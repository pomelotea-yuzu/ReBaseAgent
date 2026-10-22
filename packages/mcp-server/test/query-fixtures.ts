import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlTracer } from "@rebaseagent/trace-sdk";
import { createWorkspaceSnapshot } from "@rebaseagent/trace-sdk/workspace-hash";

/**
 * MCP0 4.3 的查询夹具（list_runs / get_run 共用）。
 *
 * 全部走 `JsonlTracer` 真写 + `createWorkspaceSnapshot` 真算快照 id：手写 JSON 行会
 * 绕过读取层的跨行判据（快照 id 重算、v2/v3 字段门禁），造出「桌面读不出来但
 * MCP 测得过」的假对象。
 *
 * 覆盖矩阵（每类都存在、都有名字可指认）：
 * - 五种结局类别（正常/出错/上限/中止/未封存）+ 无 llm.call（消耗未知）；
 * - result 分叉子（父链 resolved + 继承 span 的真实 owner）；
 * - prompt 分叉孤儿（父确实缺失 ⇒ ownOnly + ANCESTOR_NOT_FOUND）；
 * - 重名 span 的父子（`ambiguousOwner`）；
 * - 同一 `created_at` 的两个 run（UTF-16 升序 vs 区域排序的可分辨对）；
 * - v2 隔离根（检查点索引）+ 以它为基线的 v3 隔离 prompt 实验（实验身份 + 原值/假设正文）；
 * - 一个完全解析不了的文件 + 一个文件名与 meta.id 不符的文件；
 * - 一批同名前缀的普通 run，把总数抬过默认页宽 20。
 *
 * 正文类字段一律带 `SENTINEL-*` 标记值：白名单判据就是把结果序列化后逐个搜这些标记，
 * 少挡一个字段都会当场变红。
 */

const T0 = "2026-10-20T00:00:00.000Z";

/** 第 n 秒后的时间戳（列表排序要的是可预期的、彼此不同的 created_at） */
function at(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString();
}

export const SENTINELS = {
  messageBody: "SENTINEL-message-body",
  responseContent: "SENTINEL-response-content",
  toolResult: "SENTINEL-tool-result-body",
  toolArgs: "SENTINEL-tool-args-note",
  forkValue: "SENTINEL-fork-edit-value",
  originalValue: "SENTINEL-original-value",
  hypothesis: "SENTINEL-hypothesis",
  acceptanceCriterion: "SENTINEL-acceptance-criterion",
  toolErrorBody: "SENTINEL-tool-error-body",
  llmErrorBody: "SENTINEL-llm-error-message",
  /** 长正文的前缀：既是 canary，也让「第 4020 码点正好落在代理对上」可算 */
  longBodyPrefix: "SENTINEL-long-body-",
} as const;

/**
 * 长正文：19 前缀 + 5000 个「甲」+ 3 个代理对 emoji + 19 个「乙」= 5041 码点（UTF-16 是 5044 单元）。
 * 前缀本身是 canary（未请求正文时它必须不出现），emoji 的位置让「按码点切」与「按代码单元切」可分辨。
 */
export const LONG_BODY = `${SENTINELS.longBodyPrefix}${"甲".repeat(5000)}🙂🙂🙂${"乙".repeat(19)}`;

/** 长正文里第一个代理对的起始码点位置（测试据此挑一个正好切在半个字符上的上限） */
export const LONG_BODY_EMOJI_START = SENTINELS.longBodyPrefix.length + 5000;

export interface QueryFixtureIds {
  readonly alpha: string;
  readonly beta: string;
  readonly gamma: string;
  readonly delta: string;
  readonly epsilon: string;
  readonly zeta: string;
  readonly child: string;
  readonly orphan: string;
  readonly ambiguousParent: string;
  readonly ambiguousChild: string;
  readonly tieLower: string;
  readonly tieUpper: string;
  /** 4.4：父有 s_01..s_03，子在 s_02 处分叉 ⇒ s_03 被投影截断 */
  readonly cutParent: string;
  readonly cutChild: string;
  /** 4.4：工具错误正文 + 结果为 null + llm 失败详情（503） */
  readonly bodies: string;
  /** 4.4：连 result 字段都没写（未记录，与录了 null 不同） */
  readonly sparse: string;
  /** 4.4：工具错误录成空串（录了但为空，与未记录可分辨） */
  readonly emptyError: string;
  /** 4.4：超长正文（代理对正好落在切片边界附近） */
  readonly bigBody: string;
  readonly workspaceRoot: string;
  readonly experiment: string;
  readonly corrupt: string;
  readonly identityFile: string;
  readonly identityRecordedId: string;
  readonly overLongId: string;
  readonly missing: string;
  readonly bulkPrefix: string;
  readonly bulkCount: number;
}

export interface QueryFixture {
  readonly dataDir: string;
  readonly tracesDir: string;
  readonly ids: QueryFixtureIds;
  /** v2 隔离根的初始快照（v3 实验的起点与它逐字节同一份） */
  readonly initialSnapshotId: string;
  readonly finalSnapshotId: string;
  readonly workspaceRootFirstLlmSpanId: string;
}

const roots: string[] = [];

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/**
 * 目录逐文件指纹（相对名 + 内容哈希 + 目录标记）。
 * 只读查询跑完再取一次，两边必须逐字相同——「没写盘」是被比较出来的，不是声明的。
 */
export function dirFingerprint(dir: string): string {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) =>
      entry.isDirectory()
        ? `${entry.name}:dir`
        : `${entry.name}:${sha256(readFileSync(join(dir, entry.name)).toString("utf8"))}`,
    )
    .join("\n");
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp0-query-"));
  roots.push(dir);
  return dir;
}

export function cleanupQueryFixtures(): void {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface V1RunOptions {
  readonly createdAt: string;
  readonly task?: string;
  readonly parent?: string | null;
  readonly forkField?: string;
  readonly forkAtSpan?: string;
  readonly forkValue?: unknown;
  readonly spanSeqStart?: number;
  /** 省略 = 正常结束；"none" = 不写终止事件（未封存） */
  readonly reason?:
    | "completed"
    | "error"
    | "max_iterations"
    | "budget_exceeded"
    | "aborted"
    | "none";
  readonly llm?: boolean;
  readonly tool?: boolean;
  readonly usage?: { readonly in: number; readonly out: number; readonly cache_hit?: number };
  /** 源配置声明的累计 token 预算（省略 = 未录，MCP 侧必须如实给 null） */
  readonly budgetMaxTotalTokens?: number;
  /** 工具错误正文：`null` 与省略都是「未记录」，空串是「录了但为空」 */
  readonly toolError?: string;
  /** 工具结果正文（省略 = 用默认 canary 值） */
  readonly toolResult?: unknown;
  /** true = 结果录成 `null`（与"字段缺失"和"录了字符串"三态互斥） */
  readonly toolResultNull?: boolean;
  /** true = 连 `result` 字段都不写（未记录，与录了 null 不同） */
  readonly omitResult?: boolean;
  /** llm 调用失败详情（省略 = 未记录错误详情） */
  readonly llmError?: { message: string; status?: number };
}

/** 写一个 v1 run：一步（可选一请求一工具），返回它的 span id 便于被分叉引用 */
function writeV1Run(
  tracesDir: string,
  id: string,
  options: V1RunOptions,
): { readonly stepSpanId: string; readonly llmSpanId: string; readonly toolSpanId: string } {
  const tracer = new JsonlTracer(join(tracesDir, `${id}.jsonl`), {
    ...(options.spanSeqStart === undefined ? {} : { spanSeqStart: options.spanSeqStart }),
  });
  const isFork = options.parent !== undefined && options.parent !== null;
  tracer.startRun({
    id,
    format_version: 1,
    task: options.task ?? `MCP0 4.3 投影夹具 ${id}`,
    model: "controlled-model",
    created_at: options.createdAt,
    parent: options.parent ?? null,
    fork: isFork
      ? {
          at_span: options.forkAtSpan ?? "s_03",
          edit: {
            field: options.forkField ?? "result",
            value: options.forkValue ?? SENTINELS.forkValue,
          },
        }
      : null,
    ...(options.budgetMaxTotalTokens === undefined
      ? {}
      : { budget: { max_total_tokens: options.budgetMaxTotalTokens } }),
    ...(!isFork ? { config_hash: "sha256:controlled-config" } : {}),
  });

  const step = tracer.startSpan({ kind: "agent.step", n: 1 });
  let llm = step;
  let tool = step;
  if (options.llm !== false) {
    llm = tracer.startSpan({
      kind: "llm.call",
      parent: step,
      request: {
        model: "controlled-model",
        messages: [
          { role: "system", content: SENTINELS.messageBody },
          { role: "user", content: "读一下 a.txt" },
        ],
      },
    });
    tracer.endSpan(llm, {
      response: {
        content: SENTINELS.responseContent,
        reasoning_content: null,
        tool_calls: [],
        usage: options.usage ?? { in: 10, out: 4 },
        ttft_ms: 3,
      },
      ...(options.llmError === undefined ? {} : { error: options.llmError }),
    });
  }
  if (options.tool !== false) {
    tool = tracer.startSpan({
      kind: "tool.invoke",
      parent: step,
      tool: "read_file",
      // 键序刻意倒着写：规范 JSON 必须把它排成 note 在前（外发正文的稳定性判据）
      args: { zeta: 1, note: SENTINELS.toolArgs, alpha: { path: "a.txt" } },
    });
    tracer.endSpan(tool, {
      result: options.omitResult
        ? undefined
        : options.toolResultNull
          ? null
          : (options.toolResult ?? SENTINELS.toolResult),
      dur_ms: 7,
      error: options.toolError ?? null,
    });
  }
  tracer.endSpan(step);
  if (options.reason !== "none") {
    tracer.endRun({
      event:
        options.reason === "aborted"
          ? "aborted"
          : options.reason === "error"
            ? "errored"
            : "stopped",
      reason: options.reason ?? "completed",
      at: 1,
    });
  } else {
    // 未封存：只关句柄、不补终止事件（readRun 如实判 crashed）
    tracer.dispose();
  }
  return { stepSpanId: step, llmSpanId: llm, toolSpanId: tool };
}

/** 只有一步、没有请求也没有工具的极简 run（用来把条目数抬过默认页宽） */
function writeMinimalRun(tracesDir: string, id: string, createdAt: string): void {
  writeV1Run(tracesDir, id, { createdAt, llm: false, tool: false });
}

function metaLine(id: string, createdAt: string, task: string): string {
  return JSON.stringify({
    type: "run.meta",
    id,
    format_version: 1,
    task,
    model: "controlled-model",
    created_at: createdAt,
    parent: null,
    fork: null,
  });
}

const STOP_LINE = JSON.stringify({ type: "run.event", event: "stopped", reason: "completed" });

export function buildQueryFixture(): QueryFixture {
  const dataDir = tempDir();
  const tracesDir = join(dataDir, "traces");
  mkdirSync(tracesDir, { recursive: true });

  const alpha = writeV1Run(tracesDir, "mcp0-alpha", {
    createdAt: at(60),
    usage: { in: 100, out: 20, cache_hit: 40 },
    budgetMaxTotalTokens: 100_000,
  });
  writeV1Run(tracesDir, "mcp0-beta", { createdAt: at(50), reason: "max_iterations" });
  writeV1Run(tracesDir, "mcp0-gamma", { createdAt: at(40), reason: "error" });
  writeV1Run(tracesDir, "mcp0-delta", { createdAt: at(30), reason: "aborted" });
  writeV1Run(tracesDir, "mcp0-epsilon", { createdAt: at(20), reason: "none" });
  writeV1Run(tracesDir, "mcp0-zeta", {
    createdAt: at(10),
    llm: false,
    tool: false,
    // 只出现在 task 文本里的非 ASCII 关键词：query 必须按完整 task 匹配到它
    task: "含独特关键词锃亮的夹具",
  });

  // result 分叉子：继承父前缀（s_01..s_03 属于 mcp0-alpha），自有 span 从 s_21 起
  writeV1Run(tracesDir, "mcp0-child", {
    createdAt: at(5),
    parent: "mcp0-alpha",
    forkField: "result",
    forkAtSpan: alpha.toolSpanId,
    spanSeqStart: 20,
  });

  // prompt 分叉孤儿：父文件确实不存在 ⇒ ownOnly（result 分叉的缺父是严格失败，不是这条）
  writeV1Run(tracesDir, "mcp0-orphan", {
    createdAt: at(4),
    parent: "mcp0-gone",
    forkField: "system_prompt",
    forkAtSpan: "s_02",
    spanSeqStart: 40,
  });

  // 重名 span：子 run 自有 step 复用父 run 的 s_02 标识
  const ambParent = writeV1Run(tracesDir, "mcp0-amb-parent", {
    createdAt: at(3),
    llm: false,
  });
  writeV1Run(tracesDir, "mcp0-amb-child", {
    createdAt: at(2),
    parent: "mcp0-amb-parent",
    forkField: "system_prompt",
    forkAtSpan: ambParent.stepSpanId,
    spanSeqStart: 1,
  });

  // 同一 created_at 的一对：UTF-16 代码单元序里大写在前，区域排序会把小写排在前面
  writeMinimalRun(tracesDir, "mcp0-tie-B", at(1));
  writeMinimalRun(tracesDir, "mcp0-tie-a", at(1));

  // ---------------- 4.4：截断祖先与正文形态 ----------------
  writeV1Run(tracesDir, "mcp0-cut-parent", { createdAt: at(-1) });
  writeV1Run(tracesDir, "mcp0-cut-child", {
    createdAt: at(-2),
    parent: "mcp0-cut-parent",
    forkField: "result",
    // 分叉点落在父的 llm.call 上 ⇒ 父的工具 span s_03 被投影截断（Q10 的靶子）
    forkAtSpan: "s_02",
    spanSeqStart: 70,
  });
  writeV1Run(tracesDir, "mcp0-bodies", {
    createdAt: at(-3),
    // 错误定位只对「以 error 终止」的 run 有意义（共享层同款纪律：非 error 终止不产生错误目标）
    reason: "error",
    toolError: SENTINELS.toolErrorBody,
    toolResultNull: true,
    llmError: { message: SENTINELS.llmErrorBody, status: 503 },
  });
  writeV1Run(tracesDir, "mcp0-sparse", { createdAt: at(-4), omitResult: true });
  writeV1Run(tracesDir, "mcp0-emptyerr", { createdAt: at(-5), toolError: "" });
  writeV1Run(tracesDir, "mcp0-bigbody", { createdAt: at(-6), toolResult: LONG_BODY });

  // 超过默认页宽的批量（同一时刻，彼此按标识升序）
  for (let index = 0; index < 12; index += 1) {
    const suffix = String(index + 1).padStart(2, "0");
    writeMinimalRun(tracesDir, `mcp0-bulk-${suffix}`, at(0));
  }

  // ---------------- v2 隔离根 + v3 隔离 prompt 实验 ----------------
  const initialSnapshot = createWorkspaceSnapshot([
    { path: "a.txt", sha256: sha256("alpha 内容"), bytes: 12 },
    { path: "notes/b.txt", sha256: sha256("beta 内容"), bytes: 10 },
  ]);
  const finalSnapshot = createWorkspaceSnapshot([
    { path: "a.txt", sha256: sha256("alpha 内容"), bytes: 12 },
    { path: "config.json", sha256: sha256("改后的配置"), bytes: 21 },
  ]);
  const workspaceRootFirstLlm = writeWorkspaceRoot(tracesDir, initialSnapshot, finalSnapshot);
  writeExperimentChild(tracesDir, {
    initialSnapshot,
    finalSnapshot,
    baselineFirstLlmSpanId: workspaceRootFirstLlm,
    originalValue: SENTINELS.originalValue,
  });

  // ---------------- 失败文件 ----------------
  // 完全解析不了（第二行不是合法 span 行）
  writeFileSync(
    join(tracesDir, "mcp0-corrupt.jsonl"),
    `${metaLine("mcp0-corrupt", at(7), "损坏")}
{"type":"span","id":
`,
  );
  // 文件名与 meta.id 不一致：身份错配（旧 listRuns 仍允许，MCP 详细列表按失败项在场）
  writeFileSync(
    join(tracesDir, "mcp0-identity.jsonl"),
    `${metaLine("mcp0-other-id", at(8), "身份错配")}\n${STOP_LINE}\n`,
  );

  // 身份超出外部标识上限（200）：仍是个可解析的记录，但不能被客户端按 ID 回查
  const overLongId = `mcp0-long-${"x".repeat(200)}`;
  writeFileSync(
    join(tracesDir, `${overLongId}.jsonl`),
    `${metaLine(overLongId, at(9), "超长标识")}\n${STOP_LINE}\n`,
  );

  return {
    dataDir,
    tracesDir,
    initialSnapshotId: initialSnapshot.id,
    finalSnapshotId: finalSnapshot.id,
    workspaceRootFirstLlmSpanId: workspaceRootFirstLlm,
    ids: {
      alpha: "mcp0-alpha",
      beta: "mcp0-beta",
      gamma: "mcp0-gamma",
      delta: "mcp0-delta",
      epsilon: "mcp0-epsilon",
      zeta: "mcp0-zeta",
      child: "mcp0-child",
      orphan: "mcp0-orphan",
      ambiguousParent: "mcp0-amb-parent",
      ambiguousChild: "mcp0-amb-child",
      tieLower: "mcp0-tie-a",
      tieUpper: "mcp0-tie-B",
      cutParent: "mcp0-cut-parent",
      cutChild: "mcp0-cut-child",
      bodies: "mcp0-bodies",
      sparse: "mcp0-sparse",
      emptyError: "mcp0-emptyerr",
      bigBody: "mcp0-bigbody",
      workspaceRoot: "mcp0-ws-root",
      experiment: "mcp0-ws-experiment",
      corrupt: "mcp0-corrupt",
      identityFile: "mcp0-identity",
      identityRecordedId: "mcp0-other-id",
      overLongId,
      missing: "mcp0-never-written",
      bulkPrefix: "mcp0-bulk-",
      bulkCount: 12,
    },
  };
}

/** 写 v2 隔离根（import 世界 + 轮末检查点），返回首次 llm.call 的 span id */
function writeWorkspaceRoot(
  tracesDir: string,
  initialSnapshot: ReturnType<typeof createWorkspaceSnapshot>,
  finalSnapshot: ReturnType<typeof createWorkspaceSnapshot>,
): string {
  const id = "mcp0-ws-root";
  const tracer = new JsonlTracer(join(tracesDir, `${id}.jsonl`));
  tracer.startRun({
    id,
    format_version: 2,
    task: "MCP0 4.3 投影夹具：v2 隔离根",
    model: "controlled-model",
    created_at: at(70),
    parent: null,
    fork: null,
    config_hash: "sha256:controlled-config",
    workspace: {
      profile: "file-tools-v1",
      world_id: id,
      write_authorized: true,
      initial_snapshot: initialSnapshot,
      origin: { kind: "import" },
    },
  });
  const step = tracer.startSpan({ kind: "agent.step", n: 1 });
  const llm = tracer.startSpan({
    kind: "llm.call",
    parent: step,
    request: {
      model: "controlled-model",
      messages: [
        { role: "system", content: SENTINELS.messageBody },
        { role: "user", content: SENTINELS.originalValue },
      ],
    },
  });
  tracer.endSpan(llm, {
    response: {
      content: SENTINELS.responseContent,
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 120, out: 12 },
      ttft_ms: 2,
    },
  });
  const tool = tracer.startSpan({
    kind: "tool.invoke",
    parent: step,
    tool: "write_file",
    args: { path: "config.json", content: SENTINELS.toolArgs },
  });
  tracer.endSpan(tool, { result: SENTINELS.toolResult, dur_ms: 1, error: null });
  tracer.endSpan(step, { workspace_snapshot: finalSnapshot });
  tracer.endRun({ event: "stopped", reason: "completed", at: 1 });
  return llm;
}

/** 写 v3 隔离 prompt 实验：起点 = 父根的初始快照，只替换一条启动指令 */
function writeExperimentChild(
  tracesDir: string,
  input: {
    readonly initialSnapshot: ReturnType<typeof createWorkspaceSnapshot>;
    readonly finalSnapshot: ReturnType<typeof createWorkspaceSnapshot>;
    readonly baselineFirstLlmSpanId: string;
    readonly originalValue: string;
  },
): void {
  const id = "mcp0-ws-experiment";
  const parent = "mcp0-ws-root";
  const tracer = new JsonlTracer(join(tracesDir, `${id}.jsonl`), { spanSeqStart: 60 });
  tracer.startRun({
    id,
    format_version: 3,
    task: "MCP0 4.3 投影夹具：v3 隔离 prompt 实验",
    model: "controlled-model",
    created_at: at(80),
    parent,
    fork: {
      at_span: input.baselineFirstLlmSpanId,
      edit: { field: "user_message", value: SENTINELS.forkValue },
    },
    config_hash: "sha256:controlled-config",
    workspace: {
      profile: "file-tools-v1",
      world_id: id,
      write_authorized: true,
      initial_snapshot: input.initialSnapshot,
      origin: {
        kind: "initial",
        run_id: parent,
        snapshot_id: input.initialSnapshot.id,
      },
    },
    prompt_experiment: {
      baseline_run_id: parent,
      baseline_llm_span_id: input.baselineFirstLlmSpanId,
      initial_snapshot_id: input.initialSnapshot.id,
      original_value: input.originalValue,
      execution: {
        model: "controlled-model",
        params: {},
        provider_endpoint: "https://example.invalid/v1/chat/completions",
        max_iterations: 8,
        budget: 100_000,
        config_fingerprint: "fp-controlled-1",
      },
      hypothesis: SENTINELS.hypothesis,
      acceptance_criterion: SENTINELS.acceptanceCriterion,
    },
  });
  const step = tracer.startSpan({ kind: "agent.step", n: 1 });
  const llm = tracer.startSpan({
    kind: "llm.call",
    parent: step,
    request: {
      model: "controlled-model",
      messages: [
        { role: "system", content: SENTINELS.messageBody },
        { role: "user", content: SENTINELS.forkValue },
      ],
    },
  });
  tracer.endSpan(llm, {
    response: {
      content: SENTINELS.responseContent,
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 88, out: 6, cache_hit: 0 },
      ttft_ms: 2,
    },
  });
  tracer.endSpan(step, { workspace_snapshot: input.finalSnapshot });
  tracer.endRun({ event: "stopped", reason: "completed", at: 1 });
}
