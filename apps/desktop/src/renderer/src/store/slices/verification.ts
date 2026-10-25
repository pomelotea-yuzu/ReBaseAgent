// AppState 分片：Verification 域（R3 任务 5.1）。
// 工厂以完整 store 的 set/get 为上下文（design D2：无第二 create、不导入 useAppStore）。
// 本分片持有 R3 验证的**核对与确认**状态：显式 selector、capability/preparePlan 只读
// 核对缓存（代次守卫）、两份独立确认（准备/执行）与提交呈现面。提交动作住在
// operations 分片（唯一提交适配器 submitActive 在它的闭包里），经本分片公开的
// action 驱动这里的状态——跨分片调用走执行时 get()（design D2）。
import type {
  VerificationCapabilityResult,
  VerificationCheckpoint,
  VerificationGetResult,
  VerificationPreparePlanResult,
} from "@shared/ipc";
import {
  VerificationCapabilityResultSchema,
  VerificationGetResultSchema,
  VerificationPreparePlanResultSchema,
  VerificationReadLogResultSchema,
} from "@shared/ipc";
import { api } from "../../lib/api";
import { describeZodError } from "../../lib/describe-zod-error";
import {
  type VerificationArmedConfirmation,
  type VerificationTargetRef,
  verificationDomainIdOf,
  verificationTargetKey,
} from "../../lib/verification-entry";
import type { SliceContext } from "../types";

/** 提交呈现面（5.1 最小面：请求收尾 + 领域结局一行；完整分层呈现归 5.2/5.4） */
export interface VerificationOutcomeView {
  readonly kind: "prepare" | "run";
  /** 提交那一刻的显式目标键（迟到结果不得显示在新目标下） */
  readonly targetKey: string;
  /** 提交那一刻的目标代次（open/close 推进；不匹配 ⇒ 丢弃） */
  readonly atOutcomeGeneration: number;
  /** prepare 成功时：真实创建的准备记录身份 + 镜像事实 */
  readonly preparationId?: string;
  readonly imageDigest?: string;
  /** run 返回时：请求收尾（ok 信封）+ 领域结局（D04 分层的原始事实） */
  readonly verificationId?: string;
  readonly outcome?: string;
  readonly detail?: string;
  readonly evidenceComplete?: boolean;
  /** 本次提交的 operationId（与登记记录对链：D04 请求收尾以登记为准） */
  readonly operationId?: string;
}

/** 提交失败的呈现面（请求层失败：门内拒绝稳定码 / 本地拒发） */
export interface VerificationSubmitError {
  readonly code: string;
  readonly message: string;
}

export interface VerificationState {
  /**
   * 显式 selector：只有「打开验证面板」这个显式动作能写它；检查点选择器的变化
   * 绝不无声改写 target（design D3「UI 不得无声换点」——换点必须重新打开面板）。
   */
  verificationTarget: VerificationTargetRef | null;
  /** 只读核对结果（capability）；null = 尚未核对/已随目标重置 */
  verificationCapability: VerificationCapabilityResult | null;
  verificationCapabilityState: "idle" | "loading" | "ready" | "error";
  verificationCapabilityError: { code: string; message: string } | null;
  /** 核对代次：发出请求前捕获，迟到响应按代次整包丢弃 */
  verificationCapabilityGeneration: number;
  /** 固定准备计划预览（preparePlan） */
  verificationPlan: VerificationPreparePlanResult | null;
  verificationPlanState: "idle" | "loading" | "ready" | "error";
  verificationPlanError: { code: string; message: string } | null;
  verificationPlanGeneration: number;
  /** 执行确认绑定的固定命令（选择器状态；确认绑定它的当下值） */
  verificationCommand: "typecheck" | "test";
  /**
   * 两份**独立**确认（D02：准备与执行许可不互相替代）。
   * 失效不靠"记得清"：判定是现算比对（`decideVerificationConfirmation`），
   * 目标/计划 token/命令任一漂移 ⇒ stale。
   */
  verificationPrepareConfirmation: VerificationArmedConfirmation | null;
  verificationRunConfirmation: VerificationArmedConfirmation | null;
  /** 目标代次：open/close 推进；提交结果按代次 + 目标键守卫（迟到结果不显示在新目标下） */
  verificationOutcomeGeneration: number;
  /** 请求在飞标记（请求层；领域结局另见 lastOutcome） */
  verificationSubmitting: "idle" | "prepare" | "run";
  verificationSubmitError: VerificationSubmitError | null;
  verificationLastOutcome: VerificationOutcomeView | null;
  /**
   * 在飞 R3 操作身份（5.2/D05）：提交动作铸出 operationId 后立即登记——停止通道、
   * status/reconcile 核对都按它寻路。响应明确返回（成功/业务拒绝）即清除；
   * **通道抛错不清除**（请求是否被接受未知 ⇒ 靠该身份 reconcile 核对，D03）。
   */
  verificationActiveOperation: { kind: "prepare" | "run"; operationId: string } | null;
  /** 停止反馈（D05）：停止信号已被 main 接受（确认全部停止由编排收尾后随结局到达） */
  verificationStopRequested: boolean;
  /** 停止通道的非失败事实（幂等 no-op / 尚无可信身份已转核对） */
  verificationStopNotice: string | null;
  verificationStopError: VerificationSubmitError | null;
  /**
   * 记录/日志读取（5.3/D09/P13/P16）：只读**可信验证身份**（连接层只传登记附件/
   * 响应里的 ID），读取本身零执行零补写。迟到响应按代次整包丢弃；焦点切换
   * （换验证身份）推进两个代次 ⇒ 旧响应/旧正文绝不混入新身份（D09）。
   */
  verificationRecordFocus: string | null;
  verificationRecordState: "idle" | "loading" | "ready" | "error";
  verificationRecordData: VerificationGetResult | null;
  verificationRecordError: { code: string; message: string } | null;
  /** 记录/日志读取代次：与 capability/plan 同口径——单调递增、不随 open 复位 */
  verificationRecordGeneration: number;
  verificationLogIdentity: {
    verificationId: string;
    commandId: "typecheck" | "test";
    stream: "stdout" | "stderr";
  } | null;
  verificationLogText: string;
  verificationLogMeta: {
    totalBytes: number;
    nextOffset: number;
    remaining: number;
    truncated: boolean;
  } | null;
  verificationLogState: "idle" | "loading" | "ready" | "error";
  verificationLogError: { code: string; message: string } | null;
  verificationLogGeneration: number;
}

export interface VerificationSliceActions {
  /**
   * 显式进入验证核对（检查点入口的唯一写入口）：绑定当前显式 selector，清空旧核对/
   * 旧确认/旧结果（新目标必须重新核对），并自动发起 capability + preparePlan 两个只读加载。
   */
  openVerification: (runId: string, checkpoint: VerificationCheckpoint) => void;
  /** 收起面板：整域复位（target 清空 ⇒ 一切确认自然失效） */
  closeVerification: () => void;
  /** 重新核对（只读）：capability 聚合（来源/环境/引擎/当前计划 token） */
  refreshVerificationCapability: () => Promise<void>;
  /** 重新加载固定准备计划预览（只读） */
  loadVerificationPreparePlan: () => Promise<void>;
  /** 切换固定命令选择（确认绑定命令：切换后旧执行确认现算判 stale） */
  setVerificationCommand: (commandId: "typecheck" | "test") => void;
  /** 显式确认环境准备（绑定当前计划 token 与目标；核对缺失时拒绝武装） */
  confirmVerificationPrepare: () => boolean;
  /** 显式确认固定检查执行（另绑定当前选择的命令） */
  confirmVerificationRun: () => boolean;
  /** 撤销两份确认（换检查点/显式放弃时调用；面板收起走 closeVerification 全清） */
  revokeVerificationConfirmations: () => void;

  // —— 提交呈现面的驱动口（operations 分片的提交动作调用；组件不直接调）——
  beginVerificationSubmit: (kind: "prepare" | "run") => void;
  endVerificationSubmit: () => void;
  /** 提交失败（请求层失败或本地拒发）；迟到失败按代次丢弃 */
  failVerificationSubmit: (error: VerificationSubmitError, atOutcomeGeneration?: number) => void;
  /** 提交明确返回（ok 信封）；迟到结果按代次 + 目标键丢弃 */
  noteVerificationOutcome: (
    outcome: Omit<VerificationOutcomeView, "targetKey" | "atOutcomeGeneration">,
    atOutcomeGeneration: number,
  ) => void;
  /** 登记/清除在飞 R3 操作身份（提交动作在铸出 operationId 后调用；组件不直接调） */
  noteVerificationActiveOperation: (kind: "prepare" | "run", operationId: string) => void;
  clearVerificationActiveOperation: () => void;

  /**
   * R3 定向停止（D05/D06）：对**当前在飞 owner** 请求停止。领域 ID 只从操作登记
   * 附件取（D06 不接任意容器/PID）；登记里还没有身份时先 reconcile 一次核对
   * （D03：复用既有核对，不猜），仍拿不到就如实说明并放弃（零停止）。
   * 幂等：main 对重复/已收尾操作返回 alreadySettled（no-op）。
   */
  requestVerificationStop: () => Promise<void>;

  /**
   * 聚焦一条**可信**验证身份并读取其记录（5.3/D09/P16）：调用方（连接层）只传登记
   * 附件/响应里的 ID；焦点切换复位记录与日志并推进代次 ⇒ 旧响应/旧正文不混入。
   */
  focusVerificationRecord: (verificationId: string) => void;
  /** 重读当前聚焦的验证记录（只读；焦点未设置时零动作） */
  loadVerificationRecord: () => Promise<void>;
  /**
   * 有界日志读取（P13/D09）：`mode:"replace"` 读首页（main 默认 32 KiB 切片）、
   * `"append"` 以 nextOffset 续读并追加正文。身份（verificationId+commandId+stream）
   * 与代次双重守卫：迟到的旧响应绝不混入当前正文。
   */
  readVerificationLog: (
    commandId: "typecheck" | "test",
    stream: "stdout" | "stderr",
    mode: "replace" | "append",
  ) => Promise<void>;
}

export type VerificationSlice = VerificationState & VerificationSliceActions;

/** 目标代次的起点（open/close 各推进一次；0 = 从未打开） */
const INITIAL_OUTCOME_GENERATION = 0;

export function initialVerificationState(): VerificationState {
  return {
    verificationTarget: null,
    verificationCapability: null,
    verificationCapabilityState: "idle",
    verificationCapabilityError: null,
    verificationCapabilityGeneration: 0,
    verificationPlan: null,
    verificationPlanState: "idle",
    verificationPlanError: null,
    verificationPlanGeneration: 0,
    verificationCommand: "test",
    verificationPrepareConfirmation: null,
    verificationRunConfirmation: null,
    verificationOutcomeGeneration: INITIAL_OUTCOME_GENERATION,
    verificationSubmitting: "idle",
    verificationSubmitError: null,
    verificationLastOutcome: null,
    verificationActiveOperation: null,
    verificationStopRequested: false,
    verificationStopNotice: null,
    verificationStopError: null,
    verificationRecordFocus: null,
    verificationRecordState: "idle",
    verificationRecordData: null,
    verificationRecordError: null,
    verificationRecordGeneration: 0,
    verificationLogIdentity: null,
    verificationLogText: "",
    verificationLogMeta: null,
    verificationLogState: "idle",
    verificationLogError: null,
    verificationLogGeneration: 0,
  };
}

export function createVerificationSlice({ set, get }: SliceContext): VerificationSlice {
  /**
   * 内容字段的复位形状。⚠️ 三个代次计数**不在复位面**：它们是分片全生命周期的单调
   * 计数器——若随 open 清零，「开目标 A → 开目标 B」后 A 的迟到响应会与 B 的新请求
   * 同代次碰撞，迟到守卫失效。open/close 清的是内容（核对/确认/呈现），代次只进不退。
   */
  const resetContent = () => ({
    verificationTarget: null,
    verificationCapability: null,
    verificationCapabilityState: "idle" as const,
    verificationCapabilityError: null,
    verificationPlan: null,
    verificationPlanState: "idle" as const,
    verificationPlanError: null,
    verificationCommand: "test" as const,
    verificationPrepareConfirmation: null,
    verificationRunConfirmation: null,
    verificationSubmitting: "idle" as const,
    verificationSubmitError: null,
    verificationLastOutcome: null,
    verificationActiveOperation: null,
    verificationStopRequested: false,
    verificationStopNotice: null,
    verificationStopError: null,
    verificationRecordFocus: null,
    verificationRecordState: "idle" as const,
    verificationRecordData: null,
    verificationRecordError: null,
    verificationLogIdentity: null,
    verificationLogText: "",
    verificationLogMeta: null,
    verificationLogState: "idle" as const,
    verificationLogError: null,
  });

  return {
    ...initialVerificationState(),

    openVerification(runId, checkpoint) {
      const target: VerificationTargetRef = { runId, checkpoint };
      set((state) => ({
        ...resetContent(),
        verificationTarget: target,
        verificationOutcomeGeneration: state.verificationOutcomeGeneration + 1,
        // 记录/日志也要失效在飞读取：换目标后旧验证的迟到响应不得写进新目标
        verificationRecordGeneration: state.verificationRecordGeneration + 1,
        verificationLogGeneration: state.verificationLogGeneration + 1,
      }));
      void get().refreshVerificationCapability();
      void get().loadVerificationPreparePlan();
    },

    closeVerification() {
      set((state) => ({
        ...resetContent(),
        verificationOutcomeGeneration: state.verificationOutcomeGeneration + 1,
        verificationRecordGeneration: state.verificationRecordGeneration + 1,
        verificationLogGeneration: state.verificationLogGeneration + 1,
      }));
    },

    async refreshVerificationCapability() {
      const target = get().verificationTarget;
      if (target === null) return;
      const commandId = get().verificationCommand;
      // 代次先捕获再发请求：期间的目标切换/重开让本响应整包过期（迟到响应不覆盖新核对）
      const generation = get().verificationCapabilityGeneration + 1;
      set((state) => ({
        verificationCapabilityGeneration: generation,
        verificationCapabilityState: "loading",
        verificationCapabilityError: null,
      }));
      let envelope: Awaited<ReturnType<typeof api.verificationCapability>>;
      try {
        envelope = await api.verificationCapability({
          runId: target.runId,
          checkpoint: target.checkpoint,
          profileId: "node-ts-v1",
          commandId,
        });
      } catch (error) {
        if (get().verificationCapabilityGeneration !== generation) return;
        set({
          verificationCapabilityState: "error",
          verificationCapabilityError: {
            code: "R3_CAPABILITY_CHANNEL_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
        });
        return;
      }
      if (get().verificationCapabilityGeneration !== generation) return;
      if (!envelope.ok) {
        set({
          verificationCapabilityState: "error",
          verificationCapabilityError: {
            code: envelope.error.code,
            message: envelope.error.message,
          },
        });
        return;
      }
      // 跨进程数据不可信：确认卡的数字原样展示给用户，先校验形状（不合法整包丢弃）
      const parsed = VerificationCapabilityResultSchema.safeParse(envelope.data);
      if (!parsed.success) {
        set({
          verificationCapabilityState: "error",
          verificationCapabilityError: {
            code: "R3_CAPABILITY_SCHEMA_INVALID",
            message: `核对结果结构校验失败：${describeZodError(parsed.error)}`,
          },
        });
        return;
      }
      set({
        verificationCapability: parsed.data,
        verificationCapabilityState: "ready" as const,
        verificationCapabilityError: null,
      });
    },

    async loadVerificationPreparePlan() {
      const generation = get().verificationPlanGeneration + 1;
      set((state) => ({
        verificationPlanGeneration: generation,
        verificationPlanState: "loading",
        verificationPlanError: null,
      }));
      let envelope: Awaited<ReturnType<typeof api.verificationPreparePlan>>;
      try {
        envelope = await api.verificationPreparePlan({ profileId: "node-ts-v1" });
      } catch (error) {
        if (get().verificationPlanGeneration !== generation) return;
        set({
          verificationPlanState: "error",
          verificationPlanError: {
            code: "R3_PLAN_CHANNEL_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
        });
        return;
      }
      if (get().verificationPlanGeneration !== generation) return;
      if (!envelope.ok) {
        set({
          verificationPlanState: "error",
          verificationPlanError: { code: envelope.error.code, message: envelope.error.message },
        });
        return;
      }
      const parsed = VerificationPreparePlanResultSchema.safeParse(envelope.data);
      if (!parsed.success) {
        set({
          verificationPlanState: "error",
          verificationPlanError: {
            code: "R3_PLAN_SCHEMA_INVALID",
            message: `计划预览结构校验失败：${describeZodError(parsed.error)}`,
          },
        });
        return;
      }
      set({
        verificationPlan: parsed.data,
        verificationPlanState: "ready" as const,
        verificationPlanError: null,
      });
    },

    setVerificationCommand(commandId) {
      set({ verificationCommand: commandId });
    },

    confirmVerificationPrepare() {
      const state = get();
      // 没有当前核对就没有可绑定的计划 token：拒绝武装（不是"先确认后核对"）
      if (state.verificationTarget === null || state.verificationCapability === null) return false;
      set({
        verificationPrepareConfirmation: {
          planToken: state.verificationCapability.planToken,
          targetKey: verificationTargetKey(state.verificationTarget),
        },
      });
      return true;
    },

    confirmVerificationRun() {
      const state = get();
      if (state.verificationTarget === null || state.verificationCapability === null) return false;
      set({
        verificationRunConfirmation: {
          planToken: state.verificationCapability.planToken,
          targetKey: verificationTargetKey(state.verificationTarget),
          commandId: state.verificationCommand,
        },
      });
      return true;
    },

    revokeVerificationConfirmations() {
      set({
        verificationPrepareConfirmation: null,
        verificationRunConfirmation: null,
      });
    },

    beginVerificationSubmit(kind) {
      set({ verificationSubmitting: kind, verificationSubmitError: null });
    },

    endVerificationSubmit() {
      set({ verificationSubmitting: "idle" });
    },

    failVerificationSubmit(error, atOutcomeGeneration) {
      // 迟到失败守卫：提交期间目标已切换/收起 ⇒ 这条失败已不属于当前目标，整包丢弃
      if (
        atOutcomeGeneration !== undefined &&
        atOutcomeGeneration !== get().verificationOutcomeGeneration
      ) {
        return;
      }
      set({ verificationSubmitError: error });
    },

    noteVerificationOutcome(outcome, atOutcomeGeneration) {
      const state = get();
      if (state.verificationTarget === null) return;
      if (atOutcomeGeneration !== state.verificationOutcomeGeneration) return;
      set({
        verificationLastOutcome: {
          ...outcome,
          targetKey: verificationTargetKey(state.verificationTarget),
          atOutcomeGeneration,
        },
      });
    },

    noteVerificationActiveOperation(kind, operationId) {
      set({ verificationActiveOperation: { kind, operationId } });
    },

    clearVerificationActiveOperation() {
      set({ verificationActiveOperation: null });
    },

    async requestVerificationStop() {
      const active = get().verificationActiveOperation;
      if (active === null) return;
      const epoch = get().operations.epoch;
      if (epoch === null) {
        set({
          verificationStopError: {
            code: "MAIN_HANDSHAKE_REQUIRED",
            message: "尚未与主进程完成操作握手：停止请求未发送",
          },
        });
        return;
      }
      set({ verificationStopError: null, verificationStopNotice: null });
      // 可信领域 ID 只从登记记录附件取（D06）；编排尚未建记录 ⇒ 先 reconcile 核对一次
      const findRecord = () =>
        get().operations.operations.find(
          (record) => record.epoch === epoch && record.operationId === active.operationId,
        );
      let domainId = verificationDomainIdOf(findRecord(), active.kind);
      if (domainId === null) {
        await get().reconcileOperation(active.operationId);
        domainId = verificationDomainIdOf(findRecord(), active.kind);
      }
      if (domainId === null) {
        set({
          verificationStopNotice:
            "登记里还没有该操作的可信领域身份（编排尚未创建记录或已收尾）：已请求核对；拿到登记身份后才能定向停止，不猜测目标",
        });
        return;
      }
      let envelope: Awaited<ReturnType<typeof api.verificationStop>>;
      try {
        envelope = await api.verificationStop({ epoch, operationId: active.operationId, domainId });
      } catch (error) {
        set({
          verificationStopError: {
            code: "R3_STOP_CHANNEL_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
        });
        return;
      }
      if (!envelope.ok) {
        set({
          verificationStopError: { code: envelope.error.code, message: envelope.error.message },
        });
        return;
      }
      if (envelope.data.alreadySettled) {
        // 幂等 no-op（重复停止/已收尾/迟到请求）：如实呈现，不假装"停止了什么"；
        // 已收尾 ⇒ 不再等待停止确认（stopRequested 复位）
        set({
          verificationStopRequested: false,
          verificationStopNotice: envelope.data.reason ?? "该操作无需停止（已收尾或不在执行段）",
        });
        return;
      }
      set({
        verificationStopRequested: true,
        verificationStopNotice: null,
        verificationStopError: null,
      });
    },

    focusVerificationRecord(verificationId) {
      // 焦点切换 = 换验证身份：复位记录与日志并推进两个代次 ⇒ 在飞旧响应整包过期
      // （D09：切换验证后旧响应迟到，绝不混入新身份的正文）
      set((state) => ({
        verificationRecordFocus: verificationId,
        verificationRecordState: "idle" as const,
        verificationRecordData: null,
        verificationRecordError: null,
        verificationRecordGeneration: state.verificationRecordGeneration + 1,
        verificationLogIdentity: null,
        verificationLogText: "",
        verificationLogMeta: null,
        verificationLogState: "idle" as const,
        verificationLogError: null,
        verificationLogGeneration: state.verificationLogGeneration + 1,
      }));
      void get().loadVerificationRecord();
    },

    async loadVerificationRecord() {
      const verificationId = get().verificationRecordFocus;
      if (verificationId === null) return;
      const generation = get().verificationRecordGeneration + 1;
      set((state) => ({
        verificationRecordGeneration: generation,
        verificationRecordState: "loading" as const,
        verificationRecordError: null,
      }));
      let envelope: Awaited<ReturnType<typeof api.verificationGet>>;
      try {
        envelope = await api.verificationGet({ verificationId });
      } catch (error) {
        if (get().verificationRecordGeneration !== generation) return;
        set({
          verificationRecordState: "error",
          verificationRecordError: {
            code: "R3_RECORD_CHANNEL_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
        });
        return;
      }
      if (get().verificationRecordGeneration !== generation) return;
      if (!envelope.ok) {
        set({
          verificationRecordState: "error",
          verificationRecordError: { code: envelope.error.code, message: envelope.error.message },
        });
        return;
      }
      const parsed = VerificationGetResultSchema.safeParse(envelope.data);
      if (!parsed.success) {
        set({
          verificationRecordState: "error",
          verificationRecordError: {
            code: "R3_RECORD_SCHEMA_INVALID",
            message: `验证记录结构校验失败：${describeZodError(parsed.error)}`,
          },
        });
        return;
      }
      set({
        verificationRecordData: parsed.data,
        verificationRecordState: "ready" as const,
        verificationRecordError: null,
      });
    },

    async readVerificationLog(commandId, stream, mode) {
      const verificationId = get().verificationRecordFocus;
      if (verificationId === null) return;
      // 续读只对"当前身份+同一命令+同一流"追加；首页读取整段重置（不混上一条正文）
      const currentMeta = get().verificationLogMeta;
      const current = get().verificationLogIdentity;
      // 续读须有当前身份的上一页游标；没有游标就退化为首页（绝不用 offset=0 再拼一次正文）
      const appending =
        mode === "append" &&
        currentMeta !== null &&
        current !== null &&
        current.verificationId === verificationId &&
        current.commandId === commandId &&
        current.stream === stream;
      const offset = appending ? currentMeta.nextOffset : 0;
      const generation = get().verificationLogGeneration + 1;
      set((state) => ({
        verificationLogGeneration: generation,
        verificationLogState: "loading" as const,
        verificationLogError: null,
        verificationLogIdentity: { verificationId, commandId, stream },
        verificationLogText: appending ? state.verificationLogText : "",
        verificationLogMeta: appending ? state.verificationLogMeta : null,
      }));
      let envelope: Awaited<ReturnType<typeof api.verificationReadLog>>;
      try {
        envelope = await api.verificationReadLog({ verificationId, commandId, stream, offset });
      } catch (error) {
        if (get().verificationLogGeneration !== generation) return;
        set({
          verificationLogState: "error",
          verificationLogError: {
            code: "R3_LOG_CHANNEL_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
        });
        return;
      }
      if (get().verificationLogGeneration !== generation) return;
      if (!envelope.ok) {
        set({
          verificationLogState: "error",
          verificationLogError: { code: envelope.error.code, message: envelope.error.message },
        });
        return;
      }
      const parsed = VerificationReadLogResultSchema.safeParse(envelope.data);
      if (!parsed.success) {
        set({
          verificationLogState: "error",
          verificationLogError: {
            code: "R3_LOG_SCHEMA_INVALID",
            message: `日志切片结构校验失败：${describeZodError(parsed.error)}`,
          },
        });
        return;
      }
      set((state) => ({
        verificationLogState: "ready" as const,
        verificationLogText: appending
          ? state.verificationLogText + parsed.data.text
          : parsed.data.text,
        verificationLogMeta: {
          totalBytes: parsed.data.totalBytes,
          nextOffset: parsed.data.nextOffset,
          remaining: parsed.data.remaining,
          truncated: parsed.data.truncated,
        },
        verificationLogError: null,
      }));
    },
  };
}
