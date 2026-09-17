本段保留原任务编号以追踪历史；5/6 阶段迁到 B/C。拆分片段的 A 后缀是原任务归属，不增加重复任务。预算 41h，含已完成 1.1 的 2h；1.2 部分进度保留。全部专项场景在本段五份 delta 中，公共全仓回归和桌面构建仍须运行。完整迁移表见 docs/plans/2026-09-16-a3-split-plan.md。

## 1. Trace 版本与检查点契约

- [x] 1.1 扩展 trace-sdk v1/v2 schema、普通写入版本常量及导出；实现共用的原始对象禁字段 helper，在 reader 的 parse 前按 v1 自有属性存在性检查 workspace/fork.resume_after_step/span.workspace_snapshot，不泛化 strict（2h）。验证：`trace-format/双版本与旧读取器`、`未来版本文件`、`版本与隔离字段不匹配`、`v1 禁字段与其他扩展区分`，包含 null/false/空对象；普通 writer 默认 v1，旧 fixture 拒绝 v2，未来版本用 3。**（reader 入口已接；Tracer 入口按 A 1.3 继续，IPC 入口迁 B 1.1。实现：`FORMAT_VERSION=2` 最高支持 + `PLAIN_FORMAT_VERSION=1` 普通写入 + `FormatVersionSchema` 双读；`version-guard.ts` 纯函数三处共用，存在性判定用 `hasOwn`（null/false/{}/显式 undefined 都算存在）；v2 另有"meta 必须带 workspace"约束。新增测试 16 个）**
- [ ] 1.2 实现快照清单与 workspace/origin schema、规范排序和哈希验证，区分 renderer 可用纯 schema 与 Node 字节哈希模块；在类型及 schema 注释注明 write_authorized 仅是审计标注、不授予新执行权限（2h）。验证：`trace-format/非法清单拒绝`，包含空清单、乱序、重复/冲突路径、hash/bytes 与 origin 非法输入，并核对审计字段文档。**（进度：schema 部分已落 —— `WorkspaceFile/Snapshot/Origin/MetaSchema` + 审计标注注释；**待做**：`workspace-hash.ts` 规范排序与哈希、非法清单（乱序/重复/冲突路径/越界）拒绝）**
- [ ] 1.3 扩展 step EndSpanPatch、读取端跨行约束及 BaseTracer 转换前版本守卫，完整保留事件、JSONL、MemoryTracer 的合法元数据；IPC 部分迁 B 1.1（1.5h）。验证：`trace-format/根与分支快照往返`、`无附件仍能看轨迹`、`v1 禁字段与其他扩展区分`，含自有 undefined；纯解析不读 blob。来源：原 1.3-A。
- [ ] 1.4 扩展 fork.resume_after_step 和 resolveBranch 的 v2 整轮截断，v1 行为不变（2h）。验证：`trace-format/编辑工具结果后分叉`、`隔离分叉保留同轮兄弟工具`、`隔离续跑边界矛盾`。
- [ ] 1.5 给 JsonlTracer 增加异常清理能力，只关闭当前句柄而不写终止事件；接入新编排的 finally 路径前先测资源语义（1h）。验证：`workspace-isolation/存储故障释放资源`，未封存状态保留、重复释放无副作用。

## 2. 文件世界存储与导入

- [ ] 2.1 在 trace-sdk 增加无 Node 依赖的共用逻辑路径校验，在 replay 定义固定配额并复用校验（1.5h）。验证：`workspace-isolation/恶意路径与未知工具` 的路径部分、`名称冲突和参数非法` 的路径部分、`超限导入与运行时超限` 的长度/深度边界，覆盖 Windows ADS/UNC/设备名、NFC 和大小写碰撞。
- [ ] 2.2 实现内容寻址 blob 发布与读取，并导出按已校验 run/自有检查点/逻辑路径定位的包只读接口，临时独占创建、刷盘、并发同哈希去重、不覆盖既有内容（2h）。验证：`workspace-isolation/内容发布失败和并发去重`、`附件丢失或被篡改`、`包只读接口限定清单与自有步骤`，注入 I/O 失败并确认只清本次临时文件。
- [ ] 2.3 实现 source 根校验与普通文件采集（2h）。验证：`workspace-isolation/拒绝链接及不合适的根目录`、`二进制字节保持`；独立读取 hardlink 字节，不保留链接；隐藏文件不静默跳过。
- [ ] 2.4 补两遍集合/内容核对、导入配额和失败收尾（1.5h）。验证：`workspace-isolation/采集期间变化被拒绝`、`超限导入与运行时超限` 的导入部分，变化/超限零 LLM、零 trace，孤立 blob 不成为可用快照。
- [ ] 2.5 实现分支独立映射、冻结快照及当前/新增内容配额派生（2h）。验证：`workspace-isolation/父子及并发兄弟隔离`、`导入后源目录变化不影响运行`、`写入授权限定于当前世界`，逐字节/hash 核对源与父状态不变。

## 3. 受控工具与 Tracer 适配

- [ ] 3.1 实现固定 file-tools-v1 定义和受控 read_file，绑定世界对象、严格参数及 UTF-8 解码（1h）。验证：`workspace-isolation/二进制字节保持`、`名称冲突和参数非法` 的读取参数部分，不使用宿主 cwd 查找文件。
- [ ] 3.2 实现受控 write_file，先持久发布内容再更新映射，按实际 UTF-8 字节数限制（1.5h）。验证：`workspace-isolation/同一分支写后立即读取`、`内容发布失败和并发去重`、`超限导入与运行时超限` 的运行写入部分，失败映射不变。
- [ ] 3.3 实现 profile 一致性及每次运行副本授权校验，只检查当前请求的 allowFileWrites，不接受任意 Tool[]，不继承 write_authorized 历史标注（1h）。验证：`workspace-isolation/缺授权或伪造工具定义`、`历史审计标记不能授权新执行`、`恶意路径与未知工具` 的未知工具部分，不能改 sideEffect 或伪造审计标记绕过。
- [ ] 3.4 实现 workspace Tracer 包装器：根 id/v2 meta 注入、step id 跟踪、轮末清单与底层事件转发（2h）。验证：`trace-format/根与分支快照往返`、`workspace-isolation/LLM 失败仍保留已完成文件事实`；runLoop 不新增 fs/global state。

## 4. 隔离编排与原入口门禁

- [ ] 4.1 实现 createIsolatedRun，显式 dataDir、参数/授权/导入预检后才建临时 trace，根结束归位并导出 API（2h）。验证：`replay/创建受控父本`，任务、工具指纹、根关系、文件名与快照正确。
- [ ] 4.2 实现并导出只读隔离能力预检，正式分叉时重新预检：父链、叶子自有工具、完整工具批次、profile/config_hash、编辑值、匹配 step 与附件哈希（2h）。验证：`replay/缺检查点与祖先编辑点拒绝`、`崩溃的 run 拒绝分叉`、`源代码变化拒绝分叉`、`分叉点必须是被编辑的 tool.invoke`，拒绝零子 trace/零 LLM；另覆盖 `workspace-isolation/隔离能力预检无执行副作用`。
- [ ] 4.3 实现 replayIsolatedRun，复用 deriveReplayState、独立映射、父链最大 span 编号和 workspace origin（2h）。验证：`replay/恢复历史中间文件而非最终文件`、`同轮多工具及最终轮回退路径`，spy 断言前缀工具/LLM 均零调用。
- [ ] 4.4 补子分支再分叉和兄弟并发集成测试，覆盖工具错误及 LLM error（1.5h）。验证：`replay/分支 run 再分叉`、`父文件不可变`、`重跑遇工具报错`、`新结果改变后续轨迹`，源、父和兄弟逐字节不变。
- [ ] 4.5 给 replayRun/loadForkParent 添加共享隔离拒绝规则并验证 CLI 路由；桌面 main/IPC 路由迁 B 1.2（1h）。验证：`replay/普通入口不可降级隔离父本`、`prompt-replay/隔离父本不能转普通 prompt fork`、`model-experiments/隔离实验无降级逃生通道`，含 dry-run 和 allowSideEffects。来源：原 4.5-A。
- [ ] 4.6 增加 v1 正向回归及隔离 trace 的卡带兼容 fixture（1.5h）。验证：`replay/生成分支 run 文件`、`卡带路径保持录制结果语义`；prompt-replay 三个既有场景 `proxy run 拒绝`、`含 config_hash 的 proxy run 放行`、`父 run 未封存` 保持通过。

## 7. 包集成、故障与公共回归

- [ ] 7.1 新增包 API 三轮 fixture：before→middle→after，分叉恢复 middle 后写 child，断言源目录、父 trace/附件及兄弟哈希不变（1.5h）。验证：`replay/恢复历史中间文件而非最终文件`、`父文件不可变`、`workspace-isolation/父子及并发兄弟隔离`。桌面操作断言迁 B 3.2。
- [ ] 7.2 增加包 API 重新加载、dataDir 整体迁移、trace 写失败和 blob 发布后中断测试（2h）。验证：`workspace-isolation/中断与数据目录迁移`、`存储故障释放资源`、`trace-format/无附件仍能看轨迹`；孤立 blob/临时 trace 不得成为完整父本。桌面重启及文件显示由 B/C 验收。
- [ ] 7.3 运行普通模型实验的包与 CLI 回归；桌面纯对话部分迁 B 3.1（0.5h）。验证：model-experiments 的 `创建两个模型分支`、`含 config_hash 的 proxy run 创建 A/B`、`拒绝不可 fork 父 run`、`拒绝缺少 system 消息的父 run`、`带工具的代理父本沿用既有门禁`、`pure 工具实验`、`副作用工具阻断`、`显式确认副作用后放行并留痕`、`CLI 遇到带工具的父 run`。来源：原 7.3-A。
- [ ] 7.5 在 Windows 运行可创建的 junction/symlink 导入测试；截图部分迁 B/C（0.5h）。验证：`workspace-isolation/拒绝链接及不合适的根目录`；缺创建权限记录未验证限制，不能标作通过。来源：原 7.5-A。
- [ ] 7.6 执行包 build 后的完整测试、桌面 typecheck、Biome、OpenSpec strict 及桌面完整构建（1h）。验证命令为 `pnpm check:ci`、`pnpm --filter @rebaseagent/desktop build`；构建须先于依赖 dist 的测试，保存失败/通过摘要，不把规范校验等同于运行验收。
- [ ] 7.7 生成可复用的 1/10/50 run 合法 fixture，覆盖短路径、上限附近 ASCII/中文路径、每 run 11 份清单和 v1 对照，测完整 reader 解析时间/峰值内存/正确性（1h）。验证：`trace-format/根与分支快照往返`、`无附件仍能看轨迹`；记录环境/字节量，零 blob 读取/写入，不省略验证，不把首次进程扫描称 OS 冷缓存。真实 listRuns 验收迁 B 3.4。来源：原 7.7-A。

## 8. 文档与验收收口

- [ ] 8.1 更新 README 和 trace-sdk/replay 包说明：普通执行、隔离文件执行、卡带区别，dataDir、v2/附件备份与文件保真度（0.5h）。验证：`workspace-isolation/导入后源目录变化不影响运行`、`trace-format/双版本与旧读取器`、`replay/卡带路径保持录制结果语义`；桌面和文件查看文档迁 B/C。来源：原 8.1-A。
- [ ] 8.2 汇总 A 五份 delta 的 scenario→测试/fixture 索引，核对原任务及跨段场景迁移、四个修改能力的既有场景和实现期发现（1h）。验证：本段全部场景均有证据，特别是 `trace-format/版本与隔离字段不匹配`、`workspace-isolation/历史审计标记不能授权新执行`；未实现项不勾选。本次不自动提交、归档或发版。来源：原 8.2-A；B/C 各独立建立索引。

## 实现期发现（对回真实代码后修正的假设）

**2026-09-16 · 阶段 1 实现时发现 4 项**，已按真实代码修正（不改语义，只修正落点/归属）：

1. **`proxy-recorder.ts` 用的是 `FORMAT_VERSION` 而不是字面量 1** —— 提案只说要"新增普通写入版本常量"，没说清这里必须换。若把 `FORMAT_VERSION` 提到 2（最高支持），**代理录制会跟着写出 v2**，而 v2 契约要求必须有 workspace ⇒ 代理录制的 run 立刻变成非法文件。已改为 `PLAIN_FORMAT_VERSION`。
2. **`run-loop.ts:81` 的字面量 1 保持不动并加注释**：让它 import 常量会在 agent-loop 引入对 trace-sdk 的**运行时**依赖（现仅类型依赖），为一个常量不值得；注释里写明"不得改用 FORMAT_VERSION"。已在 `check:ci` 全绿前提下确认行为不变。
3. **路径校验的归属与 design 相反（层级问题）**：task 2.1 写"在 replay 增加共用逻辑路径校验"，但 **replay 依赖 trace-sdk**（`packages/replay/package.json` 确认），而 trace-format 的 schema 又必须校验合法路径 ⇒ trace-sdk 无法 import replay。**结论：路径校验器与快照哈希应放 trace-sdk（最底层、纯函数），replay 复用**。实现 1.2/2.1 前按此调整，勿按原文照做。
4. **"未来版本"基准从 2 改为 3**，三处既有断言同步更新：`packages/trace-sdk/test/reader.test.ts`、`packages/trace-sdk/test/schema.test.ts`（用例名含"未来版本"）、`apps/desktop/test/run-repository.test.ts`。v2 现在是受支持版本。

### 拆分后的历史说明

上面四项是实施当时的记录。路径校验归属现已同步到 A design 和 2.1；第 4 项已完成的 desktop 测试版本修正保留，不重复列为待办。2026-09-17 随方向规划审阅明确：A 的 desktop 修改仅限因共享包版本兼容而必需的既有版本/测试断言与常量引用修正，须保留既有行为及拒绝门禁，并记录原因和回归证据；禁止新增或扩展 IPC handler、preload/store 暴露、渲染层组件和 main 侧流程。隔离桌面工作归 B/C，可用性工作归独立 U 变更，白名单外先调整受影响分工及 OpenSpec。原 1.1 的 IPC 后续工作迁 B 1.1；原 1.2 的 schema 进度不等于哈希/路径验证已完成。本次未改任务勾选或预算。
