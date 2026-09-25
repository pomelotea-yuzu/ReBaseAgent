import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { firstFocusableOf } from "../src/renderer/src/components/ModalDialog";

/**
 * U3 任务 5.1：小型原生模态包装（design D7）。
 *
 * 判据来源：tasks.md 5.1——「实现小型原生 dialog 模态包装，创建和设置接入
 * showModal、初始焦点及关闭恢复」。
 * 验收场景：
 * - 创建设置和放弃确认不泄漏焦点（初始焦点 + 关闭恢复 + 失效回退锚点）；
 * - 创建忙碌期间不能通过焦点修复绕过关闭锁（closeDisabled 接 modalLocked）。
 *
 * ⚠️ 本包无 jsdom ⇒ showModal/close 的运行时行为归 §6 CDP 实机；本组钉两件事：
 *   ① 纯函数能力（初始焦点的可见性判定）；
 *   ② 接线契约（源码级）：两个对话框必须经 ModalDialog 且不得再出现静态
 *      `<dialog open>`（那正是"非 top layer、无焦点禁闭"的旧形态）。
 */

describe("U3 5.1 firstFocusableOf：初始焦点的可见可用判定", () => {
  function fakeRoot(elements: Array<Partial<HTMLElement>>): {
    querySelectorAll: (sel: string) => ArrayLike<HTMLElement>;
  } {
    const lastSelector = { value: "" };
    const els = elements as HTMLElement[];
    return {
      querySelectorAll: (sel: string) => {
        lastSelector.value = sel;
        void lastSelector;
        return els.filter((el) => true);
      },
    };
  }

  it("跳过 disabled 与不可见（offsetParent null）元素，返回首个可见可用控件", () => {
    const hidden = { offsetParent: null } as Partial<HTMLElement> as HTMLElement;
    const disabled = { offsetParent: {}, disabled: true } as Partial<HTMLElement> as HTMLElement;
    const visible = { offsetParent: {} } as Partial<HTMLElement> as HTMLElement;
    expect(firstFocusableOf(fakeRoot([hidden, disabled, visible]))).toBe(visible);
  });

  it("全部不可用 ⇒ null（调用方安全降级到浏览器默认聚焦）", () => {
    const hidden = { offsetParent: null } as Partial<HTMLElement> as HTMLElement;
    expect(firstFocusableOf(fakeRoot([hidden]))).toBeNull();
  });

  it("选择器覆盖五类控件 + tabindex，排除 tabindex=-1", () => {
    let seen = "";
    const root = {
      querySelectorAll: (sel: string): ArrayLike<HTMLElement> => {
        seen = sel;
        return [];
      },
    };
    firstFocusableOf(root);
    expect(seen).toContain("button:not([disabled])");
    expect(seen).toContain("input:not([disabled])");
    expect(seen).toContain("textarea:not([disabled])");
    expect(seen).toContain("[tabindex]:not([tabindex='-1'])");
  });
});

describe("U3 5.1 接线契约（源码级）", () => {
  const R = (p: string): string => readFileSync(resolve(import.meta.dirname, p), "utf8");
  const create = R("../src/renderer/src/components/CreateRunDialog.tsx");
  const settings = R("../src/renderer/src/components/SettingsDialog.tsx");
  const modal = R("../src/renderer/src/components/ModalDialog.tsx");
  const globalBar = R("../src/renderer/src/components/GlobalBar.tsx");
  const lock = R("../src/renderer/src/lib/use-draft-close-guard.ts");

  it("创建/设置对话框经 ModalDialog，静态 <dialog open> 旧形态必须消失", () => {
    expect(create).toContain("<ModalDialog");
    expect(settings).toContain("<ModalDialog");
    for (const src of [create, settings]) {
      // 旧形态 = 无 top layer、无焦点禁闭（这正是要消灭的）
      expect(src).not.toMatch(/<dialog\b/);
      expect(src).not.toContain("fixed inset-0");
    }
  });

  it("创建对话框把 modalLocked 接到 closeDisabled；showModal 是唯一的打开方式", () => {
    expect(create).toContain("closeDisabled={modalLocked}");
    expect(modal).toContain("el.showModal()");
    // showModal 必须有 open 守卫（StrictMode 双调效果安全）
    expect(modal).toMatch(/if \(!el\.open\) \{\s*el\.showModal\(\)/);
    // 关闭锁：cancel 事件在 closeDisabled 时不调 onClose
    expect(modal).toContain("if (!closeDisabledRef.current) onCloseRef.current();");
  });

  it("焦点恢复与失效回退：打开前元素优先，回退锚点在全局栏", () => {
    expect(modal).toContain("previouslyFocused");
    expect(modal).toContain('querySelector<HTMLElement>("[data-modal-focus-fallback]")');
    expect(modal).toContain("fallback?.focus()");
    expect(globalBar).toContain("data-modal-focus-fallback");
  });

  it("设置对话框的手写 Esc 监听已被原生 cancel 取代", () => {
    expect(settings).not.toContain('e.key === "Escape"');
    expect(modal).toContain("onCancel=");
  });

  it("输入锁覆盖指针事件（top layer 逃过覆盖层，须捕获阶段拦截）", () => {
    expect(lock).toContain('"mousedown"');
    expect(lock).toContain('"click"');
    expect(lock).toContain('"auxclick"');
    expect(lock).toContain('"contextmenu"');
  });
});
