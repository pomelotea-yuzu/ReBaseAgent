import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store";
import { api } from "./api";
import { DraftCloseClient } from "./draft-close-client";
import { dirtyCountOf } from "./draft-list";

/**
 * U3 任务 4.2 / 4.3：关闭协商的 React 接线。
 *
 * 职责：
 * - 挂载 `DraftCloseClient`（握手 + 订阅查询/释放）并订阅 store 的 drafts 变化
 *   驱动 dirty 上报；
 * - 锁定期间：全文档捕获阻止新编辑/粘贴/拖放（**不缓冲不重放**，D6），阻止释放
 *   时把焦点还给锁前元素；
 * - 任务 4.3：跟踪输入法组合状态——组合进行中 `isInputSettled()=false`
 *   （不得冒充 clean）；锁前组合的**尾随事件放行**（可收尾、不可开启新编辑）；
 * - 返回锁状态，供 App 渲染 `DraftCloseLockOverlay`（挡住指针交互）。
 *
 * 输入同步（D6 顺序第 2 步的 flush）：§2 起四个编辑器已在**变更事件**把输入同步
 * 写进 store（无 debounce / 无失焦依赖），锁前组合已进入 model 的文字同样随变更
 * 事件入 store——flush 本身是收口点，不需要额外的文本搬运。
 */
export function useDraftCloseGuard(): boolean {
  const [locked, setLocked] = useState(false);
  /** 是否有进行中的输入法组合（任务 4.3）；document 捕获跟踪，不用 React 状态 */
  const composingRef = useRef(false);
  const clientRef = useRef<DraftCloseClient | null>(null);
  if (clientRef.current === null) {
    clientRef.current = new DraftCloseClient({
      api,
      getDirtyCount: () => dirtyCountOf(useAppStore.getState().drafts),
      flushInputs: () => {
        // 变更事件已同步（见文件头注释）；组合中已进入 model 的文字同在 store
      },
      isInputSettled: () => !composingRef.current,
      onLockChange: setLocked,
    });
  }

  useEffect(() => {
    const client = clientRef.current;
    if (client === null) return;
    client.start();
    // zustand 订阅：drafts 变化 → 上报 dirty 元数据（值未变时客户端内部去重）
    const unsub = useAppStore.subscribe(() => {
      client.reportDirtyIfChanged();
    });
    return () => {
      unsub();
      client.stop();
    };
  }, []);

  // 任务 4.3：document 捕获跟踪输入法组合（compositionstart/end 都冒泡）
  useEffect(() => {
    const onStart = (): void => {
      composingRef.current = true;
    };
    const onEnd = (): void => {
      composingRef.current = false;
    };
    const options: AddEventListenerOptions = { capture: true };
    document.addEventListener("compositionstart", onStart, options);
    document.addEventListener("compositionend", onEnd, options);
    return () => {
      document.removeEventListener("compositionstart", onStart, options);
      document.removeEventListener("compositionend", onEnd, options);
    };
  }, []);

  // 锁定期间：document 捕获阶段阻止一切会产生新输入的事件（不缓冲不重放）。
  // ⚠️ 只阻止**可取消**的事件：输入法组合驱动的 beforeinput/insertCompositionText
  // 不可取消（Chromium 规范行为），放行它们=允许锁前组合的尾随收尾（D6）；
  // 组合收尾不是"新的编辑动作"——新键入的 keydown 是可取消事件、照拦。
  useEffect(() => {
    if (!locked) return;
    const prevFocus = document.activeElement;
    const block = (event: Event): void => {
      if (!event.cancelable) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const events = ["keydown", "keypress", "beforeinput", "paste", "drop", "dragstart"] as const;
    const options: AddEventListenerOptions = { capture: true };
    for (const type of events) {
      document.addEventListener(type, block, options);
    }
    return () => {
      for (const type of events) {
        document.removeEventListener(type, block, options);
      }
      // 解锁恢复焦点：锁前焦点元素仍在文档中才交还（可能已被导航卸载）
      if (prevFocus instanceof HTMLElement && prevFocus.isConnected) {
        prevFocus.focus();
      }
    };
  }, [locked]);

  return locked;
}
