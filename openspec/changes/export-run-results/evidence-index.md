# R2.1 场景证据索引

> 2026-10-05 规划骨架。所有功能场景均待实施；文档结构/strict 校验不作为功能或 Electron 通过证据。实施时逐批回填测试、fixture、实机批次及限制。

| 序号 | capability | 场景 | 精确任务 | 状态 | 证据与限制 |
|---|---|---|---|---|---|
| 1 | workspace-isolation | 导出根 run 的初始检查点 | 1.3、3.4、4.1 | 包层完成（1.X–4.X） | 定位单测 + e2e（files/ 字节、清单 source/status、no_text_changes）+ `workspace-export-integration.test.ts`：固定时钟完整清单逐字节复算（测试手拼期望）、不同时间仅排除 created_at 一致 |
| 2 | workspace-isolation | 导出本 run 自有完成步骤 | 1.3、4.1 | 包层完成（1.X–4.X） | 定位 + e2e + integration：真实父链分支 run 与失败 run（errored/error）自有 step 逐字节核对，initial_snapshot_id 由测试侧独立复算 |
| 3 | workspace-isolation | 祖先、清单外路径和非法来源被拒绝 | 1.1、4.2 | 包层完成（1.X–4.X） | 祖先 step（真实父链）/非法 runId/no_workspace/trace_invalid/run_not_found 均在编排层拒绝且零写入+空清理报告；额外物理字段 @ts-expect-error 编译期钉死（运行时严格 schema 归 5.1）；清单外路径拒绝由 read-api 既有用例承载 |
| 4 | workspace-isolation | 附件缺失或损坏不生成伪完整导出 | 1.4、4.3a | 包层完成（1.X–4.X） | 附件复核 missing/corrupt/io + 编排层 attachment_unavailable 目标零残留（缺失 e2e、损坏 integration 各一） |
| 5 | workspace-isolation | 二进制字节导出但不进入文本补丁 | 2.1、4.3a | 包层完成（1.X–4.X） | 二进制字节逐字节落盘且哈希一致；二进制变化 excluded(binary) 不进补丁；外部 decoy 同名文件不可达 + dataDir 全域指纹不变（integration） |
| 6 | workspace-isolation | 非空目标和取消选择不覆盖既有内容 | 1.2、4.4a | 包层完成（1.X–4.X，桌面取消归 5.2a/6.3） | 非空目标→target_invalid 零写入（单测+e2e）；中断残留按非空拒绝；目标链接/dataDir 关系单测 + 编排层透传零写入 |
| 7 | workspace-isolation | 写入中失败只清理本次产物 | 2.2、2.3、4.4a、4.4b | 包层完成（2.X 注入 + 4.4a/4.4b 编排层注入） | 物化层注入（半成品即时移除/逆序清理/所有权核对/清理失败 retained）+ 编排层注入（补丁/清单写失败逆序回收、半成品移除失败 retained）+ 同目标并发败者零清理不碰胜者产物 |
| 8 | workspace-isolation | 父文件缺失不否定包层自有快照 | 1.1、1.3、4.2 | 包层完成（1.X–4.X） | ghost 父链 fixture：定位/附件复核 + 编排层端到端导出成功；桌面 main 拒绝语义待 5.2a |
| 9 | workspace-isolation | 项目同名文件不覆盖导出元信息 | 2.1、4.1 | 包层完成（2.X–4.X） | 同名元信息路径全部进 files/、根部命名空间干净（单测+e2e，4.1 复用既有证据） |
| 10 | workspace-isolation | 空快照与初始无变化可以导出 | 3.1、3.3b、4.1 | 包层完成（3.X–4.X） | e2e：空快照→空 files/ + 空 files 数组 + no_text_changes；选定=初始 → 无变化不拒绝（4.1 复用既有证据） |
| 11 | workspace-isolation | 目标排除数据目录及竞争写入 | 1.2、2.2、4.4a | 包层完成（1.X–4.X） | 目标=dataDir/内部/祖先→target_conflicts_data_dir（单测+编排层透传）；目录/文件级竞争→target_race 不碰获胜者产物；同目标 Promise.all 并发恰一个成功、胜者三件套完整（integration）；dataDir 指纹 e2e |
| 12 | workspace-isolation | 清单时间与不变量可独立核验 | 3.1、3.4、4.1 | 包层完成（3.X–4.X） | 固定时钟完整清单**逐字节**复算（测试手拼期望文本，钉死键序/缩进/末尾换行）；不同动作时间仅排除 created_at 后一致；status 恒 exported |
| 13 | workspace-isolation | 中断残留不被当作成功结果 | 2.3、4.4b | 包层完成（2.X/4.4b） | 残留目标按非空拒绝、零自动补写/清理（编排层注入文件承载中断契约面）；⚠️ 真实子进程中断单测不可稳定复现，实机归 7.1b |
| 14 | workspace-isolation | 文本修改及新增有可证明的补丁 | 3.2、3.3a、4.3b | 包层完成（3.X–4.X） | diff 单测 + e2e + integration 逐段核对：CRLF 内容行逐字保留、末尾无换行 del/add 双侧标准标记、带空格路径 /dev/null + git 引用、清单记录 bytes/sha256 |
| 15 | workspace-isolation | 二进制和删除变化逐路径说明 | 3.2、3.3b、4.3b | 包层完成（3.X–4.X） | excluded binary/deletion 逐路径（单测+e2e+integration）；deletion-only→not_available 且文件导出完整 |
| 16 | workspace-isolation | 初始附件不可用仅撤销补丁 | 3.2、4.3b | 包层完成（3.X–4.X） | baseline_missing（e2e）/baseline_corrupt（字节篡改）/baseline_io（blob 位换目录）→ 整份 not_available；文件导出完整、无 changes.patch 落盘 |
| 17 | workspace-isolation | 补丁超限保留完整文件导出 | 3.3b、4.3b | 包层完成（3.X–4.X） | maxDiffCells 注入超限 → not_available+reason 超限、文件树与哈希完整、无补丁文件落盘（e2e，4.3b 复用既有证据） |
| 18 | desktop-ui | 复制路径原文及元信息 | 6.5、7.1b | 待实施 | — |
| 19 | desktop-ui | 查找换行和差异定位使用当前文件 | 6.5、7.1b | 待实施 | — |
| 20 | desktop-ui | 不可比较或未就绪时工具诚实禁用 | 6.1、6.5、7.1b | 待实施 | — |
| 21 | desktop-ui | 文件阅读键盘操作与离线加载 | 6.4、7.1b | 待实施 | — |
| 22 | desktop-ui | 从文件页导出成功 | 6.1、6.2、7.1a | 待实施 | — |
| 23 | desktop-ui | 目标目录非空或取消选择 | 5.2a、5.4、6.3、7.1b | 部分（main 侧完成） | 取消→canceled 零写入、包层未调用；非空目标→target_invalid（包层 e2e）；端点测试含取消/失败透传；UI 反馈（6.3）待 |
| 24 | desktop-ui | 来源不完整时禁用或拒绝导出 | 5.1、5.2a、5.4、6.1、7.1b | 部分（main 侧完成） | ownOnly→RUN_LINEAGE_INCOMPLETE、损坏 trace→RUN_DETAIL_UNREADABLE，对话框前早期拒绝 + 目录返回后写入前重验（对话框期间父链变化用例）；strict schema 拒绝额外物理键；UI 禁用资格（6.1）待 |
| 25 | desktop-ui | 导出失败后恢复阅读 | 5.3、6.3、7.1b | 待实施 | — |
| 26 | desktop-ui | 导出成功不改变主动执行边界 | 5.2b、5.4、7.2 | 部分（main 构造保证） | 端点 deps 不含 OperationRegistry/sourceToken（零 operation/零授权由构造保证）；在飞保护独立于执行槽；7.2 回归待 |
| 27 | desktop-ui | 无文本差异和二进制不封禁检查点导出 | 6.1、7.1a | 待实施 | — |
| 28 | desktop-ui | 补丁不可用不隐去成功文件导出 | 6.2、7.1a | 待实施 | — |
| 29 | desktop-ui | 导出请求迟到或重载不重发写入 | 5.2b、5.3、5.4、7.2 | 部分（main 侧完成） | main 闭包在飞保护：重复请求立即 WORKSPACE_EXPORT_IN_FLIGHT 且不开第二个对话框，结束释放，renderer 重载不解除；renderer 回执守卫随 5.3 落地 |

保留旧场景同样需要本轮接线回归证据。实机不成立、环境受阻或仅单元层承载均单列，不将规划完成等同功能完成。
