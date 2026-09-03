import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type DataDirOptions,
  MARKER_FILE,
  POINTER_FILE,
  resolveDataDir,
} from "../src/main/data-dir";

/** 最小 fs 注入：用内存映射模拟文件存在性（key 用 join 构造，与实现侧一致） */
function fakeFs(files: Record<string, string>): DataDirOptions["fs"] {
  return {
    existsSync: (p) => Object.hasOwn(files, p),
    readFileSync: (p) => {
      const content = files[p];
      if (content === undefined) throw new Error(`不存在：${p}`);
      return content;
    },
  } as NonNullable<DataDirOptions["fs"]>;
}

const devDir = join("D:", "repo");
const exeDir = join("D:", "app");

describe("resolveDataDir：三条路径", () => {
  it("开发模式 → 仓库根 .rebaseagent/", () => {
    const result = resolveDataDir({ devDir, exeDir, packaged: false, fs: fakeFs({}) });
    expect(result).toEqual({ kind: "resolved", dir: join(devDir, ".rebaseagent") });
  });

  it("打包 + portable.marker → <exe 目录>/data", () => {
    const fs = fakeFs({ [join(exeDir, MARKER_FILE)]: "" });
    const result = resolveDataDir({ devDir, exeDir, packaged: true, fs });
    expect(result).toEqual({ kind: "resolved", dir: join(exeDir, "data") });
  });

  it("打包 + 无 marker + 有指针 → 指针记录的目录", () => {
    const target = join("E:", "my-traces");
    const fs = fakeFs({ [join(exeDir, POINTER_FILE)]: JSON.stringify({ dataDir: target }) });
    const result = resolveDataDir({ devDir, exeDir, packaged: true, fs });
    expect(result).toEqual({ kind: "resolved", dir: target });
  });

  it("打包 + 无 marker + 无指针 → needs-selection，不创建任何文件", () => {
    const result = resolveDataDir({ devDir, exeDir, packaged: true, fs: fakeFs({}) });
    expect(result).toEqual({ kind: "needs-selection" });
  });

  it("指针内容非法（dataDir 非字符串）→ needs-selection", () => {
    const fs = fakeFs({ [join(exeDir, POINTER_FILE)]: JSON.stringify({ dataDir: 42 }) });
    const result = resolveDataDir({ devDir, exeDir, packaged: true, fs });
    expect(result).toEqual({ kind: "needs-selection" });
  });
});
