# 首轮 review 修订处理记录

日期：2026-10-06。对应 [首轮独立 review](review.md)。原 review 保留审阅时的结论、数量与源码锚点；本文件记录后续修订，不替代新的独立复审或功能验收。

## 处理结果

| 意见 | 本次修订 | 对应文档与验收 |
| --- | --- | --- |
| P2：失败 run 的分叉适用范围未显式决策 | 采用方案 A：有完整自有请求的已封存失败代理 run 可以修改 messages 后，以当前凭据和独立确认重发。已封存指有终止记录的结构状态，stopped/error 不代表未封存；原样请求即使换凭据仍拒绝。成功/再次失败均产出自己的新子 run，父本不改，旧无调用、未封存或损坏记录仍拒绝 | [proposal](proposal.md)、[design D4](design.md)、[llm-proxy delta](specs/llm-proxy/spec.md) 的 MODIFIED“单请求级最小分叉（方案 a）”；[tasks](tasks.md) 3.6a/3.6b。保留原 3 个场景，补成功/再次失败/历史无调用/未封存或损坏 4 个场景 |
| 写入失败措辞含糊 | 明确不推进成功记录 revision；主动重发返回 PROXY_RECORDING_WRITE_FAILED，保留草稿、不借其他请求 ID，也不标录制成功，客户端转发仍保持既有边界 | [design D4](design.md)、[llm-proxy delta](specs/llm-proxy/spec.md)“写入失败不报告新记录”；[tasks](tasks.md) 1.2/1.4/3.5b |
| 启动恢复 capability 归属 | llm-proxy 保留监听生命周期与只读失败事实；desktop-ui 新增“代理启动恢复结果就近可见”，单独约束顶栏/录制页状态、原因与重读/显式应用入口 | [design D3](design.md)、[desktop-ui delta](specs/desktop-ui/spec.md) 的 3 个新场景；[tasks](tasks.md) 2.3a/2.3b/2.4 |
| 1024 常量双源漂移 | desktop 集成测试同时导入两处常量，锁定相等且为 1024，并比较同组脱敏限长边界；llm-proxy 不增加 agent-loop 运行时依赖 | [design D4](design.md)、[tasks](tasks.md) 3.1b、[evidence-index](evidence-index.md) 的对应场景与补充检查 |
| 合并回归只有对方承载 | 新增本 change 的 5.3，与 UI change 的 4.4 对称；最终组合重跑可见恢复、当前凭据、轮换/确认撤销和 main 副作用前拒绝，不依赖合入顺序 | [tasks](tasks.md) 5.3、[evidence-index](evidence-index.md) |
| 停用重启时无捕获凭据是冗余表述 | 保留，作为新 main 会话的可观察断言，与无持久凭据规则一致 | [llm-proxy delta](specs/llm-proxy/spec.md)“保存停用不启动代理” |

验收索引也已按每个精确 scenario 单独列出任务 ID 与计划证据，补充常量一致性及合并回归条目，所有结果仍为“待实施”。

## 修订后文档检查

- delta：llm-proxy 为 2 MODIFIED + 2 ADDED、20 scenarios；desktop-ui 为 5 ADDED、18 scenarios，共 38 个场景。25 项实施任务全部未勾选。
- OpenSpec 全量 strict：15 passed、0 failed；两份 change 均通过。现行主 spec 的长文本 INFO 不是失败。
- 语义核对通过：两项 MODIFIED 名称与主 spec 精确匹配，原有场景全部保留；新增 requirement 与主 spec/另一 change 无重名，场景与任务/证据逐项对应，引用路径与空白检查通过。
- 本轮仅修订草案及验收计划，未改产品代码、未执行功能或 Electron 验收、未提交或归档。失败父本重发与编辑器恢复尚未交付；原塌缩路径仍须复现并登记限制。
