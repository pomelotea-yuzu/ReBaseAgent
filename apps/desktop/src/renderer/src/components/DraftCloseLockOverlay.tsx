/**
 * U3 任务 4.2：关闭核对期间的输入锁遮罩（纯展示组件）。
 *
 * 挡住指针交互（覆盖全文档），键盘与剪贴板由 `useDraftCloseGuard` 的 document
 * 捕获监听阻止——两层合起来才满足「锁期间禁止新编辑、粘贴、放弃和提交」。
 * 遮罩**不缓冲不重放**任何被挡住的输入（D6）。
 *
 * ⚠️ 导出供测试静态断言（本包无 jsdom）：必须是真实覆盖层，不是空 div。
 */
export function DraftCloseLockOverlay() {
  return (
    <div
      data-testid="draft-close-lock"
      aria-hidden="true"
      className="fixed inset-0 z-[200] cursor-not-allowed bg-transparent"
    />
  );
}
