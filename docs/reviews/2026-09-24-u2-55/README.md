# U2 任务 5.5 实机验收证据（2026-09-24）

change：`improve-workspace-file-reading` · 任务 5.5（回归原 IPC 安全、未录制/失败记录和只读不变性）
原始数据：`.workbuddy/u2-55/measurements.json`（**40/40 checks 全绿**：ipc-guard 11 · unavailable 8 · errored 6 · readonly 12 · selfcheck 3；`probe` 只 dump 真机事实不计分）
截图：12 张（本目录）· 采集脚本：`apps/desktop/scripts/u2-55-cdp.cjs` · 夹具生成：`apps/desktop/scripts/gen-u2-55-fixtures.cjs`

任务原文（`tasks.md`）：

> **5.5** 回归原 IPC 安全、未录制/失败记录和只读不变性（1.5h）；验证"文件读取 IPC 拒绝越权""二进制和不可用附件分别显示""失败运行已记录文件可查看""文件浏览过程无写入""阅读重试只读且重新校验"；源/父/兄弟/既有 trace/附件逐文件前后 SHA-256 一致，模型及工具零调用。

**本轮结论：五个 spec 场景实机可达且全绿（37/37 验收 + 3 条"判据有牙"自检）；`readonly` 一条在真实 Electron 里冻结了源目录 / 夹具目录 / live trace / live 附件共 **119 条哈希（113 个唯一文件）**，浏览全程零变化、零新增 run/附件、零 LLM/工具调用。本轮**未发现产品缺陷**；但**发现并修掉了 1.1 留下的一处坏标本**（见 §5）。**

---

## 1. 环境真值

| 项 | 值 |
| --- | --- |
| 物理屏 | 2560×1600 @ Windows 缩放 210% |
| 本档 CSS 视口 | **1210×713**，`devicePixelRatio` **2.1**（`measurements.json` 各场景一致） |
| 断点档 | **medium（960–1279）**（U1 既定布局：文件页会临时收起左侧运行导航） |
| 应用 | Vite dev `http://localhost:5173/`，CDP **9612**；脚本**不 spawn、不改窗、不重启 dev、不伪造 deviceMetrics** |
| store 探针真实 URL | `http://localhost:5173/src/store.ts`（Vite root = `apps/desktop/src/renderer`） |
| 冷重载后运行名单 | **69** 项 = `traces/` 里 69 个 run 文件（另有 1 个**既有**遗留 `tmp-measure-*.tmp`，与本案无关，见 §4.5） |

### 夹具（`gen-u2-55-fixtures.cjs` 生成，已安装进 live 数据目录）

| 夹具 | 形态 | 用途 |
| --- | --- | --- |
| `run_muevo9vx_3ou36x`（root R） | **真实引擎**：3 轮（读 `a.txt` → 改 `edit.txt` + 新建 `new.txt` + 读 `long.txt`/`bin.dat` → 收尾） | IPC 越权对照、二进制、只读不变性、重构重试 |
| `run_muevo9x5_ndle`（fork F） | **真实引擎** `replayIsolatedRun`（R 的子） | "子/sibling" 哈希对照 |
| `run_muevo9xm_noymff`（errored E） | **真实引擎**：第 1 轮真实写入 → 第 2 轮 LLM 失败封存 | 失败运行已记录文件可查看 |
| `u2bad55_missing` | 手工派生：第 2 轮检查点多引用一条路径，其 blob **未落盘**（**独立哈希**） | 附件缺失 |
| `u2bad55_corrupt` | 手工派生：同上，但该 blob 位置写入**等长错字节**（**独立哈希**） | 附件损坏（**只**哈希不符 ⇒ 把判据精确钉在哈希校验上） |
| `u2bad55_noownsteps` | 手工派生：挂到 R 下并别掉本 run 全部 `agent.step` | 没有检查点的旧 run / 未录制检查点 |

**为什么异常标本必须自造、不能复用 1.1 的 `broken/*`**：1.1 的 missing/corrupt 是"以真实 root 为底、附件整体替换"，其"损坏"落在**与真实 run 共用**的附件哈希上 ⇒ 安装进 live 会把真实 run 的附件一起弄坏。本案改为每条异常引用**只属于自己**的哈希，缺失/损坏只影响该标本。

---

## 2. 真实性保障

- **越权证据走真 IPC**：`ipc-guard` 直接调 `window.api.inspectWorkspace / readWorkspaceFile`（preload 经 `contextBridge` 暴露的**唯一**跨进程通道），读的是**未加工的 Envelope**，不经过 store / 组件。这是"越权"最贴切的证据面。
- **哨兵宿主文件**：把一个真实宿主文件写成唯一串 `U2-5.5-SENTINEL-<ts>-绝不外泄`，再以 5 种写法（绝对路径 / 正斜杠绝对路径 / `file://` / 四级穿越 / 裸文件名）请求；断言**返回值里从未出现该串**——若实现真去读了目标宿主文件，串必然出现。
- **对照项防"一律拒绝"假真**：同 tag 内设合法请求（`inspectWorkspace(R, 第2轮)` + `readWorkspaceFile(edit.txt)` 必须**成功**并返回真实文本），证明上面的拒绝判据有牙。
- **只读不变性用逐文件 SHA-256**：在本机对 4 个数据面递归取哈希（见 §3.5），浏览前后逐条比对；并另有 `selfcheck` tag 故意制造"新增"与"哈希变化"，证明该判据**真的能发现写入**（不是常量真）。
- **重试"真的重发"由包装层日志立证**：`installHooks` 包住 store 的 `readWorkspaceFile` / `inspectWorkspace`，**原动作照常执行**，只对指定规则注入失败，并记录 `{kind,key,side,occurrence,mode}`；"重试是否真发了 IPC"由日志本身立证。
- **三条独立读取通道**：IPC（新）· DOM（列表徽标 / 状态卡 / 工具栏可用性）· **真 monaco 真模型**（`standalone[].text` / `diff.originalText|modifiedText` / `readOnly`）。"正文是运行时真实写入的内容"必须由**真模型文本**立证，DOM 只能证明"看得见"。

---

## 3. 结果矩阵（40/40）

| tag | checks | 覆盖的 spec 场景 |
| --- | --- | --- |
| `ipc-guard` | **11/11** | 文件读取 IPC 拒绝越权 |
| `unavailable` | **8/8** | 二进制和不可用附件分别显示 |
| `errored` | **6/6** | 失败运行已记录文件可查看 |
| `readonly` | **12/12** | 文件浏览过程无写入 + 阅读重试只读且重新校验 |
| `selfcheck` | **3/3**（canary，非验收项） | 证明 §3.5 的冻结面判据有牙 |
| `probe` | 0（只 dump 真机事实） | 诊断基线：视口/模块 URL/名单/夹具可见性/原始 Envelope |
| **合计** | **40/40，0 失败** | 其中验收项 **37** |

### 3.1 文件读取 IPC 拒绝越权（`ipc-guard` 11/11）

三层判据 + 一条对照，全部取自 `measurements.json` 的原始 Envelope：

| 用例 | 实测返回 |
| --- | --- |
| 哨兵宿主文件（5 种写法） | 全部 `not_found`，且返回值 **5/5 无泄漏**；原因分别是「路径分隔符必须规范化为 `/`」「路径段不得包含冒号（Windows ADS 或盘符前缀）」「路径不得包含空段」「路径不得包含 `.` 或 `..` 段」「所选清单内没有这条路径」 |
| `runId: "../../etc/passwd"`（inspect） | Envelope `ok:false`，`code = WORKSPACE_INVALID_REQUEST`，原因「runId 不得包含路径分隔符或 NUL」 |
| `runId: "..\\..\\x"` / `".."`（read） | `rejected`，`code = invalid_request`（分别命中「不得包含路径分隔符」/「不得是 `.` 或 `..`」） |
| 清单外路径 `not-in-manifest.txt` | `not_found`「所选清单内没有这条路径」 |
| **同一路径存在于别的 run 的清单**（`u2bad-missing.txt` 在 missing 标本里有、R 里没有） | `not_found` ⇒ **不以同名文件或其他快照替代** |
| 任意物理 blob 路径 `workspace-blobs/sha256/<hash>` | `not_found` ⇒ 逻辑路径永不拼进宿主路径 |
| 未规范化分隔符 `sub\a.txt` | `not_found`（契约级拒绝，先于"清单里有没有"） |
| **祖先而非自有 step**（用父 run 的 `s_01` 定位 `u2bad55_noownsteps` 的文件） | read ⇒ `rejected` / `code = step_not_found`；inspect ⇒ `WORKSPACE_STEP_NOT_FOUND`；原因「step s_01 不在 u2bad55_noownsteps 的自有记录中（祖先步骤不能用来定位本 run 的文件）」 |
| 请求形状非法（缺 `path` / 空 `runId`） | `INVALID_ARGUMENT`（zod 明细） |
| **对照：合法请求** | inspect `ok:true`（含清单）；read `status:"text"`、`text` = `第二轮改写` |
| **同一 run 的别的检查点也不替代** | `new.txt` 在**初始**快照 ⇒ `not_found`；在**第 2 轮**快照 ⇒ `text` = `新建文件内容` |

### 3.2 二进制和不可用附件分别显示（`unavailable` 8/8）

| 标本 | 列表徽标 | 内容区 | 编辑器 |
| --- | --- | --- | --- |
| `bin.dat`（真二进制） | — | 卡片标题「**二进制文件**」+「不参与文本比较（只展示大小与哈希）」+ 原始大小/完整哈希 + 两侧状态行「内容不可比较（二进制 / 附件缺失 / 损坏）」 | **一个编辑器都没渲染**（monaco 未加载） |
| `u2bad55_missing`（附件缺失） | 「**附件缺失**」 | 卡片标题「内容不可读」+「附件缺失，无法读取内容；不会用空文本或源目录兜底」+ 清单记录大小/哈希 | **无**（不渲染伪空文件） |
| `u2bad55_corrupt`（附件损坏） | 「**附件损坏**」 | 「附件与清单记录的哈希/长度不符，**拒绝展示内容**」+ 清单记录大小/哈希 | **无** |
| `u2bad55_noownsteps`（没有检查点的旧 run） | — | 检查点选择器**只剩「本 run 初始状态」**（不把祖先轮号冒充本 run 检查点） | — |

四条的 `fakeEmptyClaim`（"无变化 / 文件为空 / 文件是空的"）全为 **false**，且 `selfcheck` 之外的每个标本都已确认真机可读（`unavailable` 的 4 次 `enterFiles` 都通过了 store 活实例自检）。

### 3.3 失败运行已记录文件可查看（`errored` 6/6）

| 断言 | 实测 |
| --- | --- |
| run 级事实 | `RunSummary` = `{status:"completed", reason:"error", steps:2}`；概览页正文含「**出错终止**」（界面与数据同源） |
| 已落盘的检查点都列出 | 选择器 3 项：`本 run 初始状态` / `本 run 第 1 轮结束` / `本 run 第 2 轮结束`（无"漏项"、也无"凭空多出的步骤"） |
| 第 1 轮读出的正文 | monaco **真模型**：`diff.originalText = 初始版本`、`diff.modifiedText = 失败前的写入`（= `write_file` 的真实写入） |
| 切第 2 轮 | `pathHeader` 仍 `edit.txt`、内容仍可读、`fakeEmptyClaim = false` ⇒ **失败不撤销历史写入** |
| 只读 | `diff.modifiedReadOnly = true`、`standalone[].readOnly` 全 `true` |

> **口径说明（不是缺陷）**：该 run 的 `status` 是 `completed`、`reason` 是 `error`。按既有设计，`status` 只区分"**有没有终止事件**"（`crashed` = 无终止事件 ⇒ 界面「运行中断」），失败原因走 `reason`；`shared/outcome.ts` 的 `classifyOutcome` 把 `error` 映射成「出错终止」/`danger`/`normalEnd:false`。本任务以**界面文案 + reason 原值**双证据固定这一口径，避免把"status 不是 crashed"误读成缺陷。

### 3.4 阅读重试只读且重新校验（`readonly` 12/12）

浏览序列（全真点击）：第 2 轮 → 开 `edit.txt`(diff，`lineChangeCount = 1`) → 开 `long.txt`(0 差异) → 开 `bin.dat`(二进制) → 切「初始」→ 切回「第 2 轮」。

| 断言 | 实测（包装层日志，按 `(kind,key,side)` 分桶计数） |
| --- | --- |
| 清单失败不冒充空清单 | 注入 `inspect` 失败 ⇒ 出现「**重新读取清单**」入口，`fakeEmptyClaim = false` |
| 重试清单**真的重发** | `inspect`：`occurrence 1 → fail`，点击后 `occurrence 2 → pass`，清单恢复到 5 条 |
| 内容失败不冒充「不存在」 | 注入**所选侧**读 `edit.txt` 失败 ⇒ 出现「**重新读取所选侧**」入口与"这是只读通道的失败，并不表示该文件不存在" |
| 重试内容**真的重发** | `read/selected/edit.txt`：`occurrence 1 → fail`，点击后 `occurrence 2 → pass`，随后 monaco 真模型显示 `初始版本` → `第二轮改写`（**当前**校验结果，不是旧内容/源目录兜底） |
| 编辑器只读 | 浏览全程 `modifiedReadOnly = true`（无替换/写入通道） |

### 3.5 文件浏览过程无写入 + 源/父/兄弟/trace/附件零变化（`readonly`）

冻结面 = 递归逐文件 SHA-256，共 **119 条哈希记录 / 113 个唯一文件**（`source/` 因同时属于夹具目录而被计两次）：

| 数据面 | 文件数 | 说明 |
| --- | --- | --- |
| `source/`（夹具源目录） | 6 | 含 `ipc-guard` 写入的哨兵文件；摘要 `e0c70f3b…21ce8` **前后一致** |
| 夹具目录 `u2-file-fixtures-55/`（含 `source/` + `data/` + 清单） | 22 | 6 source + 6 夹具 trace + 9 夹具附件 + `MANIFEST-55.json` |
| live `traces/` | 70 | 69 个 run trace + 1 个**既有**遗留 `tmp-measure-mu2ivsni.tmp`（A2 度量脚本产物，与本案无关） |
| live `workspace-blobs/` | 21 | 全部附件 |

**结果：`diffSurface(before, after) = []`（零差异、零新增、零消失）**；`traces 70→70`、`blobs 21→21`、`source 6→6`。由于 trace 逐字节不变，**未落任何新的 `llm.call` / `tool.invoke`** ⇒ 模型与工具调用为零。

**"判据有牙"自检（`selfcheck` 3/3）**：故意新增 `canary.tmp` ⇒ 检出 `fixture/canary.tmp 新增`；故意改写清单 ⇒ 检出 `fixture/MANIFEST-55.json 哈希变化`；两者**逐字节还原后回到零差异**。这排除了"冻结面永远返回无差异"的空转真。

---

## 4. 陷阱记录（harness 侧，全部已修，别再踩）

1. **`pickFilter` / `CKPT_ACTIVE_EXPR` 的 `find` 返回 `undefined` 而非 `null`**：`a === null ? null : a.textContent` 在"一个活动项都没有"时抛 `TypeError`（首轮实测把"没有活动筛选"报成脚本崩溃）。改为 `?? null` + 把活动项/按钮存在性写进报错信息。
2. **`monacoOrNull` 的 `null` 不能与"没有 diff 编辑器"混写**：`null?.diff === null` 求值为 `undefined === null` ⇒ `false`，会把"**一个编辑器都没渲染**"误报成"有编辑器"（首轮 8 条里 3 条就是这么假失败的）。改用 `noDiffEditor / noEditorAtAll / allReadOnly` 三个显式判词。
3. **同路径两侧读共用计数桶 ⇒ 点名某一侧的注入静默失效**：`(kind,key,side)` 里 `occurrence` 若只按 `key` 计数，"第 1 次"会被**先发出的那一侧**（初始侧）消费掉，规则永不匹配。改为按 `kind|key|side` 分桶。（5.4 已按 `side` 匹配，但计数仍是共享的——本轮补上。）
4. **同 (检查点, 路径) 已在会话里结算过时，再点同一个文件不会重发 IPC**：注入失败"永不生效"、重试按钮也不存在。必须先**切到初始再切回目标轮**，制造一次真正的重新读取。
5. **模块 URL 形态不唯一**：`performance` 资源表里 store 的真实 URL 是 `http://localhost:5173/src/store.ts`（Vite root = `apps/desktop/src/renderer`），而 5.4 记录的是 `/@fs/D:/…/src/renderer/src/store.ts?t=…`。`appImport` 改为接受**候选子串数组**，并按「带 `?t=` → 非 `/@fs/` → 首个匹配」排序挑选。
6. **`node --check` 抓不到模板字面量内嵌反引号**（`domExpr` 是模板字符串）：注释里写 `` ` `` 会直接把脚本打崩。

---

## 5. 本轮发现：**1.1 的"无自有完成步骤"标本是坏的**（已在本任务的生成器里修正）

- **症状**：把 `u2bad55_noownsteps`（按 1.1 同法构造）放进 live 数据目录后，**运行列表里该 run 直接报错**：
  「读取 run 失败：`fork.at_span` 不能等于 `resume_after_step`（`s_01`）：编辑点是该轮内的工具调用，不是轮次容器」
  ⇒ 详情页不可用、文件页进不去（`filesTab = false`、store 里没有它的 key、清单 0 条），连带 `unavailable` 的两条断言失败。
- **根因**：1.1 的 `deriveNoOwnSteps` 把 `fork.at_span` 与 `fork.resume_after_step` **都设成同一个 `agent.step` id**。
  `trace-sdk` 的 `resolveBranch`（`packages/trace-sdk/src/branch.ts:152-168`）硬校验：`at_span` 必须是**该轮内的工具调用**（`resume_after_step` 的后代）且不得等于它。
- **为什么 1.1 没发现**：1.1 的用例只 `readRun` **本文件**（不触发分支解析），而桌面端"经运行列表读取"走的是 `loadRunRecord` → `resolveBranch`。**只读本文件能过、经分支解析被拒**，正是"标本看起来合法但实机读不出来"。
- **修正（本任务生成器）**：`at_span` 取第 1 轮内真实的 `tool.invoke` id，`resume_after_step` 取该轮 `agent.step` id；并在自检里**显式调用 `resolveBranch`**（不再只 `readRun`），把这条真实读取路径纳入标本自检。
- **影响面（如实标注）**：`openspec/changes/improve-workspace-file-reading/test/u2-file-fixtures.test.ts`（1.1 的 38 条）覆盖的是 `u2bad_noownsteps` 的**文件级**读取，未覆盖分支解析 ⇒ 那 38 条**仍然成立但不能据此认为该标本可用于实机**。1.1 的生成器**本轮未改动**（避免动已完成任务的制品与其证据），此处如实记录为遗留项，供 6.3 的证据索引与后续修复参考。

---

## 6. 未验证项与边界（如实标注）

- **`ipc-guard` 不产界面截图**：它是 IPC 级（直接调 `window.api`），截图只会是一张无关的概览页；把它当"越权拒绝的证据"是误导。原始证据以 `measurements.json` 的 Envelope 为准。
- **`selfcheck` 的 3 条不计入验收项**：它是"判据有牙"的 canary，不是 spec 场景。
- **哨兵文件是本次新建的宿主文件**（`source/secret-sentinel.txt`）：判据是"返回值里从未出现该串"。这能抓住"把请求路径拼进宿主路径去读"的实现，但**不能**覆盖"读了却因别的原因没回传字节"这类更隐蔽的形态。
- **`bin.dat` 的"二进制"判据**依据是非 UTF-8 字节序列（含 `0xff/0xfe`）；`write_file` 只能写合法 UTF-8，故"文本 → 后来变二进制"这种状态引擎不会原生录制（5.4 已记录）。
- **`u2bad55_corrupt` 的损坏是"等长 + 只有哈希不符"**：把 `corrupt` 的判据精确钉在哈希校验上；但产品文案是「哈希/长度不符」合一表述，故无法从文案区分是哪一项拦下的——判据以状态码 `corrupt` 为准。
- **`readonly` 的 `source/` 校验证据力有限**：隔离 run 的 `meta.workspace` 不含源目录路径，应用在结构上就够不到它；该面严格说不算"产品可能写入"的面。真正载重的是 live `traces/` 与 `workspace-blobs/` 的逐字节不变。
- **未验证**：5.6（重启 / 整体迁移 / 仅迁 JSONL / 断网读取）。该任务仍未勾选。
- 本任务**未提交、未归档**；`HANDOFF.md` 与 `docs/` 不入库（按交接单要求留 owner 手动处理）。