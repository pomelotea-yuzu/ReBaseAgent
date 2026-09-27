import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { firstFocusableOf } from "../src/renderer/src/components/ModalDialog";
import { auditForbiddenTokens } from "../src/renderer/src/lib/overview-view";
import { shouldEscapeClose } from "../src/renderer/src/lib/use-escape-close";

/**
 * U3 任务 5.1：小型原生模态包装（design D7）。
 *
 * 判据来源：tasks.md 5.1——「实现小型原生 dialog 模态包装，创建和设置接入
 * showModal、初始焦点及关闭恢复」。
 * 验收场景：
 * - 创建设置和放弃确认不泄漏焦点（初始焦点 + 关闭恢复 + 失效回退锚点）；
 * - 创建忙碌期间不能通过焦点修复绕过关闭锁（closeDisabled）
 *   ⚠️ U5 任务 4.1 起"创建"已迁出模态：这两条打在**仍在场的模态**（设置 / 放弃确认 /
 *   ModalDialog 本体）上，创建页一侧改钉"它不得做成模态"（见下方 4.1 那条）。
 *
 * ⚠️ 本包无 jsdom ⇒ showModal/close 的运行时行为归 §6 CDP 实机；本组钉两件事：
 *   ① 纯函数能力（初始焦点的可见性判定）；
 *   ② 接线契约（源码级）：两个对话框必须经 ModalDialog 且不得再出现静态
 *      `<dialog open>`（那正是"非 top layer、无焦点禁闭"的旧形态）。
 */

describe("U3 6.10 shouldEscapeClose：编辑区 Esc 的层级判据（纯函数）", () => {
  const ok = { key: "Escape", defaultPrevented: false, modalPresent: false, isTopmost: true };
  it("四条件全满足才消费", () => {
    expect(shouldEscapeClose(ok)).toBe(true);
  });
  it("非 Escape 键不消费", () => {
    expect(shouldEscapeClose({ ...ok, key: "Enter" })).toBe(false);
  });
  it("Monaco 弹层已消费（defaultPrevented）⇒ 编辑区让位", () => {
    expect(shouldEscapeClose({ ...ok, defaultPrevented: true })).toBe(false);
  });
  it("真模态在场（创建/设置/放弃确认）⇒ 一次按键不同时关确认与底层编辑区", () => {
    expect(shouldEscapeClose({ ...ok, modalPresent: true })).toBe(false);
  });
  it("非最近打开的编辑区不消费（prompt 与 A/B 并存逐层收起）", () => {
    expect(shouldEscapeClose({ ...ok, isTopmost: false })).toBe(false);
  });
});

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
  const create = R("../src/renderer/src/components/CreateRunWorkspace.tsx");
  const settings = R("../src/renderer/src/components/SettingsDialog.tsx");
  const modal = R("../src/renderer/src/components/ModalDialog.tsx");
  const globalBar = R("../src/renderer/src/components/GlobalBar.tsx");
  const lock = R("../src/renderer/src/lib/use-draft-close-guard.ts");

  it("设置对话框经 ModalDialog，静态 <dialog open> 旧形态必须消失", () => {
    expect(settings).toContain("<ModalDialog");
    // 旧形态 = 无 top layer、无焦点禁闭（这正是要消灭的）
    expect(settings).not.toMatch(/<dialog\b/);
    expect(settings).not.toContain("fixed inset-0");
  });

  it("U5 4.1：创建工作区已迁出模态——它盖不住阅读区，也不禁闭焦点", () => {
    // 旧形态（执行期间锁全窗的对话框）不得复活：App 的 `view === "create"` 分支挂页面。
    // ⚠️ 判据用剥注释的审计器：页面文档注释里要写"不再是 ModalDialog"，
    //    裸 not.toContain 会被自己的注释判红（ENGINEERING「判据假门清单」）。
    expect(auditForbiddenTokens(create, ["<ModalDialog", "showModal", "fixed inset-0"])).toEqual(
      [],
    );
    expect(create).not.toMatch(/<dialog\b/);
  });

  it("showModal 是模态唯一的打开方式，关闭锁由 cancel 吞掉", () => {
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

  it("设置对话框的手写 Esc 监听已被原生 cancel 取代（创建页不是模态，本就不该有）", () => {
    // U3 6.10：创建对话框残留的 window keydown Esc 与 cancel 双通道并存，
    // 嵌套放弃确认在场时一次按键同时关掉确认与创建对话框（违反 D7）⇒ 必须消失。
    // U5 4.1 起创建是页面：它不监听 Escape、也不关窗，这条判据原样落在页面源码上。
    expect(settings).not.toContain('e.key === "Escape"');
    expect(create).not.toContain('e.key === "Escape"');
    expect(create).not.toContain('window.addEventListener("keydown"');
    // U3 6.10：cancel 处理**不走 React 委托**（实机坐实 React 的 onCancel 监听
    // 第二次 Esc 不再运行 ⇒ busy 锁被绕）——必须手动绑定/解绑且与 open 同生命周期
    expect(modal).toContain('el.addEventListener("cancel", onCancel)');
    expect(modal).toContain('el.removeEventListener("cancel", onCancel)');
    expect(modal).not.toContain("onCancel=");
    // U3 6.10：Chromium「两步关闭」——第二次 Esc 的 cancel 以 cancelable:false 派发，
    // cancel 上 preventDefault 无效 ⇒ 关闭锁必须在 keydown 捕获阶段吃掉 Escape，
    // 且只在**本模态是最顶层 modal** 时拦（嵌套确认的 Esc 要放行）
    expect(modal).toContain('document.addEventListener("keydown", onKeyCapture, true)');
    expect(modal).toContain('document.removeEventListener("keydown", onKeyCapture, true)');
    expect(modal).toContain('if (e.key !== "Escape" || !closeDisabledRef.current) return;');
    expect(modal).toContain("modals[modals.length - 1] !== el");
  });

  it("输入锁覆盖指针事件（top layer 逃过覆盖层，须捕获阶段拦截）", () => {
    expect(lock).toContain('"mousedown"');
    expect(lock).toContain('"click"');
    expect(lock).toContain('"auxclick"');
    expect(lock).toContain('"contextmenu"');
  });

  it("U3 6.10：四个编辑区都接 useEscapeClose，且与收起按钮同动作（保留草稿）", () => {
    const panel = R("../src/renderer/src/components/DetailPanel.tsx");
    const hook = R("../src/renderer/src/lib/use-escape-close.ts");
    // 四编辑器各一处（result / prompt / messages / A-B）
    expect(panel.match(/useEscapeClose\(open && !inProgress/g)?.length).toBe(4);
    // 收起动作与按钮一致：不触碰 discard/删除草稿的 store 动作
    const escBlocks = panel.match(
      /useEscapeClose\(open && !inProgress, \(\) => \{\s*reset[A-Za-z]+\(\);\s*setOpen\(false\);\s*\}\);/g,
    );
    expect(escBlocks?.length).toBe(4);
    expect(panel).toContain('import { useEscapeClose } from "../lib/use-escape-close";');
    // 层级判据齐备：模态在场不消费、defaultPrevented 让位、栈顶才消费
    expect(hook).toContain('ctx.key === "Escape"');
    expect(hook).toContain("!ctx.defaultPrevented");
    expect(hook).toContain("!ctx.modalPresent");
    expect(hook).toContain("ctx.isTopmost");
    expect(hook).toContain('document.querySelector("dialog:modal")');
  });
});
