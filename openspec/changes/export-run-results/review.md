# R2.1（export-run-results）change 审阅

> 日期：2026-10-05。对象：proposal / design / tasks / workspace-isolation delta / desktop-ui delta。范围：文档与源码核对，未实施产品代码、未运行功能或 Electron 验收。本文件为该 change 的首轮独立评审记录。

> 阅读提示：下方首轮结论及数量保留审阅当时状态；2026-10-05 修订响应见文末，属于起草方自检，不冒充第二轮独立评审或功能验收。

## 结论

**暂不可直接作为实施基线**：发现 1 项 P1（包层「来源不完整」拒绝的分层歧义，直接影响实施位置与是否在包层新建父链校验逻辑）和 1 项 P2（任务映射纪律）。其余契约、源码锚点、数量与 strict 校验全部通过；P1 落实（二选一：补理由并明确层次，或从包层 requirement 移除该条件）后即可进入实施。

## 对照依据

- 主 spec：`workspace-isolation` 6 requirements、`desktop-ui`（U8 归档后）；`desktop-ui` L1014「文件阅读工具操作完整原文且保持只读」现文明确「SHALL NOT 增加编辑、替换、回写、应用补丁或导出入口」。
- 源码核对：`packages/replay/src/workspace/read-api.ts`、`workspace-snapshot.ts`（trace-sdk）、`blob-store.ts`、`apps/desktop/src/main/{ipc,workspace-view,run-lineage-read,run-source-gate}.ts`、`apps/desktop/src/shared/channels.ts`、`apps/desktop/test/preload-surface.test.ts`、`packages/replay/package.json`。
- 基线核对：`87a73b3` = U8 归档提交（已验证）；`openspec validate --all --strict --no-interactive` 复跑 **13 passed / 0 failed**。
- 注意：change 目录当前**未提交**（untracked），提交时随本 review 一并入库或按约定处理。

## 已核实事实（全部属实）

1. **数量与结构**（脚本独立解析）：delta **1 MODIFIED + 2 ADDED、16 scenarios（MODIFIED 内 4 + desktop ADDED 5 + workspace ADDED 7）**、27 条任务全部未勾选；MODIFIED 名称与主 spec 精确匹配、4 个旧场景名零丢失、ADDED 与主 spec 零重名、delta 内零重复场景名；tasks 引用零悬空。
2. **解除禁止的路径正确**：desktop-ui L1017 的「禁止导出入口」由 MODIFIED 正面处理——保留编辑/替换/回写/应用补丁禁止，仅导出被显式允许并限定为「复制已校验快照到用户选择的空目录」；全 spec 检索确认无其他导出禁令（L111「全程只读」、L262「分叉重跑是唯一的显式写路径」均按正文收窄到 trace/数据目录写入，导出目标在数据目录之外，不冲突）。
3. `locateWorkspaceSnapshot`（read-api.ts:118）/`readWorkspaceFile`（:187）契约与 design Context 一致：缺省 step 取初始快照、祖先 step 拒绝（step_not_found）、no_workspace/trace_invalid 可辨认、text/binary/not_found/missing/corrupt/rejected 六态区分；「不需要 run 已封存」明文支持任务 1.3「失败运行已落盘 step」。
4. `WorkspaceFile` 规范序列化为 `[path, sha256, bytes]`（workspace-hash.ts:37）——无权限/时间戳/链接身份，design 的「未保留状态」清单与快照记录能力精确对齐；清单规范排序（UTF-16 码元序）由 schema 强制，delta「清单排序与路径契约」校验有现成依托。
5. `pickDirectory`（ipc.ts:127，dialog.showOpenDialog openDirectory）已存在，`workspaces:export` 命名与既有 `workspaces:chooseSource/forkCapability/inspect/readFile` 家族一致；`preload-surface.test.ts` 存在，task 5.1「更新封闭 preload 白名单测试」引用真实。
6. `packages/replay` 无 diff 依赖且依赖最小（agent-loop/trace-sdk/zod），桌面 diff 走 Monaco；手写确定性补丁（D4）不引入第三方包的约束与现状一致。
7. 补丁基线选「初始快照 vs 选定检查点」与文件页既有「相对初始快照的新增/修改状态」（L751）同口径；导出初始快照本身时无差异，D3 `no_text_changes`/场景「适用的 changes.patch」自洽。

## 发现与处置建议

| 级别 | 问题 | 建议处置 |
|---|---|---|
| P1 | workspace-isolation ADDED 场景「祖先、清单外路径和非法来源被拒绝」把「**来源不完整的 run**」列为**包层**拒绝条件，task 4.2 也在「包层测试」下要求 ownOnly 拒绝。但：(a) 包层现有只读接口刻意不做父链校验——`locateWorkspaceSnapshot` 只读本 run 自有 JSONL，快照自校验（清单 id 重算 + 附件哈希）自足，read-api 注释明言「不需要 run 已封存——读取不是分叉」；(b) 父链完整性校验逻辑（`run-lineage-read.ts`/`checkRunSource`）全部在 **desktop main**，packages/replay 无任何 lineage 代码，实施包层拒绝需在包内新建一套重复逻辑；(c) desktop-ui delta 已有同语义场景「来源不完整时禁用或拒绝导出」（ownOnly 显式入 WHEN），两处重复且层次未定 | 二选一并落实到 delta/design/tasks：**方案 A**（推荐，与 U6 §5.7/5.8 先例一致）——ownOnly 门禁由 desktop main 在调用包 API 前承担（复用 checkRunSource），从 workspace-isolation 场景 3 与 task 4.2 中移除「来源不完整的 run / ownOnly」，包层只管快照自身事实；**方案 B**——若坚持包层拒绝（首期保守），design 须补明理由及「包层需新增父链校验」的实现代价，并接受与 inspect/readFile「文件可看不可导出」的差异被显式文档化 |
| P2 | MODIFIED「文件阅读工具操作完整原文且保持只读」下 3 个旧场景（复制路径原文及元信息 / 查找换行和差异定位使用当前文件 / 不可比较或未就绪时工具诚实禁用）**无精确任务引用**，仅由 7.3/7.4「本 delta 全部场景」兜底。其中「不可比较或未就绪时工具诚实禁用」的 THEN 本轮**有语义修改**（新增「和导出入口」禁用条件），与 U8 复审同类问题（U6 收口纪律为「未被任务引用的场景 0」） | 为「不可比较或未就绪时工具诚实禁用」补精确引用（自然落点 6.1 或 6.3）；另两个逐字保留且未被 R2.1 触及，可接受兜底，维持纪律则一并补齐 |

## 不阻塞观察项

1. **task 4.1「逐字节核对清单」与 D3 `created_at` 矛盾**：清单含导出动作时间戳，同一输入两次导出的清单不可能逐字节一致。4.1 应改为「排除 created_at 的规范化比较」或 fixture 注入固定时间，实施时钉死。
2. D3 `files[].status` 恒为 `"exported"`（任一失败整批失败），字段当前冗余；无害，保留作前向兼容或实施时删去均可，但 schema 测试应覆盖该不变量。
3. 补丁资格不对称：初始不存在而选定为 text 的新增文件进补丁，删除（初始有、选定无）只进清单说明。unified diff 本可表达删除；设计选择了保守面，建议在 D4 补一句理由（空侧无法验证 UTF-8？），避免实施时被当成遗漏。
4. evidence-index 建立时点在 7.3（收口期）；U4–U8 先例均为任务 1.1 先建骨架逐场景跟踪，建议前移。
5. 空清单快照（主 spec 明确合法）导出 → 0 文件 + 空 files 数组 + patch not_available，任务/场景未显式覆盖，可在 4.1 fixture 顺手带上。

## 实施时继续遵守的边界

- 「分叉重跑是唯一的显式写路径」「全程只读且只呈现原样数据」按正文范围理解（trace/数据目录），导出目标目录是新开辟的独立面，由两个 ADDED requirement 完整定义；若实施中发现需要触碰数据目录写入，先回 proposal 修订。
- 导出不登记主动 operation、不占执行槽、不消费授权，与既有未登记只读通道（inspect/readFile/compare）同模式；迟到响应守卫（task 5.3）复用既有代次模式。
- 本轮为文档与源码核对，不构成功能交付或归档放行；27 条任务全部未勾选。

## 2026-10-05 修订响应（起草方）

首轮发现与补充核对均已落实到 proposal、design、两个 delta 和 tasks；首轮记录保留不改写。修订采用方案 A，当前是修订后的规划基线，未实施产品代码、未宣称独立复审通过。

| 项目 | 修订结果与落点 |
|---|---|
| P1 包层与父链完整性分层 | D1 明确包层只校验当前自有快照/附件，不读取父链。包层场景和任务 4.2 移除 ownOnly 拒绝，新增缺父自有快照可导出场景。main 在目录选择返回后用 readRunLineage 重验完整来源，保留桌面 ownOnly 拒绝与既有稳定码，使用导出语境文案而不改变 checkRunSource 执行语义；任务 5.2a/5.4 承载。 |
| P2 任务精确映射 | 6.5 和 7.1b 显式引用三个旧工具场景；6.1 独立实现导出资格。所有 delta 场景有精确任务引用，全部保留旧场景名，无悬空引用。 |
| 清单时间与固定状态 | D3/3.1/4.1 固定时钟测试逐字节 JSON，真实不同时间仅排除 created_at 后比较；保留 status:exported 并固定 schema 不变量，不允许实施时静默删去。 |
| 删除为何不进补丁 | D4 明确 R1 固定工具组无删除，本阶段补丁只支持修改/新增；若合法快照显示删除，逐路径标为 deletion，文件树仍按所选快照物化。不以无法表示删除或无法验证空侧为理由。 |
| evidence-index 建立时点 | 起草阶段已创建 29 场景待实施骨架；1.1 复核并逐批回填，不等收口才建立，不将文档校验冒充功能证据。 |
| 空快照 | workspace delta 增显式场景，D3/3.1/4.1 明确成功导出空 files/、空数组、no_text_changes，无 changes.patch。 |
| 元信息文件名冲突 | D3 固定项目树 files/ 与根清单/补丁分离，项目同名路径保留原字节；新增场景由 2.1/4.1 验证。 |
| 导出错误绑定 diff 条件 | MODIFIED 恢复原“不可比较或未就绪”工具场景；导出资格独立于 Monaco、选中文件、二进制和差异，新增桌面场景由 6.1/7.1a 承载。 |
| 新增文本补丁前后矛盾 | proposal/D4/补丁 ADDED/tasks 统一允许初始清单证实不存在的新增文本，用 /dev/null 表示空侧，不把 missing/corrupt 当不存在。 |
| 补丁与文件失败分层 | 选定附件损坏整批失败；初始基线附件不可用/生成超限只撤销整份补丁，完整 files/ 仍可导出；二进制/删除逐路径标未覆盖。补丁目标写入故障仍整批失败。 |
| 目标与中断边界 | 排除目标链接/dataDir 关系，排他创建，不覆盖/清理竞争者；清理仅本请求可确认产物及空目录。进程中断不保证 finally 清理，不自动补写/回滚，残留按非空目标处理；新增场景和任务 2.2/2.3/4.4a/4.4b。 |

修订后结构：**1 MODIFIED + 3 ADDED / 29 scenarios / 33 条待实施任务**。场景索引全部待实施，未修改主 spec、产品代码或发行物。保留四个旧场景名；新增导出/补丁契约分别对应包层自有事实和桌面来源策略。

文档自检：场景→任务及 evidence-index 机器回查通过（29/29、悬空引用 0、旧场景遗漏 0）；`openspec validate --all --strict --no-interactive` 为 13 passed / 0 failed，完整 change 的 Git 暂存差异空白检查通过。此结论只说明规划材料一致，不替代功能、Electron 或独立复审证据。
