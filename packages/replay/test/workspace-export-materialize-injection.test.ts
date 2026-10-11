import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXPORT_FILES_ROOT, WorkspaceExportWriter, materializeExportFiles } from "../src/index";
import type { ExportVerifiedFile } from "../src/index";
import { hashWorkspaceContent } from "../src/workspace/blob-store";
import { makeTempDir } from "./workspace-helpers";

/**
 * 注入 I/O 故障的用例（单独一个文件，避免 mock 影响其他用例的模块图；与
 * workspace-blob-store-injection.test.ts 同一模式）。真实卷故障（磁盘满、断电、权限）
 * 无法在单测里稳定复现，因此替换 `node:fs/promises` 的具体函数：默认走真实实现，
 * 只在用例显式排入故障时接管。
 *
 * 覆盖（任务 2.2/2.3 对应的失败注入面）：
 * - `open` 失败 → 创建目标文件失败（io），此前产物被逆序清理；
 * - 写入中途失败（handle.writeFile 抛 EIO）→ 半成品在失败点即时移除 + 逆序清理；
 * - `unlink` 失败 → 清理不完整，retained 报告残留相对路径。
 */
const injection = vi.hoisted(() => ({
  /** open 时注入：返回要抛的错误（返回 null 则放行真实实现） */
  nextOpenError: null as null | (() => Error),
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
      const make = injection.nextOpenError;
      if (make !== null) {
        injection.nextOpenError = null;
        throw make();
      }
      const openIndex = injection.openCount;
      injection.openCount += 1;
      const openActual = actual.open as unknown as (...args: unknown[]) => Promise<FileHandle>;
      const handle = await openActual(path, flags, ...rest);
      if (injection.failWriteOnOpenIndex === openIndex) {
        injection.failWriteOnOpenIndex = null;
        handle.writeFile = (async () => {
          throw Object.assign(new Error("注入的写入中途故障"), { code: "EIO" });
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

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function vf(path: string, content: string): ExportVerifiedFile {
  const data = utf8(content);
  return {
    file: { path, sha256: hashWorkspaceContent(data), bytes: data.byteLength },
    data,
  };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  injection.nextOpenError = null;
  injection.failWriteOnOpenIndex = null;
  injection.openCount = 0;
  injection.nextUnlinkError = null;
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function newTarget(name: string): string {
  const dir = makeTempDir(`export-inject-${name}-`);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("导出物化：注入 I/O 失败（任务 2.2/2.3）", () => {
  it("第二个文件写入中途失败：半成品即时移除 + 全部本次产物逆序清理，目标回到空", async () => {
    const target = newTarget("mid-write");
    // open 序号：0 = a.txt（成功），1 = b.txt（写入中途失败）
    injection.failWriteOnOpenIndex = 1;

    const result = await materializeExportFiles(target, [
      vf("a.txt", "第一个文件（成功）"),
      vf("b.txt", "第二个文件（写入中途失败）"),
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("io");
    expect(result.failure.reason).toContain("注入的写入中途故障");

    // 半成品（b.txt）没躺在目标里：失败点即时移除
    expect(existsSync(join(target, EXPORT_FILES_ROOT, "b.txt"))).toBe(false);
    // 逆序清理：a.txt、目录树全部回收，目标回到空（files/ 也被删空）
    expect(result.cleanup.complete).toBe(true);
    expect(result.cleanup.removed).toEqual([`${EXPORT_FILES_ROOT}/a.txt`, EXPORT_FILES_ROOT]);
    expect(readdirSync(target)).toEqual([]);
  });

  it("第一个文件创建即失败（open 注入 EIO）：目录被清理，诊断保留原始错误", async () => {
    const target = newTarget("open-fail");
    injection.nextOpenError = () => Object.assign(new Error("注入的磁盘故障"), { code: "EIO" });

    const result = await materializeExportFiles(target, [vf("a.txt", "x")]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("io");
    expect(result.failure.reason).toContain("注入的磁盘故障");
    expect(result.cleanup.complete).toBe(true);
    expect(result.cleanup.removed).toEqual([EXPORT_FILES_ROOT]);
    expect(readdirSync(target)).toEqual([]);
  });

  it("清理失败（unlink 注入 EPERM）：原始写失败保留，残留相对路径进 retained", async () => {
    const target = newTarget("cleanup-fail");
    const writer = new WorkspaceExportWriter(target);
    await writer.ensureDir(EXPORT_FILES_ROOT);
    await writer.writeFile(`${EXPORT_FILES_ROOT}/a.txt`, utf8("已写入"));

    // 让 b.txt 写入失败（触发清理），且清理 a.txt 的 unlink 也失败
    writeFileSync(join(target, EXPORT_FILES_ROOT, "b.txt"), "抢占者");
    injection.nextUnlinkError = () => Object.assign(new Error("注入的权限故障"), { code: "EPERM" });

    let failure: unknown = null;
    try {
      await writer.writeFile(`${EXPORT_FILES_ROOT}/b.txt`, utf8("x"));
    } catch (error) {
      failure = error;
    }
    expect((failure as { code: string }).code).toBe("target_race");

    const report = await writer.cleanup();
    // a.txt 删除失败 → retained 带残留相对路径；b.txt 是抢占者的，根本不在登记里
    expect(report.complete).toBe(false);
    expect(report.retained.map((item) => item.path)).toEqual([
      `${EXPORT_FILES_ROOT}/a.txt`,
      EXPORT_FILES_ROOT,
    ]);
    expect(report.retained[0]?.reason).toContain("注入的权限故障");
    expect(existsSync(join(target, EXPORT_FILES_ROOT, "a.txt"))).toBe(true);
    expect(existsSync(join(target, EXPORT_FILES_ROOT, "b.txt"))).toBe(true);
  });
});
