import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProxyManager } from "../src/main/proxy-manager";
import { RunRepository } from "../src/main/run-repository";
import { SettingsStore } from "../src/main/settings";
import type { SettingsCipher } from "../src/main/settings";

/**
 * tasks 2.3a：**保存的监听意图在启动时恢复，且失败可诊断**。
 *
 * 判据来源：llm-proxy delta「保存的监听意图在启动时恢复且失败可诊断」三个场景：
 * - 「保存启用后重启恢复监听」→ 真实监听既有地址、running=true、hasKey=false；
 * - 「重启恢复失败可见且可重试」→ 保留 enabled=true 与受控原因，**回读不再启动**，
 *   端口释放后**显式应用配置**可重试；
 * - 「保存停用不启动代理」→ 不尝试监听、无上游请求。
 *
 * 端口占用用真实 `node:http` 占位（不注入假 server）——「端口被别的进程占着」就是
 * 真实用户会遇到的情形，注入桩等于把要验的东西验掉了。
 *
 * ⚠️ 两条本机硬事实（实测，别再改回去）：
 * 1. `saveProxy({ port: 0 })` 存进 settings 后，`loadProxy()` 会把非法端口**归一成
 *    默认 18787**（settings.ts:152 要求 1..65535）。所以这里不能用 `port: 0`
 *    表达"随便给我一个端口"——那样每条用例都在抢同一个固定端口。统一走
 *    `freePort()` 借一个系统分配的端口再放掉。
 * 2. 本机 `HTTP_PROXY=http://127.0.0.1:9088` 会**穿透 localhost**，`fetch` 到
 *    无人监听的端口也可能被代理接管并返回响应体。判"端口到底有没有人监听"
 *    必须用 `node:net` 直连（看 ECONNREFUSED），不能用 `fetch`。
 */

const cipher: SettingsCipher = {
  isAvailable: () => true,
  encrypt: (plain) => `enc:${plain}`,
  decrypt: (encoded) => encoded.slice(4),
};

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  manager: ProxyManager;
  repository: RunRepository;
  tracesDir: string;
  upstreamCalls: () => number;
}

/** 建一个已保存 enabled 的环境（模拟"上次开着"） */
function setup(saved: { enabled: boolean; port: number; upstreamBaseUrl: string }): Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), "proxy-recovery-"));
  dirs.push(dataDir);
  const tracesDir = join(dataDir, "traces");
  mkdirSync(tracesDir, { recursive: true });
  const repository = new RunRepository(tracesDir);
  const settings = new SettingsStore({ dataDir, cipher });
  settings.saveProxy(saved);

  let upstreamCalls = 0;
  const manager = new ProxyManager({
    repository,
    settings,
    tracesDir,
    fetchImpl: async () => {
      upstreamCalls += 1;
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "stub" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  return { manager, repository, tracesDir, upstreamCalls: () => upstreamCalls };
}

/** 真占一个端口（让代理起不来），返回端口与释放句柄 */
async function occupyPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const server = createServer((_, res) => {
    res.statusCode = 200;
    res.end("occupied");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const release = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  closers.push(release);
  return { port, release };
}

/** 借一个当前空闲的端口并立刻放掉（供"应当能起来"的用例使用） */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** 用 node:net 直连判端口是否真的有人在监听（绕开本机 HTTP 代理） */
function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const done = (value: boolean): void => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

const UPSTREAM = "https://upstream.test";

describe("2.3a 保存启用后重启恢复监听", () => {
  it("端口可用 ⇒ 真实监听既有地址、running=true、hasKey=false", async () => {
    const port = await freePort();
    const f = setup({ enabled: true, port, upstreamBaseUrl: UPSTREAM });
    await f.manager.autoStart();

    const state = f.manager.status();
    expect(state.enabled).toBe(true);
    expect(state.running).toBe(true);
    expect(state.port).toBe(port);
    expect(state.recovery).toBe("stopped");
    expect(state.recoveryFailure).toBeNull();
    // 重启不恢复 key：hasKey 必须是 false（key 只在本次 main 内存）
    expect(state.hasKey).toBe(false);
    // 恢复过程不调用上游（不"验证连接"）
    expect(f.upstreamCalls()).toBe(0);
    // 真实监听：能连上
    expect(await isListening(state.port)).toBe(true);
    const res = await fetch(`http://127.0.0.1:${state.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-after-restart" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    await res.text();
  });

  it("恢复期间状态是 recovering（不是 stopped），终态推进 revision", async () => {
    const port = await freePort();
    const f = setup({ enabled: true, port, upstreamBaseUrl: UPSTREAM });
    const seen: Array<{ recovery: string; running: boolean }> = [];
    f.manager.onChange(() => {
      const s = f.manager.status();
      seen.push({ recovery: s.recovery, running: s.running });
    });
    await f.manager.autoStart();

    // 「进入 recovering」必须可观察：否则 renderer 首次读状态可能正好落在窗口里
    expect(seen.some((s) => s.recovery === "recovering" && !s.running)).toBe(true);
    expect(seen[seen.length - 1]).toEqual({ recovery: "stopped", running: true });
  });

  it("状态回读是纯只读：不启动监听、不调用上游", async () => {
    const port = await freePort();
    const f = setup({ enabled: true, port, upstreamBaseUrl: UPSTREAM });
    await f.manager.autoStart();
    const before = f.manager.status();
    for (let i = 0; i < 5; i += 1) f.manager.status();
    const after = f.manager.status();
    expect(after.revision).toBe(before.revision);
    expect(f.upstreamCalls()).toBe(0);
  });
});

describe("2.3a 重启恢复失败可见且可重试", () => {
  it("端口占用 ⇒ enabled 仍为 true、running=false、阶段 failed、受控原因可见", async () => {
    const { port, release } = await occupyPort();
    const f = setup({ enabled: true, port, upstreamBaseUrl: UPSTREAM });

    await expect(f.manager.autoStart()).resolves.toBeUndefined(); // 不阻断应用启动

    const state = f.manager.status();
    // 🔴 关键：enabled 不回滚。用户保存的是"我想开着"，失败不等于"用户关了"。
    expect(state.enabled).toBe(true);
    expect(state.running).toBe(false);
    expect(state.recovery).toBe("failed");
    expect(state.recoveryFailure).not.toBeNull();
    expect(state.recoveryFailure?.code).toBe("PORT_UNAVAILABLE");
    expect(state.recoveryFailure?.message).toContain(String(port));
    expect(f.upstreamCalls()).toBe(0);
    // 端口确实不是我们的：真连上去的是那个占位 server，不是录制代理
    expect(await isListening(port)).toBe(true);

    // 历史仍可读取（traces 目录照常可用）
    expect(f.repository.listRuns().runs).toEqual([]);
    expect(() => f.repository.listRuns()).not.toThrow();

    // 端口释放后，**显式应用配置**可重试
    await release();
    const retried = await f.manager.toggle({ enabled: true, port, upstreamBaseUrl: UPSTREAM });
    expect(retried.running).toBe(true);
    expect(retried.recovery).toBe("stopped");
    expect(retried.recoveryFailure).toBeNull();
    // enabled 本来就是 true，不因这次成功而改变
    expect(retried.enabled).toBe(true);
    expect(await isListening(port)).toBe(true);
  });

  // 🔴 变异靶：诊断是"有失败才有"，两头都要守住。
  //   - 若 `attemptListen` 失败时忘了写 recoveryFailure（仍返回 null）⇒ 本组第一、
  //     倒数第二条的 `not.toBeNull()` 会红；
  //   - 若 `classifyRecoveryFailure` 恒返回非 null（凭空造诊断）⇒ 本条红。
  //   两侧都验，才不会出现"永远失败"或"永远有理由"的糊口。
  it("无失败时诊断必须为 null（凭空造诊断会让本条红）", async () => {
    const port = await freePort();
    const f = setup({ enabled: true, port, upstreamBaseUrl: UPSTREAM });
    await f.manager.autoStart();
    expect(f.manager.status().recoveryFailure).toBeNull();
    expect(f.manager.status().recovery).toBe("stopped");
  });

  it("失败诊断已脱敏限长：不含捕获到的 key，也不含 stack", async () => {
    const { port } = await occupyPort();
    const f = setup({ enabled: true, port, upstreamBaseUrl: UPSTREAM });
    await f.manager.autoStart().catch(() => undefined);
    const failure = f.manager.status().recoveryFailure;
    if (failure === null) throw new Error("unreachable：端口占用必然产生失败诊断");
    expect(failure.message.length).toBeLessThanOrEqual(1024);
    expect(failure.message).not.toContain("at Object.");
    expect(failure.message).not.toContain("node:internal");
    // 不含上游地址（诊断是给用户看"为什么没起来"，不是回显配置）
    expect(failure.message).not.toContain("upstream.test");
  });

  it("恢复失败后回读不会偷偷重试监听（只有显式应用才会）", async () => {
    const { port } = await occupyPort();
    const f = setup({ enabled: true, port, upstreamBaseUrl: UPSTREAM });
    await f.manager.autoStart();

    const revisionAfterFailure = f.manager.status().revision;
    for (let i = 0; i < 5; i += 1) f.manager.status();
    expect(f.manager.status().revision).toBe(revisionAfterFailure);
    expect(f.manager.status().recovery).toBe("failed");
  });

  it("显式停用会复位阶段与诊断（不留过期的失败原因）", async () => {
    const { port } = await occupyPort();
    const f = setup({ enabled: true, port, upstreamBaseUrl: UPSTREAM });
    await f.manager.autoStart();
    expect(f.manager.status().recoveryFailure).not.toBeNull();

    const off = await f.manager.toggle({ enabled: false, port, upstreamBaseUrl: UPSTREAM });
    expect(off.enabled).toBe(false);
    expect(off.running).toBe(false);
    expect(off.recovery).toBe("stopped");
    expect(off.recoveryFailure).toBeNull();
  });

  it("失败诊断只归稳定类别，不把原始异常对象回传", async () => {
    const { port } = await occupyPort();
    const f = setup({ enabled: true, port, upstreamBaseUrl: UPSTREAM });
    await f.manager.autoStart();
    const failure = f.manager.status().recoveryFailure;
    if (failure === null) throw new Error("unreachable");
    expect(Object.keys(failure).sort()).toEqual(["code", "message"]);
    expect(["PORT_UNAVAILABLE", "LISTEN_FAILED", "UNKNOWN"]).toContain(failure.code);
  });
});

describe("2.3a 保存停用不启动代理", () => {
  it("saved.enabled=false ⇒ 不尝试监听、阶段 stopped、零上游请求", async () => {
    const port = await freePort();
    const f = setup({ enabled: false, port, upstreamBaseUrl: UPSTREAM });
    await f.manager.autoStart();

    const state = f.manager.status();
    expect(state.enabled).toBe(false);
    expect(state.running).toBe(false);
    expect(state.recovery).toBe("stopped");
    expect(state.recoveryFailure).toBeNull();
    expect(state.hasKey).toBe(false);
    expect(f.upstreamCalls()).toBe(0);
    // 端口没被监听：连不上（不是"恰好也起了"）。⚠️ 必须用 net 直连判，
    // fetch 会被本机 HTTP 代理接管，返回 400 也不代表有人在监听。
    expect(await isListening(port)).toBe(false);
  });
});
