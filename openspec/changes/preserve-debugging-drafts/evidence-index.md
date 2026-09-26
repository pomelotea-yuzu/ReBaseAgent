# U3 `preserve-debugging-drafts` 场景 → 证据索引

> 任务 7.2 的产出。范围：本 change **唯一一份 spec delta**
> [`specs/desktop-ui/spec.md`](specs/desktop-ui/spec.md) 的 **9 requirements / 41 scenarios**（全部 ADDED，
> 无 MODIFIED / REMOVED ⇒ 既有 desktop-ui 场景零改动、零丢失）。
>
> **本索引不自动归档、不发版。** 证据只到契约级或实机不可注入的项**显式标注**，不以"已通过"冒充。
> 本索引**不是**验收放行凭据——放行由 owner 拍板（tasks 7.2 明写"归档另行处理"）。

## 怎么读这份表

- **证据**优先给**可执行的用例名**（`测试文件 › 用例名`，用例名**逐字取自 `it(...)` 标题**，不写行号，
  定位以用例名为准；describe 名不并入用例名）；纯静态约束显式写"源码契约"。
- **测试**默认指 `apps/desktop/test/*.test.ts`（全量 80 文件 / 1525 用例 / 0 失败，见 7.1）。
- **CDP** 指 `apps/desktop/scripts/u3-6{1..9}-cdp.cjs` 与 `u3-610-cdp.cjs`、`u3-611-cdp.cjs`。
  **tag 名即该脚本 `--tag=` 的白名单键**，`n/m` 为「通过/总检查数」。
  截图与逐 tag 结果矩阵**已入库**到 `docs/reviews/2026-09-25-u3-61|62|63|64|65|66|67|68|69/`、
  `docs/reviews/2026-09-26-u3-610|611/`（各含 `README.md`）；原始 `measurements.json` 落 gitignored
  `.workbuddy/u3/u3-6*/`（**`u3-64`/`u3-65` 的 JSON 是修缺陷前的中间态**，终态以 README + `final-run.log` 为准）。
- **系统级通道**：`scripts/lib/u3-64-winops.ps1`（Win32 `SC_CLOSE`/真 Alt+F4/真 `#32770` UIA 文案读取与
  `BM_CLICK` 应答/窗口与 PID 存活判定）、`scripts/lib/u3-65-input.ps1`（`keybd_event` 真按键、
  `Set-Clipboard` 真剪贴板、`GetGUIThreadInfo`/`ImmGetContext` 真输入法状态）。
  这两条通道的作用是：**关闭由系统发起、输入由系统投递**，不合成任何 `CompositionEvent`。
- **受控执行**指 `scripts/mock-llm-server.cjs`（剧本制 OpenAI 兼容服务，`entries()` 逐条计数、`delayMs` 造在飞、
  `mode:fail+status:503` 造失败）⇒ 6.3/6.10/6.11 的"真的执行过/确实零执行"两面都由它立证，零付费。
- **fixture** 由 `gen-smoke-run.cjs` / `gen-smoke-proxy-run.cjs` / `gen-u2-55-fixtures.cjs`（U3 复用它装隔离谱系
  root）产出到 gitignored `.rebaseagent/traces/`；6.1 夹具清单在 `.workbuddy/u3/u3-61/manifest.json`。
- **变异**指「注入一处破坏 ⇒ 确认判红 ⇒ 还原复绿」，脚本在 `.workbuddy/u3/**/*mutate*.cjs`（17 个）；
  引用格式 `变异 6.7/F-A`。这是"判据有牙"的证据，不是测试用例。
- 图例：**单测** = vitest 用例；**契约** = 源码级接线断言（vitest 内读源码字符串）；**实机** = CDP/Win32/UIA tag。

## 汇总

| requirement（desktop-ui，全部 ADDED） | 场景数 | 已覆盖 | 未验证 | 主要证据层 |
| --- | --- | --- | --- | --- |
| 调试草稿按编辑身份保存在会话内 | 5 | 5 | 0 | 单测 + 实机 6.1/6.11 |
| 草稿可定位且来源失效不丢输入 | 4 | 4 | 0 | 单测 + 实机 6.2 |
| 编辑核对与明确放弃区分于收起 | 5 | 5 | 0 | 单测 + 实机 6.2/6.8/6.9 |
| 创建草稿和实验臂遵守同一保留规则 | 4 | 4 | 0 | 单测 + 实机 6.1/6.2/6.3 |
| 草稿恢复不恢复执行许可 | 6 | 6 | 0 | 单测 + 实机 6.3 + 既有隔离门禁 |
| 提交绑定草稿修订且响应不清除草稿 | 3 | 3 | 0 | 单测 + 实机 6.3 |
| 主进程核对草稿后决定常规退出 | 9 | 9 | 0 | 实机 6.4–6.7 + 单测三件套 |
| 保留模态框约束焦点并正确恢复 | 3 | 3 | 0 | 单测 + 实机 6.10 |
| 草稿交互保持既有执行和数据边界 | 2 | 2 | 0 | 实机 6.11 + 既有执行回归 |
| **合计** | **41** | **41** | **0** | — |

> 五条**诚实边界**（不改变上表计数，逐条落在下方「已知限制」）：① 零持久化**无单测面**，只有 6.11 实机三面扫描；
> ② 真原生目录选择的"取消"不可自动化；③ `fff6581`（6.4 装配接线）与 `eef8fed`（App 挂确认宿主）两处产品改动
> **无新增单测**；④ `event.sender` 的 webContentsId/frame 冒名**实机不可注入**，由 guard 单测承载；
> ⑤ Monaco 走 `native-edit-context` ⇒ `inputSettled=false` 这条降级在输入法路径**没有触发路径**（结论见下方专节）。

## 差集核对

`## ADDED` 是**新增**语义，不动主 spec 既有 requirement ⇒ 丢场景的风险在这里不存在，但**同名冲突**与**漏项**仍然会静默发生。
脚本 `.workbuddy/u3/u3-72/scenario-diff.cjs` + `verify-index-coverage.cjs`（沿用 U2 6.3 的模式，改按 ADDED 语义），输出
`.workbuddy/u3/u3-72/14-scenario-diff.log`、`15-coverage.log`：

```
=== ADDED requirement：不得与主 spec 同名（避免归档时重复） ===
9 个 ADDED requirement 全部与 openspec/specs/desktop-ui/spec.md 无同名 ✅
主 spec desktop-ui 现状：requirements 38 → 归档后 47；scenarios 159 → 200（本 change 净新增 9/41，既有 0 改动）
=== 逐 requirement 覆盖核对（本索引第 2 列点名） ===
合计 delta 41 场景；索引表内命中 41；缺失 0
结论：索引逐条覆盖全部场景 ✅
```

### 引用回查（防"编造证据"）

索引里的证据名**全部做了机器回查**，不靠"我核对过了"：

| 自检 | 脚本 | 结果 | 反证（判据有牙） |
| --- | --- | --- | --- |
| 场景逐条覆盖 | `.workbuddy/u3/u3-72/verify-index-coverage.cjs` | delta **41** 场景 → 索引命中 **41**，缺失 **0**；索引点名 **41** 行，虚构 **0** | `coverage-mutate.cjs`：M1 改场景名⇒缺失 1、M2 删场景名⇒缺失 1、M3 凭空加假行⇒虚构 1，**双向有牙**（`16-coverage-mutate.log`） |
| tag 名真实 | `.workbuddy/u3/u3-72/verify-refs.cjs` | 11 个采集脚本、**62 个 tag** 全部在脚本源码内命中（引号 / 对象键 / 头部 `--tag=<a\|b>` 用法行三种声明面任一） | `--mutate` 用不存在的 tag 名反查 ⇒ `hit=false` ✅（`18-verify-refs-mutate.log`） |
| 截图真实 | 同上 | **11 个已入库 review 目录的全部 78 张 png** 逐张点名核对存在（61=9、62=8、63=11、64=4、65=8、66=3、67=4、68=10、69=9、610=7、611=5），缺失 **0**，且目录实际计数与点名数**逐一相等** | 同上（png 列表按目录 `readdirSync` 对全） |
| 用例名逐字 | `.workbuddy/u3/u3-72/verify-cases.cjs` | 引用到的 **17** 个测试文件、**79** 个用例名片段全部命中 `describe/it` 标题，未命中 **0** | `--mutate` 用不存在的用例名反查 ⇒ `hit=false` ✅（`20-verify-cases-mutate.log`） |

> 🔴 **本次回查抓到并修正 3 处"非逐字"引用**（原写法把 describe 名与 it 名拼接、或省略了箭头与"（源码级）"，
> 人读没问题，机器按标题匹配就判红）：`create-form-draft › 打开（ensure）→ 填写 → 关闭对话框 → 再打开…`、
> `modal-dialog › 跳过 disabled 与不可见…`、`confirm-dialog › 放弃确认全部经 requestConfirm…`。
> ⇒ 已在「怎么读这份表」里把"用例名**逐字取自 `it(...)` 标题**"写成索引纪律。

---

## desktop-ui

### 1. 调试草稿按编辑身份保存在会话内（5，**A**）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | result 草稿经步骤页签和运行往返逐字恢复 | **单测** `debugging-drafts.test.ts › 空串、仅空白、末尾空白与换行逐字保留（不 trim）` + `fork-editor-draft.test.ts › store 行为：result 草稿逐字恢复与重开不覆盖（ForkEditor 同形调用）› 打开 → 编辑 → 切页签/切运行（其他状态翻动）→ 重开：草稿逐字恢复`；**实机** `u3-61-cdp.cjs --tag=result` **6/6**（真页签/真运行往返，store + Monaco model 双口径同源；`docs/reviews/2026-09-25-u3-61/61-result-after-tab-roundtrip.png`、`61-result-restored.png`）；"导航不触发模型或工具调用"由 `u3-611-cdp.cjs --tag=zero-exec` **15/15** 立证（受控服务 `entries()=0` + 逐文件 SHA-256 `diff=[]`） |
| 2 | 相同 span ID 和不同字段不串草稿 | **单测** `debugging-drafts.test.ts › 两个 run 的相同 span ID 各自独立` / `同一 run 同一 span 的不同字段互不影响（切 prompt 字段不重置另一字段）` / `跨运行继承 span：编辑落在当前父本 runId 上，不共享到其他 run`；`prompt-messages-editor-draft.test.ts › 同 span 的两个字段各自登记基线、各自编辑，互不串`；**实机** `u3-61 --tag=contrast` **4/4**（两个**独立 root** `run_mughwjk4` / `run_mughyp60_txvlev` 的**同名 span `s_03`**，双侧草稿不串且独立保留；`61-contrast-a.png`、`61-contrast-b.png`）+ `--tag=prompt` **5/5**（两字段互不串） |
| 3 | 非法 JSON 和空输入仍可暂存 | **单测** `debugging-drafts.test.ts › 非法 JSON 原样保留，不被格式化或替换为原值` + `store 里暂存非法 JSON 与空串后原样读回（同步写入，不经格式化）`；`prompt-messages-editor-draft.test.ts › messages 草稿：非法 JSON 与空输入原样暂存（不 format / 不 trim / 不替换）`；**实机** `u3-61 --tag=messages` **4/4**（`{"broken": [1,2,xxx` 落 store 往返恢复、清空为空串仍可暂存；`61-messages-restored.png`、`61-messages-cleared.png`） |
| 4 | 修订不因删除重建而复用 | **单测** `debugging-drafts.test.ts › 修订不因删除重建而复用：放弃后重建同 key 必然拿到更新的修订` / `无编辑直接放弃后重建同样不复用旧修订（防 ABA）` / `改回基线也是内容变化：修订继续递增，条目保留且 text === baseline` / `打开未编辑不产生虚假 dirty`；A/B 面 `仅行 ID 变化（语义不变）不推进修订但更新行引用`；创建面 `dirty：默认空表单不算 dirty`；**变异** §1 各任务逐条（1.2 防 ABA / 1.3 稳定行 ID 注入全部捕获） |
| 5 | 草稿不会跨 renderer 会话持久恢复 | **实机** `u3-611-cdp.cjs --tag=reload` **9/9**（真 `Page.reload` 文档轮换后三区草稿全空）+ `--tag=restart-pre` **2/2** / `--tag=restart-post` **6/6**（run-all 固定全序：落草稿到 `handoff.json` ⇒ 停 dev ⇒ **全新进程** ⇒ 验证三区全空 + `.rebaseagent` 全树标记子串零命中 + 计数一致）；"检查持久存储"= **三面扫描**（`.rebaseagent` 全树 + `localStorage` + `sessionStorage`）；"正常退出前仍须执行关闭核对"见 §7。⚠️ **本场景无单测面**（vitest 里 `localStorage/sessionStorage` 零命中），纪律只写在源码注释 `lib/debugging-drafts.ts` 头部与 `store.ts`；**变异 6.11/A**（草稿镜像进 localStorage）与 **6.11/C**（sessionStorage 跨重载复活）分别在 web storage 与 reload 判据上打红 ⇒ 判据有牙在实机面。见「已知限制」① |

### 2. 草稿可定位且来源失效不丢输入（4，**A**）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 草稿列表返回精确编辑目标 | **单测** `draft-list.test.ts › 全会话列表：含调用类 / A/B / 创建，身份可辨认且 dirty 正确` / `按 runId 过滤（本运行列表）：只含该运行条目，创建草稿被排除` / `调用类目标：切运行（需要时）+ 步骤页签 + 选中 span + 登记 pending` / `consumeDraftTarget 清空 pending` + **契约** `GlobalBar 挂载全会话入口：同一面板组件、不按 run 过滤`；**实机** `u3-62-cdp.cjs --tag=precision` **6/6**（点「定位」真命中 run/span；`62-list-panel.png`、`62-precision-a.png`、`62-precision-b.png`） |
| 2 | 源记录缺失损坏或发生改变 | **单测** `draft-source.test.ts › 详情缺失或读取失败（detail=null）⇒ 保留草稿、禁止执行` / `目标 span 消失 ⇒ source_missing，不换用其他调用冒充恢复` / `prompt：启动上下文的 system 文本被改 ⇒ source_changed` / `旧条目无源基线（source=undefined）⇒ 保守拒绝`；**实机** `u3-62 --tag=source-change` **5/5**（**真篡改磁盘 trace** ⇒ 失效横幅 + 草稿仍可编辑 + 执行禁用 + 复制全文不截断，场景尾还原）与 `--tag=source-missing` **3/3**（摘除 `s_03` ⇒ 编辑器无法打开、3.2 安全回退不崩、草稿仍可复制，尾还原）；`62-source-changed-banner.png`、`62-source-missing.png` |
| 3 | 阅读回退不删除草稿且重新校验才能执行 | **单测** `debugging-drafts.test.ts › 任务 1.4：阅读状态翻页/分区、列表刷新与详情失败都不动草稿仓库（引用与内容双断言）` / `A/B 批次与创建草稿同样不受阅读/刷新影响`；`draft-source.test.ts › 曾失效的来源恢复（detail 重新可读）⇒ 重新校验通过后资格恢复`；**实机** `u3-61 --tag=result`（切文件/概览/另一运行再返回，输入不变）+ `u3-611 --tag=regression` **13/13**（U1 页签/选中 span、U2 文件阅读面在草稿存在时不被覆盖） |
| 4 | prompt 和实验恢复重验首次调用资格 | **单测** `draft-source.test.ts › 首次 llm.call 身份不再一致 ⇒ 拦截且明示不得改用后续调用（s_02 仍存在）` / `不仅凭 span ID 相同放行` 组内 `运行状态改变（completed → crashed）⇒ 拦截` / `目标 span 不再是自有叶子 ⇒ 拦截` / `配置指纹（config_hash）改变 ⇒ 拦截` / `prompt/A/B：隔离文件元数据出现 ⇒ 拦截（隔离父本不支持该入口）` / `字段与目标类型不匹配（result 草稿对到 llm.call）⇒ 拦截` + `源基线只存事实：不携带版本/算法签名键`；**实机** `u3-62 --tag=source-change`（篡改后执行按钮禁用＝资格失效面在 UI 真的生效）+ `u3-63 --tag=prompt` **6/6** 作对照（合法源确实能提交，防"一律拒绝"假真） |

### 3. 编辑核对与明确放弃区分于收起（5，**A**）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 关闭编辑与设置往返保留内容 | **单测** `create-form-draft.test.ts › 打开（ensure）→ 填写 → 关闭对话框 → 再打开：模式与任务逐字恢复`；**契约** `fork-editor-draft › 编辑值从草稿条目派生…取消/收起不删草稿`；Esc 收起通道见 §8-2；**实机** `u3-61 --tag=create` **4/4**（关闭创建→开设置→关设置→再开创建，任务逐字恢复；`61-create-restored.png`）+ `u3-62 --tag=r2` **2/2**（R2 全路径；`62-r2-create-restored.png`）+ `u3-68/6.9 --tag=prompt` 各档"改窗往返逐字保留" |
| 2 | 放弃可取消且只影响指定目标 | **单测** `debugging-drafts.test.ts › 修订一致才删除：条目消失、空父级剪枝、兄弟条目存活且引用不变`；`prompt-messages-editor-draft › 放弃只影响指定目标——放弃 system 字段不碰 user 字段`；`fork-editor-draft › 放弃修改：确认核对当前内容、按渲染快照修订 CAS；取消逐字保留`；`model-ab-editor-draft › 任务 2.6：放弃整批（不提供批量清除）`；**实机** `u3-62 --tag=discard` **4/4**（**真模态**：模态文案目标明确 ⇒ 取消逐字保留 ⇒ 确认后仅删 A 不伤 B；`62-discard-modal.png`、`62-discard-after-confirm.png`） |
| 3 | 旧放弃确认不能删除新修订 | **单测** `debugging-drafts.test.ts › 旧放弃确认不能删除新修订：确认后内容又变 ⇒ 拒绝删除，重新核对后才可放弃`；`create-form-draft › 旧放弃确认不能删除新修订（确认后继续输入）`；`confirm-dialog.test.ts › 异步确认后 CAS 仍按快照修订校验（旧确认不能删新修订）`；**变异** 5.2 M3（取消不 resolve）以结构断言钉住（无 DOM 不可观测），行为面归 6.2 `discard` |
| 4 | 无变化与空字符串按各字段契约处理 | **单测** `debugging-drafts › 打开未编辑不产生虚假 dirty；清空、仅空白、非法 JSON 都算 dirty` / `基线本身是空串时，输入空串不算 dirty、输入内容才算`；`fork-editor-draft › 清空为零长度的变更同样要经确认（dirty 判据不豁免空串）`；空串合法性**沿用字段既有契约**：`run-create.test.ts › 空 systemPrompt 允许：config_hash = …`（创建侧）+ `prompt-messages-editor-draft › 沿用原字段校验（promptForkGuard）` / `沿用提交边界解析（JSON.parse）`（messages 非有效数组禁止提交）；**实机** `u3-61 --tag=messages`（清空后仍可暂存且提交按原校验） |
| 5 | 宽窄窗口均可核对完整编辑内容 | **契约** `fork-editor-draft › 原值（只读）/草稿（可编辑）就近核对：宽屏并排、窄屏上下，两侧完整可读`；**实机** `u3-68-cdp.cjs` 三 tag **96/96**（真 `MoveWindow` 改窗 ⇒ CSS **1440/1210/1024/800** 四档；每档四件套：视口实测命中 / 轨道数对 `xl=1280` 断点 / 两侧 ≥200px 零绘制右溢 + **草稿 model 含全 12 行首末标记**（虚拟滚动下不能看 DOM）/ 收起-放弃-提交 `scrollIntoView` 后可达；截图 10 张）+ `u3-69-cdp.cjs` 三 tag **108/108**（**独立 200% 缩放**：dpr 恒 4.2，三档 CSS **1284/720/400**，加测**整页 `scrollWidth≤innerWidth+2`** 与极窄档现场键入）；**抓到并修 1 处真实产品缺陷**（提交 `e9d5f14`）：model-ab 臂行无空格 JSON 长拉丁串窄盒不强制断行 ⇒ 草稿侧右溢 26/36px 截文 ⇒ 两侧臂行 `break-all` + 契约 +2 断言；**变异** 6.8/P-A（去 `xl:` 断点⇒三窄档轨道数判红）、6.8/P-B 与 6.9/M2（去草稿侧 `break-all` ⇒ 绘制右溢判红） |

### 4. 创建草稿和实验臂遵守同一保留规则（4，**A**）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 创建关闭配置再新建仍有任务 | **单测** `create-form-draft › 打开（ensure）→ 填写 → 关闭对话框 → 再打开：模式与任务逐字恢复` + **契约** `挂载即登记创建草稿（ensureCreateRunDraft），文本字段从草稿派生` / `输入同步写入草稿；本地文本 setter 已移除（重开覆盖输入的旧根因）`；**实机** `u3-62 --tag=r2` **2/2**（创建→取消→运行配置→再开创建，逐字恢复）；"本次副本授权未勾选"见 §5-2；"未编辑的默认空表单不冒充草稿"= `debugging-drafts › dirty：默认空表单不算 dirty`；"仍使用现有对话框"= `u3-610 --tag=focus-create` **9/9**（真打开创建对话框并做 Tab 禁闭遍历） |
| 2 | 切创建模式保留文本而放弃重置表单 | **单测** `create-form-draft › 切模式写草稿且不重置文本（switchMode 不碰 systemPrompt/userMessage）` / `显式放弃：确认后按 CAS 放弃草稿并重置表单（取消不丢内容）` / `切模式清除引用` / `放弃同时清除目录引用（design D4：明确放弃创建清除引用）`；**实机** `u3-63-cdp.cjs --tag=create` **15/15**（纯对话 + 隔离两模式整份提交、重开授权复位） |
| 3 | 实验臂增删和非法参数可恢复 | **单测** `model-ab-editor-draft › 打开 → 改参数（含非法 JSON）/增删行 → 关闭往返 → 重开：逐字恢复且行 ID 稳定` / `删行恢复：删除的臂重开仍不在（批次修订推进）` / `仅行 ID 变化不推进修订；语义变化推进`；**实机** `u3-61 --tag=ab` **6/6**（非法参数写臂落 store ⇒ 加一臂 ⇒ 增删往返恢复 ⇒ 重挂载控件值一致；`61-ab-restored.png`）；"未校验参数不能用于真实执行"= `u3-63 --tag=ab` **13/13** 的门禁段 |
| 4 | 实验预览和结果不隐式清理批次 | **单测** `model-ab-editor-draft › dry-run 预览（成功或失败信封）不写、不清、不推进批次草稿` / `打开即清理临时计划与许可…预览/执行不隐式清理批次`；`draft-submission.test.ts › A/B：部分臂失败（仍是明确返回）收尾且批次保留`；**实机** `u3-63 --tag=ab`（预览/执行两路后批次逐字仍在）+ `--tag=ab-partial` **7/7**（一臂 completed 一臂 503 ⇒ 草稿保留、播报如实；`63-ab-executed.png`、`63-ab-partial.png`） |

### 5. 草稿恢复不恢复执行许可（6，**A**）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 隔离编辑恢复后重新预检授权 | **单测** `fork-editor-draft › 恢复/离开编辑器后必须重新预检（结论与授权均为组件局部态）` / `内容变化使本次副本授权失效（授权只用于当次提交）`；"父 trace 的 write_authorized 不作为授权"与"隔离 prompt/A-B 仍被拒绝"= 既有门禁回归：`isolated-parent-rejection.test.ts` 5 用例（`runFork → 拒绝，不落盘、零 LLM 调用` / `runModelAb 真实执行（confirmCost + allowSideEffects）→ 同样拒绝（授权不越隔离门禁）`）+ `controlled-isolated.test.ts › 隔离父本上 prompt fork / 模型 A-B 经受控服务仍拒绝，且零模型请求`；**实机** `u3-63 --tag=isolated` **8/8**（预检⇒授权⇒提交两段式续跑，重开授权复位；`63-isolated-reopened.png`） |
| 2 | sourceToken 在有效期内恢复但授权复位 | **单测** `create-form-draft › 打开时从会话级引用恢复源目录（授权不随引用恢复，仍为未选）` / `选择成功镜像到会话引用`；**实机** `u3-63 --tag=create` **15/15**（真 IPC 选目录 ⇒ 关闭重开：目录展示与会话引用恢复、授权未勾选、**未签发新 token**）；"不按路径自动选择"= 契约 `store 目录引用独立于草稿：set/clear 生效，写草稿不动引用`（`debugging-drafts.test.ts`）；15 分钟有效期与一次性消费仍由 main 校验（既有 `workspace-isolation` 契约，本 change 未改） |
| 3 | sourceToken 失效不清空任务 | **单测** `create-form-draft › INVALID_SOURCE_TOKEN 提示重选但不清空草稿任务` / `store 行为：任务 3.2：INVALID_SOURCE_TOKEN 提交失败不清空草稿任务（要求重选目录）`；**实机** `u3-63 --tag=create`（**token 已消费后重开对话框直接再提交** ⇒ 真 `INVALID_SOURCE_TOKEN` 信封 ⇒ 清引用要求重选、任务与模式逐字保留、不自动重发） |
| 4 | 取消目录选择保留原引用 | **单测** `create-form-draft › 选择成功镜像到会话引用；取消保留原引用；请求代次守卫迟到响应`；**契约** `debugging-drafts › store 目录引用独立于草稿：set/clear 生效，写草稿不动引用`；⚠️ 真原生目录选择对话框（`showOpenDialog`）在 harness 中**不可应答** ⇒ 该场景**只到单测 + 契约级**，未做实机（见「已知限制」②）。"首次取消保持未选、不清空草稿、不赋予写入授权"由单测覆盖 |
| 5 | 迟到检查不覆盖草稿 | **单测** `fork-editor-draft › 预检结论绑定确认时的草稿修订；迟到响应不安装旧结论`；`model-ab-editor-draft › 预览发起时记录批次修订；迟到响应按它校验，且先守卫后安装` / `计划与当前批次修订同源：修订推进即失效，改走又改回也不复活`；`create-form-draft › 请求代次守卫迟到响应`；`draft-submission › 收尾只认同令牌：旧关联（迟到回调）不解冻后来发起的新提交`；**实机** `u3-63 --tag=late` **8/8**（受控服务 `delayMs` 6s 造在飞 ⇒ 重复登记被拒不换令牌、冻结写被拒、旧令牌收尾不解冻；`63-late-callback.png`）+ `--tag=ab`（在飞窗口内卸载编辑器，关联仍在）；"不要求 A/B 提供目录选择"= `u3-63 --tag=ab` 全程零目录选择 |
| 6 | 设置凭据与调试草稿分离 | **单测** `debugging-drafts › 三区草稿的序列化结果不含授权、副作用许可、密钥或 token 字段`；`draft-close-guard.test.ts › report / answer 载荷键恰好是元数据字段，无正文/凭据通道`；**实机** `u3-61 --tag=create`（含"打开并关闭设置"往返，草稿原文不变）+ `u3-611 --tag=zero-exec` 的**逐文件 SHA-256 冻结面含 settings**（`settings.json` 零变化；**变异 6.11/B**＝键入顺手 `saveSettings` ⇒ 冻结面立刻判红）；"未保存设置输入仍由原设置流程自行管理"= 本 change 未触碰 SettingsDialog 表单态（`u3-610 --tag=focus-settings` 证其仍在且可用） |

### 6. 提交绑定草稿修订且响应不清除草稿（3，**A**）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 提交快照独立于编辑器挂载 | **单测** `draft-submission › 提交快照独立于编辑器挂载：resetFork 与展示状态复位后仍冻结` / `登记取当前修订与请求快照，令牌单调递增` / `三类目标标识与草稿列表 listKey 同编码（防两套编码漂移）` + **契约** `调用类三编辑器：先登记关联，提交值取自快照而非渲染局部值` / `store：六处写入/放弃路径拦冻结；五个执行函数负责收尾`；**实机** `u3-63 --tag=ab`（在飞卸载重挂）；**提交值核法**：`--tag=result` **9/9** / `--tag=prompt` **6/6** 一律以落盘 `fork.edit.value` 或受控服务收到的请求体逐字核对快照，**不看界面自述** |
| 2 | 成功错误和部分失败均保留草稿 | **单测** `draft-submission › 成功响应收尾（解冻）但草稿保留原文` / `业务拒绝同样收尾（可重新提交）且草稿保留；三个通道一致` / `A/B：部分臂失败…批次保留`；**实机** `u3-63 --tag=fault` **8/8**（503 剧本封存落盘 ⇒ 解冻 ⇒ 草稿保留 + 未知态）、`--tag=business` **9/9**（`SETTINGS_NOT_CONFIGURED`、非法 JSON 本地拒绝、取消确认零请求）、`--tag=ab-partial` **7/7**；**"即使 IPC 返回 ID 或记录正常 completed 也不自动清理"**= `--tag=result` 提交成功后草稿仍在（本 change 只保留不删，自动清理属 U5）；截图 `63-result-executed.png`、`63-fault-503.png`、`63-business-rejected.png`、`63-messages-rejected.png` |
| 3 | 迟到回调与未知状态不能错误解冻 | **单测** `draft-submission › 迟到回调不解冻新提交；通道抛错（状态未知）保留冻结` / `同目标重复登记被拒且不换令牌（旧请求的响应仍能收尾）` + **契约** `冻结即视为进行中：五个编辑器都禁用输入/放弃/提交并给出待处理说明`；**实机** `u3-63 --tag=late` **8/8**（重开编辑器不能解锁、不自动重发）；**"可信核对由后续操作登记提供"是本 change 的显式留白 ⇒ 属 U4**（见「U4/U5 边界」） |

### 7. 主进程核对草稿后决定常规退出（9，**A**）

> 本 requirement 的**关闭一律由系统发起**（`PostMessage(SC_CLOSE)`、`keybd_event` 真 Alt+F4、真 `app.quit` 哨兵），
> 确认框是真 `#32770`（UIA 读文案、`BM_CLICK` 应答），退出判定只看**窗口句柄消失 / 主进程 PID 不再存活 / CDP 端口关闭**，
> **不断言 guard 返回值**。这是 6.4 定下的口径，下方 9 个场景全部照此。

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 有草稿时关闭可返回或明确退出 | **实机** `u3-64-cdp.cjs`：`titlebar-return` **12/12**（SC_CLOSE ⇒ 真确认框 ⇒ UIA「返回」⇒ 应用存活 + 草稿逐字保留 + 输入锁解除 + 再关仍重新询问）、`titlebar-quit` **5/5**（确认后窗口句柄消失/PID 不存活/端口关闭）、`altf4` **7/7**、`app-quit` **7/7**（三种发起路径走同一协商）；截图 `64-titlebar-return.png`；**单测** `draft-close-flow.test.ts › dirty：有草稿时弹「有草稿」确认且默认返回；返回则取消并通知 renderer 解锁，迟到应答不关窗` / `dirty + 明确退出：一次性放行重新触发正常关闭`；🔴 本轮**抓到并修 1 处真实缺陷**（`draft-close-attach.ts`：窗口销毁后 `disposeIpc` 仍访问 `win.webContents` ⇒ 主进程未捕获异常弹系统「Error」框，把干净退出污染成 `dialogs=1` 的假询问；提交 `fff6581`，**无单测**，判据在实机 tag ⇒ 见「已知限制」③） |
| 2 | 最新 clean 应答才允许直接关闭 | **实机** `u3-64 --tag=clean-direct` **8/8**（页内 `dirtyCountOf=0` 才零询问直退）、`--tag=app-quit-clean` **4/4**；`u3-65-cdp.cjs --tag=real-keys` **7/7**（最后一次真键入进 store 且**被下一次关闭的 dirtyCount 算到** ⇒ main 重新查询得 dirty）+ `--tag=clean-unlock` **8/8**（放弃后零询问直退 + 锁面复核）；**单测** `draft-close-flow › clean：发新鲜查询 → 有效 clean 应答 → 放行关闭（bypass 恰好消费一次）`；`draft-close-client.test.ts › dirtyCount 变化才上报，序号与应答共用单调流` / `dirtyCountOf：与草稿列表同一 dirty 口径`（调用类 + A/B + 创建三区计数）；"查询应答到关闭之间不能新增未核对输入"= `draft-close-client › 查询按「同步输入→上锁→应答」顺序发出最新 dirtyCount` + 实机 6.5 锁段 |
| 3 | 退出输入锁保留已接收文字且不重放按键 | **实机** `u3-65`（键盘/剪贴板/输入法**全系统级**，CDP 只聚焦与读回，**全程不合成 CompositionEvent**）：`lock-blocks` **11/11**（锁定期**分两段**——A=关闭已投递但确认框未弹的纯锁定期、B=确认框在场且不抬窗口；各断言值不变 + `beforeinput`/`paste` 被 `defaultPrevented`；被拦输入等 2.5s **不重放**）、`cancel-restore` **6/6**（返回后焦点归还锁前编辑面且仍可输入）、`ime-composing` **10/10**（判据走结果侧：`hkl=0x08040804` + 只发 ASCII 拼音与空格却产出汉字 ⇒ 组合在飞时关闭**绝不零询问**；收尾不留裸拼音；已提交文字不回滚旧基线）、`paste` **5/5**（真 Ctrl+A→Ctrl+V 生效）；**单测** `draft-close-client › 组合进行中应答 inputSettled=false（不得冒充 clean）；无组合时为 true` / `组合收尾发生在查询之后也不重发应答（main 的确认不被自动关闭）` + **契约** `App 调用 useDraftCloseGuard 并在锁定时渲染 DraftCloseLockOverlay` / `锁的键盘/剪贴板阻止走 document 捕获监听，且在解锁时恢复焦点`；⚠️ 两条实现面事实见「三条实现面事实的结论」① ② |
| 4 | renderer 失联或应答无效仍有退出确认 | **实机** `u3-66-cdp.cjs --tag=crash-gone` **12/12**（真 `forcefullyCrashRenderer()` ⇒ unknown 确认 + 丢失说明；退出判定不依赖返回值）+ `--tag=hung-timeout` **15/15**（真同步忙等 9s 冻结 renderer，**不合成事件** ⇒ 1.5s 超时降级确认、恢复后不遗留输入锁）；截图 `66-crash-gone-dialog.png`（原生框走 PowerShell `CopyFromScreen` 全屏截取，CDP 截不到）；**单测** `draft-close-flow › 无应答/未握手/inputSettled=false/会话丢失 ⇒ unknown` / `1.5s 内无应答 ⇒ unknown 确认（不诊断存活）；迟到应答被拒且不关窗` / `unknown 提示只说明暂时无法确认，不断言崩溃/失联（源码契约）`；🔴 harness 坑：renderer 消失后 CDP ws **半开** ⇒ 无界 `await` 永不 settle ⇒ 进程以 0 静默结束的**假绿通道**，修法＝有界求值 + 看门狗 exit 3 |
| 5 | 慢响应降级后可取消并重新核对 | **实机** `u3-67-cdp.cjs`（注入＝真同步忙等冻结 1.5s/4s 两档 + CDP `Emulation.setCPUThrottlingRate 20×`；应答时刻＝页内真 preload 订阅记 `Date.now()`）：`slow-fast` **11/11**（实测延迟 1501ms 仍在投递后的阈值窗口内 ⇒ dirty 确认**不误降级**）、`slow-slow` **16/16**（实测 4001ms ⇒ unknown 超时提示、连发关闭至多一层、**取消解锁**、迟到应答解冻后零后续效果（不弹框/不关窗/草稿原样）、下次关闭 fresh dirty、clean 直退）、`cpu-throttle` **11/11**（20× 降速绝不静默放行；**不设向**——不宣称"慢 renderer 不能超时"，也不把 1.5s 声称为已实测存活阈值）；截图 `67-slow-fast-dialog.png`、`67-slow-slow-dialog.png`、`67-cpu-throttle.png`；**单测** `draft-close-flow › 慢响应降级后可取消并重新核对：下次查询正常完成` / `超时常量为 1.5s（设计初值，非慢机校准）`；**变异 6.7/F-A、F-B**（阈值 1500→100 打红 slow-fast、→60000 打红 slow-slow）；🔴 **原生框「返回」首击可被吞** ⇒ 取消类断言一律走 `drainDialogs`「点击-核对框数-重试」，并用 `dialog-hwnd` 取证排除"重弹新框" |
| 6 | 重载不能用空仓库抹掉旧会话未知状态 | **实机** `u3-66 --tag=reload-empty-repo` **15/15**（真 `Page.reload` 文档轮换：旧会话 dirty ⇒ 新会话报空仓库**仍降级确认**，标志**只能由用户「返回」清除**；反证＝清除后再关闭零询问直退）；截图 `66-reload-empty-repo-dialog.png`；**单测** `draft-close-guard.test.ts › 旧会话 dirty ⇒ 轮换置遗留标志；新会话 clean 上报不能抹掉它（空仓库不消音）` / `旧会话状态不明（未握手 / 从未上报）⇒ 同样置标志` / `崩溃（markPendingLoss）置标志；用户确认返回（acknowledge）才清除`；`draft-close-flow › 遗留标志把 clean 降级为 unknown；用户返回确认后，下次关闭恢复正常核对`；**变异 6.6/R-A**（撤销 `rotateSession` 旧会话评估 ⇒ reload tag 判红） |
| 7 | 旧会话伪造发送者和乱序消息不影响关闭 | **实机** `u3-66 --tag=forged-stale` **13/13**：**7 类伪造载荷经真 preload 通道直发**（假会话 / 乱序序号 / 坏 schema / 无挂起 requestId / 旧会话重放 …）⇒ 全部被拒、关闭按真实状态直退（反证项在场，防"一律拒绝"假真）；截图 `66-forged-stale.png`；**单测** `draft-close-guard › 握手：未知 webContents 与子 frame 被拒，主 frame 成功并标记握手` / `报告：未握手 / 非法载荷 / 旧会话 / 乱序全部被拒，合法报告才更新 lastReported` / `应答：无挂起查询 / requestId 不匹配 / 重放被拒` / `会话轮换：新 sessionId 作废旧会话，序号与握手状态重置`；**变异 6.6/R-B**（跳过 guard 的 sessionId 校验 ⇒ forged tag 判红）；"不传输草稿正文、sourceToken、授权、凭据"= `协议形状：只传元数据` 单测 + 6.11 冻结面；⚠️ `event.sender` 的 webContentsId/frame **冒名实机不可注入**（Electron 注入事件对象）⇒ 该两层只由单测承载（「已知限制」④） |
| 8 | 重复关闭取消和迟到应答不会重入 | **实机** `u3-64 --tag=reentry` **6/6**（连发关闭 6 次采样 `dialogs≤1`，不重入）+ `--tag=late-answer` **10/10**（迟到应答经真通道补投同 `requestId` **被拒且不关窗不删草稿**）；`u3-67 --tag=slow-slow` 的取消/迟到零后续段；**单测** `draft-close-flow › 进行中再次触发复用同一流程（不叠加查询、不重入确认）` / `busy 贯穿协商与确认，结束后回到空闲` / `取消后旧 requestId 应答被拒；新关闭用新 requestId 重新核对` / `确认退出的 bypass 只消费一次：泄漏到下一次关闭 = 重新协商（不静默放行）` / `源码契约：before-quit 复用 flow.requestClose，不直接退出/不自行操作 bypass`；`draft-close-guard › cancelQuery 清除挂起查询后，迟到应答不再被接受` / `detach 后一切消息被拒且 beginQuery 返回 null` |
| 9 | 系统会话结束不沿用普通退出承诺 | **实机** `u3-66 --tag=session-event` **9/9**（**合成** `query-session-end` / `session-end`，**不触发宿主机注销/关机** ⇒ 零确认、零阻止，且随后普通关闭承诺照常成立）；**单测** `draft-close-flow › 源码契约：装配层与入口不注册 query-session-end/session-end 拦截（系统结束会话不承诺确认）`；`u3-66-smoke-hook.test.ts › 两种系统会话结束事件 ⇒ 在窗口上合成 emit（带 preventDefault 面）` / `白名单外（空串/陌生动作/大小写）⇒ false 且零副作用` / `smoke-event-hook.ts 不注册任何事件监听器`（**D6「产品对系统会话结束零接入」契约跨文件成立**）/ `未设置哨兵文件 ⇒ 永不触发（生产路径零动作）`；dev-only 钩子 `REBASEAGENT_SMOKE_EVENT_FILE`（提交 `d2742ed`）：只合成不监听，未设变量时生产逐字节不变 |

### 8. 保留模态框约束焦点并正确恢复（3，**A**）

> 键盘/鼠标一律走 **CDP trusted 输入**（`Input.dispatchKeyEvent/dispatchMouseEvent`）。两条 6.10 坐实的事实决定判据写法：
> ① **Chromium 对模态框 Esc 是"两步关闭"**——第一次 cancel 可 `preventDefault`，**第二次以 `cancelable:false` 派发、
> preventDefault 无效**，且 React 委托的 `onCancel` 第二次不再执行 ⇒ 任何"吞 Esc"判据必须**连按 ≥2 次**，
> 模态行为一律手动 `addEventListener`、不信 React 委托；② `Page.reload` 后真鼠标不再触发 React onClick ⇒ 要干净页面必须**重启 dev**。

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 创建设置和放弃确认不泄漏焦点 | **实机** `u3-610-cdp.cjs --tag=focus-create` **9/9** + `--tag=focus-settings` **8/8**（初始焦点=首个可见可用控件；Tab×16 / Shift+Tab **禁闭且回绕**；背景**真鼠标** inert；判据=`activeElement.closest('dialog')`+文案+回退锚点在场性，焦点链全程落盘；截图 `610-focus-create-closed.png`、`610-focus-settings-closed.png`）；"含无可用操作按钮的状态"= `--tag=busy-lock` 的**无可用控件态 Tab×8 焦点不逃逸背景**；**单测** `modal-dialog › 跳过 disabled 与不可见（offsetParent null）元素，返回首个可见可用控件` / `全部不可用 ⇒ null（调用方安全降级到浏览器默认聚焦）` / `选择器覆盖五类控件 + tabindex，排除 tabindex=-1` + **契约** `创建/设置对话框经 ModalDialog，静态 <dialog open> 旧形态必须消失` / `showModal 是唯一的打开方式` / `输入锁覆盖指针事件（top layer 逃过覆盖层，须捕获阶段拦截）` |
| 2 | Esc 只关闭最上层并恢复焦点 | **实机** `u3-610 --tag=nested-confirm` **10/10**（一次 Esc 只关最上层放弃确认，**取消不丢草稿、关闭≠放弃**）+ `--tag=editor-confirm-esc` **10/10**（创建/编辑器两层同判据）+ `--tag=monaco-esc` **7/7**（真 Ctrl+F find 弹层**先消费第一次 Esc**，第二次才收起编辑区）+ `--tag=fallback-focus` **8/8**（「定位」触发点卸载 ⇒ 焦点=`[data-modal-focus-fallback]` 且真实可见）；截图 `610-nested-confirm.png`、`610-editor-confirm-esc.png`、`610-monaco-esc.png`、`610-fallback-focus.png`；**单测** `modal-dialog › shouldEscapeClose 四条件全满足才消费` / `非 Escape 键不消费` / `Monaco 弹层已消费（defaultPrevented）⇒ 编辑区让位` / `真模态在场 ⇒ 一次按键不同时关确认与底层编辑区` / `非最近打开的编辑区不消费（prompt 与 A/B 并存逐层收起）` + **契约** `创建/设置对话框的手写 Esc 监听都已被原生 cancel 取代（单通道）` / `四个编辑区都接 useEscapeClose，且与收起按钮同动作（保留草稿）` / `焦点恢复与失效回退：打开前元素优先，回退锚点在全局栏`；🔴 本轮抓到并修 **3 处**（提交 `fad9f87`）：①`CreateRunDialog` 残留旧 window keydown ⇒ 双通道同关确认与对话框；②`ModalDialog` busy 关闭锁被 Chromium"两步关闭"绕过 ⇒ cancel 改手动注册 + 锁主拦截点移到 **document 捕获 keydown**；③四编辑器「Esc 收起」全无实现 ⇒ 新增 `lib/use-escape-close.ts`；**变异 6.10/A、B、C、D** 全捕获（A 回插双通道 / B 不注册 keydown 守卫 / C 去 `modalPresent` / D 删回退锚点）；⚠️ C 的第一版注入 `defaultPrevented` 分支**实机不可观测**（Monaco 消费走 stopPropagation）⇒ 改注入 `modalPresent`——结论见「三条实现面事实的结论」③ |
| 3 | 创建忙碌期间不能通过焦点修复绕过关闭锁 | **实机** `u3-610 --tag=busy-lock` **11/11**（受控服务 `delayMs 6s` 在飞期间 ✕/取消/放弃/提交**全禁用**、Esc **连按 ≥2 次**被吞、无可用控件态 Tab×8 焦点不逃逸背景、受控服务**恰 1 次请求**、锁不外泄到其它入口；截图 `610-busy-lock.png`）；"原生目录选择尚未结束"的同类限制= `u3-63 --tag=create` 的在飞段；**单测/契约** `create-form-draft › 原忙碌关闭限制保留（modalLocked 禁用关闭与 Esc）`（5.2 后**改钉新通道**：关闭锁走 document 捕获 keydown，不再钉 window keydown）+ `modal-dialog › 创建对话框把 modalLocked 接到 closeDisabled`；"系统窗口退出仍由 main 草稿 guard 决定"= §7-1/§7-2 的 6.4 关闭面 |

### 9. 草稿交互保持既有执行和数据边界（2，**A**）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 草稿操作零执行且已有文件不变 | **实机** `u3-611-cdp.cjs --tag=zero-exec` **15/15**：五通道（result/prompt/messages/A-B/创建）草稿全操作 + **取消退出**（真哨兵 `app.quit` ⇒ 真 `#32770` ⇒ UIA「返回」⇒ 应用存活 + 三区草稿原样）；**"零执行"双硬证** = 受控服务 `entries()=0` **且** 冻结面零变化；**冻结面口径沿用 U2 5.5** = `traces / blobs / source / settings` **逐文件 SHA-256**，浏览前后 `diff=[]`、`traces 126→126`；截图 `611-zero-exec.png`；**变异 6.11/A/B/C**（A 草稿镜像 localStorage ⇒ web storage 判红；B 键入顺手 `saveSettings` ⇒ `settings.json` 哈希判红；C sessionStorage 跨重载复活 ⇒ reload 3 条判红），还原零残留 ⇒ 冻结面**有牙**；"无草稿持久化文件"= `.rebaseagent` 全树标记子串零命中（同 §1-5） |
| 2 | 原有执行入口和文件阅读继续可用 | **实机** `u3-611 --tag=regression` **13/13**（U1 页签/选中 span 恢复、U2 文件列表/选择/path 往返保持/正文渲染、五执行入口在场、历史草稿零泄漏；截图 `611-regression.png`）+ `u3-63 --tag=regression` **5/5**（五执行入口 + 创建可达、U2 文件阅读面未坏）；"请求沿用原有执行语义和门禁"= 受控执行逐入口核提交值：`u3-63` 的 `result` 9/9、`prompt` 6/6、`messages` 15/15（代理**真录制→重发**，关代理后 main 以 `PROXY_NO_KEY` 独立拒绝）、`ab` 13/13、`create` 15/15、`isolated` 8/8，加 `--tag=business`（`SETTINGS_NOT_CONFIGURED`）；**单测**同口径回归：`controlled-entrances.test.ts` 3 用例（普通创建/result fork/prompt fork **恰一次提交**、父文件逐字节不变）、`controlled-isolated.test.ts` 4 用例（隔离创建**恰两次提交**、只读预检**零模型请求**、二次分叉边界、隔离 prompt/A-B 拒绝）、`isolated-parent-rejection.test.ts` 5 用例、`run-create.test.ts`（A1 验收：新建 run 可作父本）、`fork-runner.test.ts` / `prompt-fork.test.ts` / `proxy.test.ts`（既有门禁未放宽）；🔴 6.11 抓到并记 4 类 harness 坑（IIFE 括号错位假阴、`clickSpan` 的 title 误命中「运行配置」⇒ 设置模态被静默打开、真鼠标前 `elementFromPoint` 校验、文件页 auto 过滤筛空），防复发＝每步 dump dialog 集合 |

---

## 三条实现面事实的结论（tasks 7.2 要求逐条给"可接受 / 回 proposal-design"）

### ① Monaco 走 `native-edit-context` ⇒ `inputSettled` 在真输入法路径**没有触发路径**

- **事实**（6.5 实测）：本机 Monaco 的编辑面是 Chromium `native-edit-context`，document 级
  `compositionstart/update/end` 事件 **0 条**（`compEventsSeen=0`）⇒ 4.3 的 `composingRef` 不置位 ⇒
  renderer 应答恒 `inputSettled=true` ⇒ D6 的「`inputSettled=false` ⇒ unknown 保守」在**输入法路径上不可达**。
- **它没有造成静默放行**：真机 `ime-composing` **10/10** 证明——组合文本一旦进入 model 就使
  `dirtyCount>0`，关闭照样出 dirty 询问；未提交的候选在确认框抢焦点时被输入法**干净丢弃**（model 回到已提交基线，
  不留裸拼音），**从未进入控件**，因此不存在"已接收但未上报"的文字。
- **判据并未被架空**：unknown 分支本身有**真触发路径**——6.6 用真 `forcefullyCrashRenderer()`（`crash-gone` 12/12）
  与真同步忙等冻结（`hung-timeout` 15/15）坐实；`draft-close-client/flow` 单测用组合状态直接钉住
  `inputSettled=false ⇒ unknown`（变异 4.5 系列有牙）。
- **结论 = 可接受，不回 proposal**：requirement 文本自洽——R7-3 的 THEN 已明写
  「未收尾组合不能报告可直接退出的 clean」**且**「不承诺恢复尚未进入控件的输入法候选」，
  前者在 NEC 通道由 `dirtyCount` 承担、后者正是本事实的落点。**但需要一处文档收口**：
  `design.md` D6 应注明「`inputSettled` 的降级判据覆盖 textarea 通道；Monaco 的 `native-edit-context` 通道
  不产生 document 级 composition 事件，保护由 `dirtyCount` 侧承担」——**本索引即为该收口的记录载体**，
  归档时随 design 一并保留；不新增合成 `CompositionEvent` 的验收（那是自证假象，6.5 已禁用）。
  ⚠️ **生效条件**：若将来 Monaco 引擎改为上报 composition 事件、或 Electron 关闭 NEC，本条需**重新评估**。

### ② 未提交候选在确认框抢焦点时被输入法干净丢弃

- **事实**（6.5）：确认框弹出抢焦点 ⇒ 输入法丢弃未提交候选 ⇒ 模型回到**已提交基线**、不留裸拼音。
- **结论 = 可接受，已写死**：与 D6「候选未进控件不算已接收」一致；spec R7-3 THEN 尾句已把它写成**明示的不承诺项**。
  断言按「提交出恰好一个汉字 / 干净丢弃」二选一 + 「**已提交文字必须保留**」双条钉住（`ime-composing` 10/10），
  不因丢弃路径判红。⚠️ 操作纪律（后续 tag 必照）：**别在模态框在场时把主窗口抬到前台**，锁内**只发字母**
  （space/enter/esc 会激活确认框默认按钮，把"询问在场"测成"已应答"）。

### ③ Monaco 弹层消费 Esc 走 `stopPropagation` ⇒ `shouldEscapeClose` 的 `defaultPrevented` 让位分支实机不可观测

- **事实**（6.10）：Monaco 的 find 弹层消费按键用 `stopPropagation`，事件**不抵达** document ⇒
  `shouldEscapeClose` 里"已 `defaultPrevented` ⇒ 编辑区让位"这条分支在实机上取不到（6.10 变异 C 第一版注入该分支，
  实机**零观测**）。
- **结论 = 可接受，证据分层**：该分支由**单测**钉住（`modal-dialog › Monaco 弹层已消费（defaultPrevented）⇒ 编辑区让位`）；
  实机面改由 `modalPresent` 判据承担（`nested-confirm` 10/10 + `monaco-esc` 7/7 从结果侧证明
  "一次按键只关一层"）。行为契约（"Monaco 内部弹层优先消费"）在**两层的哪一种实现下都成立**，
  故 spec 文本无需改。**教训已登记**：变异要在**可观测路径**上注入点，否则"判据有牙"是假的
  （与 U2 6.3、U3 3.3 的假绿同族）。

### ④ 不归 U3 的一条（避免混进本 change 结论）

渲染层**无 error boundary**（任一渲染期异常仍会整页空白）是 **U2 收官时登记的遗留**，
本 change 未处理、也未宣称处理；6.2 的 `source-missing` 只证明"来源失效 ⇒ 安全回退不崩"，
**不等于**整页异常兜底。

---

## U4 / U5 边界（本 change 显式未做，索引不宣称）

| 留白 | 归属 | 本 change 的实际交付面 |
| --- | --- | --- |
| 操作登记：main epoch / operationId / 去重 / 执行槽 / `status` 与原子 `reconcile` / `notAccepted` 封禁 / 可信 runIds | **U4** `add-desktop-operation-tracking` | 提交只登记**会话内渲染层**的关联令牌与快照（`lib/draft-submission.ts`），**main 侧无操作真相源**；R6「可信核对由后续操作登记提供」是本 change 写明的留白 |
| 跨页执行状态、结果定位、失败记录直达、按核实后的正常终止事件自动清理草稿 | **U5** `unify-run-execution-workflow` | 本 change **不因任何执行结果自动删除草稿**（R6-2 实机 `u3-63` 六入口逐条坐实"保留"）；冻结只在收到明确返回时解除，A/B 部分臂失败不清批次 |
| 活跃操作期间的退出保护 | **U4 接入、U5 统一呈现** | 退出确认只看**草稿 dirty/unknown**（D6）；正在执行的请求不参与决策（6.10 `busy-lock` 证的是**模态内**关闭锁，不是窗口退出锁） |
| 实时步骤事件、真正取消、跨 main 重启的任务恢复、运行队列/并发 | U4/U5 Non-goals | 全部未做；6.11 明确「重启后三区全空、零痕迹」是**特性不是缺陷** |
| 统一创建/实验工作区、代理录制工作区 | **U5 / U8** | 沿用现有 `CreateRunDialog` 与 `ModelAbEditor`，只改读写草稿的接线，未重排布局（保留原页面样式） |

---

## 接线核对（入口 ↔ 真相源，逐条点名）

- **五个执行通道**全部接草稿并受冻结约束：`forkAt`（result）、`promptFork`（system/user）、`proxyFork`（messages）、
  `createRun`（创建整份）、`modelAb`（A/B 整批）——契约见 `draft-submission › 接线契约：五类提交走快照并受冻结约束`
  （先登记后发请求、提交值取快照、预览不带关联、**六个**写入/放弃路径拦冻结、**五个**执行函数负责收尾）。
- **四个编辑入口**全部读写 store 草稿：`ForkEditor` / `PromptForkEditor`（两字段独立键）/ `MessagesForkEditor` /
  `ModelAbEditor`（整批），另有 `CreateRunDialog`（会话单份）——各归 `fork-editor-draft` /
  `prompt-messages-editor-draft` / `model-ab-editor-draft` / `create-form-draft`。
- **草稿入口两处**共用同一派生与同一面板：`DetailPanel`（本运行）+ `GlobalBar`（全会话），
  见 `draft-list › 接线契约：草稿入口与失效视图`。
- **确认宿主单实例**挂在 `App.tsx`（补漏提交 `eef8fed`——教训：逐文件点名 `git add` 会漏接线文件）。
- **模态基础件**：`ModalDialog`（`showModal` 真 top layer）+ `ConfirmDialog`（`requestConfirm`）+
  `DraftCloseLockOverlay`（输入锁遮罩）+ `lib/use-escape-close.ts`（编辑区 Esc）。
- **main 侧**：`draft-close-guard.ts`（六步校验，不 import electron）/ `draft-close-flow.ts`（决策流）/
  `draft-close-attach.ts`（electron 装配）/ `smoke-event-hook.ts`（dev-only 注入）/ `shared/ipc.ts` +
  `shared/channels.ts` + `preload/index.ts`（五通道 schema 与桥）。
- **U3 期间改到的既有产品代码**（4 处，均有测试回写或实机判据）：
  `main/fork-runner.ts`（6.3 缺陷：`ModelAbResult.ids` 误计失败臂 ⇒ 只取 `error===null` + 补单测
  `controlled-service › 部分臂失败：ids 只计成功臂，失败臂仍落盘且带 error（不谎报成功）`）、
  `components/DetailPanel.tsx`（6.9 缺陷：臂行 `break-all`）、
  `main/draft-close-attach.ts` + `main/index.ts`（6.4 缺陷：`win.isDestroyed()` 跳过 webContents 解绑；**无单测**）、
  `components/CreateRunDialog.tsx` + `ModalDialog.tsx`（6.10 缺陷①②③）。

---

## 已知限制与诚实边界（逐条，带影响面）

| # | 限制 | 影响 | 现在由什么守住 |
| --- | --- | --- | --- |
| ① | **零持久化没有单测面**（vitest 里 `localStorage/sessionStorage` 零命中，草稿仓库也不引用它们） | 「草稿不会跨 renderer 会话持久恢复」的**存储**子项只有实机三面扫描 | `u3-611 --tag=reload/restart-*`（27 检查）+ 变异 6.11/A/B/C；源码纪律写在注释里 |
| ② | 真原生目录选择对话框（`showOpenDialog`）在 harness 中**不可应答** | 「取消目录选择保留原引用」只到**单测 + 契约级**，未实机执行 | `create-form-draft › 取消保留原引用` + `debugging-drafts › store 目录引用独立于草稿`；代次守卫另有 6.3 `create` 的在飞段间接覆盖 |
| ③ | 两处产品改动**无新增单测**：`fff6581`（6.4 `draft-close-attach` + `main/index` 接线）、`eef8fed`（App 挂确认宿主） | 这两处的回归判据在实机脚本与后续源码契约断言里，不在 vitest 用例名上 | `u3-64` 八 tag（59 检查，含 Error 框污染的反证）+ `confirm-dialog.test.ts › 放弃确认全部经 requestConfirm（DetailPanel 9 处 + 创建 1 处）`（该用例属 describe
`U3 5.2 接线契约（源码级）：放弃确认迁出 window.confirm`） |
| ④ | `event.sender` 的 webContentsId/frame **冒名实机不可注入**（Electron 自己注入事件对象，渲染层碰不到） | 「旧会话伪造发送者」的 sender 层由单测承载，实机面聚焦 sessionId/sequence/requestId/schema 四层 | `draft-close-guard › 握手：未知 webContents 与子 frame 被拒`；`u3-66 --tag=forged-stale` 13/13 |
| ⑤ | `inputSettled=false` 的 unknown 降级在 Monaco `native-edit-context` 通道无触发路径 | 输入法路径的保护改由 `dirtyCount` 侧承担（不降低标准，见结论 ①） | `u3-65 --tag=ime-composing` 10/10 + `u3-66 --tag=crash-gone/hung-timeout` 27 检查 + `draft-close-client/flow` 单测 |
| ⑥ | 6.5 未提交候选被输入法丢弃 | 不判红，按二选一断言 | `ime-composing` 的「提交出恰好一个汉字 / 干净丢弃」+「已提交文字必须保留」 |
| ⑦ | `.workbuddy/u3/u3-64`、`u3-65` 的 `measurements.json` 是**修缺陷前的中间态**（前者缺 4 个 tag、`clean-direct` 2/3；后者 `clean-unlock` 3/4） | 直接读该 JSON 会得出"有失败项"的错误结论 | 终态以各目录 `README.md` + `final-run.log`/`run-final.log` 为准（本索引引用的是终态数字） |
| ⑧ | 1.5s 超时阈值是**设计初值**，未在慢机上校准 | 「不将 1.5 秒声称为已实测存活阈值」是 spec 原文要求 | `draft-close-flow › 超时常量为 1.5s（设计初值，非慢机校准）` + 6.7 `cpu-throttle` **不设向** |
| ⑨ | 渲染层无 error boundary（**U2 遗留**） | 与本 change 无关，未宣称处理 | 见结论 ④ 节 |

---

## 质量门禁（任务 7.1，2026-09-26 整跑，HEAD `8e3995b`）

`packages build` **EXIT=0（5/5，排除 desktop）** · `desktop typecheck` **node/web 双 EXIT=0** ·
`desktop vitest run` **80 文件 / 1525 用例 / 0 失败 / 无 `Errors` 行**（EXIT=0；**文件级差集 missing 0**，
脚本 `.workbuddy/u3/u3-71/file-diff.cjs`）· 根 `biome check .` **EXIT=0，Checked 367 files / 0 错** ·
`openspec validate preserve-debugging-drafts --strict` **valid**、`validate --all --strict` **13 passed / 0 failed** ·
`electron-vite build` **EXIT=0**。
**环境阻塞：本轮 0 次**（6.11 首轮曾出现的 2 条 `controlled-entrances` 红＝紧邻 run-all 的 mock 端口起停 flake，
本轮整跑未复现）；**产品失败 0**。原始日志 `.workbuddy/u3/u3-71/gates.txt`。

**实机检查总数（README 口径）**：6.1 29 + 6.2 20 + 6.3 103 + 6.4 59 + 6.5 47 + 6.6 64 + 6.7 38 + 6.8 96 + 6.9 108 +
6.10 63 + 6.11 45 = **672 检查全绿**；11 个采集脚本共 **62 个正式 tag 键**
（6.1 六场景 6、6.2 五场景 5、6.3 11、6.4 8、6.5 6（另有 `probe`/`lock-probe` 两个诊断键不计入检查）、
6.6 5、6.7 3、6.8 3、6.9 3、6.10 7、6.11 5）。
**变异**：§1–§5 每项 2–5 处 + 实机面（4.1/4.2/4.3/4.4/4.5/4.6/4.7/5.1/5.2/6.6/6.7/6.8/6.9/6.10/6.11）
共 **17 个变异脚本**，全部"注入 ⇒ 判红 ⇒ 还原复绿"。

## 本索引不宣称的事（放行前请 owner 自决）

- 不宣称 U4/U5 的任何能力（见上表边界）；不宣称跨页执行状态、自动清理草稿、真实取消、任务恢复。
- 未打 tag、未上传 Release、**未归档**（tasks 明写"归档另行处理"）。
- 本地 `main` 领先双远程（用户手动 push）；工作树里 `docs/README.md` 修改与 `docs/engineering/{notes,reports}/2026-09-25-*`
  两个未跟踪文件是**用户自己的 K1 Gitee 发布内容**，非本 change 产物。
