import { type ReactNode, type RefObject, useEffect, useRef } from "react";

/**
 * U3 任务 5.1（design D7）：小型原生模态包装。
 *
 * 关键点：
 * - **真 top layer**：打开时调 `dialog.showModal()`（不是静态 `open` 属性）——
 *   获得原生模态语义：背景 inert、浏览器级焦点禁闭（Tab/Shift+Tab 天然不出层）、
 *   Esc 只命中**最上层**模态（native cancel 事件按 top layer 栈分发）；
 * - **Esc 层级**：Esc 关闭由 keydown 捕获段**合成**（见下方 onKeyCapture）——最上层模态
 *   preventDefault 压掉原生 cancel 通道后调 onClose。Chromium 的原生 cancel 只能防第一次
 *   Esc，第二次以 cancelable:false 派发（6.7 实机坐实会穿透叠层直关底层模态）；合成路径
 *   对第任意次都成立。本组件的 cancel 处理器保留为非键盘关闭的兜底；
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: 初始焦点须在 effect 执行时读 ref——render 期快照进依赖数组会让首帧后 null→元素 漂移重跑 cleanup 的 el.close()，绕过 busy 关闭锁（6.10 实机坐实）
  useEffect(() => {
    const el = dialogRef.current;
    if (el === null || !open) return;
    const previouslyFocused = document.activeElement;
    // Esc→cancel 的处理**不走 React onCancel 委托**：6.10 实机坐实 React 挂在该
    // dialog 元素上的 cancel 监听只在第一次 Esc 生效，第二次事件到达但处理器不再
    // 运行（preventDefault 缺席 ⇒ 原生默认直接关闭对话框）⇒ busy 关闭锁被绕过。
    // 手动绑定到 dialog 元素本身，与 open 生命周期严格同挂同卸，行为确定。
    const onCancel = (e: Event): void => {
      e.preventDefault();
      if (!closeDisabledRef.current) onCloseRef.current();
    };
    el.addEventListener("cancel", onCancel);
    // 关闭锁的**主拦截点是 keydown**：6.10 实机坐实 Chromium 对模态框的 Esc 是
    // 「两步关闭」——第一次 cancel 可被 preventDefault，第二次 cancel 以
    // cancelable:false 派发（处理器里的 preventDefault 完全无效）⇒ 只在 cancel
    // 上吞一次必然被第二次 Esc 绕过。
    // U5 6.7 实机坐实（叠层场景）：脏设置 + 确认框在上时，第二次 Esc 经两步关闭
    // **直接关掉了底层设置**（未保存输入被静默丢弃，M6.2「Esc 只关闭最上层」被穿透）
    // —— cancel 上的防御只保得了第一次。因此最上层模态在 keydown 捕获段**合成**
    // Esc 关闭：preventDefault 压掉原生 cancel 通道（第任意次都成立），未锁时调
    // onClose；非最上层时放行（上层的捕获监听会处理，底层不得越权）。
    const onKeyCapture = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      const modals = document.querySelectorAll("dialog:modal");
      const isTopmost = modals[modals.length - 1] === el;
      if (!isTopmost) return;
      e.preventDefault();
      e.stopPropagation();
      if (!closeDisabledRef.current) onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyCapture, true);
    if (!el.open) {
      el.showModal();
      // 初始焦点在**effect 执行时**读 ref（不是 render 期快照）：ConfirmDialog 的
      // cancelRef.current 首帧后才有值——放进依赖数组会让 null→元素 的漂移触发
      // effect 重跑、cleanup 对仍在场的模态 el.close()。重开时新 initialFocusRef
      // 由对话框整体重挂载路径承担（CreateRunDialog 即如此），不依赖本 effect 重跑。
      const target = initialFocusRef?.current ?? firstFocusableOf(el);
      target?.focus();
    }
    return () => {
      el.removeEventListener("cancel", onCancel);
      document.removeEventListener("keydown", onKeyCapture, true);
      if (el.open) el.close();
      // 焦点恢复：触发元素仍在文档中还给触发元素；否则回退到全局栏入口
      const fallback =
        previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected
          ? previouslyFocused
          : document.querySelector<HTMLElement>("[data-modal-focus-fallback]");
      fallback?.focus();
    };
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-label={ariaLabel}
      // top layer 居中由 UA `dialog:modal { margin:auto; position:fixed }` 完成；
      // 遮罩用原生 ::backdrop（Tailwind backdrop: 变体）。
      // UI 密度 3.3（design D5「长确认可滚动且操作可达」）：默认限高 85vh 内滚动，
      // 放弃确认（对比确认弹窗）以 40% 遮罩可辨——行为（showModal/cancel/Esc 合成/
      // 关闭锁/焦点恢复）不变。
      className={`m-auto max-h-[85vh] max-w-full overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-xl backdrop:bg-black/40 ${className}`}
    >
      {children}
    </dialog>
  );
}
