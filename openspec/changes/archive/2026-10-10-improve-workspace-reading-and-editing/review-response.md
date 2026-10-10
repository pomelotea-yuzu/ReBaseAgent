# 首轮 review 修订处理记录

日期：2026-10-06。对应 [首轮独立 review](review.md)。原 review 保留审阅时的结论、数量与源码锚点；本文件记录后续修订，不替代新的独立复审或功能验收。

## 处理结果

| 意见 | 本次修订 | 对应文档与验收 |
| --- | --- | --- |
| evidence-index 粒度偏粗 | 改为每个精确 scenario 一行，列出所属 requirement、任务 ID、计划检查及证据路径/结果；合并回归另列，当前全部“待实施” | [evidence-index](evidence-index.md)，23 个场景逐项对应 [tasks](tasks.md) |
| 专注模式的状态存储未定位 | 在现有 useLayoutState 持有仅会话有效的 focus={mode,targetKey}，有效布局从原 prefs/阅读状态派生；不复制草稿/阅读状态，不保存退出时覆盖原值的偏好快照。目标变化/离开/卸载立即解除，返回不重入；主动调整辅助区先退出再经原 setter 更新，新偏好不被回滚 | [proposal](proposal.md)、[design D3](design.md)、[desktop-ui delta](specs/desktop-ui/spec.md)“专注模式保留目标草稿与阅读偏好”；新增“专注切换目标与主动调整有明确归属”，[tasks](tasks.md) 2.4a/2.4b/4.3 |
| 来源与工程技术详情可能出现两套控件 | 定义一个共享受控、可访问的 disclosure 组件/机制，统一键盘、aria-controls、展开与焦点语义；按现有目标阅读键持有状态，内容可不同但不另建阅读 store，也不重复同屏说明 | [design D2/D5](design.md)、[desktop-ui delta](specs/desktop-ui/spec.md)“技术元信息按需完整阅读”；[tasks](tasks.md) 1.3/1.5/3.4 |
| 窄窗/200% 缩放依赖真实环境 | 保留真实 1210×713、1024/800px 与独立 200% 缩放验收；索引逐场景写明真实宿主、实际输入/滚动/焦点和限制，Emulation 不替代 | [design D7](design.md)、[tasks](tasks.md) 4.1/4.2、[evidence-index](evidence-index.md) |

与可靠性 change 的领域边界不变；本 change 的 4.4 与对方新增的 5.3 对称承载最终组合回归，布局/折叠不能绕过当前凭据、来源、确认修订或恢复门禁。

## 修订后文档检查

- delta：desktop-ui 为 8 ADDED、23 scenarios；20 项实施任务全部未勾选。
- OpenSpec 全量 strict：15 passed、0 failed；两份 change 均通过。现行主 spec 的长文本 INFO 不是失败。
- 语义核对通过：新增 requirement 与主 spec/另一 change 无重名，23 个场景均有精确任务引用和独立证据行，任务 ID/引用路径有效、空白检查通过。
- 本轮仅修订草案及验收计划，未改产品代码、未执行功能或 Electron 验收、未提交或归档。现有截图只证明问题基线，专注/布局/共享详情仍待实施。
