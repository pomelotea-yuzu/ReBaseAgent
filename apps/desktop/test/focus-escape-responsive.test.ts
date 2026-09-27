import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * U5（unify-run-execution-workflow）任务 5.6：**焦点/层级接线 + 高度钳制 + 过渡注释清理**。
 *
 * 判据来源：delta「执行流程在窄窗口与键盘下连续可用」之「创建页面键盘可离开而模态约束焦点」
 * 「Esc 只关闭最上层并恢复焦点」（本仓既有 `shouldEscapeClose` 层级判据与 ModalDialog 的
 * top-layer 语义由 U3 交付，本项只钉**新接线**）与「长任务路径模型与结果不遮挡操作」中
 * **代码可达的部分**（容器高度/宽度钳制；代表宽度与 200% 缩放的实测归 §6.8）。
 * 过渡注释清理：`待 U5 接入…` 这类"以后会有"的旧文案在 §3/5.1 接线后必须消失（HANDOFF §九④
 * 登记的滞后 UI 文案在本项销账）。
 */

const SRC_DIR = resolve(import.meta.dirname, "../src/renderer/src");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });

const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

const read = (rel: string): string =>
  stripComments(readFileSync(resolve(import.meta.dirname, rel), "utf8"));

describe("5.6 操作面板 Esc/✕：复用层级判据，不本地重造", () => {
  it("面板走共享 useEscapeClose(open, closePanel)；✕ 与 Esc 同一关闭动作", () => {
    const src = read("../src/renderer/src/components/OperationsEntry.tsx");
    expect(src).toContain("useEscapeClose(open, closePanel)");
    expect(src.match(/onClick=\{closePanel\}/g)?.length).toBeGreaterThanOrEqual(1);
    // 层级判据不重造：组件里不出现 dialog:modal / Escape 的本地比较
    expect(src).not.toContain("dialog:modal");
    expect(src).not.toContain('"Escape"');
  });
});

describe("5.6 高度钳制：面板与设置模态不撑破视口", () => {
  it("操作面板 max-h 按视口比例钳制 + 横向不超 90vw", () => {
    const src = read("../src/renderer/src/components/OperationsEntry.tsx");
    expect(src).toContain("max-h-[min(70vh,24rem)]");
    expect(src).toContain("max-w-[90vw]");
  });

  it("设置模态受 85vh 钳制并内部滚动（长表单/200% 缩放在框内滚，不撑破屏幕）", () => {
    const src = read("../src/renderer/src/components/SettingsDialog.tsx");
    expect(src).toContain("max-h-[85vh]");
    expect(src).toContain("overflow-y-auto");
  });
});

describe("5.6 过渡注释销账", () => {
  it("渲染层不再残留「待 U5 接入…」式滞后文案（目标已交付）", () => {
    const offenders = walk(SRC_DIR)
      .filter((file) => readFileSync(file, "utf8").includes("待 U5"))
      .map((file) => file.replace(SRC_DIR, ""));
    expect(offenders).toEqual([]);
  });

  it("冻结通报改说现行判据：核实到正常结束 + 修订逐字相同才自动清理", () => {
    const src = read("../src/renderer/src/components/DetailPanel.tsx");
    expect(src).toContain("且草稿修订与提交时逐字相同，才自动清理");
  });
});
