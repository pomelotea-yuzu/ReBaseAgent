// AppState 分片：Drafts 域（refactor-renderer 4.1 接口 / 5.2 实现迁入；归属依据 change 的 ownership-map.md）
// 工厂以完整 store 的 set/get 为上下文（design D2：无第二 create、不导入 useAppStore）；
// 本域无跨域协调者注入：discardClosureTarget 随域迁入（仅三个 discard 调用），
// openDraftAt 对 navigation/runs/reading 的调用一律走执行时 get() 的 action。
import type { ExecutedResponse } from "../../../../shared/operations";
import * as draftLib from "../../lib/debugging-drafts";
import type {
  CallDraftEntry,
  CallDraftKey,
  CallDraftSource,
  CreateRunDraftEntry,
  CreateRunDraftPatch,
  CreateSourceRef,
  DraftRepo,
  ModelAbArmRow,
  ModelAbDraftEntry,
  ModelAbDraftKey,
} from "../../lib/debugging-drafts";
import type { DraftKind } from "../../lib/draft-list";
import * as submissionLib from "../../lib/draft-submission";
import { CREATE_SUBMIT_TARGET } from "../../lib/draft-submission";
import type {
  DraftSubmission,
  DraftSubmitChannel,
  DraftSubmitTarget,
  SubmissionStore,
} from "../../lib/draft-submission";
import {
  armConfirmation,
  confirmationTargetKey,
  decideConfirmation,
  emptyConfirmationStore,
  releaseConfirmation,
  settingsStampOf,
} from "../../lib/execution-confirmation";
import type { ConfirmationBinding, ConfirmationStore } from "../../lib/execution-confirmation";
import { armNavigationIntent } from "../../lib/navigation-intent";
import type { AppState, SliceContext } from "../types";

export interface DraftsState {
  drafts: DraftRepo;
  draftSubmissions: SubmissionStore;
  confirmations: ConfirmationStore;
  /** 只读检查代次（按目标键）：重启检查即推进，旧响应不可安装新确认 */
  checkGenerations: Record<string, number>;
  /**
   * U6 任务 4.10：**来源撤销令牌**（会话内单调递增）。
   * 详情落地为 ownOnly、或预检/执行响应以来源类稳定码拒绝时 +1；
   * 编辑器据此撤销绑定旧父本的 A/B 计划 / capability 结果 / 本次副本授权。
   * 只增不减 ⇒ 父文件恢复不能自动复活（恢复后必须重新检查）。
   */
  sourceRevocation: number;
  /**
   * 创建源目录的独立受限会话引用（design D4）：仅 main 已签发 token + 核对用
   * name/path。**不属于**草稿仓库：有效期由 main 判定，授权/计划不在此。
   */
  createSourceRef: CreateSourceRef | null;
  /**
   * U2 任务 2.3：一次性显式草稿定位目标（「返回草稿」/列表定位）。
   * 与阅读历史分开存：历史是"上次读到哪"，目标是"这次要看哪"。由承载组件消费一次后清空。
   */
  pendingDraftTarget: { runId: string; spanId: string | null; field: DraftKind } | null;
  /** 读取某编辑目标的草稿条目（无则 undefined；返回仓库内对象，引用稳定） */
  callDraftOf: (key: CallDraftKey) => CallDraftEntry | undefined;
  /**
   * 编辑器打开时登记基线（来自已校验详情的原文）。已存在同 key 条目则原样保留：
   * 不覆盖基线、不推进修订——重开编辑不得覆盖已有输入（design D2）。
   * `source` 为任务 1.4 的源基线（captureCallDraftSource 的产物），只在条目创建时落库。
   */
  ensureCallDraft: (
    key: CallDraftKey,
    baseline: string,
    source?: CallDraftSource,
  ) => CallDraftEntry;
  /**
   * 输入事件**同步**写入原始文本（不得仅靠 debounce/失焦/卸载保存最后一次输入）；
   * 实际内容变化才推进修订。须先 ensureCallDraft——未登记基线的目标不接收写入。
   */
  writeCallDraftText: (key: CallDraftKey, text: string) => void;
  /**
   * U3 任务 1.2：按 key + revision 的放弃校验（CAS）。仅当目标修订与确认时一致才删除；
   * 确认等待期间内容已推进或条目不存在时不动仓库。返回是否真的放弃。
   */
  discardCallDraft: (key: CallDraftKey, expectedRevision: number) => boolean;
  /** 创建表单草稿（会话内单份；null = 默认空表单）；打开创建流程时 ensure */
  createRunDraftOf: () => CreateRunDraftEntry | null;
  ensureCreateRunDraft: () => CreateRunDraftEntry;
  /** 合并写入创建草稿（切模式只传 mode ⇒ 文本保留）；实际内容变化才推进修订 */
  writeCreateRunDraft: (patch: CreateRunDraftPatch) => void;
  /** 放弃创建草稿（CAS）：确认后恢复默认空表单；旧确认不动新修订 */
  discardCreateRunDraft: (expectedRevision: number) => boolean;
  /** A/B 批次草稿读写（稳定行 ID；授权/计划不进草稿） */
  modelAbDraftOf: (key: ModelAbDraftKey) => ModelAbDraftEntry | undefined;
  ensureModelAbDraft: (
    key: ModelAbDraftKey,
    baselineArms: ReadonlyArray<{ model: string; paramsText: string }>,
    source?: CallDraftSource,
  ) => ModelAbDraftEntry;
  /** 整批替换行列表（增删/改内容/重排都经此）；语义不变仅行 ID 变化不推进修订 */
  setModelAbRows: (key: ModelAbDraftKey, rows: ReadonlyArray<ModelAbArmRow>) => void;
  /** 放弃整个 A/B 批次（CAS） */
  discardModelAbDraft: (key: ModelAbDraftKey, expectedRevision: number) => boolean;
  setCreateSourceRef: (ref: CreateSourceRef | null) => void;
  /**
   * U3 任务 3.4/3.5：提交关联（renderer 本地，与草稿仓库和授权都分开）。提交时**原子**
   * 取到目标、当前修订与请求快照，据此冻结该草稿的修改/放弃；收尾由既有执行函数负责——
   * 组件卸载、`resetFork`/`resetCreateRun`/`resetModelAb`、展示状态复位都不是解冻依据
   * （design D5）。调用类冻结单个字段，A/B 冻结整批，创建冻结整份。
   *
   * U5 任务 4.4：入口可以带上**本次执行确认**（只给目标即可——修订与设置快照由 store
   * 当场取，组件传不进旧值）。带确认的提交在登记前先验一次现场：不是 `confirmed`
   * ⇒ 返回 null，一次 IPC 都不发；通过后这份确认即被消费（重新执行要重新确认）。
   */
  beginDraftSubmission: (input: {
    channel: DraftSubmitChannel;
    target: DraftSubmitTarget;
    /** 已给出的本次确认（缺省 = 该入口尚未接入确认门禁，见 tasks 4.4 边界条） */
    confirmation?: ConfirmationBinding;
  }) => DraftSubmission | null;
  /**
   * 收尾一次提交（解除冻结）：只认令牌相同的关联，旧回调不解冻新提交。仅"已明确有结论"
   * 的路径可调用（响应到达 / 本地校验拒绝）；通道断开等不确定状态保留冻结。
   */
  settleDraftSubmission: (submission: DraftSubmission) => void;
  /**
   * U4 任务 4.2：执行响应到达后**按身份**收尾（spec「核对终态只解冻对应修订」
   * 「迟到回调与未知状态不能错误解冻」）。
   * 判据在 `decideSettle`：回执身份必须等于本次提交绑定的 `epoch`/`operationId` 且已进终态；
   * running、身份不匹配、回执不可信 ⇒ 保留冻结。一律不删草稿。
   */
  finishDraftSubmission: (submission: DraftSubmission, response: ExecutedResponse<unknown>) => void;
  /**
   * U4 任务 4.2/4.5：核对到某身份已进终态时按身份解冻（reconcile 与迟到响应的唯一合法解冻口）。
   * 身份查不到（已结束 / 从未登记）⇒ 状态不变。
   */
  settleDraftByOperation: (identity: { epoch: string; operationId: string }) => void;
  /** 该目标是否被待定提交冻结（冻结期间仓库拒绝写入与放弃） */
  isDraftFrozen: (target: DraftSubmitTarget) => boolean;
  /**
   * U5 任务 4.4：**执行前确认**（会话内凭据，design D2）。
   *
   * 绑"目标 + 草稿修订 + 设置快照 + 检查代次"，任一变化即失效；判据在
   * `lib/execution-confirmation.ts`。它**不授予执行资格**（门禁仍是 U4 的统一槽 +
   * main 的重复校验），也不落盘 / 不进 URL/日志/操作 IPC。
   */
  currentConfirmationBinding: (
    channel: DraftSubmitChannel,
    target: DraftSubmitTarget,
  ) => ConfirmationBinding;
  /** 记下一次确认（"已核对目标与边界"） */
  armExecutionConfirmation: (binding: ConfirmationBinding) => void;
  /** 撤销确认：返回编辑、切换对象、进入设置、重新执行、显式放弃都走这个出口 */
  releaseExecutionConfirmation: (target: DraftSubmitTarget) => void;
  /** 该现场现在还算不算已确认（现算，不缓存结论） */
  executionConfirmationReady: (binding: ConfirmationBinding) => boolean;
  /** 重新开始一次只读检查：推进代次并作废既有确认 */
  restartExecutionCheck: (target: DraftSubmitTarget) => void;
  /**
   * U3 任务 3.5：定位一个草稿条目：创建类 = 走进创建工作区；A/B 与 messages =
   * 进入对应辅助工作区并显式绑定目标；调用类 = 切到该运行（需要时）+ 步骤页签 +
   * 选中该 span，pending 交编辑器消费。
   */
  openDraftAt: (target: {
    runId: string;
    spanId: string | null;
    field: DraftKind;
  }) => Promise<void>;
  /** 编辑器消费定位目标后清空（一次性；旧目标不抢新页面） */
  consumeDraftTarget: () => void;
}

// 提交关联相关类型别名（lib/draft-submission 的类型经此处引用，避免与值导入混淆）

export function createDraftsSlice({ set, get }: SliceContext): DraftsState {
  /**
   * U5 任务 2.3：**显式放弃**某目标草稿时一并释放它的收尾关联（原 store.ts 模块级函数随域迁入）。
   *
   * design D3 给关联的寿命是"到 renderer 会话结束或显式放弃相关草稿"为止。用户既然明确说
   * 这份输入不要了，那次执行就不该再留着一份"将来可以替她决定删什么"的凭据——
   * 否则之后重建的同目标草稿（新修订）与该关联同处一室，判据面徒增歧义。
   */
  function discardClosureTarget(target: DraftSubmitTarget): void {
    set((state) => {
      const next = submissionLib.releaseClosuresForTarget(state.draftSubmissions, target);
      return next === state.draftSubmissions ? {} : { draftSubmissions: next };
    });
  }

  return {
    drafts: draftLib.emptyDraftRepo(),
    // U3 任务 3.4：提交关联仓库（与草稿仓库分开的生命周期，见 draft-submission.ts）
    draftSubmissions: submissionLib.emptySubmissionStore(),
    confirmations: emptyConfirmationStore(),
    checkGenerations: {},
    sourceRevocation: 0,
    pendingDraftTarget: null,

    callDraftOf(key) {
      return draftLib.callDraftOf(get().drafts, key);
    },

    ensureCallDraft(key, baseline, source) {
      const next = draftLib.ensureCallDraft(get().drafts, key, baseline, source);
      // 无变化（条目已存在）时仓库引用不变，不触发无关订阅者
      if (next.repo !== get().drafts) set({ drafts: next.repo });
      return next.entry;
    },

    writeCallDraftText(key, text) {
      // U3 任务 3.4：待定提交冻结修改（design D5）——冻结期间仓库拒绝写入，界面同时禁用输入。
      // 拦在 store 而不是只靠组件禁用：提交快照必须独立于编辑器挂载与后续输入。
      if (submissionLib.submissionOf(get().draftSubmissions, key) !== undefined) return;
      const next = draftLib.writeCallDraftText(get().drafts, key, text);
      // 相同文本 / 未 ensure：仓库引用不变，不推进修订
      if (next !== get().drafts) set({ drafts: next });
    },

    discardCallDraft(key, expectedRevision) {
      // U3 任务 3.4：冻结期间拒绝放弃（含迟到确认）——待定请求引用的就是这份快照
      if (submissionLib.submissionOf(get().draftSubmissions, key) !== undefined) return false;
      const next = draftLib.discardCallDraft(get().drafts, key, expectedRevision);
      // 未删除（修订已推进 / 条目不存在）：仓库引用不变
      if (next.repo !== get().drafts) set({ drafts: next.repo });
      // U5 任务 2.3：显式放弃 ⇒ 该目标的收尾关联一并释放（用户已明确说这份输入不要了）
      if (next.discarded) {
        discardClosureTarget(key);
        // U5 4.4：这份输入已经不要了 ⇒ 它的确认一并作废（不留给下一份草稿）
        get().releaseExecutionConfirmation(key);
      }
      return next.discarded;
    },

    createRunDraftOf() {
      return get().drafts.create;
    },

    ensureCreateRunDraft() {
      const next = draftLib.ensureCreateRunDraft(get().drafts);
      if (next.repo !== get().drafts) set({ drafts: next.repo });
      return next.entry;
    },

    writeCreateRunDraft(patch) {
      // U3 任务 3.5：待定提交冻结整份创建草稿（对话框输入同时禁用）
      if (submissionLib.submissionOf(get().draftSubmissions, CREATE_SUBMIT_TARGET) !== undefined) {
        return;
      }
      const next = draftLib.writeCreateRunDraft(get().drafts, patch);
      if (next !== get().drafts) set({ drafts: next });
    },

    discardCreateRunDraft(expectedRevision) {
      // U3 任务 3.5：冻结期间拒绝放弃创建草稿（含迟到确认）
      if (submissionLib.submissionOf(get().draftSubmissions, CREATE_SUBMIT_TARGET) !== undefined) {
        return false;
      }
      const next = draftLib.discardCreateRunDraft(get().drafts, expectedRevision);
      if (next.repo !== get().drafts) set({ drafts: next.repo });
      // U5 任务 2.3：显式放弃 ⇒ 释放该目标的收尾关联（目录引用由创建页同轮清，见 CreateRunWorkspace）
      if (next.discarded) {
        discardClosureTarget(CREATE_SUBMIT_TARGET);
        // U5 4.4：创建草稿被弃 ⇒ 本次执行的确认一并作废
        get().releaseExecutionConfirmation(CREATE_SUBMIT_TARGET);
      }
      return next.discarded;
    },

    modelAbDraftOf(key) {
      return draftLib.modelAbDraftOf(get().drafts, key);
    },

    ensureModelAbDraft(key, baselineArms, source) {
      const next = draftLib.ensureModelAbDraft(get().drafts, key, baselineArms, source);
      if (next.repo !== get().drafts) set({ drafts: next.repo });
      return next.entry;
    },

    setModelAbRows(key, rows) {
      // U3 任务 3.5：待定执行冻结整批（增删/改参数的入口同时禁用）
      if (submissionLib.submissionOf(get().draftSubmissions, key) !== undefined) return;
      const next = draftLib.setModelAbRows(get().drafts, key, rows);
      if (next !== get().drafts) set({ drafts: next });
    },

    discardModelAbDraft(key, expectedRevision) {
      // U3 任务 3.5：冻结期间拒绝放弃整批（含迟到确认）
      if (submissionLib.submissionOf(get().draftSubmissions, key) !== undefined) return false;
      const next = draftLib.discardModelAbDraft(get().drafts, key, expectedRevision);
      if (next.repo !== get().drafts) set({ drafts: next.repo });
      // U5 任务 2.3：显式放弃 ⇒ 释放该目标的收尾关联
      if (next.discarded) {
        discardClosureTarget(key);
        // U5 4.4：这份输入已经不要了 ⇒ 它的确认一并作废（不留给下一份草稿）
        get().releaseExecutionConfirmation(key);
      }
      return next.discarded;
    },

    // 字段初始化紧随其后成员（顺序照抄 store.ts 原布局：draft-submission.test 的切片边界
    // 以 "createSourceRef: null," 为 discardModelAbDraft 体结束标记）
    createSourceRef: null,

    setCreateSourceRef(ref) {
      set({ createSourceRef: ref });
    },

    beginDraftSubmission({ channel, target, confirmation }) {
      /**
       * U5 任务 4.4：带确认的提交先验一次**当下**现场（不是"提交前某刻看过一眼"）。
       * 修订、设置快照或检查代次与确认时不同 ⇒ 直接拒绝登记，组件因此一次 IPC 都不发。
       */
      if (
        confirmation !== undefined &&
        decideConfirmation(get().confirmations, confirmation).kind !== "confirmed"
      ) {
        return null;
      }
      // 原子取提交快照：三类草稿各自的可核对串（同一步内读修订与内容，不会读到半新半旧）
      let submittedRevision: number;
      let submittedText: string;
      // U5 任务 2.1/2.4：A/B 整批的预期臂数——只在这次提交里说一次，之后登记缺臂也以此为准
      let expectedArmCount: number | null = null;
      if (!("field" in target)) {
        // A/B 批次（整批）：行内容 JSON，与草稿列表的 copyText 同形
        const entry = draftLib.modelAbDraftOf(get().drafts, target);
        if (entry === undefined) return null;
        submittedRevision = entry.revision;
        submittedText = JSON.stringify(
          entry.rows.map((row) => ({ model: row.model, paramsText: row.paramsText })),
        );
        expectedArmCount = entry.rows.length;
      } else if (target.field === "create") {
        // 创建表单（整份）
        const entry = get().drafts.create;
        if (entry === null) return null;
        submittedRevision = entry.revision;
        submittedText = JSON.stringify({
          mode: entry.mode,
          systemPrompt: entry.systemPrompt,
          userMessage: entry.userMessage,
        });
      } else {
        // 调用类：草稿原文（提交值直接取它）
        const entry = draftLib.callDraftOf(get().drafts, target);
        // 未登记基线 ⇒ 没有可提交的草稿（正常提交路径必经 ensure）；不猜测快照
        if (entry === undefined) return null;
        submittedRevision = entry.revision;
        submittedText = entry.text;
      }
      const next = submissionLib.beginSubmission(get().draftSubmissions, {
        channel,
        target,
        submittedRevision,
        submittedText,
        // U4 任务 4.2：身份与草稿快照在同一步原子定下——operationId 现在就生成，
        // epoch 等真正发出时由 `submitActive` 绑定（未握手 ⇒ null，请求根本不会离开）
        operationId: crypto.randomUUID(),
        epoch: get().operations.epoch,
        // U5 任务 2.1/2.4：A/B 的预期臂数与快照同一步定下（解冻后仍留在收尾关联里）
        expectedArmCount,
      });
      // 该目标已有待定提交：拒绝重复提交，不覆盖旧关联（旧关联的响应仍能正确收尾）
      if (next.submission === null) return null;
      const submitted = next.submission;
      /**
       * U5 任务 3.4：**登记导航意图的唯一咽喉**。七类入口的提交都只经这里登记
       * （组件不许各自登记，否则必然漂出七套语义）。代次取当下：之后任何一次
       * 主动换阅读对象都会把它作废（判据在 `lib/navigation-intent.ts`）。
       */
      set((state) => ({
        draftSubmissions: next.store,
        navIntents: armNavigationIntent(
          state.navIntents,
          submitted.operationId,
          state.navGeneration,
        ),
        // U5 4.4：确认是**一次性**凭据——登记成功即消费，重新执行要重新确认
        ...(confirmation === undefined
          ? {}
          : { confirmations: releaseConfirmation(state.confirmations, target) }),
      }));
      return submitted;
    },

    settleDraftSubmission(submission) {
      const next = submissionLib.settleSubmission(get().draftSubmissions, submission);
      // 令牌不匹配（旧回调）/ 已被收尾 ⇒ 引用不变
      if (next !== get().draftSubmissions) set({ draftSubmissions: next });
    },

    finishDraftSubmission(submission, response) {
      // 用**仓库里当前那条**判定：epoch 是发出时才绑上的，入参可能是绑定前的旧快照
      const current = submissionLib.submissionOf(get().draftSubmissions, submission.target);
      if (current === undefined || current.token !== submission.token) return;
      const ack = response.operation ?? null;
      const decision = submissionLib.decideSettle(
        current,
        ack,
        response.ok ? null : response.error.code,
      );
      if (decision === "settle") get().settleDraftSubmission(current);
    },

    settleDraftByOperation({ epoch, operationId }) {
      const next = submissionLib.settleSubmissionByOperation(
        get().draftSubmissions,
        epoch,
        operationId,
      );
      if (next !== get().draftSubmissions) set({ draftSubmissions: next });
    },

    isDraftFrozen(target) {
      return submissionLib.submissionOf(get().draftSubmissions, target) !== undefined;
    },

    currentConfirmationBinding(channel, target) {
      const state = get();
      // 修订一律现取（与 `beginDraftSubmission` 读同一份草稿），组件传不进旧值
      let revision = -1;
      if (!("field" in target)) {
        revision = draftLib.modelAbDraftOf(state.drafts, target)?.revision ?? -1;
      } else if (target.field === "create") {
        revision = state.drafts.create?.revision ?? -1;
      } else {
        revision = draftLib.callDraftOf(state.drafts, target)?.revision ?? -1;
      }
      return {
        channel,
        target,
        revision,
        settingsStamp: settingsStampOf({ settings: state.settings, proxy: state.proxy }),
        generation: state.checkGenerations[confirmationTargetKey(target)] ?? 0,
      };
    },

    armExecutionConfirmation(binding) {
      set((state) => {
        const next = armConfirmation(state.confirmations, binding);
        return next === state.confirmations ? {} : { confirmations: next };
      });
    },

    releaseExecutionConfirmation(target) {
      set((state) => {
        const next = releaseConfirmation(state.confirmations, target);
        return next === state.confirmations ? {} : { confirmations: next };
      });
    },

    executionConfirmationReady(binding) {
      // 现算：现场（修订 / 设置 / 代次）任一不同即未确认——不缓存"已确认"的布尔
      return decideConfirmation(get().confirmations, binding).kind === "confirmed";
    },

    restartExecutionCheck(target) {
      const key = confirmationTargetKey(target);
      set((state) => ({
        checkGenerations: {
          ...state.checkGenerations,
          [key]: (state.checkGenerations[key] ?? 0) + 1,
        },
        confirmations: releaseConfirmation(state.confirmations, target),
      }));
    },

    async openDraftAt(target) {
      // 创建草稿：定位 = 恢复创建表单（对话框挂载即 ensure/读取草稿）；
      // 同时清掉可能残留的调用类 pending（一次性目标不跨页面残留）
      if (target.field === "create") {
        // U5 任务 4.1：创建草稿的定位 = 走进创建工作区（与全局栏同一个入口动作，
        // 从别的工作区进来照常取新来源）；同时清掉可能残留的调用类 pending
        set({ pendingDraftTarget: null });
        get().openCreateWorkspace();
        return;
      }
      // U8 任务 1.5：A/B 批次草稿的定位 = 进入实验工作区并按草稿键**显式绑定目标**
      // （精确身份来自条目本身，不跟随侧栏选择；全局「返回草稿」经 draftLocatorOf 走同一分支）。
      // pending 不再交给详情内的旧编辑器（§3.1 提取后工作区编辑器直接读草稿仓库）
      if (target.field === "model_ab") {
        set({ pendingDraftTarget: null });
        if (target.spanId === null) return;
        get().openExperimentWorkspace({ runId: target.runId, spanId: target.spanId });
        return;
      }
      // U8 任务 1.5：messages 草稿的定位 = 进入 messages 编辑工作区（同上口径）
      if (target.field === "messages") {
        set({ pendingDraftTarget: null });
        if (target.spanId === null) return;
        get().openMessagesWorkspace({ runId: target.runId, spanId: target.spanId });
        return;
      }
      set({ pendingDraftTarget: target });
      if (get().selectedRunId !== target.runId) {
        await get().selectRun(target.runId);
      }
      // 运行不可达（selectRun 失败）时 pending 保留：列表的复制/放弃仍可用（spec：详情失败仍能访问输入）
      if (get().selectedRunId === target.runId) {
        get().setReadingTab(target.runId, "steps");
        if (target.spanId !== null) get().selectSpan(target.spanId);
      }
    },

    consumeDraftTarget() {
      set({ pendingDraftTarget: null });
    },
  };
}
