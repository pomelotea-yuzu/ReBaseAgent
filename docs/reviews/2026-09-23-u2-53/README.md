# U2 任务 5.3 实机验收证据（2026-09-23）

change：`improve-workspace-file-reading` · 任务 5.3（实测文件/步骤/运行/分支/设置往返、长正文滚动及显式定位）
原始数据：`.workbuddy/u2/u2-53/measurements.json`（**36/36 checks 全绿**）· 截图 15 张（本目录）
采集脚本：`apps/desktop/scripts/u2-53-cdp.cjs`（+ `scripts/lib/u2-cdp-util.cjs`）

任务原文（`tasks.md`）：

> **5.3** 实测文件/步骤/运行/分支/设置往返、长正文滚动及显式定位（1.5h）；验证"文件页签往返恢复阅读""跨运行和辅助视图返回恢复文件""显式文件定位覆盖历史""失效检查点和路径安全回退"，含同名跨 run、无效 path 和搜索隐藏选择。

对应 spec 四场景：见 `specs/desktop-ui/spec.md`「文件页签往返恢复阅读」「跨运行和辅助视图返回恢复文件」「显式文件定位覆盖历史」「失效检查点和路径安全回退」。

**本轮结论：四场景全部实机可达且全绿（36/36）；过程中暴露并修复 6 处真实产品缺陷（其中 4 处是"纯逻辑写好了但没接上界面"的接线缺口）。**

---

## 1. 环境真值

| 项 | 值 |
| --- | --- |
| 物理屏 | 2560×1600 @ Windows 缩放 210% |
| 本档 CSS 视口 | **1210×713**，`devicePixelRatio` **2.1**（`measurements.json` 各场景 dom 快照一致） |
| 断点档 | **medium（960–1279）** —— 文件页会临时收起左侧运行导航（U1 既定布局） |
| 窗口 | 由 PowerShell 工具设定，脚本**不 spawn、不改窗、不重启 dev、不伪造 deviceMetrics** |

⚠️ 本档落在 medium，**切 run 必须先回「概览」**（文件页收起运行列表）——这是产品既有布局纪律，不是缺陷；harness 走同一路径并如实记录 `selectDetour`（roundtrip 为 `false`，跨 run 场景为 `true`）。

---

## 2. 真实性保障（与 5.1/5.2 同纪律）

- **真交互**：真点击（`element.click()` 于真实渲染按钮）、真滚轮（`Input.dispatchMouseEvent{type:"mouseWheel"}`）、真键盘（`Input.dispatchKeyEvent`）、真文本输入（`Input.insertText`）。不使用合成 DOM 事件、不直接改 `scrollTop` 造证据。
- **两条独立通道**：
  - **DOM**：`[role="option"][data-file-path]`、选中项、搜索框真值、`.monaco-diff-editor` 的**首个完整可见行号**、失效提示文案、列表 `scrollTop`；
  - **store**（dev 专有）：从 `performance.getEntriesByType('resource')` 解析出**应用自己用过的模块 URL**（`…/@fs/D:/…/src/renderer/src/store.ts?t=<ts>`）再 `import()` 同一 URL，读 `readingByRun` —— 这是"位置/选择真的被记住"的**权威**证据（DOM 只证明"看得见"）。
- **假阴性守卫**：每次进入文件页后 `assertStoreLive()` 自检（`byRunKeys` 必含该 run、`selectedRunId`/`tab` 相符），不满足即 throw。ES 模块身份 = **完整 URL（含查询串）**，写 `import('/src/store.ts')` 会拿到**另一份空 store** 且**不报错**——这是本轮实测踩到的头号陷阱（见 §6 陷阱 1）。本轮实际解析到的 URL：`http://localhost:5173/@fs/D:/ReBaseAgent/apps/desktop/src/renderer/src/store.ts?t=1790173764766`。
- **可见性判据**：列表是否"真的可见"用 `getClientRects().length > 0`，不看"元素在不在 DOM 里"（`.hidden` / `display:none` 下 `querySelector` 照样命中，旧写法会假通过）。
- **冷起点**：每个 tag 运行前 `Page.reload({ignoreCache:true})` 并等运行列表就绪（61 run），避免上一个 tag 的选中 run/文件页状态串味，同时让模块图版本戳稳定。

---

## 3. 结果矩阵（36/36）

| tag | checks | 覆盖的 spec 场景 |
| --- | --- | --- |
| `roundtrip` | **8/8** | 文件页签往返恢复阅读（含长正文滚动 + 列表位置） |
| `cross-run` | **9/9** | 跨运行和辅助视图返回恢复文件（同名 step/path 不串） |
| `explicit` | **5/5** | 显式文件定位覆盖历史（自有步骤入口 → 该轮末） |
| `search-hidden` | **5/5** | 显式目标解除阻挡它的搜索筛选 |
| `fallback` | **9/9** | 失效检查点和路径安全回退 |
| `probe` | 0（只 dump 真机事实） | 诊断：模块 URL、运行清单、初始 DOM |
| **合计** | **36/36，0 失败** | |

### 3.1 文件页签往返恢复阅读（`roundtrip` 8/8）

夹具：根 run `run_mudwrlbg_199xw1`，第 3 轮结束检查点 `s_11`，长正文 `long.txt`（200 行中文 + 两条 400 字符超长行）。

| 断言 | 实测 |
| --- | --- |
| 长正文真的滚动过 | DOM 首个可见行 `1 → 8`（真滚轮 2400px） |
| 位置写进会话状态 | `contentScroll = {stepSpanId:"s_11", path:"long.txt", line:7, offset:2}`（**行号 + 相对偏移**，不是裸像素、不是正文副本） |
| store 与 DOM 一致 | store `line=7` vs DOM `firstLine=8`（**±1 属语义差**：DOM 取第一条*完整可见*行，store 取 Monaco `getVisibleRanges()[0]` 的*部分可见*行；断言容差 2） |
| 往返后回到文件页 | 页签 = 文件；检查点/路径 = `s_11`/`long.txt`（不是默认值） |
| 往返后模式与布局偏好 | `pane=content`、`wordWrap=true`、`diffPreference=auto`、`directoryWidth=232` |
| **往返后正文位置真的恢复** | 步骤页 → 回文件页后 DOM 首个可见行仍为 **8** |
| 列表位置一致 | 往返后 `data-list-scroll-top` = store 值 **1.4286**，DOM 实测 `round()` = **1**（容差 1 内） |

> **⚠️ 列表滚动这一项在本档证据力弱，如实标注**：该夹具清单高 382 / 可视高 380 ⇒ 全清单**只可滚 2px**，真滚轮（400px）实测 `scrollTop` 停在 **0**，往返后为 **1.4286**（重挂载时焦点/可见性带入的微位移）。因此这一行只能证明"**store 与 DOM 一致、位置不会在往返中丢失**"，**不能**证明"跨内容的大位移恢复"。列表恢复的**判据与门控**由 `test/file-view-scroll-wiring.test.ts`（接线契约）+ 变异 M4（列表只写不读 ⇒ 被捕获）单独立证；**正文位置**（`line 7` ↔ DOM `8`，容差 2）才是本场景的强证据。

### 3.2 跨运行和辅助视图返回恢复文件（`cross-run` 9/9）

A = 根 run（检查点 `s_01`，第 1 轮），B = 一次分叉 `run_mudwrlgl_93di`（检查点 `s_17`），**两 run 各有同名 `long.txt`**。

| 项 | A | B |
| --- | --- | --- |
| checkpoint | `s_01` | `s_17` |
| path | `long.txt` | `long.txt` |
| `contentScroll` | `{s_01, long.txt, line 7, offset 2}` | `{s_17, long.txt, line 4, offset 10}` |
| DOM 首个可见行 | 8 | 5 |

断言覆盖：同名文件在两 run **各自持有不同检查点**（夹具对照）；跨运行回 A 后检查点/路径/正文位置**精确恢复为 A 自己的值，且不等于 B 的位置**（`restore` 后 A 仍 `line 7`，B 不受影响、仍 `s_17`）；经**分支树 + 设置**两个辅助视图返回后 A 仍在文件页且位置仍为 `line 7`；全程 `pendingFileTarget === null`，证明**普通返回不消费显式目标**。

### 3.3 显式文件定位覆盖历史（`explicit` 5/5）

从**当前运行的自有步骤**打开该轮文件（步骤页新增入口）：

| 断言 | 实测 |
| --- | --- |
| 入口在界面上可达 | 祖先/非自有完成步骤页 **不渲染**入口（`stepEntryVisible=False`）；自有完成步骤页**渲染**（`True`） |
| 覆盖历史检查点 | 历史 `s_11` → 定位后 **`s_01`**，选择器高亮「本 run 第 1 轮结束」 |
| 无 path 的显式目标 | `path=null`、`pane=list`（清空旧文件选择并显示列表） |
| 定位后可用 | 页签 = 文件、清单 6 项、列表可见 |
| 一次性消费 | `pendingFileTarget` 清空，不残留到下次导航 |

### 3.4 失效检查点和路径安全回退（`fallback` 9/9）

注入"清单里不存在的 path"与"不属于本 run 的 checkpoint"（走真实 store 入口，与产品同一 API）：

| 断言 | 实测 |
| --- | --- |
| 失效 path ⇒ 可见提示 | 「不在所选清单里」提示**真渲染**（不静默回退） |
| 失效 path ⇒ **真的写回清空** | `path = null`（此前只在本帧算 fallback，会话里一直留着失效值） |
| 清空选择 | `selectedFile = null`，**不改选同名路径** |
| 显示列表且**真的可见** | `listVisible=true`、清单 7 项 |
| 清理一次到位 | 往返后仍 `path=null` 且**提示不再重复出现**（"清理"不是"永久告警"） |
| 失效检查点 ⇒ 可见提示 | 「已不属于本…」提示真渲染 |
| 失效检查点 ⇒ **写回** | `checkpoint` 由 `span_not_in_this_run` → **`s_11`** |
| 高亮最近自有完成步骤 | 激活项 = 「本 run 第 3 轮结束」（列表 4 项：初始 + 第 1/2/3 轮） |
| 回退后仍可读 | 清单 7 项、列表可见（不因失效引用空转） |

### 3.5 搜索隐藏选择（`search-hidden` 5/5）

先制造阻挡态：真输入搜索词 ⇒ 清单被筛空（`query="not-exist"`、`options=0`，夹具对照）。再走显式目标（带 `path=long.txt`）：

| 断言 | 实测 |
| --- | --- |
| 选中目标并显示内容 | `path=long.txt`、`pane=content` |
| **清空阻挡它的搜索** | `query=""`（store 与搜索框 DOM 双证） |
| **并切 all** | `filter="all"` |
| 目标在列表可见 | `long.txt` 真渲染为选项 |

---

## 4. 本轮发现并修复的 6 处真实产品缺陷

全部由实机验收按 evidence-first 暴露；其中 ①②③④ 属"纯逻辑写好但**没接上界面**"，静态单测全绿照不出来，故同时补**能力断言**（渲染出来没有）与**接线契约**（源码里到底连没连）。

### 缺陷 1 · 正文滚动位置**根本没有字段**（4.3 被误勾）

- **症状**：长正文滚到中部 → 文件→步骤→文件 往返后**必然回到顶部**。
- **根因**：`FileReadingState` 只有 `listScrollTop`，正文位置无处可存；连接层也没把正文位置下传/写回。
- **修复**：新增 `lib/file-scroll.ts`（`ContentScrollAnchor` = 所属 step/path + **行号 + 相对该行顶部的偏移**；`buildContentAnchor` / `anchorMatches` / `resolveAnchorScrollTop` / `clampAnchorLine` / `sameAnchor`）；`FileReadingState.contentScroll` 字段；`WorkspaceFileView` 在编辑器 mount 时按 (step, path) 匹配后恢复，并订阅 `onDidScrollChange` 去重上报。像素偏移**不可跨内容复用**，故必须匹配身份后按行重算。

### 缺陷 2 · 列表滚动位置**只写不读**（4.3 被误勾）

- **症状**：`data-list-scroll-top` 只出不进，列表位置往返后永远回顶部。
- **修复**：`listScrollRef` + 复用既有 `decideRestore`/`resolveScrollRestore` 门控（按"检查点 + 清单规模"记账，容器未布局时不恢复也不记账，每身份只恢复一次）；`onScroll` 改为先判"布局已完成"再上报（避免把记住的位置抹掉）。

### 缺陷 3 · 自有步骤的文件入口**不存在**（spec 的 WHEN 不可达）

- **症状**：`store.openFileAt`（一次性显式文件目标）与 `WorkspaceFilesPanel` 消费端都写好了，但**全仓没有任何调用方** ⇒「用户从当前运行的自有步骤打开该轮文件」在界面上无路可走。
- **修复**：`DetailPanel` 步骤页新增「打开该轮文件」，调用 `openFileAt(runId, {stepSpanId})`；**门控与检查点选择器同源**（`validateCheckpointStepId(detail, span.id) === "valid"`），祖先步骤/非自有完成步骤**不渲染入口**（不冒充当前运行检查点）。

### 缺陷 4 · 带 path 的显式目标未解除阻挡它的搜索筛选

- **症状**：定位"成功"、内容也显示了，但目标仍被搜索词/变化筛选藏在列表外。
- **修复**：`WorkspaceFilesPanel` 消费目标时补 `query:""` + `filter:"all"`（design D2 原文：「指定合法 path 则显示内容、**清空阻挡它的搜索并切 all**」）。

### 缺陷 5 · **无 path** 的显式目标同样未解阻 ⇒ 定位后看到空列表

- **症状**：点「打开该轮文件」后列表被上一次残留的搜索词筛空——"显示了列表"却一个文件都看不见。
- **修复**：`if (file.path === undefined)` 分支同样补 `query:""` + `filter:"all"`（design D2：「未指定 path 时清空旧文件选择并显示列表」——列表里得真有文件）。

### 缺陷 6 · 失效引用**从不写回** ⇒ "清空"退化为"永久告警"

- **症状**：失效 `path`/`checkpoint` 只在本帧被算成 fallback（`effectivePath`/`effectiveStepSpanId`），会话状态里始终留着失效值 ⇒ 每次往返都重新提示，"清空"从未发生。
- **修复**：`WorkspaceFileView` 增加**一次性写回清理**（失效 step ⇒ 写回默认检查点并清对应滚动；失效 path ⇒ 写回 `path=null` 并清对应滚动），并把"发生过失效"**锁存在本次挂载内**（`invalidNotice`）——否则清理后判据立刻变假，提示会跟着消失，等于静默回退。下次往返时状态已干净、判据不再触发，提示自然不再复现。
- **纪律保持**：清理**只看 `absent` 判据**，清单**读取失败**（`unknown`）**不清空**——保留定位意图供重试（spec 明文），接线测试内含**反向断言**（清理 effect 体内不得出现 `inspectError` / `inspect === null`）。

> **修复后全量门禁**：`vitest` **1265 passed / 0 failed（65 文件）**；`tsc`（node + web）`EXIT=0`；`biome check .` 零错误；`openspec validate --all --strict` **13 passed / 0 failed**。

---

## 5. 回归测试与**变异验证**

新增/更新测试：

| 文件 | 内容 |
| --- | --- |
| `test/file-scroll.test.ts`（新，10 用例） | 锚点纯逻辑：构建/身份匹配/行重算/越界裁剪/去重 |
| `test/file-view-scroll-wiring.test.ts`（新，16 用例） | 缺口 ①②③⑤⑥ 的**能力断言**（渲染出来没有）+ **接线契约**（源码里连没连）+ 失效清理的**反向断言** |
| `test/file-reading-state.test.ts`（+1 用例） | `FileReadingState` 字段清单纳入 `contentScroll`，且仍排除正文/清单/哈希派生/Monaco 实例 |

**变异验证**（`.workbuddy/u2/u2-53-mutate.cjs`，一次性脚本，从基线副本打变异 → 跑定点测试 → 读 JSON 报告 → `finally` 还原）：

| 变异 | 内容（复现缺口原形态） | 结果 |
| --- | --- | --- |
| M1 | 失效引用不再写回清理 | ✅ 被捕获（2 用例失败） |
| M2 | 提示不锁存 | ✅ 被捕获（1 用例失败） |
| M3 | 正文锚点不接线 | ✅ 被捕获（2 用例失败） |
| M4 | 列表只写不读 | ✅ 被捕获（1 用例失败） |
| M5 | 无 path 目标不清搜索/不切 all | ✅ 被捕获（1 用例失败） |
| M6 | 自有步骤入口不接回调 | ✅ 被捕获（1 用例失败） |

6/6 变异全部被捕获 ⇒ 源码级接线契约不是空转（"改坏了也照样绿"这一悬案已排除）。变异后工作区已还原（`git diff --stat` 与变异前逐字节一致）。

---

## 6. 陷阱记录（给 5.4+ 复用）

1. **store 探针的模块身份陷阱（本轮最大坑）**：dev 页面 `location.href = http://localhost:5173/`，但应用真正持有的模块 URL 是 `http://localhost:5173/@fs/D:/ReBaseAgent/apps/desktop/src/renderer/src/store.ts?t=<ts>`（electron-vite 把 root 指到别处）。**ES 模块身份 = 完整 URL（含查询串）**，故 `import('/src/store.ts')` 拿到的是**另一份空 store**（`readingByRun === {}`、`selectedRunId === null`）且**不报错** —— 全部断言都会静默读默认值（典型假阴性）。必须先从 `performance.getEntriesByType('resource')` 解析出应用用过的 URL 再 import；再加 `assertStoreLive()` 自检兜底。
2. **`node --check` 抓不到模板字面量里的反引号**：domExpr 是模板字面量，注释里写 `` `.hidden` `` 会提前闭合字符串，**语法仍合法**（退化成一个 tagged template 调用），只在运行时报 `".hidden is not a function"`。写注入脚本时，嵌套字符串一律用全角引号或去掉。
3. **medium 档文件页收起运行导航**：切 run 必须**先回「概览」**；harness 记录 `selectDetour` 以示区别（`navOpened`/`setNavOpened` 全仓无 UI 调用方，**<960 档运行列表永久不可达**——**属 U1 范围，本次仅记录不改**）。
4. **默认筛选 `auto` 在完成步骤解析为 `changed`**：未被该轮改动的文件（长正文夹具 `long.txt`）不在清单里 ⇒ 必须先点「全部」，否则 `pickFile` 永远找不到目标（5.2 陷阱⑤同一形态，属验收前置而非缺陷）。
5. **DOM 与 store 的行号语义差 ±1**：DOM 取第一条**完整可见**行，store 取 Monaco `getVisibleRanges()[0]` 的**部分可见**行。断言容差取 2，并在 README 中如实标注，不靠调容差掩盖偏差。
6. **短文件不能用来验滚动位置**：`a.txt` 仅 2 行 ⇒ 位置断言恒真（假通过）。跨运行/往返场景一律用 `long.txt`。
7. **失效是在组件挂着时就被发现并处理的**：清单已加载 ⇒ 判据当场成立，提示与清空发生在**同一次挂载**内。若脚本"先切页签再回来看提示"，那时状态早已清干净、判据不再成立（提示确实消失）——那不是缺陷，正是"一次性清理"的语义。故 fallback 场景**注入后立即断言提示**，再往返验证"清理已生效且不复发"。
8. **改完脚本记得看 lint**：临时 JSON 报告若落在 `apps/desktop/` 下会被 biome 当源码检查（本轮 6 个格式错误即来自此），报告改写进 `.workbuddy/`（biome 不检查该目录）。

---

## 7. 证据文件

| 文件 | 内容 |
| --- | --- |
| `.workbuddy/u2/u2-53/measurements.json` | 36 checks + 六场景全量测量（DOM/store 双通道） |
| `.workbuddy/u2/u2-53/gate.txt` | 质量门禁日志（两条 tsconfig 的 tsc / 全量 vitest / biome / OpenSpec 严格校验，均 EXIT=0） |
| `roundtrip-1-滚动后.png` / `-2-步骤页.png` / `-3-返回文件页.png` | 长正文滚动 → 步骤页 → 返回恢复 |
| `cross-run-1-A-文件页.png` / `-2-B-文件页.png` / `-3-跨运行回A.png` / `-4-辅助视图返回A.png` | 同名文件跨 run 各自保持 |
| `explicit-1-搜索隐藏选择.png` / `-2-步骤页入口.png` / `-3-显式定位后.png` | 自有步骤入口与覆盖历史 |
| `fallback-1-失效路径.png` / `-2-失效路径往返后.png` / `-3-失效检查点.png` | 失效提示 + 真清空 + 一次到位 |
| `search-hidden-1-解阻后.png` | 显式目标解除搜索阻挡 |
| `probe-probe.png` | 探路快照（模块 URL / 运行清单 / 初始 DOM） |
| `apps/desktop/scripts/u2-53-cdp.cjs` | 采集 harness（6 个 tag） |
| `.workbuddy/u2/u2-53-mutate.cjs` · `.workbuddy/u2/u2-53-mut-base/` | 变异验证脚本与基线副本 |

---

## 8. 复现步骤

```bash
# 0) 起 dev（后台常驻，CDP 9612）
cd apps/desktop && NO_SANDBOX=1 node scripts/start-dev.cjs --remoteDebuggingPort=9612

# 1) 逐 tag 采集（每个 tag 内部会先冷重载，互不串味）
node apps/desktop/scripts/u2-53-cdp.cjs --tag=probe
node apps/desktop/scripts/u2-53-cdp.cjs --tag=roundtrip
node apps/desktop/scripts/u2-53-cdp.cjs --tag=cross-run
node apps/desktop/scripts/u2-53-cdp.cjs --tag=explicit
node apps/desktop/scripts/u2-53-cdp.cjs --tag=fallback
node apps/desktop/scripts/u2-53-cdp.cjs --tag=search-hidden

# 2) 变异验证（可选，验证接线测试非空转）
node .workbuddy/u2/u2-53-mutate.cjs snapshot
foreach ($m in "M1","M2","M3","M4","M5","M6") { node .workbuddy/u2/u2-53-mutate.cjs $m }
```

夹具：`.rebaseagent/u2-file-fixtures/iso-data`（真实引擎产物）——根 run `run_mudwrlbg_199xw1`（3 轮）、分叉 `run_mudwrlgl_93di`（2 轮，同名 a.txt/keep.txt/long.txt）、errored `run_mudwrlhv_jvqf9c`。

---

## 9. 遗留与后续

- **未覆盖（不属 5.3 交付边界）**：异常与工具命令归 **5.4**；只读不变性归 **5.5**；重启/数据目录整体迁移归 **5.6**。本 change 亦不宣称 U3–U8 通过。
- **U1 遗留观察（本次不改）**：`setNavOpened` 全仓无 UI 调用方 ⇒ <960 档运行列表**无展开入口**（`decideNavVisible` 只在 medium+files 收起，single 档直接不渲染 `RunList`）。属 U1 范围，建议 U1 收口时一并处理。
- design D7 的 **1440×900 / 1360×860** 档本机物理不可达（须外接更大屏）；本档 1210（medium）已覆盖 5.3 全部四场景，宽档几何归 5.1 已交付证据。