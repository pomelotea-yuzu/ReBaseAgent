# R2.1 场景证据索引

> 2026-10-05 规划骨架。所有功能场景均待实施；文档结构/strict 校验不作为功能或 Electron 通过证据。实施时逐批回填测试、fixture、实机批次及限制。

| 序号 | capability | 场景 | 精确任务 | 状态 | 证据与限制 |
|---|---|---|---|---|---|
| 1 | workspace-isolation | 导出根 run 的初始检查点 | 1.3、3.4、4.1 | 部分（1.X/3.X 包层单测） | `workspace-export-api.test.ts` 定位 + `workspace-export-snapshot.test.ts` 端到端（files/ 字节、清单 source/status、no_text_changes）；4.1 重型 fixture 与固定时钟全清单比较待 4.x 收口 |
| 2 | workspace-isolation | 导出本 run 自有完成步骤 | 1.3、4.1 | 部分（1.X/3.X 包层单测） | 自有 step 定位 + e2e：files/ 为该步完整状态、清单记录 step_span_id/snapshot_id、补丁以初始快照为基线；4.1 待 |
| 3 | workspace-isolation | 祖先、清单外路径和非法来源被拒绝 | 1.1、4.2 | 部分（1.X/3.X 包层单测） | 祖先 step/非法 runId/no_workspace/trace_invalid/缺检查点拒绝已测（含编排层透传零写入）；清单外路径拒绝由 read-api 既有用例承载 |
| 4 | workspace-isolation | 附件缺失或损坏不生成伪完整导出 | 1.4、4.3a | 部分（1.X/3.X 包层单测） | 附件复核 missing/corrupt/io + 编排层 attachment_unavailable 目标零残留；4.3a fixture 待 |
| 5 | workspace-isolation | 二进制字节导出但不进入文本补丁 | 2.1、4.3a | 部分（2.1/3.X 包层单测） | 二进制字节逐字节落盘且哈希一致；二进制变化 excluded(binary) 不进补丁（e2e）；4.3a 待 |
| 6 | workspace-isolation | 非空目标和取消选择不覆盖既有内容 | 1.2、4.4a | 部分（1.X/2.3/3.X 包层单测） | 非空目标→target_invalid 零写入（单测+e2e）；中断残留 files/ 按非空拒绝；取消选择是桌面层（5.2a/6.3） |
| 7 | workspace-isolation | 写入中失败只清理本次产物 | 2.2、2.3、4.4a、4.4b | 部分（2.2/2.3 包层注入单测） | 写中途故障→半成品即时移除+逆序清理回空；被替换条目所有权核对保留不删；清理失败→retained 带相对路径；未知条目不递归删除 |
| 8 | workspace-isolation | 父文件缺失不否定包层自有快照 | 1.1、1.3、4.2 | 部分（1.X 包层单测） | ghost 父链 fixture：自有 step 定位与附件复核全通过；桌面 main 拒绝语义待 5.2a |
| 9 | workspace-isolation | 项目同名文件不覆盖导出元信息 | 2.1、4.1 | 部分（2.1/3.X 包层单测） | 同名元信息路径全部进 files/、根部命名空间干净（单测+e2e）；4.1 待 |
| 10 | workspace-isolation | 空快照与初始无变化可以导出 | 3.1、3.3b、4.1 | 部分（3.X 包层单测） | e2e：空快照→空 files/ + 空 files 数组 + no_text_changes；选定=初始 → 无变化不拒绝；4.1 待 |
| 11 | workspace-isolation | 目标排除数据目录及竞争写入 | 1.2、2.2、4.4a | 部分（1.X/2.X 包层单测） | 目标=dataDir/内部/祖先→target_conflicts_data_dir；目录级与文件级竞争→target_race 且不碰获胜者产物；dataDir 指纹 e2e（成功导出零改动） |
| 12 | workspace-isolation | 清单时间与不变量可独立核验 | 3.1、3.4、4.1 | 部分（3.X 包层单测） | 固定时钟整 JSON 逐字节一致；不同动作时间仅排除 created_at 后一致；status 恒 exported；4.1 待 |
| 13 | workspace-isolation | 中断残留不被当作成功结果 | 2.3、4.4b | 部分（2.3 包层单测） | 残留 files/ 的目标按非空拒绝、不自动补写（引擎无回滚路径）；子进程真实中断模拟待 4.4b |
| 14 | workspace-isolation | 文本修改及新增有可证明的补丁 | 3.2、3.3a、4.3b | 部分（3.X 包层单测） | diff 单测（修改/新增/CRLF/末尾无换行/引用/确定性）+ e2e written 补丁落盘且清单记录 bytes/sha256；4.3b fixture 待 |
| 15 | workspace-isolation | 二进制和删除变化逐路径说明 | 3.2、3.3b、4.3b | 部分（3.X 包层单测） | excluded binary/deletion 逐路径（单测+e2e）；仅排除项→not_available；4.3b 待 |
| 16 | workspace-isolation | 初始附件不可用仅撤销补丁 | 3.2、4.3b | 部分（3.X 包层单测） | baseline_missing/baseline_corrupt → 整份 not_available 且 covered=[]；文件导出完整成功、无 changes.patch 落盘（e2e）；4.3b 待 |
| 17 | workspace-isolation | 补丁超限保留完整文件导出 | 3.3b、4.3b | 部分（3.X 包层单测） | maxDiffCells 注入超限 → not_available+reason 超限、文件树与哈希完整、无补丁文件落盘（e2e）；4.3b 待 |
| 18 | desktop-ui | 复制路径原文及元信息 | 6.5、7.1b | 待实施 | — |
| 19 | desktop-ui | 查找换行和差异定位使用当前文件 | 6.5、7.1b | 待实施 | — |
| 20 | desktop-ui | 不可比较或未就绪时工具诚实禁用 | 6.1、6.5、7.1b | 待实施 | — |
| 21 | desktop-ui | 文件阅读键盘操作与离线加载 | 6.4、7.1b | 待实施 | — |
| 22 | desktop-ui | 从文件页导出成功 | 6.1、6.2、7.1a | 待实施 | — |
| 23 | desktop-ui | 目标目录非空或取消选择 | 5.2a、5.4、6.3、7.1b | 待实施 | — |
| 24 | desktop-ui | 来源不完整时禁用或拒绝导出 | 5.1、5.2a、5.4、6.1、7.1b | 待实施 | — |
| 25 | desktop-ui | 导出失败后恢复阅读 | 5.3、6.3、7.1b | 待实施 | — |
| 26 | desktop-ui | 导出成功不改变主动执行边界 | 5.2b、5.4、7.2 | 待实施 | — |
| 27 | desktop-ui | 无文本差异和二进制不封禁检查点导出 | 6.1、7.1a | 待实施 | — |
| 28 | desktop-ui | 补丁不可用不隐去成功文件导出 | 6.2、7.1a | 待实施 | — |
| 29 | desktop-ui | 导出请求迟到或重载不重发写入 | 5.2b、5.3、5.4、7.2 | 待实施 | — |

保留旧场景同样需要本轮接线回归证据。实机不成立、环境受阻或仅单元层承载均单列，不将规划完成等同功能完成。
