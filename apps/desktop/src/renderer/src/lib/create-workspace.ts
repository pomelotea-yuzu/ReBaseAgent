import type { RunReadingState } from "./reading-state";

/**
 * U5（unify-run-execution-workflow）任务 4.1：**创建工作区与来源位置引用**（design D1 +
 * delta「桌面端提供原生 run 创建入口 · 创建工作区任务优先且可返回来源」）。
 *
 * 「新建」从覆盖模态改为 App 主工作区的一个页面之后，两件事必须分开：
 *
 * 1. **创建草稿**（`lib/debugging-drafts.ts` 的 `drafts.create`）——模式与两段文本，
 *    会话内唯一、跨离开/重开恢复；
 * 2. **来源位置引用**（本模块）——"这次是从哪儿点进来创建的"，只为"返回来源"服务。
 *
 * 来源引用的三条纪律（spec 逐字要求）：
 *
 * - **只含阅读位置**：运行 / 页签 / 调用 / 文件阅读定位。**不含**草稿正文、目录引用、
 *   授权、凭据，也不含 main 操作登记里的任何东西。
 * - **只存 renderer 会话**：不落盘、不进 URL/日志、不进 IPC。因此重载后必然失效——
 *   失效时只能回退到"已有可用工作区"，**不**从草稿或操作登记反推旧位置（那是伪造）。
 * - **生命周期与草稿互不决定**：草稿的恢复/放弃/正常结束清理都不影响来源；来源的重建
 *   也不影响草稿。每次**从别的工作区**进入创建都取新来源；**创建页内**重复点击「新建」
 *   与**设置往返**沿用本次来源（设置是盖在创建页之上的模态，视图没变）。
 *
 * ⚠️ 命名：`createSourceRef`（store 既有字段）是**隔离运行的源目录引用**（main 签发的
 * token + name/path），与这里的"来源位置"毫无关系，别混用。
 */

/**
 * 主工作区视图：轨迹 / 分支树 / 创建 / 比较，以及 U8（unify-recording-and-experiment-workspaces）
 * 的三个辅助工作区：录制 / 实验 / messages。
 * U5 4.1 起创建是一种视图；U7（improve-branch-comparison）起比较也是；U8 起三个辅助工作区同为主工作区页面。
 * ⚠️ `SourceView`（创建页的合法来源）随之包含 compare 与三个辅助视图——从它们进创建、返回时回到原页
 * （pair / 目标 / 草稿仍在 store 会话里，恢复即还原对象）。
 */
export type WorkspaceView =
  | "trace"
  | "tree"
  | "create"
  | "compare"
  | "recording"
  | "experiment"
  | "messages";

/** 可以充当"来源"的两种视图（创建页自身不是来源） */
export type SourceView = Exclude<WorkspaceView, "create">;

/** 工作区页签（与 `RunReadingState["tab"]` 同一取值域） */
export type ReadingTab = RunReadingState["tab"];

/**
 * 来源引用里的文件阅读定位（U2）。
 *
 * 只记 `checkpoint` + `path` 两个"要看哪"的坐标：文件页其余状态（pane / 搜索 / 宽度 /
 * 滚动）属该 run 的会话阅读状态，返回时由 U2 的按 run 恢复自己带回来，不在此复制第二份。
 */
export interface FileLocationRef {
  readonly checkpoint: string | null;
  readonly path: string | null;
}

/** 一次进入创建时记下的来源位置引用 */
export interface CreateReturnLocation {
  readonly view: SourceView;
  /** 来源运行；null = 进入创建时本就没有选中运行（空列表 / 分支树视图） */
  readonly runId: string | null;
  /** 该运行的页签；`runId === null` 时恒为 null */
  readonly tab: ReadingTab | null;
  /** 该运行的选中调用（随页签一起记；无页签即无调用） */
  readonly spanId: string | null;
  /** 文件阅读定位；仅当来源停在文件页且该 run 确实进入过文件页 */
  readonly file: FileLocationRef | null;
}

/** 判定输入：store 在"进入创建"那一刻现取的阅读现场 */
export interface ReadingLocationSnapshot {
  readonly view: WorkspaceView;
  readonly selectedRunId: string | null;
  /** 当前选中运行的阅读状态；不在轨迹视图或未选中运行 ⇒ null */
  readonly reading: RunReadingState | null;
}

/** 进入创建时对来源引用的处置 */
export type CreateEntryDecision =
  /** 已经在创建页（重复点击「新建」/ 设置往返后仍在创建页）⇒ 本次来源沿用 */
  | { readonly kind: "keep"; readonly reason: "already-in-create" }
  /** 从别的工作区进来 ⇒ 以当时阅读位置重新建立来源 */
  | { readonly kind: "capture"; readonly location: CreateReturnLocation };

/**
 * 决定这次进入创建要不要重记来源。
 *
 * 唯一不重记的情形就是"人还在创建页里"——视图本身就是判据，不需要额外标记：
 * 设置是盖在创建页之上的模态（视图不变 ⇒ 沿用），而经分支树/轨迹再点新建必然经过
 * 非创建视图（⇒ 取新来源）。
 */
export function decideCreateEntry(snapshot: ReadingLocationSnapshot): CreateEntryDecision {
  if (snapshot.view === "create") return { kind: "keep", reason: "already-in-create" };
  const view: SourceView = snapshot.view;
  const reading = snapshot.reading;
  // 分支树视图不承载单运行的阅读位置：即便 store 里留着上一条的选中项也不作为来源
  const runId = view === "trace" ? snapshot.selectedRunId : null;
  const tab = runId === null || reading === null ? null : reading.tab;
  const spanId = tab === null || reading === null ? null : reading.spanId;
  const files = reading?.files;
  // `files === undefined` 就是 store 的 `fileReadingEntered === false`（同一份定义，
  // 不另开第二个判据）；而 `checkpoint === null` 是"进过文件页、停在初始"，必须照记。
  const file =
    tab === "files" && files !== undefined
      ? { checkpoint: files.checkpoint, path: files.path }
      : null;
  return { kind: "capture", location: { view, runId, tab, spanId, file } };
}

/** 返回来源的结论 */
export type CreateReturnDecision =
  /** 来源仍可用：回到记录的视图（并按需恢复该运行的页签 / 调用 / 文件定位） */
  | { readonly kind: "restore"; readonly location: CreateReturnLocation }
  /**
   * 来源不可用：回退到已有可用工作区。
   * - `no-location` = 本会话没记过来源（重载后引用必然失效）
   * - `run-missing` = 来源那条运行已不在列表里（不伪造旧位置）
   */
  | {
      readonly kind: "fallback";
      readonly view: SourceView;
      readonly reason: "no-location" | "run-missing";
    };

/**
 * 决定"返回来源"落到哪里。
 *
 * 判据只用**列表事实**（`knownRunIds` 取自 `runs`）：来源那条运行还在就可以回去，
 * 不在就回退。详情读得出来读不出来交给既有 `selectRun` 的错误态，不在这里预判。
 */
export function decideCreateReturn(input: {
  readonly location: CreateReturnLocation | null;
  readonly knownRunIds: readonly string[];
}): CreateReturnDecision {
  const { location, knownRunIds } = input;
  if (location === null) return { kind: "fallback", view: "trace", reason: "no-location" };
  if (location.runId === null) return { kind: "restore", location };
  if (!knownRunIds.includes(location.runId)) {
    return { kind: "fallback", view: location.view, reason: "run-missing" };
  }
  return { kind: "restore", location };
}

/**
 * 来源位置里"该 run 的会话阅读状态"那一份（返回时先写回，再走 `selectRun` 校验）。
 *
 * 只回写 `tab` / `spanId`：其余阅读状态（展开集、滚动、概览展开块）是**该 run 的现值**，
 * 来源引用里没有记录，也就不该被返回动作抹掉。
 */
export function readingPatchOfLocation(
  location: CreateReturnLocation,
): Partial<Pick<RunReadingState, "tab" | "spanId">> {
  if (location.tab === null) return {};
  return { tab: location.tab, spanId: location.spanId };
}

/** 来源位置里的文件定位片段（不是文件页来源 ⇒ null = 不补） */
export function filePatchOfLocation(location: CreateReturnLocation): FileLocationRef | null {
  if (location.tab !== "files") return null;
  return location.file;
}

/**
 * 当场（该 run 已经是选中运行，不会再走 `selectRun`）要选中的调用。
 *
 * 必须在**当前详情**里点名存在才给——来源记录的是"当时"的位置，详情读失败或
 * 换了对象时不能拿它去高亮一个不属于这里的 span。
 */
export function liveSpanOfLocation(
  location: CreateReturnLocation,
  detailSpanIds: readonly string[],
): string | null {
  if (location.spanId === null) return null;
  return detailSpanIds.includes(location.spanId) ? location.spanId : null;
}
