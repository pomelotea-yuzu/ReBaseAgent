# U2 任务 5.4 实机验收证据（2026-09-23/24）

change：`improve-workspace-file-reading` · 任务 5.4（实测双侧异常、延迟切换/重试及工具命令）
原始数据：`.workbuddy/u2/u2-54/measurements.json`（**44/44 checks 全绿**）· 截图 19 张（本目录）
采集脚本：`apps/desktop/scripts/u2-54-cdp.cjs` · 夹具生成：`apps/desktop/scripts/gen-u2-54-side-fixtures.cjs`
变异验证：`.workbuddy/u2/u2-54-mutate.cjs`（**6/6 全被捕获**，baseline 18/18 全绿）

任务原文（`tasks.md`）：

> **5.4** 实测双侧异常、延迟切换/重试及工具命令（1.5h）；验证"不可用侧不伪装为空差异""快速切换不串清单正文错误和加载""同对象重试与往返有请求代次""复制路径原文及元信息""查找换行和差异定位使用当前文件"，不以静态结构测试代替点击和内容核对。

**本轮结论：五个 spec 场景实机可达且全绿（44/44）；过程中暴露并修复 2 处真实产品缺陷（均属"可读侧全文无处可看"这一条），另有 6 类 harness 自身的假失败/假通过被纠正（含 1 处"没输入任何字符却断言有匹配"的假通过）。**

---

## 1. 环境真值

| 项 | 值 |
| --- | --- |
| 物理屏 | 2560×1600 @ Windows 缩放 210% |
| 本档 CSS 视口 | **1210×713**，`devicePixelRatio` **2.1**（`measurements.json` 各场景 dom 快照一致） |
| 断点档 | **medium（960–1279）** —— 文件页会临时收起左侧运行导航（U1 既定布局） |
| 应用 | Vite dev `http://localhost:5173/`，CDP 调试端口 **9612**；脚本**不 spawn、不改窗、不重启 dev、不伪造 deviceMetrics** |
| store 探针真实 URL | `http://localhost:5173/@fs/D:/ReBaseAgent/apps/desktop/src/renderer/src/store.ts?t=1790173764766` |
| 冷重载后运行列表 | **63** 项（每个 tag 开跑前 `Page.reload{ignoreCache:true}` 并等名单就绪） |

夹具（`gen-u2-54-side-fixtures.cjs` 生成，已安装进 live 数据目录）：

| 夹具 | 形态 | 用途 |
| --- | --- | --- |
| `run_mue9rvkh_i9oil7`（side-data） | 第 2 轮末：`was-binary.dat` **初始侧 binary / 所选侧 text**（`现在是文本内容`）；`steady.txt` 两侧 text | A 型单侧可读、快速切换、卸载、失败重试 |
| `u2side_mirror`（side-broken，手工镜像） | 第 1 轮末：`steady.txt` **初始侧 text（`初始文本内容`）/ 所选侧 binary** | **左右互换**（B 型） |
| `run_mudwrlbg_199xw1`（root） | 第 2 轮末 `edit.txt` 有真实差异（`diffCount=1`）、`long.txt` 200 行且 0 差异 | 差异导航 / 查找作用当前文件 / 复制逻辑全文 |

---

## 2. 真实性保障（与 5.1/5.2/5.3 同纪律）

- **真交互**：真点击（`element.click()` 于真实渲染按钮）、真键入（`Input.insertText`）、真键盘（`Input.dispatchKeyEvent`）、真滚轮。不使用合成 DOM 事件造证据。
- **三条独立通道**：
  - **DOM**：`[role="option"][data-file-path]`、工具按钮的 `disabled`/`title`、`.m-4` 状态卡文案、monaco `.matchesCount`、`[data-testid="single-side-editor"]`、`.monaco-diff-editor`；
  - **store**（dev 专有）：从 `performance.getEntriesByType('resource')` 解析**应用自己用过的模块 URL** 再 `import()` 同一 URL，读 `readingByRun`（模块身份 = 完整 URL，写 `/src/store.ts` 会拿到另一份空 store 且不报错）；
  - **monaco**（`monaco-bootstrap.ensureMonaco()`）：读**真模型文本**（`models[].text` / `standalone[].text` / `diff.originalText|modifiedText`）、`readOnly`、`lineChangeCount`。**"可读侧完整展示"必须以此立证**——DOM 只能证明"有块编辑器"，模型文本才能证明"全文真的在里面"。
- **注入走真 IPC 包装层**：`installHooks` 包住 store 上的 `readWorkspaceFile`，**原动作照常执行**，只对指定规则加延迟/换哨兵/注入失败，并记录 `{kind,key,side,occurrence,mode}` 日志 —— 判据"注入真的生效"由日志本身立证（不做空转断言）。
- **假阴性守卫**：每次进入文件页后 `assertStoreLive()` 自检（`byRunKeys` 必含该 run、`selectedRunId`/`tab` 相符），不满足即 throw；`enterFiles` 读不到运行名单直接抛错，不静默早退。

---

## 3. 结果矩阵（44/44）

| tag | checks | 覆盖的 spec 场景 |
| --- | --- | --- |
| `sides` | **9/9** | 不可用侧不伪装为空差异（A 型：所选可读/初始不可用） |
| `sides`（B 段） | — | 同上**左右互换**（初始可读/所选不可用） |
| `both-unreadable` | **5/5** | 不可用侧不伪装为空差异（两侧都不可读） |
| `tools-copy` | **9/9** | 复制路径原文及元信息 |
| `tools-find` | **9/9** | 查找换行和差异定位使用当前文件 |
| `race-retry` | **12/12** | 快速切换不串清单正文错误和加载 + 同对象重试与往返有请求代次 |
| `probe` | 0（只 dump 真机事实） | 诊断：模块 URL、运行名单、夹具形态、剪贴板授权 |
| **合计** | **44/44，0 失败** | |

### 3.1 不可用侧不伪装为空差异（`sides` 9/9 + `both-unreadable` 5/5）

A 型（`was-binary.dat` 第 2 轮，初始侧 binary / 所选侧 text）：

| 断言 | 实测 |
| --- | --- |
| 两侧状态都标出 | `初始快照侧：内容不可比较（二进制 / 附件缺失 / 损坏）；所选检查点侧：有文本` |
| **可读侧完整展示** | monaco `standalone[0].text = 现在是文本内容`（真模型全文），`readOnly=true` |
| 走**单侧只读视图**而非 diff | `[data-testid="single-side-editor"]=true`、`.monaco-diff-editor=false` |
| 该侧仍可复制查找 | `复制右侧原文.disabled=false`、`查找.disabled=false`、`换行：开.disabled=false` |
| 不可用侧诚实禁用 | `复制左侧原文.disabled=true` |

B 型（左右互换，`u2side_mirror` 第 1 轮）：`[data-testid="single-side-editor"]=true`、`.monaco-diff-editor=false`、展示**左（初始）侧**原文、`复制左侧原文.disabled=false`、`查找.disabled=false` —— 与 A 型逐条对称。

两侧都不可读（`was-binary.dat` 第 1 轮，两侧皆 binary）：**一个编辑器都不渲染**（`single=false` 且 `diff=false`，monaco 无模型）、卡片给「二进制文件」+ 真实大小/哈希、无「无变化/文件为空」这类伪装、上一/下一差异诚实禁用、元信息可复制。

### 3.2 复制路径原文及元信息（`tools-copy` 9/9）

| 断言 | 实测 |
| --- | --- |
| 元信息 = 真实大小 + **完整 64 位**哈希 | 剪贴板 `9 B\n de0716…ed51`（64 hex），非 header 里截断的 12 位 |
| 不可用侧「复制原文」诚实禁用 | `disabled=true` 且点击后剪贴板**仍是哨兵值**（未写入任何东西） |
| 复制左右原文 = **逻辑全文** | 模型 8529 字符 vs 剪贴板 8732 字符 ⇒ **差 203 = 行数**，即 Windows 剪贴板把 LF 规范化为 CRLF；归一后**逐字节一致**（见 §5 陷阱 2） |
| 搜索隐藏 / 目录收起后复制路径 | 清单被筛空（`options=0, query=zzz-no-match`）时仍复制出完整逻辑路径 |
| 剪贴板失败就近提示 | 真注入 `writeText` reject ⇒ 就近提示「剪贴板故障」，**不假报成功** |

### 3.3 查找换行和差异定位使用当前文件（`tools-find` 9/9）

| 断言 | 实测 |
| --- | --- |
| 有真实差异 ⇒ 导航可用 | `edit.txt` `diffCount=1`，上一/下一差异 `disabled=false`，点「下一差异」后位置落在修改侧合法行内 |
| 编辑器只读 | `standalone[].readOnly` 全 true、`diff.modifiedReadOnly=true` |
| **查找的键入真的生效** | 查找框输入值 `版本`，`.matchesCount = "1 of 1"`；**无替换区**（`replaceShown=false`） |
| 换行只改显示不改原文 | `wordWrap` 由 true→false，`diff.modifiedText` 与切换前**完全一致** |
| 按**当前文件**重算 | 切到 `long.txt` 后 `lineChangeCount=0`，上一/下一差异 `disabled=true`（不沿用 `edit.txt` 的） |
| 查找作用于当前模型 | 输入 `alpha`（只存在于 a.txt）⇒ `.matchesCount = "No results"`；输入 `长文本样本` ⇒ `"1 of 1"` |

### 3.4 快速切换不串清单正文错误和加载 + 同对象重试与往返有请求代次（`race-retry` 12/12）

注入日志（**真 IPC 包装层**，`side` 标明是哪一侧的读）：

- ③ `was-binary.dat/selected` 第 1 次读：`delayMs=3200, mode=sentinel`（迟到的旧响应带哨兵）⇒ 期间切到 `steady.txt` 并等迟到响应到达后：`path=steady.txt`、编辑器具新文件文本、**不含哨兵**、`bodyHasLoading=false`。
- ④ 同对象往返 A→B→A：`selected` 侧第 1 次读 `sentinel`（最旧的 A），A 再次点开后第 3 次读 `pass` ⇒ 最旧 A 迟到返回后 `path=was-binary.dat`、**含真实文本 `现在是文本内容`、不含哨兵**。
- 卸载场景：`steady.txt/selected` 读到 `delayMs=6000`（**大于 `pickFile` 自身约 2.3s 的耗时**，确保响应落在切到步骤页**之后**）⇒ 「离开时 path=steady.txt ckpt=s_05」与「迟到最后 path=steady.txt ckpt=s_05」**一致**，返回文件页读到真实内容。
- 失败与重试：`side: "selected"` 注入失败 ⇒ `path` 仍为 `was-binary.dat`（**不退化成"不存在"**）、卡片明说「这是只读通道的失败，并不表示该文件不存在」、给「重新读取该文件」入口；点击后包装层日志 **before=23 → after=24**（真的又发了一次只读 IPC），随后显示**当前校验结果**真实文本。

---

## 4. 本轮发现并修复的 2 处真实产品缺陷

均违反 delta L160 原文：「两侧分别标出真实状态，**可读侧完整展示并可复制查找**，禁止把不可用侧置空进行 diff；**左右互换同样成立**」。静态单测全绿照不出来（逻辑层判据都对，是**展示层没接上**），故同时补**能力断言**与**接线契约**。

### 缺陷 1 · 单侧可读时**可读侧全文无处可看**（`sides` A/B 各失败 1–3 条）

- **症状**：A 型走 `!diffEligibility.ok` 分支、B 型走 `!comparability.ok` 分支，二者都只渲染 header + toolbar + 状态卡，**没有任何编辑器**；可读侧原文既看不到、复制/查找/换行还被判禁（title「内容不可比较时不可查找」）。
- **根因**：① 两个早返回分支都没有"单侧展示"通道；② 工具判据出自 `lib/file-tools.ts` 的 `find: anyReady && input.diffEligible`（`wordWrap` 同）——把"有编辑器"与"能进 diff"混为一谈。
- **修复**：`WorkspaceFileView` 新增**只读单侧视图**（复用懒加载 `MonacoCodeEditor`，锚点 `data-testid="single-side-editor"` 挂在**真实 DOM 包裹层**上，`readOnly: true`、无替换入口、`onMount` 接实例供查找）；`openFind` 改为「diff 的修改侧 → 单侧实例」；`resolveToolEnablement` 新增必填 `editorReady`（与 `diffEligible` 分离），`find/wordWrap` 改判 `anyReady && editorReady`。

### 缺陷 2 · `!comparability.ok` 分支**只标所选侧**，另一侧状态完全不可见（`sides` B 型）

- **症状**：B 型（初始侧可读、所选侧 binary）看到的是「二进制文件不参与文本比较」——**"初始侧有文本"这件事一个字都没出现**。
- **修复**：该分支补与 `!diffEligibility.ok` 分支**同源同文案**的两侧状态行（`noteText`），并把「重新读取初始快照」入口补进该分支；`noteText` 由分支内提升为组件级共用，避免两处各说各话。

### 附带修复（同源，由新增测试当场坐实）

- **所选侧"加载中/失败/尚无结果"时**，三个早返回是**独占卡**（整卡只有一句话）⇒ 另一侧可读时会把可读侧全文一起吞掉。改为以 `initialReadableText === null` 门控：另一侧可读就落入统一的两侧呈现；所选侧的失败明细（`error.code`/`message`）在统一分支内补出，**错误码不丢**。
- 门控后 `current` 可能为 `null` ⇒ `rejected`/`not_found` 早返回补非空判定；**头部大小/哈希**改为 `current ?? 清单记录` 兜底（新测试 `初始侧 text + 所选侧加载中` 当场抓出 `current.bytes` 抛异常）。

### 回归与变异验证

- 新增 `test/file-single-side-view.test.ts`（**18 用例**：能力断言 6 + 门控能力断言 4 + 接线契约 8）；`test/file-tools.test.ts` 补 `editorReady` 并把"只有一侧 ready"拆成两个用例（`editorReady` 真/假两条路）。
- `.workbuddy/u2/u2-54-mutate.cjs` 打 6 个变异，**6/6 全被捕获**（baseline 18/18 全绿）：M1 单侧视图不渲染 / M2 两侧状态不标 / M3 判据退回 `diffEligible` / M4 查找不接单侧实例 / M5 单侧编辑器非只读 / M6 早返回门控被拿掉。证明源码级接线断言**非空转**。

---

## 5. 陷阱记录（harness 侧，全部已修，别再踩）

1. **`data-testid` 给 `<Editor>`/`<DiffEditor>` 在"已加载"时不落 DOM**：`@monaco-editor/react` 只通过 `wrapperProps` 透传 `data-*`，直接给的 props 会被丢弃 ⇒ `hasDiffEditor` 探针实际只命中"懒加载占位"，`hasSingleSideEditor` 恒为假。**改为**：diff 用 monaco 原生容器 `.monaco-diff-editor`，单侧视图由**产品挂在真实包裹层**上的 `data-testid`。
2. **Windows 剪贴板把 LF 规范化为 CRLF**：`navigator.clipboard.readText()` 返回 `\r\n`，与模型文本"逐字节不一致"是**平台行为**而非产品缺陷（模型 8529 → 剪贴板 8732，差 203 = 行数）。断言前统一 `replace(/\r\n/g,"\n")` 归一，仅用于比较。
3. **查找框不是 `input[aria-label="查找"]`**：monaco 按自己的 locale 设标签（英文 `Find`），内核还可能是 `textarea` ⇒ 原 `typeInto(call,"查找",…)` **一个字符都没输进去**，返回 false 被忽略。更坏的是 monaco 会用**编辑器里的选区自动预填**查找框，于是"有匹配"断言在**没输入任何东西**的情况下**假通过**（实测 `typeFind=false` 却 `matchesCount="1 of 1"`）。**改为**：按 `.monaco-inputbox .input` 定位 + `select()` 后 `Input.insertText`，并断言输入值等于键入词。
4. **`occurrence` 计数跨子场景累加**：`installHooks` 的 `__u254n` 是全程累加的，`setRules` 只换规则不重置 ⇒ 后续子场景的 `occurrence:1` 早已被前一个子场景消费，**注入静默失效**（日志 `…mode=sentinel,pass,pass…`，失败从未注入，白查一轮）。**改为**：`setRules` 同时 `window.__u254n = {}`（换规则即新开局）。
5. **同路径两侧读共用 `key`**：失败/哨兵若只按 `key` 匹配，会落在"先发出的那一次"（实测**所选侧总是先发**，但不能依赖顺序）⇒ 断言不可控。**改为**：包装层记录并支持按 `side: "initial"|"selected"` 点名（读请求省略 `stepSpanId` = 初始侧）。
6. **卸载场景的两个假失败**：① 基准取在 `pickFile` **之前**，把用户自己刚选中的文件当成"迟到响应改写"；② `delayMs: 3000` **小于 `pickFile` 自身约 2.3s 的耗时**，"卸载后迟到"这个前提根本不成立。**改为**：基准取在切页**之后**，延迟提到 6000ms 并加"注入确实延迟过"的夹具对照。
7. **失败态的 UI 形态决定断言措辞**：另一侧不可读时正确形态是**独占错误卡**（「重新读取该文件」），不是统一卡内的「重新读取所选侧」；重试入口文案按 DOM 实测挑，不写死。
8. `node --check` **抓不到模板字面量内嵌反引号**（`domExpr` 是模板字符串）：注释里写 `` ` `` 会直接把脚本打崩，只能靠"跑一次"发现。

---

## 6. 未验证项与边界（如实标注）

- **`probe` tag 只 dump 真机事实，不计 checks**（`0/0`）；它不构成验收通过项，仅作诊断基线。因此本任务没有 `probe` 的"通过数"。
- **`tools-copy` 的两条"复制原文 = 逻辑全文"断言有一个已知边界**：判据是"归一 CRLF 后与 monaco 模型逐字节一致"（外加"差异数恰等于行数"）。它能抓出漏行、截断、只复制显示片段等错误，但**无法区分**"平台把 LF 规范化为 CRLF"与"产品在写入时自己改写了行尾"——后者要单独设计判据（如比对不含 `\n` 的镜像文本），本轮未做。
- **单侧视图的"完整展示"以 monaco 真模型文本立证**（`standalone[].text` + `readOnly`），DOM 只作"进没进编辑器"的结构锚点；截图为本目录 19 张，逐张对应各 §3 小节所记场景，但**截图与断言的逐条对号未再逐张核验**（断言判据以 `measurements.json` 为准）。
- 本任务**未**验证：5.5（IPC 安全 / 只读不变性 / SHA-256 前后一致）、5.6（重启/迁移/离线）。二者仍未勾选。
- 本任务**未提交、未归档**；`HANDOFF.md` 与 `docs/` 不入库（按交接单要求留 owner 手动处理）。