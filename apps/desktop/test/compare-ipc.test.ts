import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { IpcDeps } from "../src/main/ipc";
import { registerIpc } from "../src/main/ipc";
import { RunRepository } from "../src/main/run-repository";
import { CHANNELS, CompareRunsResultSchema, EnvelopeSchema } from "../src/shared/ipc";

/**
 * U7（improve-branch-comparison）tasks 1.6：runs:compare 的实际 IPC 往返。
 *
 * 用 vi.mock("electron") 捕获 ipcMain.handle 注册的真实 handler（HANDOFF §六
 * 登记的补法），有效与非法请求各走一遍真实注册通道：信封形状、成功载荷 schema、
 * 请求级拒绝稳定码与受控文案。渲染层消费与错配核对归 1.4/1.5。
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

const T0 = "2026-01-15T10:00:00.000Z";

let root: string;
let traces: string;

function freshTraces(): string {
  root = mkdtempSync(join(tmpdir(), "u7-compare-ipc-"));
  traces = join(root, "traces");
  mkdirSync(traces);
  return traces;
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function metaLine(id: string, opts: { parent?: string | null; fork?: unknown } = {}): string {
  return JSON.stringify({
    type: "run.meta",
    id,
    format_version: 1,
    task: "u7 IPC 往返夹具",
    model: "controlled-model",
    created_at: T0,
    parent: opts.parent ?? null,
    fork: opts.fork ?? null,
  });
}

const STOP = JSON.stringify({ type: "run.event", event: "stopped", reason: "completed" });

function writeRun(id: string, lines: string[]): void {
  writeFileSync(join(traces, `${id}.jsonl`), `${lines.join("\n")}\n`);
}

function registerWithRepository(): RunRepository {
  const repository = new RunRepository(traces);
  const deps = {
    repository,
    settings: {},
    execCwd: traces,
    dataDir: root,
    proxy: {},
    operations: {},
    isTrustedSender: () => false,
  } as unknown as IpcDeps;
  registerIpc(deps);
  return repository;
}

function invokeCompare(request: unknown): unknown {
  const handler = handles.get(CHANNELS.compareRuns);
  if (handler === undefined) {
    throw new Error("runs:compare handler 未注册");
  }
  // 只读通道不读 sender（无 senderOf 判据），事件参数以最小形状占位
  return handler({ sender: { id: 1 } }, request);
}

describe("U7 1.6 runs:compare 实际 IPC 往返", () => {
  it("通道已随 registerIpc 注册（preload 透传面 typecheck 覆盖）", () => {
    freshTraces();
    registerWithRepository();
    expect(handles.has(CHANNELS.compareRuns)).toBe(true);
  });

  it("有效请求：ok 信封 + 载荷过自家 schema + 逐项顺序保持", () => {
    freshTraces();
    writeRun("r_a", [metaLine("r_a"), STOP]);
    writeRun("r_b", [metaLine("r_b"), STOP]);
    registerWithRepository();

    const envelope = invokeCompare({ runIds: ["r_a", "r_b"] }) as { ok: boolean };
    const parsedEnvelope = EnvelopeSchema.safeParse(envelope);
    expect(parsedEnvelope.success).toBe(true);
    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      const result = CompareRunsResultSchema.safeParse(envelope.data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.items.map((item) => item.runId)).toEqual(["r_a", "r_b"]);
        expect(result.data.items.every((item) => item.status === "ready")).toBe(true);
      }
    }
  });

  it("非法请求：重复 id 走 fail 信封（INVALID_ARGUMENT + 受控文案），不产生半截载荷", () => {
    freshTraces();
    writeRun("r_a", [metaLine("r_a"), STOP]);
    registerWithRepository();

    const envelope = invokeCompare({ runIds: ["r_a", "r_a"] }) as {
      ok: boolean;
      error?: { code: string; message: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("INVALID_ARGUMENT");
    expect(envelope.error?.message).toContain("比较对象重复");
  });

  it("非法标识（目录穿越）在往返层拒绝，错误不暴露物理路径", () => {
    freshTraces();
    registerWithRepository();

    const envelope = invokeCompare({ runIds: ["..\\secret"] }) as {
      ok: boolean;
      error?: { code: string; message: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("INVALID_ARGUMENT");
    expect(envelope.error?.message).toContain("run 标识非法");
    expect(envelope.error?.message).not.toContain(traces);
  });

  it("单侧缺失：ok 信封逐项 unavailable，合法侧 ready（往返层不丢失败项）", () => {
    freshTraces();
    writeRun("r_ok", [metaLine("r_ok"), STOP]);
    registerWithRepository();

    const envelope = invokeCompare({ runIds: ["r_ok", "r_gone"] }) as { ok: boolean };
    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      const result = CompareRunsResultSchema.safeParse(envelope.data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.items[1]?.status).toBe("unavailable");
        if (result.data.items[1]?.status === "unavailable") {
          expect(result.data.items[1].code).toBe("CURRENT_RUN_NOT_FOUND");
        }
      }
    }
  });
});
