import { type ReactNode, type RefObject, useEffect, useRef } from "react";

/**
 * U3 任务 5.1（design D7）：小型原生模态包装。
 *
 * 关键点：
 * - **真 top layer**：打开时调 `dialog.showModal()`（不是静态 `open` 属性）——
 *   获得原生模态语义：背景 inert、浏览器级焦点禁闭（Tab/Shift+Tab 天然不出层）、
 *   Esc 只命中**最上层**模态（native cancel 事件按 top layer 栈分发）；
 * - **Esc 层级**：Monaco 内部弹层对 Esc 的 keydown 会 preventDefault，Chromium
 *   据此抑制 dialog 的 cancel ⇒ 弹层先消费、第二次 Esc 才关闭模态（D7「Esc 先由
 *   最上层可关闭界面消费」）；本组件的 cancel 处理器转为 onClose；
 * - **焦点**：打开时聚焦 `initialFocusRef`（缺省第一个可见可用控件），关闭/卸载时
 *   把焦点还给打开前的元素；触发节点已卸载时回退 `[data-modal-focus-fallback]`
 *   （全局栏入口，始终在文档中）；
 * - **关闭锁**：`closeDisabled`（创建执行中/目录选择中的 modalLocked）时 Esc/取消
 *   只被吞掉，不触发 onClose——焦点修复不能绕过关闭锁；
 * - 无 jsdom ⇒ 行为验证归 §6 CDP 实机；本组件保持零 store 依赖（纯展示容器），
 *   源码级契约测试钉住 showModal/closeDisabled/焦点恢复接线。
 */

/** 可聚焦元素选择器（首个可见可用控件作为缺省初始焦点） */
const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * 在容器内找第一个**可见**可聚焦元素（纯函数，可注入桩根做单测）。
 * 选择器已排除 disabled/[tabindex=-1]；这里再按 offsetParent 判可见性
 * （display:none 的祖先使其为 null）——收起分区里的控件不作为初始焦点。
 * disabled 与可见性在函数内复核一次（对真实 DOM 冗余无害，且可在无 jsdom 下直测）。
 */
export function firstFocusableOf(root: {
  querySelectorAll: (sel: string) => ArrayLike<HTMLElement>;
}): HTMLElement | null {
  for (const el of Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR))) {
    if ((el as HTMLButtonElement).disabled === true) continue;
    if (el.offsetParent === null) continue;
    return el;
  }
  return null;
}

export interface ModalDialogProps {
  /** 受控开关：true 时进入 top layer，false/卸载时退出并恢复焦点 */
  open: boolean;
  /** 关闭请求（Esc / 取消）；closeDisabled 时不会被调用 */
  onClose: () => void;
  ariaLabel: string;
  /** true = 忙碌/锁定：Esc 与取消事件被吞掉，不触发 onClose */
  closeDisabled?: boolean;
  /** 打开时聚焦的元素；缺省取第一个可见可用控件 */
  initialFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
  /** 附加到 <dialog> 的尺寸类（模态自身在 top layer 居中，无需外层定位容器） */
  className?: string;
}

export function ModalDialog({
  open,
  onClose,
  ariaLabel,
  closeDisabled = false,
  initialFocusRef,
  children,
  className = "",
}: ModalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  // onClose/closeDisabled 的最新值经 ref 供 cancel 处理器读取（native 事件不重挂）
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeDisabledRef = useRef(closeDisabled);
  closeDisabledRef.current = closeDisabled;
  // biome useExhaustiveDependencies：ref.current 在 render 期取出作为依赖，
  // 元素稳定时不变（正是期望的重开聚焦语义）
  const initialFocus = initialFocusRef?.current ?? null;

  useEffect(() => {
    const el = dialogRef.current;
    if (el === null || !open) return;
    const previouslyFocused = document.activeElement;
    if (!el.open) {
      el.showModal();
      const target = initialFocus ?? firstFocusableOf(el);
      target?.focus();
    }
    return () => {
      if (el.open) el.close();
      // 焦点恢复：触发元素仍在文档中还给触发元素；否则回退到全局栏入口
      const fallback =
        previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected
          ? previouslyFocused
          : document.querySelector<HTMLElement>("[data-modal-focus-fallback]");
      fallback?.focus();
    };
  }, [open, initialFocus]);

  return (
    <dialog
      ref={dialogRef}
      aria-label={ariaLabel}
      onCancel={(e) => {
        // Esc 命中最上层模态且未被 Monaco 弹层消费时到达这里；
        // 关闭锁期间只吞掉（preventDefault + 不关），焦点修复不能绕过
        e.preventDefault();
        if (!closeDisabledRef.current) onCloseRef.current();
      }}
      // top layer 居中由 UA `dialog:modal { margin:auto; position:fixed }` 完成；
      // 遮罩用原生 ::backdrop（Tailwind backdrop: 变体）
      className={`m-auto max-w-full rounded-lg border border-gray-200 bg-white shadow-xl backdrop:bg-black/20 ${className}`}
    >
      {children}
    </dialog>
  );
}
