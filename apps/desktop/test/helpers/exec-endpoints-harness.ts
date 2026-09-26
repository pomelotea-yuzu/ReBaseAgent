import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop } from "@rebaseagent/agent-loop";
import type { LlmClient, Tool } from "@rebaseagent/agent-loop";
import { FILE_TOOLS_V1_DEFINITIONS } from "@rebaseagent/replay";
import { JsonlTracer, readRun } from "@rebaseagent/trace-sdk";
import {
  MockLlmClient,
  type ScriptedTurn,
  initialMessages,
  sampleConfig,
  sampleTools,
} from "../../../../packages/agent-loop/test/helpers";
import type { ExecEndpointDeps } from "../../src/main/exec-endpoints";
import type { TrustedSender } from "../../src/main/operation-endpoints";
import { OperationRegistry } from "../../src/main/operation-registry";
import { RequestFingerprinter } from "../../src/main/operation-request";
import { ProxyForkError } from "../../src/main/proxy-manager";
import { RunRepository } from "../../src/main/run-repository";
import { type RunSettings, SETTINGS_FILE_NAME } from "../../src/main/settings";
import { SourceTokenStore } from "../../src/main/source-token";
import type { OperationRecord } from "../../src/shared/operations";

/**
 * U4 任务 3.1–3.4 的执行入口测试夹具：一份**真实**的 registry + 指纹器 + 仓库 +
 * 令牌仓库 + settings 文件，只把三样东西换成可控件——
 * 1. LLM：`MockLlmClient`（脚本可换、`llmCalls()` 数的是**真实模型调用次数**）；
 * 2. 代理 `fork`：可换行为的桩（`PROXY_*` 拒绝与调用计数；真实代理链路归 2.9/2.10 与受控回归）；
 * 3. settings/proxy/sourceTokens 的读取与消费次数（判重必须先于一切副作用，只能数出来）。
 *
 * 父 run 一律用真实 `runLoop` 现造（仓库约定：不 mock 编排），因此 span 序号、
 * `config_hash`、落盘文件名都是真实事实，身份关联的断言才不是自证。
 */

export const EXEC_EPOCH = "11111111-1111-4111-8111-111111111111";
export const TRUSTED_SENDER: TrustedSender = { webContentsId: 1, frameRoutingId: 100 };
export const UNTRUSTED_SENDER: TrustedSender = { webContentsId: 2, frameRoutingId: 200 };

const TASK = "读取 README.md 并把要点写入 summary.md";
const CONFIG = sampleConfig();
const TOOLS: Tool[] = sampleTools();
/** completed 父 run 剧本：read_file → 收尾 */
const PARENT_SCRIPT: ScriptedTurn[] = [
  { toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"README.md"}' }] },
  { content: "任务完成：要点已写入 summary.md。" },
];
/** 一步答完（fork/重跑的通用剧本） */
export const ONE_TURN: ScriptedTurn[] = [{ content: "一步答完。" }];
/** file-tools-v1 工具表的**非隔离**父本剧本（读一次真实工作目录再收尾） */
const V1_PARENT_SCRIPT: ScriptedTurn[] = [
  { toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"README.md"}' }] },
  { content: "任务完成：已读取 README.md。" },
];
/** 全 pure 工具表：模型 A/B 默认工具策略只允许这种形状 */
const PURE_TOOLS: Tool[] = [
  {
    name: "read_file",
    description: "读取指定路径的文件",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    sideEffect: false,
    handler: (args) => `内容(${(args as { path: string }).path})`,
  },
];

const SETTINGS: RunSettings = {
  baseURL: "https://mock.invalid/v1",
  apiKey: "sk-exec-harness",
  model: "deepseek-chat",
  encrypted: false,
};

/** 合法 uuid 形态的操作 ID（registry/schema 只认这种形状） */
export function opId(n: number): string {
  const tail = String(n).padStart(12, "0");
  return `00000000-0000-4000-8000-${tail}`;
}

/** 一条主动请求的信封（main 侧唯一合法入参形状） */
export function envelope<TRequest>(n: number, request: TRequest, epoch = EXEC_EPOCH): unknown {
  return { operation: { epoch, operationId: opId(n) }, request };
}

export interface ExecHarness {
  readonly deps: ExecEndpointDeps;
  readonly registry: OperationRegistry;
  readonly epoch: string;
  readonly sender: TrustedSender;
  /** 仓库 traces 目录（数文件用） */
  readonly traces: string;
  readonly dataDir: string;
  readonly sourceDir: string;
  /** 换 LLM 剧本（每次换都重置调用计数） */
  setScript(turns: ScriptedTurn[]): void;
  /**
   * 在第一次模型调用前设一道门：用于「操作仍在 running 时的重复提交/跨入口忙碌」——
   * 门未开时副作用计数必须停在 0，判重与门禁才有反证可数。传 null 放行。
   */
  setGate(gate: Promise<void> | null): void;
  /**
   * 换掉执行期使用的 LLM 客户端（判「指纹与执行使用同一解析快照」时用它捕获实际入参）。
   * 计数仍走 `llmCalls()`：只要新客户端内部委托回 MockLlmClient 即可。
   */
  setLlm(client: LlmClient | null): void;
  /** 真实模型调用次数 */
  llmCalls(): number;
  /** 交给编排的 messages 快照（判「实际编排入参与解析快照一致」用） */
  llmRequests(): unknown[][];
  settingsLoads(): number;
  tokenConsumes(): number;
  proxyCalls(): number;
  /** 写运行配置（未调用 ⇒ settings.load() 返回 null，即"未配置"） */
  configure(): void;
  unconfigure(): void;
  /** 签发一次性目录令牌（隔离创建/续跑的入参） */
  issueSource(dir?: string): string;
  /** 换代理 fork 行为（缺省抛 PROXY_NO_KEY，与本会话未捕获 key 的真实处境一致） */
  setProxyFork(behavior: (request: unknown) => Promise<{ id: string }>): void;
  /** traces 目录里的 .jsonl 文件名（排序） */
  traceFiles(): string[];
  /** 现造 completed 父 run，返回 id 与其首个 tool.invoke span id */
  makeParent(): Promise<{ parentId: string; atSpanId: string }>;
  /**
   * 现造**非隔离**、但工具表恰为 `file-tools-v1` 的父 run：让 A 的隔离预检一路走到
   * "直接父必须是隔离 run"那一步（工具表不匹配时会更早以 profile_mismatch 拒绝，
   * 那样测不到父本门禁本身）。
   */
  makeV1Parent(): Promise<{ parentId: string; atSpanId: string }>;
  /** 现造模型 A/B 可用的父 run（纯工具表 + 带 params 的首次请求） */
  makePureParent(): Promise<string>;
  cleanup(): void;
}

export function openExecHarness(): ExecHarness {
  const root = mkdtempSync(join(tmpdir(), "exec-endpoints-"));
  const dataDir = join(root, "data");
  const traces = join(dataDir, "traces");
  const work = join(root, "work");
  const sourceDir = join(root, "source");
  for (const dir of [dataDir, traces, work, sourceDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(work, "README.md"), "# ReBaseAgent\n\n原始内容\n");
  writeFileSync(join(sourceDir, "a.txt"), "源文件 a\n");

  const settingsFile = join(dataDir, SETTINGS_FILE_NAME);
  const counts = { settings: 0, tokens: 0, proxy: 0 };
  /** 过一遍 LLM 就记一次：无论走默认剧本还是测试注入的客户端 */
  const observed: { calls: number; requests: unknown[][] } = { calls: 0, requests: [] };

  let scripted: MockLlmClient | null = null;
  let override: LlmClient | null = null;
  let gate: Promise<void> | null = null;
  const llm: LlmClient = {
    complete: async (messages, signal) => {
      if (gate !== null) await gate;
      observed.calls += 1;
      observed.requests.push(messages);
      if (override !== null) return override.complete(messages, signal);
      if (scripted === null) throw new Error("夹具未设置 LLM 剧本");
      return scripted.complete(messages, signal);
    },
  };
  const tokenStore = new SourceTokenStore();
  let proxyFork: (request: unknown) => Promise<{ id: string }> = async () => {
    throw new ProxyForkError("PROXY_NO_KEY", "本会话未捕获到 key");
  };

  const registry = new OperationRegistry({
    newEpoch: () => EXEC_EPOCH,
    now: () => Date.parse("2026-09-26T00:00:00.000Z"),
  });

  const deps: ExecEndpointDeps = {
    registry,
    fingerprinter: new RequestFingerprinter(Buffer.from("exec-harness-session-secret")),
    isTrustedSender: (sender) =>
      sender.webContentsId === TRUSTED_SENDER.webContentsId &&
      sender.frameRoutingId === TRUSTED_SENDER.frameRoutingId,
    repository: new RunRepository(traces),
    settings: {
      load: () => {
        counts.settings += 1;
        if (!existsSync(settingsFile)) return null;
        const stored = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, string>;
        return {
          baseURL: stored.baseURL as string,
          model: stored.model as string,
          apiKey: stored.apiKey as string,
          encrypted: stored.apiKeyEncrypted !== "false",
        };
      },
    },
    execCwd: work,
    dataDir,
    proxy: {
      fork: async (request) => {
        counts.proxy += 1;
        return proxyFork(request);
      },
    },
    sourceTokens: {
      consume: (token) => {
        counts.tokens += 1;
        return tokenStore.consume(token);
      },
    },
    // 测试替身：计数与入参快照都在这一层收口（MockLlmClient 的 requestBody 是 unknown，
    // 与 agent-loop 测试夹具同口径）
    llm: llm as unknown as LlmClient,
  };

  return {
    deps,
    registry,
    epoch: EXEC_EPOCH,
    sender: TRUSTED_SENDER,
    traces,
    dataDir,
    sourceDir,
    setScript: (turns) => {
      scripted = new MockLlmClient(turns);
      override = null;
      // 换剧本即清零计数：断言"这一步没多打一次模型"才不受上一步影响
      observed.calls = 0;
      observed.requests.length = 0;
    },
    setGate: (next) => {
      gate = next;
    },
    setLlm: (client) => {
      override = client;
      scripted = null;
    },
    llmCalls: () => observed.calls,
    llmRequests: () => observed.requests,
    settingsLoads: () => counts.settings,
    tokenConsumes: () => counts.tokens,
    proxyCalls: () => counts.proxy,
    configure: () =>
      writeFileSync(
        settingsFile,
        `${JSON.stringify(
          {
            baseURL: SETTINGS.baseURL,
            model: SETTINGS.model,
            apiKey: SETTINGS.apiKey,
            apiKeyEncrypted: false,
          },
          null,
          2,
        )}\n`,
      ),
    unconfigure: () => rmSync(settingsFile, { force: true }),
    issueSource: (dir = sourceDir) => tokenStore.issue(dir).token,
    setProxyFork: (behavior) => {
      proxyFork = behavior;
    },
    traceFiles: () =>
      readdirSync(traces)
        .filter((name) => name.endsWith(".jsonl"))
        .sort(),
    async makeParent() {
      const tmpFile = join(traces, "tmp-parent.jsonl");
      await runLoop(
        CONFIG,
        initialMessages(TASK),
        new JsonlTracer(tmpFile),
        TOOLS,
        new MockLlmClient(PARENT_SCRIPT),
      );
      const record = readRun(tmpFile);
      const toolSpan = record.spans.find((span) => span.kind === "tool.invoke");
      if (toolSpan?.kind !== "tool.invoke") throw new Error("unreachable：父剧本必有 tool.invoke");
      renameSync(tmpFile, join(traces, `${record.meta.id}.jsonl`));
      return { parentId: record.meta.id, atSpanId: toolSpan.id };
    },
    async makeV1Parent() {
      const defs = FILE_TOOLS_V1_DEFINITIONS.map((def) => ({ ...def }));
      const v1Tools: Tool[] = defs.map((def) => ({
        ...def,
        handler: (args: Record<string, unknown>) => {
          const rel = String(args.path ?? "");
          const file = join(work, rel);
          if (def.name === "read_file") return readFileSync(file, "utf8");
          mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
          writeFileSync(file, String(args.content ?? ""));
          return `已写入 ${rel}`;
        },
      }));
      const tmpFile = join(traces, "tmp-v1-parent.jsonl");
      await runLoop(
        { ...CONFIG, tools: defs },
        initialMessages(TASK),
        new JsonlTracer(tmpFile),
        v1Tools,
        new MockLlmClient(V1_PARENT_SCRIPT),
      );
      const record = readRun(tmpFile);
      const toolSpan = record.spans.find((span) => span.kind === "tool.invoke");
      if (toolSpan?.kind !== "tool.invoke") throw new Error("unreachable：v1 剧本必有 tool.invoke");
      renameSync(tmpFile, join(traces, `${record.meta.id}.jsonl`));
      return { parentId: record.meta.id, atSpanId: toolSpan.id };
    },
    async makePureParent() {
      const tmpFile = join(traces, "tmp-pure-parent.jsonl");
      await runLoop(
        { ...CONFIG, tools: PURE_TOOLS.map(({ handler: _h, ...def }) => def) },
        initialMessages(TASK),
        new JsonlTracer(tmpFile),
        PURE_TOOLS,
        new MockLlmClient([{ content: "父 run 完成。" }]),
      );
      const record = readRun(tmpFile);
      renameSync(tmpFile, join(traces, `${record.meta.id}.jsonl`));
      return record.meta.id;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 记录快照里的一条操作（找不到即失败，避免断言在 undefined 上"通过"） */
export function recordOf(harness: ExecHarness, operationId: string) {
  const record = harness.registry.recordOf(operationId);
  if (record === null) throw new Error(`登记里没有操作 ${operationId}`);
  return record;
}

/**
 * 等到某条操作进入指定状态（让出事件循环等真实编排推进，不靠 sleep 猜时长）。
 * 超时即失败——"running 期间"的断言必须建立在状态确实存在之上。
 */
export async function waitForState(
  registry: OperationRegistry,
  operationId: string,
  state: OperationRecord["state"],
  rounds = 2000,
): Promise<OperationRecord> {
  for (let i = 0; i < rounds; i += 1) {
    const record = registry.recordOf(operationId);
    if (record !== null && record.state === state) return record;
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  throw new Error(
    `等不到操作 ${operationId} 进入 ${state}：当前 ${JSON.stringify(
      registry.recordOf(operationId)?.state,
    )}`,
  );
}
