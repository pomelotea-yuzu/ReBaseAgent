# 场景与证据索引

本次实现先于提案补建；尚未归档或发布。表中只认当前工作树的验证，既有 change 的验收不冒充本次回归。截图、日志、原始测量位于本地忽略目录 `output/ui-header-review/`，几何结果与限制记录在 `docs/reviews/2026-10-10-workspace-header-layout.md`；归档前需整理可保留的证据。

| 场景 | 本次证据 | 状态与限制 |
| --- | --- | --- |
| 普通文件页正文获得可见高度 | after-files-final.png，复查记录：edit.txt diff 高 391.53px；`r_03` config.json 样本经 app 只读导航检查；比较侧文件返回状态由 `openCompareSideFiles("left")` → `returnToCompare()` 复核 | 通过；正常文件页正文约占视口 55% |
| 页头把对象摘要与操作分区 | after-messages-sidebar.png、after-tool-edit.png、after-files-final.png、after-output-diff.png；`review-cdp.cjs` 真实 DOM 检查 | 通过；P2 控件已统一为 Disclosure/可见焦点 |
| 原值与草稿按容器适配 | messages-800.png、messages-640.png；`review-resizer-checks.json` | 通过；键盘步进 +24px、真实拖拽 +40px |
| 原值折叠不覆盖草稿 | keyboard-checks.json；真实 Input.insertText 后折叠和往返比较 text/revision | 通过 messages；共享布局其他调用方仍需补验 |
| 原值收起后仍可恢复核对 | keyboard-checks.json 的恢复入口和往返检查 | 通过 messages；纯键盘展开/收起尚未本轮重验 |
| 窄窗口上下排列且正文可达 | messages-640.png、keyboard-checks.json 无水平溢出 | 通过 messages；其他工作区窄窗操作需补验 |
| 窄窗口和缩放不压缩字号 | 真实约 1020、800、640 CSS px 窗口；`u5-68/zoom-probe.cjs` 真 `REBASEAGENT_ZOOM_FACTOR=2` 读数 605×356、DPR 4.2 | 通过；未使用 Emulation 伪造布局 |
| 只读差异保持只读 | 文件/输出截图、desktop 全量测试、复制菜单键盘焦点样式与菜单收起实现核对 | 通过；无替换/回写入口 |
| 专注模式保留身份并恢复布局 | `workspace-focus-mode` 测试、既有 `kb43-focus` 实机记录 | 通过；手动偏好不被临时专注覆盖 |
| 专注切换目标与主动调整有明确归属 | `workspace-focus-mode` 测试、既有 `kb43-focus` 实机记录 | 通过；目标变化解除旧专注、主动调整不回滚 |
| 紧凑页头操作不改变执行边界 | keyboard-checks.json：说明、原值与录制往返保留目标/正文/修订；未提交模型请求 | 已验证上述路径；确认门禁的其他场景仍需补验 |
| 长草稿切换不丢输入和目标 | `review-draft-messages-draft-0.json`、`-2.json`：空串、尾随空白、中文/日文、多行非法 JSON；折叠、往返、光标/滚动/target/revision | 通过 messages；目标与草稿逐字保留，长文本滚动恢复修复已回归 |

## 任务对应

- tasks 1–2：页头把对象摘要与操作分区、紧凑页头操作不改变执行边界。
- task 3：普通文件页正文获得可见高度、原值与草稿按容器适配、窄窗口上下排列且正文可达、只读差异保持只读。
- task 4：原值折叠不覆盖草稿、原值收起后仍可恢复核对、长草稿切换不丢输入和目标。
- tasks 5–7：全量桌面自动回归、上述真实交互证据及 OpenSpec 校验。
- tasks 8–9：独立 200% 真缩放、长文本光标/滚动、原值拖拽/键盘、来源身份和控件语义复核，以及全仓质量门禁。

## 当前检查

- desktop：198 个测试文件、3088 项通过；typecheck、构建及修改文件 Biome 检查通过。
- `pnpm check:spec`：14 项通过，包括本 change、R2.1 change 与 12 个主 spec。
- `pnpm check:ci`：通过（check:build、typecheck、198 文件/3088 测试、Biome、check:spec）。受控 SSE 首次遇到随机端口错误，单测重跑通过；最终全链路通过。
