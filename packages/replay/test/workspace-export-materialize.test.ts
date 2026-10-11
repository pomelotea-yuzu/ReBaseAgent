import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXPORT_FILES_ROOT,
  WorkspaceExportWriter,
  materializeExportFiles,
  validateExportTargetDir,
} from "../src/index";
import type { ExportVerifiedFile } from "../src/index";
import { hashWorkspaceContent } from "../src/workspace/blob-store";
import { makeTempDir } from "./workspace-helpers";

/** 构造一条"已通过附件复核"的文件记录（哈希按真实字节计算） */
function vf(path: string, content: string | Uint8Array): ExportVerifiedFile {
  const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return {
    file: { path, sha256: hashWorkspaceContent(data), bytes: data.byteLength },
    data,
  };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function newTarget(name: string): string {
  const dir = makeTempDir(`export-target-${name}-`);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("导出文件物化（任务 2.1）", () => {
  it("files/ 树逐字节正确：嵌套路径、零字节、二进制；返回清单与哈希一致", async () => {
    const target = newTarget("layout");
    const BINARY = Uint8Array.from([0x00, 0xff, 0x00, 0x41]);
    const files = [
      vf("a.txt", "hello"),
      vf("src/deep/nested/x.ts", "export {};\n"),
      vf("empty.bin", new Uint8Array(0)),
      vf("bin.dat", BINARY),
    ];

    const result = await materializeExportFiles(target, files);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files.map((file) => file.path)).toEqual([
      "a.txt",
      "src/deep/nested/x.ts",
      "empty.bin",
      "bin.dat",
    ]);
    expect(readFileSync(join(target, "files", "a.txt"), "utf8")).toBe("hello");
    expect(readFileSync(join(target, "files", "src/deep/nested/x.ts"), "utf8")).toBe(
      "export {};\n",
    );
    expect(readFileSync(join(target, "files", "empty.bin")).byteLength).toBe(0);
    expect(Array.from(readFileSync(join(target, "files", "bin.dat")))).toEqual(Array.from(BINARY));
    for (const item of result.value.files) {
      const bytes = readFileSync(join(target, "files", ...item.path.split("/")));
      expect(item.bytes).toBe(bytes.byteLength);
      expect(item.sha256).toBe(hashWorkspaceContent(bytes));
    }
  });

  it("输出树里只有普通文件和目录，没有 symlink/硬链接身份", async () => {
    const target = newTarget("no-links");
    const result = await materializeExportFiles(target, [vf("d/inner.txt", "x")]);
    expect(result.ok).toBe(true);

    const walk = (dir: string): void => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        expect(item.isSymbolicLink()).toBe(false);
        if (item.isDirectory()) walk(join(dir, item.name));
      }
    };
    walk(target);
    // 都是普通文件（硬链接身份无从保留：这里是独立的新文件）
    expect(statSync(join(target, "files", "d", "inner.txt")).isFile()).toBe(true);
  });

  it("同名元信息路径全部进 files/，根部命名空间不被占用", async () => {
    const target = newTarget("meta-names");
    const result = await materializeExportFiles(target, [
      vf("rebaseagent-export.json", '{"project": true}'),
      vf("changes.patch", "diff --git a/x b/x"),
      vf("files/nested.txt", "项目自己的 files 目录"),
      vf("top.txt", "top"),
    ]);
    expect(result.ok).toBe(true);

    // 根部只有 files/ 一个条目
    expect(readdirSync(target)).toEqual([EXPORT_FILES_ROOT]);
    expect(readFileSync(join(target, "files", "rebaseagent-export.json"), "utf8")).toBe(
      '{"project": true}',
    );
    expect(readFileSync(join(target, "files", "changes.patch"), "utf8")).toBe("diff --git a/x b/x");
    expect(readFileSync(join(target, "files", "files", "nested.txt"), "utf8")).toBe(
      "项目自己的 files 目录",
    );
  });

  it("空文件集合：成功且产生空 files/ 目录", async () => {
    const target = newTarget("empty-snapshot");
    const result = await materializeExportFiles(target, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files).toEqual([]);
    expect(readdirSync(target)).toEqual([EXPORT_FILES_ROOT]);
    expect(lstatSync(join(target, EXPORT_FILES_ROOT)).isDirectory()).toBe(true);
    expect(readdirSync(join(target, EXPORT_FILES_ROOT))).toEqual([]);
  });

  it("竞争（files/ 已被抢先创建）：target_race 失败，竞争者产物原样保留，无清理动作", async () => {
    const target = newTarget("race-dir");
    const competitor = join(target, EXPORT_FILES_ROOT);
    mkdirSync(competitor);
    writeFileSync(join(competitor, "winner.txt"), "竞争者产物");

    const result = await materializeExportFiles(target, [vf("a.txt", "x")]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("target_race");
    expect(result.failure.reason).toContain("竞争");
    expect(result.cleanup.complete).toBe(true);
    expect(result.cleanup.removed).toEqual([]);
    expect(readFileSync(join(competitor, "winner.txt"), "utf8")).toBe("竞争者产物");
  });

  it("竞争（写入级：目标已出现同名文件）：target_race 失败，已写文件被本次清理回收", async () => {
    const target = newTarget("race-file");
    const writer = new WorkspaceExportWriter(target);
    await writer.ensureDir(EXPORT_FILES_ROOT);
    await writer.writeFile(`${EXPORT_FILES_ROOT}/a.txt`, new TextEncoder().encode("已写入"));

    // 模拟写入 b.txt 前别人创建了同名文件
    writeFileSync(join(target, EXPORT_FILES_ROOT, "b.txt"), "抢占者");

    let failure: unknown = null;
    try {
      await writer.writeFile(`${EXPORT_FILES_ROOT}/b.txt`, new TextEncoder().encode("x"));
    } catch (error) {
      failure = error;
    }
    expect((failure as Error).name).toBe("ExportWriteError");
    expect((failure as { code: string }).code).toBe("target_race");

    // 清理只回收本次产物：a.txt 被删；files/ 里还有抢占者的 b.txt → 目录保留并报告非空
    const report = await writer.cleanup();
    expect(report.complete).toBe(false);
    expect(report.removed).toEqual([`${EXPORT_FILES_ROOT}/a.txt`]);
    expect(report.retained.map((item) => item.path)).toEqual([EXPORT_FILES_ROOT]);
    expect(report.retained[0]?.reason).toContain("非空");
    expect(readFileSync(join(target, EXPORT_FILES_ROOT, "b.txt"), "utf8")).toBe("抢占者");
  });

  it("清理的所有权核对：登记文件被替换后保留不删并报告", async () => {
    const target = newTarget("ownership");
    const writer = new WorkspaceExportWriter(target);
    await writer.ensureDir(EXPORT_FILES_ROOT);
    await writer.writeFile(`${EXPORT_FILES_ROOT}/a.txt`, new TextEncoder().encode("original"));

    // 模拟被并发替换
    writeFileSync(join(target, EXPORT_FILES_ROOT, "a.txt"), "replaced!");

    const report = await writer.cleanup();
    expect(report.complete).toBe(false);
    expect(report.removed).toEqual([]);
    expect(report.retained).toHaveLength(2); // a.txt + 其目录（删不掉）
    expect(report.retained[0]?.path).toBe(`${EXPORT_FILES_ROOT}/a.txt`);
    expect(report.retained[0]?.reason).toContain("替换");
    expect(readFileSync(join(target, EXPORT_FILES_ROOT, "a.txt"), "utf8")).toBe("replaced!");
  });

  it("非递归删除：目录内未知嵌套内容保留，目录报告非空", async () => {
    const target = newTarget("non-recursive");
    const writer = new WorkspaceExportWriter(target);
    await writer.ensureDir(EXPORT_FILES_ROOT);
    await writer.ensureDir(`${EXPORT_FILES_ROOT}/dir`);
    // 未知条目塞进本次创建的目录
    const stranger = join(target, EXPORT_FILES_ROOT, "dir", "stranger.txt");
    writeFileSync(stranger, "not mine");

    const report = await writer.cleanup();

    expect(existsSync(stranger)).toBe(true);
    // 逆序清理先碰到深层目录：files/dir 非空保留，随后 files 也非空保留
    expect(report.retained.map((item) => item.path)).toEqual([
      `${EXPORT_FILES_ROOT}/dir`,
      EXPORT_FILES_ROOT,
    ]);
    expect(report.retained[0]?.reason).toContain("递归");
    // 目标根本身从未成为清理对象
    expect(report.removed).not.toContain(".");
  });

  it("中断边界：残留 files/ 的目标按非空拒绝（复用 1.2 校验）", async () => {
    const target = newTarget("leftover");
    mkdirSync(join(target, EXPORT_FILES_ROOT));
    writeFileSync(join(target, EXPORT_FILES_ROOT, "half.txt"), "半成品");

    const result = await validateExportTargetDir(newTarget("other"), target);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("target_invalid");
    expect(result.failure.reason).toContain("非空");
  });
});
