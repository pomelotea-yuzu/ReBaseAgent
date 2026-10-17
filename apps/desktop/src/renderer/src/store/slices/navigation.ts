// AppState 分片：Navigation 域（refactor-renderer 4.1；成员逐字随迁，归属依据 change 的 ownership-map.md）
import type {
  AuxReturnLocation,
  AuxWorkspaceView,
  ExperimentTarget,
  MessagesTarget,
} from "../../lib/aux-workspace";
import type {
  CreateReturnFacts,
  CreateReturnLocation,
  SourceView,
  WorkspaceView,
} from "../../lib/create-workspace";
import type { TreeScope, TreeViewport } from "../../lib/tree-view";

import type { RunDetail } from "../../../../shared/ipc";

export interface NavigationState {
  view: WorkspaceView;
  /** 加入对照的 run id（上限 4，分支树的选择栏与比较工作区的指标表消费） */
  createReturnLocation: CreateReturnLocation | null;
  /** 「录制接入」跳转后要高亮的设置分区（null = 常规打开设置） */
  recordingReturnLocation: AuxReturnLocation | null;
  experimentReturnLocation: AuxReturnLocation | null;
  messagesReturnLocation: AuxReturnLocation | null;

  /**
   * U8 任务 1.2/1.3：辅助工作区的**显式目标**（与 U3 草稿键同形：runId + spanId）。
   * 目标只由明确的进入动作写入（运行级菜单 / 自有代理调用入口 / 草稿列表返回）；
   * `selectRun`（侧栏选择）**永不改写**目标——「切运行不更换实验父本」。
   * 切换目标只有一个途径：用户对另一目标做显式进入动作。目标失效的来源重验归 3.2/5.2。
   */
  experimentTarget: ExperimentTarget | null;
  messagesTarget: MessagesTarget | null;

  /**
   * U8 任务 2.1：录制配置草稿（结构/判据在 `lib/recording-draft.ts`，独立于草稿仓库）。
   * 会话内保留；baseline = 最近可核实的代理配置（null = 状态待读取）；不含凭据/许可/计划。
   */
  treeScope: TreeScope | null;
  /** U7 3.2：树内搜索词（完整 ID/任务匹配在渲染层复用 matchesSearch；空串 = 未搜索） */
  treeQuery: string;
  /** U7 3.3：会话视口（缩放档 + 滚动位置）；返回树恢复，显式定位才改写 */
  treeViewport: TreeViewport | null;
  /** U7 3.1：首次进入时对初始范围的处置（幂等：已初始化则沿用，不重复居中） */
  treeMode: "graph" | "list";
  setView: (view: SourceView) => void;
  /**
   * 打开创建工作区（全局栏与列表标题区**共用**这一个动作，U5 任务 4.1）。
   * 从别的工作区进来 ⇒ 以当时阅读位置重记来源并推进阅读代次；已在创建页 ⇒ 什么都不动
   * （来源沿用，任务 3.4 的自动导航资格因此不被"重复点击"撤销）。
   */
  openCreateWorkspace: () => void;
  /**
   * 返回本次创建的来源位置（spec 场景「创建工作区任务优先且可返回来源」）。
   * 来源失效（重载 / 运行已不在列表）⇒ 回退到已有可用工作区，不伪造旧位置。
   * 与创建草稿无关：返回不动输入内容，也不解任何冻结。
   */
  returnToCreateSource: () => Promise<void>;
  /**
   * UI 整理 2.3（N02/N03）：返回入口的呈现事实（store 派生，组件只吃文案）。
   * restore ⇒ label = 实际目的地（「返回运行概览」等）；fallback ⇒ label = 退路
   * （「回到运行记录」）+ reasonText = 就近失效原因。判据仍是 lib 的
   * decideCreateReturn（与 returnToCreateSource 同一事实，不另造第二份）。
   */
  createReturnFactsOf: () => CreateReturnFacts;
  /**
   * U8 任务 1.3：打开录制工作区（全局页，无运行目标；空态 / 全局栏 / 设置 / 缺凭据提示共用）。
   * 进入/沿用语义与创建页一致；已在录制页 ⇒ 什么都不动。
   */
  openRecordingWorkspace: () => void;
  /**
   * U8 任务 1.3：打开实验工作区并**显式绑定目标**（父 runId + 首次自有 llm.call spanId）。
   * 已在实验页 ⇒ 来源沿用；换目标只能经显式进入动作（含页内对另一目标的入口点击），
   * 侧栏选择/切运行不改目标、不换页面的编辑对象。
   */
  openExperimentWorkspace: (target: ExperimentTarget) => void;
  /** U8 任务 1.3：打开 messages 工作区并显式绑定目标（代理 runId + 自有 llm.call spanId）。 */
  openMessagesWorkspace: (target: MessagesTarget) => void;
  /**
   * U8 任务 1.3：返回某辅助工作区的来源位置（一次性凭据，恢复与回退都算用掉）。
   * 来源失效（重载 / 运行已不在列表）⇒ 回退已有可用工作区并保留草稿，不伪造旧位置。
   */
  returnToAuxSource: (view: AuxWorkspaceView) => Promise<void>;
  /** U8 任务 2.1：写入录制草稿字段（原始文本无损；修订按实际变化推进） */
  armTreeSession: () => { scope: TreeScope; focusRunId: string | null };
  /** U7 3.1/3.2：显式切换范围（当前树/全部）——观察参数变化，不推进阅读代次 */
  setTreeScope: (scope: TreeScope) => void;
  /** U7 3.2：更新搜索词（不丢原选择；空结果在渲染层明确提示） */
  setTreeQuery: (query: string) => void;
  /** U7 3.3：记录视口（滚动/缩放/适应画布/定位都落这里，返回树据此恢复） */
  setTreeViewport: (viewport: TreeViewport) => void;
  /**
   * U7 3.6：树的呈现模式（图 / 关系列表）。会话内状态——从列表打开某运行再返回，
   * 仍停留在列表模式（scenario「返回保留来源模式」）；与范围/搜索/视口一样不落盘。
   */
  setTreeMode: (mode: "graph" | "list") => void;

  /**
   * U5 任务 3.5：**用户明确打开某条可信结果**。
   *
   * 与 3.4 的自动导航分开：那条要过导航意图（离开过流程就不跳），这条**不过**——
   * 用户点了就是要去看。仍走既有 `selectRun`（恢复该 run 自己的阅读状态），不另写落地逻辑。
   * 顺带把该条通知标成已看（3.6 的去重）。
   */
  experimentSource: ExperimentSourceState;
  readExperimentSource: () => Promise<void>;
  /**
   * U8 任务 5.1b：messages 工作区目标的**源读取**（只读 `runs:get`），判据与
   * experimentSource 同形——目标不跟随侧栏选择 ⇒ 工作区不能借用全局 `detail`；
   * 本读取不改选中项、不切页、不碰阅读状态；失败保留旧读取项并允许只读重试。
   */
  messagesSource: ExperimentSourceState;
  readMessagesSource: () => Promise<void>;
  /** 打开设置并定位到某分区（全局栏「录制接入」用），null = 常规打开 */
}

/** U8 3.1b：实验目标父本源的四态（idle = 换目标后待读取） */
export interface ExperimentSourceState {
  readonly phase: "idle" | "reading" | "ready" | "failed";
  readonly detail: RunDetail | null;
  readonly errorMessage: string | null;
}

/** U8 3.1b：初值（换目标/复位共用同一形状） */
export function idleExperimentSource(): ExperimentSourceState {
  return { phase: "idle", detail: null, errorMessage: null };
}
