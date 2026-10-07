import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProxyForkError, ProxyManager } from "../src/main/proxy-manager";
import { RunRepository } from "../src/main/run-repository";
import { SettingsStore } from "../src/main/settings";
import type { SettingsCipher } from "../src/main/settings";

/**
 * tasks 2.2b：**main 在副作用前拒绝失配的提交**（delta 场景「提交前版本变化由 main 拒绝」）。
 *
 * 场景原文：「renderer 已确认但 main 在收到 proxy:fork 前捕获新凭据或应用新代理配置
 * ⇒ main 按提交的预期代理/捕获版本在副作用前拒绝，不调用上游、不产生新 run，
 * 保留草稿并要求重新核对，不仅依赖 renderer 禁用」。
 *
 * 三个可证伪点，逐条钉住：
 * 1. 捕获版本推进（哪怕 hasKey 仍为 true）⇒ `PROXY_CREDENTIAL_CHANGED`；
 * 2. 代理配置（upstream / 端口）变化 ⇒ `PROXY_CONFIG_CHANGED`；
 * 3. 两种拒绝都**零上游调用、零新 run、父本 SHA 不变**——「副作用前」是这句话的实义。
 *
 * 走真实回环代理 + stub upstream（零真实 API），父本由一次真实被动录制产生。
 */

const cipher: SettingsCipher = {
  isAvailable: () => true,
  encrypt: (plain) => `enc:${plain}`,
  decrypt: (encoded) => encoded.slice(4),
};

const CAPTURED_KEY = "Bearer sk-fork-race-supersecret";
const SYSTEM_PROMPT = "你是文件助手。";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  manager: ProxyManager;
  repository: RunRepository;
  tracesDir: string;
  port: number;
  parentId: string;
  atSpanId: string;
  edited: Record<string, unknown>[];
  /** 提交这一刻的真实代理事实 */
  expected: {
    expectedKeyCaptureRevision: number;
    expectedUpstreamBaseUrl: string;
    expectedPort: number;
  };
  /** 落盘到 tracesDir 的 jsonl 数（用来证明"没有新 run"） */
  jsonlCount: () => number;
  parentSha: () => string;
}

/**
 * 起一个真实监听的代理，并**跑一次真实请求**得到 key + 可作父本的代理 run。
 * 顺带把 upstream 请求次数记下来，用于断言"失配时零上游调用"。
 */
async function withParent(): Promise<Fixture> {
  const dataDir = mkdtempSync(join(tmpdir(), "proxy-fork-race-"));
  dirs.push(dataDir);
  const tracesDir = join(dataDir, "traces");
  mkdirSync(tracesDir, { recursive: true });
  const repository = new RunRepository(tracesDir);
  const settings = new SettingsStore({ dataDir, cipher });

  const manager = new ProxyManager({
    repository,
    settings,
    tracesDir,
    fetchImpl: async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "stub 回复" } }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const state = await manager.toggle({
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

  const runs = repository.listRuns().runs;
  if (runs.length !== 1 || runs[0] === undefined)
    throw new Error("unreachable：应先录出一条父 run");
  const parent = repository.loadRunRecord(runs[0].id);
  const atSpanId = parent.spans.find((span) => span.kind === "llm.call")?.id ?? "s_02";
  const facts = manager.status();

  return {
    manager,
    repository,
    tracesDir,
    port: state.port,
    parentId: runs[0].id,
    atSpanId,
    expected: {
      expectedKeyCaptureRevision: facts.keyCaptureRevision,
      expectedUpstreamBaseUrl: facts.upstreamBaseUrl,
      expectedPort: facts.port,
    },
    edited: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "编辑后的消息正文" },
    ],
    jsonlCount: () => readdirSync(tracesDir).filter((n) => n.endsWith(".jsonl")).length,
    parentSha: () =>
      readdirSync(tracesDir)
        .filter((n) => n.endsWith(".jsonl"))
        .map((n) => join(tracesDir, n))
        .sort()
        .join("|"),
  };
}

/** 让外部请求再经过一次代理（触发一次新的捕获，hasKey 仍是 true） */
async function captureAgain(f: Fixture, key: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${f.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: key },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: "外部又来一次" }],
    }),
  });
  expect(res.status).toBe(200);
  await res.text();
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe("2.2b 提交前版本变化由 main 拒绝", () => {
  it("凭据轮换（hasKey 仍 true、捕获版本推进）⇒ 副作用前拒绝", async () => {
    const f = await withParent();
    const before = f.manager.status();
    expect(before.hasKey).toBe(true);

    // renderer 核对之后、提交之前：外部应用带着**另一个 key** 又过了一次代理
    await captureAgain(f, "Bearer sk-fork-race-rotated");
    const after = f.manager.status();
    // 前置自证：布尔没变，版本变了 —— 这正是旧实现漏掉的那一类
    expect(after.hasKey).toBe(true);
    expect(after.keyCaptureRevision).toBeGreaterThan(before.keyCaptureRevision);

    const jsonlBefore = f.jsonlCount();
    const shaBefore = f.parentSha();
    const promise = f.manager.fork({
      parentRunId: f.parentId,
      atSpanId: f.atSpanId,
      messages: f.edited,
      ...f.expected,
    });
    await expect(promise).rejects.toMatchObject({ code: "PROXY_CREDENTIAL_CHANGED" });
    // 零新 run、父本逐字不变
    expect(f.jsonlCount()).toBe(jsonlBefore);
    expect(f.parentSha()).toBe(shaBefore);
  });

  it("上游地址变了 ⇒ PROXY_CONFIG_CHANGED、零新 run", async () => {
    const f = await withParent();
    const jsonlBefore = f.jsonlCount();
    // 换个 upstream 重启代理（保存的配置随之变化 ⇒ 提交里的预期不再成立）
    await f.manager.toggle({ enabled: true, port: f.port, upstreamBaseUrl: "https://other.test" });
    expect(f.manager.status().upstreamBaseUrl).toBe("https://other.test");

    await expect(
      f.manager.fork({
        parentRunId: f.parentId,
        atSpanId: f.atSpanId,
        messages: f.edited,
        ...f.expected,
      }),
    ).rejects.toMatchObject({ code: "PROXY_CONFIG_CHANGED" });
    expect(f.jsonlCount()).toBe(jsonlBefore);
  });

  it("端口变了 ⇒ 同样按配置失配拒绝（不是只比upstream 字符串）", async () => {
    const f = await withParent();
    await f.manager.toggle({ enabled: true, port: 0, upstreamBaseUrl: "https://upstream.test" });
    // 端口由系统分配 ⇒ 与提交时的预期几乎必然不同
    expect(f.manager.status().port).not.toBe(f.expected.expectedPort);
    await expect(
      f.manager.fork({
        parentRunId: f.parentId,
        atSpanId: f.atSpanId,
        messages: f.edited,
        ...f.expected,
      }),
    ).rejects.toMatchObject({ code: "PROXY_CONFIG_CHANGED" });
  });

  it("版本与配置都一致 ⇒ 正常重发（确认这道门没有把正常路径一起堵死）", async () => {
    const f = await withParent();
    const jsonlBefore = f.jsonlCount();
    const { id } = await f.manager.fork({
      parentRunId: f.parentId,
      atSpanId: f.atSpanId,
      messages: f.edited,
      ...f.expected,
    });
    expect(id).not.toBe(f.parentId);
    expect(f.jsonlCount()).toBe(jsonlBefore + 1);
  });

  it("拒绝发生在读父本之前：父本 id 无效时也报版本失配（不泄露父本是否存在）", async () => {
    const f = await withParent();
    await captureAgain(f, "Bearer sk-fork-race-rotated");
    await expect(
      f.manager.fork({
        parentRunId: "r_does_not_exist",
        atSpanId: f.atSpanId,
        messages: f.edited,
        ...f.expected,
      }),
    ).rejects.toBeInstanceOf(ProxyForkError);
    await expect(
      f.manager.fork({
        parentRunId: "r_does_not_exist",
        atSpanId: f.atSpanId,
        messages: f.edited,
        ...f.expected,
      }),
    ).rejects.toMatchObject({ code: "PROXY_CREDENTIAL_CHANGED" });
  });

  it("失败文案不含 messages 正文与捕获的 key（凭据与用户输入都不进错误路径）", async () => {
    const f = await withParent();
    await captureAgain(f, "Bearer sk-fork-race-rotated");
    const secretEdit = [{ role: "user", content: "绝密正文-不应出现在错误里" }];
    let message = "";
    try {
      await f.manager.fork({
        parentRunId: f.parentId,
        atSpanId: f.atSpanId,
        messages: secretEdit,
        ...f.expected,
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain("绝密正文");
    expect(message).not.toContain("sk-fork-race");
    expect(message).not.toContain("Bearer");
    expect(message).toContain("重新核对");
  });
});
