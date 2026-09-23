import type { SpanLine } from "@rebaseagent/trace-sdk";
import type {
  WorkspaceInspectFile,
  WorkspaceInspectResult,
  WorkspaceReadFileResult,
} from "@shared/ipc";
import { formatBytes } from "./format";

/**
 * 文件检查点视图在渲染层的纯逻辑（C 任务 1.2）。
 *
 * 三条纪律（与 B 2.2 的 `isolated-fork.ts` 同法）：
 *
 * 1. **轮号一律取所属 run 自己的 `agent.step.n`**——绝不按合并轨迹沿链累加。
 *    A 有 3 轮、子 B 本地第 1 轮再分叉出 C 时，B 的选择器写"本 run 第 1 轮结束"，
 *    C 的起点来源指 B 第 1 轮；**不得**标成全链第 4 轮。
 * 2. **判据与请求同源**：选择器一次给出"能选哪些检查点 + 选中的是什么"，
 *    与"哪些文件能点开"用同一份结论，不在组件里另算一遍。
 * 3. **状态必须可分辨**：二进制 / 不存在 / 缺失 / 损坏各自有独立文案，
 *    **不得**把缺失或损坏渲染成空文件，也不用"当前目录"兜底。
 *
 * ⚠️ 本层是**早拦层，不是权威判据**：run 归属、清单合法性、附件哈希只在
 * main（`workspace-view.ts`）与 A 包里判。渲染层只是把结论排版出来。
 */

/** 一个可选的检查点（选择器条目） */
export interface CheckpointOption {
  /** null = 初始快照（"本 run 初始状态"，不是"第 0 轮结束"） */
  readonly stepSpanId: string | null;
  /** 轮号 = 所属 run 自己的 `agent.step.n`；初始快照为 null */
  readonly localIteration: number | null;
  /** 选择器主体文案 */
  readonly label: string;
  /** 来源说明（分支 run 的起点另标父 run，不写成"本 run 第 N 轮"） */
  readonly originNote: string | null;
}

/**
 * 从**当前 run 的详情轨迹**派生可选检查点。
 *
 * 只取 `leafSpanIds` 里的 `agent.step`——祖先前缀的 step 是 `resolveBranch` 拼出来的、
 * 不属于本 run，把它们列进选择器就是"把祖先当本 run 的文件检查点"（本段明令禁止）。
 * 因此判据必须是"这个 step 在 leafSpanIds 里"，而不是"它出现在合并轨迹里"。
 */
export function deriveCheckpointOptions(run: {
  spans: readonly SpanLine[];
  leafSpanIds: readonly string[];
  meta: { workspace?: unknown };
}): CheckpointOption[] {
  const owned = new Set(run.leafSpanIds);
  const steps = run.spans.filter(
    (span): span is Extract<SpanLine, { kind: "agent.step" }> =>
      span.kind === "agent.step" && owned.has(span.id),
  );

  const initial: CheckpointOption = {
    stepSpanId: null,
    localIteration: null,
    label: "本 run 初始状态",
    originNote: null,
  };

  // 按轮号升序（`n` 是所属 run 的本地轮号，本来就是 1..N）
  const stepOptions = [...steps]
    .sort((a, b) => a.n - b.n)
    .map((step) => ({
      stepSpanId: step.id,
      localIteration: step.n,
      // 文案固定为"本 run 第 N 轮结束"——**不**写"沿链第 N 轮"
      label: `本 run 第 ${step.n} 轮结束`,
      originNote: null,
    }));

  return [initial, ...stepOptions];
}

/**
 * U2 任务 2.2：默认检查点 —— **最近的自有完成步骤**；没有自有完成步骤时退**初始状态**。
 *
 * 判据与 `deriveCheckpointOptions` 同源（都只取 `leafSpanIds` 里的 `agent.step`）：
 * 不借用祖先步骤、不按合并轨迹下标选、不因"run 整体非 completed"而隐藏已有步骤
 * （delta「首次文件页选择最近自有完成步骤」明确：**失败 run 的既有完成步骤同样可用**）。
 *
 * ⚠️ "最近"按**本 run 本地轮号 `n` 最大**判，不是合并轨迹里的数组下标——合并轨迹把
 *    祖先 span 排在本 run 之前，用下标会选到祖先的步骤。
 */
export function defaultCheckpointStepId(run: {
  spans: readonly SpanLine[];
  leafSpanIds: readonly string[];
  meta: { workspace?: unknown };
}): string | null {
  const options = deriveCheckpointOptions(run);
  // options[0] 恒为初始（stepSpanId: null）；其余按 n 升序 ⇒ 末条即最近
  const steps = options.filter(
    (option): option is CheckpointOption & { stepSpanId: string } => option.stepSpanId !== null,
  );
  return steps.length === 0 ? null : (steps[steps.length - 1]?.stepSpanId ?? null);
}

/**
 * U2 任务 2.2：校验保存/显式指定的检查点是否仍属于当前 run。
 *
 * 三种结论与 delta「失效检查点和路径安全回退」一一对应：
 * - `"initial"`：请求的就是初始状态（合法）；
 * - `"valid"`：该 step 仍是本 run 的自有完成步骤；
 * - `"stale"`：**不再属于本 run**（祖先步骤 / 已被删的轮次 / 拼错的 id）⇒ 调用方须提示并回退默认，
 *   **不得**改用另一个"看起来可读"的检查点。
 */
export function validateCheckpointStepId(
  run: {
    spans: readonly SpanLine[];
    leafSpanIds: readonly string[];
    meta: { workspace?: unknown };
  },
  stepSpanId: string | null,
): "initial" | "valid" | "stale" {
  if (stepSpanId === null) return "initial";
  const options = deriveCheckpointOptions(run);
  return options.some((option) => option.stepSpanId === stepSpanId) ? "valid" : "stale";
}

/**
 * U2 任务 2.2：保存的 path 在新清单里是否仍然存在。
 *
 * - `"present"`：完整逻辑路径在清单里 ⇒ **保留选择**（即使附件不可用或不符合筛选，
 *   也保留阅读意图——delta「切检查点保留仍存在的路径」）；
 * - `"absent"`：清单**确认**路径不存在 ⇒ 调用方提示、清空选择、显示列表，
 *   **不得**改选另一同名路径；
 * - `"unknown"`：尚未拿到清单 / 清单读取失败 ⇒ **不当作路径已消失**，保留意图以便重试
 *   （delta「读取失败 SHALL NOT 等同引用消失」）。
 */
export function validateSavedPath(
  inspect: { files: readonly { path: string }[] } | null,
  inspectFailed: boolean,
  path: string | null,
): "present" | "absent" | "unknown" {
  if (path === null) return "unknown";
  if (inspectFailed || inspect === null) return "unknown";
  return inspect.files.some((file) => file.path === path) ? "present" : "absent";
}

/**
 * 检查点选择器顶部的**来源说明**（选择题 2 的判据面）：
 *
 * - 根 run：世界由源目录导入，说明写"独立文件世界（导入）"；
 * - 分支 run：世界来自**父 run 的某一轮检查点**——这里的轮号也取父 run 自己的 `n`，
 *   并显式标出父 run id，绝不把父的轮号写成"本 run 第 N 轮"。
 *
 * `parentIteration` 为 null 表示父 run 的轮号解析不出来（父文件缺失等）——
 * 此时只报 step，**不猜**一个"看起来对"的轮号。
 */
export function checkpointOriginNote(
  inspect: WorkspaceInspectResult,
  parentIteration: number | null,
): string {
  const origin = inspect.origin;
  if (origin.kind === "import") {
    return `独立文件世界（world_id ${inspect.worldId}），由选定源目录采集而来；本 run 的初始状态即该世界的起点。`;
  }
  const iterationText =
    parentIteration === null
      ? `父运行 ${origin.runId} 的某一轮检查点（轮号未能在轨迹中解析，此处只报 step ${origin.stepSpanId}）`
      : `父运行 ${origin.runId} 的第 ${parentIteration} 轮检查点`;
  return `本 run 的文件世界从 ${iterationText} 续跑而来；本 run 的"初始状态"即该检查点，不是父 run 的第 1 轮。`;
}

/** 变更状态的中文短标签（added / modified / unchanged / initial） */
export function changeLabel(change: WorkspaceInspectFile["change"]): string {
  switch (change) {
    case "added":
      return "新增";
    case "modified":
      return "修改";
    case "unchanged":
      return "未变";
    case "initial":
      return "初始";
  }
}

/** 附件可用性的中文短标签（ok / missing / corrupt） */
export function availabilityLabel(availability: WorkspaceInspectFile["availability"]): string {
  switch (availability) {
    case "ok":
      return "可读";
    case "missing":
      return "附件缺失";
    case "corrupt":
      return "附件损坏";
  }
}

/** 清单规模一行：文件数 / 总字节 / 不可用附件数 */
export function inspectSummaryLine(inspect: WorkspaceInspectResult): string {
  const base = `${inspect.fileCount} 个文件 / ${formatBytes(inspect.totalBytes)}`;
  return inspect.unavailableCount === 0
    ? base
    : `${base} · ⚠ ${inspect.unavailableCount} 个附件不可用`;
}

/**
 * 某个文件**能不能进文本比较**：只有两侧都拿到 text 才允许。
 *
 * 二进制、缺失、损坏、不存在一律不进 DiffEditor——否则编辑器会把"没有内容"
 * 渲染成空文件，正好是本段禁止的"伪空文件"。返回原因供界面禁用时说明。
 */
export function canCompareText(
  side: WorkspaceReadFileResult | null,
): { ok: true } | { ok: false; reason: string } {
  if (side === null) return { ok: true };
  switch (side.status) {
    case "text":
      return { ok: true };
    case "binary":
      return { ok: false, reason: "二进制文件不参与文本比较（只展示大小与哈希）" };
    case "missing":
      return { ok: false, reason: "附件缺失，无法读取内容；不会用空文本或源目录兜底" };
    case "corrupt":
      return { ok: false, reason: "附件与清单记录的哈希/长度不符，拒绝展示内容" };
    case "not_found":
      return { ok: false, reason: "该路径不在所选清单里（可能是本 run 新增或已不存在）" };
    case "rejected":
      return { ok: false, reason: `请求被拒绝：${side.reason}` };
  }
}

/**
 * DiffEditor 的左右两侧文本。
 *
 * 缺席的一侧**显式表达为"不存在"**而不是空字符串——`null` 交给调用方渲染成
 * "（该侧不存在）"的提示，绝不用 `""` 冒充"文件是空的"。
 *
 * U2 任务 3.3 起，每一侧另带**缺席原因**（`leftNote` / `rightNote`），因为"缺席"至少有四种
 * 不同含义，界面**必须**分开表达（delta「不可用侧不伪装为空差异」）：
 * - `"text"`：有文本；
 * - `"not_found"`：清单确认该侧不存在（新增文件的初始侧）——**合法**，算作"缺失的空侧"；
 * - `"unavailable"`：binary / missing / corrupt —— **不可比较**，不得当作空文本参与 diff；
 * - `"unread"`：null（加载中 / 通道失败 / 还没读）—— **不是**"不存在"。
 */
export type DiffSideNote = "text" | "not_found" | "unavailable" | "unread";

export interface DiffSides {
  readonly left: string | null;
  readonly right: string | null;
  readonly leftLabel: string;
  readonly rightLabel: string;
  readonly leftNote: DiffSideNote;
  readonly rightNote: DiffSideNote;
  /** 是否至少一侧有内容可显示（两侧都缺席时不该进编辑器） */
  readonly hasContent: boolean;
}

function sideNoteOf(side: WorkspaceReadFileResult | null): DiffSideNote {
  if (side === null) return "unread";
  switch (side.status) {
    case "text":
      return "text";
    case "not_found":
      return "not_found";
    // binary / missing / corrupt / rejected 都不可参与文本比较
    default:
      return "unavailable";
  }
}

export function resolveDiffSides(
  initial: WorkspaceReadFileResult | null,
  selected: WorkspaceReadFileResult | null,
  labels: { initial: string; selected: string },
): DiffSides {
  const left = initial?.status === "text" ? initial.text : null;
  const right = selected?.status === "text" ? selected.text : null;
  return {
    left,
    right,
    leftLabel: labels.initial,
    rightLabel: labels.selected,
    leftNote: sideNoteOf(initial),
    rightNote: sideNoteOf(selected),
    hasContent: left !== null || right !== null,
  };
}

/**
 * U2 任务 3.3：两侧**是否具备进入文本 diff 的资格**。
 *
 * delta 明文：只有「两侧均为 text」，或「**经校验的初始 `not_found`** 与「所选 `text`」
 * 才进 diff（新增文件的初始侧本就不存在，是**合法的空侧**）；新增文件用空侧时
 * **保留"不存在"标识**（不是把空侧当空文本）。
 *
 * 其余一律不进：
 * - 任一侧 `unavailable`（binary / missing / corrupt / rejected）⇒ 不得用空文本参与比较
 *   （否则就是"不可用侧伪装为空差异"）；
 * - 任一侧 `unread`（null，加载中 / 通道失败 / 还没读）⇒ "未读"不等于"不存在"；
 * - **所选侧** `not_found` ⇒ 所选检查点里根本没有这条路径，不该当空侧比较。
 */
export function canEnterTextDiff(sides: DiffSides): { ok: true } | { ok: false; reason: string } {
  const leftOk = sides.leftNote === "text" || sides.leftNote === "not_found";
  const rightOk = sides.rightNote === "text";
  if (!leftOk || !rightOk) {
    return {
      ok: false,
      reason:
        "至少一侧不可比较（不可用 / 尚未读取 / 读取失败 / 所选侧不存在）；不会把该侧当空文本参与 diff。",
    };
  }
  return { ok: true };
}

/** Monaco 语言嗅探：内容可解析为 JSON 用 json，否则纯文本（与既有编辑器同判据） */
export function detectFileLanguage(text: string | null): "json" | "plaintext" {
  if (text === null) return "plaintext";
  try {
    JSON.parse(text);
    return "json";
  } catch {
    return "plaintext";
  }
}
