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
 */
export interface DiffSides {
  readonly left: string | null;
  readonly right: string | null;
  readonly leftLabel: string;
  readonly rightLabel: string;
  /** 是否至少一侧有内容可显示（两侧都缺席时不该进编辑器） */
  readonly hasContent: boolean;
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
    hasContent: left !== null || right !== null,
  };
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
