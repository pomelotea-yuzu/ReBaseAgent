# 审阅：`add-sandboxed-rerun` proposal / design / specs / tasks

- 日期：2026-09-16
- 审阅对象：`openspec/changes/add-sandboxed-rerun/`（proposal.md / design.md / tasks.md / 六份 specs delta）
- 审阅方式：逐条比对仓库实际源码（replay-run.ts、derive.ts、branch.ts、run-loop.ts、tool-registry.ts、fork-runner.ts、run-create.ts、reader.ts、run-repository.ts、主 specs），并核验 OpenSpec delta 纪律（MODIFIED requirement 的场景保留、task→scenario 映射）
- 结论：**方向正确，架构决策成熟，源码依据与 delta 纪律全部核实，无 P1；4 个 P2 建议在实现前钉死或确认。**

---

## 总评

这是目前体量最大的一个 change（v2 格式 + 新能力 + 五个既有能力修改），但工程质量罕见地完整：

- **核心语义对齐正确且被源码证实**：隔离分叉的 messages 起点（分叉点后首次 llm.call 的录制 request.messages，天然包含同轮全部工具结果）与文件起点（该轮全部工具完成后的快照）在语义上恰好对齐——[derive.ts:93-127](file:///d:/ReBaseAgent/packages/replay/src/derive.ts#L93-L127) 的 lookahead 主路径与边界重建路径都消费整轮工具批次，快照取轮末状态，两者不需要任何"半轮状态"就能配对。「编辑的是模型观察，不撤销历史写入」的文件/消息双空间语义自洽且被明确声明。
- **v2 BREAKING 的论证到位**：拒绝降级而非可选字段，直接引用了 zod strip 会静默剥离字段这一已核实事实（tracer.ts:125 经 schema 解析、zod object 默认丢弃未知键）——若用 v1 可选字段，旧桌面 strip 掉 workspace 后同名 `write_file` 就会落到普通 handler，正是版本门禁要防的事故。
- **delta 纪律满分**：全部 9 个 MODIFIED requirement（trace-format×2、replay×3、desktop-ui×3、prompt-replay×1、model-experiments×2）与主 spec 同名精确匹配，且**逐场景比对无一丢失**——每个既有 scenario 都在 delta 中保留（含措辞修订），新增 scenario 均有对应任务反向引用。tasks.md 的「验证」项引用的场景全部实际存在于 delta specs。
- **保真度边界诚实**：导入非 OS 原子快照、并发变化拒绝、无 GC、不宣称 OS 沙箱、网络不在隔离范围——与项目既有惯例一致。

## 源码依据核查

proposal「源码依据」与 design Context 的全部断言经逐一核实，**全部准确**：

| 引用 | 实测 | 结论 |
|---|---|---|
| `replay-run.ts` 复用前缀、后续工具真实执行 | [replay-run.ts:103-121](file:///d:/ReBaseAgent/packages/replay/src/replay-run.ts#L103-L121) | ✅ |
| `deriveReplayState` 消息起点位于整轮工具完成后 | [derive.ts:93-107](file:///d:/ReBaseAgent/packages/replay/src/derive.ts#L93-L107)（lookahead = 下次 llm.call 的录制 messages） | ✅ |
| `derive.ts` 边界路径重建整轮 assistant/tool 消息 | [derive.ts:109-127](file:///d:/ReBaseAgent/packages/replay/src/derive.ts#L109-L127) | ✅ |
| `resolveBranch` 只截到所选工具（遗漏同轮后续兄弟） | [branch.ts:72-77](file:///d:/ReBaseAgent/packages/trace-sdk/src/branch.ts#L72-L77)（`slice(0, idx+1)` 按单 span 截断） | ✅ |
| 桌面 handler 真实读写 `exec.cwd` | [fork-runner.ts:278-321](file:///d:/ReBaseAgent/apps/desktop/src/main/fork-runner.ts#L278-L321)（`resolvePath` 仅做 cwd 包含检查，注释自认"不做沙箱"） | ✅ |
| `main/index.ts` 将 exec.cwd 设为数据目录 | [main/index.ts:140](file:///d:/ReBaseAgent/apps/desktop/src/main/index.ts#L140) | ✅ |
| `ToolRegistry` 捕获一切异常、sideEffect 只是声明 | [tool-registry.ts:50-59](file:///d:/ReBaseAgent/packages/agent-loop/src/tool-registry.ts#L50-L59) | ✅ |
| LLM 失败详情（A4）已实现可沿用 | [run-loop.ts:126-147](file:///d:/ReBaseAgent/packages/agent-loop/src/run-loop.ts#L126-L147)（normalizeFailureText/sanitizeDiagnosticText/errored 收尾） | ✅ |
| 读取器版本拒绝行为 | [reader.ts:72-75](file:///d:/ReBaseAgent/packages/trace-sdk/src/reader.ts#L72-L75)（`version > FORMAT_VERSION` 显式报错）；FORMAT_VERSION 仍为 1 | ✅ |
| 任务验证命令 | [package.json:19](file:///d:/ReBaseAgent/package.json#L19) `check:ci` 存在；desktop 包名 `@rebaseagent/desktop` 带 `build` 脚本 | ✅ |

## P2（实现前钉死或确认）

### P2-1 每步全量快照清单的体积与读取性能未做量级评估

快照行是全量清单：单条 `{path,sha256,bytes}` 最坏约 600 B（路径上限 512 单元），2000 文件上限 ⇒ 单步清单行 ~1.2 MB；桌面 `MAX_ITERATIONS = 10` ⇒ 单个隔离 run 的 JSONL 最坏 ~12 MB。而 [run-repository.ts:17-35](file:///d:/ReBaseAgent/apps/desktop/src/main/run-repository.ts#L17-L35) 的 `listRuns` 在**每次列表刷新时对每个 run 文件做全文件逐行 zod parse**（[reader.ts:32-36](file:///d:/ReBaseAgent/packages/trace-sdk/src/reader.ts#L32-L36)），运行数量积累后列表刷新会被放大。design 的 Risks 只引用配额作为缓解（配额约束的是**内容字节**，不约束清单行的重复总量）。

**建议**：design 补一段量级评估与明确取舍——要么接受该上界并注明，要么为列表扫描路径准备缓解方案（如 meta-only 的轻量读取、快照行惰性解析）。不阻塞正确性，但这是本期引入的唯一系统性性能变量。

### P2-2 v1 拒绝隔离字段的实现机制未写明（zod strip 陷阱）

trace-format delta 要求「v1 SHALL NOT 携带 workspace、step 快照或整轮续跑字段」，验证场景「版本与隔离字段不匹配」存在。但 zod object 默认**剥离**未知键而非报错——v1 文件带 workspace 字段会被 `TraceLineSchema.parse` 静默丢弃，读出来就是一个"合法 v1"，恰好复刻 v2 设计要防的 strip 绕过。行为场景已覆盖，机制却没有着落（`.strict()` 会连带拒绝其他未知字段，波及面大；预 parse 的存在性检查是更小的刀口）。

**要求**：task 1.1 / design 写明 v1 禁字段的检测机制（建议：对 v1 行在 schema parse 前做显式字段存在性检查），并保证只针对隔离字段集而非泛化 strict。

### P2-3 「从第 N 轮结束后继续」的轮号口径未定义

`runLoop` 的 `agent.step.n` 对 fork run 从 1 重新计数（迭代计数不继承父链，span 序号才延续）。对二代分叉（fork 的 fork），确认区与详情里的「第 N 轮」是叶子 run 的内部序号，不是全链视角的第 N 轮；用户对照父/祖轨迹时会产生错位感。

**要求**：desktop-ui 实现时明确文案口径（如「本 run 第 N 轮」或直接以 span 定位），scenario「多工具轮次确认」的断言随之对齐。

### P2-4 `write_authorized: true` 恒真字段的语义需注明

`WorkspaceMeta.write_authorized` 值域只有 `true`——它无法承担任何校验职责（false 形态不存在，篡改成 true 也无从区分），只是"该 run 经授权创建"的审计证据。真正的授权校验是每次请求的 `allowFileWrites`。

**建议**：design/schema 注释明确该字段是**审计记录而非权限判据**（类似 `source` 的标注语义），防止后续实现者把它当门禁条件写出恒真校验；或评估干脆省略。二选一，写明即可。

## 其他确认项（无异议）

- **双边界字段的必要性**：`at_span`（编辑位置）与 `resume_after_step`（整轮边界）分离是对 `resolveBranch` 现状缺陷（截断丢失同轮兄弟）的正确修法，v1 行为不动、v2 修语义的兼容策略稳妥。
- **「分叉工具位于叶子自有 spans」**与 [run-repository.ts:41-50](file:///d:/ReBaseAgent/apps/desktop/src/main/run-repository.ts#L41-L50) 既有 `leafSpanIds` 机制同构，数据通路存在。
- **v2 失败步骤的一致性**：A4 失败路径仍调用 `endSpan(step)`（[run-loop.ts:145](file:///d:/ReBaseAgent/packages/agent-loop/src/run-loop.ts#L145)），wrapper 可注入快照，与「完整 v2 step 必须带 checkpoint」「LLM 失败仍保留已完成文件事实」自洽。
- **配额数字自洽**：快照上限 64 MiB 与新增内容 128 MiB 不矛盾（中间态覆写可产生超量唯一哈希而快照总量有界）。
- **卡带兼容**：shape-align 本就只比 kind/parent/n/tool/args/tool_calls（[shape-align.ts](file:///d:/ReBaseAgent/packages/trace-test/src/shape-align.ts)），快照字段天然不参与；task 4.6 的 fixture 补充正确。
- **删除保护**：既有 `assertDeletable` 的子分支保护 + 「不做 blob GC、禁止单独删共享 blob」组合下，v2 运行删除不会破坏兄弟引用（孤儿 blob 无害）。
- **迁移顺序**（先双读、再存储、后桌面入口，门禁未完成不开放创建）与 tasks 分区一致；「未完成拒绝门禁前不开放隔离创建」防止半成品能力暴露。
- 与「更可视化」方向相容：文件 tab + Monaco 差异 + 确认区双边界展示属于本期必要增量，未引入过度可视化改版。

## 可应用性

**无 P1。** P2-1（性能量级）建议在 design 内补注后 apply；P2-2（v1 禁字段机制）须在 task 1.1 实现前钉死；P2-3 / P2-4 为实现期文案与注释口径，随手收口即可。

## 拆分后归属（2026-09-16）

以上正文保留为原整体 change 的历史审阅，源码行号和“FORMAT_VERSION 仍为 1”等描述反映当时状态，不作为当前实现断言。现已将文档拆为 A → B → C：A 为 add-sandboxed-rerun，B 为 add-sandboxed-rerun-desktop，C 为 add-sandboxed-rerun-file-view；本次仅文档拆分，未实现或归档。

| 原审阅项 | A | B | C |
|---|---|---|---|
| P2-1 全量清单性能 | design §3.1、task 7.7：体积、合法 fixture、完整解析基准 | design §5、task 3.4：真实 listRuns 汇总与主进程扫描实测 | 消费既有读取能力，不替代列表基准 |
| P2-2 v1 strip | task 1.1 已完成 reader；task 1.3 待补 Tracer | task 1.1：RunRecord/RunDetail/祖先元数据的 IPC 原始守卫与往返 | 复用 B 详情校验，自有读取请求另校验 |
| P2-3 轮号口径 | design §6：所属 run、原始 n、step 数据语义 | tasks 1.5/2.2：确认与来源 | tasks 1.2/2.1：文件选择器和来源 |
| P2-4 审计与授权 | tasks 1.2/3.3：schema 审计说明及每次请求授权 | tasks 1.4/2.1：main 与本次操作显式授权 | 查看不授予执行能力 |

trace-format 的详情 IPC 义务迁入 B；workspace-isolation 和 desktop-ui 中的文件显示义务迁入 C。原场景语义按包数据/桌面操作/文件呈现分别验收，不能只靠场景标题保留宣称完整交付。任务映射及工时详见 docs/engineering/plans/2026-09-16-a3-split-plan.md。

拆分后文档核对：A/B/C 共 51 项任务（原任务拆分及各段收口）、91 个场景；原 78 个场景标题无丢失，主 spec 既有场景无丢失，OpenSpec 全量 strict 14/14。性能基准、桌面 CDP、文件哈希和截图验证仍是待实现任务；不因本节追加而标为完成。
