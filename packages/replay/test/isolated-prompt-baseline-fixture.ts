import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configHash } from "@rebaseagent/agent-loop";
import { JsonlTracer } from "@rebaseagent/trace-sdk";
import type { WorkspaceFile } from "@rebaseagent/trace-sdk";
import { createWorkspaceSnapshot } from "@rebaseagent/trace-sdk/workspace-hash";
import { createWorkspaceBlobStore } from "../src/workspace/blob-store";
import { FILE_TOOLS_V1_DEFINITIONS, FILE_TOOLS_V1_PROFILE } from "../src/workspace/file-tools";

/**
 * R2.2 任务 1.1 —— config.json 受控案例（fixture）。
 *
 * 场景：原启动指令会"重写整个 config.json"，把用户手工加的未知键覆盖掉；
 * 用户只改一条启动消息（system 或首条 user），从**根初始快照 A**（而不是父最终 B、
 * 也不是当前源目录 C）重新执行，人工判据 = 未知键保留且目标值正确。
 *
 * 三态（对应 workspace「根初始状态与父最终及源目录分离」）：
 * - 初始 A（根 initial_snapshot）：config.json 含未知键 + 目标键初值
 * - 父最终 B（根第 1 轮轮末快照）：原指令覆盖式重写 → 未知键丢失
 * - 源目录 C：当前源目录真实落盘（dataDir/source-dir-c），与 A、B 均不同
 *
 * 案例按 proposal「验收口径」固定，不宣称已完成真实项目接入（I）或 R3 测试验证；
 * mock（本 fixture + 确定性断言）与真实模型（7.1）证据分列。
 */

// ---------------------------------------------------------------------------
// 案例常量（改这里 = 改判据，须同步 baseline 记录文档）
// ---------------------------------------------------------------------------

/** 被实验的文件（工作区内逻辑路径） */
export const CONFIG_PATH = "config.json";

/** 未知键：原指令会覆盖它，人工判据要求保留 */
export const UNKNOWN_KEY = "custom_flag";
export const UNKNOWN_VALUE = "keep-me";

/** 目标键：本次修复要改的值 */
export const TARGET_KEY = "retries";
/** 目标键在初始 A 里的错误初值 */
export const TARGET_INITIAL_VALUE = 1;
/** 目标键的正确值（新指令要写入的值） */
export const TARGET_VALUE = 3;

/** 初始 A：config.json（含未知键、目标键初值错误；保留尾随换行的真实字节） */
export const CONFIG_INITIAL_A = `{
  "${TARGET_KEY}": ${TARGET_INITIAL_VALUE},
  "${UNKNOWN_KEY}": "${UNKNOWN_VALUE}"
}
`;

/** 父最终 B：原指令"重写整个文件"的结果 —— 未知键丢失 */
export const CONFIG_FINAL_B = `{
  "${TARGET_KEY}": ${TARGET_VALUE}
}
`;

/** 源目录 C：当前源目录的 config.json（与 A、B 均不同：目标值又变过、未知键值不同） */
export const CONFIG_SOURCE_C = `{
  "${TARGET_KEY}": 9,
  "${UNKNOWN_KEY}": "changed-by-user"
}
`;

/** 源目录 C 里的第二个文件（证明比较对象是"初始 A 的世界"而不是源目录） */
export const SOURCE_EXTRA_PATH = "README.md";
export const SOURCE_EXTRA_CONTENT =
  "# 示例项目（源目录 C）\n本目录是 R2.2 受控案例的当前源状态。\n";

/** 根 run 首次请求的原 system 指令 */
export const ORIGINAL_SYSTEM_PROMPT =
  "你是本地配置修复助手。修改 config.json 时必须用 write_file 重写整个文件内容。";

/** 根 run 首次请求的原 user 指令（覆盖式重写 → 产生 B，未知键丢失） */
export const ORIGINAL_USER_INSTRUCTION =
  `请把 config.json 的 ${TARGET_KEY} 改成 ${TARGET_VALUE}。` +
  `直接用 write_file 写入完整新内容 {"${TARGET_KEY}": ${TARGET_VALUE}}。`;

/** 单项编辑候选一：只改首条 user 消息（保留 system） */
export const NEW_USER_INSTRUCTION =
  `只把 config.json 的 ${TARGET_KEY} 改成 ${TARGET_VALUE}。` +
  `除 ${TARGET_KEY} 外不得改动或删除文件中的任何其他键（用途未知的键必须原样保留）。`;

/** 单项编辑候选二：只改首条 system 消息（保留 user） */
export const NEW_SYSTEM_PROMPT =
  "你是本地配置修复助手。修改 config.json 时只允许修改目标键，" +
  "文件中的其他全部键（包括用途未知的键）必须原样保留。";

/** 人工判据（随提交落盘到 v3 prompt_experiment.acceptance_criterion；不自动执行） */
export const ACCEPTANCE_CRITERION = `config.json 中 ${TARGET_KEY} === ${TARGET_VALUE} 且 ${UNKNOWN_KEY} === "${UNKNOWN_VALUE}"（未知键保留、目标值正确）；其余键与初始 A 一致。`;

/** 可选假设字段示例（v3 prompt_experiment.hypothesis 的取值形态） */
export const HYPOTHESIS =
  "原指令失败的原因是它要求重写整个文件，覆盖了未知键；单项限定修改范围后未知键会保留。";

/** 基线模型与采样参数（fixture 固定；D2：本入口不允许模型/参数编辑） */
export const BASELINE_MODEL = "deepseek-chat";
export const BASELINE_PARAMS: Record<string, unknown> = { temperature: 0.2 };

/** 固定工具表（file-tools-v1 定义，进首次请求与 config_hash；顺序即注册顺序） */
export const BASELINE_TOOLS = FILE_TOOLS_V1_DEFINITIONS;

/** 首次请求里 tools 字段的运行时形状（去掉 readonly 接口，结构与定义逐字段一致） */
export const BASELINE_REQUEST_TOOLS: Array<Record<string, unknown>> = BASELINE_TOOLS.map(
  (tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    sideEffect: tool.sideEffect,
  }),
);

/** 根 run 的 config_hash（system + 工具表，与 runLoop 同算法） */
export const BASELINE_CONFIG_HASH = configHash(ORIGINAL_SYSTEM_PROMPT, [...BASELINE_TOOLS]);

/** 根 run 首次请求的完整启动 messages（system/user 至少各一条，全部字符串 content） */
export const ORIGINAL_MESSAGES: ReadonlyArray<{ role: string; content: string }> = [
  { role: "system", content: ORIGINAL_SYSTEM_PROMPT },
  { role: "user", content: ORIGINAL_USER_INSTRUCTION },
];

/**
 * D2 单项编辑派生（fixture 层的参考实现）：只替换首条对应字符串消息的 content，
 * 其余消息逐字段原样保留；不 trim、不重排。供「单项改动与首次实际请求一致」断言用。
 */
export function deriveEditedMessages(
  field: "system_prompt" | "user_message",
  value: string,
): Array<{ role: string; content: string }> {
  const targetRole = field === "system_prompt" ? "system" : "user";
  let replaced = false;
  return ORIGINAL_MESSAGES.map((message) => {
    if (!replaced && message.role === targetRole) {
      replaced = true;
      return { ...message, content: value };
    }
    return { ...message };
  });
}

// ---------------------------------------------------------------------------
// 兄弟分支（同根 result 分叉，作为"另一个修复尝试"的比较对象与指纹基线）
// ---------------------------------------------------------------------------

/** 兄弟分支的轮末内容（另一种修复结果；与 A/B 均不同） */
export const CONFIG_SIBLING_FINAL = `{
  "${TARGET_KEY}": ${TARGET_VALUE},
  "${UNKNOWN_KEY}": "sibling-kept"
}
`;

// ---------------------------------------------------------------------------
// fixture 构造器
// ---------------------------------------------------------------------------

/** run 固定 ID（fixture 专用前缀，避免与真实 run 混淆） */
export const BASELINE_ROOT_RUN_ID = "rpex-fixture-root";
export const BASELINE_SIBLING_RUN_ID = "rpex-fixture-sibling";

export interface IsolatedPromptBaselineSpec {
  /** 临时 dataDir（调用方用 `makeDataDir()` 创建并负责清理） */
  readonly dataDir: string;
  /**
   * 空初始世界变体（workspace 场景「空初始世界与后续超限遵守原配额」的基座）：
   * initial_snapshot 为空清单，第 1 轮仍写 config.json。
   */
  readonly emptyInitial?: boolean;
  /** 是否同时写兄弟分支（缺省 true） */
  readonly withSibling?: boolean;
}

export interface IsolatedPromptBaselineCase {
  readonly dataDir: string;
  /** 源目录 C 的物理路径（真实落盘在 dataDir 内） */
  readonly sourceDir: string;
  /** 根 run（v2 隔离根：parent/fork null，origin import） */
  readonly root: {
    readonly runId: string;
    readonly traceFile: string;
    /** 初始快照 A 的清单（emptyInitial 时为空数组） */
    readonly initialFiles: readonly WorkspaceFile[];
    /** 第 1 轮轮末快照 B 的清单 */
    readonly finalFiles: readonly WorkspaceFile[];
    readonly initialSnapshotId: string;
    readonly finalSnapshotId: string;
    readonly stepSpanId: string;
    readonly llmSpanId: string;
    readonly toolSpanId: string;
  };
  /** 兄弟分支（v2 result 分叉；withSibling=false 时为 null） */
  readonly sibling: {
    readonly runId: string;
    readonly traceFile: string;
    /** 分支起点 = 父轮末 B（真实 result 分叉语义） */
    readonly initialFiles: readonly WorkspaceFile[];
    readonly finalFiles: readonly WorkspaceFile[];
    readonly initialSnapshotId: string;
    readonly finalSnapshotId: string;
    readonly stepSpanId: string;
  } | null;
}

function createSnapshot(files: ReadonlyArray<WorkspaceFile>) {
  return createWorkspaceSnapshot(files);
}

/**
 * 构造受控案例：真实发布附件（拿到真哈希）→ 写 v2 隔离根 → 可选写兄弟分支 → 落盘源目录 C。
 * 全部 span 手工经 JsonlTracer 写出（消息/请求体与 runLoop 录制形状一致）。
 */
export async function buildIsolatedPromptBaselineCase(
  spec: IsolatedPromptBaselineSpec,
): Promise<IsolatedPromptBaselineCase> {
  const { dataDir } = spec;
  const store = createWorkspaceBlobStore(dataDir);

  const publish = async (path: string, content: string): Promise<WorkspaceFile> => {
    const published = await store.publish(new TextEncoder().encode(content));
    return { path, sha256: published.sha256, bytes: published.bytes };
  };

  // ---- 根 run ----
  const initialFiles: WorkspaceFile[] = spec.emptyInitial
    ? []
    : [await publish(CONFIG_PATH, CONFIG_INITIAL_A)];
  const finalFiles: WorkspaceFile[] = [await publish(CONFIG_PATH, CONFIG_FINAL_B)];
  const initialSnapshot = createSnapshot(initialFiles);
  const finalSnapshot = createSnapshot(finalFiles);

  mkdirSync(join(dataDir, "traces"), { recursive: true });
  const rootTraceFile = join(dataDir, "traces", `${BASELINE_ROOT_RUN_ID}.jsonl`);
  const tracer = new JsonlTracer(rootTraceFile);
  tracer.startRun({
    id: BASELINE_ROOT_RUN_ID,
    format_version: 2,
    task: "R2.2 受控案例：config.json 未知键保留",
    model: BASELINE_MODEL,
    created_at: "2026-10-20T00:00:00.000Z",
    parent: null,
    fork: null,
    config_hash: BASELINE_CONFIG_HASH,
    workspace: {
      profile: FILE_TOOLS_V1_PROFILE,
      world_id: BASELINE_ROOT_RUN_ID,
      write_authorized: true,
      initial_snapshot: initialSnapshot,
      origin: { kind: "import" },
    },
  });

  const rootStep = tracer.startSpan({ kind: "agent.step", n: 1 });
  const rootLlm = tracer.startSpan({
    kind: "llm.call",
    parent: rootStep,
    request: {
      model: BASELINE_MODEL,
      messages: [...ORIGINAL_MESSAGES],
      tools: BASELINE_REQUEST_TOOLS,
      params: { ...BASELINE_PARAMS },
    },
  });
  tracer.endSpan(rootLlm, {
    response: {
      content: null,
      reasoning_content: null,
      tool_calls: [
        {
          id: "call_rpex_fixture_1",
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({ path: CONFIG_PATH, content: CONFIG_FINAL_B }),
          },
        },
      ],
      usage: { in: 128, out: 32 },
      ttft_ms: 5,
    },
  });
  const rootTool = tracer.startSpan({
    kind: "tool.invoke",
    parent: rootStep,
    tool: "write_file",
    args: { path: CONFIG_PATH, content: CONFIG_FINAL_B },
  });
  tracer.endSpan(rootTool, { result: "已写入 config.json", dur_ms: 1, error: null });
  tracer.endSpan(rootStep, { workspace_snapshot: finalSnapshot });
  tracer.endRun({ event: "stopped", reason: "completed", at: 1 });

  // ---- 兄弟分支（v2 result 分叉：起点 = 父轮末 B） ----
  let sibling: IsolatedPromptBaselineCase["sibling"] = null;
  if (spec.withSibling !== false) {
    const siblingInitialFiles = [...finalFiles];
    const siblingFinalFiles = [await publish(CONFIG_PATH, CONFIG_SIBLING_FINAL)];
    const siblingInitialSnapshot = createSnapshot(siblingInitialFiles);
    const siblingFinalSnapshot = createSnapshot(siblingFinalFiles);

    const siblingTraceFile = join(dataDir, "traces", `${BASELINE_SIBLING_RUN_ID}.jsonl`);
    const siblingTracer = new JsonlTracer(siblingTraceFile, { spanSeqStart: 100 });
    siblingTracer.startRun({
      id: BASELINE_SIBLING_RUN_ID,
      format_version: 2,
      task: "R2.2 受控案例：兄弟分支（另一种修复尝试）",
      model: BASELINE_MODEL,
      created_at: "2026-10-20T00:01:00.000Z",
      parent: BASELINE_ROOT_RUN_ID,
      fork: {
        at_span: rootStep,
        resume_after_step: rootStep,
        edit: { field: "result", value: "重试：要求保留未知键再写一次" },
      },
      config_hash: BASELINE_CONFIG_HASH,
      workspace: {
        profile: FILE_TOOLS_V1_PROFILE,
        world_id: BASELINE_SIBLING_RUN_ID,
        write_authorized: true,
        initial_snapshot: siblingInitialSnapshot,
        origin: {
          kind: "checkpoint",
          run_id: BASELINE_ROOT_RUN_ID,
          step_span: rootStep,
        },
      },
    });

    const siblingStep = siblingTracer.startSpan({ kind: "agent.step", n: 1 });
    const siblingLlm = siblingTracer.startSpan({
      kind: "llm.call",
      parent: siblingStep,
      request: {
        model: BASELINE_MODEL,
        messages: [
          ...ORIGINAL_MESSAGES,
          { role: "assistant", content: null, tool_calls: [] },
          { role: "tool", tool_call_id: "call_rpex_fixture_1", content: "已写入 config.json" },
        ],
        tools: BASELINE_REQUEST_TOOLS,
        params: { ...BASELINE_PARAMS },
      },
    });
    siblingTracer.endSpan(siblingLlm, {
      response: {
        content: null,
        reasoning_content: null,
        tool_calls: [
          {
            id: "call_rpex_sibling_1",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: CONFIG_PATH, content: CONFIG_SIBLING_FINAL }),
            },
          },
        ],
        usage: { in: 160, out: 28 },
        ttft_ms: 4,
      },
    });
    const siblingTool = siblingTracer.startSpan({
      kind: "tool.invoke",
      parent: siblingStep,
      tool: "write_file",
      args: { path: CONFIG_PATH, content: CONFIG_SIBLING_FINAL },
    });
    siblingTracer.endSpan(siblingTool, { result: "已写入 config.json", dur_ms: 1, error: null });
    siblingTracer.endSpan(siblingStep, { workspace_snapshot: siblingFinalSnapshot });
    siblingTracer.endRun({ event: "stopped", reason: "completed", at: 1 });

    sibling = {
      runId: BASELINE_SIBLING_RUN_ID,
      traceFile: siblingTraceFile,
      initialFiles: siblingInitialFiles,
      finalFiles: siblingFinalFiles,
      initialSnapshotId: siblingInitialSnapshot.id,
      finalSnapshotId: siblingFinalSnapshot.id,
      stepSpanId: siblingStep,
    };
  }

  // ---- 源目录 C（真实落盘；实验不读它，7.1 用它验证「起点只取 A」） ----
  const sourceDir = join(dataDir, "source-dir-c");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, CONFIG_PATH), CONFIG_SOURCE_C);
  writeFileSync(join(sourceDir, SOURCE_EXTRA_PATH), SOURCE_EXTRA_CONTENT);

  return {
    dataDir,
    sourceDir,
    root: {
      runId: BASELINE_ROOT_RUN_ID,
      traceFile: rootTraceFile,
      initialFiles,
      finalFiles,
      initialSnapshotId: initialSnapshot.id,
      finalSnapshotId: finalSnapshot.id,
      stepSpanId: rootStep,
      llmSpanId: rootLlm,
      toolSpanId: rootTool,
    },
    sibling,
  };
}
