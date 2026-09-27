# 重跑状态一致性机制

核查日期：2026-09-27。本文解释已存在的执行语义，依据 [replay 规范](../../openspec/specs/replay/spec.md)、[workspace-isolation 规范](../../openspec/specs/workspace-isolation/spec.md) 与对应源码。它不增加新的产品契约，也不代表本次已重跑全部测试。

## 要解决的问题

如果只恢复模型的对话历史，却让后续工具读取今天的工作目录，消息中的“当时”与文件中的“现在”可能矛盾。反过来，仅复制文件而不确定消息前缀对应哪个工具轮次，也不能保证续跑边界清楚。

ReBaseAgent 的隔离模式把一次续跑的起点定义为三项：派生消息前缀、所选工具所属整轮结束的文件快照、直接父运行中的分叉位置。适用范围是本项目执行循环与固定 `file-tools-v1` 工具组。

## 工具观察编辑的准确含义

设某轮模型产生 T1、T2 两个工具调用。执行完二者得到观察 O1、O2，同时形成轮末文件世界 W。用户把 O1 改成 O1' 后创建分支：

1. 派生消息保留这一轮的工具调用和两条工具结果，仅将 O1 替换为 O1'。
2. 分支的文件初态取 W，因此包含 T1、T2 原来执行的文件效果。
3. T1、T2 不重新执行，也不撤销其中任何一个；下一次模型调用才看到新的观察组合。
4. 后续新产生的工具调用真实执行，只改变当前分支的文件映射。

因此，此模式研究的是“在既定轮末文件事实下，改变一个观察会怎样影响后续决策”。它不是“把 T1 真正换成另一种执行并重算世界”。人为编辑的观察可以与文件事实冲突，这种冲突本身是实验输入，不能声称恢复了一个必然真实发生过的历史。

多代分叉还要求编辑点属于直接父运行自身，并存在对应的完整检查点。普通消息分叉允许的祖先引用范围不能直接套用到隔离入口。

## 文件世界与失败边界

| 机制 | 作用 | 限制 |
|---|---|---|
| 导入源目录的普通文件字节 | 建立独立初始世界，后续不靠回读源目录补齐 | 不保存空目录、权限、时间戳或链接身份；不接受链接和不支持对象 |
| 内容寻址的不可变 blob | 相同内容可共享，通过哈希和大小验证附件 | 哈希不是备份策略；附件仍可能丢失，丢失时拒绝执行 |
| 各分支独立路径映射 | 后续写入不改变父世界或兄弟世界 | 不自动合并回源目录，也不是操作系统权限沙箱 |
| 初始及工具轮末检查点 | 消息边界和文件边界可定位 | 不提供每个单独工具之后的任意恢复点 |
| 当前请求的显式副本写入授权 | 避免历史记录自动授权新执行 | `sideEffect` 声明和父运行授权都不能代替本次授权 |
| 执行前验证与拒绝降级 | 附件缺失、损坏或父本非法时不偷偷改走普通工具 | 轨迹仍可阅读，不能把“可查看”写成“可续跑” |

首期配额包括文件数 2000、单文件 8 MiB、当前世界 64 MiB、单次运行新增唯一内容 128 MiB。配额及路径约束以规范为准，本文不承诺更大任务规模。受控工具只支持 `read_file` / `write_file`；不覆盖 shell、数据库、网络副作用或自定义 handler 的历史恢复。

## 不同入口不能混称为完整复现

| 入口 | 起点与执行 | 能说明什么 |
|---|---|---|
| 普通工具结果重跑 | 复用消息前缀，后续工具在原配置 cwd 执行 | 观察变化后的续跑；不保证外部状态回退 |
| 隔离工具结果续跑 | 复用消息前缀和匹配轮末文件快照，后续操作副本 | 受控文件世界内可核查的分支实验 |
| 提示词或模型实验 | 从初始输入启动新的运行 | 新配置下重新执行；不是工具编辑点后的续跑，当前不支持隔离 prompt/A-B |
| 代理录制和重发 | 捕获或重发模型请求 | 单次请求层面的观测，不是任意第三方 Agent 的完整恢复 |
| Trace-as-test | 当前 loop 使用记录的模型响应和 stub 工具执行 | 默认验证执行结构；不验证真实模型回答质量或真实外部副作用 |

卡带测试中的 `request_drift` / `config_drift` 会显示警告，但本身不改变通过状态或退出码。代理来源的 run 不能进行动态卡带重跑，只允许明确的静态断言。参见 [trace-as-test 规范](../../openspec/specs/trace-as-test/spec.md)。

## 实现与验证入口

| 主张 | 实现入口 | 测试源码中的核查点 |
|---|---|---|
| 轮末恢复与观察编辑对应 | [isolated-replay.ts](../../packages/replay/src/workspace/isolated-replay.ts)、[derive.ts](../../packages/replay/src/derive.ts) | [workspace-isolated-replay.test.ts](../../packages/replay/test/workspace-isolated-replay.test.ts)：读取 `middle` 而非 `after`；同轮仅替换 T1 观察、保留 T1/T2 文件效果 |
| 分支共享内容但不共享可变映射 | [world.ts](../../packages/replay/src/workspace/world.ts)、[blob-store.ts](../../packages/replay/src/workspace/blob-store.ts) | [workspace-isolated-integration.test.ts](../../packages/replay/test/workspace-isolated-integration.test.ts)：多代分叉、兄弟独立、父本不变 |
| 缺失附件不退回源目录 | [preflight.ts](../../packages/replay/src/workspace/preflight.ts)、[read-api.ts](../../packages/replay/src/workspace/read-api.ts) | [workspace-package-recovery.test.ts](../../packages/replay/test/workspace-package-recovery.test.ts)：迁移恢复、缺附件可读轨迹但拒绝续跑 |
| 卡带不等同真实模型回归 | [cassette-llm-client.ts](../../packages/trace-test/src/cassette-llm-client.ts) | [cassette.test.ts](../../packages/trace-test/test/cassette.test.ts)：请求漂移告警后继续消费响应 |

## 技术贡献的表述边界

检查点、时间旅行、内容寻址、写时复制、追踪与卡带测试都是既有技术。当前能够陈述的是：项目针对工具观察干预，做出了消息与整轮文件快照对齐、分支身份追溯、受控副本写入和失败拒绝策略，并有对应实现与测试源码。

这构成可解释、可验证的系统设计与工程实现，但不能仅凭此证明新的基础算法、同类方案无法实现或绝对首创。实际价值仍需通过 [实验方案](../research/2026-09-27-replay-consistency-experiment.md) 验证正确性、资源代价和真实任务收益。
