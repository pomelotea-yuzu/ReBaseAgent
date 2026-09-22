/* eslint-disable */
/**
 * 受控模型服务（开发/冒烟/回归辅助，不入产品代码路径）：OpenAI 兼容。
 *
 * 用途：
 * - GUI 冒烟（B 任务 3.2）：让应用设置里的 baseURL 指到本服务，确定性、零成本走完
 *   「隔离创建 → 改 result → 隔离续跑」。
 * - 第 6 组主动执行回归（U1 任务 6.0）：作为 6.4–6.6 的受控前置，按请求格式/次数/顺序
 *   证明"旧创建设置及执行入口保持可达"。
 *
 * 两种用法：
 *   CLI：  node scripts/mock-llm-server.cjs --port 18799 --script <剧本.json> --log <请求.jsonl>
 *   内嵌： const { startMockLlmServer } = require("./mock-llm-server.cjs");
 *         const h = await startMockLlmServer({ script, logPath });   // port 省略 = 系统分配
 *         ...
 *         await h.close();
 *
 * ⚠️ **协议协商不是"统一 SSE 冒充全协议"**（design D7 明令）：
 *   应用内置执行入口（创建/fork/实验）硬编码 `stream: true`，走 SSE；但 **llm-proxy 通道
 *   按请求体 `stream` 分流**——外部 agent 发 `stream: false` 时必须收到真正的非流式 JSON。
 *   故本服务在回合未显式指定 `mode` 时**按请求协商**：`stream === true` ⇒ SSE，否则 ⇒ JSON。
 *
 * 剧本格式：
 *   {
 *     "turns": [ ...回合... ],
 *     "fallback": { ...回合... }        // 剧本耗尽后的兜底
 *   }
 * 回合字段（全部可选）：
 *   content      文本。SSE 下分两段增量；JSON 下为 message.content
 *   reasoning    思维链。SSE 下作为 reasoning_content 增量；JSON 下为 message.reasoning_content
 *   toolCalls    [{ id, name, args }]，非空则以 tool_calls 结束
 *   mode         "sse" | "json" | "fail"；缺省按请求协商（显式指定时不协商，用于构造协议错配用例）
 *   status       fail 的 HTTP 状态码（默认 429）
 *   errorBody    fail 的响应体（默认 { error: { message: "mock failure" } }）
 *   delayMs      响应前延迟（探针 ttft / 超时用例）
 *   usage        { in, out, cache_hit, cache_miss } —— 覆盖默认用量；cache_* 走 DeepSeek 扁平字段
 *                （`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`），与客户端解析同源
 *
 * 请求日志（jsonl 文件 / `GET /__log` 内存镜像，每行一条）：
 *   n、at、path、model、stream、mode、messages（角色与字符数）、tools（声明的工具名）、turn（本回合内容摘要）
 *
 * 控制端点（供测试复位，不属于 OpenAI 协议）：
 *   GET  /__log          → { served, entries }
 *   POST /__reset        → 计数与日志清零；body 可选 `{ "script": {...} }` 一并换剧本
 *   GET  /（或 /__health）→ { ok, served, startedAt, turns }
 *
 * ⚠️ 只监听 127.0.0.1；不校验 apiKey（本地受控服务）。
 */
"use strict";

const { appendFileSync, mkdirSync, readFileSync } = require("node:fs");
const { createServer } = require("node:http");
const { dirname } = require("node:path");

/** 默认剧本（无 --script 时） */
const DEFAULT_SCRIPT = {
  turns: [{ content: "（默认响应）" }],
  fallback: { content: "（剧本耗尽）" },
};

/** CLI 参数取值 */
function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

/** 读剧本文件；读取/解析失败直接抛（受控服务不该静默降级成"默认剧本"） */
function readScript(scriptPath) {
  if (scriptPath === undefined) return DEFAULT_SCRIPT;
  return JSON.parse(readFileSync(scriptPath, "utf8"));
}

/** 剧本回合数（日志/健康端点用） */
function turnCount(script) {
  return Array.isArray(script?.turns) ? script.turns.length : 0;
}

/** 从 tools 声明里取工具名（兼容 `{type,function:{name}}` 与 `{name}` 两种形态） */
function toolNames(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) =>
      t && typeof t.function === "object" && t.function !== null ? t.function.name : t?.name,
    )
    .filter((n) => typeof n === "string");
}

/**
 * 回合模式：显式 `mode` 优先；否则按请求协商。
 *
 * ⚠️ 这两句就是"不把统一 SSE 当全协议"的落点：`stream: false` 必须得到真 JSON。
 */
function resolveMode(turn, body) {
  if (turn.mode === "sse" || turn.mode === "json" || turn.mode === "fail") return turn.mode;
  return body.stream === true ? "sse" : "json";
}

/** 由回合的 usage 覆盖 + 请求体推出 OpenAI 形态的 usage 对象 */
function usageFor(turn, body) {
  const u = turn.usage ?? {};
  const promptChars = JSON.stringify(body.messages ?? []).length;
  const inTokens = Number.isInteger(u.in) ? u.in : Math.max(1, Math.floor(promptChars / 4));
  const outTokens = Number.isInteger(u.out) ? u.out : 8;
  const usage = {
    prompt_tokens: inTokens,
    completion_tokens: outTokens,
    total_tokens: inTokens + outTokens,
  };
  // DeepSeek 扁平缓存字段（与 llm-client 的 parseCacheUsage 同源；0 是有值，必须照发）
  if (Number.isInteger(u.cache_hit)) usage.prompt_cache_hit_tokens = u.cache_hit;
  if (Number.isInteger(u.cache_miss)) usage.prompt_cache_miss_tokens = u.cache_miss;
  return usage;
}

/**
 * 创建（但不监听）受控服务。测试用 `startMockLlmServer` 更方便。
 * @returns 句柄：`{ port, url, baseURL, ready, served(), entries(), reset(), close() }`
 */
function createMockLlmServer(options = {}) {
  const logPath = options.logPath;
  const requestedPort = Number.isInteger(options.port) ? options.port : 0;
  let script = options.script ?? DEFAULT_SCRIPT;
  let served = 0;
  let entries = [];
  const startedAt = new Date().toISOString();

  function logRequest(entry) {
    entries.push(entry);
    if (logPath === undefined) return;
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  }

  function turnFor(index) {
    const turns = Array.isArray(script.turns) ? script.turns : [];
    return index < turns.length ? turns[index] : (script.fallback ?? { content: "" });
  }

  /** mode = "fail"：HTTP 非 2xx + 响应体（代理非 2xx 直通 / 客户端错误路径都用它） */
  function respondFail(res, turn) {
    const status = Number.isInteger(turn.status) ? turn.status : 429;
    const payload = turn.errorBody ?? {
      error: { message: String(turn.content ?? "mock failure"), type: "mock_error" },
    };
    const text = JSON.stringify(payload);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(text),
    });
    res.end(text);
  }

  /** mode = "json"：标准 chat.completion（非流式）——llm-proxy 的 stream:false 分支的对照 */
  function respondJson(res, turn, model, body) {
    const message = { role: "assistant", content: String(turn.content ?? "") };
    if (typeof turn.reasoning === "string") message.reasoning_content = turn.reasoning;
    let finishReason = "stop";
    if (Array.isArray(turn.toolCalls) && turn.toolCalls.length > 0) {
      message.content = null;
      message.tool_calls = turn.toolCalls.map((call, index) => ({
        index,
        id: call.id ?? `call_${index + 1}`,
        type: "function",
        function: { name: call.name, arguments: call.args ?? "{}" },
      }));
      finishReason = "tool_calls";
    }
    const payload = {
      id: `chatcmpl-mock-${served}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: usageFor(turn, body),
    };
    const text = JSON.stringify(payload);
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(text),
    });
    res.end(text);
  }

  /** mode = "sse"：现有行为（文本/工具/思维链增量 + 结束块带 usage） */
  function respondSse(res, turn, model, body) {
    const id = `chatcmpl-mock-${served}`;
    const created = Math.floor(Date.now() / 1000);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const chunk = (delta, finish = null) => {
      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`,
      );
    };

    chunk({ role: "assistant", content: null });
    if (typeof turn.reasoning === "string" && turn.reasoning.length > 0) {
      chunk({ reasoning_content: turn.reasoning });
    }

    if (Array.isArray(turn.toolCalls) && turn.toolCalls.length > 0) {
      turn.toolCalls.forEach((call, index) => {
        chunk({
          tool_calls: [
            {
              index,
              id: call.id ?? `call_${index + 1}`,
              type: "function",
              function: { name: call.name, arguments: call.args ?? "{}" },
            },
          ],
        });
      });
      chunk({}, "tool_calls");
    } else {
      const content = String(turn.content ?? "");
      const half = Math.ceil(content.length / 2);
      chunk({ content: content.slice(0, half) });
      if (content.length > half) chunk({ content: content.slice(half) });
      chunk({}, "stop");
    }

    // 结束块：usage 随流返回（请求里 stream_options.include_usage=true，与真实端点同形）
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [],
        usage: usageFor(turn, body),
      })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
  }

  function reset(nextScript) {
    served = 0;
    entries = [];
    if (nextScript !== undefined) script = nextScript;
  }

  const server = createServer((req, res) => {
    // --- 控制端点（测试复位用，不属 OpenAI 协议） ---
    if (req.method === "GET" && req.url === "/__log") {
      const text = JSON.stringify({ served, entries });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(text);
      return;
    }
    if (req.method === "POST" && req.url === "/__reset") {
      let raw = "";
      req.on("data", (part) => {
        raw += part;
      });
      req.on("end", () => {
        let next;
        try {
          const parsed = raw.length > 0 ? JSON.parse(raw) : {};
          if (parsed && typeof parsed === "object" && parsed.script) next = parsed.script;
        } catch {
          /* 忽略坏 body：仍执行重置 */
        }
        reset(next);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, served }));
      });
      return;
    }
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, served, startedAt, turns: turnCount(script) }));
      return;
    }

    // --- 模型调用 ---
    let raw = "";
    req.on("data", (part) => {
      raw += part;
    });
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* 保底：按空对象处理 */
      }
      const turn = turnFor(served);
      const mode = resolveMode(turn, body);
      served += 1;
      logRequest({
        n: served,
        at: new Date().toISOString(),
        path: req.url,
        model: body.model,
        stream: body.stream === true,
        mode,
        messages: Array.isArray(body.messages)
          ? body.messages.map((m) => ({
              role: m.role,
              chars: typeof m.content === "string" ? m.content.length : null,
            }))
          : [],
        tools: toolNames(body.tools),
        turn: Array.isArray(turn.toolCalls)
          ? { toolCalls: turn.toolCalls.map((c) => c.name) }
          : { content: String(turn.content ?? "").slice(0, 40) },
      });

      const model = body.model ?? "mock-model";
      const delay = Number.isFinite(turn.delayMs) && turn.delayMs > 0 ? turn.delayMs : 0;
      const emit = () => {
        if (mode === "fail") return respondFail(res, turn);
        if (mode === "json") return respondJson(res, turn, model, body);
        return respondSse(res, turn, model, body);
      };
      if (delay > 0) setTimeout(emit, delay);
      else emit();
    });
  });

  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : requestedPort;
      resolve(port);
    });
  });

  return {
    /** 实际监听端口（port 传 0 时为系统分配值，ready 之后才有效） */
    get port() {
      const address = server.address();
      return typeof address === "object" && address !== null ? address.port : requestedPort;
    },
    get url() {
      return `http://127.0.0.1:${this.port}`;
    },
    /** 传给应用设置的 baseURL（客户端会自己拼 `/chat/completions`） */
    get baseURL() {
      return `http://127.0.0.1:${this.port}/v1`;
    },
    ready,
    served: () => served,
    entries: () => entries.slice(),
    reset,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** 创建并开始监听（测试常用入口；`ready` 已兑现） */
async function startMockLlmServer(options = {}) {
  const handle = createMockLlmServer(options);
  await handle.ready;
  return handle;
}

module.exports = {
  createMockLlmServer,
  startMockLlmServer,
  readScript,
  resolveMode,
  usageFor,
  toolNames,
  DEFAULT_SCRIPT,
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const port = Number(arg("port", "18799"));
  const scriptPath = arg("script", undefined);
  const logPath = arg("log", undefined);
  const script = readScript(scriptPath);
  console.log(
    `[mock-llm] 启动于 ${new Date().toISOString()} port=${port} 剧本回合数=${turnCount(script)}`,
  );
  startMockLlmServer({ port, script, logPath }).then((handle) => {
    console.log(`[mock-llm] listening on ${handle.url}/v1`);
  });
}
