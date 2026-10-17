// AppState 分片：Runs 域（refactor-renderer 4.1；成员逐字随迁，归属依据 change 的 ownership-map.md）
import type { FailedFile, RunDetail, RunSummary } from "../../../../shared/ipc";
import type { ShortIdState } from "../../../../shared/nav";
import type { FilterVisibility, SourceAvailability } from "../../lib/workspace-selection";

export interface RunsState {
  runs: RunSummary[];
  /** 读取失败的文件（隔离展示，不拖垮列表） */
  failed: FailedFile[];
  detail: RunDetail | null;
  selectedRunId: string | null;
  /**
   * 当前 run 的选中 span（**派生视图**）。
   * 真源是 `readingByRun[selectedRunId].spanId`；本字段供既有组件直接读，
   * 每次写通过 `selectSpan` 同步两处，避免组件一次性大改（渐进迁移）。
   */
  loadingList: boolean;
  loadingDetail: boolean;
  /** 列表曾成功加载过（用于区分「刷新失败」与「首次读取失败」的提示口径） */
  listLoaded: boolean;
  /** 列表刷新失败但旧记录仍在：界面据此提示「未更新」，不清空列表 */
  listStale: boolean;
  error: string | null;

  /**
   * U4 任务 4.1：**main 操作会话**（`operations:status` 握手所得 + 乱序/代次守卫）。
   * 它取代了原先单个 `mainEpoch` 缓存——epoch 只是其中一项，锁还要看
   * 当前槽、配置变更标记、关闭标记、通信未知与**本地尚未确认的提交**
   * （spec「现有界面消费统一操作事实」；判据在 `lib/operation-session.ts`）。
   * 与 U3 的文档会话 id 各有职责、不能互代：同一 main 内重载 renderer 不换 epoch，
   * main 重启才会换。
   */
  sourceFilter: "all" | "proxy" | "local";
  /** 列表搜索词（匹配完整 task/ID）；与来源条件求交集（任务 3.5） */
  searchQuery: string;

  /**
   * 首次自动选择是否已尝试过（任务 3.5）。
   * 一次性动作的守卫：失败后留在该 run 的错误态由用户原位重试，
   * **不**因为"这条读不了"就去试下一条（那等于静默遍历整个列表）。
   */
  initialSelectionAttempted: boolean;
  /** 当前选中运行的源记录可用性（列表刷新后派生；见 lib/workspace-selection） */
  sourceUnavailable: boolean;
  sourceUnavailableReason: "available" | "missing" | "unreadable" | "unknown";

  /**
   * 主区域视图：trace = 既有三栏（列表 / span 树 / 详情），tree = 分支树，
   * create = 创建工作区（U5 任务 4.1：新建不再是覆盖模态，而是主工作区的一个页面）。
   * 纯 UI 状态，不进 IPC、不持久化（design D7）。
   */
  listRefreshInFlight: number;
  listRefreshPending: number;
  /** 单次列表读取（合并调度内部使用；失败保留旧记录） */
  shortIdState: ShortIdState;

  loadRuns: () => Promise<void>;

  /**
   * 在途刷新计数与尾随登记（任务 3.4）。
   * 不是 UI 状态，故不参与渲染；放 store 内便于测试直接断言"读列表次数"。
   */
  refreshRunsOnce: () => Promise<void>;
  /**
   * 订阅 main 的代理变化通知（design D1，tasks 1.3）。**幂等**：重复调用只保留
   * 一个订阅（挂载 effect 在 StrictMode 下会跑两次）。
   *
   * ⚠️ 必须在首次 `loadProxyStatus` **之前**调用：订阅与首读之间落盘的记录，
   * 两边都看不到（通知没发生、首读已结束）。顺序反过来则由
   * `shouldReconcileOnActivate` 在激活时补齐。
   */
  selectRun: (id: string) => Promise<void>;
  /** 按同一 runId 重新读取详情（spec「结果不可读不重执行」的重试口）；不产生任何主动执行 */
  reopenRun: (id: string) => Promise<void>;
  autoSelectInitialRun: () => Promise<void>;
  /** 设置列表搜索词（与来源条件求交集；不改选当前运行） */
  setSearchQuery: (query: string) => void;
  /** 当前选中运行的源记录可用性（列表事实的纯派生，不缓存在字段里） */
  sourceAvailability: () => SourceAvailability;
  /** 当前选中运行是否被搜索/来源条件隐藏（导航据此提示，不改选） */
  filterVisibility: () => FilterVisibility;
  /** 依赖源记录的执行入口是否可用（源不可用 ⇒ 旧内容仍可见但不得执行） */
  canExecuteFromSource: () => boolean;

  /**
   * 阅读状态的读写（会话内按运行恢复；只存阅读位置，不存授权/草稿）。
   * 全部以 runId 为键——不同 run 中相同 span ID 不串状态。
   */
  setSourceFilter: (filter: "all" | "proxy" | "local") => void;

  /** 切换主区域视图（轨迹 / 分支树）；只改 UI 状态，不触发列表重新加载（design D7） */
}
