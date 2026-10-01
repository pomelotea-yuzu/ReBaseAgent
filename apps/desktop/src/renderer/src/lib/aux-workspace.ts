import type {
  CreateReturnLocation,
  FileLocationRef,
  ReadingLocationSnapshot,
  ReadingTab,
  WorkspaceView,
} from "./create-workspace";
import { decideCreateEntry, decideCreateReturn } from "./create-workspace";

/**
 * U8（unify-recording-and-experiment-workspaces）任务 1.2：**辅助工作区目标与会话来源引用**
 * （design D1）。
 *
 * 三个辅助工作区与既有页面的三条边界：
 *
 * 1. **目标是显式登记，不是侧栏选择的投影**。experiment 目标 = 父 runId + 首次自有
 *    llm.call spanId（与 `ModelAbDraftKey` 同形）；messages 目标 = 代理 runId + 自有
 *    llm.call spanId（与 `CallDraftKey`（field="messages"）同形）。目标只由明确的进入动作
 *    写入 store（1.3 接线）；`selectRun` 永不改写目标——「切运行不更换实验父本」。
 *    recording 是全局页面，没有运行目标。
 * 2. **来源引用与创建/比较同形**（`CreateReturnLocation`），复用同一批捕获/恢复判据，
 *    不抄第二份。重复进入同页（含设置往返——视图没变）沿用本次来源；从别的工作区进来
 *    才重记。返回一次消费对应引用（store 接线归 1.3）。
 * 3. **不建通用历史栈**：每个流程只保留必要的直接来源及工作区目标；目标失效时保留草稿、
 *    说明原因并回退到已有可用工作区（判定在 1.3 接 `decideCreateReturn` 的运行事实核对）。
 */

/** U8 的三个辅助工作区视图（`WorkspaceView` 的子集） */
export type AuxWorkspaceView = Extract<WorkspaceView, "recording" | "experiment" | "messages">;

/**
 * 实验工作区目标：父本 runId + 首次自有 llm.call spanId。
 * 刻意与 `ModelAbDraftKey` 同形状（runId+spanId），草稿键就是目标的草稿身份——
 * 目标不额外造第二套身份。
 */
export interface ExperimentTarget {
  readonly runId: string;
  readonly spanId: string;
}

/**
 * messages 工作区目标：代理 runId + 自有 llm.call spanId。
 * 与 `CallDraftKey`（field 固定 "messages"）同形状，理由同上。
 */
export interface MessagesTarget {
  readonly runId: string;
  readonly spanId: string;
}

/** 目标相等：两段身份逐项一致（不做别名/前缀推断） */
export function sameExperimentTarget(a: ExperimentTarget, b: ExperimentTarget): boolean {
  return a.runId === b.runId && a.spanId === b.spanId;
}

export function sameMessagesTarget(a: MessagesTarget, b: MessagesTarget): boolean {
  return a.runId === b.runId && a.spanId === b.spanId;
}

/**
 * 辅助工作区的来源引用：与创建页同形（视图 / 运行 / 页签 / 调用 / 文件定位），
 * 但来源视图域更宽——可以是主工作区任一页面，包括创建页与另一个辅助工作区
 * （messages 缺凭据转录制再返回是 spec 明文的流程）。
 * trace/tree/compare 的捕获复用 `decideCreateEntry`（阅读位置照记，不抄第二份）；
 * 创建页/辅助页来源没有运行阅读位置可记，只记视图（草稿与目标由各自状态恢复）。
 */
export type AuxReturnLocation = Omit<CreateReturnLocation, "view"> & {
  readonly view: WorkspaceView;
};

/** 进入辅助工作区时对来源引用的处置（语义同创建：页内重复进入沿用，跨视图进来重记） */
export type AuxEntryDecision =
  | { readonly kind: "keep"; readonly reason: "already-on-page" }
  | { readonly kind: "capture"; readonly location: AuxReturnLocation };

/**
 * 决定这次进入辅助工作区要不要重记来源。
 *
 * - 「人还在本页」是唯一沿用情形（视图本身就是判据）：同页重复点击与设置往返
 *   （设置盖在页面之上、视图不变）都不覆盖原来源；
 * - 来源是 trace/tree/compare：捕获复用 `decideCreateEntry`，不复制字段挑选逻辑；
 * - 来源是创建页或另一个辅助工作区：只记视图与空阅读位置——返回即回到那个页面，
 *   创建草稿/目录引用与辅助目标/草稿由 store 各自状态恢复，不在这里复制。
 */
export function decideAuxEntry(
  view: AuxWorkspaceView,
  snapshot: ReadingLocationSnapshot,
): AuxEntryDecision {
  if (snapshot.view === view) return { kind: "keep", reason: "already-on-page" };
  if (snapshot.view === "trace" || snapshot.view === "tree" || snapshot.view === "compare") {
    const decision = decideCreateEntry(snapshot);
    return decision.kind === "capture"
      ? { kind: "capture", location: decision.location }
      : { kind: "keep", reason: "already-on-page" };
  }
  return {
    kind: "capture",
    location: { view: snapshot.view, runId: null, tab: null, spanId: null, file: null },
  };
}

/** 返回来源的结论（restore 的 location 是进入时记下的原引用） */
export type AuxReturnDecision =
  | { readonly kind: "restore"; readonly location: AuxReturnLocation }
  | {
      readonly kind: "fallback";
      readonly view: WorkspaceView;
      readonly reason: "no-location" | "run-missing";
    };

/**
 * 决定「返回来源」落到哪里：运行事实核对**直接复用** `decideCreateReturn`
 * （来源运行在列表 ⇒ restore；没记过或已不在 ⇒ fallback），不复制第二份判据。
 * 创建页来源（无运行阅读位置）只恢复视图——创建草稿/目录引用在 store 里原样。
 */
export function decideAuxReturn(input: {
  readonly location: AuxReturnLocation | null;
  readonly knownRunIds: readonly string[];
}): AuxReturnDecision {
  const loc = input.location;
  if (loc === null) return { kind: "fallback", view: "trace", reason: "no-location" };
  if (loc.view === "create") {
    return { kind: "restore", location: loc };
  }
  const { view, ...reading } = loc;
  // view 已收窄为 SourceView；重建创建页同形的 location 复用既有运行事实核对
  const decision = decideCreateReturn({
    location: {
      view,
      runId: reading.runId,
      tab: reading.tab,
      spanId: reading.spanId,
      file: reading.file,
    },
    knownRunIds: input.knownRunIds,
  });
  if (decision.kind === "restore") return { kind: "restore", location: decision.location };
  return { kind: "fallback", view: decision.view, reason: decision.reason };
}

/** 来源位置里可回写的运行阅读定位片段（创建页/辅助页来源恒为空对象） */
export function auxReadingPatchOfLocation(
  location: AuxReturnLocation,
): Partial<Pick<RunReadingStateLike, "tab" | "spanId">> {
  if (location.tab === null) return {};
  return { tab: location.tab, spanId: location.spanId };
}

/** 只取本模块需要的形状（与 `RunReadingState` 的 tab/spanId 字段同构），避免渲染层类型依赖倒挂 */
interface RunReadingStateLike {
  readonly tab: ReadingTab;
  readonly spanId: string | null;
}

/** 来源位置里的文件定位片段（不是文件页来源 ⇒ null = 不补；与创建页同判据） */
export function auxFilePatchOfLocation(location: AuxReturnLocation): FileLocationRef | null {
  if (location.tab !== "files") return null;
  return location.file;
}
