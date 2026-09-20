# C 段（`add-sandboxed-rerun-file-view`）场景 → 证据索引

> 任务 3.5 的产出。范围：本 change **唯一一份 spec delta**（`specs/desktop-ui/spec.md`）的
> **全部 9 个 scenario**（1 个 ADDED requirement）。与 A / B 段归档时的 evidence-index 同形。
> **本索引不自动归档、不发版**。

## 怎么读这份表

- **证据**优先是**可执行的用例**（`文件 › 用例名`，行号不写、定位以用例名为准）；
  纯静态约束显式写"静态"。
- **`--phase=...`** 指 `apps/desktop/scripts/isolated-flow-cdp-smoke.cjs` 的 CDP 冒烟阶段
  （受控模型服务：同目录 `mock-llm-server.cjs`）。截图与 `*-checks.json` 落在
  gitignored 的 `.workbuddy/isolated-flow-smoke/`：
  - `files` → `files-checks.json` + 截图 11~15（含「挪走 blob 制造附件缺失」的 15）
  - `files-restart` → `files-restart-checks.json` + 截图 14
  - `files-migrate` → `files-migrate-checks.json`
  - `files-narrow` → `files-narrow-checks.json` + 截图 16~19
- 本段 CDP 全部实跑于 2026-09-20：files **20/20**、files-restart **4/4**、
  files-migrate **6/6**、files-narrow **16/16**。

## 汇总

| requirement（desktop-ui） | 场景数 | 已覆盖 |
| --- | --- | --- |
| 文件检查点和差异只读可查（ADDED） | 9 | 9 |
| **合计** | **9** | **9** |

检查基线（tasks 3.3，沙箱逐段替换口径）：typecheck（node/web）0 错误；
biome **223 文件 0 errors**；desktop **24 文件 / 363 passed**（`--pool=forks
--poolOptions.forks.singleFork=true` 消 EPERM 假红）；`openspec validate --all
--strict` **13 passed**；desktop `electron-vite build` 三段全绿。

## 1. 文件检查点和差异只读可查（9，全 ADDED）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 初始与各轮文件快照可选择 | `test/workspace-view.test.ts` ›「初始快照：change 恒为 initial…」「第 2 轮结束时：新增 b.txt 标 added…」「修改既有文件 → 标 modified（按内容哈希，不用 mtime）」；`test/workspace-files.test.ts` ›「deriveCheckpointOptions › 只列本 run 自有步骤…」（leafSpanIds 过滤，祖先不进选择器）；CDP `--phase=files`：「隔离 run 详情页出现『文件』tab」「选择器含『本 run 初始状态』+ 按本 run 自有轮号命名的检查点」（实测 `["第 1 轮","第 2 轮"]`） |
| 2 | 文件选择器轮号不沿链累加 | `test/workspace-files.test.ts` ›「轮号取 step **自己的** n，不是数组下标（变异验证：改用 index 必须红）」——**已做变异验证**（`step.n` → `indexOf(step)+1` 后 2 条用例红，还原后绿）；`test/workspace-file-view.test.ts` ›「选择器用'本 run 第 N 轮结束'，且不出现沿链累加的轮号」「父轮号解析不出来时只报 step，不猜」；CDP `--phase=files`：「子 run 选择器只出现它自己的第 1 轮（不沿链累加成第 3 轮）」——父 run 实测 2 轮、子 run（从父第 1 轮分叉再跑 1 轮）实测只有 `["本 run 第 1 轮结束"]`，若沿链累加会冒出第 3 轮；「子 run 文件 tab 的来源说明指父 run（不写成自己的轮号）」 |
| 3 | 二进制和不可用附件分别显示 | `test/workspace-view.test.ts` ›「二进制文件：只返回大小/哈希，**不传字节**、不做有损解码」「附件被删除 → missing」「附件被篡改 → corrupt」「清单外路径 / 物理 blob 路径 → not_found」（六态全表）；`test/workspace-file-view.test.ts` ›「二进制内容 → 只展示大小/哈希，不出现编辑器」「内容缺失 → 明说缺失，不渲染空编辑器」「内容损坏 → 明说哈希/长度不符」；CDP `--phase=files` §H：**临时把 blob 挪出数据目录**（真实缺失态）→ 界面出「附件缺失」文字标签 ×2、汇总行「N 个附件不可用」、点开后出状态面板**不渲染伪空编辑器**，还原后指纹不变（截图 15） |
| 4 | 文件读取 IPC 拒绝越权 | `test/workspace-view.test.ts` ›「祖先 / 不存在的 stepSpanId → step_not_found（不用祖先快照冒充本 run 自有状态）」「非法 runId（可穿越 tracesDir）→ rejected」「非法逻辑路径（穿越 / 绝对 / UNC / 保留名）→ not_found」「清单外路径 / 物理 blob 路径 → not_found（永不拼进宿主路径）」；静态：`shared/ipc.ts` 的 zod schema（runId/path 形状）+ main 只注入 dataDir、renderer 零 fs；`readWorkspaceFile` 的物理路径只由已校验哈希生成（A 段不变量） |
| 5 | 文件浏览过程无写入 | `test/workspace-view.test.ts` ›「完整浏览一遍（初始 + 各轮 + 逐文件读文本）后，数据目录全树指纹逐字节不变」；CDP `--phase=files`：「浏览文件视图无写入：源目录与全部 trace 逐字节不变」+ 源目录哈希集合不变；`--phase=files-narrow`：「长路径/长文本浏览全程无写入」；静态：渲染层只有 `inspectWorkspace` / `readWorkspaceFile` 两个只读动作，视图**无任何回写/应用到源目录按钮**（`test/workspace-file-view.test.ts` ›「任何形态下都不得出现回写入口」对 inspect 为 null 与有清单两态都断言） |
| 6 | 重启后查看文件差异 | CDP `--phase=files-restart` 4/4：重启后 inspect IPC 仍按 runId 取到世界（fileCount=2、a.txt status=text、哈希同前）、文件 tab 可开、diff 可看、全程指纹不变（截图 14）；静态：数据全部落盘（trace + blob），渲染层无缓存 |
| 7 | 数据目录迁移后文件仍可查 | CDP `--phase=files-migrate` 6/6：整目录复制到新根后**Node 侧直调 A 包 dist**（`readRun(新根 trace)` + `readWorkspaceFile({dataDir:新根,…})`）逐份哈希与迁移前相同；blob 逐份同名且「内容哈希 = 文件名」（内容寻址自证，**已做变异验证**：在同名判据里注入假 blob 后该条红）；「只迁移 JSONL」的半边由 `--phase=files` §H 的缺 blob 场景覆盖（附件缺失标签 + 轨迹可读） |
| 8 | 失败运行已记录文件可查看 | `test/workspace-view.test.ts` ›「run 被 errored 事件封存后，已记录的初始/步骤检查点仍可列出并读取完整文件事实」（按真机失败 run 的落盘形态追加 `run.event errored`，2 个步骤的 a.txt 均读回 `alpha 内容`全文）；CDP flow 语料里同样存在 errored 隔离 run（列表「出错终止」） |
| 9 | 长文本及窄窗口 | CDP `--phase=files-narrow` 16/16：长路径（196 字符源根 + 88 字符相对路径）在紧凑文件表**换行显示无横向溢出**；长文本（8528 字符、含两条 400 字符超长行）**按哈希核对**（IPC sha256 = 磁盘 sha256，字符数一致、逐字符一致——不靠截图）；桌面宽度（1210px）详情列 >300px（截图 17）；**900px < lg 1024px** 下「文件列表 / 内容」二选一切换生效、互不遮挡（截图 18/19）、内容区无横向溢出（wordWrap 生效） |

## 由 A/B 迁入义务的核对（tasks 3.5 要求）

- B 段 `evidence-index.md`「迁 C 的显示义务」四条逐条落实并在上表有证据：
  ① 选择器只列自有 step + 「本 run 第 N 轮结束」用 `step.n`（表 #1 #2）；
  ② 分支来源指父 run 轮号、解析不出只报 step（表 #2）；
  ③ 不可用附件带文字标签、二进制不进编辑器、两侧皆缺席不渲染伪空（表 #3）；
  ④ 无任何回写入口（表 #5）。
- A 段「只读 IPC 约束」：renderer 不指定物理路径/存储根、main 注入 dataDir、
  物理路径只由已校验哈希生成——静态约束，落点见表 #4。
- **本段不交付执行能力**：文件视图只有读；没有任何"恢复文件 / 应用 diff /
  回写源目录"的按钮或 IPC（证据见 #5），缺附件显示的是「附件缺失」而不是
  "文件已恢复"。
