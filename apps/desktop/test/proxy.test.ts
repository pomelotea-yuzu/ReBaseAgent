import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configHash } from "@rebaseagent/agent-loop";
import type { ProxyRecording } from "@rebaseagent/llm-proxy";
import { afterEach, describe, expect, it } from "vitest";
import { ProxyForkError, ProxyManager } from "../src/main/proxy-manager";
import { ProxyRunRecorder } from "../src/main/proxy-recorder";
import { RunRepository } from "../src/main/run-repository";
import { SettingsStore } from "../src/main/settings";
import type { SettingsCipher } from "../src/main/settings";

/**
 * 代理录制与分叉的单测：
 * - ProxyRunRecorder：三种 outcome 的 JSONL 形态（无 config_hash / source / fork meta）
 * - ProxyManager：端到端（真实 127.0.0.1 回环 + stub upstream fetch，零真实 API）
 *   ——录制 run、key 捕获、分叉重发、空 fork 与父本校验拒绝
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

/** 构造一条完整的非流式代理录制（handler 真实产物的形态） */
function fakeRecording(overrides?: Partial<ProxyRecording>): ProxyRecording {
  return {
    meta: {
      task: "(llm-proxy)",
      model: "deepseek-chat",
      source: { kind: "proxy", base_url: "http://127.0.0.1:18787/v1" },
    },
    started_at: new Date().toISOString(),
    request: {
      model: "deepseek-chat",
      messages: [
        { role: "system", content: "你是文件助手。" },
        { role: "user", content: "你好" },
      ],
      tools: undefined,
      params: { temperature: 0.7 },
    },
    response: {
      content: "你好！",
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 10, out: 5 },
      ttft_ms: 0,
    },
    outcome: "completed",
    ...overrides,
  };
}

describe("ProxyRunRecorder：三种 outcome 的 JSONL 形态", () => {
  it("completed：meta（含 config_hash、source）+ step + llm.call + 终止事件", () => {
    const dir = tempDir("proxy-rec-");
    const recorder = new ProxyRunRecorder(dir);
    const id = recorder.write(fakeRecording());
    const record = new RunRepository(dir).loadRunRecord(id);
    expect(record.status).toBe("completed");
    expect(record.meta.task).toBe("(llm-proxy)");
    expect(record.meta.config_hash).toBe(configHash("你是文件助手。", []));
    expect(record.meta.config_hash_reason).toBeUndefined();
    expect(record.meta.source).toEqual({ kind: "proxy", base_url: "http://127.0.0.1:18787/v1" });
    expect(record.meta.parent).toBeNull();
    expect(record.spans).toHaveLength(2);
    expect(record.spans[0]?.kind).toBe("agent.step");
    expect(record.spans[1]?.kind).toBe("llm.call");
    expect(record.events).toEqual([{ type: "run.event", event: "stopped", reason: "completed" }]);
  });

  it("error：只落 meta + 终止事件，不写任何 span", () => {
    const dir = tempDir("proxy-rec-");
    const recorder = new ProxyRunRecorder(dir);
    const id = recorder.write(fakeRecording({ response: null, outcome: "error" }));
    const record = new RunRepository(dir).loadRunRecord(id);
    expect(record.status).toBe("completed");
    expect(record.spans).toHaveLength(0);
    expect(record.events).toEqual([{ type: "run.event", event: "stopped", reason: "error" }]);
  });

  it("crashed：无终止事件（读取器识别为运行中断）", () => {
    const dir = tempDir("proxy-rec-");
    const recorder = new ProxyRunRecorder(dir);
    const id = recorder.write(fakeRecording({ outcome: "crashed" }));
    const record = new RunRepository(dir).loadRunRecord(id);
    expect(record.status).toBe("crashed");
    expect(record.spans).toHaveLength(2);
    expect(record.events).toHaveLength(0);
  });

  it("fork：parent/fork 元数据正确（edit.field=messages）", () => {
    const dir = tempDir("proxy-rec-");
    const recorder = new ProxyRunRecorder(dir);
    const edited = [{ role: "user", content: "编辑后" }];
    const id = recorder.write(fakeRecording(), {
      parent: "run_src",
      atSpan: "s_02",
      editValue: edited,
    });
    const record = new RunRepository(dir).loadRunRecord(id);
    expect(record.meta.parent).toBe("run_src");
    expect(record.meta.fork).toEqual({
      at_span: "s_02",
      edit: { field: "messages", value: edited },
    });
  });

  it("含工具表：config_hash 按解包后工具算（与 configHash 逐字节相等）", () => {
    const dir = tempDir("proxy-rec-");
    const recorder = new ProxyRunRecorder(dir);
    const tools = [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "读取文件",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ];
    const id = recorder.write(
      fakeRecording({
        request: {
          model: "deepseek-chat",
          messages: [
            { role: "system", content: "你是文件助手。" },
            { role: "user", content: "你好" },
          ],
          tools,
          params: undefined,
        },
      }),
    );
    const record = new RunRepository(dir).loadRunRecord(id);
    const expected = configHash("你是文件助手。", [
      {
        name: "read_file",
        description: "读取文件",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
    expect(record.meta.config_hash).toBe(expected);
    expect(record.meta.config_hash_reason).toBeUndefined();
  });

  it("无字符串 system 消息：不写 config_hash，写缺因 no_system", () => {
    const dir = tempDir("proxy-rec-");
    const recorder = new ProxyRunRecorder(dir);
    const id = recorder.write(
      fakeRecording({
        request: {
          model: "deepseek-chat",
          messages: [{ role: "user", content: "你好" }],
          tools: undefined,
          params: undefined,
        },
      }),
    );
    const record = new RunRepository(dir).loadRunRecord(id);
    expect(record.meta.config_hash).toBeUndefined();
    expect(record.meta.config_hash_reason).toBe("no_system");
  });

  it("工具表无法解析：不写 config_hash，写缺因 invalid_tool", () => {
    const dir = tempDir("proxy-rec-");
    const recorder = new ProxyRunRecorder(dir);
    const id = recorder.write(
      fakeRecording({
        request: {
          model: "deepseek-chat",
          messages: [
            { role: "system", content: "你是文件助手。" },
            { role: "user", content: "你好" },
          ],
          tools: [{ name: "broken" }], // 缺 description/parameters
          params: undefined,
        },
      }),
    );
    const record = new RunRepository(dir).loadRunRecord(id);
    expect(record.meta.config_hash).toBeUndefined();
    expect(record.meta.config_hash_reason).toBe("invalid_tool");
  });

  it("error outcome：请求快照可派生即写 hash（与是否有 llm.call span 无关）", () => {
    const dir = tempDir("proxy-rec-");
    const recorder = new ProxyRunRecorder(dir);
    const id = recorder.write(fakeRecording({ response: null, outcome: "error" }));
    const record = new RunRepository(dir).loadRunRecord(id);
    expect(record.meta.config_hash).toBe(configHash("你是文件助手。", []));
    expect(record.spans).toHaveLength(0);
  });
});

describe("ProxyManager：端到端（回环 + stub upstream）", () => {
  function setup() {
    const dataDir = tempDir("proxy-mgr-");
    const tracesDir = join(dataDir, "traces");
    mkdirSync(tracesDir, { recursive: true });
    const repository = new RunRepository(tracesDir);
    const settings = new SettingsStore({ dataDir, cipher });
    /** stub upstream：非流式固定响应 */
    const manager = new ProxyManager({
      repository,
      settings,
      tracesDir,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "stub 回复" } }],
            usage: { prompt_tokens: 7, completion_tokens: 3 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    return { repository, settings, manager };
  }

  /**
   * tasks 2.2b：提交这一刻的真实代理事实。失配检查排在所有其他门禁**之前**
   * （含 PROXY_NO_KEY / PROXY_PARENT_INVALID），所以每处 fork 调用都必须带上
   * 与当前状态一致的预期值，否则测到的会是版本失配而不是本用例想测的那一层。
   */
  const factsOf = (manager: ProxyManager) => {
    const f = manager.status();
    return {
      expectedKeyCaptureRevision: f.keyCaptureRevision,
      expectedUpstreamBaseUrl: f.upstreamBaseUrl,
      expectedPort: f.port,
    };
  };

  it("无 key 时分叉 → PROXY_NO_KEY", async () => {
    const { manager } = setup();
    await manager.toggle({ enabled: true, port: 0, upstreamBaseUrl: "https://upstream.test" });
    const err1 = await manager
      .fork({
        parentRunId: "run_x",
        atSpanId: "s_02",
        messages: [{ role: "user", content: "a" }],
        ...factsOf(manager),
      })
      .catch((e: unknown) => e);
    expect(err1).toBeInstanceOf(ProxyForkError);
    expect((err1 as ProxyForkError).code).toBe("PROXY_NO_KEY");
  });

  it("非代理父 run → PROXY_PARENT_INVALID", async () => {
    const { repository, manager } = setup();
    const state = await manager.toggle({
      enabled: true,
      port: 0,
      upstreamBaseUrl: "https://upstream.test",
    });
    // 先经代理跑一次捕获 key（前置条件），再验证父本校验
    await fetch(`http://127.0.0.1:${state.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-x" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(repository.listRuns().runs).toHaveLength(1);
    // 直接伪造一个 run id（文件不存在也会走父本校验失败路径）
    const err2 = await manager
      .fork({
        parentRunId: "run_missing",
        atSpanId: "s_02",
        messages: [{ role: "user", content: "a" }],
        ...factsOf(manager),
      })
      .catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(ProxyForkError);
    expect((err2 as ProxyForkError).code).toBe("PROXY_PARENT_INVALID");
  });

  it("全链路：经代理录制 → key 捕获 → 编辑 messages 分叉 → fork run 落盘", async () => {
    const { repository, manager } = setup();
    // 1. 启动代理（port 0 = 系统分配）
    const state = await manager.toggle({
      enabled: true,
      port: 0,
      upstreamBaseUrl: "https://upstream.test",
    });
    expect(state.running).toBe(true);
    expect(state.hasKey).toBe(false);

    // 2. 用户应用经代理发一次请求（真实回环 HTTP，upstream 为 stub）
    const res = await fetch(`http://127.0.0.1:${state.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-e2e" },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: "你是文件助手。" },
          { role: "user", content: "原始消息" },
        ],
        temperature: 0.7,
      }),
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(manager.status().hasKey).toBe(true);

    // 3. 录制结果：一 run（含 config_hash）、列表带 source 徽标数据
    const runs = repository.listRuns().runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.source).toBe("proxy");
    expect(runs[0]?.task).toBe("(llm-proxy)");
    const parent = repository.loadRunRecord(runs[0]!.id);
    expect(parent.meta.config_hash).toBe(configHash("你是文件助手。", []));
    expect(parent.spans.find((s) => s.kind === "llm.call")?.request.params).toEqual({
      temperature: 0.7,
    });

    // 4. 编辑 messages 分叉重发
    const edited = [{ role: "user", content: "编辑后的消息" }];
    const { id: forkId } = await manager.fork({
      parentRunId: parent.meta.id,
      atSpanId: "s_02",
      messages: edited,
      ...factsOf(manager),
    });
    const forkRun = repository.loadRunRecord(forkId);
    expect(forkRun.meta.parent).toBe(parent.meta.id);
    expect(forkRun.meta.fork?.edit.field).toBe("messages");
    const forkSpan = forkRun.spans.find((s) => s.kind === "llm.call");
    expect(
      forkSpan !== undefined && "messages" in forkSpan.request ? forkSpan.request.messages : [],
    ).toEqual(edited);

    // 5. 详情读取：proxy 分叉走父链列表（自身 span、无合并重复）
    const detail = repository.getRun(forkId);
    expect(detail.chain).toHaveLength(2);
    expect(detail.chain[0]?.meta.id).toBe(parent.meta.id);
    expect(detail.leafSpanIds).toEqual(["s_01", "s_02"]);

    // 6. 空 fork 拒绝
    const err3 = await manager
      .fork({
        parentRunId: parent.meta.id,
        atSpanId: "s_02",
        messages: parent.spans.find((s) => s.kind === "llm.call")?.request.messages ?? [],
        ...factsOf(manager),
      })
      .catch((e: unknown) => e);
    expect(err3).toBeInstanceOf(ProxyForkError);
    expect((err3 as ProxyForkError).code).toBe("PROXY_EMPTY_FORK");
  });
});
