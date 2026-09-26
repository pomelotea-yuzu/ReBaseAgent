import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ProxyConfigWriter,
  clearRunSettings,
  toggleProxy,
  writeRunSettings,
} from "../src/main/config-endpoints";
import type { TrustedSender } from "../src/main/operation-endpoints";
import { OperationRegistry } from "../src/main/operation-registry";
import { SETTINGS_FILE_NAME, SettingsStore } from "../src/main/settings";
import type { SettingsCipher } from "../src/main/settings";
import type { Envelope, ProxyState } from "../src/shared/ipc";
import { OPERATION_ERROR } from "../src/shared/operations";
import { deferred } from "./helpers/deterministic-schedule";

/**
 * U4 任务 3.5 + 3.6：配置写通道由 main 判锁（保存/清除 + 代理异步启停）。
 *
 * 判据来源：tasks.md 3.5/3.6 + design D3；delta spec `desktop-ui`（MODIFIED「运行配置」）。
 * 验收场景（delta 逐字标题）：
 * - 「直接 IPC 不能绕过配置锁」——任一主动操作占槽时，save/clear/toggle 全被拒，
 *   配置文件字节一字未动、代理处理器没被换（toggle 一次都没被调用），
 *   而 settings:get / proxy:status 一类只读通道照常可用；
 * - 「配置变更与主动接受原子互斥」——启停进行中占住配置变更标记：新主动执行被拒、
 *   第二个配置变更也被拒，`finally` 释放后两者才恢复；标记只出现在 operations:status；
 * - 「settled 后读取失败不阻止配置」——已 settled 的失败操作（含结果不可读）不构成
 *   执行中证据，配置照常可写，且新配置只影响后续新 operationId；
 * - 失败返回不泄漏配置或密钥：加密器把入参带进异常时也不回显密钥。
 *
 * 三个处理体都是纯函数（不 import electron），sender 以普通数据注入。
 */

const SENDER: TrustedSender = { webContentsId: 1, frameRoutingId: 100 };
const API_KEY = "sk-config-gate-secret";
const PROXY_STATE: ProxyState = {
  enabled: true,
  running: true,
  port: 18787,
  upstreamBaseUrl: "https://upstream.test",
  hasKey: false,
};

const cipher: SettingsCipher = {
  isAvailable: () => true,
  encrypt: (plain) => `enc:${plain}`,
  decrypt: (encoded) => encoded.slice(4),
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stubProxy(behavior?: () => Promise<ProxyState>): {
  proxy: ProxyConfigWriter;
  calls: () => number;
} {
  let calls = 0;
  const proxy: ProxyConfigWriter = {
    status: () => PROXY_STATE,
    toggle: async (input) => {
      calls += 1;
      void input;
      return behavior === undefined ? PROXY_STATE : await behavior();
    },
  };
  return { proxy, calls: () => calls };
}

function setup(options?: {
  /** 让 cipher.encrypt 抛错（模拟系统加密异常） */
  cipherThrows?: boolean;
  behavior?: () => Promise<ProxyState>;
}): {
  registry: OperationRegistry;
  deps: {
    settings: SettingsStore;
    proxy: ProxyConfigWriter;
    registry: OperationRegistry;
    isTrustedSender: (s: TrustedSender) => boolean;
  };
  dataDir: string;
  settingsFile: string;
  proxyCalls: () => number;
} {
  const dataDir = mkdtempSync(join(tmpdir(), "config-gate-"));
  dirs.push(dataDir);
  const settingsFile = join(dataDir, SETTINGS_FILE_NAME);
  const activeCipher: SettingsCipher =
    options?.cipherThrows === true
      ? {
          isAvailable: () => true,
          encrypt: (plain) => {
            throw new Error(`加密失败，入参 ${plain} 被带进异常\nstack at safeStorage.ts:1`);
          },
          decrypt: (encoded) => encoded.slice(4),
        }
      : cipher;
  const settings = new SettingsStore({ dataDir, cipher: activeCipher });
  const proxyStub = stubProxy(options?.behavior);
  const registry = new OperationRegistry();
  const proxy = proxyStub.proxy;
  return {
    registry,
    deps: {
      settings,
      proxy,
      registry,
      isTrustedSender: (sender) =>
        sender.webContentsId === SENDER.webContentsId &&
        sender.frameRoutingId === SENDER.frameRoutingId,
    },
    dataDir,
    settingsFile,
    proxyCalls: proxyStub.calls,
  };
}

function validInput(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    baseURL: "https://api.deepseek.com/v1",
    apiKey: API_KEY,
    model: "deepseek-chat",
    ...overrides,
  };
}

function expectFail(envelope: Envelope<unknown>, code: string): { message: string } {
  expect(envelope.ok).toBe(false);
  if (envelope.ok) throw new Error(`期望失败信封 ${code}，实际成功`);
  expect(envelope.error.code).toBe(code);
  return envelope.error;
}

describe("U4 3.5 settings 保存/清除的 main 锁", () => {
  it("无锁时正常写入；清除后读取仍可用（读取不受锁影响）", () => {
    const { deps, settingsFile, registry } = setup();
    expect(writeRunSettings(deps, SENDER, validInput())).toEqual({
      ok: true,
      data: { configured: true },
    });
    expect(existsSync(settingsFile)).toBe(true);
    expect(registry.snapshot().operations).toEqual([]);
    expect(deps.settings.load()?.baseURL).toBe("https://api.deepseek.com/v1");
    expect(clearRunSettings(deps, SENDER)).toEqual({ ok: true, data: { configured: false } });
    expect(deps.settings.load()).toBeNull();
    // 清除后仍可读写 ⇒ "配置后重跑可用"的 main 侧一半（另一半在 4.8 的 UI 派生）
    expect(writeRunSettings(deps, SENDER, validInput({ model: "m2" })).ok).toBe(true);
    expect(deps.settings.load()?.model).toBe("m2");
  });

  it("主动操作占槽时：save/clear 被拒、配置文件字节不变、registry 不被写入", () => {
    const { deps, registry, settingsFile } = setup();
    writeRunSettings(deps, SENDER, validInput());
    const before = readFileSync(settingsFile, "utf8");
    const versionBefore = registry.registryVersion;
    registry.registerRunning({
      operationId: "88888888-8888-4888-8888-888888888888",
      target: { kind: "create", mode: "plain" },
      fingerprint: "a".repeat(64),
    });

    expectFail(
      writeRunSettings(deps, SENDER, validInput({ model: "换了模型" })),
      OPERATION_ERROR.notAccepted,
    );
    expectFail(clearRunSettings(deps, SENDER), OPERATION_ERROR.notAccepted);
    expect(readFileSync(settingsFile, "utf8")).toBe(before);
    expect(deps.settings.load()?.model).toBe("deepseek-chat");
    // 被拒的配置变更不是 operation：登记内容不变（只有 running 那一条）
    expect(registry.snapshot().operations.map((one) => one.operationId)).toEqual([
      "88888888-8888-4888-8888-888888888888",
    ]);
    expect(registry.registryVersion).toBe(versionBefore + 1);
  });

  it("已 settled 的操作（含失败与结果不可读）不阻止配置写入", () => {
    const { deps, registry, settingsFile } = setup();
    const operationId = "77777777-7777-4777-8777-777777777777";
    registry.registerRunning({
      operationId,
      target: {
        kind: "result",
        mode: "plain",
        parentRunId: "run_p",
        atSpanId: "s_1",
        editField: "result",
      },
      fingerprint: "b".repeat(64),
    });
    registry.attachRunId(operationId, "run_failed_read");
    registry.settle({ operationId, requestOutcome: "failed", errorCode: "FORK_FAILED" });
    // 该记录仍在快照里、仍带错误码——但"结果读不到"不是执行中证据
    expect(registry.snapshot().operations[0]).toMatchObject({
      state: "settled",
      errorCode: "FORK_FAILED",
      runIds: ["run_failed_read"],
    });
    expect(writeRunSettings(deps, SENDER, validInput()).ok).toBe(true);
    expect(existsSync(settingsFile)).toBe(true);
  });

  it("形状不合先拒（不写盘）；子 frame / 陌生 webContents 一律拒绝", () => {
    const { deps, settingsFile } = setup();
    expectFail(
      writeRunSettings(deps, SENDER, validInput({ baseURL: "not-a-url" })),
      "INVALID_ARGUMENT",
    );
    expectFail(writeRunSettings(deps, SENDER, validInput({ model: "" })), "INVALID_ARGUMENT");
    expectFail(writeRunSettings(deps, SENDER, null), "INVALID_ARGUMENT");
    expect(existsSync(settingsFile)).toBe(false);
    for (const bad of [
      { webContentsId: 1, frameRoutingId: 101 },
      { webContentsId: 9, frameRoutingId: 100 },
    ]) {
      expectFail(writeRunSettings(deps, bad, validInput()), OPERATION_ERROR.untrustedSender);
      expectFail(clearRunSettings(deps, bad), OPERATION_ERROR.untrustedSender);
    }
    expect(existsSync(settingsFile)).toBe(false);
  });

  it("写失败只回单行文案：不回显密钥、也不带 stack", () => {
    const { deps } = setup({ cipherThrows: true });
    const error = expectFail(writeRunSettings(deps, SENDER, validInput()), "SETTINGS_SAVE_FAILED");
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).not.toContain("stack at");
    expect(error.message).toContain("[已隐去]");
  });
});

describe("U4 3.6 代理启停的异步配置互斥", () => {
  it("启停进行中新主动执行被拒；结束后标记释放、主动执行才可被接受", async () => {
    const gate = deferred<ProxyState>();
    const { deps, registry, proxyCalls } = setup({ behavior: () => gate.promise });
    const running = toggleProxy(deps, SENDER, {
      enabled: true,
      port: 19000,
      upstreamBaseUrl: "https://upstream.test",
    });
    // toggle 已进入 await：配置变更标记必须仍占着（判锁与占标记之间无 await）
    expect(registry.snapshot().configurationBusy).toBe(true);
    expect(proxyCalls()).toBe(1);
    const blockedAccept = registry.isAccepting();
    expect(blockedAccept).toEqual({ accepting: false, reason: "configuration_busy" });
    expectFail(
      await toggleProxy(deps, SENDER, {
        enabled: false,
        port: 19001,
        upstreamBaseUrl: "https://x.test",
      }),
      OPERATION_ERROR.notAccepted,
    );
    expect(proxyCalls()).toBe(1);
    gate.resolve(PROXY_STATE);
    const done = await running;
    expect(done).toEqual({ ok: true, data: PROXY_STATE });
    expect(registry.snapshot().configurationBusy).toBe(false);
    expect(registry.isAccepting()).toEqual({ accepting: true });
  });

  it("启停抛错也在 finally 释放标记（不留下永久锁死的配置通道）", async () => {
    const { deps, registry } = setup({
      behavior: async () => {
        throw new Error("端口已被占用");
      },
    });
    const error = expectFail(
      await toggleProxy(deps, SENDER, {
        enabled: true,
        port: 18787,
        upstreamBaseUrl: "https://x.test",
      }),
      "PROXY_START_FAILED",
    );
    expect(error.message).toContain("端口已被占用");
    expect(registry.snapshot().configurationBusy).toBe(false);
    expect(registry.isAccepting()).toEqual({ accepting: true });
    // 标记释放后配置写通道恢复
    expect(writeRunSettings(deps, SENDER, validInput()).ok).toBe(true);
  });

  it("主动占槽时启停被拒且代理处理器不动；只读 status 照常可用", async () => {
    const { deps, registry, proxyCalls } = setup();
    registry.registerRunning({
      operationId: "66666666-6666-4666-8666-666666666666",
      target: { kind: "proxy", parentRunId: "run_p", atSpanId: "s_1" },
      fingerprint: "c".repeat(64),
    });
    const error = expectFail(
      await toggleProxy(deps, SENDER, {
        enabled: false,
        port: 1,
        upstreamBaseUrl: "https://x.test",
      }),
      OPERATION_ERROR.notAccepted,
    );
    expect(error.message).toContain("busy");
    expect(proxyCalls()).toBe(0);
    expect(deps.proxy.status()).toEqual(PROXY_STATE);
    expect(registry.snapshot().configurationBusy).toBe(false);
  });

  it("退出协商期间配置写通道同样被拒（closing 优先），解除后恢复", async () => {
    const { deps, settingsFile } = setup();
    deps.registry.setClosing(true);
    expectFail(clearRunSettings(deps, SENDER), OPERATION_ERROR.notAccepted);
    expectFail(
      await toggleProxy(deps, SENDER, {
        enabled: true,
        port: 2,
        upstreamBaseUrl: "https://x.test",
      }),
      OPERATION_ERROR.notAccepted,
    );
    expect(existsSync(settingsFile)).toBe(false);
    deps.registry.setClosing(false);
    expect(writeRunSettings(deps, SENDER, validInput()).ok).toBe(true);
  });
});
