## 1. Trace 版本与检查点契约

- [x] 1.1 扩展 trace-sdk v1/v2 schema、普通写入版本常量及导出；实现共用的原始对象禁字段 helper，在 reader 的 parse 前按 v1 自有属性存在性检查 workspace/fork.resume_after_step/span.workspace_snapshot，不泛化 strict（2h）。验证：`trace-format/双版本与旧读取器`、`未来版本文件`、`版本与隔离字段不匹配`、`v1 禁字段与其他扩展区分`，包含 null/false/空对象；普通 writer 默认 v1，旧 fixture 拒绝 v2，未来版本用 3。**（reader 入口已接；Tracer 与 IPC 入口按 1.3 继续。实现：`FORMAT_VERSION=2` 最高支持 + `PLAIN_FORMAT_VERSION=1` 普通写入 + `FormatVersionSchema` 双读；`version-guard.ts` 纯函数三处共用，存在性判定用 `hasOwn`（null/false/{}/显式 undefined 都算存在）；v2 另有"meta 必须带 workspace"约束。新增测试 16 个）**
- [ ] 1.2 实现快照清单与 workspace/origin schema、规范排序和哈希验证，区分 renderer 可用纯 schema 与 Node 字节哈希模块；在类型及 schema 注释注明 write_authorized 仅是审计标注、不授予新执行权限（2h）。验证：`trace-format/非法清单拒绝`，包含空清单、乱序、重复/冲突路径、hash/bytes 与 origin 非法输入，并核对审计字段文档。**（进度：schema 部分已落 —— `WorkspaceFile/Snapshot/Origin/MetaSchema` + 审计标注注释；**待做**：`workspace-hash.ts` 规范排序与哈希、非法清单（乱序/重复/冲突路径/越界）拒绝）**
- [ ] 1.3 扩展 step 的 EndSpanPatch 及读取端跨行约束，在 BaseTracer 转换前和 RunRecord/RunDetail IPC 原始输入入口复用 1.1 的版本禁字段检查，保证事件、JSONL、MemoryTracer 和 IPC 保留合法元数据（2h）。验证：`trace-format/根与分支快照往返`、`无附件仍能看轨迹`、`v1 禁字段与其他扩展区分`，内存输入自有 undefined 也拒绝，不在纯浏览解析时读 blob。
- [ ] 1.4 扩展 fork.resume_after_step 和 resolveBranch 的 v2 整轮截断，v1 行为不变（2h）。验证：`trace-format/编辑工具结果后分叉`、`隔离分叉保留同轮兄弟工具`、`隔离续跑边界矛盾`。
- [ ] 1.5 给 JsonlTracer 增加异常清理能力，只关闭当前句柄而不写终止事件；接入新编排的 finally 路径前先测资源语义（1h）。验证：`workspace-isolation/存储故障释放资源`，未封存状态保留、重复释放无副作用。

## 2. 文件世界存储与导入

- [ ] 2.1 在 replay 增加共用逻辑路径校验与固定配额定义（1.5h）。验证：`workspace-isolation/恶意路径与未知工具` 的路径部分、`名称冲突和参数非法` 的路径部分、`超限导入与运行时超限` 的长度/深度边界，覆盖 Windows ADS/UNC/设备名、NFC 和大小写碰撞。
- [ ] 2.2 实现内容寻址 blob 发布与读取，临时独占创建、刷盘、并发同哈希去重、不覆盖既有内容（2h）。验证：`workspace-isolation/内容发布失败和并发去重`、`附件丢失或被篡改`，注入 I/O 失败并确认只清本次临时文件。
- [ ] 2.3 实现 source 根校验与普通文件采集（2h）。验证：`workspace-isolation/拒绝链接及不合适的根目录`、`二进制字节保持`；独立读取 hardlink 字节，不保留链接；隐藏文件不静默跳过。
- [ ] 2.4 补两遍集合/内容核对、导入配额和失败收尾（1.5h）。验证：`workspace-isolation/采集期间变化被拒绝`、`超限导入与运行时超限` 的导入部分，变化/超限零 LLM、零 trace，孤立 blob 不成为可用快照。
- [ ] 2.5 实现分支独立映射、冻结快照及当前/新增内容配额派生（2h）。验证：`workspace-isolation/父子及并发兄弟隔离`、`导入后源目录变化不影响运行`、`写入授权限定于当前世界`，逐字节/hash 核对源与父状态不变。

## 3. 受控工具与 Tracer 适配

- [ ] 3.1 实现固定 file-tools-v1 定义和受控 read_file，绑定世界对象、严格参数及 UTF-8 解码（1h）。验证：`workspace-isolation/二进制字节保持`、`名称冲突和参数非法` 的读取参数部分，不使用宿主 cwd 查找文件。
- [ ] 3.2 实现受控 write_file，先持久发布内容再更新映射，按实际 UTF-8 字节数限制（1.5h）。验证：`workspace-isolation/同一分支写后立即读取`、`内容发布失败和并发去重`、`超限导入与运行时超限` 的运行写入部分，失败映射不变。
- [ ] 3.3 实现 profile 一致性及每次运行副本授权校验，只检查当前请求的 allowFileWrites，不接受任意 Tool[]，不继承 write_authorized 历史标注（1h）。验证：`workspace-isolation/缺授权或伪造工具定义`、`历史审计标记不能授权新执行`、`恶意路径与未知工具` 的未知工具部分，不能改 sideEffect 或伪造审计标记绕过。
- [ ] 3.4 实现 workspace Tracer 包装器：根 id/v2 meta 注入、step id 跟踪、轮末清单与底层事件转发（2h）。验证：`trace-format/根与分支快照往返`、`workspace-isolation/LLM 失败仍保留已完成文件事实`；runLoop 不新增 fs/global state。

## 4. 隔离编排与原入口门禁

- [ ] 4.1 实现 createIsolatedRun，参数/授权/导入预检后才建临时 trace，根结束归位并导出 API（2h）。验证：`replay/创建受控父本`、`desktop-ui/直接创建隔离文件父本`，任务、工具指纹、根关系、文件名与快照正确。
- [ ] 4.2 实现隔离分叉预检：父链、叶子自有工具、完整工具批次、profile/config_hash、编辑值、匹配 step 与附件哈希（2h）。验证：`replay/缺检查点与祖先编辑点拒绝`、`崩溃的 run 拒绝分叉`、`源代码变化拒绝分叉`、`分叉点必须是被编辑的 tool.invoke`，拒绝零子 trace/零 LLM。
- [ ] 4.3 实现 replayIsolatedRun，复用 deriveReplayState、独立映射、父链最大 span 编号和 workspace origin（2h）。验证：`replay/恢复历史中间文件而非最终文件`、`同轮多工具及最终轮回退路径`，spy 断言前缀工具/LLM 均零调用。
- [ ] 4.4 补子分支再分叉和兄弟并发集成测试，覆盖工具错误及 LLM error（1.5h）。验证：`replay/分支 run 再分叉`、`父文件不可变`、`重跑遇工具报错`、`新结果改变后续轨迹`，源、父和兄弟逐字节不变。
- [ ] 4.5 给 replayRun/loadForkParent 添加共享隔离拒绝规则并确保桌面/CLI 都经过门禁（1.5h）。验证：`replay/普通入口不可降级隔离父本`、`prompt-replay/隔离父本不能转普通 prompt fork`、`model-experiments/隔离实验无降级逃生通道`，包含 dry-run 和 allowSideEffects。
- [ ] 4.6 增加 v1 正向回归及隔离 trace 的卡带兼容 fixture（1.5h）。验证：`replay/生成分支 run 文件`、`卡带路径保持录制结果语义`；prompt-replay 三个既有场景 `proxy run 拒绝`、`含 config_hash 的 proxy run 放行`、`父 run 未封存` 保持通过。

## 5. 桌面 IPC 与状态派生

- [ ] 5.1 增加目录选择与 sourceToken 会话绑定（15 分钟有效期、提交时消费、取消零写），用已有 dataDir 约束 source（1.5h）。验证：`desktop-ui/浏览过程无写入`、`非法请求被拒绝`，无效/过期 token 和源目录重新校验失败不执行。
- [ ] 5.2 扩展 create/fork 的 zod 请求、通道分流、preload 与 store，隔离父类型与模式严格匹配（2h）。验证：`desktop-ui/非法请求被拒绝`、`空 fork 被拒绝`、`settings 未配置时拒绝`、`执行失败不产生半成品`，失败运行保留且列表刷新。
- [ ] 5.3 增加快照 inspect/readFile 只读 IPC 与 main 服务，按自有 trace 引用授权读取（2h）。验证：`desktop-ui/文件读取 IPC 拒绝越权`、`workspace-isolation/附件丢失或被篡改`，二进制、缺失、损坏与不存在分开返回。
- [ ] 5.4 在共享派生层集中实现隔离入口能力、续跑边界和初始/步骤快照文件差异；展示模型保留 ownerRunId/stepSpanId/localIteration，轮号取所属原始 step.n，不沿链累加（1.5h）。验证：`desktop-ui/历史运行和缺附件降级`、`多工具轮次确认`、`二次分叉轮号不沿链累加`、`重启后查看文件差异`；新增/修改基于路径和 hash，不持久化汇总缓存。

## 6. 桌面交互与文件结果

- [ ] 6.1 扩展 CreateRunDialog 模式控件、目录选择、副本授权及提交状态；每次新操作的授权不由历史 write_authorized 自动勾选（2h）。验证：`desktop-ui/直接创建隔离文件父本`、`新建 run 成功`、`userMessage 为空时禁用提交`、`空 systemPrompt 允许`、`workspace-isolation/历史审计标记不能授权新执行`，默认纯对话不改变工具表。
- [ ] 6.2 接隔离 result 重跑确认及 prompt/A-B 禁用原因，忙碌时禁重复提交，边界展示明确“运行 B 的第 N 轮”及 step span（1.5h）。验证：`desktop-ui/编辑 tool_result 并重跑`、`多工具轮次确认`、`二次分叉轮号不沿链累加`、`隔离父本的其他真执行入口`，确认、文件选择器和子运行来源说明的归属一致。
- [ ] 6.3 增文件 tab、检查点选择及紧凑文件列表、附件缺失/损坏状态（2h）。验证：`desktop-ui/重启后查看文件差异`、`历史运行和缺附件降级`，返回轨迹后保留当前运行和步骤，不触发后台写入。
- [ ] 6.4 接现有懒加载 Monaco 文本差异及二进制信息展示、窄窗口列表/内容切换（2h）。验证：`desktop-ui/长文本及窄窗口`、`超长消息`，不静默截断，不出现回写原目录按钮。

## 7. 系统回归与故障验证

- [ ] 7.1 新增受控三轮文件世界集成 fixture：before→middle→after，分叉恢复 middle 后写 child；断言原目录、父 trace/附件、兄弟 hash 不变（1.5h）。覆盖 `replay/恢复历史中间文件而非最终文件`、`desktop-ui/分叉不触碰既有文件`、`新建运行不触碰既有文件`。
- [ ] 7.2 增加重启、便携目录迁移、trace 写失败与发布后中断故障测试（2h）。覆盖 `workspace-isolation/中断与数据目录迁移`、`存储故障释放资源`、`trace-format/无附件仍能看轨迹`；不得把孤立 blob 或临时 trace 当完整父本。
- [ ] 7.3 运行普通模型实验与原生纯对话入口回归（1h）。覆盖 model-experiments 的 `创建两个模型分支`、`含 config_hash 的 proxy run 创建 A/B`、`拒绝不可 fork 父 run`、`拒绝缺少 system 消息的父 run`、`带工具的代理父本沿用既有门禁`、`pure 工具实验`、`副作用工具阻断`、`显式确认副作用后放行并留痕`、`CLI 遇到带工具的父 run`；desktop 的 `新建 run 作为父本进行 prompt fork`、`新建 run 作为父本进行模型 A/B`、`新建 run 作为父本进行 trace-test`。
- [ ] 7.4 编写并运行受控模型服务的桌面 CDP 冒烟：目录选择→父运行→修改结果→子运行→文件差异，重启后复查（2h）。验证 `desktop-ui/直接创建隔离文件父本`、`重启后查看文件差异`、`浏览过程无写入`，按 fixture 哈希检验实际文件不变，不仅检查 UI 文案。
- [ ] 7.5 在 Windows 代表性桌面和窄窗口截图复核长路径、确认区、文件表及 diff，运行可用的 junction/symlink 路径测试（1h）。验证 `desktop-ui/长文本及窄窗口`、`workspace-isolation/拒绝链接及不合适的根目录`；无权限创建链接时记录限制，不能记为已通过。
- [ ] 7.6 执行包 build 后的完整测试、桌面 typecheck、Biome、OpenSpec strict 及桌面完整构建（1h）。验证命令为 `pnpm check:ci`、`pnpm --filter @rebaseagent/desktop build`；构建须先于依赖 dist 的测试，保存失败/通过摘要，不把规范校验等同于运行验收。
- [ ] 7.7 新增可复现的列表扫描基准脚本并产出结果：按 design §3.1 构造 1/10/50 run、每 run 11 份完整合法清单，覆盖短路径/上限附近 ASCII 与中文路径及普通 v1 对照（2h）。验证：记录 fixture 总字节、环境、首次进程/重复扫描耗时与峰值内存，扫描结果与完整读取派生一致；满足 `desktop-ui/浏览过程无写入`、`trace-format/无附件仍能看轨迹`，不读 blob、不省略快照验证；实测性能与序列化估算分开，不能把首次进程扫描称为 OS 冷缓存或宣称大规模即时刷新。

## 8. 文档与验收收口

- [ ] 8.1 更新 README、trace-sdk/replay 使用说明：普通真实执行、隔离文件执行、卡带三者区别，v2/附件备份及文件保真度边界（1h）。验证：与 `workspace-isolation/导入后源目录变化不影响运行`、`trace-format/双版本与旧读取器`、`replay/卡带路径保持录制结果语义` 一致，不再宣传旧 run 自动恢复历史磁盘。
- [ ] 8.2 汇总 scenario→测试/fixture/截图索引与已知限制，复核六份 delta 和五个修改能力的既有 scenario 未丢失（1h）。验证：所有场景有可追踪证据，未做项维持未勾选；本任务不自动提交、归档或发版。

## 实现期发现（对回真实代码后修正的假设）

**2026-09-16 · 阶段 1 实现时发现 4 项**，已按真实代码修正（不改语义，只修正落点/归属）：

1. **`proxy-recorder.ts` 用的是 `FORMAT_VERSION` 而不是字面量 1** —— 提案只说要"新增普通写入版本常量"，没说清这里必须换。若把 `FORMAT_VERSION` 提到 2（最高支持），**代理录制会跟着写出 v2**，而 v2 契约要求必须有 workspace ⇒ 代理录制的 run 立刻变成非法文件。已改为 `PLAIN_FORMAT_VERSION`。
2. **`run-loop.ts:81` 的字面量 1 保持不动并加注释**：让它 import 常量会在 agent-loop 引入对 trace-sdk 的**运行时**依赖（现仅类型依赖），为一个常量不值得；注释里写明"不得改用 FORMAT_VERSION"。已在 `check:ci` 全绿前提下确认行为不变。
3. **路径校验的归属与 design 相反（层级问题）**：task 2.1 写"在 replay 增加共用逻辑路径校验"，但 **replay 依赖 trace-sdk**（`packages/replay/package.json` 确认），而 trace-format 的 schema 又必须校验合法路径 ⇒ trace-sdk 无法 import replay。**结论：路径校验器与快照哈希应放 trace-sdk（最底层、纯函数），replay 复用**。实现 1.2/2.1 前按此调整，勿按原文照做。
4. **"未来版本"基准从 2 改为 3**，三处既有断言同步更新：`packages/trace-sdk/test/reader.test.ts`、`packages/trace-sdk/test/schema.test.ts`（用例名含"未来版本"）、`apps/desktop/test/run-repository.test.ts`。v2 现在是受支持版本。
