import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { OpenAiCompatClient, runLoop } from "@rebaseagent/agent-loop";
import type { ForkRunMeta, LlmClient, RunConfig, RunResult } from "@rebaseagent/agent-loop";
import { JsonlTracer, readRun } from "@rebaseagent/trace-sdk";
import { deriveReplayState } from "../derive.js";
import type { ReplayEdit } from "../derive.js";
import { maxSpanSeq } from "../parent-chain.js";
import { newForkRunId } from "../replay-run.js";
import { observeRunIdentity } from "../run-identity.js";
import type { OnRunIdentified } from "../run-identity.js";
import { createWorkspaceCheckpointTracer } from "./checkpoint-tracer.js";
import { createFileToolsV1 } from "./file-tools.js";
import { preflightIsolatedReplay } from "./preflight.js";
import type { IsolatedPreflightFailureCode } from "./preflight.js";
import { checkWriteAuthority } from "./profile-guard.js";
import { WORKSPACE_TRACES_DIR_NAME } from "./read-api.js";
import { createWorkspaceWorld } from "./world.js";

/**
 * **隔离 result 分叉编排**（A design §5/§6，tasks 4.3）：`replayIsolatedRun`。
 *
 * 语义一句话：**从直接父 run 某一轮的轮末检查点继续跑**，消息前缀复用录制、只把被编辑的那条
 * 工具结果换掉；该轮及其之前**一个 LLM、一个工具都不重跑**。
 *
 * ## 顺序（每一步都必须在"创建子 trace / 发 LLM"之前完成）
 *
 * ```
 * 当前请求授权 → 预检（4.2，提交时重跑）→ 派生消息前缀（纯内存）
 *   → 建新世界（起点 = 该轮检查点）→ 固定受控工具
 *   → 临时 trace（span 序号延续父链最大值）→ runLoop（带 forkRun）
 *   → 按 meta.id 归位
 * ```
 *
 * ## 为什么"前缀零调用"是结构保证，而不是承诺
 *
 * - **消息**：`deriveReplayState` 取"分叉点之后首次 llm.call 的录制 request.messages"，把其中那条
 *   工具消息的内容换掉 —— 这是"截断 + 替换"，没有重放。
 * - **文件**：新世界的起点是**直接父那一轮的检查点**（该轮**全部**工具完成后的状态），所以同轮
 *   兄弟工具 T2 的原效果天然在内，**不需要也不会重做 T1/T2**。
 * - **可观测证据**：新 trace 的 span 从父链最大序号之后开始。若前缀被重放过一遍，首个新 span 的
 *   序号就不会紧接父链最大值（用例正是这么断言的）。
 *
 * ## 与根创建（4.1）的差异
 *
 * | | 根创建 | 隔离分叉 |
 * |---|---|---|
 * | 世界起点 | 两遍导入的源目录 | 直接父该轮的检查点 |
 * | `origin` | `{ kind: "import" }` | `{ kind: "checkpoint", run_id: 直接父, step_span: 边界 }` |
 * | meta | `parent`/`fork` 均为 null | 带 `parent` + `fork{at_span, resume_after_step, edit}` |
 * | span 序号 | 从 1 起 | **延续父链最大序号** |
 *
 * ## 不访问源目录、不写父 run
 *
 * 世界建好后只认附件存储；父 run 的 JSONL 只被读、不追加（"父文件不可变"由此保证）。
 * 世界实例是纯内存对象（映射表 + 附件存储引用，附件存储无长开句柄），loop 结束后随作用域释放。
 */

export interface ReplayIsolatedRunOptions {
  /** 数据目录：父 run 在其 `traces/` 下，附件在 `workspace-blobs/` 下 */
  readonly dataDir: string;
  /** 直接父 run id */
  readonly parentId: string;
  /** 分叉点：**直接父自有**轨迹里的 `tool.invoke` span id */
  readonly atSpanId: string;
  /** 编辑值（首期只支持改 `result`） */
  readonly edit: ReplayEdit;
  /** 本次运行配置：system prompt / 工具表必须与父 run 同源 */
  readonly config: RunConfig;
  /**
   * **当前请求**的副本写入授权，原样交给 3.3 的 `checkWriteAuthority`：
   * 唯一通过形状是 `{ allowFileWrites: true }`。父 meta 里的 `write_authorized` 标注无效。
   */
  readonly authority: unknown;
  /** LLM 客户端（测试注入 mock；缺省真调 `config.baseURL`） */
  readonly llm?: LlmClient;
  /**
   * 可选的可信运行身份观察（U4 design D5）：预检/授权/源校验通过后、首次 LLM 前收到
   * 最终 run id（= 落盘 meta.id = 本副本世界的 `world_id`）。
   * 拒绝路径（授权缺失、快照定位失败、预检失败）一律不回调；归位失败也不撤销已报告的身份。
   */
  readonly onRunIdentified?: OnRunIdentified;
}

/** 失败码：本层三类 + 预检原始分类（原样透传，便于上层直接映射提示） */
export type ReplayIsolatedRunFailureCode =
  | "missing_authority"
  | "invalid_snapshot"
  | "run_not_landed"
  | IsolatedPreflightFailureCode;

export interface ReplayIsolatedRunFailure {
  readonly code: ReplayIsolatedRunFailureCode;
  readonly reason: string;
}

export type ReplayIsolatedRunResult =
  | {
      readonly ok: true;
      /** 新分支 run 的 id（文件位于 `<dataDir>/traces/<id>.jsonl`） */
      readonly id: string;
      /** loop 的终止结果（`errored` 也已落盘，由调用方决定提示） */
      readonly outcome: RunResult;
    }
  | { readonly ok: false; readonly failure: ReplayIsolatedRunFailure };

function fail(
  code: ReplayIsolatedRunFailureCode,
  reason: string,
): { ok: false; failure: ReplayIsolatedRunFailure } {
  return { ok: false, failure: { code, reason } };
}

/**
 * 从直接父 run 的一个工具点做隔离续跑，产出新的分支 run。
 *
 * 返回 `ok: true` 表示新文件已归位到 `<dataDir>/traces/<id>.jsonl`（v2 + checkpoint origin +
 * 本 run 自有的检查点），`readRun` / `resolveBranch` 均可正常解析。
 */
export async function replayIsolatedRun(
  options: ReplayIsolatedRunOptions,
): Promise<ReplayIsolatedRunResult> {
  const { dataDir, parentId, atSpanId, edit, config, authority, llm } = options;

  // ── 1. 当前请求的副本写入授权：唯一授权输入，先于一切 IO（含预检的附件读取）──────────
  const authorityCheck = checkWriteAuthority(authority);
  if (!authorityCheck.ok) {
    return fail("missing_authority", authorityCheck.failure.reason);
  }

  // ── 2. 提交时**重新**预检（4.2）─────────────────────────────────────────────────────
  // 不信任调用方此前的预检结果：两次之间父本可能被改动，能力预检本来就是"确认前先看一眼、
  // 提交时再判一次"的两段式。
  const preflight = await preflightIsolatedReplay({ dataDir, parentId, atSpanId, edit, config });
  if (!preflight.ok) {
    return fail(preflight.failure.code, preflight.failure.reason);
  }
  const capability = preflight.value;

  // ── 3. 消息前缀：截断 + 只替换被编辑的那条工具结果（纯内存，零调用）─────────────────
  const state = deriveReplayState({ records: [...capability.records], atSpanId, edit });

  // ── 4. 新世界：独立映射，起点 = 直接父那一轮的轮末检查点 ─────────────────────────────
  // 授权已在上一步通过门禁 ⇒ 这里传 true 是"把校验结果转成世界的入参"，不是新判定。
  const created = createWorkspaceWorld({
    dataDir,
    snapshot: capability.snapshot,
    allowFileWrites: true,
  });
  if (!created.ok) {
    return fail("invalid_snapshot", created.failure.reason);
  }
  const world = created.value;

  // ── 5. 固定受控工具（定义与 config.tools 同源，预检已逐字段核对）──────────────────────
  const tools = createFileToolsV1(world);

  // ── 6. 临时 trace ──────────────────────────────────────────────────────────────────
  const tracesDir = join(dataDir, WORKSPACE_TRACES_DIR_NAME);
  // 目录通常已存在（父 run 就在里面），这一步是为了与 4.1 保持同一前置条件
  mkdirSync(tracesDir, { recursive: true });
  const runId = newForkRunId();
  const tmpFile = join(
    tracesDir,
    `tmp-isolated-fork-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  const delegate = new JsonlTracer(tmpFile, { spanSeqStart: maxSpanSeq(capability.records) });
  const tracer = createWorkspaceCheckpointTracer({
    delegate,
    world,
    runId,
    origin: capability.origin,
  });

  // 分支元数据：`resume_after_step` 必须写（v2 隔离分支的整轮边界），且与 origin.step_span
  // 一致——两者都取自预检定位出的同一个 step。
  const forkRun: ForkRunMeta = {
    id: runId,
    parent: capability.parentId,
    fork: {
      at_span: capability.atSpanId,
      resume_after_step: capability.stepSpanId,
      edit: { field: "result", value: edit.value },
    },
  };

  let outcome: RunResult | null = null;
  let landedId: string | null = null;
  // 挂在底层 delegate 上 ⇒ 报告的是 checkpoint tracer 加工后的最终 meta（与 4.1 同一口径）
  const releaseIdentityWatch = observeRunIdentity(delegate, options.onRunIdentified);
  try {
    outcome = await runLoop(
      config,
      state.messages,
      tracer,
      tools,
      llm ?? new OpenAiCompatClient(config),
      forkRun,
    );
  } finally {
    releaseIdentityWatch();
    // 与 4.1 同序：先释放句柄（Windows 上打开的文件不能改名），再归位。
    delegate.dispose();
    if (existsSync(tmpFile)) {
      landedId = readRun(tmpFile).meta.id;
      renameSync(tmpFile, join(tracesDir, `${landedId}.jsonl`));
    }
  }

  if (outcome === null || landedId === null) {
    return fail(
      "run_not_landed",
      "隔离续跑未产出 trace 文件（loop 未走到 startRun，或临时文件已丢失）",
    );
  }

  return { ok: true, id: landedId, outcome };
}
