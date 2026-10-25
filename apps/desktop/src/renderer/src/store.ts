import { ProxyChangeEventSchema } from "@shared/ipc";
import { create } from "zustand";
import { api } from "./lib/api";
import { shouldApplyChange } from "./lib/proxy-changes";
import { createCreateReturnFactsCache } from "./store/runtime/create-return-facts-cache";
import { createOperationPollingRuntime } from "./store/runtime/operation-polling";
import { createProxyCoordinationRuntime } from "./store/runtime/proxy-coordination";
// 兼容导出（4.1）：ExperimentSourceState/idleExperimentSource 迁 slices/navigation，指向同一实现
import { createCompareSlice } from "./store/slices/compare";
import { createConfigurationSlice } from "./store/slices/configuration";
import { createDraftsSlice } from "./store/slices/drafts";
import { idleExperimentSource } from "./store/slices/navigation";
import { createNavigationSlice } from "./store/slices/navigation";
import { createOperationsSlice } from "./store/slices/operations";
import { createDetailReadAttempts, createReadingSlice } from "./store/slices/reading";
import { createResultsSlice } from "./store/slices/results";
import { createRunsSlice } from "./store/slices/runs";
import { createVerificationSlice } from "./store/slices/verification";
import type { AppState } from "./store/types";
export { idleExperimentSource };
export type { ExperimentSourceState } from "./store/slices/navigation";
/**
 * UI 状态：只存选择状态与原始数据。
 * 聚合数字一律在组件里用 shared/derive 的纯函数现算，不进 store、不落缓存。
 *
 * refactor-renderer 5.7 收敛：本文件是**唯一 create/组合入口**——八分片实现全部住在
 * `store/slices/*`（彼此无运行时导入，跨域调用走执行时 get() 的 action）、四个 runtime
 * 资源住在 `store/runtime/*`（此处按实例组合一次）。键归属/兼容导出/可达导入图的
 * 收敛核查记录见 change 目录 test-migration-ledger.md 的 5.7 销账。
 */

// MAX_COMPARE（5.3）随 compare 分片迁 slices/compare.ts；此处兼容再导出指向同一实现。
export { MAX_COMPARE } from "./store/slices/compare";

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

// 代理协调 runtime 组合（4.3 组合 / 5.6 前移）：订阅句柄与静默等待者的唯一所有者住在
// `store/runtime/proxy-coordination.ts`，这里按 store 实例组合一次（design D3）。
// 通知处理体逐字随迁；store 依赖用惰性回调注入（调用时才 `getState()`）；
// ⚠️ 必须先于 create 组合：configuration 分片工厂要把句柄注入代理订阅/静默入口
// （TDZ 纪律同 5.3/5.4）；模块加载不建立订阅（ensure 由挂载调用点触发）。
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

export const useAppStore = create<AppState>((set, get) => {
  // 5.5：results 分片先组合——它的三个跨域协调者（noteReadingChanged/
  // revokeSourceBoundPermissions/consumeSettledOperations）是 runs/reading/compare/navigation/
  // operations 分片的注入源（design D2：注入经实例成员，分片之间无运行时互相导入）。
  const results = createResultsSlice({ set, get });
  return {
    // --- 5.1 分片组合：runs/reading（实现迁 slices/；跨域协调者显式注入，design D2）---
    ...createRunsSlice({
      set,
      get,
      // 5.5 起注入源 = results 分片实例（results 域协调者迁出 store.ts）
      noteReadingChanged: results.noteReadingChanged,
      revokeSourceBoundPermissions: results.revokeSourceBoundPermissions,
      detailReadAttempts,
    }),
    ...createReadingSlice({ set, get, noteReadingChanged: results.noteReadingChanged }),
    // 5.2：drafts 分片（草稿仓库/提交关联/执行确认；discardClosureTarget 随域迁入）
    ...createDraftsSlice({ set, get }),
    // 5.3：compare/navigation 分片（域内协调者随域迁入；noteReadingChanged 注入；
    // restoreReadingLocation 5.7 迁 navigation 为公开成员，compare 走 get() 消费）
    ...createCompareSlice({
      set,
      get,
      noteReadingChanged: results.noteReadingChanged,
    }),
    ...createNavigationSlice({
      set,
      get,
      noteReadingChanged: results.noteReadingChanged,
      createReturnFactsRuntime,
    }),
    // 5.4：operations 分片（操作会话/唯一提交适配器/执行与通道入口；submitActive 随域迁入
    // 闭包；revokeSourceBoundPermissions/consumeSettledOperations（5.5 起注入源 = results 分片）
    // 与轮询 runtime 句柄由 store.ts 注入）
    ...createOperationsSlice({
      set,
      get,
      revokeSourceBoundPermissions: results.revokeSourceBoundPermissions,
      consumeSettledOperations: results.consumeSettledOperations,
      polling: operationPolling,
    }),
    // 5.5：results 分片（结果核实/导航代次/通知键 + 三个跨域协调者）
    ...results,
    // 5.6：configuration 分片（设置/代理状态与变化/录制草稿应用；代理协调句柄注入）
    ...createConfigurationSlice({
      set,
      get,
      coordination: proxyCoordination,
    }),
    // R3 5.1：verification 分片（显式 selector/只读核对缓存/两份独立确认/提交呈现面；
    // 提交动作在 operations 分片，经本分片 action 驱动这里的状态）
    ...createVerificationSlice({ set, get }),
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
