import { describe, expect, it } from "vitest";
import {
  MAX_LOGICAL_PATH_DEPTH,
  MAX_LOGICAL_PATH_LENGTH,
  findLogicalPathCollisionViolation,
  findLogicalPathViolation,
  logicalPathCollisionKey,
  normalizeLogicalPath,
} from "../src/logical-path";

/** 构造恰好 `length` 个 UTF-16 单元的合法路径（单段、无点、无冒号） */
function paddedPath(length: number): string {
  return "a".repeat(length);
}

/** 构造恰好 `depth` 段的合法路径 */
function deepPath(depth: number): string {
  return Array.from({ length: depth }, (_, i) => `d${i}`).join("/");
}

describe("logical-path：工具输入规范化", () => {
  it("反斜杠一律换成 /（含混合与连续）", () => {
    expect(normalizeLogicalPath("dir\\a.txt")).toBe("dir/a.txt");
    expect(normalizeLogicalPath("dir\\sub\\a.txt")).toBe("dir/sub/a.txt");
    expect(normalizeLogicalPath("a\\/b")).toBe("a//b");
    expect(normalizeLogicalPath("a.txt")).toBe("a.txt");
  });

  it("规范化只做分隔符，不折叠点段、不去尾随空格、不折大小写", () => {
    expect(normalizeLogicalPath("dir/..\\a.txt")).toBe("dir/../a.txt");
    expect(normalizeLogicalPath("a.txt ")).toBe("a.txt ");
    expect(normalizeLogicalPath("A.TXT")).toBe("A.TXT");
  });

  it("规范化不等于放行：UNC 与盘符路径规范化后仍被拒", () => {
    // 工具入口的两步：先规范化，再校验——少了第二步，`\\server\share` 会变成合法的相对路径形状
    expect(findLogicalPathViolation(normalizeLogicalPath("\\\\server\\share\\a.txt"))).toContain(
      "UNC",
    );
    expect(findLogicalPathViolation(normalizeLogicalPath("\\\\?\\C:\\a.txt"))).toContain("UNC");
    expect(findLogicalPathViolation(normalizeLogicalPath("C:\\a.txt"))).toContain("冒号");
    expect(findLogicalPathViolation(normalizeLogicalPath("dir\\sub\\a.txt"))).toBeNull();
  });
});

describe("logical-path：合法形式", () => {
  it("普通相对路径通过（含中文、空格、隐藏名与深层）", () => {
    expect(findLogicalPathViolation("a.txt")).toBeNull();
    expect(findLogicalPathViolation("dir/sub/b.md")).toBeNull();
    expect(findLogicalPathViolation("配置/说明.md")).toBeNull();
    expect(findLogicalPathViolation("a b/c-d_e.txt")).toBeNull();
    expect(findLogicalPathViolation(".gitignore")).toBeNull();
    expect(findLogicalPathViolation(".git/config")).toBeNull();
    expect(findLogicalPathViolation("带 空 格/名 称.txt")).toBeNull();
  });

  it("长度与深度等于上限时合法（边界含在内）", () => {
    const longOk = `${paddedPath(MAX_LOGICAL_PATH_LENGTH - 2)}/x`; // 恰好 512 单元
    expect(longOk.length).toBe(MAX_LOGICAL_PATH_LENGTH);
    expect(findLogicalPathViolation(longOk)).toBeNull();
    expect(findLogicalPathViolation(deepPath(MAX_LOGICAL_PATH_DEPTH))).toBeNull();
  });

  it("长度按 UTF-16 代码单元算：代理对按 2 计、中文字按 1 计（不按字节）", () => {
    const emoji = "🀄"; // 非 BMP，占 2 个 UTF-16 单元
    expect(emoji.length).toBe(2);
    expect(findLogicalPathViolation(emoji.repeat(MAX_LOGICAL_PATH_LENGTH / 2))).toBeNull();
    expect(findLogicalPathViolation(emoji.repeat(MAX_LOGICAL_PATH_LENGTH / 2 + 1))).toContain(
      "长度超过上限",
    );

    // 512 个中文字 = 512 单元，但 UTF-8 下是 1536 字节；按字节判会误拒合法路径
    const cjk = "字".repeat(MAX_LOGICAL_PATH_LENGTH);
    expect(cjk.length).toBe(MAX_LOGICAL_PATH_LENGTH);
    expect(Buffer.byteLength(cjk, "utf8")).toBe(1536);
    expect(findLogicalPathViolation(cjk)).toBeNull();
    expect(findLogicalPathViolation("字".repeat(MAX_LOGICAL_PATH_LENGTH + 1))).toContain(
      "长度超过上限",
    );
  });
});

describe("logical-path：结构与上限", () => {
  it("空、超长、超深分别被拒", () => {
    expect(findLogicalPathViolation("")).toContain("不得为空");
    expect(findLogicalPathViolation(paddedPath(MAX_LOGICAL_PATH_LENGTH + 1))).toContain(
      "长度超过上限",
    );
    expect(findLogicalPathViolation(deepPath(MAX_LOGICAL_PATH_DEPTH + 1))).toContain(
      "段数超过上限",
    );
    // 只多一段也必须拒——上限不是"建议值"
    expect(findLogicalPathViolation(`${deepPath(MAX_LOGICAL_PATH_DEPTH)}/x`)).toContain("33 段");
  });

  it("绝对路径、反斜杠、尾随斜杠分别被拒", () => {
    expect(findLogicalPathViolation("/etc/passwd")).toContain("相对路径");
    expect(findLogicalPathViolation("dir\\a.txt")).toContain("规范化为");
    expect(findLogicalPathViolation("dir/")).toContain("结尾");
  });

  it("空段、点段与 NUL 被拒", () => {
    expect(findLogicalPathViolation("dir//a.txt")).toContain("空段");
    expect(findLogicalPathViolation("./a.txt")).toContain("..");
    expect(findLogicalPathViolation("dir/../a.txt")).toContain("..");
    expect(findLogicalPathViolation("a\0b")).toContain("NUL");
  });

  it("报错原因只取决于路径本身（同一输入稳定报同一条）", () => {
    // 这条路径同时踩了长度与点段；固定顺序下应先报结构问题
    const both = `../${paddedPath(600)}`;
    expect(findLogicalPathViolation(both)).toContain("..");
    expect(findLogicalPathViolation(both)).toBe(findLogicalPathViolation(both));
  });
});

describe("logical-path：Windows 平台特性", () => {
  it("UNC 与设备前缀被拒（规范化后的 // 形式与裸反斜杠两种写法）", () => {
    expect(findLogicalPathViolation("//server/share/a.txt")).toContain("UNC");
    expect(findLogicalPathViolation("//?/C:/a.txt")).toContain("UNC");
    expect(findLogicalPathViolation("//./PhysicalDrive0")).toContain("UNC");
    // 未规范化的裸 UNC：先按"分隔符未规范化"拒绝（工具入口本应先规范化）
    expect(findLogicalPathViolation("\\\\server\\share\\a.txt")).toContain("规范化为");
  });

  it("盘符与 ADS（冒号）被拒", () => {
    expect(findLogicalPathViolation("C:/a.txt")).toContain("冒号");
    expect(findLogicalPathViolation("a.txt:ads")).toContain("冒号");
    expect(findLogicalPathViolation("dir/a.txt:stream")).toContain("冒号");
  });

  it("保留设备名被拒（任意层级、带扩展名、大小写不敏感）", () => {
    for (const path of [
      "CON",
      "con",
      "CON.txt",
      "dir/NUL",
      "dir/sub/PRN.log",
      "AUX",
      "COM1",
      "lpt9.txt",
      "CONIN$",
      "CONOUT$.txt",
    ]) {
      expect(findLogicalPathViolation(path), path).toContain("保留设备名");
    }
  });

  it("非保留名字放行（避免过度收紧）", () => {
    for (const path of ["CONSOLE", "console.txt", "COM10", "LPT10", "COM0", "myCON", "a.NUL"]) {
      expect(findLogicalPathViolation(path), path).toBeNull();
    }
  });

  it("尾随点或空格被拒（Windows 会静默改写）", () => {
    for (const path of ["a.txt.", "dir /a.txt", "a.txt ", "...", "dir/a. "]) {
      expect(findLogicalPathViolation(path), path).toContain("结尾");
    }
    // 前导点/空格不是问题（只有尾随会被改写）
    expect(findLogicalPathViolation(" a.txt")).toBeNull();
  });
});

describe("logical-path：NFC 与大小写碰撞", () => {
  it("碰撞键做 NFC 规范化与小写折叠，不改写显示路径", () => {
    expect(logicalPathCollisionKey("A.txt")).toBe(logicalPathCollisionKey("a.txt"));
    expect(logicalPathCollisionKey("dir/A.TXT")).toBe(logicalPathCollisionKey("DIR/a.txt"));
    // U+00E9 与 "e" + U+0301 是同一个字形的两种编码
    expect(logicalPathCollisionKey("caf\u00e9.txt")).toBe(
      logicalPathCollisionKey("cafe\u0301.txt"),
    );
    expect(logicalPathCollisionKey("A.txt")).toBe("a.txt"); // 折叠只发生在键上
  });

  it("大小写与 NFC 等价被判碰撞", () => {
    expect(findLogicalPathCollisionViolation(["a.txt"])).toBeNull();
    expect(findLogicalPathCollisionViolation(["A.txt", "a.txt"])).toContain("碰撞");
    expect(findLogicalPathCollisionViolation(["dir/A.txt", "DIR/a.TXT"])).toContain("碰撞");
    expect(findLogicalPathCollisionViolation(["caf\u00e9.txt", "cafe\u0301.txt"])).toContain(
      "碰撞",
    );
  });

  it("完全相同的一条报「重复」，且报先出现的那条", () => {
    expect(findLogicalPathCollisionViolation(["a.txt", "a.txt"])).toContain("重复路径");
    // 顺序换了，报出的第一条与第二条也跟着换
    const message = findLogicalPathCollisionViolation(["dir/A.txt", "DIR/a.txt"]);
    expect(message).toContain("dir/A.txt");
    expect(message).toContain("DIR/a.txt");
  });

  it("不同路径不算碰撞", () => {
    expect(findLogicalPathCollisionViolation(["a.txt", "ab.txt", "a/b.txt"])).toBeNull();
    expect(findLogicalPathCollisionViolation(["e.txt", "\u00e9.txt"])).toBeNull();
    expect(findLogicalPathCollisionViolation([])).toBeNull();
  });
});
