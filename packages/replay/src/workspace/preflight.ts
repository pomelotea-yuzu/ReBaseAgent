import { configHash } from "@rebaseagent/agent-loop";
import type { RunConfig } from "@rebaseagent/agent-loop";
import { assertForkable, readRun } from "@rebaseagent/trace-sdk";
import type {
  RunLoader,
  RunRecord,
  ToolInvokeSpan,
  WorkspaceOrigin,
  WorkspaceSnapshot,
} from "@rebaseagent/trace-sdk";
import { deriveReplayState } from "../derive.js";
import type { ReplayEdit } from "../derive.js";
import { loadParentChain } from "../parent-chain.js";
import { createWorkspaceBlobStore } from "./blob-store.js";
import { FILE_TOOLS_V1_PROFILE } from "./file-tools.js";
import { checkToolProfile } from "./profile-guard.js";
import { workspaceTraceFile } from "./read-api.js";

/**
 * **只读隔离能力预检**（A design §5/§7，tasks 4.2）：回答"这个父本能不能从该编辑点做隔离续跑"，
 * 并给出**可区分的不可用原因**。
 *
 * ## 三条硬约束
 *
 * 1. **零执行副作用**：不写 trace、不写附件、不调 LLM、不建任何目录。全部动作是"读 JSONL +
 *    读附件字节做校验"。B 段用它做「确认前先取原因」，而**提交时仍要重新预检**——两次预检之间
 *    父本可能被改动，也不能把预检结果当成一次性的通行证（4.3 会重新调用本函数）。
 * 2. **绝不兜底**：缺检查点、缺附件、编辑点落在祖先共享前缀——一律拒绝，**不用父 run 的最终
 *    状态、也不用当前磁盘上的源目录**顶替。隔离续跑的起点只有"直接父那一轮的轮末检查点"一个事实源。
 * 3. **判定复用既有实现，不另写一份**：工具 profile 一致性走 3.3 的 `checkToolProfile`，父链/封存
 *    走 `loadParentChain` + `assertForkable`，消息前缀可派生性走 `deriveReplayState`（在内存里演练一次，
 *    不返回结果），清单 id 与跨行约束由 `readRun` 的 schema 校验顺带完成，附件走附件存储的 `verify`。
 *
 * ## 校验顺序（顺序即优先级）
 *
 * ```
 * 参数形状 → 编辑值形状 → profile 一致性（本次）→ 父链（含环/缺失）→ 已封存
 *   → 直接父必须是 v2 隔离 run → at_span 必须在**直接父自有** spans 里
 *   → at_span 是 tool.invoke，其所属 step 即本次续跑的整轮边界（检查点取该轮末）
 *   → 检查点存在（读取层已保证；缺检查点的记录读不出来）→ 工具批次完整（llm.call + 数量一致）
 *   → config_hash 一致 → 编辑可派生（内存演练）
 *   → 起点清单的全部附件存在且字节/哈希相符
 * ```
 *
 * 便宜的判定放前面（拒绝时零 IO）；昂贵的附件逐字节校验放最后。
 *
 * ## 为什么必须有"编辑点必须在直接父自有记录里"这一条
 *
 * 普通 `replayRun` 允许编辑祖先 run 里的工具点——它的消息前缀是"截断+拼接"出来的，不需要文件状态。
 * 隔离续跑不同：**文件起点只能取直接父该轮的检查点**（`workspace_snapshot` 由父 run 自己写入，
 * 祖先的工具执行发生在更早的轮次，其文件效果早已被后续轮次覆盖，且祖先的检查点不在直接父的记录里）。
 * 若放行"编辑祖先工具、用直接父检查点"，消息里那个工具的返回值被改掉了，而文件状态却是"经过该工具
 * 原本效果之后"的——两者矛盾。所以这里必须显式拒绝，并给出可操作的说明。
 */

/** 预检入参：只吃"显式数据目录 + 分叉意图 + 本次配置" */
export interface IsolatedPreflightOptions {
  /** 数据目录：父 run 位于 `<dataDir>/traces/<id>.jsonl`，附件位于 `<dataDir>/workspace-blobs/` */
  readonly dataDir: string;
  /** 直接父 run id（叶子；可为隔离根 run，也可为隔离分叉 run） */
  readonly parentId: string;
  /** 分叉点：**直接父自有**轨迹里的 `tool.invoke` span id */
  readonly atSpanId: string;
  /** 编辑值（首期只支持改 `result`） */
  readonly edit: ReplayEdit;
  /** 本次运行配置：`systemPrompt` + `tools` 决定 config_hash，必须与父 run 一致 */
  readonly config: RunConfig;
}

/** 可用性结论里的数据（4.3 直接消费；`records` 供同进程编排复用，不是给 IPC 的裁剪结果） */
export interface IsolatedReplayCapability {
  /** 直接父 run id */
  readonly parentId: string;
  /** 被编辑的工具 span id */
  readonly atSpanId: string;
  /** 该工具所属的 `agent.step`（= 检查点所在 = `fork.resume_after_step`） */
  readonly stepSpanId: string;
  /**
   * 检查点的**所属 run**（永远等于直接父）与**本地轮号**（该 step 的 `n`，按所属 run 计而非沿链累加）。
   * 数据定位统一用 `{ownerRunId, stepSpanId, localIteration}`。
   */
  readonly ownerRunId: string;
  readonly localIteration: number;
  /** 起点清单：直接父该轮**全部工具完成后**的完整文件状态（不是父 run 的最终状态） */
  readonly snapshot: WorkspaceSnapshot;
  /**
   * **本次续跑世界**的来源：恒为 `checkpoint` 指向直接父与边界 step。
   *
   * 刻意不复用父本自己的 `meta.workspace.origin`——那个字段描述的是"父本的世界从哪来"
   * （根 run 是 `import`，分叉 run 是更上游的 checkpoint）。新 run 的世界来源由
   * "父身份 + 本轮的边界 step"唯一决定，推导出来才与 schema 的跨字段约束自洽。
   */
  readonly origin: WorkspaceOrigin;
  /** 直接父的配置指纹（已与本次 config 校验一致） */
  readonly configHash: string;
  /** 起点清单的附件校验统计（派生值：逐项 `verify` 通过后才这么报） */
  readonly fileCount: number;
  readonly totalBytes: number;
  /** 父链（根→直接父）解析记录，供 4.3 派生消息前缀复用，避免重复读盘 */
  readonly records: readonly RunRecord[];
}

export type IsolatedPreflightFailureCode =
  | "invalid_request"
  | "invalid_edit"
  | "profile_mismatch"
  | "parent_chain_invalid"
  | "parent_not_forkable"
  | "parent_not_isolated"
  | "ancestor_edit_point"
  | "invalid_edit_point"
  | "incomplete_tool_batch"
  | "missing_config_hash"
  | "source_changed"
  | "derive_failed"
  | "attachment_missing"
  | "attachment_corrupt";

export interface IsolatedPreflightFailure {
  readonly code: IsolatedPreflightFailureCode;
  readonly reason: string;
}

export type IsolatedPreflightResult =
  | { readonly ok: true; readonly value: IsolatedReplayCapability }
  | { readonly ok: false; readonly failure: IsolatedPreflightFailure };

function fail(
  code: IsolatedPreflightFailureCode,
  reason: string,
): { ok: false; failure: IsolatedPreflightFailure } {
  return { ok: false, failure: { code, reason } };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 预检隔离续跑能力。**只读**：任何拒绝都在创建子 trace 与发起 LLM 之前发生。
 *
 * 返回 `ok: true` 时，`value` 里的起点清单与来源已经过完整校验，可以直接建立新世界与派生消息；
 * 调用方**仍不得**跳过真正的执行前校验——`replayIsolatedRun`（4.3）在提交时会再次调用本函数。
 */
export async function preflightIsolatedReplay(
  options: IsolatedPreflightOptions,
): Promise<IsolatedPreflightResult> {
  const { dataDir, parentId, atSpanId, edit, config } = options;

  // ── 1. 参数形状 ─────────────────────────────────────────────────────────────────────
  if (!isNonEmptyString(dataDir)) {
    return fail("invalid_request", `dataDir 必须是非空字符串，实际为 ${JSON.stringify(dataDir)}`);
  }
  if (!isNonEmptyString(parentId)) {
    return fail("invalid_request", `parentId 必须是非空字符串，实际为 ${JSON.stringify(parentId)}`);
  }
  if (!isNonEmptyString(atSpanId)) {
    return fail("invalid_request", `atSpanId 必须是非空字符串，实际为 ${JSON.stringify(atSpanId)}`);
  }
  if (typeof config !== "object" || config === null) {
    return fail("invalid_request", "config 必须是 RunConfig 对象");
  }

  // ── 2. 编辑值形状（真正的"有没有变化"由第 10 步的派生演练判）────────────────────────
  if (typeof edit !== "object" || edit === null || edit.field !== "result") {
    return fail(
      "invalid_edit",
      `仅支持编辑 tool.invoke 的 result 字段（收到 ${JSON.stringify(
        (edit as { field?: unknown } | null | undefined)?.field,
      )}）`,
    );
  }
  if (typeof edit.value !== "string") {
    return fail("invalid_edit", "编辑值 value 必须是字符串");
  }

  // ── 3. 本次工具表必须逐字段等于固定 profile（3.3 门禁；与父本无关，先判）────────────
  const profileCheck = checkToolProfile(config.tools, FILE_TOOLS_V1_PROFILE);
  if (!profileCheck.ok) {
    return fail("profile_mismatch", profileCheck.failure.reason);
  }

  // ── 4. 父链：根→叶；环与缺失都在这里被抓住 ────────────────────────────────────────
  const load: RunLoader = (id) => readRun(workspaceTraceFile(dataDir, id));
  let records: RunRecord[];
  try {
    records = loadParentChain(parentId, load);
  } catch (error) {
    return fail("parent_chain_invalid", `父链加载失败：${messageOf(error)}`);
  }
  const parent = records[records.length - 1];
  if (parent === undefined) {
    return fail("parent_chain_invalid", `父 run 加载失败：${parentId}`);
  }

  // ── 5. 父 run 必须已封存（缺终止事件的 crashed run 前缀不稳定，禁止分叉）────────────
  try {
    assertForkable(parent);
  } catch (error) {
    return fail("parent_not_forkable", messageOf(error));
  }

  // ── 6. 直接父必须是 v2 隔离 run ────────────────────────────────────────────────────
  // v1 父本没有 workspace，也没有任何检查点：旧 trace 无法凭空获得文件状态（历史 JSONL 不迁移、
  // 不补造快照），因此明确拒绝并指向"重新用隔离入口跑一次"。
  const workspace = parent.meta.workspace;
  if (workspace === undefined) {
    return fail(
      "parent_not_isolated",
      `父 run ${parent.meta.id} 不是隔离 run（没有 workspace 元数据，格式版本 ${parent.meta.format_version}）：它没有文件检查点，无法作为隔离续跑的父本；请先经隔离入口重跑一次以获得带检查点的 run`,
    );
  }
  if (workspace.profile !== FILE_TOOLS_V1_PROFILE) {
    return fail(
      "parent_not_isolated",
      `父 run ${parent.meta.id} 的 workspace.profile 为 ${JSON.stringify(workspace.profile)}，本版本只支持 ${FILE_TOOLS_V1_PROFILE}`,
    );
  }

  // ── 7. 编辑点必须在**直接父自有**记录里（祖先共享前缀一律拒绝，见模块头说明）─────────
  const ownIndex = parent.spans.findIndex((span) => span.id === atSpanId);
  if (ownIndex === -1) {
    const ancestorOwner = records
      .slice(0, records.length - 1)
      .find((record) => record.spans.some((span) => span.id === atSpanId));
    if (ancestorOwner !== undefined) {
      return fail(
        "ancestor_edit_point",
        `分叉点 ${atSpanId} 位于祖先 run ${ancestorOwner.meta.id} 的共享前缀里，不在直接父 ${parent.meta.id} 自有的记录中：隔离续跑的文件起点只能取直接父该轮的检查点，编辑祖先工具会让消息与文件状态错配；请改选直接父自有的工具调用，或先让父 run 成为直接父（在更靠近叶子的位置分叉）`,
      );
    }
    return fail(
      "invalid_edit_point",
      `分叉点 ${atSpanId} 不存在于父 run ${parent.meta.id} 的轨迹中，无法定位被编辑的工具调用`,
    );
  }
  const atSpan = parent.spans[ownIndex];
  if (atSpan === undefined) {
    return fail("invalid_edit_point", `分叉点 ${atSpanId} 定位失败（内部不一致）`);
  }
  if (atSpan.kind !== "tool.invoke") {
    return fail(
      "invalid_edit_point",
      `分叉点 ${atSpanId} 必须是 tool.invoke（实际为 ${atSpan.kind}）——只有工具结果是可编辑的数据`,
    );
  }
  const editedTool: ToolInvokeSpan = atSpan;
  if (editedTool.parent === null) {
    return fail(
      "invalid_edit_point",
      `分叉点 ${atSpanId} 缺少父 step（tool.invoke 必须挂在一个 agent.step 下）`,
    );
  }

  // 所属 step = 本次续跑的**整轮边界**（检查点就从这一轮的轮末取）。
  //
  // ⚠️ 边界由 **at_span 的父 span** 决定，不是读父本自己的 `fork.resume_after_step`：
  // 后者记录的是"父本当初从哪一轮续跑"，那是父本的历史，与本次分叉无关；根 run 更是没有 fork 字段。
  // （v2 分支 run 自身"必须带 resume_after_step"由 schema 层保证，这里不重复实现。）
  const step = parent.spans.find((span) => span.id === editedTool.parent);
  if (step === undefined || step.kind !== "agent.step") {
    return fail(
      "invalid_edit_point",
      `分叉点 ${atSpanId} 的父 span ${editedTool.parent} 不是 agent.step`,
    );
  }

  // ── 8. 该轮必须有检查点 ──────────────────────────────────────────────────────────────
  // ⚠️ 这一步**不是**防御性检查，而是类型收窄：reader 的 v2 跨行约束（`reader.ts` 的
  // "v2 隔离运行已完成的 agent.step 必须携带 workspace_snapshot"）已保证已落盘的 step 必带检查点
  // ——缺快照的记录**根本读不出来**，会在第 4 步以父链加载失败被拒（用例覆盖的正是那条路径）。
  // 这里保留分支只为在契约被放宽时**明确失败**，绝不"用父 run 最终状态或当前目录补一个快照"。
  const snapshot = step.workspace_snapshot;
  if (snapshot === undefined) {
    return fail(
      "parent_chain_invalid",
      `第 ${step.n} 轮（step ${step.id}）缺少文件检查点（读取层未拦住，属内部不一致）；隔离续跑不接受用父 run 最终状态或当前目录代替起点`,
    );
  }

  // ── 9. 工具批次完整性：该轮要有自己的 llm.call，且工具数与 tool_calls 一一对应 ────────
  // `deriveReplayState` 按**下标**把 tool.invoke 与 response.tool_calls 对齐，缺一个也不会立刻报错
  // （它会取到错位的那条 call id）——所以"完整批次"这条必须在这里显式判，不能指望派生期发现。
  const stepLlm = parent.spans.find((span) => span.parent === step.id && span.kind === "llm.call");
  if (stepLlm === undefined || stepLlm.kind !== "llm.call") {
    return fail(
      "incomplete_tool_batch",
      `第 ${step.n} 轮（step ${step.id}）缺少 llm.call 录制：无法定位该轮的工具调用上下文，也不可能重建续跑消息前缀`,
    );
  }
  const stepTools = parent.spans.filter(
    (span): span is ToolInvokeSpan => span.parent === step.id && span.kind === "tool.invoke",
  );
  const declaredCalls = stepLlm.response.tool_calls.length;
  if (declaredCalls !== stepTools.length) {
    return fail(
      "incomplete_tool_batch",
      `第 ${step.n} 轮的工具批次不完整：llm.call 声明了 ${declaredCalls} 个工具调用，但只录到 ${stepTools.length} 个 tool.invoke——该轮的整轮边界无法复原（同轮兄弟工具会丢失或错位）`,
    );
  }

  // ── 10. config_hash 一致（换源码属新实验，拒绝伪装成分支）──────────────────────────
  const parentHash = parent.meta.config_hash;
  if (parentHash === undefined) {
    return fail(
      "missing_config_hash",
      `父 run ${parent.meta.id} 没有 config_hash，无法确认本次 system prompt / 工具表与它同源`,
    );
  }
  const hash = configHash(config.systemPrompt, config.tools);
  if (hash !== parentHash) {
    return fail(
      "source_changed",
      `config_hash 不一致：本次 ${hash} ≠ 父 run ${parent.meta.id} 的 ${parentHash}。换源码（system prompt / 工具表）属于新实验而非时间旅行，拒绝伪装成分支`,
    );
  }

  // ── 11. 消息前缀可派生性：纯内存演练一次（不返回结果，4.3 会再派生成实际输入）────────
  // 传 `[parent]` 而不是整条父链：隔离语义只认直接父自有记录，祖先的 spans 不参与续跑。
  try {
    deriveReplayState({ records: [parent], atSpanId, edit });
  } catch (error) {
    return fail("derive_failed", `无法从该编辑点派生续跑上下文：${messageOf(error)}`);
  }

  // ── 12. 附件逐项校验（最贵的一步放最后）：缺失与损坏分别可辨认 ───────────────────────
  const store = createWorkspaceBlobStore(dataDir);
  let totalBytes = 0;
  for (const file of snapshot.files) {
    const verified = await store.verify({ sha256: file.sha256, bytes: file.bytes });
    if (verified.state !== "ok") {
      return fail(
        verified.state === "missing" ? "attachment_missing" : "attachment_corrupt",
        `起点清单里的 ${file.path} 附件不可用（${verified.reason}）——不能从源目录重新读取补齐，请重新导入源目录后再分叉`,
      );
    }
    totalBytes += file.bytes;
  }

  return {
    ok: true,
    value: {
      parentId: parent.meta.id,
      atSpanId,
      stepSpanId: step.id,
      ownerRunId: parent.meta.id,
      localIteration: step.n,
      snapshot,
      // 新世界的来源由"父身份 + 边界 step"推导（见字段注释：不复用父本自己的 origin）
      origin: { kind: "checkpoint", run_id: parent.meta.id, step_span: step.id },
      configHash: hash,
      fileCount: snapshot.files.length,
      totalBytes,
      records,
    },
  };
}
