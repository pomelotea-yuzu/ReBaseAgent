# 实施任务

> 本 change 在实现之后补建，如实记录顺序，不表示已走完提案评审。每项控制在 2 小时以内；场景与证据对应关系见 evidence-index.md。

- [x] 1. 新增共享 `WorkspaceHeading`，以两行 grid 承载对象、摘要、操作和可展开详情，并为窄容器提供单列布局。
- [x] 2. 将重跑、工具编辑、文件页和比较页的操作/来源/显示控制接入页头，移除重复说明。
- [x] 3. 调整编辑器、文件 diff、输出 diff 的高度链、标签对齐和窄窗布局，保留只读身份与异常摘要。
- [x] 4. 为原值、草稿和调整手柄设置稳定 React key，验证折叠/恢复与页面往返不覆盖草稿。
- [x] 5. 更新受影响的静态接线测试，并运行 desktop 全量测试、typecheck、Biome、构建和 diff 检查。
- [x] 6. 用真实 Electron/CDP 窗口验证中文/日文/非法 JSON 输入、详情展开、原值折叠/恢复、录制往返、目标保持和无水平溢出。
- [x] 7. 补齐 proposal、design、delta 和场景证据索引，运行 `pnpm check:spec`。
- [x] 8. 对照既有全部场景补验未覆盖路径，包括独立 200% 缩放、专注偏好恢复、长文本光标/滚动、config.json 比较返回以及新增复制菜单的纯键盘焦点。（见证据索引）
- [x] 9. 完成当前改动的 `pnpm check:ci` 全链路门禁，完成评审后再归档；桌面单包测试和构建不替代全仓质量门禁。

## 证据

- `docs/reviews/2026-10-10-workspace-header-layout.md`
- `output/ui-header-review/desktop-tests.log`
- `output/ui-header-review/desktop-build.log`
- `output/ui-header-review/keyboard-checks.json`
- `output/ui-header-review/after-messages-sidebar.png`
- `output/ui-header-review/after-files-final.png`
- `output/ui-header-review/after-output-diff.png`
