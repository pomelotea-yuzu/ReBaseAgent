# U2 任务 5.6 实机验收证据（2026-09-24）

change：`improve-workspace-file-reading` · 任务 5.6（重启 / 数据目录迁移 / 离线读取）
原始数据：`.workbuddy/u2-56/measurements.json`（**34/34 checks 全绿**：restart-state 9 · migrate 10 · keyboard-offline 10 · compat 5；`probe` 只 dump 真机事实不计分）
截图：9 张（本目录）· 采集脚本：`apps/desktop/scripts/u2-56-cdp.cjs` · 夹具生成：`apps/desktop/scripts/gen-u2-56-fixtures.cjs`

任务原文（`tasks.md`）：

> **5.6** 在受控数据副本上重启、整体迁移、仅迁 JSONL 并断网读取（1.5h）；验证“重启后查看文件差异”“数据目录迁移后文件仍可查”“文件阅读状态不跨进程承诺”“文件阅读键盘操作与离线加载”；普通 run 无伪文件页，现有概览/步骤/编辑/执行入口仍可达。

**本轮结论：四个 spec 场景 + 兼容性核对全部实机可达且全绿（34/34）；过程中**坐实并修复了 1 处真实产品缺陷**（「首次进入文件页」从未落到默认检查点，与 delta 明文相矛盾，且属于本 change 反复出现的"纯逻辑写好、接线少一支"形态）。**

---

## 1. 环境真值

| 项 | 值 |
| --- | --- |
| 物理屏 | 2560×1600 @ Windows 缩放 210% |
| 本档 CSS 视口 | **1210×713**，`devicePixelRatio` **2.1**（medium 档） |
| 应用 | Vite dev `http://localhost:5173/`，CDP **9612**；不伪造 deviceMetrics、不改窗 |
| 冷重载后运行名单 | **71** 项（`traces/` 72 个文件 = 71 run + 1 个既有遗留 `tmp-measure-*.tmp`） |

### 夹具（`gen-u2-56-fixtures.cjs` 生成，已安装进 live 数据目录）

| 夹具 | 形态 | 用途 |
| --- | --- | --- |
| `run_muey4e6q_a0xrtz`（根 R） | **真实引擎**：3 轮（读 `a.txt` → **写 `edit.txt` = 根第二轮改写** → 收尾） | 「编辑」入口（自有工具 span）验证 |
| `run_muey4e7h_tog3`（**隔离子 run S**） | **真实引擎** `replayIsolatedRun`（R 的子）：自有第 1 轮**写 `edit.txt` = 子 run 改写** | 重启后查看文件差异 / 迁移 / 键盘离线 |
| `r_02`（普通 run，父 `r_01`） | 既有 live 非隔离续跑者（2 步，`fork.edit.field=result`） | 普通 run 无伪文件页 / 现有入口可达 |

**为什么必须新造夹具（实测）**：扫遍 live 的 **25 条隔离 run**，`parent != null` 的隔离子 run **没有一条"自有步骤改动文件"**（子 run 的初始快照 = 父 run 检查点，而其自有轮只读不写）⇒ 5.6 明确要求"隔离子 run + 完成步骤的**修改**文件"，只能现造一条自有轮写入的续跑者。

---

## 2. 结果矩阵（34/34）

| tag | checks | 覆盖 |
| --- | --- | --- |
| `restart-state` | **9/9** | 重启后查看文件差异 + 文件阅读状态不跨进程承诺 |
| `migrate` | **10/10** | 数据目录迁移后文件仍可查（整体迁移 / 仅迁 JSONL） |
| `keyboard-offline` | **10/10** | 文件阅读键盘操作与离线加载 |
| `compat` | **5/5** | 普通 run 无伪文件页 + 现有概览/步骤/编辑/执行入口可达 |
| `probe` | 0（只 dump 事实） | 诊断基线 |
| **合计** | **34/34，0 失败** | |

### 2.1 重启后查看文件差异 + 阅读状态不跨进程（`restart-state` 9/9）

**真进程重启**：停 → **确认 9612 端口真的空出来** → 起 → 重连（`portFreed: true`）。⚠️ 只调 `--stop` 不够：pid 文件过期时 taskkill 失败而 `--stop` 仍返回成功，紧接的启动会因端口被占用而打印「already listening」**直接返回**——那样"重启"就是假的。

| 断言 | 实测 |
| --- | --- |
| 重启前刻意选**非默认**检查点 | 显式点「本 run 初始状态」⇒ `entered=true`、`checkpoint=null` |
| 重启后**文件**状态未跨进程 | `entered=false`（checkpoint / path / pane 都没被恢复） |
| 重启后按首次进入策略落**默认检查点** | 活动项 = **本 run 第 2 轮结束**（最近自有完成步骤）≠ 重启前的初始 |
| 未选文件时界面无该文件内容 | body 里既无 `子 run 改写` 也无 `根第二轮改写`（无内容副本被恢复出来） |
| 选中完成步骤的修改文件 ⇒ **真 diff** | monaco 真模型：`originalText = 根第二轮改写`、`modifiedText = 子 run 改写`、`lineChangeCount = 1` |
| 差异数真实 | `共 1 处差异`（不是写死的） |
| 只读 | `diff.modifiedReadOnly = true` |
| 浏览全程零写入 | 夹具目录 / live traces / 附件逐文件 SHA-256 **`diff = []`**（本次冻结 9 + 72 + 25 = **106 个文件**） |

### 2.2 数据目录迁移后文件仍可查（`migrate` 10/10）

（a）**整体迁移**——把 `.rebaseagent` **整个重命名到另一个绝对路径**：

| 断言 | 实测 |
| --- | --- |
| 数据目录真的移走了 | 原路径不存在、新路径有 `traces/` |
| 用**新的 dataDir** 读 trace 与文件内容 | 初始侧 `根第二轮改写` / 当前侧 `子 run 改写`（两侧都对） |
| **不依赖原 source 路径** | 迁移期间 `u2-file-fixtures-56/source` 随数据目录一起不可达，读取仍成功 |
| 迁回 + 重启后界面仍显示真 diff | `originalText/modifiedText` 与迁移前逐字一致 |

（b）**仅迁 JSONL**——新路径下只放 `traces/`（无附件）：

| 断言 | 实测 |
| --- | --- |
| 数据层 | `readRun` 成功（`metaId` 正确）+ `readWorkspaceFile` ⇒ **`missing`** |
| 应用层（临时移走 live `workspace-blobs` + 重启） | 列表徽标「**附件缺失**」、清单仍列 `a.txt`/`edit.txt`、运行与步骤页照常可读 |
| 不渲染伪空文件 | 一个编辑器都没渲染；卡片文案「附件缺失，无法读取内容；不会用空文本或源目录兜底」 |
| 复位 + 重启 | 文件恢复可读，diff 与迁移前逐字一致 |

**可逆性与安全**：三处文件系统操作全部是 `rename`（同卷即时），并在 `finally` 里还原；另有 `.workbuddy/u2-56/RESTORE-NEEDED.txt` 标记，还原成功后删除。**收尾核验**：`workspace-blobs` 在位、`moved-data` / `workspace-blobs-bak` / 标记文件都不存在。

### 2.3 文件阅读键盘操作与离线加载（`keyboard-offline` 10/10）

| 断言 | 实测 |
| --- | --- |
| Monaco 与全部资源**来自本地** | 冷启动 + 懒加载全程资源 host 只有 `localhost:5173`（**外部 host 0 个**），`monaco/css/worker` 相关资源 **172** 项 |
| 切离线成立 | `navigator.onLine === false` |
| 离线仍渲染编辑器 | `.monaco-diff-editor` 在位、`ensureMonaco()` 已加载（走本地缓存） |
| 列表键盘导航 + 焦点跟随 | focus 后 `Home`→`a.txt`、`End`→`edit.txt`、`ArrowUp`→焦点与选中一致（roving tabindex） |
| 检查点 Enter 激活 | 聚焦「本 run 初始状态」+ Enter ⇒ 活动项变「本 run 初始状态」 |
| 搜索键盘输入并真筛选 | 键入 `edit` ⇒ 清单从 2 项筛到 `[edit.txt]`；退格清空后恢复 2 项 |
| 目录宽度键盘调整 | 分隔条 `ArrowRight`：`directoryWidth 232 → 248`（写回会话状态） |
| 工具栏键盘激活 | 聚焦「换行：开」+ Enter ⇒ `wordWrap true → false` |
| 查找 Esc 往返 | 打开后 `.find-widget` 带 `visible`；Esc 后 `visible` 消失、焦点回到编辑器（`native-edit-context`） |

### 2.4 普通 run 无伪文件页 + 现有入口可达（`compat` 5/5）

| 断言 | 实测 |
| --- | --- |
| 普通 run（`r_02`）**没有**文件页 | 页签只有 `[概览, 步骤]`；无文件清单（`fileOptions=0`）、无 `role="listbox"` |
| 概览 / 步骤入口可达 | 两个页签都能选中并有内容 |
| **编辑**入口可达 | 在自有工具 span 上（隔离根 run）展开步骤 → 选中「工具 read_file」行 ⇒ 出现「**在此重跑**」编辑器 |
| **执行**类入口可达 | 壳层「新建运行 / 运行配置 / 代理录制」等仍在 |

> ⚠️ 实测纠正（harness 侧，非产品缺陷）：
> ①「编辑 messages 重发」是**代理 run** 专用通道（`proxy:fork`），本地续跑 run 上本来就没有；
> ②`r_02` 的工具行是**继承**（祖先前缀），产品如实提示"位于祖先前缀…打开其所属 run 才可在此重跑"、**不**给重跑入口 —— 这是正确行为。故「编辑」入口改在自有工具 span 上验证。

---

## 3. 本轮发现并修复的真实产品缺陷（首次进入文件页从不落默认检查点）

- **症状**（`probe` 实机坐实）：首次进入隔离子 run 的文件页，活动检查点停在「**本 run 初始状态**」，而 delta 明文要求「**首次进入 SHALL 选择最近自有完成步骤**」（该 run 有 2 个自有完成步骤 ⇒ 应停在「本 run 第 2 轮结束」）。
- **根因**：`WorkspaceFileView` 只把 `defaultCheckpointStepId` 用在 `stale` 分支；首次进入时 `saved.checkpoint === null`，`validateCheckpointStepId(run, null)` 返回 `"initial"` ⇒ 直接保持 `null`（初始）。**两种"没有 step id"被混为一谈**：`files === undefined`（从未进入）与 `checkpoint === null`（用户明确要看初始）。
- **为什么之前全绿**：`defaultCheckpointStepId` 的纯函数用例（2.2 的 13 条）全绿，但**没有任何用例钉住"首次进入"这条分支**——与本 change 已多次出现的"纯逻辑写好、接线少一支"（4.1/4.5/4.6、5.3 的 ①②③④、5.4 的 ①②）同一形态。
- **修复**（最小化 + 可单测）：
  1. `lib/workspace-files.ts` 新增纯函数 `resolveCheckpoint(run, {entered, checkpoint})`：未进入 ⇒ 默认；valid ⇒ 保持；stale ⇒ 默认 + `invalidated`；`initial` ⇒ 保持初始。
  2. `store.ts` 新增 `fileReadingEntered(runId)`（`files !== undefined`），把"从未进入"这一事实暴露出来。
  3. `WorkspaceFileView` 改走 `resolveCheckpoint`，并在首帧把解析出的默认检查点**写回会话状态**——否则随后任何一次 patch（选文件 / 切 pane / 换行 / 筛选…）都会以 `DEFAULT_FILE_READING_STATE`（`checkpoint: null`）起底 ⇒ 界面**突然跳回初始**。写回前**再查一次新鲜状态**，避免覆盖由父组件在同一提交写入的显式文件目标。
- **回归与验证**：新增 `resolveCheckpoint` 纯函数 5 条 + 接线契约 6 条（含 2 条**反向**断言：不得再出现旧写法、写回前必须复查新鲜状态）；既有 `file-view-session-state.test.ts` 的"恢复前做引用校验"同步改钉新接线（校验下沉到 `resolveCheckpoint`，视图不得绕过）。
- **验证**：desktop **1295 passed / 66 文件**（较 5.5 基线 1284 +11）；实机复测——首次进入现在落在「本 run 第 2 轮结束」，且该检查点下 `edit.txt` 立刻呈现真实差异（修复前停在初始 ⇒ 两侧同文、0 差异）。

---

## 4. 陷阱记录（harness 侧，全部已修，别再踩）

1. **`node --check` 抓不到模板字面量内嵌反引号**：给 `domExpr`（模板字符串）里的注释写 `` `bodySample` `` 直接打崩脚本（本项目第 3 次踩到）。
2. **`<button>` 的 Enter 激活需要完整按键序列**：只发 `keyDown+keyUp` 时焦点确实在按钮上、`activeElement` 也对，但**默认动作（click）不触发** ⇒ 得到一个"按键无效"的假失败。必须 `rawKeyDown → char(text:"\r") → keyUp`（本任务检查点与工具栏换行两处都栽在这里）。
3. **store 字段名写错只会静默变空**：`FileReadingState` 是 `directoryWidth`/`directoryCollapsed`，写成 `dirWidth` 得到 `undefined`，`JSON.stringify` 又把它丢掉 ⇒ 判据变成空转断言。
4. **`bodySample` 只截前 500 字符**：详情面板排在导航之后 ⇒ 用它判"详情里有没有某个入口"必然假失败。新增全文判据 `bodyHasRerunHere`。
5. **「清空搜索」只在空态渲染**：有匹配时页面上**没有**这个按钮 ⇒ 改用真退格逐字删（这才是"键盘操作"本身）。
6. **finder 的可见性判据要按类名**：`.find-widget` 关闭后仍留在 DOM 且 `getBoundingClientRect().height > 0` ⇒ 原"height>0 即可见"会把已关闭判成打开。改判 `className` 里的 `visible`。
7. **dev 重启必须"确认端口真的空出"**：见 §2.1 的说明（否则重启是假的）。
8. **一次调用跑多个 tag 会让被 spawn 的 Electron 撞上沙箱**：本机实测——把 `probe` 与 `restart-state` 串在同一次命令里，`restart-state` 内 spawn 的新 Electron 被沙箱拦在 `%APPDATA%` 写入上（DevToolsActivePort / Local Storage），表现为"Monaco 没加载、pane 停在 list"的**假失败**；同样的 tag 单独一次调用则 3/3 稳定通过。**协议：每个 tag 单独一次调用**（与 5.1–5.5 一致），且 dev 必须在**非沙箱**下起。

---

## 5. 未验证项与边界（如实标注）

- **`probe` 只 dump 真机事实，不计 checks**；本任务没有 `probe` 的"通过数"。
- **「仅迁 JSONL」的应用层证据需要动 live 数据目录**：dev 模式下数据目录恒为 `<仓库根>/.rebaseagent`（`data-dir.ts:101-103`，无环境变量/指针文件可改），因此"迁移到新路径"在**应用层**只能表现为"内容整体搬到别处再搬回 + 重启"；**路径无关性**由数据层用**另一个绝对路径**直接证明（真实读取 API）。生产（打包）模式的 `data-dir.json` 指针指向新 `dataDir` 属 electron 主进程既有能力，本次未在打包态复测。
- **离线是"暖离线"**：先联网加载完页面与 Monaco，再 `Network.emulateNetworkConditions{offline:true}` 重进文件页（同 5.2 口径）。**冷启动离线**在 dev 下不可测（页面本身由 Vite 提供），故本任务以 **"零外部 host"**（资源表全量）作为"Monaco 从本地懒加载"的主证据，并如实标注这一点。
- **`restart-state` 的"零写入"冻结面**包含夹具目录 / live `traces/` / live 附件共 106 个文件；它与 5.5 的只读不变性同口径，但**不重复**验证 5.5 已覆盖的注入式重试（那是 5.5 的范围）。
- **本轮只修了 §3 那一处缺陷**；`test/u2-file-fixtures.test.ts` 里 1.1 的坏标本（见 5.5 证据 README §5）**仍未修**，仍留待 6.3 处理。
- 第 6 组（6.1–6.3：门禁、evidence-index、边界核对）**未做**。
- 本任务**未提交、未归档**；`HANDOFF.md` 与 `docs/` 不入库（`docs/reviews/2026-09-24-u2-56/` 随本任务组入库）。