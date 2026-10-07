import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DIAGNOSTIC_MAX_LENGTH,
  GENERIC_LLM_FAILURE,
  limitDiagnosticText,
  redactDiagnosticText,
  sanitizeDiagnosticText,
} from "@rebaseagent/agent-loop";
import {
  GENERIC_PROXY_FAILURE,
  PROXY_DIAGNOSTIC_MAX_LENGTH,
  REDACTION_PLACEHOLDER as PROXY_PLACEHOLDER,
  TRUNCATION_MARKER as PROXY_TRUNCATION_MARKER,
  credentialLiteralsOf,
  extractUpstreamErrorMessage,
  limitProxyDiagnosticText,
  redactProxyDiagnosticText,
  sanitizeProxyDiagnosticText,
} from "@rebaseagent/llm-proxy";
import { afterEach, describe, expect, it } from "vitest";
import { ProxyManager } from "../src/main/proxy-manager";
import { RunRepository } from "../src/main/run-repository";
import { type SettingsCipher, SettingsStore } from "../src/main/settings";

/**
 * 失败诊断的端到端契约（tasks 3.1b + 3.5a）。
 *
 * 两个 change 之外的包级锁定 + 一条真实回环链路：
 *
 * 1. **3.1b：两包诊断上限等值**。llm-proxy 刻意不import agent-loop 的
 *    `DIAGNOSTIC_MAX_LENGTH`（那会引入 trace-sdk/zod 到最窄的转发路径），
 *    于是「两值相等」必须由**外部**断言成事实，而不是注释里的承诺。本文件
 *    同时导入两边，对上限与一组脱敏/限长边界输入比较输出行为。
 *    ⚠️ 这条测试**故意放在 desktop**：它是集成测试，加llm-proxy→agent-loop
 *    运行时依赖只为测试是错的（本就不该有那个依赖）。
 * 2. **3.5a：失败链路真跑**。真实 127.0.0.1 回环 + stub upstream fetch，
 *    覆盖 401 / 503 / 连接失败 / 凭据回显 / 空体/非 JSON / 截断，
 *    并核对**wire 字节未被脱敏改变**（脱敏只作用于诊断文本）。
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

/** 起一个真实的本地监听（取系统分配的端口），返回 base 与 stop */
async function listenUpstream(
  handler: (req: { body: string; authorization: string | undefined }) => {
    status: number;
    body: string;
    contentType?: string;
  },
): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const out = handler({
        body: Buffer.concat(chunks).toString("utf8"),
        authorization: req.headers.authorization,
      });
      res.writeHead(out.status, {
        "content-type": out.contentType ?? "application/json",
      });
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ stop: () => new Promise<void>((r) => server.close(() => r())) });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}`, stop: async () => undefined };
}

/** 起一套 ProxyManager（真实监听代理，零真实上游） */
async function setupManager(
  upstreamBaseUrl: string,
): Promise<{ manager: ProxyManager; tracesDir: string; repository: RunRepository }> {
  const dataDir = tempDir("proxy-diag-");
  const tracesDir = join(dataDir, "traces");
  mkdirSync(tracesDir, { recursive: true });
  const repository = new RunRepository(tracesDir);
  const settings = new SettingsStore({ dataDir, cipher });
  const manager = new ProxyManager({ repository, settings, tracesDir });
  // 上游用真实 fetch（打到上面那个本地监听），代理自身也走真实回环
  await manager.toggle({ enabled: true, port: 0, upstreamBaseUrl });
  return { manager, tracesDir, repository };
}

/** 经代理发一个 chat请求，返回客户端看到的状态与原始字节 */
async function callThroughProxy(
  manager: ProxyManager,
  body: Record<string, unknown>,
  authorization?: string,
): Promise<{ status: number; bytes: string }> {
  const port = manager.status().port;
  const res = await fetch(`http://127.0.0.1:${port}${CHAT}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization !== undefined ? { authorization } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, bytes: await res.text() };
}

const REQ = {
  model: "deepseek-chat",
  messages: [{ role: "user", content: "你好" }],
  stream: false,
};

/** 等落盘（recorder 是异步交付，轮询避免靠 sleep 猜时序） */
async function waitForRuns(repository: RunRepository, expected: number): Promise<string[]> {
  for (let i = 0; i < 100; i += 1) {
    // listRuns 返回 { runs, failed } —— 只取 runs，failed 是解析坏文件列表
    const runs = repository.listRuns().runs.map((r) => r.id);
    if (runs.length >= expected) return runs;
    await new Promise((r) => setTimeout(r, 10));
  }
  return repository.listRuns().runs.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// 3.1b：两包诊断口径等值（跨包锁定）
// ---------------------------------------------------------------------------

describe("跨包锁定：agent-loop 与 llm-proxy 的诊断口径等值", () => {
  it("上限都是 1024（含截断标记计入）", () => {
    expect(PROXY_DIAGNOSTIC_MAX_LENGTH).toBe(1024);
    expect(DIAGNOSTIC_MAX_LENGTH).toBe(PROXY_DIAGNOSTIC_MAX_LENGTH);
  });

  it("同组边界输入：脱敏后的输出逐字节相同", () => {
    const secrets = ["sk-live-9999999"];
    const inputs = [
      `Authorization: Bearer ${SECRET}`,
      `sent Bearer ${SECRET} upstream`,
      "connect https://user:pw@api.example.com/v1",
      `token with metachar ${SECRET} end`,
      "no secrets here at all",
    ];
    for (const text of inputs) {
      expect(redactProxyDiagnosticText(text, secrets)).toBe(redactDiagnosticText(text, secrets));
    }
  });

  it("同组边界输入：限长后的长度与截断标记相同", () => {
    const inputs = [
      "x".repeat(PROXY_DIAGNOSTIC_MAX_LENGTH),
      "x".repeat(PROXY_DIAGNOSTIC_MAX_LENGTH + 1),
      "x".repeat(PROXY_DIAGNOSTIC_MAX_LENGTH + 5000),
    ];
    for (const text of inputs) {
      const proxyOut = limitProxyDiagnosticText(text);
      const loopOut = limitDiagnosticText(text);
      expect(proxyOut.length).toBe(loopOut.length);
      expect(proxyOut).toBe(loopOut);
      // 组合入口也等值（脱敏幂等 + 限长幂等 ⇒ 两边对同一文本结果相同）
      expect(sanitizeProxyDiagnosticText(text, [])).toBe(sanitizeDiagnosticText(text, []));
    }
  });

  it("占位与截断标记字面量一致（两包不能各写一套文案）", () => {
    expect(PROXY_PLACEHOLDER).toBe("[已脱敏]");
    expect(PROXY_TRUNCATION_MARKER).toBe("…[已截断]");
  });

  it("🔴 llm-proxy 未引入 agent-loop 运行时依赖（加它只为测试是错的）", () => {
    // 读包清单判，而不是 import 探测：import 会被 bundler/tree-shaking 掩盖，
    // 而"为了测试引入依赖"正是这里要防的事。
    const pkgPath = join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "packages",
      "llm-proxy",
      "package.json",
    );
    const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const all = {
      ...parsed.dependencies,
      ...parsed.peerDependencies,
      ...parsed.optionalDependencies,
    };
    expect(Object.keys(all)).not.toContain("@rebaseagent/agent-loop");
  });
});

describe("诊断 helper 组合行为（包内导出的对外口径）", () => {
  it("兜底文案各自成文（不共用一个常量：语义不同、载体不同）", () => {
    expect(GENERIC_PROXY_FAILURE.length).toBeGreaterThan(0);
    expect(GENERIC_LLM_FAILURE.length).toBeGreaterThan(0);
    expect(GENERIC_PROXY_FAILURE).not.toBe(GENERIC_LLM_FAILURE);
  });

  it("credentialLiteralsOf + sanitize 组合：裸 token 回显也被脱敏", () => {
    const secrets = credentialLiteralsOf(`Bearer ${SECRET}`);
    const out = sanitizeProxyDiagnosticText(`invalid key ${SECRET} provided`, secrets);
    expect(out).not.toContain(SECRET);
    expect(out).toContain(PROXY_PLACEHOLDER);
  });

  it("非 JSON 正文给有限摘要而非全文（HTML 错误页也不整段进trace）", () => {
    const html = `<html><body>${"pad ".repeat(500)}</body></html>`;
    const out = extractUpstreamErrorMessage(html);
    expect(out).not.toBeNull();
    expect((out ?? "").length).toBeLessThanOrEqual(512);
  });
});

// ---------------------------------------------------------------------------
// 3.5a：失败链路真跑（真实回环 + 本地 stub 上游，零真实 API）
// ---------------------------------------------------------------------------

describe("失败录制：upstream 401（真实回环）", () => {
  it("落盘失败 llm.call（真实 status + 受控摘要 + 完整 request），wire 字节原样", async () => {
    const errBody = JSON.stringify({ error: { message: "Invalid API key", code: "invalid" } });
    const upstream = await listenUpstream(() => ({ status: 401, body: errBody }));
    const { manager, repository } = await setupManager(upstream.baseUrl);

    const seen = await callThroughProxy(manager, REQ, `Bearer ${SECRET}`);
    // 客户端拿到的仍是上游原字节（透明转发边界不被脱敏破坏）
    expect(seen.status).toBe(401);
    expect(seen.bytes).toBe(errBody);

    const [runId] = await waitForRuns(repository, 1);
    const record = repository.loadRunRecord(runId ?? "");
    expect(record.status).toBe("completed"); // 已封存 ≠ 请求成功
    const call = record.spans.find((s) => s.kind === "llm.call");
    if (call?.kind !== "llm.call") throw new Error("未落失败 llm.call");
    expect(call.error?.status).toBe(401);
    expect(call.error?.message).toBe("Invalid API key");
    expect(call.request.messages).toHaveLength(1);
    // 失败空占位：不是实测零
    expect(call.response.usage).toEqual({ in: 0, out: 0 });
    expect(call.response.content).toBeNull();
  });
});

describe("失败录制：upstream 503 + 凭据回显 + 截断", () => {
  it("凭据回显被脱敏（诊断与 run 文件里都没有它），摘要仍非空", async () => {
    // 上游把 key 原样回显（真实服务商错误文案的形态）
    const errBody = JSON.stringify({
      error: { message: `invalid api key: ${SECRET}` },
    });
    const upstream = await listenUpstream(() => ({ status: 503, body: errBody }));
    const { manager, repository } = await setupManager(upstream.baseUrl);

    const seen = await callThroughProxy(manager, REQ, `Bearer ${SECRET}`);
    // wire 侧不脱敏：客户端要看到服务商原话才能自己判断
    expect(seen.bytes).toContain(SECRET);

    const [runId] = await waitForRuns(repository, 1);
    const call = repository.loadRunRecord(runId ?? "").spans.find((s) => s.kind === "llm.call");
    if (call?.kind !== "llm.call") throw new Error("未落失败 llm.call");
    expect(call.error?.message).not.toContain(SECRET);
    expect(call.error?.message).toContain(PROXY_PLACEHOLDER);
    expect((call.error?.message ?? "").length).toBeGreaterThan(0);
    expect(call.error?.status).toBe(503);
  });

  it("超长诊断被限长到 1024（含标记），wire 侧仍原样完整", async () => {
    const huge = "E".repeat(5000);
    const errBody = JSON.stringify({ error: { message: huge } });
    const upstream = await listenUpstream(() => ({ status: 500, body: errBody }));
    const { manager, repository } = await setupManager(upstream.baseUrl);

    const seen = await callThroughProxy(manager, REQ);
    // 客户端拿到完整原文（限长只作用于 trace，不影响转发）
    expect(seen.bytes.length).toBe(errBody.length);

    const [runId] = await waitForRuns(repository, 1);
    const call = repository.loadRunRecord(runId ?? "").spans.find((s) => s.kind === "llm.call");
    if (call?.kind !== "llm.call") throw new Error("未落失败 llm.call");
    expect(call.error?.message.length).toBe(PROXY_DIAGNOSTIC_MAX_LENGTH);
    expect(call.error?.message.endsWith(PROXY_TRUNCATION_MARKER)).toBe(true);
  });
});

describe("失败录制：连接失败不伪造上游状态码", () => {
  it("fetch 抛异常 ⇒ error 无 status 字段，但客户端仍拿到明确 502", async () => {
    // ⚠️ 这里**不能**用"指向一个没人监听的真实端口"来制造连接失败：本机
    // HTTP_PROXY 穿透 localhost，fetch 到无人端口可能被代理接管并返回响应体
    // （实测拿到 200/400）。用注入的 fetch 抛异常来表达"连不上"，
    // 代理自身的监听仍是真实回环，只有上游那一跳是注入的。
    const dataDir = tempDir("proxy-dead-");
    const tracesDir = join(dataDir, "traces");
    mkdirSync(tracesDir, { recursive: true });
    const repository = new RunRepository(tracesDir);
    const settings = new SettingsStore({ dataDir, cipher });
    const manager = new ProxyManager({
      repository,
      settings,
      tracesDir,
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:1");
      },
    });
    await manager.toggle({ enabled: true, port: 0, upstreamBaseUrl: "http://127.0.0.1:1" });

    const seen = await callThroughProxy(manager, REQ);
    expect(seen.status).toBe(502);

    const [runId] = await waitForRuns(repository, 1);
    const call = repository.loadRunRecord(runId ?? "").spans.find((s) => s.kind === "llm.call");
    if (call?.kind !== "llm.call") throw new Error("未落失败 llm.call");
    // 🔴 契约核心：502 是代理本地生成的，不能记成上游状态码
    expect(call.error?.status).toBeUndefined();
    expect(call.error?.message).toContain("ECONNREFUSED");
    expect((call.error?.message ?? "").length).toBeGreaterThan(0);
    // 空占位仍在（失败请求也有自有调用，可编辑重发）
    expect(call.response.usage).toEqual({ in: 0, out: 0 });
  });
});

describe("失败录制：空体 / 非 JSON 错误体", () => {
  it("非 2xx 且空 body ⇒ 保留真实 status + 非空受控 fallback", async () => {
    const upstream = await listenUpstream(() => ({
      status: 502,
      body: "",
      contentType: "text/plain",
    }));
    const { manager, repository } = await setupManager(upstream.baseUrl);

    await callThroughProxy(manager, REQ);
    const [runId] = await waitForRuns(repository, 1);
    const call = repository.loadRunRecord(runId ?? "").spans.find((s) => s.kind === "llm.call");
    if (call?.kind !== "llm.call") throw new Error("未落失败 llm.call");
    expect(call.error?.status).toBe(502);
    // 空体 ⇒ 落兜底文案，不是空串、也不是完整响应体
    expect(call.error?.message).toBe(GENERIC_PROXY_FAILURE);
  });

  it("非 2xx 且 body 是 HTML（非 JSON）⇒ 给有限文本摘要，不写完整响应体", async () => {
    const html = `<html><head><title>502</title></head><body>${"pad ".repeat(400)}</body></html>`;
    const upstream = await listenUpstream(() => ({
      status: 502,
      body: html,
      contentType: "text/html",
    }));
    const { manager, repository } = await setupManager(upstream.baseUrl);

    await callThroughProxy(manager, REQ);
    const [runId] = await waitForRuns(repository, 1);
    const call = repository.loadRunRecord(runId ?? "").spans.find((s) => s.kind === "llm.call");
    if (call?.kind !== "llm.call") throw new Error("未落失败 llm.call");
    expect(call.error?.message).toContain("502");
    expect(call.error?.message.length).toBeLessThanOrEqual(PROXY_DIAGNOSTIC_MAX_LENGTH);
    expect(call.error?.message.length).toBeLessThan(html.length);
  });
});

describe("成功路径不受失败诊断改动影响", () => {
  it("200 成功：省略 error 字段，usage 是实测值", async () => {
    const ok = JSON.stringify({
      choices: [{ message: { role: "assistant", content: "回复" } }],
      usage: { prompt_tokens: 11, completion_tokens: 4 },
    });
    const upstream = await listenUpstream(() => ({ status: 200, body: ok }));
    const { manager, repository } = await setupManager(upstream.baseUrl);

    const seen = await callThroughProxy(manager, REQ, `Bearer ${SECRET}`);
    expect(seen.status).toBe(200);
    const [runId] = await waitForRuns(repository, 1);
    const call = repository.loadRunRecord(runId ?? "").spans.find((s) => s.kind === "llm.call");
    if (call?.kind !== "llm.call") throw new Error("未落llm.call");
    // 缺省 ≠ 成功：靠 error 字段是否存在判失败
    expect(call.error).toBeUndefined();
    expect(call.response.usage).toEqual({ in: 11, out: 4 });
  });
});
