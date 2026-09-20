/* eslint-disable */
/**
 * 受控模型服务（开发/冒烟辅助脚本，不入产品代码路径）：OpenAI 兼容 + SSE 流式响应。
 *
 * 用途（B 任务 3.2）：让 GUI 冒烟能真实走完「隔离创建 → 改 result → 隔离续跑」，
 * 且**确定性、零成本**——把应用设置里的 baseURL 指到本服务即可，不需要任何真实 key。
 *
 * 用法：
 *   node scripts/mock-llm-server.cjs --port 18799 --script <剧本.json> --log <请求.jsonl>
 *
 * 剧本文件：
 *   {
 *     "turns": [
 *       { "toolCalls": [{ "id": "c1", "name": "read_file", "args": "{\"path\":\"a.txt\"}" }] },
 *       { "content": "父 run 完成。" }
 *     ],
 *     "fallback": { "content": "（剧本耗尽后的兜底响应）" }
 *   }
 * 剧本按请求顺序消费（FIFO）；耗尽后使用 fallback。
 *
 * 请求日志（jsonl，每行一条）：模型、是否流式、消息角色序列、声明的工具名——
 * 冒烟据此断言"确实发生了真实模型调用"与"隔离模式声明的是固定 file-tools-v1 工具组"。
 *
 * ⚠️ 只监听 127.0.0.1；不校验 apiKey（本地受控服务）。
 */
"use strict";

const { appendFileSync, mkdirSync, readFileSync } = require("node:fs");
const { createServer } = require("node:http");
const { dirname } = require("node:path");

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

const port = Number(arg("port", "18799"));
const scriptPath = arg("script", undefined);
const logPath = arg("log", undefined);

const script = scriptPath
  ? JSON.parse(readFileSync(scriptPath, "utf8"))
  : { turns: [{ content: "（默认响应）" }], fallback: { content: "（剧本耗尽）" } };

let served = 0;
const startedAt = new Date().toISOString();
console.log(`[mock-llm] 启动于 ${startedAt} port=${port} 剧本回合数=${script.turns?.length ?? 0}`);

function logRequest(entry) {
  if (logPath === undefined) return;
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function toolNames(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) =>
      t && typeof t.function === "object" && t.function !== null ? t.function.name : t?.name,
    )
    .filter((n) => typeof n === "string");
}

function writeTurn(res, turn, model, requestBody) {
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

  if (Array.isArray(turn.toolCalls) && turn.toolCalls.length > 0) {
    chunk({ role: "assistant", content: null });
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
    chunk({ role: "assistant", content: content.slice(0, half) });
    if (content.length > half) chunk({ content: content.slice(half) });
    chunk({}, "stop");
  }

  // 结束块：usage 随流返回（requests 里 stream_options.include_usage=true，与真实端点同形）
  const promptChars = JSON.stringify(requestBody.messages ?? []).length;
  res.write(
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [],
      usage: {
        prompt_tokens: Math.max(1, Math.floor(promptChars / 4)),
        completion_tokens: 8,
        total_tokens: Math.max(9, Math.floor(promptChars / 4) + 8),
      },
    })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, served, startedAt }));
    return;
  }
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
    const turn =
      served < (script.turns?.length ?? 0)
        ? script.turns[served]
        : (script.fallback ?? { content: "" });
    served += 1;
    logRequest({
      n: served,
      at: new Date().toISOString(),
      path: req.url,
      model: body.model,
      stream: body.stream === true,
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
    writeTurn(res, turn, body.model ?? "mock-model", body);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[mock-llm] listening on http://127.0.0.1:${port}/v1`);
});
