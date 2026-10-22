# MCP0 / MCP1 设计

## Context

源码核对 `2d39b1e`。main 的 RunRepository、RunReadContext、run-lineage-read、run-detail-project 负责读取与父链投影；compare-endpoints 不依赖 Electron，但依赖 desktop shared schema。shared 的 derive、compare-derive/output/edit-evidence/source-map 提供纯事实派生。workspace-view 包装 replay/workspace/read-api；R2.2 compare-api 已提供 compareWorkspaceSnapshots/readComparedWorkspaceFile。

不能直接外发整个 RunDetail：它包含正文、容量无界，并会将内部 IPC 绑定为外部协议。

## Goals / Non-goals

让一个明确客户端完成带来源的只读诊断，桌面/MCP 复用事实。范围和保真度见 proposal；不预建 MCP3 执行基础设施。

## Decisions

### D1. 运行与依赖

新增 packages/run-query、packages/mcp-server，沿用 strict TS/vitest/Biome。run-query 依赖 trace-sdk/replay/现有 zod；MCP 包消费它并使用官方 @modelcontextprotocol/sdk。

第一项实施任务验证本机 WorkBuddy 5.9.0 的最小 stdio 接入，记录客户端完整版本、Node 实际版本（满足仓库 >=20）、SDK 精确版本、zod 兼容、依赖许可证/体积。尚未完成，不能声称兼容；若需全仓升级 Node/zod，先修订 proposal。

首版源码工作区构建后，以 Node 绝对路径运行 packages/mcp-server/dist/cli.js --data-dir <已有绝对路径>。真实试验后才写可复制指南；不用开发机路径充当通用安装示例。不依赖桌面运行、不自动发现便携数据、不读 SettingsStore/key、不修改客户端配置。不包含 npm 发布或桌面捆绑。

### D2. 最小共享层闭包

| 来源 | 处理 |
|---|---|
| main/run-repository、run-read-context、run-lineage-read、run-detail-project | 迁入 run-query，旧路径可薄 re-export；保持缓存/身份/父链/投影 |
| shared/derive 与 compare-* 纯事实函数 | 提取必要部分；视图文案/renderer 状态留 desktop |
| shared/ipc 的运行/详情/比较领域 schema、run-detail-integrity | 最小领域 schema 迁入包层，旧类型兼容导出；CHANNELS/IPC 信封/执行类型留 desktop |
| main/compare-endpoints | 事实查询共享，IPC 信封仍在 desktop |
| main/workspace-view、replay 的 read-api/compare-api | 查询包装共享，继续调用 replay 定位/路径/附件/比较，不复制解析/哈希 |

依赖方向 desktop → run-query → replay/trace-sdk、mcp-server → run-query。run-query 不反向依赖 desktop、Electron、renderer 或 MCP SDK。不搬 store/组件/执行 registry/端点；agent-loop 不变。先审查 schema 最小依赖闭包，不能整体搬 shared/ipc。

1.3 的闭包清单落为 change 制品（迁移文件/schema/纯派生/旧出口逐项列明）。出现下列任一情形即停下、先修订提案拆分，不得静默扩大：① 需变更任何旧 IPC 名、schema 或行为才能迁出；② 需搬 CHANNELS、IPC 信封、执行类型、store 或任何 renderer 状态依赖；③ run-query 需反向 import apps/desktop 或 Electron；④ D2 表列之外的 shared 模块成批迁入，超出必要最小闭包。

内部完整事实满足旧 IPC；MCP 的白名单/容量只在外部投影，不收紧桌面读取。错误按结构分类，不解析中文异常、不向 MCP 透传含物理路径的原始 Error.message。

### D3. 数据根与零写入

启动只接受一个显式已有绝对 dataDir，要求已有可读 traces/，空 traces 合法。缺参/不存在/无 traces/不可读时 stderr 固定码、非零退出，不 mkdir、不换数据根。工具参数 strict，不接受 dataDir/宿主路径/URL/handler/配置覆盖。runId 最长 200、spanId 128、逻辑路径 4096 字符；父链 ID 同校验，文件名必须等于 meta.id。非法目标读取前拒绝，复用现有路径判据。

操作者显式信任数据根。共享读取边界检查真实路径和普通文件类型，拒绝 traces/JSONL/blob 经 symlink/junction/reparse point 越界或目录替身。不承诺抵御有权限并发换文件的恶意本机进程；发现版本变化不拼混合结果。

不写数据目录/索引/session/锁/持久日志，不写 trace/blob/source、不读当前源目录兜底、不调用模型/工具/导出、不登记 operation/占执行槽。stdout 仅协议；受控日志在 stderr，不含正文/原始参数；关闭所选 SDK 若有的自动遥测/外联。

### D4. 结果与来源

成功 structuredContent：

```text
{apiVersion:"rebaseagent.query.v1",ok:true,observedAt,readVersion,data,
 provenance:{runs:[{runId,formatVersion,sealed,lineage,spanScope}],
             refs:[{runId,spanId?,stepSpanId?,snapshotId?,path?}]},
 limitations:[{code,ref?,message}],page?:{nextCursor},
 truncation:{truncated:boolean,nextCursor?:string}}
```

observedAt 为 UTC ISO；readVersion 是参与文件字节与参数摘要，不代表目录事务。未知保留 null/limitation，不补零。引用只用真实运行、所属 span、自有检查点、逻辑路径；不输出宿主 URL、不新增 deep link。指南说明如何在桌面按完整 ID 定位。

失败 `{apiVersion,ok:false,error:{code,message,ref?,retryable}}`，工具 isError=true；未知工具/协议错误沿 MCP 标准。已知工具非法业务参数映射统一信封，不透传 SDK/Zod 参数/异常。content 只给简短状态/定位，不复制整份正文；按选定 SDK 验证 outputSchema/structuredContent。

稳定码：INVALID_ARGUMENT、DATA_DIR_INVALID、RUN_NOT_FOUND、RUN_INVALID、UNSUPPORTED_TRACE_VERSION、IDENTITY_MISMATCH、ANCESTOR_INVALID、ANCESTOR_UNREADABLE、LINEAGE_CYCLE、FORK_INVALID、STEP_NOT_FOUND、SPAN_AMBIGUOUS、NO_WORKSPACE、CHECKPOINT_NOT_FOUND、STORAGE_IO、STALE_CURSOR、RESPONSE_LIMIT。无法可靠细分解析错时用 RUN_INVALID，不按错误文字猜版本。缺父仅在确认祖先 ENOENT 时给 ANCESTOR_NOT_FOUND limitation；文件保留 text/binary/not_found/missing/corrupt/rejected。

码命名空间分三类，实现和客户端按类分支，不得混用承载：

| 类别 | 承载 | 码 |
|---|---|---|
| 启动域 | stderr 固定码 + 非零退出，服务未初始化前不进工具信封 | DATA_DIR_INVALID 及 D3 启动失败固定原因 |
| 工具错误域 | 结构化失败信封 error.code（即上段稳定码，业务失败，isError=true） | 上段除 DATA_DIR_INVALID 外的全部 |
| limitation 域 | 成功结果 limitations[].code，只提示不导致失败 | TERMINATION_NOT_RECORDED、ANCESTOR_NOT_FOUND、BODY_NOT_EXPOSED、REDACTED（D7 的已知凭据过滤标记） |

文件状态枚举 text/binary/not_found/missing/corrupt/rejected 独立于以上三类，绑定 selector 返回。limitation 码首版封闭为上表四项，新码须先修订本文档，实现不得自行造码。

请求内缓存相同物理 run，跨请求不缓存事实。未封存只返回可校验已落盘记录、sealed=false 和 TERMINATION_NOT_RECORDED，不能证明仍运行；坏尾行/半行报错，不裁掉错误拼成功。desktop crashed 原状态保留，MCP 加上述解释，不改事实。

### D5. 七个工具契约

下表是拟交付接口，当前不可调用。条目默认 20、最大 100，未知键拒绝。

| 工具与参数 | 事实和正文边界 |
|---|---|
| list_runs({status?,query?,cursor?,limit?}) | status=all/errored/ended_without_error/limited/aborted/termination_not_recorded，默认 all，按记录分类，不等价任务成败。query 搜完整 task/ID。摘要不含正文；失败文件 tagged item 不因筛选消失 |
| get_run({runId,cursor?,limit?}) | 白名单摘要、fork 字段/实验身份、父链、自有/适用累计消耗、分页 span/检查点索引；不默认 messages、fork.edit.value、假设/文件正文或原始 meta |
| get_step({runId,spanId,ownerRunId?,section?,cursor?,maxChars?}) | 无 section 只给 kind/时间/是否录有错误及 section 索引；section=input/output/error 才取正文。继承项标 owner；重名 span 不取首项，SPAN_AMBIGUOUS 给 owner 候选，显式 owner 仍须在当前投影可见 |
| compare_runs({left:{runId},right:{runId}}) | 与 compare_checkpoint_files 同形的两侧对象（统一参数风格，不使用数组）；恰两个不同运行，同序逐侧 ready/unavailable；复用祖先、消耗、干预/输出摘要，正文给引用/有界预览，不对齐步骤/判修复 |
| inspect_checkpoint({runId,stepSpanId?,cursor?,limit?}) | 省略 step 固定初始；显式 step 只认本 run 自有完成 agent.step；snapshotId/origin/总数/字节及分页清单/附件状态，不换最近步骤 |
| read_checkpoint_file({runId,stepSpanId?,path,cursor?,maxChars?}) | 长度/哈希核验后按范围读 UTF-8 原文，保留 CRLF/空串/尾随换行；二进制仅 bytes/hash，不给 base64/替换字符；状态绑定 selector |
| compare_checkpoint_files({left:{runId,stepSpanId?},right:{runId,stepSpanId?},path?,cursor?,limit?,maxChars?}) | 无 path 分页清单并集/引用；有 path 逐侧核验/正文/状态；左右固定、自有检查点、同 run 两点可比，不按迭代号猜对应 |

get_run 索引 tagged item 按 span 投影序、检查点自有记录序排列；list 摘要 created_at 倒序、runId UTF-16 升序解同刻，失败项排后按安全文件标识排序并占分页额度。过滤只作用成功摘要，失败项保留。失败项构成线性序列末尾的固定段，与成功摘要共用同一游标位置序列：每个失败项只在首次翻到其位置时返回一次，后续页不重复回传全部失败项，游标含该段进度（D6 续读据此保证无重不漏）。

get_step owner 在共享投影中建立，不由 MCP 重拼父链；被截掉的祖先 span 不因显式 owner 可读。error 缺失标未记录，空串/null/未记录分开；tool error 不等价运行出错。

compare_runs 不默认完整最终文本，过长干预/输出给可用 get_step 引用。无法定位 span 的 fork 编辑正文首版只给字段/长度/摘要及 BODY_NOT_EXPOSED，指引桌面，不造正文接口。历史服务商/消耗缺失保持未知。

### D6. 容量、分页和续读

完整工具结果含 structuredContent/content/来源/错误，UTF-8 JSON 后最多 64 KiB。条目数是上限，实际预算不足提前结束页给 nextCursor；单项元数据仍无法容纳则 RESPONSE_LIMIT，不删身份假称完整。

正文默认 4096、最大 8192 Unicode 码点，再按实际信封预算缩短，不拆代理对。结构正文先规范 JSON 后分文本段，encoding=canonical-json；文件 encoding=utf8-text。返回 `{text,range:{start,end,total,unit:"unicode-code-point"},truncated,nextCursor}`。范围针对过滤后外发文本；原文件 bytes/hash 明确属于完整历史文件，不充当片段哈希；换行不规范化。

比较游标分别存左右 offset，一侧结束不拿另一侧补；内容结论依据完整附件校验/字节，不凭片段判断 same/different。清单 same 只表示引用相同。

不透明游标含版本/工具/参数指纹/readVersion/下一位置，以进程随机密钥认证，不含任意路径/正文。改参数/篡改给 INVALID_ARGUMENT；进程重启旧游标 STALE_CURSOR，从首页重查。续读重新核对列表候选集合/失败项、详情来源链或文件 selector/清单/所需附件，变化给 STALE_CURSOR，不跨页拼混合事实。不提供跨请求事务/实时流；单请求同 run 只解析一次。

### D7. 可见字段与信任

元数据白名单，不读/输出 SettingsStore、代理 key、Authorization/api-key headers、端点 userinfo/query/fragment、物理存储路径。步骤的结构正文中，已知凭据字段替换为标记并给 redacted limitation；历史文件原文不做通用解析/重写，以保留字节和换行语义。自由文本和文件仍可能有秘密/指令，不能保证脱敏。配置前说明客户端可能外发/自行计费；历史正文作为不可信记录，不可改变数据根/工具/过滤规则。

有过滤时原历史文件 hash 与外发片段分开。只发布七个工具，不提供 prompts/resources/templates 旁路；annotations 为 readOnlyHint=true/destructiveHint=false/idempotentHint=true/openWorldHint=false，但只读由代码/测试保证。

### D8. 生命周期与验收

SDK 管初始化/协商/tools/list/call。EOF/关闭释放资源；查询取消只停读取/响应，不发布执行取消；重连重读盘、不后台续发任务、多进程不各建执行 registry。

桌面保留 IPC/schema/中文状态/逐侧失败、U6/U7/R2.2 语义及 UI 最近自有完成步骤默认；MCP 缺 step=初始不能改变桌面。无新 UI，不另建原型；Electron 回归列表→详情→比较→文件，并抽查窄窗/200%/键盘/阅读位置。

领域测试、stdio 真实子进程、Electron、真实 WorkBuddy 四层分开留证，按 evidence-index 回填。前后文件集合/SHA-256 验零写入；源目录存在时也核对。另一位使用者按指南接入，未完成诚实保留未验收。

## Risks / Trade-offs

- shared/ipc 闭包可能扩大：先审计，超范围（判据见 D2 四条硬触发）先修订拆分，不阻塞 R3。
- 首版依赖 Node/源码构建，不能写成现有下载包已支持。
- 输出上限不等于读取成本上限；记录大数据集耗时/内存，不加持久索引。
- readVersion 防续读串数据，不提供目录事务或恶意并发替换保证。
- 自由文本不能保证去密，配置前明确外发范围。

## Migration / Rollback

无数据迁移/trace 升版。逐步提取并保留旧兼容出口；回退恢复依赖/接线、移除 MCP 配置即可，不修历史轨迹。发行和 MCP2/3 独立立项。
