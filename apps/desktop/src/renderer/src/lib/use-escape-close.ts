import { useEffect, useRef } from "react";

/**
 * U3 任务 6.10（design D7）：Esc 收起当前打开的编辑区。
 *
 * 层级纪律（spec「Esc 只关闭最上层并恢复焦点」+「关闭编辑…保留输入」）：
 * 1. **有真模态在场不消费**——`dialog:modal`（创建/设置/放弃确认）在场时 Esc 属
 *    模态栈语义，一次按键不能同时关掉放弃确认和底层编辑器；
 * 2. **Monaco 内部弹层优先消费**——弹层处理 Esc 时对 keydown `preventDefault`
 *    （或 stopPropagation 使本监听根本不触发）⇒ `defaultPrevented` 即让位；
 * 3. **多个编辑区同开只关最近打开的一个**——模块级 token 栈，栈顶消费
 *    （prompt 与 A/B 编辑器可并存，逐层收起而非一键全关）；
 * 4. 收起与「取消/收起」按钮同动作（`setOpen(false)` + 各自的 reset），
 *    **不等于放弃**——草稿保留在 store，重开原样恢复。
 *
 * 无 jsdom ⇒ `shouldEscapeClose` 是纯判据（单测直测），DOM 接线归源码契约 + §6 实机。
 */

/** 判据纯函数：四个条件全满足才由本编辑区消费本次 Esc */
export function shouldEscapeClose(ctx: {
  key: string;
  defaultPrevented: boolean;
  modalPresent: boolean;
  isTopmost: boolean;
}): boolean {
  return ctx.key === "Escape" && !ctx.defaultPrevented && !ctx.modalPresent && ctx.isTopmost;
}

/** 已注册（打开中）编辑区的 Esc 消费栈，后打开者栈顶 */
const escapeCloseStack: symbol[] = [];

/**
 * @param active 编辑区打开且可关闭（进行中/冻结时传 false，与收起按钮 disabled 同源）
 * @param onClose 与「取消/收起」按钮完全相同的收起动作（保留草稿）
 */
export function useEscapeClose(active: boolean, onClose: () => void): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!active) return;
    const token = Symbol("escape-close");
    escapeCloseStack.push(token);
    const onKey = (e: KeyboardEvent): void => {
      if (
        !shouldEscapeClose({
          key: e.key,
          defaultPrevented: e.defaultPrevented,
          modalPresent: document.querySelector("dialog:modal") !== null,
          isTopmost: escapeCloseStack[escapeCloseStack.length - 1] === token,
        })
      ) {
        return;
      }
      e.preventDefault();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const i = escapeCloseStack.indexOf(token);
      if (i >= 0) escapeCloseStack.splice(i, 1);
    };
  }, [active]);
}
