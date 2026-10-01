import type { EntryGate } from "../lib/entry-gate";

/**
 * U4 任务 4.3/4.4：门禁理由的可见说明（四个执行入口共用）。
 * 只把按钮置灰 = 死按钮；spec「操作入口在窄窗口和键盘下可达」要求"为什么不能提交"读得到。
 *
 * ⚠️ U8 3.1（2026-10-01）自 DetailPanel 原样搬出（ModelAbEditor 提取到独立文件时，
 * 共用的展示组件随迁；判据与渲染零改动）。
 */
export function EntryGateNotice({ gate }: { gate: EntryGate }) {
  return gate.notice !== null ? (
    <div data-testid="entry-gate-notice" className="mt-1 text-[11px] leading-4 text-amber-700">
      {gate.notice}
    </div>
  ) : null;
}
