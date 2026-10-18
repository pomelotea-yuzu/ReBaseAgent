import type { ProxyState, SettingsState } from "@shared/ipc";
import { ProxyChangeEventSchema, ProxyStateSchema, SettingsStateSchema } from "@shared/ipc";
import { create } from "zustand";
import { api } from "./lib/api";
import type { CreateReturnLocation } from "./lib/create-workspace";
import {
  filePatchOfLocation,
  liveSpanOfLocation,
  readingPatchOfLocation,
} from "./lib/create-workspace";
import { emptyConfirmationStore } from "./lib/execution-confirmation";
import type { ProxyFactCursor } from "./lib/proxy-changes";
import {
  initialProxyFactCursor,
  shouldApplyChange,
  shouldReconcileOnActivate,
} from "./lib/proxy-changes";
import type { ProxyStatusReadState } from "./lib/proxy-status-read";
import {
  acceptProxySnapshot,
  beginStatusRead,
  initialProxyStatusReadState,
  settleStatusRead,
} from "./lib/proxy-status-read";
import {
  fileReadingOf,
  patchFileReading,
  patchReadingState,
  readingStateOf,
} from "./lib/reading-state";
import type { RecordingDraft, RecordingDraftPatch } from "./lib/recording-draft";
import {
  applyRecordingBaseline,
  discardRecordingDraft as discardRecordingDraftState,
  recordingApplyRequest,
  recordingBaselineOf,
  writeRecordingDraft,
} from "./lib/recording-draft";
import type { SettingsSaveOutcome } from "./lib/settings-form";
import { createCreateReturnFactsCache } from "./store/runtime/create-return-facts-cache";
import { createOperationPollingRuntime } from "./store/runtime/operation-polling";
import { createProxyCoordinationRuntime } from "./store/runtime/proxy-coordination";
// 兼容导出（4.1）：ExperimentSourceState/idleExperimentSource 迁 slices/navigation，指向同一实现
import { createCompareSlice } from "./store/slices/compare";
import { createDraftsSlice } from "./store/slices/drafts";
import { idleExperimentSource } from "./store/slices/navigation";
import { createNavigationSlice } from "./store/slices/navigation";
import { createOperationsSlice } from "./store/slices/operations";
import { createDetailReadAttempts, createReadingSlice } from "./store/slices/reading";
import { createResultsSlice } from "./store/slices/results";
import { createRunsSlice } from "./store/slices/runs";
import type { AppState } from "./store/types";
export { idleExperimentSource };
export type { ExperimentSourceState } from "./store/slices/navigation";
/**
 * UI 状态：只存选择状态与原始数据。
 * 聚合数字一律在组件里用 shared/derive 的纯函数现算，不进 store、不落缓存。
 */

// MAX_COMPARE（5.3）随 compare 分片迁 slices/compare.ts；此处兼容再导出指向同一实现。
export { MAX_COMPARE } from "./store/slices/compare";

/** 跨进程数据不可信：统一用 schema 校验后再进状态 */
function describeZodError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 撤销全部待用的执行确认（U5 任务 4.4，design D2「目标、修订、设置或流程代次变化 SHALL
 * 使旧检查与许可失效」里"离开现场"那一半）。
 *
 * 修订 / 设置 / 检查代次的变化由**现算比对**兜住，这里清的是比对看不出来的那种变化：
 * 用户已经不在当初核对的那个现场了。没有确认时不改引用，避免无谓重渲染。
 * 5.5：results 分片的 noteReadingChanged 经注入消费；setSettingsSection 在本文件直接调用。
 */
function clearExecutionConfirmations(): void {
  useAppStore.setState((state) =>
    Object.keys(state.confirmations.byTargetKey).length === 0
      ? {}
      : { confirmations: emptyConfirmationStore() },
  );
}

/**
 * U7 2.3：按来源引用恢复阅读位置（创建页与比较页的"返回来源"共用——不抄第二份）。
 *
 * 该 run 本来就选中 ⇒ 用既有阅读动作当场对齐（页签/调用/文件定位）；
 * 换运行 ⇒ 先把位置写成该 run 的会话阅读状态，再走 `selectRun`——它自带
 * "按详情校验 + 失效回退"，这里不重复判有效性（判了也不认）。
 */
async function restoreReadingLocation(
  location: Pick<CreateReturnLocation, "runId" | "tab" | "spanId" | "file">,
): Promise<void> {
  const { runId } = location;
  // 无运行可恢复（来源视图不承载单运行位置）⇒ 视图已恢复，无事可做
  if (runId === null) return;
  if (useAppStore.getState().selectedRunId === runId) {
    // 该 run 本来就选中：没有"恢复"这一步可借，直接用既有的阅读动作当场对齐
    if (
      location.tab !== null &&
      readingStateOf(useAppStore.getState().readingByRun, runId).tab !== location.tab
    ) {
      useAppStore.getState().setReadingTab(runId, location.tab);
    }
    const liveSpan = liveSpanOfLocation(
      location,
      (useAppStore.getState().detail?.spans ?? []).map((span) => span.id),
    );
    if (liveSpan !== null && useAppStore.getState().selectedSpanId !== liveSpan) {
      useAppStore.getState().selectSpan(liveSpan);
    }
    const filePatch = filePatchOfLocation(location);
    const liveFile = fileReadingOf(readingStateOf(useAppStore.getState().readingByRun, runId));
    if (
      filePatch !== null &&
      (liveFile.checkpoint !== filePatch.checkpoint || liveFile.path !== filePatch.path)
    ) {
      useAppStore.getState().setFileReading(runId, filePatch);
    }
    return;
  }
  // 换运行：先把位置写成该 run 的会话阅读状态，再走 `selectRun`（判据同上）
  const readingPatch = readingPatchOfLocation(location);
  if (Object.keys(readingPatch).length > 0) {
    useAppStore.setState((current) => ({
      readingByRun: patchReadingState(current.readingByRun, runId, readingPatch),
    }));
  }
  const filePatch = filePatchOfLocation(location);
  if (filePatch !== null) {
    useAppStore.setState((current) => ({
      readingByRun: patchFileReading(current.readingByRun, runId, filePatch),
    }));
  }
  await useAppStore.getState().selectRun(runId);
}

/**
 * 代理变化订阅的解绑句柄与状态读取静默等待者（refactor-renderer 4.3）：
 * 订阅句柄、等待队列与"先结算、后唤醒"顺序整体迁 `store/runtime/proxy-coordination.ts`
 * （唯一所有者，见文件尾组合）；这里的两个薄包装让既有调用点逐字保持。
 */

/**
 * `createReturnFactsOf` 的**按引用缓存**已迁 `store/runtime/create-return-facts-cache.ts`
 * （refactor-renderer 4.4，唯一所有者；5.3 起组合点在 create 前）；action 只交输入引用与判据回调。
 */

/** 已静默则立即 resolve；否则排在 `notifyProxyStatusSettled` 队列里。 */
function settledProxyStatusRead(): Promise<void> {
  return proxyCoordination.settledProxyStatusRead();
}

function notifyProxyStatusSettled(): void {
  proxyCoordination.notifyProxyStatusSettled();
}

// 详情读取代次（5.1）：唯一持有者住在 slices/reading 的工厂；这里按 store 实例创建一次，
// runs 分片经注入访问（分片之间无运行时互相导入，design D2）。
const detailReadAttempts = createDetailReadAttempts();

// 派生缓存 runtime 组合（4.4/5.3）：`createReturnFactsOf` 按引用缓存的唯一所有者住在
// `store/runtime/create-return-facts-cache.ts`，这里按 store 实例组合一次（create 回调
// 需要把它注入 navigation 分片 ⇒ 必须先于 create 初始化；模块加载不预热缓存）。
const createReturnFactsRuntime = createCreateReturnFactsCache();

// 轮询 runtime 组合（4.2 组合 / 5.4 前移）：单路有界轮询的唯一所有者住在
// `store/runtime/operation-polling.ts`，这里按 store 实例组合一次（design D3）。
// store 依赖用惰性回调注入（调用时才 `getState()`），与搬迁前逐字等价；
// ⚠️ 必须先于 create 组合：operations 分片工厂要把句柄注入 submitActive（TDZ 纪律同 5.3）；
// 模块加载不启动任何资源（轮询全部由 action/组件调用点惰性触发）。
const operationPolling = createOperationPollingRuntime({
  getSession: () => useAppStore.getState().operations,
  refreshOperationStatus: () => useAppStore.getState().refreshOperationStatus(),
});

export const useAppStore = create<AppState>((set, get) => {
  // 5.5：results 分片先组合——它的三个跨域协调者（noteReadingChanged/
  // revokeSourceBoundPermissions/consumeSettledOperations）是 runs/reading/compare/navigation/
  // operations 分片的注入源（design D2：注入经实例成员，分片之间无运行时互相导入）；
  // clearExecutionConfirmations（drafts 域出口，5.6/5.7 收敛前暂住本文件）显式注入。
  const results = createResultsSlice({ set, get, clearExecutionConfirmations });
  return {
    // --- 5.1 分片组合：runs/reading（实现迁 slices/；跨域协调者显式注入，design D2）---
    ...createRunsSlice({
      set,
      get,
      // 5.5 起注入源 = results 分片实例（results 域协调者迁出 store.ts）
      noteReadingChanged: results.noteReadingChanged,
      revokeSourceBoundPermissions: results.revokeSourceBoundPermissions,
      describeZodError,
      detailReadAttempts,
    }),
    ...createReadingSlice({ set, get, noteReadingChanged: results.noteReadingChanged }),
    // 5.2：drafts 分片（草稿仓库/提交关联/执行确认；discardClosureTarget 随域迁入）
    ...createDraftsSlice({ set, get }),
    // 5.3：compare/navigation 分片（域内协调者随域迁入；noteReadingChanged/
    // restoreReadingLocation/describeZodError/createReturnFactsRuntime 注入）
    ...createCompareSlice({
      set,
      get,
      noteReadingChanged: results.noteReadingChanged,
      restoreReadingLocation,
    }),
    ...createNavigationSlice({
      set,
      get,
      noteReadingChanged: results.noteReadingChanged,
      restoreReadingLocation,
      createReturnFactsRuntime,
      describeZodError,
    }),
    // 5.4：operations 分片（操作会话/唯一提交适配器/执行与通道入口；submitActive 随域迁入
    // 闭包；revokeSourceBoundPermissions/consumeSettledOperations（5.5 起注入源 = results 分片）、
    // describeZodError 与轮询 runtime 句柄由 store.ts 注入）
    ...createOperationsSlice({
      set,
      get,
      revokeSourceBoundPermissions: results.revokeSourceBoundPermissions,
      consumeSettledOperations: results.consumeSettledOperations,
      describeZodError,
      polling: operationPolling,
    }),
    // 5.5：results 分片（结果核实/导航代次/通知键 + 三个跨域协调者）
    ...results,

    proxyFactCursor: initialProxyFactCursor,

    settings: null,
    proxy: null,
    recordingDraft: null,
    recordingApply: null,
    recordingApplyError: null,
    recordingStatusReadFailed: false,
    proxyReadGeneration: 0,
    proxyStatusRead: initialProxyStatusReadState,
    settingsChangeGeneration: 0,
    settingsSection: null,

    /**
     * 订阅 main 的代理变化通知（design D1，tasks 1.3）。**幂等**。
     *
     * 三条纪律：
     * - **零主动登记**：这条订阅不碰 `operations:status`、不占执行槽、不发任何请求
     *   （delta「通知只包含受控元信息」的 renderer 半边：证明没有自动请求/自动重发）；
     * - **先订阅后首读**：调用方必须在本方法之后才 `loadProxyStatus`，
     *   否则订阅与首读之间落盘的记录两边都看不到；
     * - **载荷过 schema 才采纳**：非法载荷整条丢弃（不按"看起来像"的部分字段处理），
     *   否则一个坏载荷能把 hasKey 之类的门禁事实带歪。
     */
    ensureProxyChangeSubscription() {
      proxyCoordination.ensureSubscription();
    },

    releaseProxyChangeSubscription() {
      proxyCoordination.releaseSubscription();
    },

    /**
     * 只读核对代理事实版本（失焦/激活补读，design D1）。
     *
     * 失焦期间可能错过任意多条通知；重新激活时读一次状态，
     * 只有 `recordsRevision` 确实落后才补刷列表——否则每次点回窗口都白读全量 traces。
     * **只读**：不启动监听、不调上游、不产生模型请求。
     *
     * ⚠️ 这里**必须等状态读取静默**（tasks 2.1）：`loadProxyStatus` 在飞时会把本次意图
     * 合并成尾随并**立即返回**，此时游标一个字都没动。若不等待就拿游标做判据，
     * "没读到" 又会被误判成"没有变化"，失焦期间漏掉的落盘永远补不上。
     */
    async reconcileProxyFacts() {
      const before = get().proxyFactCursor;
      await get().loadProxyStatus();
      await settledProxyStatusRead();
      const readOk = get().proxy !== null;
      const after = get().proxyFactCursor;
      // 读取失败/载荷非法时 loadProxyStatus 把 proxy 置 null 且**游标不前进**
      // （见上面的 `loadProxyStatus`）。⚠️ 这时**不能**直接把 `after` 当"已核实版本"：
      // 游标没动 ⇒ epoch 仍与 `before` 相同 ⇒ `shouldReconcileOnActivate` 会走
      // "无落后"分支返回 false，正好把"这次什么都没读到"误判成"没有变化"，
      // 于是失焦期间漏掉的落盘永远补不上。故此处把 epoch 置 null 显式表达
      // "本次未取得任何版本事实"，由判据一律要求补刷。
      const observed: ProxyFactCursor = readOk ? after : { ...after, epoch: null };
      if (shouldReconcileOnActivate(before, observed).reloadRuns) await get().loadRuns();
    },

    /**
     * 门禁事实的只读核对（tasks 2.1）。
     *
     * 与 `reconcileProxyFacts` 刻意分开：那个判"要不要补刷列表"，这个只刷新门禁事实。
     * 分开的理由是**代价不对称**——打开 messages 编辑器时补刷一次全量 traces 是白读，
     * 而窗口激活时漏掉一次落盘补读是事实缺失（delta 两条场景各自点名）。
     */
    async reconcileProxyGate() {
      await get().loadProxyStatus();
      await settledProxyStatusRead();
    },

    async loadSettings() {
      const envelope = await api.getSettings();
      if (!envelope.ok) {
        set({ settings: null, error: `读取运行配置失败：${envelope.error.message}` });
        return false;
      }
      const parsed = SettingsStateSchema.safeParse(envelope.data);
      if (!parsed.success) {
        set({
          settings: null,
          error: `运行配置数据结构校验失败：${describeZodError(parsed.error)}`,
        });
        return false;
      }
      set({ settings: parsed.data });
      return true;
    },

    async saveSettings(input) {
      const envelope = await api.saveSettings(input);
      if (!envelope.ok) {
        set({ error: `保存运行配置失败：${envelope.error.message}` });
        return "save-failed";
      }
      // U5 任务 5.4：保存与回读是**两个结论**——回读失败不否定"已保存"，
      // 但也绝不把旧摘要当新配置事实（loadSettings 失败路径已把 settings 置 null）。
      // U8 任务 3.7：两种成功结局都推进已核实配置变化代次（含仅轮换 key 的保存；
      // 回读失败=已保存但状态未知，同样撤销实验旧计划）；保存失败不推进。
      const outcome = (await get().loadSettings()) ? "saved" : "reread-failed";
      if (outcome === "saved" || outcome === "reread-failed") {
        set({ settingsChangeGeneration: get().settingsChangeGeneration + 1 });
      }
      return outcome;
    },

    async clearSettings() {
      const envelope = await api.clearSettings();
      if (!envelope.ok) {
        set({ error: `清除运行配置失败：${envelope.error.message}` });
        return false;
      }
      set({ settings: null });
      // U8 任务 3.7：已核实清除推进配置变化代次（实验旧计划随之作废）
      set({ settingsChangeGeneration: get().settingsChangeGeneration + 1 });
      return true;
    },

    /**
     * 只读读一次代理状态（tasks 2.1：**合并 + 代次守卫 + 快照新旧守卫**）。
     *
     * 三个触发源会叠出并发读取（通知 / messages 打开的核对 / 窗口激活补读），
     * 两条守卫各自挡一种"旧事实覆盖新事实"：
     * - **合并**：在飞时不并发发射，只登记尾随，结束后补发恰好一次；
     * - **快照新旧**：读回的载荷可能比已采纳的事实更旧（请求在途期间又发生了一次变更），
     *   同 epoch 且任一版本维度落后 ⇒ 整份丢弃，一个字节都不写。
     *
     * ⚠️ **为什么没有第三道「代次守卫」**（变异验证的结论，别照着旧注释再加回去）：
     * 合并已经保证同时至多一个读取在飞，因此"响应对不上自己那次请求"在这条链路上
     * **不可达**。曾加过一道 `isLatestStatusRead` 断言，变异测试（改成 `if (false)`）
     * 显示 14 条 store 用例全绿——它从未真正拒绝过任何响应。留着它等于挂一个永不
     * 触发的"保险"，读代码的人会以为并发防护靠它。故移除；真正的并发防线是合并，
     * 真正的乱序防线是快照新旧守卫（变异后 3 条用例变红，见 proxy-status-read.test.ts）。
     *
     * ⚠️ 失败时游标**不前进**：状态未知时不能断言"版本没变"——否则失焦期间漏掉的落盘
     * 会被这次失败读取"确认"成没有变化（design D1）。
     */
    async loadProxyStatus() {
      const decision = beginStatusRead(get().proxyStatusRead);
      set({ proxyStatusRead: decision.state });
      if (decision.action === "deferred") {
        // 刷新意图已受理：不发射、不返回事实。尾随补发由在飞那次收尾时完成。
        return;
      }
      try {
        // ⚠️ **通道本身抛错也必须被吞进失败分支**（tasks 2.1 实施期坐实）：本方法被
        // `openMessagesWorkspace` / `returnToAuxSource` 以 `void` 方式发起（fire-and-forget），
        // 一旦这里把异常抛出去就变成**未处理拒绝**——既没有可重试入口，也不会有人看见。
        // 实测：`aux-workspace-store.test.ts` 的 api 桩没有 proxyStatus，8 处未处理错误
        // 全部来自这一条路径。读通道失败与"读到一个失败信封"是同一件事：状态未知。
        let envelope: Awaited<ReturnType<typeof api.proxyStatus>>;
        try {
          envelope = await api.proxyStatus();
        } catch (e) {
          envelope = {
            ok: false as const,
            error: { code: "PROXY_STATUS_UNAVAILABLE", message: (e as Error).message },
          };
        }
        // U8 任务 2.6：每次真正发射的读取推进状态代次（守卫锚点；读取本身零写通道）
        set({ proxyReadGeneration: get().proxyReadGeneration + 1 });
        if (!envelope.ok) {
          set({
            proxy: null,
            error: `读取代理状态失败：${envelope.error.message}`,
            // U8 任务 2.5：回读失败如实呈现「状态待读取」，允许只读重试（不重新 toggle）
            recordingStatusReadFailed: true,
          });
          // ⚠️ 游标**不前进**（理由见上方注释）
          // 草稿在场 ⇒ baseline 撤到 null（没有可核实的当前应用值；输入原样保留）
          const draft = get().recordingDraft;
          if (draft !== null) set({ recordingDraft: applyRecordingBaseline(draft, null) });
          return;
        }
        const parsed = ProxyStateSchema.safeParse(envelope.data);
        if (!parsed.success) {
          set({
            proxy: null,
            error: `代理状态数据结构校验失败：${describeZodError(parsed.error)}`,
          });
          return;
        }
        // 规则 3（快照新旧）：载荷比已采纳事实更旧 ⇒ 整份丢弃。
        // ⚠️ 这一条**不能**由 cursorFromStatus 兜住：它只保证游标数字不回退，
        // 而 `proxy` 状态对象仍会被这份旧载荷写下去（hasKey 由 true 按回 false）。
        const ruling = acceptProxySnapshot(get().proxyFactCursor, parsed.data);
        if (!ruling.accept) return;
        set({
          proxy: parsed.data,
          recordingStatusReadFailed: false,
          proxyFactCursor: ruling.cursor,
        });
        // U8 任务 2.1：草稿在场 ⇒ baseline 跟随最近可核实事实（输入原样，dirty 随之重算）
        const draft = get().recordingDraft;
        if (draft !== null)
          set({ recordingDraft: applyRecordingBaseline(draft, recordingBaselineOf(parsed.data)) });
      } finally {
        const settled = settleStatusRead(get().proxyStatusRead);
        set({ proxyStatusRead: settled.state });
        // 尾随补发走本方法自身（由它登记在途数）——旁路直发 IPC 会让补发那次
        // 无人递减计数，此后所有读取都被"合并"成尾随而永不发射。
        //
        // ⚠️ 这里**不写 `return`**：`finally` 里的 return 会吞掉 try 块的控制流，
        // 且 Biome 直接把它标成错误（`noUnsafeFinally`）。改成 if/else 让两条路径互斥。
        if (settled.shouldRefire) {
          await get().loadProxyStatus();
        } else {
          // 只在**不再补发**时唤醒等待者：补发会在上面的 await 里重新置起在途计数，
          // 先唤醒会让"等静默"的调用方在补发还在飞时就拿到判断依据。
          notifyProxyStatusSettled();
        }
      }
    },

    async toggleProxy(input) {
      set({ error: null });
      const envelope = await api.proxyToggle(input);
      if (!envelope.ok) {
        set({ error: `代理操作失败：${envelope.error.message}` });
        return null;
      }
      const parsed = ProxyStateSchema.safeParse(envelope.data);
      if (!parsed.success) {
        set({ error: `代理状态数据结构校验失败：${describeZodError(parsed.error)}` });
        return null;
      }
      set({ proxy: parsed.data });
      return parsed.data;
    },

    writeRecordingDraftFields(patch) {
      const draft = get().recordingDraft;
      if (draft === null) return;
      useAppStore.setState({ recordingDraft: writeRecordingDraft(draft, patch) });
    },

    discardRecordingDraftConfirmed(expectedRevision) {
      const draft = get().recordingDraft;
      if (draft === null) return false;
      const result = discardRecordingDraftState(draft, expectedRevision);
      if (!result.discarded) return false;
      set({ recordingDraft: result.draft });
      return true;
    },

    async applyRecordingDraft() {
      const draft = get().recordingDraft;
      if (draft === null) return "no-draft";
      if (get().recordingApply !== null) return "busy";
      const request = recordingApplyRequest(draft);
      // 纵深防御：组件判据同源，但这里再拦一次——非法字段连在飞标记都不该出现
      if (!request.ok) return "invalid";
      const submittedRevision = draft.revision;
      set({ recordingApply: submittedRevision, recordingApplyError: null });
      const envelope = await api.proxyToggle(request.input);
      // toggle 非事务（design D2）：无论启动成败都回读真实状态——成功确认「已保存意图」，
      // 回读给出「监听事实」；回读失败 ⇒ 状态待读取，两层诊断分别呈现
      const startOk = envelope.ok;
      const startMessage = envelope.ok ? "" : envelope.error.message;
      await get().loadProxyStatus();
      const current = get();
      // U8 任务 2.6：响应只在「与当前草稿修订匹配」时更新基线——在飞期间的后来输入
      // 不被旧响应覆写；诊断照报（它属于真实发生过的那次应用）
      const stale =
        current.recordingDraft === null || current.recordingDraft.revision !== submittedRevision;
      const patch: {
        recordingApply: number | null;
        recordingApplyError: string | null;
        recordingDraft?: RecordingDraft;
      } = { recordingApply: null, recordingApplyError: startOk ? null : startMessage };
      if (startOk && !stale && current.recordingDraft !== null) {
        patch.recordingDraft = applyRecordingBaseline(current.recordingDraft, {
          enabled: request.input.enabled,
          port: request.input.port,
          upstreamBaseUrl: request.input.upstreamBaseUrl,
        });
      }
      set(patch);
      return startOk ? "applied" : "start-failed";
    },

    setSettingsSection(section) {
      // U5 3.4：进设置 SHALL 撤销自动导航资格（delta「结果导航尊重用户当前阅读意图」）
      // 5.5：noteReadingChanged 迁 results 分片，经执行时 get() 消费（跨域调用走 action，design D2）
      if (section !== null) get().noteReadingChanged();
      // U5 4.4：设置往返本身即撤销待用的执行确认（进出都算——确认时看到的模型/接入
      // 与回来后可能已经不是同一份配置了）
      else clearExecutionConfirmations();
      set({ settingsSection: section });
    },
  };
});

// ---------------------------------------------------------------------------
// 轮询 runtime 组合（refactor-renderer 4.2 原在文件尾 / 5.4 前移到 create 前）：
// 句柄已随 operations 分片注入 submitActive，这里只保留原入口兼容导出。
// ---------------------------------------------------------------------------

/** 停止自动轮询（保留在飞守卫；手动核对不受它限制）——原入口兼容导出，指向同一 runtime 实现 */
export function stopOperationStatusPolling(): void {
  operationPolling.stopOperationStatusPolling();
}

// ---------------------------------------------------------------------------
// 代理协调 runtime 组合（refactor-renderer 4.3）：订阅句柄与静默等待者的唯一
// 所有者住在 `store/runtime/proxy-coordination.ts`，这里按 store 实例组合一次。
// 通知处理体逐字随迁；store 依赖用惰性回调注入（调用时才 `getState()`）。
// ---------------------------------------------------------------------------
const proxyCoordination = createProxyCoordinationRuntime({
  onProxyChanged: (handler) => api.onProxyChanged(handler),
  handleEvent: (payload) => {
    const parsed = ProxyChangeEventSchema.safeParse(payload);
    if (!parsed.success) return;
    const plan = shouldApplyChange(useAppStore.getState().proxyFactCursor, parsed.data);
    // 规则 4：`records` 才刷列表。刷新一律走 loadRuns（自带在途合并 + 尾随补发），
    // **不**旁路 refreshRunsOnce —— 旁路那次请求无人递减在途计数，计数器永久残留。
    if (plan.reloadRuns) void useAppStore.getState().loadRuns();
    if (plan.reloadStatus) void useAppStore.getState().loadProxyStatus();
    // 游标在**发起读取之前**推进：读到的是异步结果，若推进放在后面，
    // 同一 tick 里的第二条通知会因游标未动而被当成新变化，重复触发读取。
    useAppStore.setState({ proxyFactCursor: plan.cursor });
  },
  getProxyStatusRead: () => useAppStore.getState().proxyStatusRead,
});
