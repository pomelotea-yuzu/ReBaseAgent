# 验收证据索引（待实施）

问题基线为 [实机问题记录](../../../docs/reviews/2026-10-06-ui-density-review.md) 与其引用的几何基线 [`docs/reviews/2026-10-06-ui-density-geometry-baseline.json`](../../../docs/reviews/2026-10-06-ui-density-geometry-baseline.json)（原 `output/ui-density-review-2026-10-06/` 的逐页几何读数已提炼入库；截图与 DOM 全文转储为本地过程产物，按 `.gitignore` 的 `output/` 规则不入库）。验收必须用真实窗口及真实 200% 缩放；Emulation 不替代比例、输入与恢复证据。宿主不可达项单列限制，不宣称全矩阵通过。

每个 delta scenario 单独登记。实施后在最后一列填测试名/日志或截图路径、真实宿主尺寸、限制与结果；当前所有证据均待实施，文档校验不等同功能通过。

| Capability / Requirement | Scenario | 任务 | 计划检查与证据 | 证据路径 / 结果 |
| --- | --- | --- | --- | --- |
| [desktop-ui](specs/desktop-ui/spec.md) / 工作区折叠控制一致且可发现 | 列表和步骤控制可发现且可恢复 | [1.1](tasks.md) | 真实控制截图与至少 28 CSS px 命中区；收起/展开后选中与手动宽度前后值 | 待实施 |
| [desktop-ui](specs/desktop-ui/spec.md) / 工作区折叠控制一致且可发现 | 目录与长文本折叠不丢位置 | [1.2](tasks.md)、[1.5](tasks.md) | run/span 目标往返；就近恢复入口、完整文本/选择/滚动指纹及其他目标隔离 | 待实施 |
| [desktop-ui](specs/desktop-ui/spec.md) / 工作区折叠控制一致且可发现 | 键盘折叠显示当前状态 | [1.1](tasks.md)、[1.2](tasks.md)、[4.3](tasks.md) | Tab、Enter/Space 实际操作；可见焦点、名称/aria-expanded/aria-controls 与恢复入口 | 待实施 |
| [desktop-ui](specs/desktop-ui/spec.md) / 工作区说明分层去重且异常不隐藏 | 隔离文件页不重复同一说明 | [1.3](tasks.md) | 根/分支文件页真实截图；同屏隔离说明唯一、轮次/来源/只读身份及完整保真边界可达 | 待实施 |
| [desktop-ui](specs/desktop-ui/spec.md) / 工作区说明分层去重且异常不隐藏 | 技术元信息按需完整阅读 | [1.3](tasks.md)、[1.5](tasks.md) | 来源/工程详情共用组件核对；键盘/aria、目标隔离、完整原值/原因阅读与复制 | 待实施 |
| [desktop-ui](specs/desktop-ui/spec.md) / 工作区说明分层去重且异常不隐藏 | 异常摘要始终可见 | [1.4](tasks.md)、[1.5](tasks.md)、[2.4a](tasks.md) | 缺来源/读取失败/未知/门禁 fixtures；折叠与专注截图、处理动作可达、提交仍拒绝 | 待实施 |
| [desktop-ui](specs/desktop-ui/spec.md) / 编辑与差异获得实际可用空间 | 普通文件页正文获得可见高度 | [2.1](tasks.md)、[4.1](tasks.md) | 真实 1210×713 文件 config.json diff 及比较返回；可见正文≥约 357px、左右/checkpoint 身份与基线对照 | 待实施 |
| [desktop-ui](specs/desktop-ui/spec.md) / 编辑与差异获得实际可用空间 | 原值与草稿按容器适配 | [2.2](tasks.md)、[2.3](tasks.md) | 真实宽高变化与拖拽/键盘调整；每侧约 320px 判据、并排/上下、剩余空间和完整滚动 | 待实施 |
| [desktop-ui](specs/desktop-ui/spec.md) / 编辑与差异获得实际可用空间 | 原值收起后仍可恢复核对 | [2.2](tasks.md) | 真实输入后收起/展开原值；草稿空间、恢复入口、全文与只读身份 | 待实施 |
| [desktop-ui](specs/desktop-ui/spec.md) / 编辑与差异获得实际可用空间 | 窄窗口和缩放不压缩字号 | [4.2](tasks.md) | 真实 1024/800px 窗口与独立 200% 缩放；实际字号、内部滚动、工具栏/焦点无溢出遮挡 | 待实施 |
| [desktop-ui](specs/desktop-ui/spec.md) / 编辑与差异获得实际可用空间 | 只读差异保持只读 | [2.1](tasks.md)、[2.5](tasks.md) | 切换尺寸/专注后查找复制；只读配置、无写动作、源/trace/附件 SHA 与模型计数不变 | 待实施 |
| [desktop-ui](specs/desktop-ui/spec.md) / 专注模式保留目标草稿与阅读偏好 | 专注模式保留身份并恢复布局 | [2.4a](tasks.md)、[2.4b](tasks.md)、[4.2](tasks.md) | 手动宽度/折叠前后值、空间变化时退出；目标/恢复操作与有效阅读位置，不用旧快照覆盖 | 待实施 |
| [desktop-ui](specs/desktop-ui/spec.md) / 专注模式保留目标草稿与阅读偏好 | 专注切换目标与主动调整有明确归属 | [2.4b](tasks.md)、[4.3](tasks.md) | run/span/字段/有方向 pair 切换、卸载往返与主动调宽/折叠；旧专注立即解除、不重入、不回滚新偏好、无草稿/阅读并行 store | 待实施 |
| [desktop-ui](specs/desktop-ui/spec.md) / 专注模式保留目标草稿与阅读偏好 | 长草稿切换不丢输入和目标 | [2.3](tasks.md)、[2.5](tasks.md)、[4.3](tasks.md)、[4.4](tasks.md) | messages/prompt/result/A/B 非法 JSON、多行、空串/尾随空白；折叠/专注/往返后逐字草稿、目标、光标/滚动与实际输入 | 待实施 |
| [desktop-ui](specs/desktop-ui/spec.md) / 比较修改证据可收起且身份始终可辨 | 修改证据收起释放输出空间 | [1.4](tasks.md)、[4.1](tasks.md) | 收起前后 diff 可见高度；摘要/方向/身份、关系未知与展开后完整证据/定位 | 待实施 |
| [desktop-ui](specs/desktop-ui/spec.md) / 核对与提交相邻且绑定纪律不变 | 确认和提交在同一操作区 | [3.1](tasks.md)、[3.2](tasks.md)、[4.1](tasks.md) | 各模式真实操作区与纯键盘核对→提交；窄窗上下相邻，sticky 不遮挡正文焦点/摘要 | 待实施 |
| [desktop-ui](specs/desktop-ui/spec.md) / 核对与提交相邻且绑定纪律不变 | 核对后的编辑撤销旧许可 | [3.1](tasks.md)、[4.4](tasks.md) | 核对后改变草稿/目标/配置/参数/凭据及离开返回；旧许可拒绝、输入保持与折叠/专注无旁路 | 待实施 |
| [desktop-ui](specs/desktop-ui/spec.md) / 核对与提交相邻且绑定纪律不变 | 详细边界可读但不能跳过核对 | [3.2](tasks.md) | 普通/隔离创建、result/prompt/messages/A/B；折叠细节后费用/副作用摘要、预检/计划与两段确认仍必需 | 待实施 |
| [desktop-ui](specs/desktop-ui/spec.md) / 放弃修改模态视觉明确且保留安全语义 | 放弃模态可辨且取消不丢草稿 | [3.3](tasks.md)、[4.3](tasks.md) | 真实遮罩/居中截图及取消/Esc；背景隔离、焦点返回与草稿逐字保持 | 待实施 |
| [desktop-ui](specs/desktop-ui/spec.md) / 放弃修改模态视觉明确且保留安全语义 | 长确认可滚动且操作可达 | [3.3](tasks.md) | 真实窄窗/200% 缩放长草稿模态；内部滚动、两动作可达、焦点不逃背景 | 待实施 |
| [desktop-ui](specs/desktop-ui/spec.md) / 放弃修改模态视觉明确且保留安全语义 | 旧确认不能放弃新修订 | [3.3](tasks.md) | CAS 竞争注入；旧确认被拒、新草稿保持与重新核对当前内容 | 待实施 |
| [desktop-ui](specs/desktop-ui/spec.md) / 主流程文案表达用户结果而非实现机制 | 没有改动提示用中文且技术细节可查 | [3.4](tasks.md) | 原样提交/尚未提交/机制详情 UI 对照；用户文案、完整工程规则、共享详情机制、无字面 ** | 待实施 |
| [desktop-ui](specs/desktop-ui/spec.md) / 主流程文案表达用户结果而非实现机制 | 时间旅行名称不扩大恢复承诺 | [3.4](tasks.md) | 入口与模式说明对照；整轮快照/消息复用边界可读，无外部恢复或同轮写入撤销承诺 | 待实施 |

## 补充验收

| 检查 | 任务 | 计划检查与证据 | 证据路径 / 结果 |
| --- | --- | --- | --- |
| 与可靠性 change 的双向合并回归 | [4.4](tasks.md) | 最终组合重跑可见编辑器恢复、当前凭据门禁与确认撤销；公共包装和文件工具栏交界检查，领域证据分别登记 | 待实施 |
| 功能与质量收口 | [4.5](tasks.md) | 受影响 desktop 测试/typecheck/build/Biome/OpenSpec strict 日志与逐场景索引；纯静态截图不能证明可输入/恢复 | 待实施 |
