import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcDeps } from "../src/main/ipc";
import { registerIpc } from "../src/main/ipc";
import { OperationRegistry } from "../src/main/operation-registry";
import { RunRepository } from "../src/main/run-repository";
import type { RunSettings } from "../src/main/settings";
import { CHANNELS, CreateRunResultSchema } from "../src/shared/ipc";
import { OPERATION_ERROR, executedResponseSchema } from "../src/shared/operations";

/**
 * `runs:create` 的**实际 IPC 往返**（HANDOFF §六 登记的第一条测试基础设施小欠账：
 * "未配置门禁缺 IPC 级用例"）。
 *
 * ## 为什么端点级用例还不够
 *
 * `exec-create-fork.test.ts` 已经直接调 `execCreateRun(deps, TRUSTED_SENDER, …)` 覆盖了
 * 未配置分支（`SETTINGS_NOT_CONFIGURED` + 可信终态）。但那条路径**绕过了 `ipc.ts`**，
 * 于是 IPC 薄适配层的三件事完全无覆盖：
 *
 * 1. `ipcMain.handle(CHANNELS.createRun, …)` 真的注册上了这条通道；
 * 2. `senderOf(event)` 把 Electron 的 `{sender:{id}, senderFrame:{routingId}}` 事件
 *    翻译成 `{webContentsId, frameRoutingId}`——**主 frame 判据只在这一层存在**
 *    （`senderFrame` 取不到时给 -1，必然不等于任何主 frame ⇒ 走拒绝分支）；
 * 3. 响应真的落在 `executedResponseSchema` 的合法形状里（renderer 只认这一种）。
 *
 * 端点级用例把 `TrustedSender` 当参数直接注入，**证不到"IPC 事件 ⇒ sender 判据"这一段**。
 *
 * ## 夹具
 *
 * 用 `vi.mock("electron")` 捕获注册的真实 handler；其余依赖全是真件——
 * `RunRepository`（真扫盘）、`OperationRegistry`（真 epoch/占槽/判重）、
 * 只把 LLM 与 settings 读取换成可控件（`unconfigured` ⇒ `load()` 返回 null，即真实
 * "尚未配置运行参数"处境）。因此"零副作用"是数出来的，不是断言出来的。
 */

const handles = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown): void => {
      handles.set(channel, handler);
    },
  },
  dialog: {
    showOpenDialog: async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({
      canceled: true,
      filePaths: [],
    }),
  },
}));

const EPOCH = "22222222-2222-4222-8222-222222222222";
/** 另一个 main 会话的 epoch（合法 uuid，但不是本会话） */
const OTHER_EPOCH = "33333333-3333-4333-8333-333333333333";
/** 合成 sender：与 `isTrustedSender` 桩约定的主 frame 一致 */
const MAIN_FRAME = { sender: { id: 7 }, senderFrame: { routingId: 70 } };
/** 子 frame（webContents 对但 routingId 不是主 frame） */
const CHILD_FRAME = { sender: { id: 7 }, senderFrame: { routingId: 71 } };

let root: string;
let traces: string;
let registry: OperationRegistry;
let settingsLoads: number;
/** 未配置 ⇔ `load()` 返回 null（真实 "SETTINGS_NOT_CONFIGURED" 门禁的输入） */
let configured: RunSettings | null;

/** 合法 uuid 形态的 operationId（registry/schema 只认这种形状） */
function opId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function envelope(n: number, request: unknown, epoch = EPOCH): unknown {
  return { operation: { epoch, operationId: opId(n) }, request };
}

function createRequest(n: number, epoch = EPOCH): unknown {
  return envelope(
    n,
    { systemPrompt: "你是简洁的问答助手。", userMessage: `第 ${n} 次创建` },
    epoch,
  );
}

/** 走真实注册通道调用 runs:create（事件形状即 Electron invoke 的形状） */
function invokeCreate(payload: unknown, event: unknown = MAIN_FRAME): Promise<unknown> {
  const handler = handles.get(CHANNELS.createRun);
  if (handler === undefined) throw new Error("runs:create handler 未注册");
  return Promise.resolve(handler(event, payload));
}

function traceFiles(): string[] {
  return readdirSync(traces)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "create-run-ipc-"));
  traces = join(root, "traces");
  mkdirSync(traces);
  registry = new OperationRegistry({
    newEpoch: () => EPOCH,
    now: () => Date.parse("2026-10-04T00:00:00.000Z"),
  });
  settingsLoads = 0;
  configured = null;
  const deps = {
    repository: new RunRepository(traces),
    settings: {
      load: () => {
        settingsLoads += 1;
        return configured;
      },
      isEncryptionAvailable: () => false,
    },
    execCwd: root,
    dataDir: root,
    proxy: {
      fork: async (): Promise<{ id: string }> => {
        throw new Error("proxy:fork 不该被 runs:create 触达");
      },
    },
    operations: registry,
    // 只放行 MAIN_FRAME：webContents 与主 frame routingId 都对才可信
    isTrustedSender: (sender: { webContentsId: number; frameRoutingId: number }) =>
      sender.webContentsId === MAIN_FRAME.sender.id &&
      sender.frameRoutingId === MAIN_FRAME.senderFrame.routingId,
  } as unknown as IpcDeps;
  registerIpc(deps);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("runs:create 实际 IPC 往返：通道注册与 sender 薄适配", () => {
  it("通道随 registerIpc 注册在 runs:create 上（preload 透传面 typecheck 覆盖）", () => {
    expect(handles.has(CHANNELS.createRun)).toBe(true);
  });

  it("主 frame 事件被放行到端点：门禁真的读到了配置（senderOf 翻译正确）", async () => {
    const response = (await invokeCreate(createRequest(1))) as {
      ok: boolean;
      operation: { operationId: string } | null;
    };
    // 未配置 ⇒ 端点跑到了 settings 门禁（而不是被 sender 判据挡下）
    expect(settingsLoads).toBe(1);
    expect(response.ok).toBe(false);
    expect(response.operation?.operationId).toBe(opId(1));
  });

  it("子 frame 事件在任何副作用之前被拒：operation 为 null、零配置读取、零登记", async () => {
    const response = (await invokeCreate(createRequest(2), CHILD_FRAME)) as {
      ok: boolean;
      operation: unknown;
      error: { code: string; message: string };
    };
    expect(response.ok).toBe(false);
    expect(response.operation).toBeNull();
    expect(response.error.code).toBe(OPERATION_ERROR.untrustedSender);
    expect(settingsLoads).toBe(0);
    expect(registry.size).toBe(0);
    expect(registry.activeId).toBeNull();
    expect(traceFiles()).toEqual([]);
  });

  it("senderFrame 取不到时 routingId 落 -1 ⇒ 拒绝（不猜身份）", async () => {
    const response = (await invokeCreate(createRequest(3), {
      sender: { id: 7 },
      senderFrame: null,
    })) as { ok: boolean; operation: unknown; error: { code: string } };
    expect(response.ok).toBe(false);
    expect(response.operation).toBeNull();
    expect(response.error.code).toBe(OPERATION_ERROR.untrustedSender);
    expect(settingsLoads).toBe(0);
    expect(registry.size).toBe(0);
  });

  it("缺身份信封在配置读取之前被拒：零配置读取、零登记", async () => {
    const response = (await invokeCreate({
      systemPrompt: "",
      userMessage: "没有信封的裸请求",
    })) as { ok: boolean; operation: unknown; error: { code: string } };
    expect(response.ok).toBe(false);
    expect(response.operation).toBeNull();
    expect(response.error.code).toBe(OPERATION_ERROR.invalidIdentity);
    expect(settingsLoads).toBe(0);
    // 整个 registry 里一条登记都没有（size 0 才是"零登记"，查某个具体 ID 会漏）
    expect(registry.size).toBe(0);
    expect(registry.activeId).toBeNull();
  });
});

describe("runs:create 未配置门禁：接受之后才失败，响应形状仍是合法执行信封", () => {
  it("未配置：SETTINGS_NOT_CONFIGURED + settled 回执 + 零运行身份/零文件", async () => {
    const response = await invokeCreate(createRequest(10));

    // 响应形状必须过 executedResponseSchema —— renderer 只认这一种
    const parsed = executedResponseSchema(CreateRunResultSchema).safeParse(response);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.ok).toBe(false);
    if (parsed.data.ok) return;
    expect(parsed.data.error.code).toBe("SETTINGS_NOT_CONFIGURED");
    // 已接受 ⇒ 必须带回执（operation 不是 null），否则 renderer 无法解冻门禁
    expect(parsed.data.operation).toMatchObject({
      epoch: EPOCH,
      operationId: opId(10),
      state: "settled",
    });

    // 登记侧：可信终态带原稳定码，且零运行身份（不伪造）
    expect(registry.recordOf(opId(10))).toMatchObject({
      state: "settled",
      target: { kind: "create", mode: "plain" },
      requestOutcome: "rejected",
      errorCode: "SETTINGS_NOT_CONFIGURED",
      runIds: [],
    });
    // 副作用计数：没建目录外的任何东西，也没占着槽
    expect(traceFiles()).toEqual([]);
    expect(registry.activeId).toBeNull();
  });

  it("未配置时的隔离创建报 SETTINGS_NOT_CONFIGURED 而非 INVALID_SOURCE_TOKEN（门禁先于令牌校验）", async () => {
    // 判的是**顺序**：端点先读配置、后校验令牌，所以"未配置 + 无效令牌"必须落在配置门禁上。
    // （"令牌到底有没有被烧掉"由端点级 `exec-create-fork.test.ts` 的 `tokenConsumes()`
    // 计数断言——那需要可注入的 sourceTokens 桩，IPC 往返层拿不到，也不需要。）
    const response = (await invokeCreate(
      envelope(11, {
        systemPrompt: "",
        userMessage: "未配置时的隔离创建",
        workspace: {
          mode: "isolated_files",
          sourceToken: "no-such-token",
          allowFileWrites: true,
        },
      }),
    )) as { ok: boolean; error: { code: string } };
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe("SETTINGS_NOT_CONFIGURED");
    expect(traceFiles()).toEqual([]);
  });

  it("旧 epoch 的未配置请求连门禁都进不去：零配置读取、零登记", async () => {
    const response = (await invokeCreate(createRequest(12, OTHER_EPOCH))) as {
      ok: boolean;
      operation: unknown;
      error: { code: string };
    };
    expect(response.ok).toBe(false);
    expect(response.operation).toBeNull();
    expect(response.error.code).toBe(OPERATION_ERROR.staleEpoch);
    expect(settingsLoads).toBe(0);
    expect(registry.size).toBe(0);
    expect(traceFiles()).toEqual([]);
  });
});
