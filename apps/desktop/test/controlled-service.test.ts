import {
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
import { OpenAiCompatClient, extractHttpStatus, runLoop } from "@rebaseagent/agent-loop";
import type { RunConfig, Tool } from "@rebaseagent/agent-loop";
import { JsonlTracer, readRun } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import {
  MockLlmClient,
  initialMessages,
  sampleConfig,
} from "../../../packages/agent-loop/test/helpers";
import { runModelAb } from "../src/main/fork-runner";
import { RunRepository } from "../src/main/run-repository";
import type { RunSettings } from "../src/main/settings";
import {
  applyTestSettings,
  settingsFileIn,
  snapshotFile,
  startMockLlm,
  summarize,
  withMockLlm,
} from "./helpers/mock-llm-harness";
import type { MockLlmHandle } from "./helpers/mock-llm-harness";

/**
 * U1（refactor-run-workspace）任务 6.0：6.4–6.6 的受控服务前置 + 协议探针。
 *
 * 判据来源：design D7 末段——「复用 `mock-llm-server.cjs --port/--script/--log`，逐入口核对
 * stream 模式，**非流式 JSON、HTTP 失败和延迟**若为用例所需则先补相应测试能力并做协议探针；
 * **不能将统一 SSE 响应当成全协议模拟**。每条流程重置剧本/服务、使用测试配置并恢复原配置，
 * 日志只存受控测试数据；**请求计数和预期调用顺序通过后再运行 6.4–6.6**。」
 *
 * 入口请求模式核对结论（本文件用真实客户端/编排逐条钉住）：
 *   | 入口 | stream | 端点 |
 *   |---|---|---|
 *   | 普通创建 / 隔离创建 / result fork / prompt fork / 隔离续跑 / 模型 A/B | `true`（SSE） | `POST {baseURL}/chat/completions` |
 *   | 模型 A/B **dry-run** | **零请求**（model-replay-run.ts 在联网前早退） |
 *   | **llm-proxy 转发** | **按请求体 `stream` 分流**（handler.ts:132；`false` 走 JSON 直通 :198） |
 * ⇒ 唯一会发 `stream:false` 的是代理通道，故"统一 SSE 冒充全协议"会让代理非流式路径**无能力可验**。
 *
 * ⚠️ 探针一律用**真实实现**驱动受控服务（`OpenAiCompatClient` / `runLoop` / `runModelAb`），
 *    不手搓 fetch —— 否则验的是探针自己的假设，而非产品与服务的契约。
 */

// ---------------------------------------------------------------------------
// 造数据 / 工具
// ---------------------------------------------------------------------------

const SETTINGS: RunSettings = {
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "sk-test",
  model: "deepseek-chat",
  encrypted: true,
};

/** 受控服务下发的 SSE 响应体（原始文本），用于协议层断言 */
async function rawPost(
  baseURL: string,
  body: Record<string, unknown>,
): Promise<{ status: number; contentType: string | null; text: string }> {
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    text: await res.text(),
  };
}

/** 把 SSE 原文里的 content 增量拼回完整正文（协议层验证分块与可重组） */
function joinSseContent(text: string): string {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> })
    .map((obj) => obj.choices?.[0]?.delta?.content ?? "")
    .join("");
}

/** 真实客户端指向受控服务（baseURL 由受控服务分配端口，其余同生产默认） */
function clientFor(handle: MockLlmHandle, over: Partial<RunConfig> = {}): OpenAiCompatClient {
  return new OpenAiCompatClient(
    sampleConfig({ baseURL: handle.baseURL, apiKey: "test-key", ...over }),
  );
}

async function tempDir(prefix: string): Promise<{ dir: string; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 纯工具（显式 sideEffect: false），模型 A/B 走真实 HTTP 时用 */
const PURE_TOOLS: Tool[] = [
  {
    name: "read_file",
    description: "读取指定路径的文件",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    sideEffect: false,
    handler: (args) => `内容(${(args as { path: string }).path})`,
  },
];

/** 用真实 runLoop + mock 客户端现造已封存父 run（零真实 API） */
async function createParent(traces: string): Promise<void> {
  const defs = PURE_TOOLS.map(({ handler: _h, ...def }) => def);
  const config = sampleConfig({ tools: defs });
  const tmp = join(traces, "tmp-parent.jsonl");
  await runLoop(
    config,
    initialMessages("读取 README.md"),
    new JsonlTracer(tmp),
    PURE_TOOLS,
    new MockLlmClient([{ content: "父 run 直接收尾。" }]),
  );
  const record = readRun(tmp);
  expect(record.status).toBe("completed");
  renameSync(tmp, join(traces, `${record.meta.id}.jsonl`));
}

// ---------------------------------------------------------------------------
// 1. 协议协商：不做"统一 SSE 冒充全协议"
// ---------------------------------------------------------------------------

describe("受控服务协议协商（design D7：不能把统一 SSE 当全协议）", () => {
  it("回合未指定 mode 且请求 stream=true ⇒ SSE；stream=false ⇒ **JSON**（协商而非固定）", async () => {
    // 两回合：两次请求各自消费一个（避免第二次落到 fallback 而误以为"内容丢了"）
    await withMockLlm({ turns: [{ content: "SSE 响应" }, { content: "协商响应" }] }, async (h) => {
      const sse = await rawPost(h.baseURL, { model: "m", stream: true, messages: [] });
      expect(sse.contentType).toContain("text/event-stream");
      expect(sse.text).toContain("data: [DONE]");
      // 正文按增量分块发送 ⇒ 在协议层拼回，验证"分块正确且可重组"
      expect(joinSseContent(sse.text)).toBe("SSE 响应");

      const json = await rawPost(h.baseURL, { model: "m", stream: false, messages: [] });
      expect(json.contentType).toContain("application/json");
      expect(json.text).not.toContain("data:");
      const parsed = JSON.parse(json.text) as {
        object: string;
        choices: Array<{ message: { content: string } }>;
      };
      expect(parsed.object).toBe("chat.completion");
      expect(parsed.choices[0]?.message.content).toBe("协商响应");

      // 日志如实记录协商结果（格式三要素之一）
      expect(summarize(h.entries()).map((e) => [e.stream, e.mode])).toEqual([
        [true, "sse"],
        [false, "json"],
      ]);
    });
  });

  it("回合显式 mode 覆盖协商（用它可以构造协议错配用例）", async () => {
    await withMockLlm({ turns: [{ mode: "json", content: "显式 JSON" }] }, async (h) => {
      // 请求要 SSE，服务按剧本回 JSON —— 错配是**被构造出来的**，不是默认行为
      const res = await rawPost(h.baseURL, { model: "m", stream: true, messages: [] });
      expect(res.contentType).toContain("application/json");
      expect(h.entries()[0]?.mode).toBe("json");
      expect(h.entries()[0]?.stream).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. 真实客户端 ↔ 受控服务（内置执行入口的协议）
// ---------------------------------------------------------------------------

describe("真实 OpenAiCompatClient ↔ 受控服务", () => {
  it("SSE 文本：增量拼成完整正文；usage 映射为 in/out", async () => {
    await withMockLlm(
      { turns: [{ content: "第一段第二段", usage: { in: 100, out: 7 } }] },
      async (h) => {
        const { response, requestBody } = await clientFor(h).complete(initialMessages("hi"), null);
        expect(response.content).toBe("第一段第二段");
        expect(response.usage.in).toBe(100);
        expect(response.usage.out).toBe(7);
        // 客户端硬编码的请求模式（逐入口核对的证据）
        expect(requestBody.stream).toBe(true);
        expect(requestBody.stream_options).toEqual({ include_usage: true });
        expect(h.entries()[0]?.path).toBe("/v1/chat/completions");
      },
    );
  });

  it("SSE 思维链：reasoning_content 进 reasoningContent，与正文互不混淆", async () => {
    await withMockLlm({ turns: [{ reasoning: "先想一下……", content: "答案" }] }, async (h) => {
      const { response } = await clientFor(h).complete(initialMessages("hi"), null);
      expect(response.reasoningContent).toBe("先想一下……");
      expect(response.content).toBe("答案");
    });
  });

  it("SSE 工具调用：id/name/arguments 完整聚合，finish_reason=tool_calls", async () => {
    await withMockLlm(
      {
        turns: [{ toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"a.txt"}' }] }],
      },
      async (h) => {
        const { response } = await clientFor(h).complete(initialMessages("hi"), null);
        // 协议形状是**嵌套**的（`ToolCallSchema`：id + type + function.{name,arguments}）
        expect(response.toolCalls).toEqual([
          {
            id: "c1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a.txt"}' },
          },
        ]);
        expect(response.content).toBeNull();
        // 声明的工具名进日志（回归据此比对"入口声明的工具组"）
        expect(h.entries()[0]?.tools).toEqual(["read_file", "write_file"]);
      },
    );
  });

  it("缓存维度：扁平 cache_hit/cache_miss 被解析；**0 是有值**（照常出现，不当未知）", async () => {
    await withMockLlm(
      {
        turns: [
          { content: "a", usage: { in: 1000, out: 5, cache_hit: 800, cache_miss: 200 } },
          { content: "b", usage: { in: 1000, out: 5, cache_hit: 0, cache_miss: 1000 } },
          { content: "c", usage: { in: 10, out: 1 } },
        ],
      },
      async (h) => {
        const client = clientFor(h);
        const first = await client.complete(initialMessages("1"), null);
        expect(first.response.usage.cache_hit).toBe(800);
        expect(first.response.usage.cache_miss).toBe(200);

        const second = await client.complete(initialMessages("2"), null);
        expect(second.response.usage.cache_hit).toBe(0); // 0 ≠ undefined
        expect(second.response.usage.cache_miss).toBe(1000);

        const third = await client.complete(initialMessages("3"), null);
        expect(third.response.usage.cache_hit).toBeUndefined();
        expect(third.response.usage.cache_miss).toBeUndefined();
      },
    );
  });

  it("HTTP 失败：抛 LlmRequestError 且状态码可被 extractHttpStatus 取回", async () => {
    await withMockLlm(
      { turns: [{ mode: "fail", status: 429, errorBody: { error: { message: "限流" } } }] },
      async (h) => {
        const err = await clientFor(h)
          .complete(initialMessages("hi"), null)
          .then(
            () => null,
            (e: unknown) => e,
          );
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).name).toBe("LlmRequestError");
        expect(extractHttpStatus(err)).toBe(429);
        expect((err as Error).message).toContain("429");
        expect((err as Error).message).toContain("限流");
      },
    );
  });

  it("协议错配：服务显式回 JSON 而客户端按 SSE 解析 ⇒ 明确报错，不静默假装成功", async () => {
    await withMockLlm({ turns: [{ mode: "json", content: "我不是 SSE" }] }, async (h) => {
      const err = await clientFor(h)
        .complete(initialMessages("hi"), null)
        .then(
          () => null,
          (e: unknown) => e,
        );
      // 关键：不能"解析出空正文但报 success"——那会把协议错配伪装成模型空回复
      expect(err).not.toBeNull();
      expect((err as Error).name).toBe("LlmRequestError");
    });
  });

  it("延迟：delayMs 生效，首 token 时延不小于延迟量（ttft 探针可用）", async () => {
    await withMockLlm({ turns: [{ content: "慢响应", delayMs: 120 }] }, async (h) => {
      const { response } = await clientFor(h).complete(initialMessages("hi"), null);
      expect(response.content).toBe("慢响应");
      expect(response.ttftMs).toBeGreaterThanOrEqual(120);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. 请求日志三要素：格式 / 次数 / 顺序
// ---------------------------------------------------------------------------

describe("请求日志：格式、次数与顺序可验证", () => {
  it("FIFO 顺序、逐条计数、stream 标志与消息角色如实入账", async () => {
    await withMockLlm(
      {
        turns: [
          { content: "1" },
          { toolCalls: [{ id: "c1", name: "read_file", args: "{}" }] },
          { content: "3" },
        ],
      },
      async (h) => {
        const client = clientFor(h);
        await client.complete(initialMessages("第一"), null);
        await client.complete(initialMessages("第二"), null);
        await client.complete(initialMessages("第三"), null);

        const entries = h.entries();
        expect(h.served()).toBe(3);
        expect(entries.map((e) => e.n)).toEqual([1, 2, 3]); // 顺序即消费顺序
        expect(entries.every((e) => e.stream && e.mode === "sse")).toBe(true);
        expect(entries.every((e) => e.model === "deepseek-chat")).toBe(true);
        expect(entries[1]?.turn).toEqual({ toolCalls: ["read_file"] });
        // 角色序列（system + user）逐条可读
        expect(entries[0]?.messages.map((m) => m.role)).toEqual(["system", "user"]);
      },
    );
  });

  it("重置端点把计数与日志清零（同一实例内的显式复位通道）", async () => {
    await withMockLlm({ turns: [{ content: "x" }], fallback: { content: "fb" } }, async (h) => {
      await clientFor(h).complete(initialMessages("1"), null);
      await clientFor(h).complete(initialMessages("2"), null);
      expect(h.served()).toBe(2);

      const res = await fetch(`${h.url}/__reset`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(h.served()).toBe(0);
      expect(h.entries()).toEqual([]);

      // 复位后重新从剧本第 0 回合开始
      const { response } = await clientFor(h).complete(initialMessages("3"), null);
      expect(response.content).toBe("x");
    });
  });

  it("logPath 落盘为 jsonl（GUI 冒烟 --log 的同一通道），每行一条且顺序一致", async () => {
    const { dir, cleanup } = await tempDir("controlled-log-");
    try {
      const logPath = join(dir, "logs", "requests.jsonl");
      const handle = await startMockLlm({
        script: { turns: [{ content: "1" }, { content: "2" }] },
        logPath,
      });
      try {
        const client = clientFor(handle);
        await client.complete(initialMessages("第一"), null);
        await client.complete(initialMessages("第二"), null);

        const lines = readFileSync(logPath, "utf8").trim().split("\n");
        expect(lines.length).toBe(2);
        const parsed = lines.map((l) => JSON.parse(l) as { n: number; model?: string });
        expect(parsed.map((e) => e.n)).toEqual([1, 2]);
        // 只落受控测试数据：模型名就是测试配置里的值，不含真实 provider 信息
        expect(parsed.every((e) => e.model === "deepseek-chat")).toBe(true);
      } finally {
        await handle.close();
      }
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. 真实编排端到端：dry-run 零请求 / 真实执行按臂数调用
// ---------------------------------------------------------------------------

describe("模型 A/B 经受控服务：dry-run 零请求、真实执行按臂计次", () => {
  function abRequest(parentId: string, arms: Array<{ model: string; paramsText: string }>) {
    return {
      parentRunId: parentId,
      arms: arms.map((arm) => ({ model: arm.model, paramsText: arm.paramsText })),
      dryRun: false,
    };
  }

  it("dry-run 不产生任何模型请求（受控服务计数为零）", async () => {
    const { dir, cleanup } = await tempDir("controlled-ab-dry-");
    try {
      const traces = join(dir, "traces");
      mkdirSync(traces);
      await createParent(traces);
      const parentId = readRun(join(traces, readdirSync(traces)[0] as string)).meta.id;

      await withMockLlm({ turns: [{ content: "不应被调用" }] }, async (h) => {
        const result = await runModelAb(
          {
            repository: new RunRepository(traces),
            settings: { ...SETTINGS, baseURL: h.baseURL },
            execCwd: dir,
          },
          {
            ...abRequest(parentId, [
              { model: "mock-arm-a", paramsText: "" },
              { model: "mock-arm-b", paramsText: "" },
            ]),
            dryRun: true,
          },
        );
        expect(result.ok).toBe(true);
        expect(result.plan.length).toBe(2);
        // 执行前提：dry-run 的"零请求"是**可验证事实**，不是文档承诺
        expect(h.served()).toBe(0);
      });
    } finally {
      cleanup();
    }
  });

  it("真实执行按臂数逐次调用受控服务，且请求顺序与臂顺序一致", async () => {
    const { dir, cleanup } = await tempDir("controlled-ab-live-");
    try {
      const traces = join(dir, "traces");
      mkdirSync(traces);
      await createParent(traces);
      const parentId = readRun(join(traces, readdirSync(traces)[0] as string)).meta.id;

      await withMockLlm(
        { turns: [{ content: "臂一收尾。" }, { content: "臂二收尾。" }] },
        async (h) => {
          const result = await runModelAb(
            {
              repository: new RunRepository(traces),
              settings: { ...SETTINGS, baseURL: h.baseURL },
              execCwd: dir,
            },
            abRequest(parentId, [
              { model: "mock-arm-a", paramsText: "" },
              { model: "mock-arm-b", paramsText: "" },
            ]),
          );
          expect(result.ok).toBe(true);
          expect(result.ids.length).toBe(2);

          const entries = h.entries();
          expect(entries.length).toBe(2); // 每臂恰好一次调用
          // 顺序 = 臂顺序（模型名逐条对上，证明不是并发乱序）
          expect(entries.map((e) => e.model)).toEqual(["mock-arm-a", "mock-arm-b"]);
        },
      );
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. harness：每流程隔离 + 配置恢复
// ---------------------------------------------------------------------------

describe("回归 harness：每流程换实例、配置逐字节恢复", () => {
  it("withMockLlm 每个流程拿到独立实例与独立计数（结构上不可能串响应）", async () => {
    const first = await withMockLlm({ turns: [{ content: "流程一" }] }, async (h) => {
      const { response } = await clientFor(h).complete(initialMessages("x"), null);
      return { content: response.content, served: h.served(), port: h.port };
    });
    const second = await withMockLlm({ turns: [{ content: "流程二" }] }, async (h) => {
      const { response } = await clientFor(h).complete(initialMessages("x"), null);
      return { content: response.content, served: h.served(), port: h.port };
    });

    expect(first.content).toBe("流程一");
    expect(second.content).toBe("流程二");
    // 计数从 0 起算（第二个流程没继承第一个的 1 次）
    expect(first.served).toBe(1);
    expect(second.served).toBe(1);
    // 新实例 = 新端口（"重置"由隔离提供，不依赖调用方记得 reset）
    expect(second.port).not.toBe(first.port);
  });

  it("withMockLlm 流程结束即关停（不留监听句柄，端口可被回收）", async () => {
    let captured: MockLlmHandle | null = null;
    await withMockLlm({ turns: [{ content: "x" }] }, async (h) => {
      captured = h;
      await clientFor(h).complete(initialMessages("x"), null);
    });
    // ⚠️ 只断言"端口不同"证明不了关停（新实例本来就换端口）⇒ 必须验**已被关停的句柄不可达**
    const handle = captured as MockLlmHandle | null;
    expect(handle).not.toBeNull();
    const err = await fetch(`${(handle as MockLlmHandle).url}/__log`).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
  });

  it("applyTestSettings 写入受控配置，restore 逐字节还原原文件", async () => {
    const { dir, cleanup } = await tempDir("controlled-settings-");
    try {
      const settingsPath = settingsFileIn(dir);
      const original =
        '{\n  "baseURL": "https://api.deepseek.com",\n  "model": "real",\n  "apiKey": "sk-real"\n}\n';
      writeFileSync(settingsPath, original, "utf8");

      const handle = await startMockLlm({ script: { turns: [{ content: "x" }] } });
      try {
        const restore = applyTestSettings(settingsPath, {
          baseURL: handle.baseURL,
          model: "mock-model",
          apiKey: "test-key",
        });
        const applied = JSON.parse(readFileSync(settingsPath, "utf8")) as { baseURL: string };
        expect(applied.baseURL).toBe(handle.baseURL);

        expect(restore()).toBe(true);
        expect(readFileSync(settingsPath, "utf8")).toBe(original); // 逐字节
      } finally {
        await handle.close();
      }
    } finally {
      cleanup();
    }
  });

  it("原文件不存在时 restore 删除该文件（不留下回归残留）", async () => {
    const { dir, cleanup } = await tempDir("controlled-settings-absent-");
    try {
      const settingsPath = settingsFileIn(dir);
      expect(snapshotFile(settingsPath).existed).toBe(false);

      const restore = applyTestSettings(settingsPath, {
        baseURL: "http://127.0.0.1:1/v1",
        model: "m",
        apiKey: "k",
      });
      expect(readFileSync(settingsPath, "utf8")).toContain("127.0.0.1");
      expect(restore()).toBe(true);
      // 回归后目录回到"从未写过设置"的状态
      expect(() => readFileSync(settingsPath, "utf8")).toThrow();
    } finally {
      cleanup();
    }
  });
});
