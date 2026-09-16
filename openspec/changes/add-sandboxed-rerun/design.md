## Context

动机及首期范围见 proposal。现有接口足以注入受控工具和 Tracer，无需让纯 TS loop 感知文件系统。必须同时解决三个已核实的问题：原 trace 无文件状态；`deriveReplayState` 的消息起点位于整轮工具完成后；`resolveBranch` 按单个工具截断会遗漏同轮后续兄弟工具。仅切换 `exec.cwd` 无法约束任意 handler、绝对路径或外部写请求。

## Goals / Non-Goals

目标是文件字节及路径集合在轮次边界可恢复，分支间相互隔离，所有新运行的文件状态都有 trace 依据。根运行及子分支使用同一受控工具实现，重启后不依赖内存 workspace。

不提供通用 OS 沙箱。首期能力是受控文件 API 的应用层 COW；不挂载可供 shell 执行的真实项目目录，不运行任意用户代码。保真度边界沿用 proposal。

## Decisions

### 1. 内容寻址附件与分支路径映射

选择应用层 COW：每个文件路径映射到 `{sha256, bytes}`，读工具按当前映射读取不可变内容，写工具先落新 blob 再原子替换当前分支的映射项。clone 只复制映射，不复制文件字节。同一内容可在父子及兄弟间共享，任何 handler 都不能覆盖已有 blob。

原生 overlayfs 需要平台特定挂载；复制整个真实目录仍要逐次处理链接和路径穿越，并不能约束未知 handler。因此本期不采用这两种方案。普通 `read_file/write_file` 与隔离 profile 同名，但实现不可互换；隔离编排自行创建 handler，API 不接受 `Tool[]`。

存储只新增 `<dataDir>/workspace-blobs/sha256/<64位小写十六进制哈希>`，临时 blob 放同目录的 `.tmp-*`。路径只能由已校验哈希生成，工具参数中的逻辑路径绝不拼接到该物理目录。blob 内容的 SHA-256 与文件名及字节数必须一致。采用独占临时创建、写完并刷盘、发布；已存在目标先验证，禁止覆盖。并发发布同哈希只有一个目标文件，失败方清理自己的临时文件。

JSONL 内嵌完整 snapshot 清单，不建立独立可变 manifest。blob 是清单引用的不可变字节附件，单独出现的 blob 不代表运行或检查点；复制备份时必须同时带上引用的附件。不会在未确认引用关系的情况下删除 blob，本期不做 GC。

### 2. 数据契约及版本

```ts
type WorkspaceFile = { path: string; sha256: string; bytes: number };
type WorkspaceSnapshot = {
  id: string;
  files: WorkspaceFile[];
};
type WorkspaceMeta = {
  profile: "file-tools-v1";
  world_id: string;
  write_authorized: true; // 创建方记录本次已确认副本写入，仅供审计，不是执行权限
  initial_snapshot: WorkspaceSnapshot;
  origin: { kind: "import" } |
    { kind: "checkpoint"; run_id: string; step_span: string };
};
```

`snapshot.id` 是对规范化清单 UTF-8 字节取 SHA-256：路径使用 `/`，按 UTF-16 代码单元序比较排序，序列化固定为 `JSON.stringify(files.map(f => [f.path, f.sha256, f.bytes]))`，不依赖 locale、mtime、原目录路径或 OS 枚举顺序。空清单同样有确定哈希。执行前重算验证，schema 验证类型、合法路径、去重及文件/目录冲突；reader 负责跨行与版本关联验证。

- `run.meta.workspace` 携带上述元数据；`world_id` 等于本 run id，每次真实运行新建。
- `agent.step.workspace_snapshot` 保存该轮全部工具完成后的完整快照，由受控 Tracer 在结束 step 时注入。初始快照在首次 LLM 前已就绪。
- 隔离 result fork 另写 `fork.resume_after_step`，指向直接父 run 中编辑工具的所属 step；`fork.at_span` 仍指向被编辑工具，`edit.field=result` 不变。
- v2 隔离 run 必须有 workspace；v1 禁止隔离字段，避免字段被 strip 后绕过门禁。根 v2 origin 必须是 import；分支 v2 origin 必须与 parent/resume_after_step 一致。完整 v2 step 必须带 checkpoint；进程中断时尚未结束的 step 可以没有落盘行。
- `FORMAT_VERSION` 表示最高支持版本 2；增加清晰的普通写入版本常量 1。不要把所有 writer 自动迁到 2：现有 runLoop、代理和卡带仍可产出 v1，wrapper 仅在隔离执行时覆盖 meta 的版本和 workspace。

**v1 禁字段的检测必须先于 schema parse（P2-2）**：读取首个内容行时先取原始 `format_version`；若为 1，在原始对象上用自有属性存在性检查拒绝 `run.meta.workspace` 和对象型 `run.meta.fork.resume_after_step`。后续每条 span 在 parse/safeParse 前，依据已保存版本拒绝顶层 `workspace_snapshot`。属性值即使是 `null`、`false`、空对象（内存输入还包括 `undefined`）也算存在，不用 truthiness。检查只针对上述结构位置，不递归搜索 messages、工具 args 或 result 中同名业务字段。

禁字段检查收敛为无 Node 依赖的纯 helper：reader 的原始行入口、BaseTracer 在 meta/span 被 zod 转换前的入口，以及 RunRecord/RunDetail IPC schema 的原始记录入口共用。BaseTracer 保存本次已校验的格式版本以检查后续 span；v2 的必填/跨行约束另按既有设计验证。不得对整个 v1 schema 加 `.strict()`，其他未知扩展字段仍按原有 strip/passthrough 行为处理；测试同时覆盖三个禁字段和不相关扩展字段，避免为防隔离降级而破坏旧数据兼容。

选择 v2 的原因是执行权限语义发生变化。可选 v1 字段会被旧读取器静默丢掉，旧桌面就可能对同名 `write_file` 使用普通 handler；版本拒绝能阻止这种意外降级。新版本读取旧 trace 不变，未来版本测试改用 3。旧版应用看到 v2 报不支持，不展示部分数据。

### 3. 导入、路径与容量

源目录通过桌面原生文件夹选择器或受控包 API 提供；main 验证真实路径，不允许磁盘根、UNC/设备路径，且源目录与应用数据目录不能相同、互为祖先或后代。选择器只返回本会话的 sourceToken、显示名称和目录路径供确认；sourceToken 在 main 绑定路径，取消选择不生成 token，不导入、不发请求。token 有效期 15 分钟，成功提交创建时消费；执行前重新校验。

导入递归枚举普通文件及普通目录，拒绝符号链接/junction、非普通文件和可检测到的其他 reparse 对象，不静默跳过；父路径也检查 realpath。源文件独立读取后写入 blob，不能创建 hardlink 或保留指向源目录的引用。hardlink 源文件按字节分别采集，导入后解除文件身份关联。空目录不进入契约，不保存 ACL、mtime、执行位或链接身份。不默认略过 `.git` / 隐藏文件；用户必须选定专用数据目录，UI 提示选定范围内文件均会被采集。

导入前后两次枚举并核对文件集合、大小、标识和内容哈希，期间任何可观察变化、读取错误或不支持项均拒绝且零 LLM。无法用纯 Node 保证对恶意并发替换的 OS 原子采集，明确要求采集期间源目录静止；这不是对同用户恶意进程的防护承诺。

逻辑路径采用 Windows 可移植子集：相对路径，`/` 为分隔符；工具输入的 `\` 规范化为 `/`，拒绝绝对/盘符/UNC/设备路径、空段、`.`/`..`、NUL、冒号/ADS、Windows 保留设备名、尾随点/空格。路径最长 512 个 UTF-16 单元、深度最多 32。同一世界以 Unicode NFC + 小写路径键检测碰撞，但保留原显示路径；不允许文件既是文件又是另一文件的祖先。导入时名称不兼容或碰撞即拒绝，不隐式改名；工具写入也用相同校验。

首期固定配额集中定义：最多 2000 个文件；每文件 8 MiB；当前快照合计 64 MiB；一次运行新增的不同内容字节最多 128 MiB（以本 run 实际产出的唯一哈希集合求和）。零字节文件合法，超限整次导入拒绝；运行中的超限写入成为工具错误，保持旧映射，loop 可继续。配额不是授权开关，renderer 不能加大上限。

### 3.1 清单体积与列表读取取舍（P2-1）

文件字节配额不限制清单重复体积，blob 去重也不会减少 JSONL 中每轮的完整清单。桌面默认最多 10 轮，连同初始状态共 **11 份**清单；若包 API 使用不同迭代预算，则清单数量按实际完成轮数加一计算，不能把 10 轮当所有运行的格式上限。

以下是 2026-09-16 用 Node `Buffer.byteLength(JSON.stringify({id,files}),"utf8")` 对合成清单计算的序列化字节量，**不是磁盘读取或 zod 性能实测**：2000 个文件，路径各 512 个 UTF-16 单元、8 段组成，四位 ASCII 唯一编号，其余分别填 ASCII 或中文字符；每个 bytes=32768、哈希均为 64 位。表中 MB 采用十进制，包含快照 id/files，不含所在 meta/step 其他字段、messages、tool result 或换行。

| 路径样本 | 单份清单 | 11 份清单/运行 | 50 个运行的重复清单 |
|---|---:|---:|---:|
| ASCII 长路径 | 1,228,083 B（约 1.23 MB） | 13,508,913 B（约 13.51 MB） | 约 675 MB |
| 中文长路径 | 3,232,083 B（约 3.23 MB） | 35,552,913 B（约 35.55 MB） | 约 1.78 GB |

这两个样本不是整个 trace 的硬上界：UTF-8 编码、JSON 转义和模型消息还会增加体积。以每个路径代码单元最多产生 6 个 JSON 编码字节作保守包络，单份清单约可到 6.4 MB、11 份约 70 MB，仍不含请求/响应数据。实际 fixture 须按本期合法路径集合生成，不把不存在的非法文件名当运行样本。

**首期明确接受全量清单及现有逐文件完整读取的代价**，定位于少量本地调试运行，不承诺数十个满配额运行的即时刷新。`listRuns` 继续完整校验 JSONL，不读 blob；不改成 meta-only，因为列表中的步数、用量和终止原因来自 spans/events，meta-only 不能给出等价结果。本期也不加入惰性快照校验或持久化摘要缓存，避免改变损坏记录判定和事实源规则。代价包括同步 main 扫描期间的等待，不能用“64 MiB 内容配额”宣称该问题已解决。

实施任务 7.7 必须运行可复现的 1/10/50 run 扫描基准，分别使用短路径和接近上限的 ASCII/中文路径、每 run 初始加 10 个 step 快照，附普通 v1 对照。记录文件总字节、机器/Node 版本、首次进程扫描及重复扫描耗时、峰值内存和列表结果一致性；首次进程扫描不冒称已清空 OS 文件缓存。基准不作为机器相关的单测时间阈值，不删减清单换取漂亮数字。若实测等待不可接受，应先修订 change 增加明确的读取优化设计和对应测试，再开放该规模的产品承诺；当前文档没有宣称性能已达标。

### 4. 固定工具与授权

`file-tools-v1` 定义固定的两个工具及参数 schema：`read_file({path:string})` 返回 UTF-8 文本，`write_file({path:string,content:string})` 写入完整 UTF-8 内容并返回逻辑路径/字节数。非 UTF-8 文件可进入快照并保持字节，但读取为文本时报工具错误，不做有损转码；写文件创建必要的逻辑父目录。两者拒绝额外参数及错误类型，不使用 `String()` 强制转换 content。

profile 定义、handler、参数校验和逻辑路径校验由 replay 的同一个模块提供。`read_file.sideEffect=false`、`write_file.sideEffect=true`，指纹包含原定义，不能给写工具改标记来放行。创建/分叉每次必须显式 `allowFileWrites:true`；此授权只覆盖副本，不是网络、数据库或宿主写入许可。启动前核对完整工具表与指定 profile 逐字段一致（含顺序及 sideEffect 存在性），缺标记、未知 profile、任意自定义 handler 均拒绝。

**保留 `write_authorized:true` 作为审计标注（P2-4）**：它只表示创建方声称该次运行经副本写入确认，不能证明历史文件未被篡改，也不是可转移的权限凭证。schema 的恒真约束只保证记录形状一致；本次执行唯一的副本授权输入是当前请求的 `allowFileWrites:true`，仍须叠加 profile、路径和快照等门禁。即使父 trace 带该标注，或调用方伪造同名字段，本次请求未确认也必须拒绝；不得从父 meta 推导、补齐或默认勾选本次授权。该区分须写入 schema/类型注释。

世界实例被绑定在工具闭包中；`exec.cwd` 不参与文件定位，传递的值只是受控运行上下文，不作为路径能力。不要调用普通桌面 `attachHandlers`，不要向 handler 暴露源路径或物理 blob 根。未知模型工具调用仍由 ToolRegistry 记录错误，不执行外部命令。

### 5. 隔离编排与检查点 Tracer

模块建议位于 `packages/replay/src/workspace/`：清单与路径、blob store、受控工具、checkpoint tracer、root/fork 编排分离；不另建 workspace 包。核心导出 `createIsolatedRun` / `replayIsolatedRun`，输入显式 store/outDir/config 和 source 或 parent 定位；不接受工具 handler、renderer 路径或可执行脚本。内部新生成 id，root 用 Tracer wrapper 覆盖 startRun 的 id，fork 沿用 `ForkRunMeta`。

wrapper 实现既有 Tracer 接口并委托真实 JsonlTracer：startRun 注入 v2 workspace；startSpan 跟踪本次 id/kind；endSpan(agent.step) 在所有顺序工具完成后，把当前映射冻结成清单与 `workspace_snapshot` 一起提交。文件 blob 在工具返回成功前已经发布并持久化，checkpoint 只是纯清单快照，不需要在 loop 内等待异步复制。subscribe 委托底层，订阅者拿到带 checkpoint 的最终 span。仅扩展 trace-sdk `EndSpanPatch`，不新增 loop 生命周期回调，不把文件状态放进 messages。

隔离根创建先完成 settings、参数、source/profile/授权/配额校验与导入，再创建临时 trace 并调用 loop；完成或 errored 后按照 meta.id 归位。源目录仅在导入阶段读取，执行不再访问它。

隔离分叉按顺序验证：父链存在无环且已封存；直接父是 v2 workspace；分叉工具位于叶子自有 spans；所属 step 和完整 tools 批次存在；profile、config_hash、edit 与快照来源合法；所有快照 blob 字节数和哈希正确。然后复用 `deriveReplayState` 获取下一轮 messages，新世界从该 step 的快照复制映射。缺失快照时拒绝，绝不用父最终状态或当前目录兜底。通过全部预检后才创建子 trace/发 LLM，沿用父链最大 span 编号，执行后续工具并记录新 checkpoint。

相同数据源上的两个并发分支有独立映射、授权、tracer、LLM client 与新增字节集合；blob store 共享不可变内容。loop 终止后释放世界实例，不恢复或改写源目录。

### 6. 整轮边界与只读展开

`deriveReplayState` 已消费整个工具批次的结果；例如同轮 T1 写 a、T2 写 b，选 T1 改结果后，文件起点必须包含 a 和 b 的原写入。禁止重做 T1/T2，也不能回滚 T1 写入以“配合”编辑文案。

v2 `resolveBranch` 依据 `resume_after_step` 保留该 step 及所有后代，验证 at_span 属于该 step；v1 保持按 at_span 截断的原行为。branch resolver 只拼接记录，不加载 blob、不应用 result 编辑。隔离重跑必须从直接父的原始自有记录取 checkpoint，不能从拼接后的祖先 spans 猜测。

**轮号以所属 run 为单位（P2-3）**：`runLoop` 对每个 fork 都从 `agent.step.n=1` 开始，只有 span id 序号延续父链。共享展示模型携带 `{ownerRunId, stepSpanId, localIteration}`，localIteration 直接取所属原始记录的 step.n，不能按合并数组位置或祖先轮数累加。确认区显示“从运行 {parentRunId} 的第 N 轮结束后继续”，并提供 step span 定位；当前运行的文件选择器显示“本 run 第 N 轮结束”。查看子运行的来源仍展示来源父 run id，不能把父轮号称作子运行轮号。二次分叉 B→C 即使 A 已有 3 轮，也应显示“运行 B 的第 1 轮”，不能显示“第 4 轮”。

对所有公共真实执行入口增加同源门禁：`replayRun` 拒绝 workspace 父本；`loadForkParent` 为 prompt/model 提供隔离父本拒绝，调用方提前捕获为可操作错误；`allowSideEffects` 与 dry-run 不覆盖该拒绝。Trace-as-Test 使用录制结果与桩工具，不加载 blob，结构对齐忽略 workspace 快照字段，不宣称在真实文件世界执行。

### 7. 桌面接口与用户流程

| 接口 | 契约 |
|---|---|
| `workspaces:chooseSource` | 原生目录选择，返回 sourceToken/显示路径或取消；只读，无 blob/trace 写入 |
| `runs:create` | 旧请求不变；可选 `workspace:{mode:"isolated_files",sourceToken,allowFileWrites:true}` 分流至隔离根编排 |
| `runs:fork` | 旧请求保持 legacy 行为；隔离请求增加 `execution:{mode:"isolated_files",allowFileWrites:true}`，main 依据父类型严格匹配，禁止漏传后降级 |
| `workspaces:inspect` | `{runId, stepSpanId?:string}`；缺省取本 run 初始快照，指定 step 仅限本 run 自有；返回清单、与初始状态的新增/修改标记及附件可用性 |
| `workspaces:readFile` | `{runId, stepSpanId?:string,path}`；只能读该清单引用的文件，返回文本或二进制/缺失/损坏状态；不接受任意 blob 路径 |

新接口都走统一 IPC 信封和 zod，renderer 零 fs。用户目录选择属于只读授权，只有显式创建/分叉能持久写数据。新创建失败仍返回 `CREATE_RUN_FAILED` 且已落盘运行可查看，其他预检错误沿用信封并提供 `WORKSPACE_*` 分类；不往信封塞密钥或任意物理 blob 路径。

“新建运行”使用模式分段控件：纯对话为默认，隔离文件模式显示选定目录和“允许副本内写入”复选框，每次新操作均由当前请求确认，不继承历史审计标记。隔离 result 编辑的确认区展示父 run、编辑工具、按所属 run 标注的整轮续跑边界、step span 定位、快照标识和将调用的模型；提交期间禁用重复动作，不编造进度百分比。旧 trace 隔离入口禁用并说明“未录制文件检查点”；隔离父本的 prompt/A-B 禁用且说明首期范围。

详情新增“文件”tab，与既有轨迹详情并列：本 run 初始/各完成轮次快照选择器，紧凑文件表（路径、大小、变更、附件状态），选中文本用现有懒加载 Monaco DiffEditor 查看初始/当前内容。二进制显示字节与哈希，不尝试文本渲染；长文件不静默截断，可折叠和滚动。窄窗口以列表/内容切换展示。全部查看只读，无回写/应用按钮；文件缺失时轨迹仍可读，重跑不可用。

### 8. 生命周期、故障和配额

预检校验失败不创建 trace、不调用模型。导入 I/O 失败可能留下已经发布但未被引用的 blob，不能作为 checkpoint 使用；仅删除本请求自己的临时文件，已发布 blob 留待未来 GC，不冒险删除共享内容。元数据发布之前的孤立内容不破坏 JSONL 的事实源地位。

写工具发布 blob 失败时旧映射保持不变，按既有 tool error 继续；普通工具异常不产生半写入文件。LLM 失败沿用 A4 的详情与 errored 收尾，step 快照仍可记录已有状态。trace I/O 故障/进程中断允许保留未封存 trace，禁止从其分叉；不制造成功终止事件、不删除父记录，需为新编排提供释放 JsonlTracer 文件句柄的异常清理路径（close/dispose 不写终止事件）。正常终止和异常退出都只释放本次资源。

冻结快照先于该步下一次 LLM；中断后只承认已落盘的检查点。dataDir 整体可移动，引用不带绝对路径；只复制 JSONL 会保留轨迹但丢文件附件，读取界面必须明确指出此状态。新文件最多由现有迭代/用量预算及额外文件配额限制，运行记录长期积累的总磁盘占用不在单次配额内。

## Risks / Trade-offs

- 应用层隔离容易被误解为 Docker/OS 沙箱：产品命名使用“隔离文件运行”，文档明确固定工具组和外部状态边界。
- Windows 路径/链接与并发采集：运行阶段不打开用户逻辑路径；导入严格预检并核对两遍，对不支持类型失败关闭；受控测试覆盖平台路径与可创建的链接，不能创建链接的 CI 须报告跳过并补 Windows 验证。
- v2 不能被旧桌面读取：限制到新隔离产物，保留 v1 writer；使用旧 schema fixture 验证明确拒绝，不做自动降级导出。
- 快照清单在每轮重复、列表全量解析成本线性增长：接受 §3.1 的体积和等待代价，实施时用任务 7.7 量测；内容配额与 blob 去重不解决清单膨胀。附件长期增长另受单次配额约束，不在首期加入高风险 GC。
- 明文源文件可能敏感：目录选择时展示采集范围与 provider 读工具文本的事实，不把密钥设置目录纳入 source；应用不声称加密所有附件。
- 多工具轮次边界容易与用户直觉不符：记录两个边界字段，确认与详情同时展示编辑位置及继续执行时点，测试证明同轮兄弟不会丢失或重执行。

## Migration Plan

先完成 v1/v2 双读与普通 writer 兼容，再增加受控存储和隔离编排，最后接桌面入口；未完成拒绝门禁前不开放隔离创建。所有新增任务保持未完成，不能以文档状态替代代码验证。

历史 JSONL 不迁移、不重写，不添加伪快照。回退到旧应用只能查看 v1；v2 和附件保留，待升级读取，不能降低版本号绕过。既有普通重跑仍按其旧能力执行，UI 不把它标成隔离执行。发行前通过源码门禁、桌面完整构建及受控三轮文件读写冒烟，不要求真实 provider 或付费 API。

## Review Resolution

2026-09-16 审阅的四项 P2 已落实为以下设计与待验收任务；这不是实现完成记录。

| 审阅项 | 约束与验收落点 |
|---|---|
| P2-1 全量清单性能 | §3.1 量级、首期取舍、任务 7.7 扫描基准；内容配额不再被表述为清单体积的缓解 |
| P2-2 v1 strip 绕过 | §2 原始对象禁字段检查；trace-format 场景、任务 1.1/1.3 覆盖 reader/Tracer/IPC |
| P2-3 轮号歧义 | §6/§7 所属 run + 本地轮号 + span 定位；desktop-ui 二次分叉场景、任务 5.4/6.2 |
| P2-4 恒真审计字段 | §4 保留但不赋权；trace-format/workspace-isolation 约束、任务 1.2/3.3/6.1 |
