import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ProxyRecording } from "@rebaseagent/llm-proxy";
import { afterEach, describe, expect, it } from "vitest";
import { ProxyForkError, ProxyManager } from "../src/main/proxy-manager";
import { ProxyRunRecorder } from "../src/main/proxy-recorder";
import { readRunLineage } from "../src/main/run-lineage-read";
import { RunRepository } from "../src/main/run-repository";
import { type SettingsCipher, SettingsStore } from "../src/main/settings";

/**
 * 失败父本编辑重发的回归（tasks 3.6a / 3.6b）。
 *
 * 契约来源：llm-proxy delta「单请求级最小分叉（方案 a）」——
 *「已封存」按**已有终止记录的结构状态**判断，**不等同请求成功**。所以
 * `stopped/error` 的新代理 run 同样可作父本：保留完整自有 llm.call.request，
 * 允许改 messages、按当前监听/凭据版本核对后显式提交，沿用原 model/tools/params。
 *
 * 🔴 这条契约在 tasks 3.3 之前**无法兑现**：旧形态的失败 run 只落 meta + event，
 * 没有自有调用，于是「父本请求完整」这一必要条件根本不成立。3.3 写了失败
 * llm.call 之后，这条路径才真正可用——所以本文件同时是 3.3 的下游验收。
 *
 * 3.6b覆盖**副作用前拒绝**那一半：未修改（含仅换凭据）、历史无调用、
 * 未封存 / 来源或请求损坏。四类都必须固定请求计数（不调上游）、不新建子 run、
 * 保留完整草稿。
 */

const cipher: SettingsCipher = {
  isAvailable: () => true,
  encrypt: (plain) => `enc:${plain}`,
  decrypt: (encoded) => encoded.slice(4),
};

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const servers: Array<{ stop: () => Promise<void> }> = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    await s.stop();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const CHAT = "/v1/chat/completions";
const SECRET = "sk-live-9999999";

/** 一条失败父本录制（stopped/error + 完整自有请求 + 顶层 error） */
function failedRecording(overrides?: Partial<ProxyRecording>): ProxyRecording {
  return {
    meta: {
      task: "(llm-proxy)",
      model: "deepseek-chat",
      source: { kind: "proxy", base_url: "http://127.0.0.1:18787/v1" },
    },
    started_at: new Date().toISOString(),
    request: {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "脏内容" }],
      tools: undefined,
      params: { temperature: 0.7 },
    },
    response: {
      content: null,
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 0, out: 0 },
      ttft_ms: 0,
    },
    outcome: "error",
    error: { message: "Invalid API key", status: 401 },
    ...overrides,
  };
}

/** 起套真实监听的代理（上游由 fetchImpl 决定，零真实 API） */
async function setup(fetchImpl: () => Promise<Response>): Promise<{
  manager: ProxyManager;
  repository: RunRepository;
  tracesDir: string;
}> {
  const dataDir = tempDir("proxy-failparent-");
  const tracesDir = join(dataDir, "traces");
  mkdirSync(tracesDir, { recursive: true });
  const repository = new RunRepository(tracesDir);
  const settings = new SettingsStore({ dataDir, cipher });
  const manager = new ProxyManager({ repository, settings, tracesDir, fetchImpl });
  await manager.toggle({ enabled: true, port: 0, upstreamBaseUrl: "https://upstream.test" });
  return { manager, repository, tracesDir };
}

/** 提交这一刻的真实代理事实（tasks 2.2b：失配检查排在所有门禁之前） */
function factsOf(manager: ProxyManager) {
  const f = manager.status();
  return {
    expectedKeyCaptureRevision: f.keyCaptureRevision,
    expectedUpstreamBaseUrl: f.upstreamBaseUrl,
    expectedPort: f.port,
  };
}

/** 用某次请求的凭据经真实代理制造一次捕获（key 只在内存） */
async function captureCredential(manager: ProxyManager): Promise<void> {
  const port = manager.status().port;
  await fetch(`http://127.0.0.1:${port}${CHAT}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: "x" }] }),
  }).catch(() => undefined);
  // 等 recorder 交付完，避免与后续 fork 的写入交错
  await new Promise((r) => setTimeout(r, 30));
}

async function waitRuns(repository: RunRepository, expected: number): Promise<string[]> {
  for (let i = 0; i < 100; i += 1) {
    const runs = repository.listRuns().runs.map((r) => r.id);
    if (runs.length >= expected) return runs;
    await new Promise((r) => setTimeout(r, 10));
  }
  return repository.listRuns().runs.map((r) => r.id);
}

/** 写一条失败父本并返回其 id */
function seedFailedParent(tracesDir: string, overrides?: Partial<ProxyRecording>): string {
  return new ProxyRunRecorder(tracesDir).write(failedRecording(overrides));
}

// ---------------------------------------------------------------------------
// 3.6a：失败父本编辑重发（成功 / 再次失败 / 分叉链）
// ---------------------------------------------------------------------------

describe("3.6a 失败父本编辑重发", () => {
  it("失败父本（stopped/error）+ 编辑 messages ⇒ 发一次真实请求，产物 parent/fork 正确、父本字节不变", async () => {
    let calls = 0;
    const { manager, repository, tracesDir } = await setup(async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "重发成功" } }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const parentId = seedFailedParent(tracesDir);
    await captureCredential(manager);
    // 请求计数取基线：上面那次凭据捕获本身也过了上游，本用例只关心 fork 有没有再打
    const baseline = calls;
    const parentBefore = readFileSync(join(tracesDir, `${parentId}.jsonl`), "utf8");

    const edited = [{ role: "user", content: "改干净了" }];
    const child = await manager.fork({
      parentRunId: parentId,
      atSpanId: "s_02",
      messages: edited,
      ...factsOf(manager),
    });

    expect(calls - baseline).toBe(1); // 只发一次，不自动重试
    const childRecord = repository.loadRunRecord(child.id);
    // 成功子run：stopped/completed，且只含本次自有 span
    expect(childRecord.events).toEqual([
      { type: "run.event", event: "stopped", reason: "completed" },
    ]);
    expect(childRecord.meta.parent).toBe(parentId);
    expect(childRecord.meta.fork?.at_span).toBe("s_02");
    expect(childRecord.meta.fork?.edit).toEqual({ field: "messages", value: edited });
    const call = childRecord.spans.find((s) => s.kind === "llm.call");
    if (call?.kind !== "llm.call") throw new Error("子 run 无 llm.call");
    // 沿用原 model / params。
    // ⚠️ `stream_options` 是 `buildForkRequest` 自己注入的（重发恒走流式以测 TTFT），
    // 不是父本 params 的一部分；`stream`/`model`/`messages`/`tools` 是被排除的固定键。
    // 所以这里断言"原 params 全部保留"而不是逐字节相等。
    expect(call.request.model).toBe("deepseek-chat");
    expect(call.request.params).toMatchObject({ temperature: 0.7 });
    expect(call.request.messages).toEqual(edited);
    // 成功子run 不带 error
    expect(call.error).toBeUndefined();
    // 🔴 父本字节不变（不把父本状态改成成功）
    expect(readFileSync(join(tracesDir, `${parentId}.jsonl`), "utf8")).toBe(parentBefore);
    const parentRecord = repository.loadRunRecord(parentId);
    expect(parentRecord.events).toEqual([{ type: "run.event", event: "stopped", reason: "error" }]);
  });

  it("失败父本重发再次失败 ⇒ 新子run 保留本次 error 与 stopped/error、父本不变、无自动再次请求", async () => {
    let calls = 0;
    const { manager, repository, tracesDir } = await setup(async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "仍然无效" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });
    const parentId = seedFailedParent(tracesDir);
    await captureCredential(manager);
    // 请求计数取基线：上面那次凭据捕获本身也过了上游，本用例只关心 fork 有没有再打
    const baseline = calls;
    const parentBefore = readFileSync(join(tracesDir, `${parentId}.jsonl`), "utf8");

    const child = await manager.fork({
      parentRunId: parentId,
      atSpanId: "s_02",
      messages: [{ role: "user", content: "再改一次" }],
      ...factsOf(manager),
    });

    expect(calls - baseline).toBe(1);
    const childRecord = repository.loadRunRecord(child.id);
    // 本次结果如实记录：stopped/error + 自己的 error
    expect(childRecord.events).toEqual([{ type: "run.event", event: "stopped", reason: "error" }]);
    const call = childRecord.spans.find((s) => s.kind === "llm.call");
    if (call?.kind !== "llm.call") throw new Error("子 run 无 llm.call");
    expect(call.error?.status).toBe(401);
    expect(call.error?.message).toBe("仍然无效");
    expect(childRecord.meta.parent).toBe(parentId);
    // 父本字节不变
    expect(readFileSync(join(tracesDir, `${parentId}.jsonl`), "utf8")).toBe(parentBefore);
    // 「提交已产出记录」不等于「模型请求成功」：父本、凭据捕获那次、子 run 三条都在，
    // 子 run 带本次可信 ID 供结果核实，而它自己如实是 error
    const ids = await waitRuns(repository, 3);
    expect(ids.length).toBe(3);
    expect(ids).toContain(child.id);
  });

  it("分叉产物可再分叉（失败父本链）：r3 的产物 r3 指向 r2，父链可经 readRunLineage 展开", async () => {
    const { manager, repository, tracesDir } = await setup(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const r1 = seedFailedParent(tracesDir);
    await captureCredential(manager);

    const r2 = await manager.fork({
      parentRunId: r1,
      atSpanId: "s_02",
      messages: [{ role: "user", content: "第二版" }],
      ...factsOf(manager),
    });
    const r3 = await manager.fork({
      parentRunId: r2.id,
      atSpanId: "s_02",
      messages: [{ role: "user", content: "第三版" }],
      ...factsOf(manager),
    });

    expect(repository.loadRunRecord(r3.id).meta.parent).toBe(r2.id);
    expect(repository.loadRunRecord(r2.id).meta.parent).toBe(r1);
    // 父链可经既有 readRunLineage 展开（叶 → 根顺序收集）
    const lineage = readRunLineage(tracesDir, r3.id, (file) =>
      repository.loadRunRecord(basename(file, ".jsonl")),
    );
    expect(lineage.ok).toBe(true);
    if (!lineage.ok) return;
    expect(lineage.complete).toBe(true);
    // ⚠️ 顺序：本实现返回**根 → 叶**（与 `readRunLineage` 函数头注释里写的
    // 「叶 → 根」不符——那是注释滞后于实现）。本用例只关心链上三个都在，
    // 顺序另由 run-lineage-read 自己的用例钉，不在这里跟着注释跑。
    expect([...lineage.records].map((hop) => hop.meta.id).sort()).toEqual(
      [r1, r2.id, r3.id].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 3.6b：副作用前拒绝（固定请求计数 / 无新子 run / 保留草稿）
// ---------------------------------------------------------------------------

describe("3.6b 失败父本的门禁拒绝", () => {
  it("未修改 messages（哪怕凭据已换过）⇒ 空fork 防线拒绝，零上游调用、无子 run", async () => {
    let calls = 0;
    const { manager, repository, tracesDir } = await setup(async () => {
      calls += 1;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    const parentId = seedFailedParent(tracesDir);
    // 仅换凭据：捕获两次，让捕获版本推进（凭据字面量不同）——
    // delta「未修改拒绝重发」要证明的是"哪怕凭据已轮换也不放行"
    await captureCredential(manager);
    await captureCredential(manager);
    // 请求计数取基线：上面那次凭据捕获本身也过了上游，本用例只关心 fork 有没有再打
    const baseline = calls;
    const before = repository.listRuns().runs.length;

    const err = await manager
      .fork({
        parentRunId: parentId,
        atSpanId: "s_02",
        // 原样回传父本 messages =未修改
        messages: [{ role: "user", content: "脏内容" }],
        ...factsOf(manager),
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProxyForkError);
    expect((err as ProxyForkError).code).toBe("PROXY_EMPTY_FORK");
    expect(calls - baseline).toBe(0); // 副作用前拒绝：fork 没打上游
    expect(repository.listRuns().runs.length).toBe(before); // 无新子 run
  });

  it("历史无自有调用的失败文件（meta + stopped/error）⇒ 不可重发、不补造数据", async () => {
    const { manager, repository, tracesDir } = await setup(
      async () =>
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    // 旧形态：只落 meta + 终止事件，没有 llm.call span
    const legacyId = new ProxyRunRecorder(tracesDir).write({
      ...failedRecording(),
      response: null,
      outcome: "error",
    });
    const legacyRecord = repository.loadRunRecord(legacyId);
    expect(legacyRecord.spans).toHaveLength(0);
    await captureCredential(manager);
    const before = repository.listRuns().runs.length;

    const err = await manager
      .fork({
        parentRunId: legacyId,
        atSpanId: "s_02",
        messages: [{ role: "user", content: "改一版" }],
        ...factsOf(manager),
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProxyForkError);
    expect((err as ProxyForkError).code).toBe("PROXY_PARENT_INVALID");
    // 历史文件不被修改、不被补造 span
    expect(repository.loadRunRecord(legacyId).spans).toHaveLength(0);
    expect(repository.listRuns().runs.length).toBe(before);
  });

  it("未封存（crashed，缺终止记录）⇒ 拒绝、零上游调用", async () => {
    let calls = 0;
    const { manager, repository, tracesDir } = await setup(async () => {
      calls += 1;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    const crashedId = new ProxyRunRecorder(tracesDir).write({
      ...failedRecording(),
      outcome: "crashed", // 无终止事件 ⇒ status=crashed
    });
    expect(repository.loadRunRecord(crashedId).status).toBe("crashed");
    await captureCredential(manager);
    // 请求计数取基线：上面那次凭据捕获本身也过了上游，本用例只关心 fork 有没有再打
    const baseline = calls;
    const before = repository.listRuns().runs.length;

    const err = await manager
      .fork({
        parentRunId: crashedId,
        atSpanId: "s_02",
        messages: [{ role: "user", content: "改一版" }],
        ...factsOf(manager),
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProxyForkError);
    expect((err as ProxyForkError).code).toBe("PROXY_PARENT_INVALID");
    expect(calls - baseline).toBe(0);
    expect(repository.listRuns().runs.length).toBe(before);
  });

  it("来源不是 proxy ⇒ 拒绝（不把 SDK run 拉进代理重发路径）", async () => {
    const { manager, tracesDir } = await setup(
      async () =>
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    // SDK 录制的 run：**省略** `source` 字段（schema 是 `SourceSchema.optional()`，
    // 显式 `null` 会被 zod 拒成 invalid_union）。整份文件按真实读取器的形状
    // 构造，而不是"先正常写再删字段"——后者会让测试依赖 recorder 与读取器两处
    // 实现的差异，测到的可能不是想测的那一层。
    const lines = [
      JSON.stringify({
        type: "run.meta",
        id: "run_sdk_like",
        format_version: 1,
        task: "文件助手",
        model: "deepseek-chat",
        created_at: new Date().toISOString(),
        parent: null,
        fork: null,
        // 无 `source` ⇒ 非代理来源
      }),
      JSON.stringify({ type: "span", id: "s_01", parent: null, kind: "agent.step", n: 1 }),
      JSON.stringify({
        type: "span",
        id: "s_02",
        parent: "s_01",
        kind: "llm.call",
        request: { model: "deepseek-chat", messages: [{ role: "user", content: "原始" }] },
        response: {
          content: null,
          reasoning_content: null,
          tool_calls: [],
          usage: { in: 0, out: 0 },
          ttft_ms: 0,
        },
      }),
      JSON.stringify({ type: "run.event", event: "stopped", reason: "error" }),
    ];
    writeFileSync(join(tracesDir, "run_sdk_like.jsonl"), `${lines.join("\n")}\n`, "utf8");
    await captureCredential(manager);

    const err = await manager
      .fork({
        parentRunId: "run_sdk_like",
        atSpanId: "s_02",
        messages: [{ role: "user", content: "改一版" }],
        ...factsOf(manager),
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProxyForkError);
    expect((err as ProxyForkError).code).toBe("PROXY_PARENT_INVALID");
    expect((err as ProxyForkError).message).toContain("不是代理录制");
  });
});
