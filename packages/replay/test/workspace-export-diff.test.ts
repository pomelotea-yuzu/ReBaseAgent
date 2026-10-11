import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_DIFF_CELLS,
  ExportDiffError,
  buildUnifiedDiff,
  quoteDiffPath,
} from "../src/index";

describe("确定性 unified diff（任务 3.3a）", () => {
  it("单点修改：三行上下文、a/b 头、-/+ 行", () => {
    // 5 行文件改第 3 行：±3 上下文被文件边界截断后覆盖全文件（与 git 一致）
    const diff = buildUnifiedDiff("f.txt", "f.txt", "l1\nl2\nl3\nl4\nl5\n", "l1\nl2\nX3\nl4\nl5\n");
    expect(diff).toBe(
      [
        "--- a/f.txt",
        "+++ b/f.txt",
        "@@ -1,5 +1,5 @@",
        " l1",
        " l2",
        "-l3",
        "+X3",
        " l4",
        " l5",
        "",
      ].join("\n"),
    );
    // 9 行文件改第 5 行：上下文完整不触边界 → @@ -2,7 +2,7 @@
    const nine = (m: string): string =>
      `${Array.from({ length: 9 }, (_, i) => (i === 4 ? m : `l${i + 1}`)).join("\n")}\n`;
    const diff9 = buildUnifiedDiff("g.txt", "g.txt", nine("old"), nine("new"));
    expect(diff9).toContain("@@ -2,7 +2,7 @@\n l2\n l3\n l4\n-old\n+new\n l6\n l7\n l8\n");
  });

  it("间隔 ≤ 6 行的两处修改合并为一个 hunk，> 6 行分成两个", () => {
    const lines = (n: number, mutateAt: number[]): string =>
      `${Array.from({ length: n }, (_, i) =>
        mutateAt.includes(i + 1) ? `M${i + 1}` : `l${i + 1}`,
      ).join("\n")}\n`;

    // 修改第 2、9 行：中间 6 行上下文 → 合并
    const merged = buildUnifiedDiff("f", "f", lines(12, []), lines(12, [2, 9]));
    expect(merged.match(/@@ -\d+,\d+ \+\d+,\d+ @@/g)).toHaveLength(1);
    // 修改第 2、11 行：中间 8 行上下文 → 分两个 hunk
    const split = buildUnifiedDiff("f", "f", lines(12, []), lines(12, [2, 11]));
    expect(split.match(/@@ -\d+,\d+ \+\d+,\d+ @@/g)).toHaveLength(2);
  });

  it("新增：旧头 /dev/null，@@ -0,0 +1,N @@，全部为 + 行", () => {
    const diff = buildUnifiedDiff(null, "new.txt", "", "hello\nworld\n");
    expect(diff).toBe(
      ["--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1,2 @@", "+hello", "+world", ""].join("\n"),
    );
  });

  it("CRLF 逐字保留在内容行里，不被规范化", () => {
    const diff = buildUnifiedDiff("f.txt", "f.txt", "a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\n");
    expect(diff).toContain("-b\r\n");
    expect(diff).toContain("+B\r\n");
    expect(diff).not.toContain("-b\n");
  });

  it("旧文件末尾无换行：del 行后跟 \\ No newline 标记；新文件有换行则无标记", () => {
    const diff = buildUnifiedDiff("f.txt", "f.txt", "x\ny", "x\nY\n");
    expect(diff).toBe(
      [
        "--- a/f.txt",
        "+++ b/f.txt",
        "@@ -1,2 +1,2 @@",
        " x",
        "-y",
        "\\ No newline at end of file",
        "+Y",
        "",
      ].join("\n"),
    );
  });

  it("新文件末尾无换行：add 行后跟标记；双方都无换行则各跟一个", () => {
    const onlyNew = buildUnifiedDiff("f.txt", "f.txt", "x\ny\n", "x\ny");
    expect(onlyNew).toContain("+y\n\\ No newline at end of file\n");
    const both = buildUnifiedDiff("f.txt", "f.txt", "a", "b");
    expect(both).toContain("-a\n\\ No newline at end of file\n");
    expect(both).toContain("+b\n\\ No newline at end of file\n");
  });

  it("空文件改成有内容：@@ -0,0 +1,1 @@", () => {
    const diff = buildUnifiedDiff("f.txt", "f.txt", "", "hi\n");
    expect(diff).toBe(["--- a/f.txt", "+++ b/f.txt", "@@ -0,0 +1,1 @@", "+hi", ""].join("\n"));
  });

  it("内容相同 → 空字符串（无 hunk）", () => {
    expect(buildUnifiedDiff("f.txt", "f.txt", "same\n", "same\n")).toBe("");
  });

  it("确定性：同输入重复调用逐字节一致", () => {
    const oldText = "a\nb\nc\nd\ne\n";
    const newText = "a\nB\nc\nd\nE\n";
    expect(buildUnifiedDiff("f", "f", oldText, newText)).toBe(
      buildUnifiedDiff("f", "f", oldText, newText),
    );
  });

  it("工作量上限：格子数超限抛 ExportDiffError（不截断冒充成功）", () => {
    const big = `${"x\n".repeat(50)}`;
    expect(() => buildUnifiedDiff("f", "f", big, big.replace("x", "y"), 10)).toThrow(
      ExportDiffError,
    );
    // 缺省上限的文档值可被引用
    expect(DEFAULT_MAX_DIFF_CELLS).toBe(1_000_000);
  });
});

describe("路径引用（任务 3.3a）", () => {
  it("安全路径原样输出", () => {
    expect(quoteDiffPath("a/src/main.ts")).toBe("a/src/main.ts");
  });

  it("含空格/非 ASCII/引号 → 加引号并按 UTF-8 字节八进制转义", () => {
    expect(quoteDiffPath("a/file name.txt")).toBe('"a/file\\040name.txt"');
    expect(quoteDiffPath("b/文.txt")).toBe('"b/\\346\\226\\207.txt"');
    expect(quoteDiffPath('c/we"ird.txt')).toBe('"c/we\\"ird.txt"');
  });
});
