import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { exportWorkspaceSnapshot } from "../src/index";
import type { TempDataDir } from "./workspace-helpers";
import {
  cleanupTempDirs,
  makeDataDir,
  makeTempDir,
  round,
  writeIsolatedRun,
} from "./workspace-helpers";

/**
 * R2.1 任务 4.4b：编排器（exportWorkspaceSnapshot）的写入失败注入。
 *
 * 物化引擎内部的注入用例在 workspace-export-materialize-injection.test.ts；本文件把
 * 注入面抬到**编排层**，验证"清单最后完成"账本在补丁/清单写失败时的逆序清理，以及
 * 清理自身失败时的残留报告。真实卷故障无法在单测稳定复现，与 materialize 注入同一
 * 模式：默认放行真实实现，只在用例显式排入故障时接管 `node:fs/promises`。
 *
 * open 序号（编排器固定顺序，fixture 为单文件选定 step 且补丁 written）：
 * 0 = files/a.txt；1 = changes.patch；2 = rebaseagent-export.json。
 *
 * 「模拟子进程中断」在单测里不可稳定复现，由"残留非空拒绝 + 无自动补写/清理"用例
 * 承载契约面（中断后的目标 = 带残留的非空目录，重新导出被拒，引擎无任何恢复路径）；
 * 真实中断的实机验证归任务 7.1b。
 */
const injection = vi.hoisted(() => ({
  /** 第 N 次 open（0 起）成功的句柄让 writeFile 抛错一次；null = 不注入 */
  failWriteOnOpenIndex: null as null | number,
  openCount: 0,
  /** unlink 时注入：返回要抛的错误（返回 null 则放行真实实现） */
  nextUnlinkError: null as null | (() => Error),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (path: unknown, flags: unknown, ...rest: unknown[]) => {
      const openIndex = injection.openCount;
      injection.openCount += 1;
      const openActual = actual.open as unknown as (...args: unknown[]) => Promise<FileHandle>;
      const handle = await openActual(path, flags, ...rest);
      if (injection.failWriteOnOpenIndex === openIndex) {
        injection.failWriteOnOpenIndex = null;
        handle.writeFile = (async () => {
          throw Object.assign(new Error("注入的写入故障"), { code: "EIO" });
        }) as typeof handle.writeFile;
      }
      return handle;
    },
    unlink: async (path: unknown) => {
      const make = injection.nextUnlinkError;
      if (make !== null) {
        injection.nextUnlinkError = null;
        throw make();
      }
      return actual.unlink(path as Parameters<typeof actual.unlink>[0]);
    },
  };
});

const RUN_ID = "run_inject_orchestrator";

let handle: TempDataDir;
let dataDir: string;
let stepSpanId: string;

beforeAll(async () => {
  handle = makeDataDir();
  dataDir = handle.dataDir;
  // 单文件 + 文本修改 ⇒ 补丁 written：open 序号固定为 文件/补丁/清单
  const written = await writeIsolatedRun({
    dataDir,
    runId: RUN_ID,
    rounds: [round([["a.txt", "before"]]), round([["a.txt", "after\nsecond\n"]])],
  });
  stepSpanId = written.stepSpanIds[0];
});

afterAll(() => {
  handle.cleanup();
});

afterEach(() => {
  injection.failWriteOnOpenIndex = null;
  injection.openCount = 0;
  injection.nextUnlinkError = null;
  cleanupTempDirs();
});

function newTarget(name: string): string {
  return makeTempDir(`export-inject-orch-${name}-`);
}

describe("编排层写失败注入（任务 4.4b）", () => {
  it("补丁写失败：files/ 树逆序清理，目标回空，无清单残留", async () => {
    const target = newTarget("patch-fail");
    injection.openCount = 0; // beforeAll 的 fixture 发布已消耗计数，用例内重新对齐
    injection.failWriteOnOpenIndex = 1; // open#1 = changes.patch

    const result = await exportWorkspaceSnapshot({
      dataDir,
      runId: RUN_ID,
      stepSpanId,
      targetDir: target,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("io");
    expect(result.failure.reason).toContain("注入的写入故障");
    // 逆序清理：files/a.txt → files/；补丁半成品已在失败点即时移除、未入账本
    expect(result.cleanup.complete).toBe(true);
    expect(result.cleanup.removed).toEqual(["files/a.txt", "files"]);
    expect(readdirSync(target)).toEqual([]);
  });

  it("清单写失败：补丁与 files/ 树一并逆序清理，目标回空（无清单 ≠ 成功）", async () => {
    const target = newTarget("manifest-fail");
    injection.openCount = 0;
    injection.failWriteOnOpenIndex = 2; // open#2 = rebaseagent-export.json

    const result = await exportWorkspaceSnapshot({
      dataDir,
      runId: RUN_ID,
      stepSpanId,
      targetDir: target,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("io");
    expect(result.cleanup.complete).toBe(true);
    expect(result.cleanup.removed).toEqual(["changes.patch", "files/a.txt", "files"]);
    expect(readdirSync(target)).toEqual([]);
  });

  it("清单半成品移除失败（unlink 注入 EPERM）：原始失败保留，残留进 retained，其余产物仍回收", async () => {
    const target = newTarget("partial-remove-fail");
    injection.openCount = 0;
    injection.failWriteOnOpenIndex = 2;
    // 注入的 unlink 消耗在清单半成品的即时移除上
    injection.nextUnlinkError = () => Object.assign(new Error("注入的权限故障"), { code: "EPERM" });

    const result = await exportWorkspaceSnapshot({
      dataDir,
      runId: RUN_ID,
      stepSpanId,
      targetDir: target,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("io");
    expect(result.failure.reason).toContain("注入的写入故障");
    // 清理不完整：清单半成品残留并报告；其余本次产物逆序回收成功
    expect(result.cleanup.complete).toBe(false);
    expect(result.cleanup.retained).toHaveLength(1);
    expect(result.cleanup.retained[0]?.path).toBe("rebaseagent-export.json");
    expect(result.cleanup.retained[0]?.reason).toContain("注入的权限故障");
    expect(result.cleanup.removed).toEqual(["changes.patch", "files/a.txt", "files"]);
    expect(existsSync(join(target, "rebaseagent-export.json"))).toBe(true);
  });

  it("残留非空拒绝（中断契约面）：带残留的目标再导出被拒，引擎不自动补写/清理", async () => {
    const target = newTarget("stale-residue");
    // 模拟一次中断后的残留：半成品 files/ 与其中的未知内容
    writeFileSync(join(target, "residue.txt"), "上次中断的残留");
    mkdirSync(join(target, "files"), { recursive: true });
    writeFileSync(join(target, "files", "half.txt"), "半成品");

    const result = await exportWorkspaceSnapshot({
      dataDir,
      runId: RUN_ID,
      stepSpanId,
      targetDir: target,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("target_invalid");
    expect(result.failure.reason).toContain("非空");
    expect(result.cleanup).toEqual({ removed: [], retained: [], complete: true });
    // 残留逐字节原样：引擎没有任何自动清理/补写路径
    expect(readFileSync(join(target, "residue.txt"), "utf8")).toBe("上次中断的残留");
    expect(readFileSync(join(target, "files", "half.txt"), "utf8")).toBe("半成品");
  });
});
