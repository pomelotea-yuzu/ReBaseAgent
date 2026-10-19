# 场景与证据索引

> 2026-10-16：规划骨架，19 个场景全部待验证。任务映射和测试名是计划承载，不代表测试已运行或功能已通过。本轮只编写文档；后续按最终源码提交、命令、退出码、fixture、实机路径与观测值回填。

## Delta 场景 → 任务 → 计划证据

| 编号 | 场景（逐字对应 delta） | 任务 | 计划证据与关键判据 | 状态 |
|---|---|---|---|---|
| S01 | 原入口导出指向同一实现 | 1.1、2.1、3.1、4.1、5.7、7.2 | 导出/消费者清单区分静态读取和动态导入；类型检查、原入口与具体模块引用身份，生产调用方继续消费兼容入口 | 待验证 |
| S02 | 内部模块依赖有明确方向 | 2.1、3.1、5.7、6.7、7.2 | 可达运行时导入图无循环，分片不回引 store.ts，Monaco 仍走包装；desktop build | 待验证 |
| S03 | 分片组合不覆盖状态或动作 | 1.2、4.1、4.4、5.1、5.7、7.2 | 全量类型/实际初始键与归属表比对；单次 create，所有消费者实例一致、组合键不重叠 | 待验证 |
| S04 | 初始化和派生引用保持稳定 | 1.4、4.4、5.8 | 导入/初建请求计数基线、延迟 get、createReturnFactsOf 的 Object.is、创建页稳定渲染 | 待验证 |
| S05 | 资源重复启停保持原有纪律 | 1.2、4.2、4.3、5.8 | operation-polling / proxy-change-store / proxy-status-store 等实际组合 action + 假时钟/受控 Promise；订阅/计时器数与等待唤醒时点 | 待验证 |
| S06 | 跨分片协调保持原子更新 | 1.2、5.2、5.3、5.6、5.8 | 组合 store 订阅者观察更新序列，导航/提交/许可失效无新增中间状态；set/await 边界表 | 待验证 |
| S07 | 迟到读取不能污染当前目标 | 1.4、3.3、5.1、5.3、5.4、5.5、6.3.2 | store / reading-request-guard / compare-store / result-verification-store / operation-session-epoch 的旧目标/代次/epoch 竞态 | ✅ 6.3.2：u7-69 34/34（换边不串/迟到只认最新代次/文件往返身份保持，`gates-632.txt`）；其余侧由单测+6.2 各批承载 |
| S08 | 草稿修订和许可失效不被拆分改变 | 2.2、5.2、5.5、5.6 | draft-submission / draft-closure-store / settings-roundtrip-invalidate / draft-close 系列；正文、revision、冻结及授权逐项比较 | 待验证 |
| S09 | 未知执行只核对且所有主动入口共用适配器 | 2.3、4.2、5.4、5.5、6.2.1–6.2.3 | operation-races / operation-session-store / execution-confirmation / exec-entry-matrix + mock 服务实机；真实组合提交计数及未知核对，不重放 | 待验证 |
| S10 | 代理事实和配置协调仍取最新有效读取 | 4.3、5.6、6.2.3 | proxy-status-store / proxy-recovery-races / proxy-change-store / messages-eligibility；尾随与配置交错、解绑后重订阅 | 待验证 |
| S11 | 调用详情完整展示与入口保持 | 2.1、2.4、6.1 | call-detail-view / cache-display / budget-reachability + Electron；LLM/tool/step 字段、错误、原文工具及入口真实可达 | 待验证 |
| S12 | prompt 和 result 编辑保持身份与提交边界 | 2.2、2.3、2.4、6.1 | prompt-messages-editor-draft / fork-editor-draft / execution-confirmation / isolated-fork + Electron；身份、恢复、确认/放弃和隔离拒绝 | 待验证 |
| S13 | 两侧读取独立且旧结果不串选择 | 3.2、3.3、6.3.1 | file-two-side-read / file-single-side-view / file-reading-state + 受控读取/实机；成功/失败/缺失、旧选择及独立重试 | ✅ 6.3.1：u2-54 sides 9/9 + both-unreadable 5/5 + race-retry 12/12（`gates-631-main.txt`） |
| S14 | 编辑器资源和阅读位置按原身份恢复 | 3.2、3.4、6.3.1 | file-view-session-state / file-view-scroll-wiring / monaco-view-state / file-diff-height-chain + Electron 长文件；滚动、模式、监听释放 | ✅ 6.3.1：u2-53 roundtrip 8/8（模式+滚动按身份恢复）+ tools-copy/find 18/18（查找/复制/诚实禁用，`gates-631-main.txt`） |
| S15 | 导出资格和异步反馈不串目标 | 3.1、3.5、6.3.3 | workspace-export-state / workspace-export-panel / workspace-export-endpoint + 实际 UI/IPC；成功/取消/拒绝、切目标和返回 | 待验证 |
| S16 | 测试迁移保留原有保证 | 1.3、2.1、2.4、3.4、5.8、7.1 | 从 36 个静态测试文件逐断言建账并核对起点差集；单列动态导入与固定清单/计数，旧保证→新模块/消费者→新断言位置；禁止空入口否定断言、整目录拼接搜索和新增跳过 | 待验证 |
| S17 | 最终源码重新通过质量门禁 | 1.1、1.3、6.6、6.7、7.1、7.2、7.3 | 最终提交的 check:ci + desktop build、测试执行/跳过差异、职责/规模报告与暂存路径复核；主 spec 前后 requirement/带所属条款的 scenario 集合求差留档 | 待验证 |
| S18 | 真实交互保持数据与执行边界 | 1.4、6.1、6.2.1–6.2.3、6.3.1–6.3.3、7.1 | 独立数据目录、现有受控 mock、真实 UI/IPC；纯阅读零调用/写入，执行计数与可信结果、父/源/兄弟指纹和导出内容 | 待验证 |
| S19 | 宽度缩放和键盘保持连续流程 | 3.4、6.4、6.5 | 四档 CSS 宽度、独立 200% 缩放、真实键盘；DOM 尺寸/可达性、偏好/焦点恢复及编辑器高度链 | 待验证 |

## 既有测试迁移台账（实施前补齐）

文件级起点改用 [静态测试迁移基线](test-migration-baseline.md) 的 **36 个文件完整清单**，不再从少量举例增量搜。该表已复核旧路径读取位置及重点清单/计数；逐测试名/断言的原保证、新承载与运行证据仍由任务 1.3 建档，实施起点变化须附文件/断言差集。

每条记录测试名/旧文件位置、原保证、新模块和真实消费者、新断言、运行日志、执行/跳过变化及理由。单列动态导入测试，继续通过原入口验证实际组合 store/组件；同文件包含两类检查时分别登记。特别核对 `run-list-nav`、`budget-reachability` 的固定文件清单和 `draft-compare-grid` 等跨文件计数，否定断言跟随实际实现迁移，不能只检查已搬空的入口。拆分不触及的测试仍在全仓门禁中执行，不要求逐条复制到本表。

## 实施与验收记录（待执行）

- 实施起点：`379b388`（2026-10-17 固定，见 [baseline-inventory](baseline-inventory.md)）；阶段 1（1.1–1.4）已完成：基线清单 / 归属表 / 迁移台账（desktop 基线：check:build 绿，全量 201 文件/3098 用例，2 条失败单包复跑全过=沙箱并行假红，2 条 EPERM 既有噪声）/ Electron 行为基线（`rrm-14-baseline-cdp.cjs` 9/9：B1 prompt 草稿跨页签往返正文+revision 保持；B2 文件选中跨页签往返路径+几何保持；证据 `.workbuddy/rrm-14-baseline/evidence-1792216313496.json`，重构后同脚本对比）。
- 实机通道事实（探针新增）：electron-vite dev 的 renderer root = `src/renderer` ⇒ 模块 specifier 是 `/src/monaco-bootstrap.ts`（`/src/renderer/src/...` 会被 SPA fallback 成 HTML）；prompt 草稿编辑器字段名为 `system_prompt`；孤儿 dev host 会占住 5173 导致后续 dev 静默换端口——探针前先 `u2-dev-host.cjs --stop`。
- 6.1 收口（2026-10-18，21/21）：S11/S12/S18 的实机面 = rrm-14 复跑 9/9（详情/prompt 键入恢复/文件几何）+ 补探针三判据（长原文折叠/展开/查找/复制、放弃模态初始焦点/取消保留/确认清稿、设置往返预填/保存回读/落盘/重开保持），证据 `.workbuddy/rrm-61/evidence-1792316040979.json`（探针 `.workbuddy/rrm-61/probe-61-extra.cjs`，run-all 编排含 settings 备份还原）；🔴 通道坑：title 筛选 `'LLM'` 误中 GlobalBar「运行配置」⇒ 设置模态 inert 背景吞掉全部焦点/键入且选中判据假绿掩盖（必须精确「LLM 调用」+ 写前断言无 `dialog[open]`）；tool 行 title=工具名、compact tool 详情长原文在「入参与结果」Disclosure 内、折叠摘要字符数=prettyJson 显示长度。
- 6.2.1–6.2.3 收口（2026-10-18）：S09/S10/S18 的 mock 实机面 = **拆分后树上复跑 U4/U5/U8 提交闭环探针全绿**——u4-61 7/7（登记/身份三方/请求数/判重/隔离令牌）、u5-63 12/12（result 闭环/边界披露/按修订收尾/迟到核对）、u5-64 9/9（prompt 提交/messages 门禁/失败定位/重发闭环）、u5-65 5/5（modelAb 批次/整批清理/部分失败保留/确认绑定计划）、u8-69 3/3（比较实验真实三批、messages 真实代理单请求重发+503 失败诚实+真实 main 重启凭据失效闭环）；证据各批 gates.txt。**探针判据适配四笔提交**（`475aabc`/`0975c0d`/`cc14dd4`/`2656002`）：操作登记迁 SessionActivity、确认块「详细边界」Disclosure 展开、panelLiteral 多文件改读、JSX 文本同源断言、实验工作区 [data-experiment-entry] 入口、aux 返回入口前缀匹配、#46 失败落盘口径对齐——拆分链对 packages/main/呈现层零改动（git log/diff 为空）⇒ 旧判据在拆分前同样红，均属 refine-ui/U8 改版后探针过时而非行为回归；**夹具更换**：U3 manifest proxyRun 自环（2026-09-25 遗留坏数据，读守卫如实拒绝=产品正确行为）→ 换健康 run_mto90h5r_7i6z；**harness 增强**：appImport reload 后直连 import 兜底、clickSpan 失败诊断转储。
- 6.3.1 收口（2026-10-19）：S13/S14/S18 的文件页实机面 = **拆分后树复跑 U2 文件页探针 64 判据零适配全绿**——u2-53:roundtrip 8/8（往返恢复模式+滚动+筛选+布局偏好）、u2-54:sides 9/9 + both-unreadable 5/5 + race-retry 12/12（两侧独立/失败不伪装/迟到代次）、tools-copy+tools-find 18/18（查找/复制/工具诚实禁用）、u2-55:readonly 12/12（**source/traces/blobs/夹具逐文件 SHA-256 前后一致 + 零新增 + 零模型工具调用**，S18 纯阅读指纹承载）；证据 `.workbuddy/rrm-63/`（gates-631-main/supplement.txt + readonly-measurements.json，编排器 run-all-631.cjs 单次调用内 start→probe→stop + settings 备份还原）。**夹具更换留痕**：侧夹具重装后引擎原生 run id 变化 ⇒ `u2-54-cdp.cjs` 改读 SIDE-MANIFEST.json（不再硬编码 run id）。
- 6.3.2 收口（2026-10-19）：S07/S18 的比较→文件页实机面 = **拆分后树复跑 u7-69 keyboard-entries 34/34 全绿**（#64 键盘比较闭环 + #61/#62 比较→隔离文件页往返各自检查点 + #40 父子入口 + #44 设置往返保留会话；全程只读指纹自核）；证据 `.workbuddy/rrm-63/gates-632.txt`。**判据适配一笔**（#38 页头可达：refine-ui R01 语义 `<header>` → WorkspaceHeading div + returnLabel 动态化「返回」前缀匹配）；**首轮 4 条失败为真键盘通道瞬态**（复跑未改判据全绿，与 refine-55「同 dev 复跑劣化」同族登记）。
- 字段/action/资源归属、导出/依赖图、前后行数报告：归属表已建（[ownership-map](ownership-map.md)）；导出/依赖图与前后行数报告待最终源码（7.2）。
- 旧断言迁移清单及基线/最终执行与跳过差异：台账骨架已建（[test-migration-ledger](test-migration-ledger.md)，36 文件/631 用例/动态导入 50 文件/固定清单点名）；逐断言回填与最终执行差异随各阶段与 7.1。
- 最终全仓门禁、desktop build、Electron 数据目录/fixture/mock/构建：待填。
- 新发现问题、未覆盖或实机不成立项：待填，不提前记为无。
- 工作区/暂存路径归属复核与任务组提交：待执行，不混入无关发行文档、截图或脚本。
- 归档与既有 requirement/scenario 集合差集：待执行；保存前后完整标题和场景所属条款，验证旧项缺失为零、新项与 delta 一致；发行不在本 change 范围内。
