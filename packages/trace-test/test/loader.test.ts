import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TraceTestConfigError } from "../src/errors.js";
import { discoverDefinitions, loadDefinition, resolveTracePath } from "../src/loader.js";

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "trace-test-loader-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadDefinition", () => {
  it("加载合法定义", () => {
    const dir = makeTempDir();
    const file = join(dir, "ok.json");
    writeFileSync(file, JSON.stringify({ format_version: 1, name: "t", trace: "a.jsonl" }), "utf8");
    const def = loadDefinition(file);
    expect(def.name).toBe("t");
    expect(def.trace).toBe("a.jsonl");
  });

  it("非 JSON 文件 → 配置错误", () => {
    const dir = makeTempDir();
    const file = join(dir, "bad.json");
    writeFileSync(file, "{not json", "utf8");
    expect(() => loadDefinition(file)).toThrow(TraceTestConfigError);
  });

  it("结构非法 / 未知版本 → 配置错误（指明文件名）", () => {
    const dir = makeTempDir();
    const file = join(dir, "v2.json");
    writeFileSync(file, JSON.stringify({ format_version: 9, name: "x", trace: "t" }), "utf8");
    expect(() => loadDefinition(file)).toThrow(/v2\.json/);

    const file2 = join(dir, "missing.json");
    writeFileSync(file2, JSON.stringify({ format_version: 1 }), "utf8");
    expect(() => loadDefinition(file2)).toThrow(TraceTestConfigError);
  });

  it("文件不存在 → 配置错误", () => {
    expect(() => loadDefinition(join(makeTempDir(), "nope.json"))).toThrow(TraceTestConfigError);
  });
});

describe("resolveTracePath", () => {
  it("相对定义文件解析（不依赖 cwd），结果为绝对路径", () => {
    const resolved = resolveTracePath("D:/proj/tests/readme.test.json", "fixtures/readme.jsonl");
    expect(resolved.toLowerCase()).toContain("tests");
    expect(resolved.toLowerCase()).toContain("fixtures");
  });

  it("绝对路径原样保留（Windows 盘符路径跨平台视为绝对，含反斜杠写法）", () => {
    expect(resolveTracePath("D:/proj/tests/x.json", "D:/other/t.jsonl")).toBe("D:/other/t.jsonl");
    expect(resolveTracePath("D:/proj/tests/x.json", "D:\\other\\t.jsonl")).toBe("D:\\other\\t.jsonl");
  });

  it("POSIX 绝对路径原样保留", () => {
    expect(resolveTracePath("/proj/tests/x.json", "/other/t.jsonl")).toBe("/other/t.jsonl");
  });

  it("仅大小写盘符前缀被识别，普通相对路径仍拼接（防误伤）", () => {
    // 「nn:/x」「1:/x」不是合法盘符路径，仍按相对路径处理
    for (const weird of ["nn:/x", "1:/x", "DD:/x"]) {
      const resolved = resolveTracePath("D:/proj/tests/x.json", weird);
      expect(resolved).not.toBe(weird);
    }
  });
});

describe("discoverDefinitions", () => {
  it("递归发现 *.json（忽略其他扩展名与 node_modules），按名称排序", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "b.json"), "{}", "utf8");
    writeFileSync(join(dir, "a.json"), "{}", "utf8");
    writeFileSync(join(dir, "readme.txt"), "x", "utf8");
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "c.json"), "{}", "utf8");
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "nested", "c.json"), "{}", "utf8");

    const files = discoverDefinitions(dir);
    expect(files.map((f) => f.replaceAll("\\", "/").split("/").pop())).toEqual([
      "a.json",
      "b.json",
      "c.json",
    ]);
  });

  it("空目录 → 配置错误", () => {
    expect(() => discoverDefinitions(makeTempDir())).toThrow(TraceTestConfigError);
  });
});
