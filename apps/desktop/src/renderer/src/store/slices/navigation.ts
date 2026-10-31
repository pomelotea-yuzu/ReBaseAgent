// AppState 分片：Navigation 域（refactor-renderer 4.1 接口 / 5.3 实现迁入；归属依据 change 的 ownership-map.md）
// 工厂以完整 store 的 set/get 为上下文（design D2：无第二 create、不导入 useAppStore）；
// auxEntrySnapshot/auxLocationKey/auxTargetKey/enterAuxWorkspace 域内协调者随域迁入（闭包持有）；
// noteReadingChanged/createReturnFactsRuntime 由 store.ts 注入（results 分片成员与 runtime 句柄）；
// restoreReadingLocation（「返回来源」的阅读位置恢复落点，跨 navigation+reading 协调）
// 5.7 自 store.ts 迁入本分片为公开成员（ownership-map：navigation 持有、只调 reading 的公开 action），
// compare 分片经执行时 get() 消费。
import type { RunDetail } from "../../../../shared/ipc";
import { RunDetailSchema } from "../../../../shared/ipc";
import { api } from "../../lib/api";
import {
  type AuxReturnLocation,
  type AuxWorkspaceView,
  type ExperimentTarget,
  type MessagesTarget,
  decideAuxEntry,
  decideAuxReturn,
} from "../../lib/aux-workspace";
import type {
  CreateReturnFacts,
  CreateReturnLocation,
  ReadingLocationSnapshot,
  SourceView,
  WorkspaceView,
} from "../../lib/create-workspace";
import {
  decideCreateEntry,
  decideCreateReturn,
  filePatchOfLocation,
  liveSpanOfLocation,
  readingPatchOfLocation,
} from "../../lib/create-workspace";
import { describeZodError } from "../../lib/describe-zod-error";
import {
  fileReadingOf,
  patchFileReading,
  patchReadingState,
  readingStateOf,
} from "../../lib/reading-state";
import { ensureRecordingDraft, recordingBaselineOf } from "../../lib/recording-draft";
import type { TreeScope, TreeViewport } from "../../lib/tree-view";
import { decideTreeInitialFocus } from "../../lib/tree-view";
import type { CreateReturnFactsCacheRuntime } from "../runtime/create-return-facts-cache";
import type { AppState, SliceContext } from "../types";

export interface NavigationState {
  view: WorkspaceView;
  /**
   * 创建工作区（U5 任务 4.1）：**这次是从哪儿点进来创建的**。
   *
   * 「新建」不再是覆盖模态而是主工作区的一个页面（`view === "create"`），于是需要一个
   * 与创建草稿**分开**的凭据来兑现"返回来源"（design D1 + delta 场景「创建工作区任务
   * 优先且可返回来源」）。三条纪律：
   * - 只含阅读位置（运行 / 页签 / 调用 / 文件定位），**不含**草稿正文、目录引用、授权、
   *   凭据，也不含 main 操作登记的任何字段（判据与形状都在 `lib/create-workspace.ts`）；
   * - 只存 renderer 会话：不落盘、不进 URL/日志/IPC ⇒ **重载后必然失效**，
   *   返回时只能回退到已有可用工作区，不从草稿或登记反推旧位置；
   * - 与草稿生命周期互不决定：草稿的恢复/放弃/正常结束清理都不动它；
   *   从别的工作区进入创建重记，创建页内重复点击与设置往返沿用。
   *
   * ⚠️ 与 `createSourceRef`（隔离运行的**源目录**引用：main 签发的 token + name/path）
   * 是两回事，别混用。
   */
  createReturnLocation: CreateReturnLocation | null;
  /**
   * U8（unify-recording-and-experiment-workspaces）任务 1.2/1.3：三个辅助工作区的
   * **来源位置引用**（判据在 `lib/aux-workspace.ts`，语义同 `createReturnLocation`）：
   * - 只含会话内可核对的阅读位置，不含草稿正文 / 目标 / 凭据 / 授权；
   * - 页内重复进入与设置往返（视图未变）沿用；跨视图进入重记；经 setView 离开 = 用掉；
   * - `selectRun` 离开辅助页时**保留**（与比较页同一纪律：返回动作才消费引用）。
   * recording 是全局页面，也留来源（可从 messages 缺凭据提示进入，返回要回得去）。
   */
  recordingReturnLocation: AuxReturnLocation | null;
  experimentReturnLocation: AuxReturnLocation | null;
  messagesReturnLocation: AuxReturnLocation | null;
  experimentTarget: ExperimentTarget | null;
  messagesTarget: MessagesTarget | null;
  /**
   * U7 任务 3.1/3.2/3.3：分支树的**会话观察状态**（design D2——视口是观察参数，
   * 逻辑布局永不在 store 里重排）。null = 本会话尚未进入过树（首次进入由
   * `decideTreeInitialFocus` 决定初始范围与焦点）。
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
  /** U7 3.1：首次进入树时初始化范围与焦点（幂等：已初始化则沿用，不重复居中） */
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
  experimentSource: ExperimentSourceState;
  /** U8 3.1b：实验目标的父本源只读读取（runs:get；不改选中/视图/阅读状态） */
  readExperimentSource: () => Promise<void>;
  /**
   * U8 任务 5.1b：messages 工作区目标的**源读取**（只读 `runs:get`），判据与
   * experimentSource 同形——目标不跟随侧栏选择 ⇒ 工作区不能借用全局 `detail`；
   * 本读取不改选中项、不切页、不碰阅读状态；失败保留旧读取项并允许只读重试。
   */
  messagesSource: ExperimentSourceState;
  readMessagesSource: () => Promise<void>;
  /**
   * U7 2.3：按来源引用恢复阅读位置（创建页与比较页的"返回来源"共用——不抄第二份）。
   *
   * 该 run 本来就选中 ⇒ 用既有阅读动作当场对齐（页签/调用/文件定位）；
   * 换运行 ⇒ 先把位置写成该 run 的会话阅读状态，再走 `selectRun`——它自带
   * "按详情校验 + 失效回退"，这里不重复判有效性（判了也不认）。
   * 5.7 自 store.ts 迁入本分片（ownership-map：navigation 持有、只调 reading 的公开 action）；
   * compare 分片经执行时 get() 消费（design D2）。
   */
  restoreReadingLocation: (
    location: Pick<CreateReturnLocation, "runId" | "tab" | "spanId" | "file">,
  ) => Promise<void>;
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

/** navigation 分片工厂上下文：完整 set/get + 跨域协调者/资源的显式注入 */
export interface NavigationSliceContext extends SliceContext {
  /** results 域协调者（results 分片公开成员，5.5 起注入源 = results 实例）：换阅读对象 ⇒ 撤销在飞导航资格 */
  noteReadingChanged: () => void;
  /** 4.4 的按引用派生缓存句柄（store.ts 按实例组合一次，注入给 createReturnFactsOf） */
  createReturnFactsRuntime: CreateReturnFactsCacheRuntime;
}

export function createNavigationSlice({
  set,
  get,
  noteReadingChanged,
  createReturnFactsRuntime,
}: NavigationSliceContext): NavigationState {
  /**
   * U8 任务 1.3：从 store 现场构造辅助工作区进入判据的快照
   * （与 `enterCompareView` / `openCreateWorkspace` 的现场取法同一形状，不抄第二份字段挑选）。
   */
  function auxEntrySnapshot(): ReadingLocationSnapshot {
    const state = get();
    return {
      view: state.view,
      selectedRunId: state.selectedRunId,
      reading:
        state.view === "trace" && state.selectedRunId !== null
          ? readingStateOf(state.readingByRun, state.selectedRunId)
          : null,
    };
  }

  /** 三个辅助工作区的来源引用与视图的对应（唯一映射，open/return 两处共用） */
  function auxLocationKey(
    view: AuxWorkspaceView,
  ): "recordingReturnLocation" | "experimentReturnLocation" | "messagesReturnLocation" {
    return view === "recording"
      ? "recordingReturnLocation"
      : view === "experiment"
        ? "experimentReturnLocation"
        : "messagesReturnLocation";
  }

  /** 实验页/messages 页各自的目标状态键（recording 无目标，不进此映射） */
  function auxTargetKey(view: AuxWorkspaceView): "experimentTarget" | "messagesTarget" | null {
    return view === "experiment"
      ? "experimentTarget"
      : view === "messages"
        ? "messagesTarget"
        : null;
  }

  /**
   * U8 任务 1.3：进入辅助工作区的公共落点（录制 / 实验 / messages 共用）。
   * - 页内重复进入：来源沿用、代次不推进（设置往返视图未变 ⇒ 同一判据覆盖）；
   *   目标仍按本次显式请求写入（同一目标幂等；不同目标 = 用户显式换目标）；
   * - 跨视图进入：现记来源位置 + 推进阅读代次 + 显式绑定目标；
   * - recording 无目标：目标状态永不触碰。
   */
  function enterAuxWorkspace(
    view: AuxWorkspaceView,
    target: ExperimentTarget | MessagesTarget | null,
  ): void {
    const decision = decideAuxEntry(view, auxEntrySnapshot());
    const targetKey = auxTargetKey(view);
    const targetPatch = target === null || targetKey === null ? {} : { [targetKey]: target };
    if (decision.kind === "keep") {
      set(targetPatch);
      return;
    }
    // 进入辅助页 = 离开原来在看的那条运行 ⇒ 撤销在飞的自动导航资格
    noteReadingChanged();
    set({
      view,
      [auxLocationKey(view)]: decision.location,
      ...targetPatch,
    });
  }

  return {
    view: "trace",
    createReturnLocation: null,
    recordingReturnLocation: null,
    experimentReturnLocation: null,
    messagesReturnLocation: null,
    experimentTarget: null,
    messagesTarget: null,
    treeScope: null,
    treeQuery: "",
    treeViewport: null,
    treeMode: "graph",
    experimentSource: idleExperimentSource(),
    messagesSource: idleExperimentSource(),

    setView(view) {
      // U5 3.4：轨迹 / 分支树之间切换也是"换了在看的东西"⇒ 撤销在飞的自动导航资格
      noteReadingChanged();
      // U5 4.1：从创建页切去别的工作区 = 本次来源用掉（下次进入按新位置重记）。
      // ⚠️ 刻意**不清**创建草稿——离开创建保留它是 U3 的既有语义。
      // U7 2.3：比较页的来源引用同纪律（经 setView 离开 = 用掉；selectRun 打开单侧
      // 时保留，那是比较自己的往返流）
      // U8 1.3：三个辅助工作区的来源引用同一纪律（经 setView 离开 = 用掉；
      // selectRun 离开时保留——目标是显式凭据，不随视图切换被抹）
      set({
        view,
        createReturnLocation: null,
        compareReturnLocation: null,
        recordingReturnLocation: null,
        experimentReturnLocation: null,
        messagesReturnLocation: null,
      });
    },

    openCreateWorkspace() {
      const state = get();
      const selected = state.selectedRunId;
      const decision = decideCreateEntry({
        view: state.view,
        selectedRunId: selected,
        // 文件定位由 `reading.files` 自己表达（undefined = 从未进入文件页）——
        // 不在这里另传一份"进入过"布尔，两处判据会漂移
        reading:
          state.view === "trace" && selected !== null
            ? readingStateOf(state.readingByRun, selected)
            : null,
      });
      // 已经在创建页：来源沿用、代次不推进（重复点「新建」不该把这次流程的导航资格撤销掉）
      if (decision.kind === "keep") return;
      // 进入创建页 = 离开原来在看的那条运行 ⇒ 撤销在飞的自动导航资格
      noteReadingChanged();
      set({ view: "create", createReturnLocation: decision.location });
    },

    async returnToCreateSource() {
      const state = get();
      const decision = decideCreateReturn({
        location: state.createReturnLocation,
        knownRunIds: state.runs.map((run) => run.id),
      });
      // 一次性凭据：恢复与回退都算用掉，不存在"回到创建页再按一次返回来源"的旧位置复活
      set({ createReturnLocation: null });
      const target = decision.kind === "restore" ? decision.location.view : decision.view;
      noteReadingChanged();
      set({ view: target });
      if (decision.kind !== "restore" || decision.location.runId === null) return;
      await get().restoreReadingLocation(decision.location);
    },

    createReturnFactsOf() {
      const state = get();
      // ⚠️ 引用稳定（zustand v5 getSnapshot 纪律）：本方法被 selector 直接消费
      // （CreateRunWorkspace「useAppStore((s) => s.createReturnFactsOf())」），
      // 每次现造对象会让 getSnapshot 恒新 ⇒ "Maximum update depth exceeded"
      // ⇒ 无 error boundary 整树卸载（2026-10-15 实机坐实：打开创建页即白屏）。
      // 输入只有 createReturnLocation 与 runs 两个引用 ⇒ 按引用缓存（4.4 迁
      // runtime/create-return-facts-cache，句柄经上下文注入），两者任一变化才重建；
      // 判据本体（decideCreateReturn + 文案派生，5.3 随本分片迁入）：同一
      // decideCreateReturn 事实喂返回动作与呈现文案。
      return createReturnFactsRuntime.factsOf(
        { location: state.createReturnLocation, runs: state.runs },
        ({ location, runs }) => {
          return decideCreateReturn({
            location,
            knownRunIds: runs.map((run) => run.id),
          });
        },
      );
    },

    openRecordingWorkspace() {
      enterAuxWorkspace("recording", null);
      // U8 任务 2.1：进录制页即确保草稿在场（从当前已核实状态初始化；已有草稿原样保留）
      const state = get();
      set({
        recordingDraft: ensureRecordingDraft(
          state.recordingDraft,
          state.proxy !== null ? recordingBaselineOf(state.proxy) : null,
        ),
      });
    },

    openExperimentWorkspace(target) {
      enterAuxWorkspace("experiment", target);
      // U8 3.1b：换目标 ⇒ 父本源回到待读取（容器按目标发起只读读取；旧目标的详情不残留）
      set({ experimentSource: idleExperimentSource() });
    },

    openMessagesWorkspace(target) {
      enterAuxWorkspace("messages", target);
      // U8 5.1b：换目标 ⇒ 源回到待读取（容器按目标发起只读读取；旧目标的详情不残留）
      set({ messagesSource: idleExperimentSource() });
      // 任务 2.1：打开 messages 即核对当前代理事实（design D2「messages 初次打开…
      // 均可核对」）。场景「打开重发即核对当前状态」：store 里可能还留着旧的
      // hasKey=false，用户不必先去录制页手动重读。
      void get().reconcileProxyGate();
    },

    async returnToAuxSource(view) {
      const state = get();
      const location = state[auxLocationKey(view)];
      const decision = decideAuxReturn({
        location,
        knownRunIds: state.runs.map((run) => run.id),
      });
      // 一次性凭据：恢复与回退都算用掉（与创建页同一纪律，旧位置不复活）
      set({ [auxLocationKey(view)]: null });
      const target = decision.kind === "restore" ? decision.location.view : decision.view;
      noteReadingChanged();
      set({ view: target });
      // 任务 2.1：从录制页返回 messages ⇒ 代理启停/凭据接入的**结果**要立刻进 gate。
      // 场景「打开重发即核对当前状态」的另一半：刚在录制页启用了代理，回来就重发
      // 时不能还拿着启停之前的门禁事实。⚠️ 只在落到 messages 时核对——
      // 落到 trace/tree 时读状态是白读一次 IPC。
      if (target === "messages") void get().reconcileProxyGate();
      // U8 6.11 实机坐实：辅助工作区「返回来源」后焦点落回工作区主容器（不落 body）——
      // 场景 THEN「返回有效来源焦点」；U7 5.9「返回比较」的 data-compare-primary 同款。
      // 返回目标是主工作区视图（trace 等）时落回 main（App 侧 tabIndex=-1）。
      requestAnimationFrame(() => {
        (
          document.querySelector<HTMLElement>("[data-aux-frame]") ??
          document.querySelector<HTMLElement>("main")
        )?.focus();
      });
      if (decision.kind !== "restore" || decision.location.runId === null) return;
      await get().restoreReadingLocation(decision.location);
    },

    armTreeSession() {
      // U7 3.1：首次进入的初始范围与焦点。幂等：已有会话范围就原样沿用（返回树
      // 恢复视口、不重复强制居中——显式定位才再次居中，D2）
      const existing = get().treeScope;
      if (existing !== null) {
        return { scope: existing, focusRunId: null };
      }
      const decision = decideTreeInitialFocus(get().selectedRunId);
      set({ treeScope: decision.scope });
      return { scope: decision.scope, focusRunId: decision.focusRunId };
    },

    setTreeScope(scope) {
      // U7 3.1：显式范围切换（观察参数；不影响选中运行与阅读位置）
      set({ treeScope: scope });
    },

    setTreeQuery(query) {
      // U7 3.2：搜索词只进会话状态；无命中时渲染层明确提示，不丢原选择
      set({ treeQuery: query });
    },

    setTreeViewport(viewport) {
      // U7 3.3：视口落会话（缩放/平移/定位/适应画布都汇到这里）；返回树恢复
      set({ treeViewport: viewport });
    },

    setTreeMode(mode) {
      // U7 3.6：呈现模式落会话（返回树保留来源模式）；不影响选中与对比集合
      set({ treeMode: mode });
    },

    async readExperimentSource() {
      const target = get().experimentTarget;
      if (target === null) return;
      // 只读 runs:get：不改选中项、不切视图、不碰阅读状态（design D1「后台核实不切页」）
      set({ experimentSource: { phase: "reading", detail: null, errorMessage: null } });
      const envelope = await api.getRun(target.runId);
      if (!envelope.ok) {
        set({
          experimentSource: { phase: "failed", detail: null, errorMessage: envelope.error.message },
        });
        return;
      }
      const parsed = RunDetailSchema.safeParse(envelope.data);
      if (!parsed.success) {
        set({
          experimentSource: {
            phase: "failed",
            detail: null,
            errorMessage: describeZodError(parsed.error),
          },
        });
        return;
      }
      set({ experimentSource: { phase: "ready", detail: parsed.data, errorMessage: null } });
    },

    async readMessagesSource() {
      // U8 5.1b：与 readExperimentSource 同判据（只读 runs:get，不改选中/视图/代次），
      // 只是目标换成 messagesTarget——不抄第二份状态形状，复用 ExperimentSourceState。
      const target = get().messagesTarget;
      if (target === null) return;
      set({ messagesSource: { phase: "reading", detail: null, errorMessage: null } });
      const envelope = await api.getRun(target.runId);
      if (!envelope.ok) {
        set({
          messagesSource: { phase: "failed", detail: null, errorMessage: envelope.error.message },
        });
        return;
      }
      const parsed = RunDetailSchema.safeParse(envelope.data);
      if (!parsed.success) {
        set({
          messagesSource: {
            phase: "failed",
            detail: null,
            errorMessage: describeZodError(parsed.error),
          },
        });
        return;
      }
      set({ messagesSource: { phase: "ready", detail: parsed.data, errorMessage: null } });
    },

    async restoreReadingLocation(location) {
      const { runId } = location;
      // 无运行可恢复（来源视图不承载单运行位置）⇒ 视图已恢复，无事可做
      if (runId === null) return;
      if (get().selectedRunId === runId) {
        // 该 run 本来就选中：没有"恢复"这一步可借，直接用既有的阅读动作当场对齐
        if (
          location.tab !== null &&
          readingStateOf(get().readingByRun, runId).tab !== location.tab
        ) {
          get().setReadingTab(runId, location.tab);
        }
        const liveSpan = liveSpanOfLocation(
          location,
          (get().detail?.spans ?? []).map((span) => span.id),
        );
        if (liveSpan !== null && get().selectedSpanId !== liveSpan) {
          get().selectSpan(liveSpan);
        }
        const filePatch = filePatchOfLocation(location);
        const liveFile = fileReadingOf(readingStateOf(get().readingByRun, runId));
        if (
          filePatch !== null &&
          (liveFile.checkpoint !== filePatch.checkpoint || liveFile.path !== filePatch.path)
        ) {
          get().setFileReading(runId, filePatch);
        }
        return;
      }
      // 换运行：先把位置写成该 run 的会话阅读状态，再走 `selectRun`（判据同上）
      const readingPatch = readingPatchOfLocation(location);
      if (Object.keys(readingPatch).length > 0) {
        set((current) => ({
          readingByRun: patchReadingState(current.readingByRun, runId, readingPatch),
        }));
      }
      const filePatch = filePatchOfLocation(location);
      if (filePatch !== null) {
        set((current) => ({
          readingByRun: patchFileReading(current.readingByRun, runId, filePatch),
        }));
      }
      await get().selectRun(runId);
    },
  };
}
