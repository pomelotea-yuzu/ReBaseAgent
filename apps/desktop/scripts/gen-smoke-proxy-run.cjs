/**
 * 代理录制冒烟数据生成器（零真实 API）：
 * 1. 起 stub upstream（固定 SSE 响应）
 * 2. 起 llm-proxy（127.0.0.1 随机端口，upstream 指向 stub）
 * 3. 模拟用户应用发两次请求（经代理）→ 生成 2 个代理 run
 * 4. 用第二个 run 的 messages 编辑后走代理分叉 → 生成 fork run
 * 5. 全部落在 <数据目录>/traces/，打开调试台即可演示：来源徽标/过滤、编辑 messages 重发入口、父链列表
 *
 * 用法：node scripts/gen-smoke-proxy-run.cjs [数据目录]（缺省 = 仓库 .rebaseagent/）
 */
const { mkdtempSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createServer } = require("node:http");

const dataDir = process.argv[2] ?? join(__dirname, "..", "..", "..", ".rebaseagent");
const tracesDir = join(dataDir, "traces");
mkdirSync(tracesDir, { recursive: true });

async function main() {
  const { startProxyServer, createProxyHandler } = await import("@rebaseagent/llm-proxy");

  // --- stub upstream：固定 SSE ---
  const sseChunks = [
    'data: {"choices":[{"delta":{"content":"已收到（stub upstream）"}}]}\n\n',
    'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":42,"completion_tokens":11}}\n\n',
    "data: [DONE]\n\n",
  ];
  const upstream = createServer((req, res) => {
    // 按 stream 标志分别返回：非流式回 JSON，流式回 SSE（与真实 provider 行为一致）
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const isStream = (() => {
        try {
          return JSON.parse(raw).stream === true;
        } catch {
          return false;
        }
      })();
      if (isStream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const chunk of sseChunks) res.write(chunk);
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "已收到（stub upstream）" } }],
            usage: { prompt_tokens: 42, completion_tokens: 11 },
          }),
        );
      }
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;

  // --- 代理（随机端口，避免与真实代理冲突）---
  const handler = createProxyHandler({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    proxyBaseUrl: "http://127.0.0.1:0/v1", // 端口回填在下方
    keyStore: {},
    recorder: {
      record(recording, fork) {
        // 落盘器与 main 相同形态：直接内联（脚本不 import Electron 侧代码）
        const { writeFileSync } = require("node:fs");
        const id = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        const now = new Date().toISOString();
        const lines = [
          JSON.stringify({
            type: "run.meta",
            id,
            format_version: 1,
            task: "(llm-proxy)",
            model: recording.meta.model,
            created_at: recording.started_at,
            parent: fork?.parent ?? null,
            fork:
              fork === undefined
                ? null
                : { at_span: fork.atSpan, edit: { field: "messages", value: fork.editValue } },
            source: recording.meta.source,
          }),
        ];
        if (recording.response !== null) {
          const timing = { started_at: recording.started_at, ended_at: now };
          lines.push(
            JSON.stringify({
              type: "span",
              id: "s_01",
              parent: null,
              kind: "agent.step",
              n: 1,
              timing,
            }),
          );
          lines.push(
            JSON.stringify({
              type: "span",
              id: "s_02",
              parent: "s_01",
              kind: "llm.call",
              timing,
              request: {
                model: recording.request.model,
                messages: recording.request.messages,
                ...(recording.request.tools !== undefined
                  ? { tools: recording.request.tools }
                  : {}),
                ...(recording.request.params !== undefined
                  ? { params: recording.request.params }
                  : {}),
              },
              response: recording.response,
            }),
          );
        }
        if (recording.outcome === "completed") {
          lines.push(JSON.stringify({ type: "run.event", event: "stopped", reason: "completed" }));
        } else if (recording.outcome === "error") {
          lines.push(JSON.stringify({ type: "run.event", event: "stopped", reason: "error" }));
        }
        writeFileSync(join(tracesDir, `${id}.jsonl`), `${lines.join("\n")}\n`, "utf8");
        console.log(`  ✓ run 落盘：${id}（${recording.outcome}${fork ? "，fork" : ""}）`);
      },
    },
  });

  const server = await startProxyServer({ port: 0, handler });
  const realProxyBase = `http://127.0.0.1:${server.port}`; // 用户应用的 base_url 以 /v1 结尾，客户端自动拼接 /chat/completions
  console.log(`stub upstream :${upstreamPort} · 代理 :${server.port} · 数据目录 ${tracesDir}`);

  // --- 两次"用户应用"请求 ---
  const send = async (messages, stream = false) => {
    const res = await fetch(`${realProxyBase}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-smoke" },
      body: JSON.stringify({ model: "deepseek-chat", messages, temperature: 0.7, stream }),
    });
    const text = await res.text();
    console.log(`  ← HTTP ${res.status}（${text.length} 字节）`);
    return text;
  };

  const fs = require("node:fs");
  const before = new Set(fs.readdirSync(tracesDir));

  const baseMessages = [
    { role: "system", content: "你是助手。" },
    { role: "user", content: "第一次请求（工具结果含脏数据，演示 JTBD ②）" },
  ];
  console.log("请求 1：录制");
  await send(baseMessages);
  await new Promise((r) => setTimeout(r, 100)); // 等 tee 聚合分支落盘
  const messages2 = [
    ...baseMessages,
    { role: "assistant", content: "已收到（stub upstream）" },
    { role: "user", content: "继续" },
  ];
  console.log("请求 2：录制");
  await send(messages2);
  await new Promise((r) => setTimeout(r, 100));

  // --- 分叉：编辑第二条 user 消息后经代理重发（fork run）---
  console.log("请求 3：分叉（编辑 messages 重发）");
  const newFiles = fs
    .readdirSync(tracesDir)
    .filter((f) => f.endsWith(".jsonl") && !before.has(f))
    .sort();
  if (newFiles.length < 2) throw new Error(`预期至少 2 个新 run，实际 ${newFiles.length}`);
  const srcFile = newFiles[1];
  const srcRecord = srcFile.replace(/\.jsonl$/, "");
  const srcLines = fs.readFileSync(join(tracesDir, srcFile), "utf8").trim().split("\n");
  const llm = JSON.parse(srcLines[2]);
  const edited = JSON.parse(JSON.stringify(llm.request.messages));
  edited[1].content = "（已编辑）工具结果修正后的消息";
  const forkBody = {
    model: llm.request.model,
    messages: edited,
    temperature: 0.7,
    stream: true,
    stream_options: { include_usage: true },
  };
  await fetch(`${realProxyBase}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-smoke" },
    body: JSON.stringify(forkBody),
  });
  await new Promise((r) => setTimeout(r, 100));
  // fork 元数据要在录制里体现——脚本直接改写最后落盘的 run（演示用；真实路径由 proxy:fork 通道完成）
  const forkFile = newFiles[newFiles.length - 1];
  const forkLines = fs.readFileSync(join(tracesDir, forkFile), "utf8").trim().split("\n");
  const meta = JSON.parse(forkLines[0]);
  meta.parent = srcRecord;
  meta.fork = { at_span: "s_02", edit: { field: "messages", value: edited } };
  forkLines[0] = JSON.stringify(meta);
  fs.writeFileSync(join(tracesDir, forkFile), `${forkLines.join("\n")}\n`, "utf8");

  await server.stop();
  upstream.close();
  console.log("完成：打开调试台即可查看代理 run（含一条分叉链）");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
