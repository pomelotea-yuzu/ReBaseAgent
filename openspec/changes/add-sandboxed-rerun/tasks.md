本段保留原任务编号以追踪历史；5/6 阶段迁到 B/C。拆分片段的 A 后缀是原任务归属，不增加重复任务。预算 41h，含已完成 1.1 的 2h；1.2 部分进度保留。全部专项场景在本段五份 delta 中，公共全仓回归和桌面构建仍须运行。完整迁移表见 docs/plans/2026-09-16-a3-split-plan.md。

## 1. Trace 版本与检查点契约

- [x] 1.1 扩展 trace-sdk v1/v2 schema、普通写入版本常量及导出；实现共用的原始对象禁字段 helper，在 reader 的 parse 前按 v1 自有属性存在性检查 workspace/fork.resume_after_step/span.workspace_snapshot，不泛化 strict（2h）。验证：`trace-format/双版本与旧读取器`、`未来版本文件`、`版本与隔离字段不匹配`、`v1 禁字段与其他扩展区分`，包含 null/false/空对象；普通 writer 默认 v1，旧 fixture 拒绝 v2，未来版本用 3。**（reader 入口已接；Tracer 入口按 A 1.3 继续，IPC 入口迁 B 1.1。实现：`FORMAT_VERSION=2` 最高支持 + `PLAIN_FORMAT_VERSION=1` 普通写入 + `FormatVersionSchema` 双读；`version-guard.ts` 纯函数三处共用，存在性判定用 `hasOwn`（null/false/{}/显式 undefined 都算存在）；v2 另有"meta 必须带 workspace"约束。新增测试 16 个）**
- [x] 1.2 实现快照清单与 workspace/origin schema、规范排序和哈希验证，区分 renderer 可用纯 schema 与 Node 字节哈希模块；在类型及 schema 注释注明 write_authorized 仅是审计标注、不授予新执行权限（2h）。验证：`trace-format/非法清单拒绝`，包含空清单、乱序、重复/冲突路径、hash/bytes 与 origin 非法输入，并核对审计字段文档。**（已完成：`workspace-snapshot.ts` 纯校验（路径结构 / 规范序 / 重复 / 文件目录冲突 / origin 自洽）+ `workspace-hash.ts` Node 哈希（规范排序、id 计算与重算），`superRefine` 接入两端 schema，reader 读取时重算 id；新增 33 用例，含空清单与 ASCII/中文**金标准哈希**。⚠️ 路径只做通用结构规则，平台特性与长度/深度留 2.1；详见「实现期发现」）**
- [x] 1.3 扩展 step EndSpanPatch、读取端跨行约束及 BaseTracer 转换前版本守卫，完整保留事件、JSONL、MemoryTracer 的合法元数据；IPC 部分迁 B 1.1（1.5h）。验证：`trace-format/根与分支快照往返`、`无附件仍能看轨迹`、`v1 禁字段与其他扩展区分`，含自有 undefined；纯解析不读 blob。来源：原 1.3-A。**（已完成：`EndSpanPatch` 增可选 `workspace_snapshot`（仅 agent.step）；BaseTracer 在 `startRun` / `endSpan` 的 zod 转换**之前**跑 `findVersionFieldViolation` 并记住本次版本供 span 判定；reader 增 v2 跨行约束（**已落盘**的 `agent.step` 必须带检查点——半途中断的 step 不会有行，故缺快照只可能是写入端漏注入）；新增 16 用例覆盖根/分支往返、空清单往返、无附件解析、三处 v1 禁字段与无关扩展放行。IPC 入口归 B 1.1）**
- [x] 1.4 扩展 fork.resume_after_step 和 resolveBranch 的 v2 整轮截断，v1 行为不变（2h）。验证：`trace-format/编辑工具结果后分叉`、`隔离分叉保留同轮兄弟工具`、`隔离续跑边界矛盾`。**（已完成：`resolveBranch` 按格式版本分流 —— v2 走 `resolveWholeRound`：前缀保留边界 step 及**其全部后代**（子树按语义序一遍扫描收集，祖先不紧邻后代故不能只比相邻）；边界必须存在于**直接父自有记录**且为 `agent.step`、`at_span` 须属该轮（沿 parent 链上溯可达）且不得等于 step 本身；v1 保持按 at_span 截断的旧规则，并配了**同结构对照用例**证明 v1 会丢同轮兄弟而 v2 保留；schema 层同步加"v2 分支必须携带 resume_after_step"的必填约束。9 个新用例含 5 种边界矛盾。多级 v2 链逐级拼接有正向用例）**
- [x] 1.5 给 JsonlTracer 增加异常清理能力，只关闭当前句柄而不写终止事件；接入新编排的 finally 路径前先测资源语义（1h）。验证：`workspace-isolation/存储故障释放资源`，未封存状态保留、重复释放无副作用。**（已完成：`JsonlTracer.dispose()` —— 只关句柄、**不写终止事件**，文件保持"未封存"（readRun 判 crashed，事故现场原样保留）；幂等（句柄已关 / 已封存 / 从未 startRun 均无副作用）；dispose 后写入按"文件未打开"抛错。**接入编排 finally 归 4.1**（`createIsolatedRun`），本任务只交付资源语义与测试，不提前接线。4 个新用例）**

## 2. 文件世界存储与导入

- [x] 2.1 在 trace-sdk 增加无 Node 依赖的共用逻辑路径校验，在 replay 定义固定配额并复用校验（1.5h）。验证：`workspace-isolation/恶意路径与未知工具` 的路径部分、`名称冲突和参数非法` 的路径部分、`超限导入与运行时超限` 的长度/深度边界，覆盖 Windows ADS/UNC/设备名、NFC 和大小写碰撞。**（已完成：trace-sdk 新增 `logical-path.ts` —— `normalizeLogicalPath`（工具输入 `\`→`/`，只做分隔符）、`findLogicalPathViolation`（判定序固定：整串形状 → 段结构 → 长度 512/深度 32 → 逐段平台规则；覆盖 UNC/设备前缀、绝对、未规范化分隔符、尾随空段、空段/点段、冒号 ADS 与盘符、保留设备名（含 CONIN$/CONOUT$，"段名主体"按第一个点截断）、尾随点/空格）、`logicalPathCollisionKey`＋`findLogicalPathCollisionViolation`（NFC + 小写折叠，键折叠**不改写显示路径**）。`workspace-snapshot.ts` 改为复用该契约并把碰撞并入清单校验：1.2 那条"平台特性规则不在此层"的用例已按约定翻转为应拒绝（见「实现期发现」）。replay 侧新增 `src/workspace/quota.ts`：`WORKSPACE_QUOTA`（2000 文件 / 8 MiB 单文件 / 64 MiB 快照 / 128 MiB 新增内容；路径两项**引用 trace-sdk 常量**，本包不写字面量）、`findFileSetQuotaViolation`（导入与运行期共用同一份判定，顺序固定：文件数 → 单文件 → 合计）、`findNewContentQuotaViolation`；三者随 replay index 导出，且**不接受 quota 参数**（配额不是授权开关）。新增 19 + 10 用例，钉住上限含边界、零字节合法、UTF-16 单元口径（代理对记 2、512 个中文字记 512 单元而非 1536 字节）与全部平台特性/碰撞形式。接线不在本任务：导入两遍核对与 LLM 前拒绝归 2.4，运行期超限转工具错误归 3.2，快照/新增配额的派生归 2.5；设计未列举的其余 Windows 禁字符（尖括号、竖线、问号、星号等）与控制字符仍放行，收紧须先改 spec（已记入 design §3）。**）**
- [x] 2.2 实现内容寻址 blob 发布与读取，并导出按已校验 run/自有检查点/逻辑路径定位的包只读接口，临时独占创建、刷盘、并发同哈希去重、不覆盖既有内容（2h）。验证：`workspace-isolation/内容发布失败和并发去重`、`附件丢失或被篡改`、`包只读接口限定清单与自有步骤`，注入 I/O 失败并确认只清本次临时文件。**（已完成：`src/workspace/blob-store.ts` —— `WorkspaceBlobStore` 落在 `<dataDir>/workspace-blobs/sha256/<hash>`，临时文件同目录 `.tmp-*`；发布 = 独占创建（`wx`）→ 写入 → `fsync` 刷盘 → **排他发布**（先 `link`；卷不支持硬链接时退化 `COPYFILE_EXCL`）；既存目标**先验证**：命中即去重、校验不符则拒绝覆盖；**任何路径都不留临时文件**，失败只删本次那一个；`blobPath` 只接受 64 位小写十六进制 ⇒ 物理路径不可能由逻辑路径拼出。`src/workspace/utf8.ts` 严格 UTF-8（非法即二进制，保留 BOM，不做编辑器式改写）。`src/workspace/read-api.ts` —— `locateWorkspaceSnapshot` / `readWorkspaceFile` 按 dataDir + runId + 可选 stepSpanId 定位**本 run 初始快照或自有完成步骤的检查点**，返回 text / binary / not_found / missing / corrupt / rejected 六态；不写 trace/blob、不调 LLM、不要求 run 已封存。新增 28 用例：并发同哈希（异步链真交错，断言与调度顺序无关）、注入 I/O 故障（EIO 抛错且只清本次临时文件、陌生临时文件与既有附件不动）、EPERM 退化发布与退化时的抢占去重、既存目标损坏拒绝覆盖、长度不符与内容不符两种 corrupt、附件缺失、清单外/非法契约路径/形似物理附件的路径、祖先步骤与工具 span 拒绝、篡改清单 id（reader 重算后映射为 `trace_invalid` 并保留原始原因）、读取前后目录树指纹逐项一致。⚠️ 两处刻意偏离/澄清：① blob store 用**异步 fs**（本仓其余 fs 是同步风格）——设计要求的"并发去重"只有异步实现才真交错，否则用例只能测顺序语义；② **读取不要求 run 已封存**（崩溃 run 已落盘的检查点正是事故现场，读取不是分叉）。未做：失败写入的错误转换与旧映射保持归 3.2，分叉前全清单附件核对归 4.2。**）**
- [x] 2.3 实现 source 根校验与普通文件采集（2h）。验证：`workspace-isolation/拒绝链接及不合适的根目录`、`二进制字节保持`；独立读取 hardlink 字节，不保留链接；隐藏文件不静默跳过。**（已完成：`src/workspace/import-source.ts` —— `validateSourceRoot`（同步判定：参数形状 → UNC/设备前缀、驱动器相对形式、磁盘根 → realpath 存在且为目录 → dataDir 做"解析已存在祖先"归一 → 相同/互为祖先后代一律拒绝；Windows 下路径比较折叠大小写）与 `collectSourceFiles`（内部**再跑一次根校验**，不信任调用方预检；递归枚举普通文件与普通目录，逐条 `lstat` 检出符号链接/junction，逐条校验逻辑路径契约，逐文件**独立读取字节**并发布到附件存储，返回规范序 `files` 与含 `ino`/`mtimeMs` 的 `entries`）。设计决定：**根自己是链接时按 realpath 解析一次**（设计要求的是"源目录**包含**链接时拒绝"，根是调用方显式给的入口），树内链接与非常规对象一律拒绝、不跟随也不跳过；名称碰撞（NFC + 小写）与超深/超长路径在导入期就拒，不隐式改名。`entries` 只活在内存里供 2.4 两遍核对、**不进快照** ⇒ 不保留链接身份。新增 17 用例（其中"文件符号链接被拒"初版因本机缺创建权限显示 skipped；**2026-09-18 09:35 开启开发者模式后本机可创建文件符号链接，该用例已转为正常执行——实测 `AllowDevelopmentWithoutDevLicense=1` 后新进程立即生效、无需重新登录，`symlinkSync(file, link, "file")` 真的建出条目且 `lstat().isSymbolicLink()` 为真，重跑得 17 passed / 0 skipped**）：根形态与祖先关系、目录 junction（含悬空）、文件符号链接、NFC/NFD 碰撞、33 段超深、二进制字节与附件内容逐项核对、hardlink 双条目同哈希同 ino 而快照只留路径/哈希/字节、隐藏文件与 `.git` 不跳过、采集不建运行、根不合法时零副作用。**）**
- [x] 2.4 补两遍集合/内容核对、导入配额和失败收尾（1.5h）。验证：`workspace-isolation/采集期间变化被拒绝`、`超限导入与运行时超限` 的导入部分，变化/超限零 LLM、零 trace，孤立 blob 不成为可用快照。**（已完成：`import-source.ts` 拆成"三段 + 导入入口"——`collectSourceFiles`（第一遍：读字节、发布附件、记录 `ino`/`mtimeMs`）、`verifySourceTreeUnchanged`（第二遍：**只读、不发布**，重算集合并逐条比对标识/大小/内容哈希）、`importSourceTree`（导入入口 = 根校验 + 两遍 + 配额，4.1 用它）。配额两处落点：**读之前**按 `lstat` 大小逐条判（`quota.ts` 新增 `findAppendQuotaViolation`，避免先把 2 GiB 读进内存再拒），读完后再用 `findFileSetQuotaViolation` 对整个集合做权威复核（防文件在 `lstat` 与 `read` 之间变大）；两处上限与边界完全一致，多条违规共存时报错顺序可能不同，已写进注释与用例。失败收尾：不写 trace、不建运行、不调模型；已发布附件作为**孤立内容**保留（不删可能与别处共享的内容），临时文件由附件存储自清。变化检测用 `testHooks.betweenPasses`（受控测试注入点——设计把这条写成"受控测试"，靠竞态撞窗口是假证据）。新增 14 用例（replay 173→187）：内容/大小/新增/删除/标识五类变化（标识那条用"删掉再硬链接成另一个文件"构造）、第二遍出现链接、**第二遍不发布**（改后的内容在附件存储里查不到）、配额三类边界（8 MiB 恰好合法而 +1 在读取前被拒且未发布；2001 文件；64 MiB 恰好合法而 +1 被拒）、拒绝后零 trace / 无临时残留 / 孤立附件经读接口只得 `run_not_found` / 根不合法连附件目录都不建、追加判定与集合判定结论一致。**）**
- [x] 2.5 实现分支独立映射、冻结快照及当前/新增内容配额派生（2h）。验证：`workspace-isolation/父子及并发兄弟隔离`、`导入后源目录变化不影响运行`、`写入授权限定于当前世界`，逐字节/hash 核对源与父状态不变。**（已完成：`src/workspace/world.ts` —— `WorkspaceWorld` + `createWorkspaceWorld`。世界 = 独立映射表（`path → {sha256,bytes}`）+ 附件存储：`listFiles()` / `snapshot()` 都返回**规范序副本**（后者重算 id，发出之后再写不影响它）；`fork({allowFileWrites})` **复制映射不复制字节**、共享附件存储、**新增内容计数从零开始**；`readFile` 走附件校验（`not_found`/`missing`/`corrupt` 可辨、不读源目录）；`writeFile` 顺序固定为"全部检查 → 发布附件 → 替换映射"，配额或发布失败时映射与计数都不变；`quotaUsage()` 派生 `fileCount` / `snapshotBytes` / `newContentBytes`。配额：新路径走 `findAppendQuotaViolation`（O(1)），**覆盖写**走 `findFileSetQuotaViolation`（合计要减掉旧那份，不能用追加公式）；新增内容按"本 run 写入过的唯一内容，**排除起点快照已有的哈希**"计。建世界先过 `WorkspaceSnapshotSchema` + id 重算（世界里的映射会成为检查点的事实源）。授权：`allowFileWrites` **必填无默认**、**fork 不继承**，未授权世界写入一律 `not_authorized`。新增 17 用例（replay 187 → 204）：读写与配额派生（去重、覆盖计账）、冻结快照不被后续写入影响、非法起点清单被拒、父子与并发兄弟隔离（源目录逐字节指纹不变 + 父快照 id 不变 + 清单互不可见）、同内容共享附件（存储里只有一份）、子世界新增内容计数从零起、授权不继承不传染、`fork` 缺参数按只读 fail closed、导入后源变化不影响运行、三类上限边界（8 MiB / 2000 文件 / 64 MiB / 128 MiB 均"恰好合法、+1 被拒"）、发布失败映射不变。**）**

## 3. 受控工具与 Tracer 适配

- [x] 3.1 实现固定 file-tools-v1 定义和受控 read_file，绑定世界对象、严格参数及 UTF-8 解码（1h）。验证：`workspace-isolation/二进制字节保持`、`名称冲突和参数非法` 的读取参数部分，不使用宿主 cwd 查找文件。**（已完成：`src/workspace/file-tools.ts` —— `FILE_TOOLS_V1_PROFILE` / `READ_FILE_TOOL_NAME` / `WRITE_FILE_TOOL_NAME` / `FILE_TOOLS_V1_DEFINITIONS`（两个工具的**固定定义**：顺序、JSON Schema、`sideEffect` 都写死并 `satisfies` 窄化；`read_file.sideEffect=false` / `write_file.sideEffect=true`，`parameters` 声明 `required` + `additionalProperties:false`）、`parseReadFileArgs`（严格四步：普通对象 → 只认已知键 → path 为非空字符串（**不 `String()` 强转**）→ `normalizeLogicalPath` **再** `findLogicalPathViolation`）、`createFileToolsV1(world)`（**世界实例进闭包**，不接受外部 `Tool[]`；顺序与定义一致）、`makeReadFileHandler`（解析 → `world.readFile` 按**当前映射**取字节 → `tryDecodeUtf8`；**六态映射**：文本返回、非 UTF-8/`not_found`/`missing`/`corrupt` 抛 `FileToolArgsError`（错误是数据，ToolRegistry 转成 `tool.invoke.error`））、`makeWriteFileHandler`（**3.2 占位**：报"尚未实现"，既不落到桌面 `writeFileSync` 也不静默成功）。`ctx` 刻意不使用 —— `exec.cwd` 不是路径能力（A design §4），因此工具不可能被 cwd 引去碰宿主文件。新增 39 用例（replay 204 → 243）：定义指纹与 profile 名、schema 声明、`createFileToolsV1` 产物与固定定义逐字段相等；读世界内容（含 `\` 规范化、写后立即读回环、路径不存在 / 附件缺失可辨）；**二进制字节保持**（非 UTF-8 报错且**断言错误里不含 U+FFFD**、错误带 sha256 与字节数、原始字节仍可从附件接口逐字节核对、空文件合法、BOM 保留）；参数非法 8 种（缺 path / 额外键 / 数字 / null / 空串 / 数组 / 字符串 / null 参数）；恶意路径 14 种（穿越 `../a` 与 `..\a`、盘符、UNC、设备路径、绝对、ADS、保留设备名含带扩展、尾随点空格、重复分隔符、尾随斜杠、NUL）；**不使用宿主 cwd**（cwd 填不存在的 `D:/nope` 与 `C:/Windows` 都照常读到）。**
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
- [ ] 7.5 在 Windows 运行可创建的 junction/symlink 导入测试；截图部分迁 B/C（0.5h）。验证：`workspace-isolation/拒绝链接及不合适的根目录`；缺创建权限记录未验证限制，不能标作通过。来源：原 7.5-A。**⚠️ 开工前先提醒用户开启开发者模式（用户策略「用完即关」：本机默认关闭 `AllowDevelopmentWithoutDevLicense=0`）——开启后非管理员即可创建文件/目录符号链接且对新进程立即生效、无需重新登录；跑完提醒关闭。未开时 symlink 夹具会被探针判为"不可创建"，相关用例显示 `skipped` 而非通过（2026-09-18 已验证过一次全流程）。**
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

**2026-09-17 · 实现 1.2 时发现 4 项**：

1. **路径规则的分工必须显式划开，否则 1.2 与 2.1 各写一半**：1.2 要求清单拒绝"非法路径"，而完整路径校验是 2.1 的交付物（其验收明列 Windows ADS/UNC/设备名、NFC 与大小写碰撞、长度/深度边界）。结论：1.2 只做**跨平台通用结构**判定（非空、非绝对、`/` 分隔、无空段、无 `.`/`..`、无 NUL），平台特性与长度/深度/配额留 2.1。该边界写在 `workspace-snapshot.ts` 模块头，并用"平台特性规则不在此层"的用例固定——`CON` 与 `a.txt:ads` 当前**放行**，这是有意的不是漏判。
2. **快照 id 的重算要接在 reader，不能只留"执行前预检"**：清单与 id 之间没有结构性约束，只在执行前查，等于允许"把一个哈希不符的文件先读进来"。已在 reader 的首个内容行与 `agent.step` 行各重算一次（重算需要 `node:crypto`，纯 schema 层做不到，这也正是"Node 哈希模块与纯 schema 分离"的实际用途）。
3. **1.1 的既有 fixture 会被新校验判为不合法**：`test/version-guard.test.ts` 的 `v2Meta()` 与"v2 往返"用例原先拿 `"a".repeat(64)` / `"b".repeat(64)` 当快照 id，此前能过是因为没人核对 id 与清单相符。已改用 `computeWorkspaceSnapshotId([])` 与 `createWorkspaceSnapshot(...)` 生成真实 id——**属 fixture 数据修正，不是放宽校验**。
4. **Node 哈希模块走子路径 `./workspace-hash`，不进主出口**：主出口已导出 `JsonlTracer`（带 `node:fs`），renderer 本就不该用它；但把哈希再挂主出口会让"renderer 误 import 主出口"的代价从"多打一个 fs"升级为"打了 crypto 之后运行时报错"。包内已有 `./schema` 子路径先例，故新增 `./workspace-hash`，并在 trace-sdk README 的「导出面与子路径」写明三者分工。

**2026-09-17 · 实现 1.3 时发现 3 项**：

1. **`EndSpanPatch` 的 union 表达不了"按 span kind 约束 patch"**：id 与 kind 的关联要到运行期才知道，而 union 的第一个分支 `{ kind?: never }` 不限定 kind，所以"给 `llm.call` 传 `workspace_snapshot`"在类型上能通过、schema 又会**静默剥离**它。已在 BaseTracer 加一条运行时防御（非 `agent.step` 携带即抛错）——否则 3.4 的包装器一旦写错 kind，产物会缺检查点，只剩 reader 的跨行约束兜底。
2. **两处守卫的时机正好相反，不能照抄**：v1 禁字段必须在 **parse 之前**按**原始自有属性**判（zod 一 parse 就剥离，之后再也看不见）；v2"step 必须有检查点"必须在 **parse 之后**按 `kind` 缩窄判（原始对象尚未经过判别联合校验）。两者都在 reader 的 span 分支里，但顺序不可对调。
3. **守卫失败时该 span 已移出活跃表**：`endSpan` 里 `active.delete(id)` 位于守卫之前，与既有 `SpanSchema.parse` 失败的行为一致 ⇒ 守卫失败后不能纠正 patch 重试。沿用既有语义，本次不改；将来若要求"失败可重试"，需把 delete 挪到全部校验之后。

**2026-09-17 · 实现 1.4 时发现 2 项**：

1. **`agent-loop/test/fork-run.test.ts` 存在与本次改动无关的概率性失败（已修）**：该用例比较两次独立 run 的事件流逐字节相同，归一化只剔了 `timing`，没剔 `tool.invoke.dur_ms` —— 桩 handler 虽是同步的，但 `dur_ms` 取的是 `Date.now()` 两次之差，在 check:ci 并行跑多包的负载下可能一次 0、一次 1 ⇒ 偶发红。已在归一化里一并剔除 `dur_ms`（它是测量值，两次独立运行本就不该相等，剔除符合该用例"只比结构与数据"的原意）。**单跑与 pnpm 单包重跑均无法复现，结论靠证据链（同步桩 + Date.now 计时 + 唯一未归一化的非确定字段）而非复现**。
2. **"只存在于祖先"边界的判定必须查直接父的 `owned` Map，而不是拼接前缀**：拼接前缀里当然找得到祖先的 step，用它判定会让"跨代指祖先检查点"静默通过，文件起点与消息前缀错配。`resolveWholeRound` 因此接收 `parentRecord`（chain 里的直接父 record）而非只拿拼接结果。

**2026-09-18 · 实现 2.1 时发现 3 项（另 1 项为附带影响）**：

1. **1.2 那条"平台特性规则不在此层"用例到期，必须翻转**：`workspace-snapshot.test.ts` 曾断言 `CON` 与 `a.txt:ads` **放行**（1.2 为避免与 2.1 各写一半而刻意留的边界，见上节第 1 项）。2.1 把完整契约接进同一层后，该用例改为断言**拒绝**，并在用例里写明"这是 1.2 显式约定的边界到期，不是收紧/放宽之争"。同时 `workspace-snapshot.ts` 模块头、`schema.ts` 的 `WorkspaceFileSchema.path` 与 `WorkspaceSnapshotSchema` 注释一并改为指向 `logical-path.ts`，否则注释会与行为相反。
2. **"深度"的口径必须钉死，否则 7.7-A 会按别的口径造 fixture**：本段把深度定义为**段数（含文件名段，`a/b.txt` 记 2）**、长度定义为**UTF-16 代码单元**，且两者**上限含边界**（512 / 32 合法）。这不是措辞问题——按字节算长度会把 512 个中文字（1536 字节、512 单元）误拒，故用例同时用"512 个中文"与"代理对按 2 计"两条钉住口径；口径写进了常量注释。
3. **契约进 schema 会把"清单里的路径"与"工具输入的路径"绑成同一标准 ⇒ 工具边界必须先规范化再校验**：`findLogicalPathViolation` 对 `dir\a.txt` 是**拒绝**（清单里路径必须是规范化形式），而 Windows 用户调用工具时最常写反斜杠。因此 3.1/3.2 接线时必须 `normalizeLogicalPath` → `findLogicalPathViolation` 两步走；已把这条两步用法写进 `normalizeLogicalPath` 的文档与用例（`\\server\share` 规范化后仍按 UNC 拒绝，正是"规范化不等于放行"的例子）。
4. 附带影响（不单列任务）：清单层现在会拒绝 NFC/大小写碰撞与超长路径，故**手工构造的 v2 fixture 不能带 `A.txt` + `a.txt` 这类路径**。v2 只有隔离运行会写 `workspace`，无历史数据受影响。

**2026-09-18 · 实现 2.2 时发现 4 项**：

1. **`link` 发布成功后必须删临时文件（探针用例当场抓到）**：硬链接是"同一 inode 的第二个名字"，不是移动；我最初把"发布成功"当作已完成、只在失败时清临时文件，结果 store 里同时留下目标与 `.tmp-*`。现改为**任何路径都清理本次自己的临时文件**（`finally` 无条件删一次）：发布成功时内容已由目标名持有（链接是同一 inode、复制是另一份），失败时它只是残片。
2. **退化路径的触发条件必须收窄，否则会掩盖真实故障**：最初"任何非 `EEXIST` 的 link 失败"都退化为排他复制，注入 EIO 时被悄悄救活并报发布成功。现只对"卷不支持硬链接"这一类码（`EPERM`/`EACCES`/`ENOSYS`/`ENOTSUP`/`EXDEV`/`EMLINK`）退化，`EIO`/`ENOSPC` 原样抛出。**"能救活就救活"在这里是错的**：卷故障与卷能力不足是两回事。
3. **清单 id 的重算已在 reader，读取层不该再加一份（否则是不可达分支）**：设计 §7 的"清单及 origin 校验后才读 blob"里，**清单完整性**其实在 `readRun` 就完成了（1.2 把 `findSnapshotIdViolation` 接在 reader 的首个内容行与 step 行）。我原本在定位层又写了一个 `snapshot_invalid` 分支，实测被篡改的清单先在 `readRun` 抛错 ⇒ 该分支**永远走不到**。已删掉，改为把解析/完整性失败统一映射成 `trace_invalid` 并**原样带出原因**（"初始快照校验失败：…"）；两级校验的分工写进 `read-api.ts` 模块头。附件字节的比对才是本层的活。
4. **注入 I/O 故障用 mock 替换 `node:fs/promises.link`，且单独放一个用例文件**：真实卷故障无法稳定复现，而"失败后只清本次临时文件"只有在**临时文件已写完、只差发布**的那一刻才可观测。做法：`vi.hoisted` + `vi.mock` 包装 `link`，**默认仍走真实实现**，只在用例显式排入一次故障时接管（注入函数还可带副作用——用它构造"退化发布时目标已被抢占"的确定性竞争）。独立文件是为了不让 mock 污染其他用例的模块图。

**2026-09-18 · 实现 2.3 时发现 4 项（含 2 项未验证限制）**：

1. **`ino` 必须用 `bigint` 取，否则两个文件会被判成同一个**：实测本机 NTFS 的 ino 已达 `17451448556123362`（远超 2^53），`statSync(path).ino` 的 `number` 会**静默丢精度**——"标识"这一列正是两遍核对（2.4）用来发现"文件被换成了一个新文件"的依据，精度丢了就等于该检查失效。已改用 `lstat(..., { bigint: true })`。
2. **本机创建文件符号链接会"静默不建"，用例差点变成假绿**：`symlinkSync(target, link, "file")` **既不抛错、也没真的建出条目**（Windows 无 `SeCreateSymbolicLinkPrivilege`）。第一版用例把"没抛错"当成"建成了"，于是"应拒绝"断言失败，看起来像实现漏判链接。⇒ 判定回查 `existsSync(link)`，并把该用例改成 `it.skipIf(!FILE_SYMLINK_AVAILABLE)`，报告里显示 **skipped** 而不是绿色通过（与 7.5"缺创建权限须记录未验证"同一口径）。**目录 junction 本机可创建，因此"拒绝链接"这条路径由 junction 用例真正覆盖**（含悬空 junction）。
3. **bigint 统计把毫秒字段也变成 bigint**：`StatsBase<T>` 把 `mtimeMs`/`atimeMs` 一并参数化 ⇒ 直接赋给 `number` 字段编译失败。毫秒量级在 double 里是精确的，显式 `Number(...)` 转换并在注释里说明。
4. **dataDir 首次运行前不存在，"祖先检查"不能只用 `resolve`**：`resolve` 会漏掉"祖先里有链接"（两串字面路径看着无关、实际同一处），而 `realpath` 要求整条路径存在。做法：向上找到第一个能 realpath 的祖先，再把剩余段接回去（用例用 `outer/data/nested` 这种多级不存在的路径验证）。另：Windows 路径不区分大小写，比较前折叠（`path.win32.relative` 本身也折叠，这层是双保险）。

**未验证限制（如实记录，不得标作通过）**：① 树内出现 **FIFO/socket/设备**等其他非常规对象——Windows NTFS 上无法在目录里构造，`!isFile() && !isDirectory() → 拒绝` 这条分支未经真机验证；② **ACL 拒绝导致的"不可读文件"**未构造（代码里读取失败一律 fail closed）。两者都留待有对应环境的机器补验。（原第 3 条"文件符号链接本机不可创建"**已于 2026-09-18 09:35 解除**：开启开发者模式后该用例真跑通，不再是 skipped。）

**2026-09-18 · 实现 2.4 时发现 3 项**：

1. **"逐条追加判定"与"整集合判定"不可能在所有输入上报同一条原因，这是流式的固有代价**：实测一组"2001 个 8 MiB+1 字节的文件"，集合判定先报"文件数超过上限"（结构性原因先看规模），而流式判定在第 1 条就报"单文件超过上限"。**不要为了对齐文案去牺牲早期拒绝**——早期拒绝的意义正是别把大文件读进内存。用例改为钉"结论一致（都拒/都放行）+ 单一违规时原因一致"，并在 `findAppendQuotaViolation` 注释里写清两者关系。
2. **第二遍必须真的"只读"**：若第二遍复用带 store 的 walk，源目录变化时它会把**改后的内容**发布成附件，留下一个永远无引用的 blob。改为 `store: null` 模式（只读 + 只算哈希）后，用例可以断言"改后的内容在附件存储里查不到"——这条断言本身就是"第二遍只读"的证据，否则该性质无法观测。
3. **失败收尾的语义要落到可执行断言上**：设计的"孤立 blob 不成为可用快照"= 拒绝后 `traces/` 不存在 **且** 用读接口（2.2）拿同一 dataDir 按 runId 查得到 `run_not_found`；"不删已发布内容"= 第一遍已发布的附件仍在。另：设计把"采集期间变化被拒绝"写成**受控测试**场景，那就必须给一个显式注入点（`testHooks.betweenPasses`，参数名带 `testHooks` 让误用在评审时一眼可见）——靠竞态去撞两遍之间的窗口是假证据。

**2026-09-18 · 实现 2.5 时发现 4 项**：

1. **"本 run 新增内容"必须排除起点快照已有的哈希，否则每多一级分叉就重复计费**：设计写的是"以本 run 实际产出的唯一哈希集合求和"。若按"本 run 调用过 publish 的唯一哈希"算，子分支把父 run 已有内容原样写回也会被计一遍——而这条配额要防的是**磁盘增长**，那些字节早就在 store 里了。落点：世界维护 `inherited`（起点清单的哈希）与 `newContent`（本 run 产出的、且不在 `inherited` 里的唯一内容）；`fork` 时前者取当前映射、后者清空。
2. **覆盖写不能用"追加"公式判配额**：`findAppendQuotaViolation` 的语义是 `count+1` / `total+bytes`；覆盖写要让合计**减掉旧的那一份**，所以走整集合判定。两条路径都在"替换映射"之前返回（失败即映射不变）。新路径仍用 O(1) 的追加判定，否则"写 2000 个文件"的用例会退化成 O(n²)。
3. **"冻结"必须是返回值级的新对象**：`snapshot()` / `listFiles()` 若返回内部对象或数组引用，调用方（或 Tracer 稍后的处理）改一次就污染了世界。用例里专门钉了一句"改返回值 → 世界不变"。
4. **授权不能有默认值**：`allowFileWrites` 必填、`fork` 也必填且**不继承**父世界的值。用一个绕过类型检查的 `fork({})` 确认运行期是 **fail closed**（按未授权处理）而不是"缺省即授权"——权限边界上的默认值是反向的坑。

### 拆分后的历史说明

上面四项是实施当时的记录。路径校验归属现已同步到 A design 和 2.1；第 4 项已完成的 desktop 测试版本修正保留，不重复列为待办。2026-09-17 随方向规划审阅明确：A 的 desktop 修改仅限因共享包版本兼容而必需的既有版本/测试断言与常量引用修正，须保留既有行为及拒绝门禁，并记录原因和回归证据；禁止新增或扩展 IPC handler、preload/store 暴露、渲染层组件和 main 侧流程。隔离桌面工作归 B/C，可用性工作归独立 U 变更，白名单外先调整受影响分工及 OpenSpec。原 1.1 的 IPC 后续工作迁 B 1.1；原 1.2 的 schema 进度不等于哈希/路径验证已完成。本次未改任务勾选或预算。
