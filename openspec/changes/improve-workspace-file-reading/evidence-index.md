# U2 `improve-workspace-file-reading` 场景 → 证据索引

> 任务 6.3 的产出。范围：本 change **唯一一份 spec delta**
> [`specs/desktop-ui/spec.md`](specs/desktop-ui/spec.md) 的 **6 requirements / 35 scenarios**
> （1 MODIFIED / 9 既有场景 + 5 ADDED / 26 新场景）。
>
> **本索引不自动归档、不发版。** 证据不足或只到契约级的场景**显式标注**，不以"已通过"冒充。
> 本索引**不是**验收放行凭据——放行由 owner 拍板（任务 6.3 明写"不自动归档"）。

## 怎么读这份表

- **证据**优先是**可执行的用例**（`测试文件 › 用例名`，不写行号，定位以用例名为准）；
  纯静态约束显式写"静态"。
- **测试**默认指 `apps/desktop/test/*.test.ts`。
- **CDP** 指 `apps/desktop/scripts/u2-5*-cdp.cjs`（`u2-51`…`u2-56`），其**截图与结果矩阵已入库**到
  `docs/reviews/2026-09-23-u2-51|52|53|54/`、`docs/reviews/2026-09-24-u2-55|56/`（各含 `README.md`）；
  原始 `measurements.json` 落 gitignored `.workbuddy/u2-5*/`。**tag 名即 README 结果矩阵的行名。**
- **原型**指 `docs/reviews/2026-09-23-u2-file-prototype/`（1.2 产出，真 Monaco 0.56 的权威 D4 数字）。
- **fixture** 由 `apps/desktop/scripts/gen-u2-file-fixtures.cjs` / `gen-u2-54-side-fixtures.cjs` /
  `gen-u2-55-fixtures.cjs` / `gen-u2-56-fixtures.cjs` 生成到 gitignored `.rebaseagent/`；
  资产齐备性由 `u2-file-fixtures.test.ts` 的「1.1 资产齐备」组守护。
- **质量门禁**指任务 6.1（构建/类型检查/desktop 全量/replay 读取链）与 6.2（lint/openspec 全量/desktop build
  + 离线懒加载回归）；原始日志落 `.workbuddy/u2-61/`。

## 汇总

| requirement（desktop-ui） | 变化 | 场景数 | 已覆盖 | 未验证 |
| --- | --- | --- | --- | --- |
| 文件检查点和差异只读可查 | M | 9 | 9 | 0 |
| 文件阅读在会话内按运行恢复并校验定位 | A | 8 | 8 | 0 |
| 文件目录支持真实变化筛选和路径查找 | A | 4 | 4 | 0 |
| 文件目录和差异按内容容器宽度适配 | A | 4 | 4 | 0 |
| 文件阅读工具操作完整原文且保持只读 | A | 4 | 4 | 0 |
| 文件两侧读取状态真实且旧响应不覆盖新选择 | A | 6 | 6 | 0 |
| **合计** | 1M + 5A | **35** | **35** | **0** |

> 两条**诚实边界**（不改变上表计数，逐条落在「已知限制」）：
> ① 「文件页签往返恢复阅读」的**列表滚动**子项实机证据力弱（当时夹具清单只可滚 2px），改由接线契约用例 +
> 变异 M4 立证，**正文滚动锚点**则是实机强证据；
> ② <960px 档「运行列表」无 UI 可达入口（`navOpened` 缺调用方，**属 U1 范围**），故跨运行场景只在
> ≥960 档实机执行。

## 差集核对：MODIFIED 的既有 9 场景零丢失

`## MODIFIED` 是**整体替换**语义，丢 scenario 是**静默**的 ⇒ 按 requirement 名 + scenario 名做集合差
（脚本 `.workbuddy/u2-61/scenario-diff.cjs`，输出 `.workbuddy/u2-61/16-scenario-diff.log`）：

```
「文件检查点和差异只读可查」主 spec 9 场景 → delta 9 场景
  丢失: 无 ✅
  新增: 无
5 个 ADDED requirement 均与主 spec 无同名（无 MODIFIED/ADDED 冲突）✅
delta 场景总数 = 35（MODIFIED 9 + ADDED 26）；requirements = 6（M 1 + A 5）
```

- **既有场景零丢失**、无新生也未删名。唯一的**正文改动**是审阅 P1-a 采纳项：窄窗口场景 THEN 里
  「文本不覆盖**提交**和导航控件」→「文本不覆盖**检查点与导航控件**」（场景名未动，故差集为零）。
  proposal/tasks 已同步说明"不再声称全部逐字保留"。
- 附带：主 spec 该 requirement 现状见 `openspec/specs/desktop-ui/spec.md`（U2 归档前仍是 C 版正文，
  **本 change 尚未归档**，故主 spec 里的"提交"措辞要等归档那一刻才被替换）。

---

## desktop-ui

### 1. 文件检查点和差异只读可查（9，**M**，C 原有）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 重启后查看文件差异 | CDP 5.6 `restart-state` 9/9（`docs/reviews/2026-09-24-u2-56/`）：**真进程重启**（先确认 9612 端口真空出，避开"pid 过期 ⇒ `--stop` 假成功"的假重启）后文件页可开、选中完成步骤的修改文件后 monaco **真模型** `根第二轮改写 → 子 run 改写`、`lineChangeCount=1`、只读（`restart-state-1-重启后.png`、`restart-state-2-重启后真实差异.png`）；全程逐文件 SHA-256（夹具 9 + traces 72 + 附件 25 = **106 文件**）零变化 |
| 2 | 文件读取 IPC 拒绝越权 | `workspace-view.test.ts` ›「非法 runId（可穿越 tracesDir）→ rejected，而非抛错」「清单外路径 / 物理 blob 路径 → not_found（永不拼进宿主路径）」「非法逻辑路径（穿越 / 绝对 / UNC / 保留名）→ not_found」「祖先 / 不存在的 stepSpanId → step_not_found（不用祖先快照冒充本 run 自有状态）」；CDP 5.5 `ipc-guard` 11/11（**`window.api` 直调、不经 store/组件**：非法 runId ⇒ `WORKSPACE_INVALID_REQUEST`/`rejected{invalid_request}`、未规范化分隔符 ⇒ `not_found`、请求形状非法 ⇒ `INVALID_ARGUMENT`、5 种物理/穿越写法哨兵**全部无泄漏**，且**对照项**合法请求确实成功 ⇒ 非"一律拒绝"）；静态：`shared/ipc.ts` zod 形状校验 + main 只注入 dataDir、renderer 零 fs |
| 3 | 长文本及窄窗口 | CDP 5.1 六档矩阵（`a-800-files-monaco.png`/`a-640-files-monaco.png`）与 5.2 `800-narrow` 12/12、`640-single` 12/12：窄档目录**一律收起**、diff 强制 inline、正文占满主区 435/480px、字号不缩（13px）、无整页横向滚动；`file-layout.test.ts` ›「窄档（容器 ≤800）⇒ 目录一律收起，即使几何上装得下」「窄档过渡带（801–959）⇒ 按几何判据正常决策」；长文本**按哈希**核对完整原文（CDP 5.4 `tools-copy-2-长文件完整原文.png`，IPC sha256 = 磁盘 sha256，不靠截图） |
| 4 | 文件浏览过程无写入 | CDP 5.5 `readonly` 12/12：冻结源目录/夹具目录/live trace/live 附件共 **119 条哈希（113 个唯一文件）**，浏览（切检查点/开 diff/开长文本/开二进制/重试清单/重试内容）前后 **`diff = []`**、`traces 70→70 / blobs 21→21 / source 6→6` ⇒ 逐字节不变故**零 LLM/工具调用**；`workspace-view.test.ts` ›「完整浏览一遍（初始 + 各轮 + 逐文件读文本）后，数据目录全树指纹逐字节不变」；`u2-file-fixtures.test.ts` ›「夹具只读性：源目录与既有资产在读取期间逐字节不变」；静态：渲染层只用 `inspectWorkspace`/`readWorkspaceFile` 两个只读动作，无任何回写入口 |
| 5 | 初始与各轮文件快照可选择 | `workspace-files.test.ts` ›「deriveCheckpointOptions —— 只列本 run 自有步骤，轮号取所属 run 的 n」整组（初始恒在首位且不是"第 0 轮"、多轮按 n 升序、祖先前缀不得进选择器、无完成步骤只给初始）；`u2-file-fixtures.test.ts` › 断言①「初始与各轮文件快照可选择」；`workspace-view.test.ts` ›「初始快照：change 恒为 initial，轮号为 null」「第 2 轮结束时：新增 b.txt 标 added」「修改既有文件 → 标 modified（按内容哈希，不用 mtime）」；CDP 5.5 `errored` 6/6（失败 run 的 3 个检查点全列出） |
| 6 | 文件选择器轮号不沿链累加 | `workspace-files.test.ts` ›「轮号取 step **自己的** n，不是数组下标（变异验证：改用 index 必须红）」「祖先前缀的 step（不在 leafSpanIds 里）**不得**进选择器」；`u2-file-fixtures.test.ts` › 断言②「文件选择器轮号不沿链累加」（二次分叉）`fixture`；CDP 5.6 `probe-1-隔离子run.png`（隔离子 run 只出现自有轮） |
| 7 | 二进制和不可用附件分别显示 | `workspace-view.test.ts` › 六态全表（「二进制文件：只返回大小/哈希，**不传字节**、不做有损解码」「附件被删除 → missing」「附件被篡改 → corrupt」「清单外路径 / 物理 blob 路径 → not_found」）；CDP 5.5 `unavailable` 8/8：二进制 ⇒「二进制文件」+ 真实大小/完整哈希、**一个编辑器都不渲染**；附件缺失 ⇒ 列表徽标「附件缺失」+「不会用空文本或源目录兜底」；附件损坏 ⇒ 「附件损坏」+「哈希/长度不符，拒绝展示内容」；三者 `fakeEmptyClaim` 全 false（`unavailable-1|2|3.png`）；无自有完成步骤的旧 run ⇒ 选择器只剩「本 run 初始状态」且初始清单照常可读（`unavailable-4.png`） |
| 8 | 失败运行已记录文件可查看 | `workspace-view.test.ts` ›「run 被 errored 事件封存后，已记录的初始/步骤检查点仍可列出并读取完整文件事实」；`u2-file-fixtures.test.ts` › 断言⑤「失败运行已记录文件可查看」+ 附「无自有完成步骤的运行仍可读初始清单（不渲染成读取失败）」；CDP 5.5 `errored` 6/6：`reason:"error"` + 概览「出错终止」双证据、第 1 轮 monaco 真模型 `初始版本 → 失败前的写入`、切第 2 轮仍可读 ⇒ **失败不撤销历史写入**（`errored-1|2.png`） |
| 9 | 数据目录迁移后文件仍可查 | CDP 5.6 `migrate` 10/10：①整体迁移＝把 `.rebaseagent` **整个改名到另一绝对路径**，用**新 dataDir** 直调真实读取 API 仍读出两侧真实文本，且迁移期间原 `source` 路径随数据目录一并不可达（⇒ **不依赖原 source 路径**），迁回 + 重启后界面 diff **逐字一致**；②仅迁 JSONL ⇒ 新路径只有 `traces/`、`readRun` 成功而 `readWorkspaceFile` 报 **`missing`**，应用层徽标「附件缺失」、轨迹与步骤页照常可读、**不渲染伪空文件**（`migrate-1-整体迁移后重启.png`、`migrate-2-仅迁JSONL.png`）；三处 rename 全程 `finally` 还原且收尾核验无残留 |

### 2. 文件阅读在会话内按运行恢复并校验定位（8，**A**）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 首次文件页选择最近自有完成步骤 | `file-checkpoint-resolve.test.ts` ›「多轮自有步骤 ⇒ 取本地轮号最大者（不是数组末条）」「合并轨迹含祖先前缀时**不选祖先**（只认 leafSpanIds）」「轮号取本 run 本地 n，不沿链累加」「**从未进入**（entered=false）⇒ 取最近自有完成步骤，而不是初始」；**接线契约**组（视图必须消费解析结果、必须走 `resolveCheckpoint`、**反向**不得再用 `validateCheckpointStepId` 单独决定 effective、首帧必须写回、写回前须复查新鲜状态）；CDP 5.6 `restart-state`：重启后按首次进入策略落到默认检查点「本 run 第 2 轮结束」。⚠️ 此场景是 5.6 **实机抓出的真实缺陷**（首次进入被 `checkpoint === null` 吞成初始），修复见该任务记录 |
| 2 | 无自有完成步骤时选择初始 | `file-checkpoint-resolve.test.ts` ›「没有自有完成步骤 ⇒ null（调用方落到初始状态）」「无自有完成步骤 + 从未进入 ⇒ 初始（null），且不算失效」；`u2-file-fixtures.test.ts` › 断言⑤附（`u2bad_noownsteps` 标本：自有完成步骤 0 根）；CDP 5.5 `unavailable` 的「无自有检查点」子项（`unavailable-4-无自有检查点.png`） |
| 3 | 文件页签往返恢复阅读 | CDP 5.3 `roundtrip` 8/8：正文锚点 `contentScroll={s_11, long.txt, line 7, offset 2}` 随真滚轮从首可见行 1 变到 8，**文件→步骤→文件**往返后 DOM 首可见行仍为 8（`roundtrip-1-滚动后.png`/`-2-步骤页.png`/`-3-返回文件页.png`）；`file-view-session-state.test.ts` › 接线契约「文件选择来自会话状态，不是组件局部 state」（**反向断言**旧形态 `setSelection`/`useState` 必须消失）；`file-scroll.test.ts` 锚点构造/恢复整组；`reading-scroll-restore.test.ts` 滚动上限裁剪与恢复门控。⚠️ **列表滚动子项实机弱**（夹具清单仅可滚 2px）⇒ 由 `file-view-scroll-wiring.test.ts`「滚动位置真的会被**恢复**，不只是保存」+ 变异 M4 立证 |
| 4 | 跨运行和辅助视图返回恢复文件 | CDP 5.3 `cross-run` 9/9：跨运行 A(`s_01`/line 7) / B(`s_17`/line 4) 的**同名** `long.txt` 各自保持，经**分支树 + 设置**返回后 A 仍 line 7 且 B 不受影响（`cross-run-1-A-文件页.png` … `-4-辅助视图返回A.png`）；`file-reading-state.test.ts` ›「A/B 两个 run 的同名 step/path 各自独立，互不影响」；`reading-state.test.ts` ›「按 run 隔离：相同 span ID 不串状态（关键反例）」 |
| 5 | 显式文件定位覆盖历史 | `file-reading-target.test.ts` ›「file 目标 ⇒ 落到文件页并携带文件目标（不消费历史页签）」「file 目标不带 path ⇒ 调用方显示列表」「`file.stepSpanId` 为 null ⇒ 明确指初始」「run 无文件页时的 file 目标 ⇒ 降级概览且标失效（不臆造文件页）」「普通返回不消费显式目标」（无 target / 仅 `{tab:"files"}` 两态）；**不可混传**（审阅 P2）：`parseReadingTarget` 拒收 `spanId`+`file`、`expandStepId`+`file`、`stepSpanId` 类型非法。CDP 5.3 `explicit` 5/5（`explicit-2-步骤页入口.png`、`explicit-3-显式定位后.png`）；`file-view-scroll-wiring.test.ts` ›「步骤页真的有『打开该轮文件』入口」（能力断言 + 接线契约，以 `validateCheckpointStepId(...)==='valid'` 为门、祖先步骤不给入口） |
| 6 | 失效检查点和路径安全回退 | `file-checkpoint-resolve.test.ts` › 检查点重校验（`null`⇒初始 / 仍有效⇒valid / 祖先或拼错⇒`stale` **提示并回退默认、不换别的检查点**）与路径重校验（清单里有⇒`present`（附件不可用/被筛选隐藏也保留）/ 确认不存在⇒`absent` / **清单读取失败⇒`unknown`，不当作路径消失** / 未拿到清单⇒`unknown`）；CDP 5.3 `fallback` 9/9（`fallback-1-失效路径.png`、`-2-失效路径往返后.png`、`-3-失效检查点.png`）；`file-view-scroll-wiring.test.ts` ›「失效引用须真的被清掉」（5.3 缺口⑥：原先"从不写回"退化为永久告警） |
| 7 | 切检查点保留仍存在的路径 | `file-checkpoint-resolve.test.ts` ›「清单里有 ⇒ present（附件不可用/被筛选隐藏也保留意图）」；`file-two-side-read.test.ts` ›「U2 3.5 目录控件与隐藏选择恢复（能力断言）」；`file-directory-filter.test.ts` › `directoryCounts` 组（筛选不冒充清单规模） |
| 8 | 文件阅读状态不跨进程承诺 | CDP 5.6 `restart-state`：重启前刻意选**非默认**状态（`entered=true, checkpoint=null`）⇒ 重启后 `entered=false`（**文件阅读状态未跨进程**）；`file-reading-state.test.ts` › 默认值与引用稳定整组（内存态）；静态（Non-goal）：阅读位置只存会话、不落盘 |

### 3. 文件目录支持真实变化筛选和路径查找（4，**A**）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 路径搜索与变化筛选组合 | `file-directory-filter.test.ts` › `filterFiles` 组（「搜索对整个**路径**匹配（不只 basename），且不区分大小写」「搜索 **与** 筛选组合（交集）」「搜索词两端空白被忽略」）+ `resolveChangeFilter` 组；静态：搜索只在 inspect 返回的**完整逻辑路径**上做，不改写 path 大小写/分隔形式用于请求（D3） |
| 2 | 初始与完成检查点的默认筛选 | `file-directory-filter.test.ts` ›「auto + 初始检查点 ⇒ all」「auto + 完成步骤 ⇒ changed」「显式 all/changed 不受检查点影响（用户偏好优先）」；`file-two-side-read.test.ts` ›「U2 3.4 接线契约：搜索/筛选/空态/计数走纯派生层」（解析后的 `all\|changed` 与用户偏好原值**分开下传**，展示层不自己算 auto） |
| 3 | 空清单无变化和无匹配可区分 | `file-directory-filter.test.ts` › `deriveDirectoryEmptyReason` 组（「零文件清单 ⇒ empty-list」「有文件但相对初始无变化 + changed ⇒ no-change」「搜索无匹配 ⇒ no-match（优先于 no-change）」「三态消息各不相同（不混用同一句话）」）+ 计数组（「未过滤时 visible === total 且 filtered 为 false」「被搜索/筛选后 visible < total 且 filtered 为 true（规模不冒充）」） |
| 4 | 筛选不偷换当前文件 | `file-directory-filter.test.ts` ›「附件不可用**不**影响变化判定（缺失/损坏不被标为新增或删除」；`file-two-side-read.test.ts` ›「U2 3.5」能力断言（被筛掉的当前路径仍保留内容区标题与阅读状态；`selectedFile` 从**完整清单**取，不从 `visibleFiles` 取）；CDP 5.4 `tools-copy-3-搜索隐藏与折叠后复制路径.png`、5.3 `explicit-1-搜索隐藏选择.png` / `search-hidden` 5/5（`search-hidden-1-解阻后.png`） |

### 4. 文件目录和差异按内容容器宽度适配（4，**A**）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 文件正文在代表视口可读 | CDP 5.1 六档矩阵 **75/75 checks**（`a-1440/1360/1210/1024/800/640-files-monaco.png`）：≥960 档 inline 文字区均 ≥480（D4 硬判据）、并排档两侧各 ≥320；阈值口径由 1.2 **原型真 Monaco** 定（`docs/reviews/2026-09-23-u2-file-prototype/`，读 `getLayoutInfo().contentWidth`，且与 mock 版交叉核验偏差）；`file-layout.test.ts` › 目录常驻判据组（容器足够宽⇒常驻 / 偏窄⇒收起 / 用户显式收起⇒偏好优先） |
| 2 | 同视口下响应容器变化 | CDP 5.1 `c-*-dir-wider.png`：**视口不变（1440）、目录 203→320**，Monaco 文字区 **429→400** ⇒ 吃的是容器实测宽；`file-layout.test.ts` ›「**同容器宽下改目录宽**会改变结论——证明吃的是容器工况而非窗口」「容器偏窄 ⇒ 自动收起目录（正文优先，不把正文挤成窄条）」；`use-file-layout.ts` 走 `ResizeObserver` 测**文件容器**（静态渲染回落 1280 供组件测试断言分支） |
| 3 | 极窄与放大后仍可阅读 | CDP 5.2 **54/54 checks** 之 `zoom2` 13/13 / `800-narrow` 12/12 / `640-single` 12/12：三档目录一律收起、diff 强制 inline、正文占满主区（451–639px）、字号不缩（13px）、无整页横向滚动；zoom2 为**真 zoom**（主进程 `setZoomFactor=2`，CSS 视口精确减半 605、DPR 2.1→**4.2**）（`a-zoom2-narrow.png`、`a-800-narrow-narrow.png`、`a-640-single-narrow.png`）；`file-layout.test.ts` › 窄档门用例（含 800/640/610 ⇒ 收起、801 过渡带按几何）；`INLINE_MIN_TEXT=480`、`NARROW_TIER_MAX=800` 常量末动（语境收窄，不是降标准） |
| 4 | 手动布局偏好不被自动折叠覆盖 | CDP 5.2 `prefs` 5/5 → `prefs-narrow` 4/4 → `prefs-restore` 3/3（**须同页面会话按序执行**，zustand 内存态）：用户调宽 280 + 显式收起 → 缩到 800 档安全降级 → 回到 1207 宽档后**显式收起保持收起**、手动展开后**宽度精确复原 280**（≠默认 232）（`b-prefs-*.png`）；`file-layout.test.ts` ›「用户显式收起 ⇒ 即使很宽也不常驻（偏好优先）」「`preserveFilePrefs` 返回原对象（任何把可见性存回偏好的写法都是错的）」；`file-two-side-read.test.ts` ›「U2 4.1 接线契约：目录宽可调整（拖拽 + 键盘）」 |

### 5. 文件阅读工具操作完整原文且保持只读（4，**A**）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 复制路径原文及元信息 | `file-tools.test.ts` ›「`copyableText` 只对 text 给全文；不可读侧返回 null（**绝不返回空串冒充**）」「`copyableMeta` 对 binary/missing/corrupt 给真实大小与哈希」「`copyableMeta` 不用于 not_found/rejected（没有真实大小可谈）」「无路径 ⇒ 路径复制禁」；CDP 5.4 `tools-copy` 9/9：元信息复制为**真实大小 + 完整 64 位哈希**、不可用侧复制点了**也不写剪贴板**（仍哨兵）、剪贴板失败就近提示（`tools-copy-1|2|3|4.png`）；`file-two-side-read.test.ts` ›「U2 第4组 容器布局与阅读工具」（工具栏能力断言） |
| 2 | 查找换行和差异定位使用当前文件 | `file-tools.test.ts` ›「两 ready + 可比较 + 并排 ⇒ 全部工具可用（差异导航开启）」「inline 模式下差异导航禁用（没有并排真实 diff 可导航）」；CDP 5.4 `tools-find` 9/9：`版本`/`长文本样本` 查找 `.matchesCount="1 of 1"`、`alpha` 为 `"No results"`，**切到另一文件后查找作用当前文件**、换行开关翻转、切到 0 差异文件后（`lineChangeCount=0`）导航诚实禁用（`tools-find-1…5.png`）；`file-two-side-read.test.ts` ›「U2 4.5 接线契约：差异导航与查找必须接线」（`goToDiff`/`onDidUpdateDiff`/`getLineChanges()` 真实 `diffCount`/`actions.find`） |
| 3 | 不可比较或未就绪时工具诚实禁用 | `file-tools.test.ts` ›「**只有一侧 ready + 单侧只读视图就绪** ⇒ 该侧可复制/查找/换行，另一侧禁、差异导航禁」「一侧 ready 但**编辑器根本没就绪** ⇒ 查找/换行仍诚实禁用（不空转）」「**没有差异**（diffCount=0）⇒ 不假跳转」「inline 下差异导航禁」；CDP 5.4 单侧可读时 monaco **真模型** `readOnly=true`、`.monaco-diff-editor=false` 且 `[data-testid="single-side-editor"]=true`，不可用侧逐条对称禁用；5.5 `readonly` 12/12（浏览全程只读 + 重试仅重发只读 IPC） |
| 4 | 文件阅读键盘操作与离线加载 | CDP 5.6 `keyboard-offline` 10/10：资源 host **只有 localhost**（外部 host 0，monaco/css/worker 相关 172 项）⇒ Monaco 本地懒加载；`offline=true` 下仍渲染 diff 编辑器（`keyboard-offline-1-离线文件页.png`）；键盘逐项实测——列表 `Home/End/ArrowUp` 选中且焦点跟随、检查点 Enter 激活、搜索键入 `edit` 筛到 1 项且退格清空恢复、目录宽分隔条 `ArrowRight` 232→248、工具栏「换行」Enter 翻转、查找 Esc 关闭且**焦点回编辑器**（探针证实落点 Monaco `native-edit-context`）；CDP 5.2 `offline` 5/5（`c-offline-offline.png`）；`file-two-side-read.test.ts` ›「U2 4.6 接线契约：文件列表键盘导航与焦点」（roving tabindex + `role="listbox"/"option"` + 焦点交回）；**构建侧**（6.2）：`electron-vite build` EXIT=0、入口 chunk `index-BVAF5aNj.js` 对 `monaco-editor`/`@monaco-editor/react`/`echarts` 引用数**均为 0**、workers 审计 ok（editor+json 齐、无 ts/css/html） |

### 6. 文件两侧读取状态真实且旧响应不覆盖新选择（6，**A**）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 新增文件与零字节文件不混同 | `workspace-files.test.ts` ›「一侧是新增（初始不存在）→ 该侧为 null 而非空串」「一侧是缺失 → 该侧为 null（缺失不被当成空文本）」「U2 3.3：每侧带**缺席成因**（text / not_found / unavailable / unread 四态可分）」；`file-tools.test.ts` ›「`sideReadiness`：text ⇒ ready；**空串也是合法空文件**（ready，不是 empty）」；`u2-file-fixtures.test.ts` › 断言③「新增文件与零字节文件不混同」 |
| 2 | 不可用侧不伪装为空差异 | `workspace-files.test.ts` › `canEnterTextDiff` 组（「只有『两侧 text』或『初始经校验 not_found + 所选 text』才进 diff」「所选 `not_found` + 初始 text ⇒ **不可进**（不对称，变异 E 验证：放宽成对称即失败）」）；`file-two-side-read.test.ts` ›「U2 3.2 两侧独立状态（能力断言）」整组（初始侧通道失败 ⇒ 明说「读取失败（不是不存在）」且不置空侧参与 diff；一侧不可比较、另一侧真实文本 ⇒ 不进 diff 并标出该侧具体成因；追加：初始经校验 `not_found` + 所选 text ⇒ **进** diff 且保留不存在标识）；CDP 5.4 `sides` 9/9 且**左右互换逐条对称**（`sides-A1-所选可读初始不可用.png`、`sides-B1-所选不可用初始可读.png`） |
| 3 | 两侧都不可读时没有伪空编辑器 | `file-two-side-read.test.ts` ›「**两侧都不可读** ⇒ 明说两侧各自状态，不渲染编辑器、不宣称无变化」「两侧都**未读取完成** ⇒ 显示读取中，不渲染伪空编辑器」「**旧粗暴分支必须消失**：不得出现『两侧都没有内容 ⇒ 不渲染编辑器』的合并判据」（反向断言）；`u2-file-fixtures.test.ts` › 断言④「两侧都不可读时没有伪空编辑器」；`workspace-files.test.ts` ›「两侧都缺席 → `hasContent` 为 false（界面据此不进编辑器）」；CDP 5.4 `both-unreadable` 5/5（`both-unreadable-1-两侧都二进制.png`） |
| 4 | 快速切换不串清单正文错误和加载 | `reading-request-guard.test.ts` ›「延迟 promise 时序：快速切换不串清单/正文/错误/加载」整组（慢 A 的成功迟到**不覆盖**已切到的 B 的成功；慢 A 的**失败**迟到**不会**把已成功的 B 打成错误；同一对象连续重试只有最后一个请求生效）；`file-two-side-read.test.ts` ›「U2 3.1 接线契约：代次守卫，不退回 `cancelled` 布尔」（清单与两侧都用 `settleList`/`settleSide` 收口、每个请求面都过收口、**不得**绕过守卫直接 `setXxxState({kind:"ok"})`、**旧的 `cancelled` 布尔必须消失**、`FileContent` 不得自己拉初始侧、两侧读取互不为前置条件）；`reading-request-guard.test.ts` ›「侧状态查询：失败不冒充结果，加载不冒充 idle」「旧请求 finally 不该把它抹掉」；CDP 5.4 `race-retry` 12/12 之①③④（`race-retry-1-快速切换后迟到响应到达.png`、`-3-卸载后迟到响应.png`、`-4-读取失败.png`），由**真 IPC 包装层日志**立证"迟到哨兵未串入新文件、最旧 A 迟到后仍为真实文本、卸载场景延迟 6000ms 落在切页之后" |
| 5 | 同对象重试与往返有请求代次 | `reading-request-guard.test.ts` › `RequestGuard` 组（「每次 begin 都递增代次（**同 key 也不例外**）」「**同对象重试**：旧 token 不再被接受（不能因 key 相同就承认旧结果）」「**A→B→A 往返**：回到 A 后第一次 A 的迟到响应被拒，第二次 A 的才生效」「`invalidate` 后所有在飞 token 一律不接受」）+ `settle*` 组（「**旧代次的成功也被拒**：返回 null 而不是写旧结果」「**旧代次的失败也被拒**：不能把旧错误扣到新选择上」「旧代次的异常同样被拒」）；CDP 5.4 `race-retry` 12/12 之②（`race-retry-2-往返后最旧A迟到.png`：往返后 `path=steady.txt ckpt=s_05` 一致；真 IPC 日志立证"往返只认最新代次"） |
| 6 | 阅读重试只读且重新校验 | `file-two-side-read.test.ts` ›「U2 3.3 清单/内容独立重试（能力断言）」整组（清单失败 ⇒ 渲染「重新读取清单」；所选侧失败 ⇒ 渲染「重新读取该文件」；两侧各自独立的重试入口互不牵连；未失败时不渲染）+「**不得有任何写入通道**（阅读重试只读）：无 readFile 之外的 IPC、无 write/import/apply 调用」（源码级白名单断言）；`reading-request-guard.test.ts` › `settle*` 组；CDP 5.5 `readonly` 12/12：重试由**真 IPC 包装层日志**立证**真的重发**——`inspect occ1 fail → occ2 pass`、`read/selected/edit.txt occ1 fail → occ2 pass` 且随后显示**当前**校验结果（`readonly-3-清单失败.png`、`-4-内容失败.png`、`-5-内容重试成功.png`）；CDP 5.4 `race-retry-5-独立重试成功.png`（日志 23→24） |

---

## §布局证据（design D7 逐层记录）

> 每条给出**原生窗口外框（Win32 px）/ 应用 CSS 视口 / 文件容器宽 / 目录宽 / Monaco 两侧实际文字区 /
> zoomFactor / devicePixelRatio / 短句可读性 / 截图**。数据源为**真实 Electron CDP**（`MoveWindow` 改外框，
> **禁用** `Emulation.setDeviceMetricsOverride` —— 它会让 Monaco `automaticLayout` 产出 36px 伪影，几何不可信），
> 落 `.workbuddy/u2-5*/measurements.json`，**非原型**。CSS 视口用 `documentElement.clientWidth`。
> 本机真值：物理屏 2560×1600 @210% ⇒ CSS 桌面 1220×762、DPR 基线 **2.1**。

| 档 | 外框 (Win32) | CSS 视口 | 容器宽 | 目录宽(常驻) | 左 box/text | 右 box/text | 有效文字区 | 模式 | zoom | DPR | 短句可读 | 截图 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **640** | 912×950 | 641×629 | 641 | 0 (N) | 36 / 228 | 527 / **480** | **480** | inline | 1.0 | 2.1 | 是（13px） | `u2-51/a-640-files-monaco.png` |
| **800** | 1134×1050 | 800×701 | 800 | 200 (Y) | 36 / 228 | 481 / **435** | **435** | inline | 1.0 | 2.1 | 是 | `u2-51/a-800-files-monaco.png` |
| **1024** | 1446×1180 | 1023×794 | 1023 | 200 (Y) | 36 / 228 | 705 / **658** | **658** | inline | 1.0 | 2.1 | 是 | `u2-51/a-1024-files-monaco.png` |
| **1210** | 1704×1240 | 1212×837 | 1212 | 200 (Y) | 464 / **400** | 466 / **419** | 419 | **sideBySide** | 1.0 | 2.1 | 是 | `u2-51/a-1210-files-monaco.png` |
| **1360** | 1918×1300 | 1361×879 | 1097 | 200 (Y) | 407 / **343** | 408 / **361** | 361 | **sideBySide** | 1.0 | 2.1 | 是 | `u2-51/a-1360-files-monaco.png` |
| **1440** | 2030×1310 | 1441×887 | 1177 | 200 (Y) | 447 / **383** | 448 / **401** | 401 | **sideBySide** | 1.0 | 2.1 | 是 | `u2-51/a-1440-files-monaco.png` |
| **zoom2** | （同 1210 档窗口） | **605×356** | 605 | 收起 | — | **451** | 451 | inline（强制） | **2.0** | **4.2** | 是（13px） | `u2-52/a-zoom2-narrow.png` |
| **prefs 三段** | 同 1210 档 | 1207 → 800 → 1207 | — | 常驻 → 收起(降级) → **仍收起★** | — | 416 / 639 / **1046** | — | sideBySide → inline → inline | 1.0 | 2.1 | 是 | `u2-52/b-prefs-*.png` |

- **1360/1440 档"容器宽 < 视口宽"** 是因这两档落在 wide 断点、左侧运行导航常驻；medium 档在文件页会临时收起导航，
  故 1024/1210 容器宽≈视口宽。**这是 U1 既定布局行为，非缺陷。**
- **并排→inline 临界**落在 1210 与 1024 之间：按修好的 D4 判据 1024 档本应并排，实机 Monaco 却已回退 inline
  —— 这正是 5.1 **缺陷 1**（Monaco 内部 `renderSideBySideInlineBreakpoint:900` 覆盖外层）的暴露面，
  修复后由外层判据唯一裁决。
- **D4 阈值权威数字**来自 1.2 原型（真 Monaco 0.56 `getLayoutInfo().contentWidth`）：1440→429 / 1360→391 /
  1210→443 / 1024→354；`INLINE_MIN_TEXT=480` 的几何临界视口 = **960**（960→720 无一档达 480），
  故 800px 及以下定义为**窄档**（承认几何现实，非降低验收）。

**如实记录（未当产品门禁）**：

- **系统级原生 DPI（非 zoomFactor）未另设独立用例实测** —— 本机固定 210% 缩放 + DPR 2.1，只测了应用内
  `zoomFactor=2`（DPR 4.2）。原生目录/新建对话框的打开器差异亦未纳入布局证据。
- 5.1 期间曾记录「物理 1707×1067 @141%」，后被判定为 **DPI-unaware PowerShell 的虚拟化假象**（系数 1.5），
  已在 `apps/desktop/scripts/lib/u2-cdp-util.cjs` 头注更正。
- **文档漂移已修**（任务 6.3 复核对齐）：5.2 的 README 与 `tasks.md` 5.2 曾写「1440/1360 档本机物理不可达
  （与 5.1 结论一致）」——**该说法与 5.1 的最终结论相反**。5.1 §2 已实测推翻：窗口外框可超出屏幕物理边界，
  加 `SW_RESTORE` 复原窗口后 **D7 六档全部可达**（矩阵实测 1441 / 1361 CSS 视口，各 12/12）；先前的
  1221px 假上限源于窗口处于**最大化**被屏幕裁剪。两处旧表述已就地加更正说明，未静默改写。

---

## D7 三条竞态场景**分别举证**（不得互相替代）

任务 6.3 与 design D7 明写：这三条**作用域不同**，须各自链接到自己的断言，**不能用 U1 的详情竞态证据
代替 U2 的文件竞态验收**。

| 场景 | 归属 / 验证对象 | 本场景自己的断言 | 实机 |
| --- | --- | --- | --- |
| 快速切换及同运行重试不串响应 | **U1**「会话内按运行恢复阅读位置」（ADDED）· 对象 = **run 详情请求 `getRun`** | `detail-request.test.ts` ›「A 的慢响应后到 ⇒ 不覆盖已选中的 B」「A 的迟到成功不把 B 的 `loadingDetail` 清掉」「A 的失败在切 B 后到达 ⇒ 不写 error」「同 run 重试：再重读不被打断」「同 run 连续两次，先发旧响应后到 ⇒ 被丢弃」「非法详情切走后到达 ⇒ 既不落地也不报错」 | CDP `u1-73-cdp` `rapid-switch`（截图 `docs/reviews/2026-09-22-u1-73/d1-rapid-switch-final.png`） |
| 快速切换不串清单正文错误和加载 | **U2** · 对象 = **清单 `inspectWorkspace` + 两侧 `readWorkspaceFile`** | `reading-request-guard.test.ts` ›「延迟 promise 时序：快速切换不串清单/正文/错误/加载」**3 条**（慢 A 成功迟到不覆盖 B 的成功 / 慢 A 失败迟到不把 B 打成错误 / 同对象连续重试只最后一个生效）+「侧状态查询：失败不冒充结果，加载不冒充 idle」；**接线契约**（源码级）：`file-two-side-read.test.ts` ›「U2 3.1 接线契约：代次守卫，不退回 `cancelled` 布尔」「**旧的 `cancelled` 布尔必须消失**」「每个请求面都过 `settle` 收口，不得绕过」 | CDP 5.4 `race-retry` 12/12 之 ①③④：`race-retry-1-快速切换后迟到响应到达.png`、`race-retry-3-卸载后迟到响应.png`、`race-retry-4-读取失败.png`；**由真 IPC 包装层日志立证**"迟到哨兵未串入新文件" |
| 同对象重试与往返有请求代次 | **U2** · 对象 = **同 key（run/step/path/side）的重复与 A→B→A 往返** | `reading-request-guard.test.ts` ›「每次 `begin` 都递增代次（**同 key 也不例外**）」「**同对象重试**：旧 token 不再被接受」「**A→B→A 往返**：第一次 A 的迟到响应被拒，第二次 A 的才生效」「`invalidate` 后所有在飞 token 一律不接受」「**旧代次的成功也被拒**」「**旧代次的失败也被拒**」 | CDP 5.4 `race-retry` 12/12 之②：`race-retry-2-往返后最旧A迟到.png`（往返后 `path=steady.txt ckpt=s_05` 一致） |

> **为何不能互相替代**：U1 那条打的是 `store` 的**详情请求**代次（`getRun`），走的守卫在
> `detail-request` 路径；U2 两条打的是 `WorkspaceFileView` 连接层的**三个独立守卫**（清单 / 初始侧 / 所选侧）
> 与 `RequestGuard` 纯逻辑。**同一个 `cancelled` 布尔在 U1 已修，仍不足以覆盖 U2** —— U2 的根因正是
> "旧写法只能挡卸载后的迟到响应，挡不住同对象重试与 A→B→A"（U2 3.1 记录）。三条各自有独立断言与独立实机证据。

---

## 迁出项 / 后续段义务（U2 不交付）

| 归属 | 不交付事项 | U2 现状（证据） |
| --- | --- | --- |
| **<960px 档运行列表可达性 → U1 范围** | medium/narrow 档切换 run 须先回「概览」（`navOpened`/`setNavOpened` **无 UI 调用方** ⇒ 窄档运行列表不可达） | 5.3 实机**撞到并如实记录**（未改）：跨运行场景只在 ≥960 档执行；U2 未新增导航入口，也**不**据此宣称窄档跨运行通过 |
| **R2.1 结果导出 / R2.2+** | 文件正文导出、结果导出 | 文件页只有只读阅读与复制（`copyableText`/`copyableMeta`），**无导出/落盘入口**（§5-1、§1-4 只读断言） |
| **R3 单环境测试** | 与文件阅读无关 | 未触碰 |
| **U3** `preserve-debugging-drafts` | 编辑草稿保留、离开保护、修订号 | 文件阅读**不**保存草稿/正文/授权（`file-reading-state.test.ts` ›「字段集合收敛：只含阅读意图与位置，不含正文/草稿/授权/物理路径」） |
| **U4/U5** 执行登记与统一执行工作流 | 创建/执行侧能力 | 文件页**零写入通道**（§6-6 白名单断言）；5.6 `compat` 5/5 证明既有执行入口仍可达、未被本 change 改动 |
| **U6** `add-partial-run-reading` | 缺父链部分读取 | 仍**显式报错**、不提供假降级（U1 已定；U2 未触碰详情错误路径） |
| **U7** `improve-branch-comparison` | 树节点布局/聚焦、双运行输出比较 | 文件页只做**同一 run 的初始 vs 自有步骤**比较，**绝无**跨运行文件 diff（D5 明文）；`workspace-files.test.ts` 只接受本 run 清单 |
| **U8+** | — | 本 change 未宣称任何 U3–U8 能力通过 |

## 已知限制 / 未验证项（总结）

1. **列表滚动的实机证据力弱**：「文件页签往返恢复阅读」的**正文**滚动锚点是实机强证据（5.3 真滚轮 1→8 往返保持），
   但**列表**滚动那一项在 5.3 当轮夹具里清单只可滚 2px，无法构成有效证据 ⇒ 改由
   `file-view-scroll-wiring.test.ts`「滚动位置真的会被**恢复**，不只是保存」+ 变异 M4 立证（已在 5.3 与 README 如实标注）。
   **未做**：另造"长清单"夹具再实机测列表滚动。
2. **1.1 生成器留下的坏标本未修**（5.5 已登记）：`.rebaseagent/u2-file-fixtures/`（由 `gen-u2-file-fixtures.cjs` 生成）
   的「无自有完成步骤」标本把 `fork.at_span` 与 `resume_after_step` 设成同一个 `agent.step` id，
   而 `trace-sdk` 的 `resolveBranch` 硬校验前者必须是该轮内工具调用 ⇒ **该标本经运行列表读取必被拒**。
   `u2-file-fixtures.test.ts` 只在该文件上 `readRun`，故未暴露；5.5 / 5.6 各自的生成器已按正确形态另建标本
   （5.5 的自检显式调用 `resolveBranch`）。**影响**：仅影响该 gitignored 夹具的可复用性，不影响产品；
   「无自有完成步骤时选择初始」场景由 5.5 的正确标本 + CDP 截图承载（§2-2）。
3. **系统级原生 DPI（非应用内 zoomFactor）未独立实测**；原生目录/新建对话框差异未纳入布局证据（§布局证据末段）。
4. **本索引不含发行打包证据**：6.2 明确"不安排发行打包"；`release:verify` 的产物名/体积/身份三项**未在本 change 内执行**
   （但**资源门禁已在 6.2 以源码审计 + 产物审计先行覆盖**，并因此抓出并修复了 monaco 包根类型导入）。

## 归档状态与边界（如实表述）

- **U1 `refactor-run-workspace`：已完成并已归档**（`openspec/changes/archive/2026-09-23-refactor-run-workspace/`，
  归档提交 `4628b80`）。
  ⚠️ **任务 6.3 原文写"确认 U1 完成未归档"，与现状不符** —— U1 是 2026-09-23 归档的，本 change 的 tasks.md
  第 3 行仍写"本次不归档 U1"，同属过时表述。**按现状记录：U1 已归档，其 delta 已落入主 spec。**
  这带来一个**必须知悉的后果**：`openspec/specs/desktop-ui/spec.md` 里「文件检查点和差异只读可查」
  **仍是 C 版正文**（"提交和导航控件"措辞未改），U2 归档那一刻才会被本 delta 的 MODIFIED 块整体替换。
  故**本 change 归档前，主 spec 不能当"U2 现状"读**——判现状只认 `src/` + 本 delta。
- **U2 验收状态**：任务 **1.1–1.2 / 2.1–2.4 / 3.1–3.5 / 4.1–4.6 / 5.1–5.6 / 6.1–6.3 全部完成**；
  质量门禁 6.1/6.2 全绿（desktop **66 文件 / 1296 用例 / 0 失败 / 0 跳过**；replay 12 条失败已逐条归因沙箱环境）。
  **本索引不构成放行**：U2 归档由 owner 拍板（"不自动归档"）。
- **U3–U8 边界**：见上「迁出项 / 后续段义务」。本 change **不宣称**任何 U3–U8 能力通过；文件页仍严格限于
  **同一 run 的初始 vs 自有步骤**的只读阅读。

## 质量门禁（任务 6.1 / 6.2 结论，供本索引引用）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 依赖包构建 | `pnpm check:build` | EXIT=0，5/5 包（build 先于 test） |
| 类型检查 | `pnpm check:typecheck` | EXIT=0，零诊断 |
| desktop 全量 | `vitest run --testTimeout=30000` | **66 文件 / 1296 passed / 0 failed / 0 skipped / 无 `Errors` 行**（EXIT=0） |
| replay 读取链 | `cd packages/replay && vitest run --testTimeout=30000` | 392 用例 / 380 通过；**12 条失败全为沙箱环境故障**（9 `model-ab-cli` spawn `EBUSY` + 3 `workspace-import-source` symlink 探针被沙箱伪造骗过），U2 全程未改 `packages/` |
| lint | `biome check .` | EXIT=0，`Checked 326 files` |
| OpenSpec 全量严格校验 | `validate --all --strict` | EXIT=0，`Totals: 13 passed, 0 failed` |
| desktop build + 离线/懒加载回归 | `electron-vite.CMD build` + `release-check.mjs` 审计 | EXIT=0；workers `ok`（editor+json，无 ts/css/html）；入口 chunk 对 monaco/echarts 引用 **0**；**并抓出并修复 1 处会阻塞 `release:verify` 的真实缺陷**（monaco 包根类型导入，修复 `ecd54da`） |

**读法提醒**：本索引**不是**发行凭据。体积/产物名/身份三项发行门禁**未在本 change 执行**（6.2 不安排发行打包）。
