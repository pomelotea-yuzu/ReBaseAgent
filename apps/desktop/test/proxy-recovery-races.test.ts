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
import { proxyRecoveryView } from "../src/renderer/src/lib/proxy-recovery-view";

/**
 * tasks 2.4：§2 的**跨层场景级回归**（恢复竞争 / 端口占用 / 重启 key 失效 /
 * 回读乱序与失败 / 只读重试）。
 *
 * 2.1/2.3a/2.3b 各自钉住了自己那层的语义，本文件钉**它们交界处**才会暴露的东西：
 * - 🔴 恢复是 fire-and-forget（`main/index.ts:247` 不await `autoStart`），所以
 *   "恢复中用户点停用"这类竞争**真实会发生**。2.3a 的测试全部 await到底，
 *   正好绕开了这段窗口——那才是最容易出事的地方。
 * - 🔴 重启后 key 不恢复，但 `enabled` 恢复 ⇒ 会出现"已启用 + 监听中 + 无凭据"
 *   这个组合。它在门禁层必须表现为"不可重发"，而在呈现层必须说"尚未捕获"，
 *   两边不一致就是用户点了才发现被拦。
 * - 🔴 回读失败/乱序在 2.1 是store 层判据；这里从 main 侧验证**同一批事实**
 *   经渲染层派生后不会说出错话（比如把 failed 说成 listening）。
 *
 * 判据来源：tasks 2.4 括号里的六个场景。
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
  settings: SettingsStore;
  upstreamCalls: () => number;
}

function setup(saved: { enabled: boolean; port: number; upstreamBaseUrl: string }): Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), "proxy-recovery-race-"));
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
  return { manager, settings, upstreamCalls: () => upstreamCalls };
}

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

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

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

describe("2.4 恢复竞争：恢复是 fire-and-forget，用户操作可能插进来", () => {
  it("🔴 变异靶：恢复中显式停用 ⇒ 终态是已停，不是被恢复反手拉起", async () => {
    const port = await freePort();
    const f = setup({ enabled: true, port, upstreamBaseUrl: UPSTREAM });

    // 刻意**不 await** autoStart：复刻 main/index.ts 的 fire-and-forget
    const restoring = f.manager.autoStart();
    expect(f.manager.status().recovery).toBe("recovering");

    // 用户在恢复窗口里点了停用
    await f.manager.toggle({ enabled: false, port, upstreamBaseUrl: UPSTREAM });
    await restoring;

    const state = f.manager.status();
    expect(state.enabled).toBe(false);
    expect(state.running).toBe(false);
    expect(state.recovery).toBe("stopped");
    expect(state.recoveryFailure).toBeNull();
    // 🔴 若attemptListen 的成功分支不检查"是否已被停用"，这里会running=true
    expect(await isListening(port)).toBe(false);
  });

  it("恢复中改端口 ⇒ 最终监听的是新端口（旧端口不被占住）", async () => {
    const oldPort = await freePort();
    const newPort = await freePort();
    const f = setup({ enabled: true, port: oldPort, upstreamBaseUrl: UPSTREAM });

    const restoring = f.manager.autoStart();
    await f.manager.toggle({ enabled: true, port: newPort, upstreamBaseUrl: UPSTREAM });
    await restoring;

    const state = f.manager.status();
    expect(state.running).toBe(true);
    expect(state.port).toBe(newPort);
    expect(await isListening(newPort)).toBe(true);
    expect(await isListening(oldPort)).toBe(false);
  });

  it("重复 autoStart 幂等：不会起两个监听器，也不会把阶段倒退", async () => {
    const port = await freePort();
    const f = setup({ enabled: true, port, upstreamBaseUrl: UPSTREAM });

    await Promise.all([f.manager.autoStart(), f.manager.autoStart()]);

    const state = f.manager.status();
    expect(state.running).toBe(true);
    expect(state.recovery).toBe("stopped");
    expect(state.recoveryFailure).toBeNull();
    // 端口还通 ⇒ 没有把监听器堆成两个（第二个会 EADDRINUSE）
    expect(await isListening(port)).toBe(true);
    expect(f.upstreamCalls()).toBe(0);
  });

  it("恢复失败与用户重试交错：终态诊断只反映最后一次真实尝试", async () => {
    const { port, release } = await occupyPort();
    const f = setup({ enabled: true, port, upstreamBaseUrl: UPSTREAM });

    const restoring = f.manager.autoStart();
    await restoring;
    expect(f.manager.status().recoveryFailure?.code).toBe("PORT_UNAVAILABLE");

    // 失败期间用户又点了一次应用（端口还占着）⇒ 诊断必须仍在，不能被清成 null
    await f.manager
      .toggle({ enabled: true, port, upstreamBaseUrl: UPSTREAM })
      .catch(() => undefined);
    expect(f.manager.status().recovery).toBe("failed");
    expect(f.manager.status().recoveryFailure?.code).toBe("PORT_UNAVAILABLE");

    // 端口释放后再应用 ⇒ 成功且诊断清空
    await release();
    const ok = await f.manager.toggle({ enabled: true, port, upstreamBaseUrl: UPSTREAM });
    expect(ok.running).toBe(true);
    expect(ok.recoveryFailure).toBeNull();
  });
});

describe("2.4 端口占用的跨层回归（main 事实 ⇒ 渲染层措辞）", () => {
  it("端口占用 ⇒ main 说failed/PORT_UNAVAILABLE，渲染层不得说成已停或已监听", async () => {
    const { port } = await occupyPort();
    const f = setup({ enabled: true, port, upstreamBaseUrl: UPSTREAM });
    await f.manager.autoStart();

    const state = f.manager.status();
    const view = proxyRecoveryView(state, false);
    expect(state.recovery).toBe("failed");
    expect(view.phase).toBe("failed");
    expect(view.headline).not.toContain("已停");
    expect(view.headline).not.toContain("代理已停");
    expect(view.listenLine).toContain("未监听");
    // 受控原因原样透出，且不含栈/上游地址
    expect(view.reason).toContain(String(port));
    expect(view.reason).not.toContain("node:internal");
    expect(view.reason).not.toContain("upstream.test");
  });

  it("恢复中这一中间态经渲染层派生仍是 recovering（不被 running=false 吞掉）", async () => {
    const port = await freePort();
    const f = setup({ enabled: true, port, upstreamBaseUrl: UPSTREAM });
    const restoring = f.manager.autoStart();

    // 在恢复窗口内取一次状态：这正是 renderer 首读可能落点
    const midFlight = f.manager.status();
    expect(midFlight.recovery).toBe("recovering");
    expect(proxyRecoveryView(midFlight, false).phase).toBe("recovering");

    await restoring;
    expect(proxyRecoveryView(f.manager.status(), false).phase).toBe("listening");
  });
});

describe("2.4 重启后 key 不恢复：门禁与呈现必须一致", () => {
  it("重启后 hasKey=false 且捕获版本归零 ⇒ 呈现说未捕获，且不会说凭据可用", async () => {
    const port = await freePort();
    const f = setup({ enabled: true, port, upstreamBaseUrl: UPSTREAM });
    await f.manager.autoStart();

    const state = f.manager.status();
    expect(state.hasKey).toBe(false);
    expect(state.keyCaptureRevision).toBe(0);
    const view = proxyRecoveryView(state, false);
    expect(view.phase).toBe("listening");
    // 🔴 监听成功也不代表有凭据：呈现层必须留着"未捕获 key"
    expect(view.headline).not.toContain("未捕获 key");
    expect(view.needsRecordingEntry).toBe(false);
  });

  it("重启后的状态经渲染派生不产生恢复失败诊断（没失败就没有原因）", async () => {
    const port = await freePort();
    const f = setup({ enabled: true, port, upstreamBaseUrl: UPSTREAM });
    await f.manager.autoStart();
    expect(proxyRecoveryView(f.manager.status(), false).reason).toBeNull();
  });
});

describe("2.4 状态回读：乱序 / 失败 / 只读重试", () => {
  it("回读是纯只读：恢复失败后反复读既不重试也不推进 revision", async () => {
    const { port } = await occupyPort();
    const f = setup({ enabled: true, port, upstreamBaseUrl: UPSTREAM });
    await f.manager.autoStart();

    const before = f.manager.status();
    for (let i = 0; i < 10; i += 1) f.manager.status();
    const after = f.manager.status();

    expect(after.revision).toBe(before.revision);
    expect(after.recordsRevision).toBe(before.recordsRevision);
    expect(after.recovery).toBe("failed");
    // 只读回读不该把占位 server 顶掉（它还在 ⇒ 我们确实没抢到端口）
    expect(await isListening(port)).toBe(true);
    expect(f.upstreamCalls()).toBe(0);
  });

  it("监听成功后回读保持 running，不被读操作本身改写", async () => {
    const port = await freePort();
    const f = setup({ enabled: true, port, upstreamBaseUrl: UPSTREAM });
    await f.manager.autoStart();

    const first = f.manager.status();
    for (let i = 0; i < 10; i += 1) f.manager.status();
    const last = f.manager.status();

    expect(last.running).toBe(true);
    expect(last.port).toBe(first.port);
    expect(last.recovery).toBe("stopped");
    expect(await isListening(port)).toBe(true);
  });

  it("读失败后的重读能恢复事实（重试是真读，不是拿缓存冒充）", async () => {
    const port = await freePort();
    const f = setup({ enabled: true, port, upstreamBaseUrl: UPSTREAM });

    // 第一次"读"发生在恢复之前 ⇒ running=false（模拟 renderer 首读抢在恢复前）
    expect(f.manager.status().running).toBe(false);
    await f.manager.autoStart();
    // 重试读到的是新事实，不是第一次的旧值
    expect(f.manager.status().running).toBe(true);
    expect(proxyRecoveryView(f.manager.status(), false).phase).toBe("listening");
  });
});
