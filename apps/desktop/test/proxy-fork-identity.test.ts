import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProxyRecording } from "@rebaseagent/llm-proxy";
import { afterEach, describe, expect, it } from "vitest";
import { ProxyForkError, ProxyManager } from "../src/main/proxy-manager";
import type { ProxyRecorderSink } from "../src/main/proxy-manager";
import { ProxyRunRecorder } from "../src/main/proxy-recorder";
import { RunRepository } from "../src/main/run-repository";
import { SettingsStore } from "../src/main/settings";
import type { SettingsCipher } from "../src/main/settings";

/**
 * U4 任务 2.10：主动重发与被动录制交错的回归（替换掉全局 `lastWrittenRunId` 之后）。
 *
 * 判据来源：tasks.md 2.10 + design D5；delta spec `desktop-ui`。
 * 验收场景（delta 逐字标题）：
 * - 「主动代理重发与被动录制交错」——主动重发等待返回期间被动录制**先后**写入时，
 *   主动操作只关联本次 fork 上下文的 id；写入失败明确记录失败、不二次录制、
 *   也不改变被动录制的结果；
 * - 「会话登记不泄漏输入和凭据」——失败文案里不出现 messages 正文与捕获到的 key。
 *
 * 交错用 recorder 注入面确定性制造（在本次 fork 的录制完成后，再让一条被动录制落在
 * 同一轮里落盘），并额外跑两笔**真正并发**的主动重发——每条都必须只对应自己那次请求
 * 的上下文。代理本身走真实 127.0.0.1 回环 + stub upstream，零真实 API。
 */

const cipher: SettingsCipher = {
  isAvailable: () => true,
  encrypt: (plain) => `enc:${plain}`,
  decrypt: (encoded) => encoded.slice(4),
};

const CAPTURED_KEY = "Bearer sk-e2e-supersecret";
const SYSTEM_PROMPT = "你是文件助手。";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "proxy-fork-identity-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function passiveRecording(content: string): ProxyRecording {
  return {
    meta: {
      task: "(llm-proxy)",
      model: "deepseek-chat",
      source: { kind: "proxy", base_url: "http://127.0.0.1:1/v1" },
    },
    started_at: new Date().toISOString(),
    request: {
      model: "deepseek-chat",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content },
      ],
      tools: undefined,
      params: { temperature: 0.7 },
    },
    response: {
      content: "被动回复",
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 3, out: 2 },
      ttft_ms: 0,
    },
    outcome: "completed",
  };
}

interface Behavior {
  /** 本次 fork 的录制写入抛错（模拟磁盘/权限失败） */
  failForkWrite: boolean;
  /** 被动录制的写入抛错 */
  failPassiveWrite: boolean;
  /** 写完本次 fork 后，立刻再走一遍被动分支（= 等待期间另一条请求也落盘） */
  interleavePassiveAfterFork: boolean;
  forkWriteCalls: number;
  forkIds: string[];
  passiveIds: string[];
}

function setup(): {
  manager: ProxyManager;
  repository: RunRepository;
  tracesDir: string;
  behavior: Behavior;
} {
  const dataDir = tempDir();
  const tracesDir = join(dataDir, "traces");
  mkdirSync(tracesDir, { recursive: true });
  const repository = new RunRepository(tracesDir);
  const settings = new SettingsStore({ dataDir, cipher });
  const real = new ProxyRunRecorder(tracesDir);
  const behavior: Behavior = {
    failForkWrite: false,
    failPassiveWrite: false,
    interleavePassiveAfterFork: false,
    forkWriteCalls: 0,
    forkIds: [],
    passiveIds: [],
  };
  const sink: ProxyRecorderSink = {
    write: (recording, fork) => {
      if (fork === undefined) {
        if (behavior.failPassiveWrite) throw new Error("被动录制写入失败：附件目录不可写");
        const id = real.write(recording);
        behavior.passiveIds.push(id);
        return id;
      }
      behavior.forkWriteCalls += 1;
      if (behavior.failForkWrite) throw new Error("主动录制写入失败：目标路径不可写");
      const id = real.write(recording, fork);
      behavior.forkIds.push(id);
      if (behavior.interleavePassiveAfterFork) {
        // 本次 fork 的录制完成后，再让一条被动录制落在同一轮里落盘：
        // 主动重发的身份必须与它无关（被动不入 activeForks，也就无从改写）
        queueMicrotask(() => {
          sink.write(passiveRecording("被动请求：别的数据"), undefined);
        });
      }
      return id;
    },
  };
  const manager = new ProxyManager({
    repository,
    settings,
    tracesDir,
    newRecorder: () => sink,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "stub 回复" } }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  return { manager, repository, tracesDir, behavior };
}

/** 启动代理并真跑一次请求：拿到 key + 一条可作父本的代理 run */
async function withParent(): Promise<{
  manager: ProxyManager;
  repository: RunRepository;
  tracesDir: string;
  behavior: Behavior;
  port: number;
  parentId: string;
  atSpanId: string;
  edited: Record<string, unknown>[];
}> {
  const context = setup();
  const state = await context.manager.toggle({
    enabled: true,
    port: 0,
    upstreamBaseUrl: "https://upstream.test",
  });
  const res = await fetch(`http://127.0.0.1:${state.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: CAPTURED_KEY },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: "原始消息" },
      ],
      temperature: 0.7,
    }),
  });
  expect(res.status).toBe(200);
  await res.text();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const runs = context.repository.listRuns().runs;
  if (runs.length !== 1 || runs[0] === undefined)
    throw new Error("unreachable：应先录出一条父 run");
  const parent = context.repository.loadRunRecord(runs[0].id);
  const llmSpan = parent.spans.find((span) => span.kind === "llm.call");
  // 捕获父本那一次也走被动分支：清零计数，交错断言只看 fork 阶段发生的事
  context.behavior.passiveIds.length = 0;
  context.behavior.forkWriteCalls = 0;
  context.behavior.forkIds.length = 0;
  return {
    ...context,
    port: state.port,
    parentId: runs[0].id,
    atSpanId: llmSpan?.id ?? "s_02",
    edited: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "编辑后的秘密消息正文" },
    ],
  };
}

function jsonlIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
}

describe("U4 2.10 主动重发的请求局部身份", () => {
  it("等待期间被动录制后到 ⇒ 仍只返回本次 fork 的 id（不借用被动 id）", async () => {
    const fixture = await withParent();
    const before = jsonlIn(fixture.tracesDir);
    fixture.behavior.interleavePassiveAfterFork = true;
    const forkPromise = fixture.manager.fork({
      parentRunId: fixture.parentId,
      atSpanId: fixture.atSpanId,
      messages: fixture.edited,
    });
    const { id } = await forkPromise;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fixture.behavior.forkWriteCalls).toBe(1);
    // 交错那条被动录制确实在同一窗口落盘了（否则本用例退化成"没有交错"）
    expect(fixture.behavior.passiveIds).toHaveLength(1);
    const passiveId = fixture.behavior.passiveIds[0] as string;
    // 本次重发的身份就是它的 fork 上下文写出来的那个 id
    expect(id).toBe(fixture.behavior.forkIds[0]);
    expect(id).not.toBe(passiveId);
    const forkRun = fixture.repository.loadRunRecord(id);
    expect(forkRun.meta.parent).toBe(fixture.parentId);
    expect(forkRun.meta.fork?.edit.field).toBe("messages");
    // 被动那条独立落盘、parent 为 null（被动录制结果未被改写）
    const passiveRun = fixture.repository.loadRunRecord(passiveId);
    expect(passiveRun.meta.parent).toBeNull();
    expect(jsonlIn(fixture.tracesDir)).toEqual(
      [...before, `${id}.jsonl`, `${passiveId}.jsonl`].sort(),
    );
  });

  it("两笔主动重发并发：各自只对应自己那次请求的上下文（身份与编辑内容互不串）", async () => {
    const fixture = await withParent();
    const editedA = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "A 支线的编辑内容" },
    ];
    const editedB = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "B 支线的编辑内容" },
    ];
    const [a, b] = await Promise.all([
      fixture.manager.fork({
        parentRunId: fixture.parentId,
        atSpanId: fixture.atSpanId,
        messages: editedA,
      }),
      fixture.manager.fork({
        parentRunId: fixture.parentId,
        atSpanId: fixture.atSpanId,
        messages: editedB,
      }),
    ]);
    expect(a.id).not.toBe(b.id);
    expect(fixture.behavior.forkWriteCalls).toBe(2);
    const recordA = fixture.repository.loadRunRecord(a.id);
    const recordB = fixture.repository.loadRunRecord(b.id);
    expect(recordA.meta.fork?.edit.value).toEqual(editedA);
    expect(recordB.meta.fork?.edit.value).toEqual(editedB);
    expect(recordA.meta.parent).toBe(fixture.parentId);
    expect(recordB.meta.parent).toBe(fixture.parentId);
  });

  it("主动录制写入失败 ⇒ 明确失败：不借用别的 id、不二次录制、被动结果不动", async () => {
    const fixture = await withParent();
    fixture.behavior.failForkWrite = true;
    const before = jsonlIn(fixture.tracesDir);
    const error = await fixture.manager
      .fork({
        parentRunId: fixture.parentId,
        atSpanId: fixture.atSpanId,
        messages: fixture.edited,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProxyForkError);
    const failure = error as ProxyForkError;
    expect(failure.code).toBe("PROXY_RECORDING_WRITE_FAILED");
    expect(failure.message).toContain("目标路径不可写");
    expect(fixture.behavior.forkWriteCalls).toBe(1);
    expect(fixture.behavior.forkIds).toEqual([]);
    // 客户端已拿到响应，但桌面不据此声称产出了记录
    expect(jsonlIn(fixture.tracesDir)).toEqual(before);
    expect(fixture.repository.listRuns().runs).toHaveLength(1);
  });

  it("被动录制写失败 ⇒ 主动重发照常成功，转发不被打断", async () => {
    const fixture = await withParent();
    fixture.behavior.failPassiveWrite = true;
    const res = await fetch(`http://127.0.0.1:${fixture.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: CAPTURED_KEY },
      body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    await res.text();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const { id } = await fixture.manager.fork({
      parentRunId: fixture.parentId,
      atSpanId: fixture.atSpanId,
      messages: fixture.edited,
    });
    expect(id).toBe(fixture.behavior.forkIds[0]);
    expect(fixture.repository.loadRunRecord(id).meta.parent).toBe(fixture.parentId);
    // 被动那条因写入失败而没有落盘——但那是它自己的事，不改主动结果也不冒新错误码
    expect(fixture.behavior.passiveIds).toEqual([]);
  });

  it("失败文案只带失败事实：不泄漏 messages 正文，也不回传捕获到的 key", async () => {
    const fixture = await withParent();
    fixture.behavior.failForkWrite = true;
    const failure = (await fixture.manager
      .fork({
        parentRunId: fixture.parentId,
        atSpanId: fixture.atSpanId,
        messages: fixture.edited,
      })
      .catch((e: unknown) => e)) as ProxyForkError;
    const serialized = JSON.stringify({ code: failure.code, message: failure.message });
    expect(serialized).not.toContain("编辑后的秘密消息正文");
    expect(serialized).not.toContain("sk-e2e-supersecret");
    expect(serialized).not.toContain(fixture.parentId);
    // 但身份类失败仍可定位：父 run 与分叉点由调用方自己持有（这里不重复回传）
    expect(fixture.repository.listRuns().runs.map((run) => run.id)).toContain(fixture.parentId);
  });
});
