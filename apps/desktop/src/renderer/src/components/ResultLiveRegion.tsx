import { deriveResultNotices } from "../lib/result-notices";
import { useAppStore } from "../store";

/**
 * U5（unify-run-execution-workflow）任务 5.2：**全局结果通知区**（`aria-live="polite"`）。
 *
 * design D6 + delta「恢复核对重试与批次结果只通知」：通知区域**独立于操作面板**——
 * 面板收起时它仍在可访问的全局外壳里；结果从"待读取"变成"可查看/不可读"时更新文本，
 * 重复快照与等待计时都不进这里（3.6 的两层去重 + 判据本身不含时长）。
 *
 * 三条刻意的"不做"：
 * 1. 不强制聚焦、不弹模态——`sr-only` 静态区域，视觉零打扰；
 * 2. 不消费任何执行通道——它只派生文本，核对/重试/导航都与它无关；
 * 3. 关闭通知 ≠ 删除登记——文本随"看过"清空，main 登记原样不动（面板的✕同理，
 *    见 `OperationsEntry` 的关闭判据）。
 */

/** 纯视图（本包无 jsdom ⇒ 喂 props 断言可访问性属性；区域**恒渲染**，空文本时也不卸载） */
export function ResultLiveRegionView({ text }: { text: string | null }) {
  // `<output>` 的隐式 role=status + polite live region（biome useSemanticElements 的正解），
  // 显式属性照写——spec 认的是"aria-live=polite 的可访问区域"，不是元素名
  return (
    <output id="result-live" aria-live="polite" className="sr-only">
      {text ?? ""}
    </output>
  );
}

export function ResultLiveRegion() {
  const session = useAppStore((s) => s.operations);
  const reads = useAppStore((s) => s.resultReads);
  const seenNoticeKeys = useAppStore((s) => s.seenNoticeKeys);
  // 与面板徽标**同一份派生**（lib/result-notices）：两处各算一套必然分叉
  const notices = deriveResultNotices({
    records: session.operations,
    reads,
    seenKeys: seenNoticeKeys,
  });
  return <ResultLiveRegionView text={notices.liveText} />;
}
