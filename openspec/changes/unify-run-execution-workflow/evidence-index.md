# U5 `unify-run-execution-workflow` 场景 → 证据索引

> **当前状态（2026-09-28，任务 6.1 交付）**：本文件是 §6 的**场景清单**——每条 delta 场景都点名
> 「已有单元/契约用例」与「实机入口（批次 + 计划 tag + 所依赖的剧本/注入）」。
> **它不是验收放行凭据**：`待实机` 行的实机读数要到 6.2–6.8 逐批补，`§7.3` 才把"计划"换成"实测 n/m"。
> 回查脚本：`.workbuddy/u5/u5-61/verify-scenario-checklist.cjs`（六项判据 + `--selftest` 反证）；
> 用例名池：`.workbuddy/u5/u5-61/case-inventory.json`（172 文件 / 2597 条 `it` 标题）。

汇总口径：**74 条场景（41 ADDED / 33 MODIFIED）**，单元或契约证据已交付 **66** 条、待实机 **7** 条、实机不成立 **1** 条（6.2–6.8 六批实测后；剩余 7 条按层引用或归 §7.1 回归 / §7.3 逐条核对）

## 怎么读这张表

- **小节头** `### A1. <requirement 名>（ADDED，N 场景）`：名称与顺序 = `specs/desktop-ui/spec.md` 逐字。
- **场景行**共五列：`# / scenario（逐字） / 已有单元或契约证据 / 实机入口 / 现状`。
  证据一律写成 `` `测试文件 › it 标题逐字` ``——脚本按"该标题确实出现在**那个文件**里"回查，
  不认行号、不认 describe 拼接、不认"我大概记得是这么写的"。
- **实机入口**只允许 `—`（这条不依赖实机）或 `6.2–6.8 / 7.1` 的批次；写 `计划 tag` 表示该 tag 尚未跑。
  依赖的受控剧本写 `剧本=ID`、依赖的只读注入写 `注入=kind`，两者由脚本对着本轮两个 lib 文件回查存在性。
- **现状**三态互斥：`单元已交付`（这条不需要实机读数）/ `待实机`（单元侧判据已在，6.x 欠一次真机观察）/
  `实机不成立`（真机没有那个注入面，只能按层引用，且**给出为什么**）。
- ⚠️ **「部分覆盖」不在本表里打折**：一条场景只要实机半边还没跑，就整行记 `待实机`；
  §7.3 逐条核对时按"单元 + 实机两面齐"才计覆盖（design §Validation Strategy 对
  「普通结果与隔离结果确认边界不同」明写要 4.4/4.5 两侧证据，缺一侧只算部分）。

## 6.1 的两套原语（后续批次只引用，不再各批自造）

### 受控 SSE 剧本目录 `apps/desktop/scripts/lib/u5-sse-fixtures.cjs`

期望调用数与期望**自有终止事件**绑在剧本上，实机 tag 引用 `剧本=ID`；目录本身由
`test/controlled-sse-fixtures.test.ts`（11 条）在 127.0.0.1 受控服务上真跑一遍对上号。

| 剧本 id | 期望调用数 | 期望自有终止事件 | 立证的场景侧 |
| --- | --- | --- | --- |
| `successPlain` | 1 | stopped / completed | 正常结束才清理、留在流程可进概览、新建 run 成功 |
| `fail503` | 1（不重试） | errored / error，`llm.call.error.status=503` | 成功信封但运行错误、执行失败不产生半成品 |
| `delayedInFlight` | 1 | stopped / completed | 一切"在飞窗口"观察：离页、读取途中导航、卸载不换关联 |
| `budgetExceeded` | 1 | stopped / budget_exceeded | 限制类结局不算正常结束 |
| `maxIterations` | 10（= main 硬编码上限） | stopped / max_iterations | 同上，且次数是数出来的 |
| `notConsumed` | 0 | —（不该被执行） | 门禁拒绝类：一旦被消费就同时留下计数增量与 HTTP 418 |

- ⚠️ 上限类结局**不需要开隔离模式**：未知工具的失败是数据（`tool-registry.ts:33-39`），循环照旧继续；
  额度常量与 `run-create.ts:75-76` 同值，漂移由用例判红（不靠人记）。
- ⚠️ 中止（aborted）与"未识别 reason 的详情显示"**都不在这套剧本的能力范围内**：
  前者需要取消通道（U5 非目标），后者被 `RunEventSchema` 的枚举先拒 ⇒ 两条都在下表标 `实机不成立`。

### 只读失败注入 `apps/desktop/scripts/lib/u5-read-faults.cjs`

六种注入（施加 → 还原 → **逐字节指纹核验**，还原失败落 `RESTORE-NEEDED.txt`），
实际失败形状由 `test/controlled-read-faults.test.ts`（10 条）对着真 `RunRepository` 数出来：

| 注入 kind | 数出来的形状（不是我以为的形状） |
| --- | --- |
| `fileMissing` | 详情抛错；列表**既不含该 run 也不报 failed**（文件不在盘上） |
| `corruptTail` | 详情抛错；列表把它放进 `failed` 而**不拖垮整表** |
| `unsupportedVersion` | 版本守卫先于 schema ⇒ 详情与列表条目一起判不可读 |
| `unknownTerminalReason` | 详情被 schema 拒 ⇒ **落进"不可读"，落不进"结束原因未知"的显示** |
| `noTerminalEvent` | 读得出来但 `status=crashed` ⇒ 展示为"运行中断"（不是正常结束） |
| `tracesDirGone` | 列表与详情**同时**失败 ⇒ 见下方分层结论 |

### 🔴 6.1 坐实的两条分层结论（写下来，免得 6.6 又去追一个不存在的注入面）

1. **「列表刷新失败但详情可读」在真机没有 fs 注入面**：`RunRepository.listRuns` 与 `getRun`
   同源于一个目录，目录级故障两面一起倒；文件级故障则列表照常用 `failed` 隔离。
   ⇒ 场景「列表失败不阻断已知结果」记 `实机不成立`，只由 §1 的 store 用例承载
   （`result-verification-store.test.ts` 两支 + `operation-result-consumption.test.ts` 一支）。
2. **「篡改 status 载荷 / 丢弃执行响应 / 非法 reason 的未知显示」三类注入面不存在**：
   桥接面 `window.api` 属性 `writable:false / configurable:false`（U4 6.5 实测）+
   `RunEventSchema.reason` 是枚举（`schema.ts:379`）⇒ 相关半边一律按层引用，不得写成实机已测。

## 6.1 采集口径登记（版本与数据目录）

| 项 | 值 |
| --- | --- |
| 仓库 HEAD（6.1b 落地时） | `14bbd37`（6.1a `727e0c5`） |
| 分支 / 远程状态 | `main`；push 由 owner 执行（本仓库无 `origin`，远程名 `github` / `gitee`） |
| desktop 包版本 | `0.3.0-k1`（**未打 tag、未进任何发行包**） |
| Electron / Node | `44.1.1` / `v24.19.0` |
| 测试与检查 | vitest `^2.1.0`（单文件跑，判绿用 `--testTimeout=30000` 口径）、biome `1.9.4` |
| 受控服务与两套原语的 sha256（前 12 位） | `mock-llm-server.cjs` `01eb77a0aab8`、`u5-sse-fixtures.cjs` `75aaea6349c2`、`u5-read-faults.cjs` `39834ac795ec` |
| 数据目录 | dev 恒为 `<仓库根>/.rebaseagent`；trace 目录 `.rebaseagent/traces`（登记时 208 个 `.jsonl`） |
| 夹具基线 | U3/U4 留存的 `normalRun=run_mughwjk4` / `isoRoot=run_mughyp60_txvlev` / `proxyRun=run_mughwwom_jlgs`（真引擎产出，仍在盘上） |

⚠️ 6.2 起每批 `run-all.cjs` 必须在自己的 measurements 里落同一份字段（HEAD、Electron、剧本/注入 sha、
数据目录与 traces 计数）——"版本记录"不是这份索引的一句话，是每批各带一份的读数。

### 6.2 采集口径登记（第一批受控实机，2026-09-28）

| 项 | 值 |
| --- | --- |
| 批量驱动 | `.workbuddy/u5/u5-62/run-all.cjs`（18 tag 串跑，`汇总：18/18 通过`；settings 备份/无条件还原） |
| 采集脚本 | `apps/desktop/scripts/u5-62-cdp.cjs`（每个 tag 的 measurements JSON 各带 HEAD / Electron / 三 lib sha 前 12 位 / traces 计数） |
| 仓库 HEAD | `d164251`（= 6.1 四提交 squash 后的唯一提交） |
| Electron / Node | `44.1.1` / `v22.22.2` |
| 数据目录 | dev 恒为 `<仓库根>/.rebaseagent`；`.rebaseagent/traces` 计数 208 → 218（批内自清理按 task 含 "U5-62" 认） |
| 源目录夹具 | `.workbuddy/u5/u5-62/src-fixture`（`REBASEAGENT_SMOKE_PICK_DIR` 注入；逐文件 sha256 前后差集为空） |
| 截图 | `docs/reviews/2026-09-28-u5-62/` |

🔴 **6.2 首跑抓到的两个实机事实（都写回代码/索引，不是只记账）**：

1. **五个入口的执行确认按钮"落库不刷新"（真产品缺陷，已修）**：容器只订阅了
   `executionConfirmationReady` 的**函数引用**，`armExecutionConfirmation` 落库后不触发重渲染
   ⇒ 确认按钮永远停在未确认态（确认在 store 里已挂上、修订/快照/stamp 全对）。修 =
   `confirmed` 一律在 `useAppStore` 选择器内现算（CreateRunWorkspace 1 处 + DetailPanel 4 处），
   并在 `execution-confirmation-store.test.ts` 加源码级接线契约（15/15）；desktop 全量
   132 文件 / 2223 用例绿（基线 2222 + 新契约 1 条）、tsc node/web 双 0、根 biome 0 错。
   这是「纯逻辑写好、接线少一支」家族的新形态：**这次少的是一条订阅**。
2. **`OperationRegistry.addDiagnostic` 当前零调用方** ⇒ main 侧没有任何产出诊断的路径，
   实机 diagnostics 恒为空。「可读诊断」的呈现面由单元用例承载
   （`operation-request-facts.test.ts` 喂 props），实机可证的半边 =「不泄漏输入」+
   登记如实（空就是空）。已登记为已知限制；要不要给失败路径接诊断产出归后续口径。

### 6.7 采集口径登记（第六批受控实机：设置 / 密钥 / 退出协商，2026-09-29）

| 项 | 值 |
| --- | --- |
| 批量驱动 | `.workbuddy/u5/u5-67/run-all.cjs`（10 tag 串跑，`汇总：10/10 通过`；dev 带 quit 哨兵钩子，settings 备份/无条件还原） |
| 采集脚本 | `apps/desktop/scripts/u5-67-cdp.cjs`（每个 tag 的 measurements JSON 各带 HEAD / Electron / 三 lib sha 前 12 位 / traces 计数） |
| 仓库 HEAD | `40287fb`（= 6.7 批内两个产品缺陷修复落地后；全量门禁与整跑同 HEAD） |
| Electron / Node | `44.1.1` / `v22.22.2` |
| 数据目录 | dev 恒为 `<仓库根>/.rebaseagent`；`.rebaseagent/traces` 计数 268 → 270（批内自清理按 task 含 "U5-67" 认） |
| 截图 | `docs/reviews/2026-09-29-u5-67/` |

🔴 **6.7 抓到并修复的两个真产品缺陷（都带反证，不是只记账）**：

1. **GlobalBar 的录制入口定位失效（修在 `d158523`）**：`GlobalBar.openRecording` 先
   `setSettingsSection("proxy")` 再调 `onOpenSettings`——而后者（App.openSettings）**又同步把
   section 清成 null** ⇒ "proxy" 标记在设置模态挂载前就被清掉，定位效果（滚到代理分区 +
   聚焦首控件）从不发生，实机焦点落在 ✕ 而不是代理复选框。「接线少一支」家族新形态：
   App.openRecording 本身写对了（空态入口在用），但全局栏这一跳没接它，单元层只钉了
   App 侧形状、GlobalBar → 开器这一跳没有判据。修 = GlobalBar 增 `onOpenRecording`
   专用 prop 直连不清 section 的开器；`settings-roundtrip-invalidate` / `run-workspace`
   两处源码级契约同步（`run-workspace` 旧断言改判为禁旧形状）。
2. **Chromium「两步关闭」穿透叠层模态（修在 `40287fb`）**：脏设置 + 确认框在上时，
   第二次 Esc 以 cancelable:false 派发给**底层设置**（顶层确认框反而收不到）⇒ 设置被原生
   关闭、未保存输入被静默丢弃——M6.2「Esc 只关闭最上层」被平台行为穿透。旧防御
   （keydown 捕获段只在 closeDisabled 时吞）只保得了第一次。修 = ModalDialog 最上层
   模态在 keydown 捕获段**合成** Esc 关闭（preventDefault 压掉原生 cancel 通道，第任意次
   都成立；非最上层放行给上层处理；closeDisabled 仍只吞不放）；`modal-dialog.test.ts`
   契约更新钉合成三件套与旧形状禁令。修复后实机逐层成立（第二层 Esc 只关确认、
   输入逐字保留、第三层可再次唤起）。

🔴 **6.7 坐实的实机事实（写进对应行，别再按旧注记跑）**：

- **「在飞 run 文件运行开始时就落盘」的旧注记不成立**：llm.call span 未 end 不落盘 ⇒
  在飞中被杀的 run **盘上零痕迹**（meta 都没写）。U4 6.7 的 `newFiles.length <= 1` 判据
  正是为这个形状定的口径，6.7 沿用；「不冒充停止」的硬判据 = 留下的那份（若在）无终态
  事件 + 历史逐字节不变 + 请求只出过一次门。
- **reread-failed 的真机注入面坐实**：main 的 `SettingsStore.load()` 每次读盘（无缓存）⇒
  「保存落盘瞬间改写 settings.json 缺 apiKey（load() 抛「内容不完整」）」的竞速注入可行，
  窗口毫秒级（两次实测分别第 3 / 第 2 次尝试得手），输了就按 tasks 6.7 预设口径回退
  单元承载——本轮两次整跑都得手 ⇒ 按**实机已测**登记，不再按单元承载。
- **save-failed 零注入诱发**：clearSettings 后空 apiKey 保存 ⇒ main 校验「apiKey 不能为空」
  拒绝，反馈带真实校验文案（不是笼统失败），输入逐字保留、settings 原样、磁盘零字节不写。
- **设置槽约束（configurationBusy）只随 main 快照进会话** ⇒ 在飞判据要先
  `refreshOperationStatus()`（等价用户打开操作面板）再读 `deriveConfigGate`，否则门禁读数
  停在旧快照（U4 6.7 同教训在设置层的复刻）。
- **store 的确认凭据在 `confirmations.byTargetKey`**（不是顶层键）——探针读 `Object.keys(
  s.confirmations)` 只会拿到容器名，首跑假红根因。

### 6.8 采集口径登记（第七批受控实机：代表宽度 / 200% / 真键盘 / 指纹 / live 区域，2026-09-29）

| 项 | 值 |
| --- | --- |
| 批量驱动 | `.workbuddy/u5/u5-68/run-all.cjs`（6 tag 两组串跑，`汇总：6/6 通过`；组 2 带 `REBASEAGENT_ZOOM_FACTOR=2`） |
| 采集脚本 | `apps/desktop/scripts/u5-68-cdp.cjs`（measurements 各带 HEAD / Electron / lib+ps1 sha 前 12 位 / traces 计数） |
| 仓库 HEAD | `4262ac5`（6.7 收口提交；本批零产品代码改动） |
| Electron / Node | `44.1.1` / `v22.22.2` |
| 数据目录 | dev 恒为 `<仓库根>/.rebaseagent`；`.rebaseagent/traces` 计数 270 → 276 |
| 系统通道 | 改窗 `.workbuddy/ps-win.ps1`（SW_RESTORE + MoveWindow）；真键盘 `lib/u3-65-input.ps1`（keybd_event） |
| 截图 | `docs/reviews/2026-09-29-u5-68/` |

🔴 **6.8 坐实的实机事实与探针坑（写进对应行，别再按旧注记跑）**：

- **组间停 dev 必须「自记 pid + 异步 taskkill + 45s 真空出」**：u2-dev-host `--stop` 的内层
  spawnSync(taskkill) 在批进程树里可能 EBUSY 假成功，且它**先删 pid 文件**——旧 dev 还在监听时
  下一次 startDev 会撞上 "port already listening — assume dev running" 直接复用旧进程（首跑
  zoom200 判 DPR=2.1 的根因：跑在了组 1 的无缩放 dev 上）；且 Electron 整树退出实测可超过 20s
  （首跑 23s 预算内端口未空出、随后才空出）⇒ run-all 自己 spawn 时记住 dev host pid，
  **异步 spawn** taskkill 直杀（批内只有异步 spawn 全链可用）+ 45s 真空出预算。
- **zoom2 下外框→CSS 比例是 ×2.82（不是 zoom1 的 ×1.41）**：改窗收敛用**实测比例反解**
  （outer = target / (css/outer)），加法修正在高 DPR 下每轮只挪 1/2.82、不收敛；
  真 zoom 金标准仍是 DPR > 3.5。zoom 经 Preferences 的 per_host_zoom_levels 持久化且重启仍生效
  ⇒ run-all 对该文件做快照/还原（zoom 组放最后）。
- **窄档导航收起 ⇒ 选行走 store**：800px/200% 下运行列表整列收起、复制按钮不在 DOM
  ⇒ `H.selectRun`（按 DOM 行定位）必挂；改 `storeQ("await s.selectRun(id)")`（U4 6.8 同坑的
  第 N 次复发，判据读 store 不读 DOM）。
- **指纹判据的零写入基线必须取「注入前」**：fileMissing 注入期间目标文件被隐藏，拿注入中
  的快照当基线会把「还原」误判成「写入」（首跑假红根因）。
- **live 通知会被自动导航标已看**：markNoticesSeen 触发面 = 面板展开 + 明确打开结果（含创建
  落地后的自动导航）⇒ 要观测「未读通知更新」，创建提交后必须**立刻离页**（选中别的 run，
  代次 drop ⇒ 不导航），通知保持未读。
- **u3-65-input.ps1 的 RESULT 行写在 OutFile**（stdout 只有 "lines=N"，与 u3-64-winops 同构）
  ⇒ node 侧读文件并剥 BOM；`keys` 动作支持 TAB/SHIFT+TAB/ESC/ENTER 组合 token；本批全部
  真键盘判据只按键位导航（不打字母）⇒ imm/hkl 只记录不做 IME 组合断言。
- **6.7 的 Esc 合成修复在系统级真键盘下同样成立**（real-keyboard 复证）：真 Esc 关闭设置 +
  焦点恢复到全局栏触发入口。
- **改窗映射在窄档反向**（U2 旧知识再确认）：1024/800 档的面板断言全部按实测 CSS 宽度判，
  不按外框名义值；本批四档落点全部 ±1px 内。

### 7.1/7.2 门禁登记（2026-09-29）

**7.1 回归（点名文件复跑，全绿）**：
- 新建父本三条：`apps/desktop/test/plain-chat-regression.test.ts`（prompt fork / 模型 A/B /
  trace-test 卡带 + 配置漂移对照支）+ `run-create.test.ts`（落盘形状与执行路径）。
- 执行权限/配置锁：`exec-create-fork.test.ts`、`config-gate.test.ts`、`entry-gate.test.ts`。
- U1/U2/U3 阅读与草稿保护代表组：`workspace-file-view.test.ts`、`draft-closure-store.test.ts`、
  `draft-submission.test.ts`、`fork-editor-draft.test.ts`、`create-form-draft.test.ts`、
  `run-workspace.test.ts`。
- 读数：6 + 5 文件共 **180 用例全绿**（vitest `--pool=forks`，HEAD `4262ac5`）。

**7.2 全量门禁（HEAD `4262ac5`，本批零产品代码改动）**：

| 项 | 读数 |
| --- | --- |
| desktop 测试 | **132 文件 / 2225 用例 / 0 失败 / 无 `Errors` 行**（`--pool=forks --poolOptions.forks.singleFork`，见下方环境限制③） |
| desktop 类型检查 | `tsc -p tsconfig.node.json` 与 `-p tsconfig.web.json` **双 0 错** |
| desktop 构建 | `electron-vite build` ✓（main/preload/renderer 三段全过） |
| packages build | 5/5（`tsc -p tsconfig.json` 产 dist） |
| packages 逐包单跑 | agent-loop 49 ✓ / llm-proxy 18 ✓ / trace-sdk 191 ✓ / trace-test 77 ✓ / **replay 374 绿 + 1 skipped + 12 环境受阻**（见下） |
| 根 biome | 全仓 0 错 |
| OpenSpec | `validate --all --strict` **13 passed / 0 failed**；索引回查脚本六判据全过（74/74、208 引用） |

**环境限制（如实登记，非回归）**：
1. **replay 12 条环境受阻**（`git diff d164251..HEAD -- packages/` 为空 ⇒ 非回归硬证据）：
   - `model-ab-cli.test.ts` 9 条（dist 冒烟）：测试内部 `spawnSync` 起子进程 ⇒ 本环境
     **spawnSync 全链 EBUSY**（6.6 已登记的沙箱环境类，实测连系统 node/cmd 都一样，
     关沙箱与剥 NODE_OPTIONS 均无效）；build 产 dist 后用例正常挂载（不再 skip）。
   - `workspace-import-source.test.ts` 3 条（junction/symlink）：沙箱内 junction 创建行为
     与探针判定不一致——HANDOFF §六 已登记的测试基础设施欠账②（探针只查 existsSync），
     非 U5 场景遗漏。
2. **desktop 全量必须 `--poolOptions.forks.singleFork` 串行**：多 worker 并发下 vitest 的
   resolveConfig 会向共享 ssr 临时文件并发写 ⇒ WorkBuddy fs shim 介入后间歇 EPERM ⇒
   文件收集随机缺失（132→129~131 波动）+ `Errors` 行假红；singleFork 串行后恢复
   132/2225 干净读数。并行/串行差异属运行器环境，非测试差异。

---

## ADDED requirements

### A1. 执行前检查和确认保持各入口真实语义（ADDED，5 场景）

| # | scenario | 已有单元/契约证据 | 实机入口 | 现状 |
| --- | --- | --- | --- | --- |
| 1 | 创建和普通重跑只声明已完成的检查 | `execution-confirmation.test.ts › 纯对话创建：只有本地字段检查，并明说没有连通性预检`、`execution-confirmation.test.ts › 没有预检结论 ⇒ 不说做过只读检查，并指出缺的是哪一项`、`create-form-view.test.ts › 执行范围与计费事实就地可读，且随模式换内容` | 6.2 实测 tag `create-check` 6/6；6.3 实测 tag `result-check` 5/5（2026-09-28 实机） | 已交付（6.2 + 6.3 实测） |
| 2 | 普通结果与隔离结果确认边界不同 | `execution-confirmation.test.ts › 普通 result：说明不隔离与后续工具真副作用，不借用隔离话术`、`execution-confirmation.test.ts › 预检在场 ⇒ 直接父 / 轮号 / 整轮检查点进事实，只读预检才算「已做的检查」`、`execution-confirmation-store.test.ts › 隔离侧的确认按钮要求预检结论与本次授权都在场（无预检就不给确认）`、`execution-confirmation-store.test.ts › 两条 result 路径都把现场确认交给登记口（4.5 起隔离侧不再豁免）` | 6.3 实测 tag `result-plain-boundary` 4/4 + `result-isolated-boundary` 6/6（普通侧无隔离话术 / 隔离侧无「世界不隔离」互斥断言，预检不占槽零消费）（2026-09-28 实机） | 已交付（6.3 实测） |
| 3 | prompt 与 messages 不冒充续跑完整世界 | `execution-confirmation.test.ts › prompt：从头执行、不共享父前缀、一次只改一个启动字段`、`execution-confirmation.test.ts › messages：只重发这一个请求，不执行外部工具、不恢复其工作区`、`execution-confirmation-store.test.ts › prompt 与 messages 的资格原因就近显示（不是只把按钮禁掉）` | 6.4 实测 tag `prompt-confirm` 3/3（披露短语 lib 源码同源抽取全在场 + 确认可挂上，零消费）+ `messages-confirm` 5/5（不冒充续跑 + 肯定分支凭据事实「使用代理会话最近捕获的 key」在场，捕获转发恰 1 次零额外消费）（剧本=successPlain）（2026-09-28 实机） | 已交付（6.4 实测） |
| 4 | 实验确认使用当前预览计划 | `execution-confirmation-ab.test.ts › 披露喂的是 activePlan：属于旧修订的计划不进确认`、`execution-confirmation-ab.test.ts › 重新预览推进检查代次 ⇒ 那份确认作废，登记口当场拒绝`、`execution-confirmation.test.ts › 没有计划 ⇒ 已做的检查只到本地批次检查，不宣称跑过 dry-run`、`draft-closure-store.test.ts › dry-run 预览既不登记新关联也不读结果` | 6.5 实测 tag `ab-plan-confirm` 14/14（预览 ⇒ 计划区在场（实验组 ID）+ abDisclosure 静态短语 lib 同源抽取全在场（分支互斥字面量按前缀排除）+ 确认可挂上（绑定当前预览计划）；改臂 ⇒ 旧确认作废 + 执行按钮禁用；重新预览 ⇒ 新计划在场 + 确认可重新挂上；全程零消费零落盘）（剧本=successPlain 造父本）（2026-09-28 实机） | 已交付（6.5 实测） |
| 5 | 返回修改与设置往返撤销旧确认 | `execution-confirmation.test.ts › 改输入（修订推进）⇒ 旧确认作废：这就是「返回修改撤销旧确认」`、`execution-confirmation.test.ts › 检查代次推进 ⇒ 旧响应不能安装确认`、`execution-confirmation-store.test.ts › 换视图 / 进设置 / 常规打开设置 ⇒ 撤销待用的确认（离开现场）`、`settings-roundtrip-invalidate.test.ts › 设置往返改了配置 ⇒ config-stale，且**优先于**修订变化（先说打到哪变了）` | 6.3 实测 tag `confirm-return` 5/5（改输入 ⇒ 旧确认作废 + 重新确认恢复；result 编辑器确认文案 =「确认本次重跑」）（2026-09-28 实机）；6.7 实测 tag `settings-roundtrip-confirm` 6/6（确认挂上（store 恰一份凭据）→ 设置往返（非 dirty）⇒ 旧确认撤销 + 凭据出库（confirmations.byTargetKey 空）→ 重新确认可挂上，全程零消费）（2026-09-29 实机） | 已交付（6.3 + 6.7 实测） |

### A2. 跨页操作反馈展示真实等待与分层状态（ADDED，5 场景）

| # | scenario | 已有单元/契约证据 | 实机入口 | 现状 |
| --- | --- | --- | --- | --- |
| 1 | 执行中离页仍可查询等待 | `wait-timing.test.ts › running ∧ 本地提交时刻在场 ⇒ 自提交起，且明说不是模型耗时/进度`、`wait-timing.test.ts › OperationsEntry 只有一个时钟调用点，且受「面板开 ∧ 有可盯操作」约束；组件自己不动系统时间`、`operation-entry.test.ts › 挂在现有全局栏（不新开一处界面），数据源就是 operations 会话` | 6.2 实测 tag `in-flight-off-page` 12/12（2026-09-28 实机） | 已交付（6.2 实测） |
| 2 | 终态和重载后的计时不伪造 | `wait-timing.test.ts › settled ⇒ 时长定格在 settledAt：nowMs 再大也不增长，文本写死计时已停止`、`wait-timing.test.ts › 重载后只剩 main startedAt ⇒ 口径换成「自接受起」，不把接受冒充提交`、`wait-timing.test.ts › 提交时 pending 身份含有限 submittedAt；IPC 信封 operation 只有契约里的两键` | 6.6 实测 tag `reload-timing` 14/14（在飞 basis=submitted「自提交起已等待」+ 写明等待时长语义；收口与重载后均定格「计时已停止」且口径为 accepted——**终态行刻意按 main startedAt 定格**（operation-list.ts:205：pending 清账后 submittedAt 不再可用）；「重载后才换成 accepted」的 transition 半边真机不可观测（收口即清账）⇒ 按单元引用）（2026-09-29 实机） | 已交付（6.6 实测） |
| 3 | 关闭详情与退出不冒充停止 | `result-live-region.test.ts › 面板✕只关闭查看：没有任何登记清理、重发或「停止执行」类动作`、`focus-escape-responsive.test.ts › 面板走共享 useEscapeClose(open, closePanel)；✕ 与 Esc 同一关闭动作`、`preload-surface.test.ts › 本阶段不交付取消能力：桥接面没有 stop/cancel/abort 通道`、`draft-close-flow.test.ts › 明确退出不伪造取消：登记保持 running、槽不释放，flow 只放行窗口` | 6.7 实测 tag `quit-executing` 12/12（面板 ✕ 只关闭查看：面板退场、登记仍 running、槽仍指向它、重开面板操作仍在；哨兵 quit ⇒ 活跃操作档确认（「退出不会取消上游请求」措辞在场）⇒ 点退出窗口与进程真结束、在飞至多留一份未完成文件（**盘上常为零痕迹**——llm.call span 未 end 不落盘，见 6.7 登记节）、请求只出过一次门不重放）（剧本=delayedInFlight）（2026-09-29 实机）；6.8 实测 `live-region-a11y` 内面板 ✕ 关闭后焦点回到触发入口（triggerRef.focus()，2026-09-29 实机） | 已交付（6.7 + 6.8 实测） |
| 4 | 未知通信与新会话分开呈现 | `operation-session.test.ts › Unknown 只由下一次有效 status 清除；reconcile 只补事实、不解未知`、`operation-session.test.ts › 新 main 会话不伪造旧在飞身份的结局：保留为未知历史，但不锁住新会话`、`operation-session-store.test.ts › 通道抛错 ⇒ 未知锁且保留在飞身份；不自动重发，只有有效 status 才解锁` | 6.6 实测 tag `main-restart` 16/16（真 main 重启 kill=exit=0、9612 空出=1s 起来=5s 重连；**首帧「未握手」窗口被 2ms 采样器采到且禁用原因全为 not_handshaked**（不知握手而非未知）；新 epoch 全新、登记空、pending 空、resultReads 空、门禁开放；新会话真跑通；旧 opId 核对 ⇒ notAccepted 封禁；在场 run 文件逐份哈希不变）（2026-09-29 实机） | 已交付（6.6 实测） |
| 5 | 操作详情可读诊断但不泄漏输入 | `operation-request-facts.test.ts › 面板渲染出每条诊断的码/阶段/文案；操作摘要不含正文与 sourceToken 类字段`、`operation-request-facts.test.ts › 「rejected 不一律称为零调用」：拒绝行只报编排分类，「没有开始执行」只属于 notAccepted 侧`、`operation-request-facts.test.ts › 夹带未知字段的登记记录在 schema 层即非法：strict 契约是'不泄漏'的机器判据` | 6.2 实测 tag `diagnostics-readable` 6/6（🔴 diagnostics 恒空：main 的 addDiagnostic 零调用方，见「已知限制」）（2026-09-28 实机）；6.6 实测 tag `unlocated-reconcile` 9/9（核对未知 UUID ⇒ notAccepted 封禁（无目标/无时间）+ 读取项零结论 + 封禁不占槽 + 通知「未被主进程接受」+ 面板行无任何结果动作、对照 settled 行动作正常）（2026-09-29 实机） | 已交付（6.2 + 6.6 实测） |

### A3. 结果按可信运行身份核实且读取重试不执行（ADDED，9 场景）

| # | scenario | 已有单元/契约证据 | 实机入口 | 现状 |
| --- | --- | --- | --- | --- |
| 1 | 成功信封但运行错误 | `result-verification.test.ts › 成功信封但运行 error ⇒ 仍核实通过，但结局是失败且能定位真实自有调用`、`fork-entry-closure.test.ts › 「成功信封但运行错误」：按登记 ID 读出失败，草稿保留、进的是失败概览`、`terminal-facts.test.ts › u1-error-detail（自有 errored/error）⇒ 出错终止且定位到真实自有调用` | 6.3 实测 tag `envelope-ok-run-error` 10/10（信封 ok + 子 run errored/error + 503 + 失败概览导航 + 查看失败调用在场 + 草稿保留）（2026-09-28 实机） | 已交付（6.3 实测） |
| 2 | 失败信封仍可打开可信记录 | `result-verification-store.test.ts › 核实目标取自登记的 runIds，而不是列表项或当前选中项`、`operation-request-facts.test.ts › 「失败信封仍可打开可信记录」分层呈现：请求异常行与逐条动作互不覆盖`、`create-entry-closure.test.ts › 「失败信封仍可打开可信记录」的反面：登记没有 ID ⇒ 不解析文案、不扫列表` | 6.2 实测 tag `failed-envelope-open` 5/5（2026-09-28 实机） | 已交付（6.2 实测） |
| 3 | 封存限制中止和未知不等于正常结束 | `terminal-facts.test.ts › 达到迭代上限 / 超出预算（event=stopped 但 reason 是限制）⇒ 不算正常结束`、`terminal-facts.test.ts › 未识别的 reason ⇒ 保留原值并判未知，绝不因未知放行清理`、`draft-closure-decision.test.ts › 中止与中断都不算正常结束`、`result-verification.test.ts › schema 非法（未识别的终止原因）⇒ 结构校验失败，不为显示未知而放宽` | 6.6 实测 tag `limit-outcomes` 14/14（budget_exceeded 与 max_iterations 自有终止与目录期望同源、乙恰 10 次调用；两者 facts.normalEnd=false、草稿均保留；注入 noTerminalEvent ⇒ 重读 verified 但 event=null/normalEnd=false（crashed 中断不猜结局）；注入 unknownTerminalReason ⇒ unreadable（main 侧 GET_RUN_FAILED 行级校验，同样不为显示未知而放宽）；两次注入逐字节还原）（2026-09-29 实机）；⚠️ 中止（aborted）真机无前提、未识别 reason 落不进显示 ⇒ 那两半边按层引用（见上方分层结论） | 已交付（6.6 实测） |
| 4 | 祖先结束与失败调用不能冒充本次事实 | `terminal-facts.test.ts › 祖先含失败调用、叶子以 error 终止但自有无详情 ⇒ 定位不到祖先的 s_05`、`terminal-facts.test.ts › 祖先正常结束、叶子无终止事件 ⇒ 运行中断，不从祖先补正常结局`、`operation-result-view.test.ts › 「祖先结束与失败调用不能冒充本次事实」⇒ 没有自有失败就没有入口，只有说明` | 6.3 实测 tag `leaf-only-failure` 12/12（fail503 父本直调 IPC 造出——信封 CREATE_RUN_FAILED 但登记带 runId；**llm span 没有 result 入口** ⇒ 走 prompt fork（编辑初始 user message 重跑）子 run 成功；无「查看失败调用」+ 诚实说明）（2026-09-28 实机） | 已交付（6.3 实测） |
| 5 | 列表失败不阻断已知结果 | `result-verification-store.test.ts › 读取失败 ⇒ 不可读只落在本条读取项，全局 error 与列表 stale 都不被改写`、`result-verification-store.test.ts › 成功核实 ⇒ 只多出读取项；运行/页签/调用/滚动/全局错误逐字不动`、`operation-result-consumption.test.ts › 一批两条新终态 ⇒ 列表只刷一次，两条各自按身份读取` | —（fs 层无"列表单独失败"的注入面，见分层结论第 1 条） | 实机不成立 |
| 6 | 结果不可读只重试同一记录 | `result-verification-store.test.ts › 结果不可读 ⇒ 只按同一条可信 runId 重试读取，恢复后即为已核实（零执行调用）`、`operation-result-view.test.ts › 「结果不可读只重试同一记录」⇒ 只给重读，且明说此时不做失败定位`、`controlled-read-faults.test.ts › fileMissing：详情读取失败，列表其余项照常且该 run 既不在 runs 也不在 failed`、`run-repository.test.ts › format_version 过高的文件呈失败条目并提示版本不支持` | 6.6 实测 tag `unreadable-retry` 20/20（fileMissing/corruptTail/unsupportedVersion 三轮：重读均 unreadable（attempt 2/4/6 递增、带诚实说明）、通知区首次播报「结果不可读」且同键重复注入**不重复播报**（两层去重）、面板行保留同一条记录的重读说明、还原后重读回 verified、全程零执行调用零新 trace、逐字节还原）（2026-09-29 实机） | 已交付（6.6 实测） |
| 7 | settled 无身份与 notAccepted 不猜测结果 | `result-verification-store.test.ts › 登记里没有可信 runId ⇒ 呈现为未定位，读取项里一条结论都没有`、`result-verification-store.test.ts › notAccepted ⇒ 本次未接受（带稳定拒绝原因），没有核实成功的路径`、`operation-request-facts.test.ts › 「settled 无身份与 notAccepted 不猜测结果」在详情层同样成立：请求事实有、结果链接无` | 6.6 实测 tag `unlocated-reconcile` 9/9（核对未知 UUID ⇒ notAccepted 封禁（无目标/无时间）+ 读取项零结论 + 封禁不占槽 + 通知「未被主进程接受」+ 面板行无任何结果动作、对照 settled 行动作正常）（2026-09-29 实机）；6.2 实测 tag `dup-rejected` 8/8（notAccepted(busy) 零身份 + OPERATION_DUPLICATED / OPERATION_CONFLICT 双取证）（2026-09-28 实机） | 已交付（6.2 + 6.6 实测） |
| 8 | 旧读取响应不能污染其他结果 | `result-verification-store.test.ts › 旧读取响应迟到 ⇒ 只认当代代次：不覆盖新结论，也不碰其他身份与其他状态`、`result-verification-store.test.ts › 同一身份的重复核实去重：只读一次详情；显式只读重试才发第二次读取`、`operation-session-epoch.test.ts › 旧 epoch 的成功响应迟到 ⇒ 不导航、不解冻、不回退会话` | 6.6 实测 tag `stale-read` 7/7（重复核实去重不发第二次读取（attempt 仍 1）；显式重试 attempt 2/3 递增、最终条目认最大代次；乙的读取项与甲的重试互不影响）；⚠️ 「旧响应迟到整份丢弃」的迟到窗需 runs:get 可延时——真机无此注入面 ⇒ 按单元承载（详见 UI-VERIFY U5 §6.6 下沉）（2026-09-29 实机） | 已交付（6.6 实测） |
| 9 | 全部七类入口使用相同核实路径 | `operation-result-consumption.test.ts › 有效 status 采纳 ⇒ 解冻该身份 + 单次列表刷新 + 按可信 ID 核实`、`operation-result-consumption.test.ts › reconcile 采纳 ⇒ 走同一条消费（解冻 + 刷新 + 核实），结论与 status 路径一致`、`fork-entry-closure.test.ts › forkAt 与 promptFork 体内既不打列表也不选中新 run`、`proxy-ab-entry-closure.test.ts › proxyFork 与 modelAb 体内不刷列表、不选中新 run、不碰草稿仓库`、`create-entry-closure.test.ts › createRun 函数体里没有列表刷新、没有 selectRun；状态机没有 success` | 6.2 / 6.3 / 6.4 / 6.5 各批的调用序列同形判据（剧本=successPlain 贯穿） | 待实机 |

### A4. 正常结束仅清理提交对应草稿修订（ADDED，7 场景）

| # | scenario | 已有单元/契约证据 | 实机入口 | 现状 |
| --- | --- | --- | --- | --- |
| 1 | 单运行正常结束清理匹配修订 | `draft-closure-store.test.ts › 核实到自有 stopped/completed ⇒ 清掉匹配修订，同 run 另一字段与创建草稿不动`、`draft-closure-store.test.ts › 创建入口正常结束 ⇒ 整份表单与这次提交的目录引用一并清理`、`create-entry-closure.test.ts › 「新建 run 成功」的正常终止一侧：核实通过才按提交修订清理草稿与目录引用` | 6.2 实测并入 `create-success` 13/13（「正常终止 ⇒ 创建草稿清理」断言在其内）（2026-09-28 实机）；6.4 实测 tag `prompt-cleanup` 7/7（fork 收口 + 子 run completed + 提交快照落盘 + 登记/核实 + 匹配修订 prompt 草稿清理）+ `messages-refork` 7/7 内同口径断言「正常结束 ⇒ messages 草稿清理」（2026-09-28 实机） | 已交付（6.2 + 6.4 实测） |
| 2 | 解冻后修改不被旧结果删除 | `draft-closure-store.test.ts › 解冻后用户又改了草稿 ⇒ 迟到的正常结果不清新修订（内容改回一样也不清）`、`draft-closure-decision.test.ts › 修订推进 ⇒ 保留（判据只看修订，内容改回一样也不算）` | 6.6 实测 tag `rev-after-settle` 9/9（竞速注入挡下自动核实 ⇒ 草稿保留；解冻后修订推进；迟到的正常结果落地后 v2 文本保留；**内容改回原样也不清**（第二次重读 verified、判据只看修订））（2026-09-29 实机） | 已交付（6.6 实测） |
| 3 | 同修订再次提交也不被旧操作清理 | `draft-closure-store.test.ts › 同目标被更晚的提交接管 ⇒ 旧操作即使核实正常也不清理（草稿归新提交冻结）`、`draft-closure.test.ts › 旧操作已解冻留有关联 ⇒ 同目标再次提交后，旧关联不再在场`、`draft-submission-identity.test.ts › 旧提交的回执不能解冻新提交（身份 + 令牌双守卫）` | 6.3 实测 tag `resubmit-same-rev` 8/8（error 后同修订重发 ⇒ 迟到核对不误清理 + 新提交核实成功才清理；⚠️ 在飞接管半边真机诱不出——冻结期第二次登记被拒正是 M6.3 的证据 ⇒ 按单元承载）（2026-09-28 实机） | 已交付（6.3 实测） |
| 4 | 失败与读取恢复分别收尾 | `draft-closure-store.test.ts › 运行失败 ⇒ 保留；只读重试读到正常终止 ⇒ 才清理，全程零执行调用`、`create-entry-closure.test.ts › 结果不可读 ⇒ 解冻了也绝不先删草稿（关联留着等下一次核实）`、`create-entry-closure.test.ts › 只读重试读到正常终止 ⇒ 这条响应路径当场完成收尾（不等下一轮 status）` | 6.6 实测 tag `retry-then-cleanup` 8/8（竞速注入 ⇒ 自动核实 unreadable、草稿保留；还原后面板「重读」⇒ 同一可信 runId verified（attempt=2）；**重试读到正常终止 ⇒ 这条响应路径当场收尾（草稿被清理，不等下一轮 status）**）（2026-09-29 实机） | 已交付（6.6 实测） |
| 5 | 全部预期实验臂正常才清理整批 | `draft-closure-store.test.ts › 两条预期臂各自核实正常结束 ⇒ 整批一次清干净（不逐臂删配置）`、`draft-closure-decision.test.ts › 登记 arms 为空但预期两臂 ⇒ 不成立（空集合恒真就是这里的口子）`、`proxy-ab-entry-closure.test.ts › 「全部预期实验臂正常才清理整批」：逐臂按登记 ID 读一次，整批一次刷新` | 6.5 实测 tag `ab-all-normal` 15/15（两臂各恰一次调用、各自落盘 stopped/completed、fork.edit.experimentId 两臂同标签且与登记一致、两臂父本 = 夹具 run、登记臂 id = 落盘 meta.id 逐臂三方一致、逐臂 verified、**全部臂正常 ⇒ 整批一次清干净**——批次草稿不再存在）（剧本=successPlain 两臂）（2026-09-28 实机） | 已交付（6.5 实测） |
| 6 | 实验缺臂部分失败与未核实保留整批 | `draft-closure-store.test.ts › 缺臂 / null ID / 失败臂 ⇒ 整批配置与关联都保留`、`proxy-ab-entry-closure.test.ts › 「实验缺臂部分失败与未核实保留整批」：信封多报 id 也只读登记里的那条`、`operation-request-facts.test.ts › 「实验缺臂部分失败」逐臂诚实：登记短于 armCount 也不从信封多报的 id 凑` | 6.5 实测 tag `ab-partial-fail` 14/14（臂 1 returned = stopped/completed、臂 2 failed = errored/error + llm 503，**失败臂也是完整落盘 run**；登记逐臂诚实 outcome 不从信封凑；两臂均 verified；**部分失败 ⇒ 整批保留**——批次草稿在、model 原样、解冻可编辑；批次结果区"已收口 / 收口不等于全部成功"在场）（第二臂剧本=fail503）（2026-09-28 实机）；⚠️ 缺臂 / null ID 桌面自然诱发不了 ⇒ 维持**集成 fixture** 承载（不冒充实机） | 已交付（6.5 实测；缺臂半边按集成 fixture） |
| 7 | 重复收尾与显式放弃不会误删重建草稿 | `draft-closure-store.test.ts › 清理幂等：重复 status 与重复读取重试都不再产生第二次删除`、`draft-closure-store.test.ts › 显式放弃 ⇒ 关联一并释放；重建同目标草稿后，迟到结果也不误删`、`draft-closure.test.ts › 释放后关联不在场；再释放一次引用不变` | 6.6 实测 tag `idempotent-closure` 15/15（甲 unreadable ⇒ 关联在场；显式放弃（真模态）⇒ 关联一并释放；重建乙草稿正常收尾 ⇒ 乙自己的清理；甲迟到重读 verified ⇒ 不复活已放弃/已清理的草稿；重复重试 + 关联键集不变 ⇒ 无第二次删除）（2026-09-29 实机） | 已交付（6.2 + 6.6 实测） |

### A5. 结果导航尊重用户当前阅读意图（ADDED，5 场景）

| # | scenario | 已有单元/契约证据 | 实机入口 | 现状 |
| --- | --- | --- | --- | --- |
| 1 | 留在当前流程可进入成功或失败概览 | `navigation-intent.test.ts › 留在流程 + 单运行 + 结果已核实 ⇒ 进入那条记录的概览`、`navigation-intent-store.test.ts › 「留在当前流程可进入成功或失败概览」：失败结局同样进入，且不以打开冒充成功` | 6.2 实测（create-success 13/13 / create-503 9/9）；6.3 实测 tag `navigate-in-flow` 4/4（result 成功支）（2026-09-28 实机） | 已交付（6.2 + 6.3 实测） |
| 2 | 离开再返回不恢复旧自动导航 | `navigation-intent-store.test.ts › 「离开再返回不恢复旧自动导航」：切走再切回原 run ⇒ 结果到达也不跳`、`navigation-intent.test.ts › 「离开再返回不恢复旧自动导航」：代次不等 ⇒ drop（不是 wait）` | 6.3 实测 tag `leave-and-return` 5/5（切走再切回 ⇒ 代次推进意图作废，结果照样核实、到达不跳）（2026-09-28 实机） | 已交付（6.3 实测） |
| 3 | 读取途中离页仍不抢焦点 | `navigation-intent-store.test.ts › 「读取途中离页仍不抢焦点」：详情在飞时用户切走 ⇒ 落地后不覆盖他的页面`、`navigation-intent.test.ts › 「读取途中离页仍不抢焦点」：判定只看当下代次 ⇒ 读取开始时是 7、切换时已是 8 ⇒ drop` | 6.3 实测 tag `nav-during-read` 4/4（页内竞速捕获 resultReads phase=reading 窗口并当场切走 ⇒ 落地不覆盖用户页面）（2026-09-28 实机） | 已交付（6.3 实测） |
| 4 | 恢复核对重试与批次结果只通知 | `navigation-intent-store.test.ts › 「核对结果只由用户明确打开」：reconcile 到达的终态不导航`、`navigation-intent-store.test.ts › 手动只读重试读到正常终止 ⇒ 仍不跳（重试不是导航也不是重发）`、`result-live-region.test.ts › 区域恒渲染：空文本也不卸载，属性可访问（polite live region），面板收起不影响它`、`result-live-region.test.ts › 文本与面板徽标同源（同一份 deriveResultNotices）；重复快照派生出**逐字相同**的文本 ⇒ DOM 不变不重复播报`、`operation-result-view.test.ts › 等待计时不进通知文本（进了就等于每秒重复通知）` | 6.6 实测 tag `notice-only` 8/8（重载后 pending 空、恢复轮询接管收口、快照终态全算新 ⇒ 自动核实；通知区独立于面板播报成功结局、不含等待计时字样、1.5s 重复快照逐字相同不重复播报；手动只读重试不导航）（2026-09-29 实机）；6.8 实测 tag `live-region-a11y` 10/10（面板关闭态：区域恒渲染、OUTPUT+aria-live=polite、不在焦点链上、✕ 焦点回位；成功/失败两轮真实收口 ⇒ live 文本随结局更新且含新 runId；1.6s 重复快照逐字不变；等待期间焦点不变；**只记 DOM/可访问属性证据，未实测屏幕阅读器**）（2026-09-29 实机） | 已交付（6.6 + 6.8 实测） |
| 5 | 失败定位和返回草稿明确可达 | `operation-result-actions.test.ts › 「失败定位和返回草稿明确可达」：只跳真实自有失败调用，并落到步骤页签`、`operation-result-actions.test.ts › 「返回草稿明确可达」：失败保留时恢复原编辑目标；被清理后不返回也不复活`、`operation-result-view.test.ts › 「失败定位和返回草稿明确可达」：草稿在才给返回；被清理后给回退说明且不复活` | 6.4 实测 tag `failure-locate` 3/3 + `return-draft` 3/3（失败定位落到真实自有失败调用的 run+span+步骤页签；返回草稿回到父 run 编辑目标且草稿原文在场）（剧本=fail503）（2026-09-28 实机） | 已交付（6.4 实测） |

### A6. 设置往返保留编辑并真实反馈配置结果（ADDED，7 场景）

| # | scenario | 已有单元/契约证据 | 实机入口 | 现状 |
| --- | --- | --- | --- | --- |
| 1 | 两模式配置后返回任务 | `create-workspace-store.test.ts › 设置往返（覆盖模态开合、视图未变）后再点新建 ⇒ 仍是本次来源`、`settings-roundtrip-invalidate.test.ts › 隔离 result 与创建页：配置指纹变化 ⇒ 本次副本授权作废；目录引用/模式照旧保留`、`create-form-view.test.ts › 两种模式都显示当前接入摘要，且都带可点的「运行配置」入口` | 6.2 实测 tag `create-settings-roundtrip` 11/11（2026-09-28 实机） | 已交付（6.2 实测） |
| 2 | 重跑编辑配置往返保持阅读 | `settings-roundtrip-invalidate.test.ts › 修订与配置都同源 ⇒ fresh`、`execution-confirmation-store.test.ts › 换视图 / 进设置 / 常规打开设置 ⇒ 撤销待用的确认（离开现场）`、`fork-editor-draft.test.ts › 打开 → 编辑 → 切页签/切运行（其他状态翻动）→ 重开：草稿逐字恢复` | 6.7 实测 tag `editor-settings-roundtrip` 5/5（result 编辑器草稿键入后经全局栏打开设置并真实保存（换 model 改指纹）再关闭 ⇒ 阅读位置（run/span/视图）逐字不动、Monaco 草稿逐字保留；418 兜底零消费）（2026-09-29 实机） | 已交付（6.7 实测） |
| 3 | 未保存设置关闭可继续或放弃 | `settings-save-feedback.test.ts › 模型字段或代理字段任何一项偏离 ⇒ 脏`、`settings-save-feedback.test.ts › 设置对话框不冒充连通、不清调试草稿、防重入双保险、只读重试走读通道`、`confirm-dialog.test.ts › 宿主渲染契约：取消为初始焦点、确认按钮可改标签` | 6.7 实测 tag `settings-close-dirty` 13/13（真点选：✕ 触发「运行配置有未保存修改」真模态、**初始焦点在「继续编辑」**、继续编辑逐字保留；Esc 同样先过确认（三路同源）；放弃修改并关闭 ⇒ 已保存配置与磁盘逐字节不动、**打过的密钥从未落盘**、重开输入为空；关闭后焦点恢复到全局栏触发入口）（2026-09-29 实机） | 已交付（6.7 实测） |
| 4 | 单向密钥与保存反馈不冒充连通 | `settings-save-feedback.test.ts › 单向 key：apiKey 只要打过字就算未保存输入（它从未离开渲染层暂存）`、`settings-save-feedback.test.ts › SettingsState 的键集里**没有** apiKey：回读只含配置状态`、`config-gate.test.ts › 写失败只回单行文案：不回显密钥、也不带 stack` | 6.7 实测 tag `key-one-way` 11/11（磁盘侧不回读证据：本机 safeStorage 可用 ⇒ 落盘字节不含密钥明文（`apiKeyEncrypted=true`）；回读键集结构上没有 apiKey + 载荷不含明文；**打过字未保存 ⇒ 磁盘逐字节不动**；保存后新密钥同方式落盘、回读与重开的输入框都不回显；反馈只称「已保存并回读」并明说未发起连接测试）（2026-09-29 实机） | 已交付（6.7 实测） |
| 5 | 保存失败和保存后回读失败区分 | `settings-save-feedback.test.ts › 保存失败 ⇒ save-failed，错误入 store，settings 原样（没写进去也不该动事实）`、`settings-save-feedback.test.ts › 「保存失败和保存后回读失败区分」：回读失败 ⇒ reread-failed，且**不把旧摘要当新配置事实**（settings 清空）`、`settings-save-feedback.test.ts › 回读载荷形状不合法也算 reread-failed（不是 saved）` | 6.7 实测 tag `save-fail-shapes` 14/14（save-failed 用 main「apiKey 不能为空」校验**零注入**诱发：反馈带真实校验文案、输入逐字保留、settings 原样、磁盘零字节不写；reread-failed 由竞速注入坐实——**保存落盘瞬间改写 settings.json 缺 apiKey**（main 的 load() 每次读盘）⇒ 专属反馈「已保存，但配置状态回读失败」+ 只读重试按钮在场 + settings 清空，还原后重试回读核实、按钮退场；竞速窗口毫秒级，第 2 次尝试得手）（2026-09-29 实机） | 已交付（6.7 实测） |
| 6 | 清除确认包含凭据且受槽约束 | `settings-clear-confirm.test.ts › 确认文案点名保存凭据一并删除且不可恢复；走 requestConfirm 真模态`、`settings-clear-confirm.test.ts › 取消 ⇒ 清除通道一次都不碰；确认之后的复位只动配置输入，不越界清草稿`、`settings-clear-confirm.test.ts › 清除按钮受 U4 配置门禁（busy 防重入 + configGate），而「关闭/✕」不吃这把锁（查看返回可用）`、`config-gate.test.ts › 主动操作占槽时：save/clear 被拒、配置文件字节不变、registry 不被写入` | 6.7 实测 tag `clear-confirm` 15/15（真点选两支：取消 ⇒ 零清除调用、磁盘逐字节不动、配置事实原样；确认清除 ⇒ settings null + 磁盘 settings.json 删除 + 输入复位 + 反馈「运行配置已清除。」；确认文案点名「apiKey（保存的凭据）一并删除」不可恢复且草稿运行不受影响；槽约束半边 = 在飞期间（真占槽）设置内清除与保存都被禁用且就近给门禁说明）（2026-09-29 实机） | 已交付（6.7 实测） |
| 7 | 录制入口保持现有代理区可达 | `settings-roundtrip-invalidate.test.ts › 「录制入口保持现有代理区可达」：全局/空态的录制入口定位既有代理分区`、`entry-gate.test.ts › 读取、关闭与回读不被门禁锁掉（spec：settings:get / proxy:status 仍可用）` | 6.7 实测 tag `recording-entry` 8/8（全局栏与选中运行两个状态的录制入口都打开既有设置模态、代理分区在场、**焦点落到代理分区启用复选框**、settingsSection 用后即清）——🔴 首跑抓到并修复真产品缺陷：GlobalBar 的录制入口此前经 `onOpenSettings`（先清 settingsSection 再开）⇒ "proxy" 标记挂载前就被清掉、定位效果从不发生；修在 `d158523`（GlobalBar 增 `onOpenRecording` 专用 prop 直连不清 section 的开器 + 源码级契约）（2026-09-29 实机） | 已交付（6.7 实测） |

### A7. 执行流程在窄窗口与键盘下连续可用（ADDED，3 场景）

| # | scenario | 已有单元/契约证据 | 实机入口 | 现状 |
| --- | --- | --- | --- | --- |
| 1 | 长任务路径模型与结果不遮挡操作 | `focus-escape-responsive.test.ts › 操作面板 max-h 按视口比例钳制 + 横向不超 90vw`、`focus-escape-responsive.test.ts › 设置模态受 85vh 钳制并内部滚动（长表单/200% 缩放在框内滚，不撑破屏幕）`、`operation-entry.test.ts › 窄窗口与键盘可达：受视口宽度约束、长 ID 断行、按钮可聚焦且带 aria 关系`、`fork-editor-draft.test.ts › 原值（只读）/草稿（可编辑）就近核对：宽屏并排、窄屏上下，两侧完整可读` | 6.8 实测 tag `widths-1440-1210-1024-800` 30/30（四档代表宽度逐档：改窗实测 CSS 落点 ±1px、面板 ≤90vw 且不超视口高、页面无横向溢出（长任务/长 ID 断行）、长操作 ID 完整在场、入口命中测试可点（长内容不遮挡操作）、✕ 焦点回位；store 级选中——窄档导航收起时 DOM 行不在）（2026-09-29 实机）；6.8 实测 tag `zoom200` 8/8（独立 200%：DPR>3.5 金标准、面板几何、设置模态 85vh 钳制 + 长表单框内滚动）（2026-09-29 实机） | 已交付（6.8 实测） |
| 2 | 创建页面键盘可离开而模态约束焦点 | `modal-dialog.test.ts › U5 4.1：创建工作区已迁出模态——它盖不住阅读区，也不禁闭焦点`、`modal-dialog.test.ts › 输入锁覆盖指针事件（top layer 逃过覆盖层，须捕获阶段拦截）`、`create-form-draft.test.ts › 锁定判据不变，但创建页不得做成模态（U5 4.1：焦点不禁闭、离页不挡）` | 6.8 实测 tag `real-keyboard` 8/8（真键盘通道 keybd_event：真 Shift+Tab 可离开创建工作区（焦点不禁闭、无模态在场对照）；真 Tab 在设置模态内禁闭（top layer 原生约束）；真 Esc 关闭设置且焦点恢复到触发入口（6.7 合成路径在真键盘下同样成立）；hkl/imm 只记录——本 tag 不打字母，不做 IME 组合断言）（2026-09-29 实机） | 已交付（6.8 实测） |
| 3 | 只读反馈和读取重试保持数据边界 | `operation-result-actions.test.ts › 后台读取（自动核实）不碰当前阅读现场：页签、滚动、选中调用都不动`、`result-live-region.test.ts › 通知区不摸执行/导航/计时通道：只派生文本`、`controlled-read-faults.test.ts › 六种注入逐字节还原：指纹差集为空且不留隐藏文件与残留标记` | 6.8 实测 tag `readonly-fingerprint` 9/9（浏览/编辑器开合/面板开合一轮 ⇒ traces 逐文件 sha256 差集为空；对照支真创建 ⇒ 恰 +1 份（判据有牙）；fileMissing 注入期重读 unreadable → 还原核验 → 重读 verified，全程零写入——零写入基线取注入前）（2026-09-29 实机） | 已交付（6.8 实测） |

---

## MODIFIED requirements

> ⚠️ 七条 MODIFIED 都是**整段替换**语义：下表逐条点名 delta 里的场景，其中既有 U5 新增的、
> 也有从主 spec 逐字保留的。保留条目引用的是**既有证据**（U1–U4 与本 change 前几节），
> 差集复核在 §7.3 做（净新增场景数要含 MODIFIED 内新增）。

### M1. 代理 run 的 llm.call 可编辑 messages 重发（MODIFIED，4 场景）

| # | scenario | 已有单元/契约证据 | 实机入口 | 现状 |
| --- | --- | --- | --- | --- |
| 1 | 编辑并重发成功 | `proxy-ab-entry-closure.test.ts › 「编辑并重发成功」的可信 ID 一侧：核实后清该草稿，序列与其余入口同形`、`controlled-proxy.test.ts › 外部非流式请求 JSON 直通 + 编辑 messages 分叉按 stream:true 重发：受控日志两种模式、fork run 落盘、父不改写` | 6.4 实测 tag `messages-refork` 7/7（经代理重发落恰 1 份子 run、编辑追加在场、身份三方一致、核实 verified、匹配修订清理；捕获扑空 ⇒ operationId 从登记表按 runIds 反查）（剧本=successPlain）（2026-09-28 实机） | 已交付（6.4 实测） |
| 2 | 未修改禁用 | `proxy-ab-entry-closure.test.ts › 「未修改禁用」与「未捕获 key」：提交按钮判据仍含两者（门禁不由响应替代）` | 6.4 实测 tag `messages-unchanged` 3/3（未修改 ⇒ 提交按钮 disabled，零调用零新 trace）（2026-09-28 实机） | 已交付（6.4 实测） |
| 3 | 未捕获 key | `controlled-proxy.test.ts › 未捕获 key 时分叉 → PROXY_NO_KEY，且受控服务零请求（门禁在联网之前）`、`execution-confirmation.test.ts › messages 未捕获 key ⇒ 事实里就写「本次无法重发」，不等提交才发现` | 6.4 实测 tag `messages-no-key` 7/7（剧本=notConsumed）（🔴 实机口径 = **UX 门禁先拦**：hasKey=false ⇒ 确认按钮 disabled、无确认凭据可挂 + 否定披露「未捕获 key：本次无法重发」与就近资格原因先于提交在场——"不等提交才发现"；main 稳定码 PROXY_NO_KEY 仍由上列单元用例承载。⚠️ keyStore.lastKey 是 main 会话级的、禁用代理不清 key（toggle 只停服务器）⇒ 本 tag 必须先于任何捕获 tag 跑（批首=新 dev 会话），否则 hasKey=false 前提不成立——前提破了首 check 会响亮地红）（2026-09-28 实机） | 已交付（6.4 实测） |
| 4 | SDK run 无此入口 | `proxy-ab-entry-closure.test.ts › 「SDK run 无此入口」：messages 入口只给已封存代理 run 的自有 llm.call` | 6.4 实测 tag `sdk-run-no-entry` 4/4（无可见入口 3s 稳定；⚠️ normalRun 与 proxyRun 的 llm span 恰好同名 s_02 ⇒ 自动化必须 run+span 双证选中态——run 没切对时看到的是代理 run 的入口，首跑假红根因；只对可见按钮判 absent，不信瞬态 DOM）（2026-09-28 实机） | 已交付（6.4 实测） |

### M2. 运行工作区按阅读任务组织（MODIFIED，4 场景）

| # | scenario | 已有单元/契约证据 | 实机入口 | 现状 |
| --- | --- | --- | --- | --- |
| 1 | 首次打开与无运行入口 | `create-workspace-store.test.ts › 「首次打开与无运行入口」的反面：首次读取迟到不覆盖已进入的创建页`、`create-workspace-store.test.ts › 对照：没进创建页时首次自动选择照常发生（新守卫不误伤）` | 6.2 实测 tag `first-load-late` 2/2（addScriptToEvaluateOnNewDocument 注入「最早用户」诱出迟到窗口）（2026-09-28 实机）；⚠️ 空目录一侧要另造（数据目录恒为 `.rebaseagent`），6.2 里诱不出来就按单元承载登记 | 待实机 |
| 2 | 文件承载区不附带步骤目录 | `workspace-file-view.test.ts › 文件承载区不附带步骤目录（delta 显式要求）` | —（U2 已归档的实机证据承载，本 change 未改文件页） | 单元已交付 |
| 3 | 旧创建设置及执行入口保持可达 | `entry-gate.test.ts › 三个编辑器都声明同一来源的门禁，并渲染禁用理由`、`execution-confirmation-store.test.ts › 五个入口各有一处就地确认（不共用一个按钮、也不漏接）`、`operation-entry.test.ts › 挂在现有全局栏（不新开一处界面），数据源就是 operations 会话` | 6.2 / 6.3 / 6.4 / 6.5 各批的入口可达判据（剧本=successPlain） | 待实机 |
| 4 | 阅读过程不修改已有数据 | `operation-result-actions.test.ts › 后台读取（自动核实）不碰当前阅读现场：页签、滚动、选中调用都不动`、`draft-source.test.ts › 源基线不含授权/凭据/计划字段（与草稿同一纪律）` | 6.8 实测 tag `readonly-fingerprint` 内同口径断言（只读动作一轮 + 重试全程 ⇒ traces 逐文件 sha256 差集为空；对照支真创建恰 +1 份证明判据有牙）（2026-09-29 实机） | 已交付（6.8 实测） |

### M3. 桌面端提供原生 run 创建入口（MODIFIED，10 场景）

| # | scenario | 已有单元/契约证据 | 实机入口 | 现状 |
| --- | --- | --- | --- | --- |
| 1 | 新建 run 成功 | `create-entry-closure.test.ts › 「新建 run 成功」：按登记的可信 ID 收尾；留在流程内 ⇒ 跳的是登记的那条`、`run-create.test.ts › 落盘为 ${meta.id}.jsonl，且是根 run（parent/fork 为 null、无 source）` | 6.2 实测 tag `create-success` 13/13（2026-09-28 实机） | 已交付（6.2 实测） |
| 2 | 新建 run 作为父本进行 prompt fork | `run-create.test.ts › prompt fork：子 run 的 parent 指向新建 run`、`plain-chat-regression.test.ts › prompt fork：子 parent 指向新建 run，父文件逐字节不变` | 7.1 回归实测：`plain-chat-regression.test.ts` + `run-create.test.ts` 在 HEAD 复跑全绿（子 run parent 指向新建 run、父文件逐字节不变）（2026-09-29 实机） | 已交付（7.1 回归） |
| 3 | 新建 run 作为父本进行模型 A/B | `run-create.test.ts › 模型 A/B：两臂各自落盘，parent 与 config_hash 均指向新建 run`、`plain-chat-regression.test.ts › 模型 A/B：两臂各自落盘，parent 与 config_hash 均指向新建 run` | 7.1 回归实测：`plain-chat-regression.test.ts` + `run-create.test.ts` 在 HEAD 复跑全绿（两臂 parent 与 config_hash 均指向新建 run）（2026-09-29 实机） | 已交付（7.1 回归） |
| 4 | 新建 run 作为父本进行 trace-test | `plain-chat-regression.test.ts › 桌面产出的 trace 直接当卡带：passed / cassette / 配置无漂移，且零落盘`、`plain-chat-regression.test.ts › 对照：工具声明与基线不匹配时 trace-test 会报配置漂移（不是永远通过）` | 7.1 回归实测：`plain-chat-regression.test.ts` 在 HEAD 复跑全绿（桌面产出的 trace 直接当卡带 + 配置漂移对照支）（2026-09-29 实机） | 已交付（7.1 回归） |
| 5 | settings 未配置时拒绝 | `exec-create-fork.test.ts › 未配置运行参数：接受之后才失败 ⇒ 可信终态 + 原稳定码 + 零模型调用`、`store.test.ts › 未配置运行参数的错误码原样透传（SETTINGS_NOT_CONFIGURED）`、`create-form-view.test.ts › 未配置时摘要照给（拒绝理由是就近的，不是全局栏里才有）` | 6.2 实测 tag `create-not-configured` 6/6（2026-09-28 实机） | 已交付（6.2 实测） |
| 6 | userMessage 为空时禁用提交 | `create-run-dialog.test.ts › 空串与纯空白都拒绝，且一次 IPC 都不发`、`create-form-view.test.ts › 不可提交时按钮 disabled，且文案区分进行中 / 两种模式` | 6.2 实测 tag `empty-task-disabled` 5/5（2026-09-28 实机） | 已交付（6.2 实测） |
| 7 | 空 systemPrompt 允许 | `create-run-dialog.test.ts › 空 systemPrompt 允许：两种模式都放行，且请求里 systemPrompt 为空串`、`run-create.test.ts › 空 systemPrompt 允许：config_hash = configHash("", [])` | 6.2 实测 tag `empty-system-allowed` 6/6（2026-09-28 实机） | 已交付（6.2 实测） |
| 8 | 执行失败不产生半成品 | `create-entry-closure.test.ts › 「执行失败不产生半成品」：列表照样刷一次，失败运行按登记 ID 可读`、`run-create.test.ts › 模型调用失败 → 抛 CREATE_RUN_FAILED，且 error run 仍按 meta.id 归位`、`controlled-sse-fixtures.test.ts › fail503：失败不重试（一次调用），自有终止是 errored/error 且失败详情带 503` | 6.2 实测 tag `create-503-no-partial` 9/9（2026-09-28 实机） | 已交付（6.2 实测） |
| 9 | 直接创建隔离文件父本 | `create-run-dialog.test.ts › 落 v2 根 run、指纹按固定工具组算、源目录逐字节不变`、`controlled-isolated.test.ts › 按剧本在受控服务上恰两次提交：v2 隔离根 run 进概览、授权被记录、源目录逐字节不变` | 6.2 实测 tag `isolated-root-create` 10/10（源目录指纹差集为空）（2026-09-28 实机） | 已交付（6.2 实测） |
| 10 | 创建工作区任务优先且可返回来源 | `create-workspace.test.ts › 从轨迹步骤页的某次调用进入 ⇒ 记全运行 / 页签 / 调用`、`create-workspace.test.ts › 本会话没有来源引用（重载后必然如此）⇒ 回退轨迹工作区，不伪造旧位置`、`create-workspace-store.test.ts › 换过工作区再进创建 ⇒ 取新来源（旧的不会被继承）`、`create-workspace-store.test.ts › 「草稿不含来源」：创建草稿的键集合里不存在位置 / 授权字段` | 6.2 实测 tag `create-return-source` 3/3（2026-09-28 实机）；6.6 实测 tag `reload-return-fallback` 10/10（会话内进入 ⇒ 记当前选择、「返回来源」用过即清；换工作区再进 ⇒ 取新来源不继承旧引用；**重载后引用清空，再进创建取的是现在现场（runId 与当前选中一致，绝不等于重载前旧值）**、返回照常 restore；全程零模型调用）；⚠️ 「no-location 点返回 ⇒ fallback」真机不可达（进入创建必然现取来源）⇒ 按 create-workspace 单测承载（2026-09-29 实机） | 已交付（6.2 + 6.6 实测） |

### M4. 创建草稿和实验臂遵守同一保留规则（MODIFIED，4 场景）

| # | scenario | 已有单元/契约证据 | 实机入口 | 现状 |
| --- | --- | --- | --- | --- |
| 1 | 创建关闭配置再新建仍有任务 | `create-form-draft.test.ts › 打开（ensure）→ 填写 → 离开创建页 → 再打开：模式与任务逐字恢复`、`debugging-drafts.test.ts › store 创建草稿：切模式保留文本、放弃恢复默认空表单` | 6.2 实测 tag `create-draft-roundtrip` 3/3（2026-09-28 实机） | 已交付（6.2 实测） |
| 2 | 切创建模式保留文本而放弃重置表单 | `create-form-draft.test.ts › 切模式保留文本：只推进 mode，systemPrompt/userMessage 原样且修订照常推进`、`create-form-draft.test.ts › 放弃同时清除目录引用（design D4：明确放弃创建清除引用）` | 6.2 实测 tag `create-mode-switch-discard` 6/6（真点放弃确认两支）（2026-09-28 实机） | 已交付（6.2 实测） |
| 3 | 实验臂增删和非法参数可恢复 | `model-ab-editor-draft.test.ts › 打开 → 改参数（含非法 JSON）/增删行 → 关闭往返 → 重开：逐字恢复且行 ID 稳定`、`debugging-drafts.test.ts › 增删行推进批次修订；行 ID 顺序无关内容，非法参数原样保存` | 6.5 实测 tag `ab-rows-restore` 10/10（非法 params 原文落草稿、+ 加一臂 ⇒ 3 行、收起/重开逐字恢复、行 ID 重开前后一致、>2 臂时逐行移除按钮在场、零消费零落盘）（2026-09-28 实机） | 已交付（6.5 实测） |
| 4 | 实验预览和结果不隐式清理批次 | `draft-closure-store.test.ts › dry-run 预览既不登记新关联也不读结果`、`model-ab-editor-draft.test.ts › dry-run 预览（成功或失败信封）不写、不清、不推进批次草稿`、`draft-closure-store.test.ts › 执行信封把 ids 全带回来，但登记与核实未跟上 ⇒ 整批保留` | 6.5 实测 tag `ab-no-implicit-clear` 7/7（dry-run 预览：批次 revision 不变、rows 逐字不变、不登记新关联（operations 数不变）、零消费、零落盘）（2026-09-28 实机） | 已交付（6.5 实测） |

### M5. 提交绑定草稿修订且响应不清除草稿（MODIFIED，4 场景）

| # | scenario | 已有单元/契约证据 | 实机入口 | 现状 |
| --- | --- | --- | --- | --- |
| 1 | 提交快照独立于编辑器挂载 | `draft-submission.test.ts › 提交快照独立于编辑器挂载：resetFork 与展示状态复位后仍冻结`、`fork-editor-draft.test.ts › 打开 → 编辑 → 切页签/切运行（其他状态翻动）→ 重开：草稿逐字恢复` | 6.3 实测 tag `unmount-keeps-snapshot` 9/9（在飞切页签卸载编辑器 ⇒ 关联不变 + 快照=草稿原文 + 落盘 fork.edit.value 逐字一致）（2026-09-28 实机） | 已交付（6.3 实测） |
| 2 | 成功错误和部分失败均保留草稿 | `draft-submission.test.ts › 成功响应收尾（解冻）但草稿保留原文`、`draft-submission.test.ts › A/B：部分臂失败（仍是明确返回）收尾且批次保留`、`draft-closure-decision.test.ts › 成功信封但运行 error ⇒ 非正常，并带真实结局文字` | 6.3 实测 tag `response-keeps-draft` 5/5（error 子 run 草稿保留 + success 子 run 核实后按修订清理对照）（2026-09-28 实机）；6.5 实测 `ab-partial-fail` 同口径（部分失败 ⇒ 批次草稿保留原文 + 解冻可编辑）（2026-09-28 实机） | 已交付（6.3 + 6.5 实测） |
| 3 | 迟到回调与未知状态不能错误解冻 | `draft-submission.test.ts › 迟到回调不解冻新提交；通道抛错（状态未知）保留冻结`、`operation-session-store.test.ts › staleEpoch 响应 ⇒ 不采纳、旧身份不销账（它的结局仍是未知）`、`operation-session-epoch.test.ts › 旧 epoch 的成功响应迟到 ⇒ 不导航、不解冻、不回退会话` | 6.6 实测 tag `late-callback` 12/12（真 main 重启后：新会话真跑通并核实；**旧 epoch 身份零泄漏**（登记/pending/读取项/关联都无 A）；旧 epoch 核对被整份拒绝（OPERATION_STALE_EPOCH）、旧 epoch 主动提交被拒且不进登记；旧 ID 核对 ⇒ notAccepted 封禁（无目标/无时间）；B 草稿按正常清理，A 的迟到不复活任何东西）；⚠️ 「同一会话内迟到回执/通道抛错保留冻结」需 renderer 存活跨 main 死亡 ⇒ 按单元承载（2026-09-29 实机） | 已交付（6.6 实测） |
| 4 | 核对终态只解冻对应修订 | `draft-submission-identity.test.ts › reconcile 解冻（settleDraftByOperation）同样转存关联；重复核对不产生第二条`、`operation-session-store.test.ts › 核对到 settled ⇒ 只解冻该身份那一条，另一条仍冻结`、`operation-session-store.test.ts › 核对别人的身份 ⇒ 两条都不解冻（解冻口只认匹配身份）` | 6.6 实测 tag `reconcile-single-unfreeze` 10/10（乙在飞 ⇒ 创建目标被乙冻结；**核对甲（已收口）⇒ 乙仍冻结**（解冻口只认匹配身份）；乙收口 ⇒ 乙自己的正常清理；甲迟到重读 verified（attempt=2）不复活草稿；重复核对 ⇒ 关联键集不变按身份幂等）（2026-09-29 实机）；⚠️ 「两条同 epoch 在飞同时冻结」真机不可达（统一执行槽一次只放一个）⇒ 按单元承载 | 已交付（6.6 实测） |

### M6. 保留模态框约束焦点并正确恢复（MODIFIED，3 场景）

| # | scenario | 已有单元/契约证据 | 实机入口 | 现状 |
| --- | --- | --- | --- | --- |
| 1 | 创建设置和放弃确认不泄漏焦点 | `modal-dialog.test.ts › 真模态在场（创建/设置/放弃确认）⇒ 一次按键不同时关确认与底层编辑区`、`modal-dialog.test.ts › 焦点恢复与失效回退：打开前元素优先，回退锚点在全局栏`、`create-form-draft.test.ts › 锁定判据不变，但创建页不得做成模态（U5 4.1：焦点不禁闭、离页不挡）` | 6.8 实测 tag `real-keyboard` 半边（创建页真 Shift+Tab 可离开 + 设置模态真 Tab 禁闭 + 真 Esc 关闭后焦点恢复到全局栏触发入口）（2026-09-29 实机） | 已交付（6.8 实测） |
| 2 | Esc 只关闭最上层并恢复焦点 | `modal-dialog.test.ts › 非最近打开的编辑区不消费（prompt 与 A/B 并存逐层收起）`、`focus-escape-responsive.test.ts › 面板走共享 useEscapeClose(open, closePanel)；✕ 与 Esc 同一关闭动作`、`confirm-dialog.test.ts › 放弃确认全部经 requestConfirm（DetailPanel 9 处 + 创建 1 处）` | 6.7 实测 tag `esc-topmost` 8/8（真 Esc 键：非脏 ⇒ 设置关闭且焦点恢复到全局栏触发入口；脏 ⇒ 第一层 Esc 出现未保存确认（设置在下层原位）、第二层 Esc **只关确认**且输入逐字保留、第三层可再次唤起、放弃收尾后全部关闭且磁盘逐字节不动）——🔴 首跑抓到并修复真产品缺陷：Chromium「两步关闭」让第二次 Esc 以 cancelable:false 直关**底层**设置（未保存输入被静默丢弃，M6.2 被平台行为穿透）；修在 `40287fb`（ModalDialog 最上层模态在 keydown 捕获段**合成** Esc 关闭，preventDefault 压掉原生 cancel 通道，非最上层放行；modal-dialog 源码级契约同步更新）；6.8 实测 `real-keyboard` 用系统级真键盘复证同一行为（真 Esc 关闭 + 焦点恢复）（2026-09-29 实机） | 已交付（6.7 + 6.8 实测） |
| 3 | 创建忙碌期间不能通过焦点修复绕过关闭锁 | `create-entry-closure.test.ts › 执行中不放行第二次执行：离页、展示态复位与重复登记都发不出新的 runs:create（U5 4.3）`、`draft-close-flow.test.ts › 询问期间到达的新提交：被拒并留下 notAccepted 封禁，返回后也不自动执行`、`create-form-draft.test.ts › 锁定判据不变，但创建页不得做成模态（U5 4.1：焦点不禁闭、离页不挡）` | 6.2 实测 tag `busy-no-second-run` 7/7（2026-09-28 实机）；6.7 实测 tag `quit-return` 12/12（创建在飞 ⇒ 哨兵 quit 仍先过协商（活跃操作档）；询问期间 main 的 closing 在场且第二主动入口被拒（OPERATION_NOT_ACCEPTED + 登记 notAccepted + 零副作用）；返回 ⇒ 退出被阻止、closing 解除但槽不释放、被拒那条不自动执行（仍 notAccepted、零新文件）；原在飞照常收口并按可信 ID 核实 verified）（2026-09-29 实机） | 已交付（6.2 + 6.7 实测） |

### M7. 现有界面消费统一操作事实（MODIFIED，4 场景）

| # | scenario | 已有单元/契约证据 | 实机入口 | 现状 |
| --- | --- | --- | --- | --- |
| 1 | 初始握手失败禁用主动入口 | `operation-session.test.ts › 没握过手 ⇒ 主动入口与配置写入口都禁用，原因是不知握手而非未知`、`entry-gate.test.ts › 空闲会话 ⇒ 可提交且无提示；未握手 ⇒ 禁用并给提示`、`settings-clear-confirm.test.ts › 初始握手未成功 ⇒ 配置写入口整体禁用（U4 门禁接线回归到设置对话框这一层）` | 6.6 实测 tag `main-restart` 半边（重启后首帧「未握手」窗口被采样：epoch=null 时禁用原因全为 not_handshaked，最终门禁开放；「握手返回非法结构」半边真机诱不出 ⇒ 按层引用）（2026-09-29 实机） | 已交付（6.6 实测） |
| 2 | 所有入口实际使用同一适配器 | `operation-result-consumption.test.ts › 有效 status 采纳 ⇒ 解冻该身份 + 单次列表刷新 + 按可信 ID 核实`、`entry-gate.test.ts › 两个入口都读 s.operations 并经 deriveEntryGate 判定`、`fork-entry-closure.test.ts › 隔离 result（带 execution）走同一条消费：请求透传、序列同形` | 6.2 / 6.3 / 6.4 / 6.5 各批的调用序列同形判据（通道 → operations:status → runs:list → runs:get） | 待实机 |
| 3 | 核对结果只由用户明确打开 | `operation-entry.test.ts › 核对只发 reconcile(operationId)，打开只走明确动作通道（不经列表、不自己 selectRun）`、`navigation-intent-store.test.ts › 「核对结果只由用户明确打开」：reconcile 到达的终态不导航`、`operation-result-view.test.ts › 未定位（settled 无可信 id）⇒ 没有任何结果动作，只让核对登记` | 6.6 实测 tag `reconcile-no-nav` 4/4（前置选择在别的 run；**核对到达终态不导航**（选择/页签/代次/视图都不动）；「打开结果」显式动作才切换）（2026-09-29 实机） | 已交付（6.6 实测） |
| 4 | 操作入口在窄窗口和键盘下可达 | `operation-entry.test.ts › 窄窗口与键盘可达：受视口宽度约束、长 ID 断行、按钮可聚焦且带 aria 关系`、`focus-escape-responsive.test.ts › 操作面板 max-h 按视口比例钳制 + 横向不超 90vw` | 6.8 实测 tag `narrow-keyboard-panel` 11/11（800px 窄档：入口可聚焦且带 aria-expanded/aria-controls、真 Enter 开合面板、面板 ≤90vw、页面无横向溢出、长 ID 断行完整在场）（2026-09-29 实机）；`zoom200` 内同口径断言（独立 200% 缩放下面板几何 + 入口命中）（2026-09-29 实机） | 已交付（6.8 实测） |

---

## 已知限制（§6.1 就写在这儿，别等 §7.3 才发现）

- **`addDiagnostic` 零调用方（6.2 实机发现）**：main 侧没有任何路径往操作登记里写诊断
  ⇒ 实机 diagnostics 恒为空，A2.5「操作详情可读诊断」的可读半边只能按单元承载
  （6.2 `diagnostics-readable` tag 已如实登记）。给失败路径接诊断产出归后续口径，本 change 不新增。
- **中止（aborted）在桌面端不可诱发**：U5 非目标里没有取消通道（桥接面白名单钉死
  `preload-surface.test.ts › 本阶段不交付取消能力：桥接面没有 stop/cancel/abort 通道`）
  ⇒ 「限制中止」那半边只有 `terminal-facts` 与 `controlled-read-faults`（缺终止事件 ⇒ 中断）两级证据。
- **A/B 缺臂 / null ID 桌面自然诱发不了**：登记里的臂 id 由 main 编排产出 ⇒ 6.5 只能以
  **集成 fixture** 单列（`draft-closure-decision.test.ts` + `operation-request-facts.test.ts` 两支构造），
  不得写成实机已测。
- **剧本与注入两套原语目前只在单元层真跑过**：Electron 侧的可用性（同进程起受控服务、
  改 main 必重启 dev、原生对话框应答）沿用 U4 的机制层 `scripts/lib/u4-smoke-harness.cjs`，
  6.2 首跑若与之冲突，以实机为准修引用，不改判据本身。
- **U4 遗留的四条欠账仍未清**（真机 IPC 往返与满载诊断体积、`configurationBusy` 合并档关闭确认文案、
  跨 epoch 在飞关联的真机前提、ProxyManager 层被动录制交错反证）：本 change 未新增能力去补它们，
  §7.3 逐条核对时继续按"历史限制"登记，不算 U5 的场景遗漏。
