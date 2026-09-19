# A 段（`add-sandboxed-rerun`）场景 → 证据索引

> 任务 8.2 的产出。范围：本 change 五份 spec delta 的**全部 57 个 scenario**。
> **本次不自动提交、不归档、不发版** —— 索引只是把"每个场景的验收证据"变成可查的表。
> B（`add-sandboxed-rerun-desktop`）与 C（`-file-view`）各段独立建立自己的索引。

## 怎么读这份表

- **A / M**：`A` = 本次新增的场景（`## ADDED` 段）；`M` = 修改既有能力时**既有**的场景（`## MODIFIED` 段）——后者必须由既有回归用例证明"没被改坏"。
- **证据**一律是**可执行的用例**（文件 › 用例名/分组），必要时补一句静态约束（schema 层）。行号会随改动漂移，**定位以用例名为准**。
- **未实现项不勾选**：核对后 57 个场景均有真实证据，因此本表没有 ❌ 行；若将来某项被改动到无证据，应显式改成 ❌ 而不是删行。

## 汇总

| delta | 场景数 | A | M | 已覆盖 |
| --- | --- | --- | --- | --- |
| trace-format | 10 | 3 | 7 | 10 |
| workspace-isolation | 19 | 19 | 0 | 19 |
| replay | 14 | 5 | 9 | 14 |
| prompt-replay | 4 | 0 | 4 | 4 |
| model-experiments | 10 | 0 | 10 | 10 |
| **合计** | **57** | **27** | **30** | **57** |

覆盖面：`pnpm check:ci` 6 包 981 passed / 4 skipped（4 条是开发者模式关闭后按约定 skipped 的 symlink 用例）。

## 1. trace-format（10）

| # | scenario | A/M | 证据 |
| --- | --- | --- | --- |
| 1 | 未来版本文件 | M | `trace-sdk/test/reader.test.ts` ›「未来版本：明确报「不支持的格式版本」，不产生部分结果」；`schema.test.ts` ›「format_version 为 3（未来版本，v1/v2 以外的版本一律拒绝）」 |
| 2 | 双版本与旧读取器 | M | `trace-sdk/test/version-guard.test.ts` 整组（v1 与 v2 双读；旧 fixture 拒绝 v2） |
| 3 | 版本与隔离字段不匹配 | M | `trace-sdk/test/version-guard.test.ts` ›「findVersionFieldViolation：v1 禁字段（存在性判定，非 truthiness）」组 |
| 4 | v1 禁字段与其他扩展区分 | M | `trace-sdk/test/version-guard.test.ts` ›「v1 携带**无关**扩展字段仍放行（禁字段检查只针对隔离字段，不泛化 strict）」 |
| 5 | 编辑工具结果后分叉 | M | `trace-sdk/test/branch.test.ts` ›「branch.jsonl 沿 parent 链拼接出完整轨迹」；`replay/test/derive.test.ts` ›「对 normal 编辑 s_03(read_file result) → 与手工 branch fixture 的录制前缀逐字段一致」 |
| 6 | 隔离分叉保留同轮兄弟工具 | M | `trace-sdk/test/branch.test.ts` ›「前缀保留该轮全部兄弟工具，再接入子运行」＋对照用例「对照 v1：同一结构按 at_span 截断会丢掉同轮兄弟工具」 |
| 7 | 隔离续跑边界矛盾 | M | `trace-sdk/test/branch.test.ts` ›「resolveBranch：v2 整轮截断」组的 5 条边界矛盾（缺 `resume_after_step` / 指向非步骤 / `at_span` 不属于该 step / `at_span` 等于 step / step 只在祖先） |
| 8 | 根与分支快照往返 | A | `trace-sdk/test/workspace-roundtrip.test.ts` ›「快照往返：经 Tracer 写入再读取」；`replay/test/workspace-checkpoint-tracer.test.ts`（根与分支、空清单、无附件解析） |
| 9 | 非法清单拒绝 | A | `trace-sdk/test/workspace-snapshot.test.ts` 整组（空清单 / 乱序 / 重复与冲突路径 / hash 与 bytes 非法 / origin 不自洽 / 平台特性路径） |
| 10 | 无附件仍能看轨迹 | A | `trace-sdk/test/workspace-roundtrip.test.ts` ›「无附件仍能看轨迹」；`trace-test/test/isolated-cassette.test.ts`（附件目录不存在仍对齐通过）；`trace-sdk/test/reader-perf.test.ts`（零 blob 语料） |

## 2. workspace-isolation（19，全部 ADDED）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 导入后源目录变化不影响运行 | `replay/test/workspace-world.test.ts` ›「世界：导入后源目录变化不影响运行」 |
| 2 | 拒绝链接及不合适的根目录 | `replay/test/workspace-import-source.test.ts` ›「源根校验：形态与关系」组（磁盘根/UNC/设备/驱动器相对/祖先冲突/大小写变体）＋「源根与树内的链接形态（7.5 真机 junction/symlink）」6 条＋「树内的目录 junction 被拒」「悬空 junction 同样被拒」 |
| 3 | 采集期间变化被拒绝 | `replay/test/workspace-import-verify.test.ts` 整组（内容/大小/新增/删除/标识五类变化；第二遍只读） |
| 4 | 同一分支写后立即读取 | `replay/test/workspace-file-tools.test.ts` ›「write_file」组的写后立即读取与覆盖写 |
| 5 | 恶意路径与未知工具 | `replay/test/workspace-file-tools.test.ts` ›「参数非法」与「恶意路径」两组（穿越/盘符/UNC/设备/ADS/保留名/尾随点空格/NUL 等 14 种）；`replay/test/workspace-profile-guard.test.ts`（未知 profile、自定义工具） |
| 6 | 名称冲突和参数非法 | `replay/test/workspace-import-source.test.ts` ›「NFC/NFD 等价名字在同一目录里碰撞 ⇒ 导入整体拒绝」；`workspace-file-tools.test.ts` ›「参数非法」组；`workspace-quota.test.ts`（长度/深度边界） |
| 7 | 二进制字节保持 | `replay/test/workspace-import-source.test.ts` ›「二进制字节按原样保存」；`workspace-file-tools.test.ts` ›「二进制字节保持」组（错误里不含 U+FFFD、原始字节仍可核对） |
| 8 | 缺授权或伪造工具定义 | `replay/test/workspace-profile-guard.test.ts` ›「checkToolProfile：缺授权或伪造工具定义」组＋授权四态 |
| 9 | 写入授权限定于当前世界 | `replay/test/workspace-world.test.ts` ›「世界：授权限定于当前世界」组 |
| 10 | 历史审计标记不能授权新执行 | `replay/test/workspace-profile-guard.test.ts` ›「历史审计标记不能授权新执行」组（含「拒绝原因点明「历史审计标注不能替代本次授权」」） |
| 11 | 父子及并发兄弟隔离 | `replay/test/workspace-world.test.ts` ›「世界：父子与并发兄弟隔离」组；`workspace-isolated-integration.test.ts` ›「兄弟并发」组；`package-api-fixture.test.ts`（附件层隔离） |
| 12 | 内容发布失败和并发去重 | `replay/test/workspace-blob-store.test.ts`＋`workspace-blob-store-injection.test.ts`（注入 I/O 故障、EPERM 退化发布、抢占去重、只清本次临时文件） |
| 13 | 超限导入与运行时超限 | `replay/test/workspace-import-verify.test.ts` ›配额三类边界；`workspace-file-tools.test.ts` ›「运行时配额超限」组；`workspace-quota.test.ts`（上限含边界、UTF-16 单元口径） |
| 14 | LLM 失败仍保留已完成文件事实 | `replay/test/workspace-checkpoint-tracer.test.ts` ›「LLM 失败仍保留已完成文件事实」 |
| 15 | 附件丢失或被篡改 | `replay/test/workspace-read-api.test.ts` ›「附件被删除 → missing」「附件被改成等长的别的内容 → corrupt」；`workspace-isolated-preflight.test.ts` ›「起点附件缺失 → attachment_missing」「起点附件被篡改 → attachment_corrupt」；`workspace-file-tools.test.ts` ›「附件缺失：报工具错误，不静默返回旧内容或回读源目录」 |
| 16 | 中断与数据目录迁移 | `replay/test/workspace-trace-failure.test.ts`（blob 发布后中断：孤立 blob 不成为检查点）＋`workspace-package-recovery.test.ts`（dataDir 整体迁移后解析/读取/续跑，且 trace 内不含绝对路径） |
| 17 | 存储故障释放资源 | `replay/test/workspace-trace-failure.test.ts`（meta 行 / 第 1 轮检查点写失败：抛错收尾、未封存、**句柄开关配对全闭合**、不追加虚假终止事件、不删共享附件） |
| 18 | 包只读接口限定清单与自有步骤 | `replay/test/workspace-read-api.test.ts` ›「清单定位」「读取文件内容」「非法请求与越界路径」（清单外/非法契约路径/形似物理附件/祖先步骤与工具 span/篡改清单 id） |
| 19 | 隔离能力预检无执行副作用 | `replay/test/workspace-isolated-preflight.test.ts` ›「预检零执行副作用」（dataDir 目录树指纹逐项不变，合法与拒绝两类都断言） |

## 3. replay（14）

| # | scenario | A/M | 证据 |
| --- | --- | --- | --- |
| 1 | 崩溃的 run 拒绝分叉 | M | `replay/test/workspace-isolated-preflight.test.ts` ›「父 run 崩溃」；`prompt-replay-run.test.ts` ›「crashed 父 run → 报错、零 LLM 调用、不产生文件」 |
| 2 | 源代码变化拒绝分叉 | M | `workspace-isolated-preflight.test.ts`（`config_hash` 不一致 ⇒ `source_changed`）；`workspace-isolated-replay.test.ts` ›「拒绝时零子 trace、零 LLM」的 system prompt 变化一例 |
| 3 | 分叉点必须是被编辑的 tool.invoke | M | `workspace-isolated-preflight.test.ts` ›「分叉点不存在」「必须存在于直接父自有记录」「必须是 tool.invoke」组 |
| 4 | 普通入口不可降级隔离父本 | A | `replay/test/isolated-entry-guard.test.ts` ›「4.5：隔离父本不得进入普通执行路径」组（判定纯函数 / `replayRun` / `loadForkParent` / `promptReplayRun`，含"不误伤非隔离父本"对照） |
| 5 | 生成分支 run 文件 | M | `replay/test/replay-run.test.ts`（既有）；`replay/test/v1-plain-regression.test.ts` ›「前缀拼接不变」逐项深比较 |
| 6 | 分支 run 再分叉 | A | `replay/test/workspace-isolated-integration.test.ts` ›「4.4 集成：分支 run 再分叉」（三层链 parent / span 序号 / 起点检查点） |
| 7 | 父文件不可变 | M | `workspace-isolated-integration.test.ts`（两处父 trace 逐字节）；`package-api-fixture.test.ts` ›「源目录、父 trace、父附件与兄弟哈希全不变」 |
| 8 | 重跑遇工具报错 | M | `workspace-isolated-integration.test.ts` ›「重跑遇工具报错：错误入 trace、loop 继续，且不去源目录补救」 |
| 9 | 新结果改变后续轨迹 | M | `workspace-isolated-integration.test.ts` ›「新结果改变后续轨迹」 |
| 10 | 创建受控父本 | A | `replay/test/workspace-isolated-run.test.ts` ›「创建受控父本：任务、工具指纹、根关系、文件名与快照全部正确」 |
| 11 | 恢复历史中间文件而非最终文件 | A | `replay/test/workspace-isolated-replay.test.ts` ›「子从那一轮的检查点继续：读到的 a.txt 是 middle 而不是 after」；`package-api-fixture.test.ts` ›主场景 |
| 12 | 同轮多工具及最终轮回退路径 | A | `workspace-isolated-replay.test.ts` ›「编辑同轮 T1：消息含两条工具结果（仅 T1 替换），文件含 T1/T2 原效果，不重做」 |
| 13 | 缺检查点与祖先编辑点拒绝 | M | `workspace-isolated-preflight.test.ts` ›「缺检查点」（由 v2 跨行约束在父链加载期拒绝）与「祖先共享前缀」拒绝 |
| 14 | 卡带路径保持录制结果语义 | A | `trace-test/test/isolated-cassette.test.ts` 三条（附件不可用 + 桩工具一执行就抛仍对齐、两条不同基线各自通过、`runTraceTest` 报告 `mode === "cassette"`） |

## 4. prompt-replay（4，全部既有场景）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | proxy run 拒绝 | `replay/test/prompt-replay-run.test.ts`（三个代理拒绝变体） |
| 2 | 含 config_hash 的 proxy run 放行 | 同上（放行组） |
| 3 | 父 run 未封存 | `prompt-replay-run.test.ts` ›「crashed 父 run → 报错、零 LLM 调用、不产生文件」 |
| 4 | 隔离父本不能转普通 prompt fork | `replay/test/isolated-entry-guard.test.ts` ›「promptReplayRun 拒绝隔离父本：不创建子 run、不发 LLM」 |

## 5. model-experiments（10，全部既有场景）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 创建两个模型分支 | `replay/test/model-replay-run.test.ts` ›「两个 fork run 同父、同 experimentId、config_hash 与父一致、model 分别生效」 |
| 2 | 含 config_hash 的 proxy run 创建 A/B | 同文件 ›「含 config_hash 的 proxy 父 run → 放行创建 A/B」 |
| 3 | 拒绝不可 fork 父 run | 同文件 ›「proxy 缺 config_hash…」「非 proxy 且缺 config_hash…」＋`model-ab-regression.test.ts` ›「crashed 父 run：PARENT_NOT_FORKABLE，零文件、零模型请求」 |
| 4 | 拒绝缺少 system 消息的父 run | 同文件 ›「缺少字符串 system 消息的父 run → 拒绝」 |
| 5 | 带工具的代理父本沿用既有门禁 | 同文件 ›「副作用工具 → 拒绝…」「工具表逐字段不一致…」「sampleTools（含无标记 write_file）…默认门禁拒绝 A/B」＋`model-ab-cli.test.ts` ›「父 run 带工具 → require_empty 拒绝」 |
| 6 | 隔离实验无降级逃生通道 | `replay/test/isolated-entry-guard.test.ts` ›「4.5：模型 A/B 没有降级逃生通道」三条（整批拒绝 / dry-run / 全臂 `allowSideEffects`） |
| 7 | pure 工具实验 | `replay/test/model-ab-regression.test.ts` ›「两臂各自真调 handler，结果只写进自己的 trace（不是桩、不是卡带）」 |
| 8 | 副作用工具阻断 | `model-replay-run.test.ts` ›「副作用工具 → 拒绝，错误文本指明触发工具与首期边界」 |
| 9 | 显式确认副作用后放行并留痕 | 同文件 ›「全批 allowSideEffects → 放行并把声明写进 fork.edit 供审计」＋「只有一臂声明 allowSideEffects → 整批拒绝」 |
| 10 | CLI 遇到带工具的父 run | `model-ab-cli.test.ts` ›「父 run 带工具 → require_empty 拒绝（提示改用桌面端），退出 2、零调用」＋「隔离父本 → 明确拒绝本期不支持隔离 A/B，退出 2、零文件」 |

## 跨段迁移（本段不验收，指向对应段）

| 原任务 | 去向 | 内容 |
| --- | --- | --- |
| 1.1 / 1.3 的 IPC 入口 | B 1.1 | 桌面侧版本守卫入口 |
| 4.5 的桌面 main/IPC 路由 | B 1.2 | 隔离父本拒绝的 IPC 路由 |
| 5.x | B / C | 只读接口 IPC、文件差异与检查点选择 |
| 6.x | B / C | 创建与每次授权、分叉确认、文件 tab / diff |
| 7.1 / 7.3 的桌面断言 | B 3.2 / B 3.1 | 桌面操作断言、纯对话与 fork/A-B/卡带入口回归 |
| **7.4 整块** | **B 3.2 / C 3.1** | 桌面 CDP 跑通创建→分叉→重启轨迹；文件 CDP 与迁移后复查（A 段工时为 0，故本段无 7.4 条目） |
| 7.5 截图部分 | B / C | 目录与确认区截图、文件表/diff 截图 |
| 7.7 真实 `listRuns` 扫描 | B 3.4 | 真实目录扫描、汇总一致性、main 侧成本 |
| 8.1 桌面与文件查看文档 | B / C | 各自的使用说明 |

## 实现期发现（细节见 `tasks.md` 同名章节）

- 1.x：`proxy-recorder` 用 `PLAIN_FORMAT_VERSION`；`run-loop.ts` 字面量 1 保持不动；路径校验的层级与 design 相反（应放 trace-sdk）；"未来版本"基准由 2 改 3。
- 1.2/1.3：路径规则分工必须显式划开；清单 id 重算须接在 reader；两条守卫时机相反（v1 在 parse 前按原始属性、v2 在 parse 后按 kind）。
- 1.4：`fork-run.test.ts` 的概率性失败（`dur_ms` 未归一化）；"只存在于祖先"必须查直接父的 `owned` Map。
- 2.x：`ino` 必须 bigint；符号链接"静默不建"要回查 `existsSync`；`link` 发布成功后仍要删临时文件；退化发布只对"卷不支持硬链接"的码；判据只看已发布内容而非"能救活"；"本 run 新增内容"要排除起点已有哈希；覆盖写不能用追加公式判配额；冻结必须是返回值级新对象；授权不能有默认值。
- 3.x：`readWorkspaceFile` 是 async 且不传 `stepSpanId` 读初始快照；`config_hash` 带 `sha256:` 前缀；`ToolRegistry.execute` 返回 `{result,error,durMs}`。
- 4.x：`fork.resume_after_step` 不是本次分叉边界（父本的历史）；新世界的 origin 是推导值；"缺检查点"在 v2 下不可达；批次完整性必须显式判。
- 7.x：指纹里的相对路径要规范成 `/`；测试目录不在 `tsc -p` 检查范围；**"能 rename 被打开的文件"判不出句柄有没有关**（Node 在 Windows 用 `FILE_SHARE_DELETE`）；trace 写失败的 run 仍会归位成 `<id>.jsonl`（crashed）；最早期失败时原始 I/O 异常会被读取层异常覆盖（**已知行为，未改**）。
- 7.5：`validateSourceRoot` 只在字面路径上判"不适合作根"，`realpath` 后未复判 ⇒ 「链接指向磁盘根」可绕过（**已修**，变异验证）。

## 已知限制（如实记录，不标作通过）

- 树内 **FIFO / socket / 设备**等其他非常规对象：Windows NTFS 上无法在目录里构造，`!isFile() && !isDirectory() → 拒绝` 这条分支未经真机验证。
- **ACL 拒绝导致的"不可读文件"**未构造（代码里读取失败一律 fail closed）。
- 4 条 symlink 用例在开发者模式关闭时显示 `skipped`（不是通过）；junction 三条免特权用例与「能力探针自检」在两种环境下都真跑。
- reader 性能读数只代表**进程内热态**，不是 OS 冷缓存；内存读数是"结果保留时的 heapUsed 增量"而非峰值。
