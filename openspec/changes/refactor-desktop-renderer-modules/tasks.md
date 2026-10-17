# 实施任务

> 状态：2026-10-16 仅编写提案，全部实施与行为验收待执行。每项控制在 2 小时以内，超出先按领域/场景拆小。括号中的场景名对应本 change 的 [desktop-ui delta](specs/desktop-ui/spec.md)；映射详见 [证据索引](evidence-index.md)。本次不打包、不发布。

## 1. 固定基线与迁移清单

- [x] 1.1 固定实施起点提交，枚举三个目标的全部导出/导入方及职责、物理行数；分别登记静态读源码和动态导入消费者。保存工作区状态与提交路径清单，后续按明确路径/差异暂存并核对 staged diff，发行文档、截图、脚本等无关修改不混入任务组提交。（原入口导出指向同一实现；最终源码重新通过质量门禁）→ [baseline-inventory](baseline-inventory.md)（2026-10-17，起点 `379b388`）
- [x] 1.2 建立 AppState 全量字段/action 的唯一归属表，明确跨领域协调者及原子 set/await 边界；列出资源所有者和启动/停止/解绑时点。（分片组合不覆盖状态或动作；跨分片协调保持原子更新；资源重复启停保持原有纪律）→ [ownership-map](ownership-map.md)
- [x] 1.3 从 [36 个静态测试文件基线](test-migration-baseline.md) 全量复核并记录实施起点差集，逐断言建立旧保证→新承载/实际消费者→新验证方式台账；点名 run-list-nav、budget-reachability 的固定清单及跨文件计数。另列动态导入测试，保留原入口消费与实例验证；先跑库构建再跑 desktop 基线，记录执行/跳过/已知失败，超 2h 按套件拆项。（测试迁移保留原有保证；最终源码重新通过质量门禁）→ [test-migration-ledger](test-migration-ledger.md)（差集=0；逐断言「新承载」列按台账方法随 2.x/3.x/5.x 分套件回填）
- [x] 1.4 固定无新增调用的初始化基线、selector 引用及关键 action 竞态证据；用现有受控 fixture 记录编辑恢复和文件路径的 Electron 基线，不直接改 store。（初始化和派生引用保持稳定；迟到读取不能污染当前目标；真实交互保持数据与执行边界）→ Electron 基线 `apps/desktop/scripts/rrm-14-baseline-cdp.cjs`（2026-10-17，9/9 通过，证据 `.workbuddy/rrm-14-baseline/evidence-*.json`；B1 prompt 草稿跨页签往返正文+revision 保持、B2 文件选中跨页签往返路径+几何保持）；初始化/selector/竞态证据由既有单测锚定（store.test.ts 引用稳定、operation-races/operation-polling/operation-session-epoch/proxy-recovery-races/wait-timing），阶段 4/5 迁移后用同一组合 store 复跑

## 2. 拆详情展示与编辑器

- [x] 2.1 迁移公共展示、LLM/tool/step 展示与所需类型，保留原导出，子模块不回引 DetailPanel；迁移对应字段、缓存、错误与预算接线断言。（原入口导出指向同一实现；内部模块依赖有明确方向；调用详情完整展示与入口保持；测试迁移保留原有保证）→ 2026-10-17：新增 `detail/{DetailShared,LlmCallDetail,ToolInvokeDetail,StepDetailView}.tsx`（DetailPanel 2161→1595 行），8 个原导出全部兼容再导出指向同一实现；T02/T03/T04/T05/T09/T10/T27 断言迁移见 [台账 2.1 销账记录](test-migration-ledger.md)；全量 200 文件/2988 用例 0 失败
- [x] 2.2 迁移 PromptForkEditor，保留 key、草稿来源、恢复和配置失效逻辑；核对普通 prompt 可执行、隔离父本仍拒绝。（prompt 和 result 编辑保持身份与提交边界；草稿修订和许可失效不被拆分改变）→ 2026-10-17：PromptForkEditor（含 startupContents）迁 `detail/PromptForkEditor.tsx`（~440 行，DetailPanel 1595→1155），8 文件 16 条接线断言随载体迁移（[台账 2.2 销账](test-migration-ledger.md)）；全量 200 文件/3030 用例 0 失败
- [x] 2.3 迁移 ResultForkEditor，保留普通/隔离检查、轮末快照说明、确认绑定与每次授权，测试真实提交路径和草稿恢复。（prompt 和 result 编辑保持身份与提交边界；未知执行只核对且所有主动入口共用适配器）→ 2026-10-17：ForkEditor（含 toolMessageText/detectResultLanguage，684 行）迁 `detail/ResultForkEditor.tsx`（组件名保持，DetailPanel 1155→435 行只剩壳+组合层），12 文件断言随载体迁移（[台账 2.3 销账](test-migration-ledger.md)）；全量 200 文件/3010 用例 0 失败
- [x] 2.4 将 DetailPanel 收敛为选择/组合层，核对新增模块不改变 DOM/key；逐项迁移静态接线与确认次数测试，完成本阶段 desktop 专项回归。（调用详情完整展示与入口保持；prompt 和 result 编辑保持身份与提交边界；测试迁移保留原有保证）→ 2026-10-17：两壳随视图迁入 detail/ 模块并导出，DetailPanel 收敛为 219 行纯选择/组合层（span kind 分发 + StepDetail/预算地图/草稿列表/滚动恢复），壳体逐字搬迁 DOM/key 零变化；4 文件壳接线断言随迁（[台账 2.4 销账](test-migration-ledger.md)）；全量 202 文件/3118 用例 0 失败 = 阶段专项回归

## 3. 拆文件连接、布局与内容

- [x] 3.1 提取跨层类型和 WorkspaceFileViewBody，保留旧类型/组件导出；目录、检查点、工具条和导出面板接线不变。（原入口导出指向同一实现；内部模块依赖有明确方向；导出资格和异步反馈不串目标）→ 2026-10-17：types.ts(19)/WorkspaceFileViewBody.tsx(711) 迁出，Body/Props 经原入口再导出指向同一实现，6 个 file-* 动态导入测试继续从原入口消费
- [x] 3.2 提取 FileContent 及编辑器生命周期代码，保留懒加载、只读、两侧状态、模式判据与资源清理；验证监听只注册/释放一次。（两侧读取独立且旧结果不串选择；编辑器资源和阅读位置按原身份恢复）→ 2026-10-17：FileContent.tsx(766) 迁出（零拉取：无 readWorkspaceFile/useEffect），monaco-view-state/file-diff-height-chain/file-single-side-view 断言随迁
- [x] 3.3 收敛 WorkspaceFileView 读取连接层；用可控异步验证切 run/检查点/路径后的两侧成功、失败、缺失和迟到响应，以及独立重试。（两侧读取独立且旧结果不串选择；迟到读取不能污染当前目标）→ 2026-10-17：连接层收敛即拆分后原文件（402 行：RequestGuard×3 + 拉取 effect + 失效清理 + 组装）；file-two-side-read 62 用例（守卫/收口/重试/迟到响应）全过承载该验证
- [x] 3.4 回归长文件查找/复制、模式切换、滚动恢复及高度链；完成本阶段静态接线迁移与 desktop 专项回归。（编辑器资源和阅读位置按原身份恢复；宽度缩放和键盘保持连续流程；测试迁移保留原有保证）→ 2026-10-17：file-view-scroll-wiring 16 用例（下传=连接层/编辑器恢复=FileContent/列表读回=Body）+ file-diff-height-chain + file-two-side-read 工具组全过 = 本阶段专项回归；实机长文件回归归 6.3.1
- [ ] 3.5 通过实际 action 验证导出成功、取消、坏附件、缺来源、非空目标以及迟到反馈切目标；离开返回不新增导出请求。（导出资格和异步反馈不串目标）

## 4. 拆 store 类型与资源管理

- [x] 4.1 按归属表拆分 AppState 接口并聚合完整类型；定义带类型的 set/get/runtime 上下文，保留原字段/action 签名和入口导出，禁止 any/类型断言掩盖缺失实现。（原入口导出指向同一实现；分片组合不覆盖状态或动作）→ 2026-10-17：192 个成员按 [ownership-map](ownership-map.md) 拆入 store/slices/{runs,reading,drafts,operations,results,compare,navigation,configuration}.ts（成员逐字随迁、零 any），store/types.ts 交叉聚合 AppState；ExperimentSourceState/idleExperimentSource 随 navigation 域迁 slices 并经原入口兼容导出；唯一 create 不动，5 个原导出全部保留
- [x] 4.2 将轮询移到单一 runtime 所有者，保留停止导出和在飞守卫，假时钟验证重复 ensure、慢响应、停止后响应及未知不重放。（资源重复启停保持原有纪律；未知执行只核对且所有主动入口共用适配器）→ 2026-10-17：轮询整段（pollState/pollTimer/pollContextOf/applyPollStep/runStatusPoll/rescheduleStatusPoll/stopOperationStatusPolling，含 JSDoc）迁 `store/runtime/operation-polling.ts` 唯一所有者；store.ts 在唯一 create 之后组合一次（惰性回调注入 getSession/refreshOperationStatus，本模块不导入 useAppStore、不在模块顶层缓存实例）；原入口兼容导出 `stopOperationStatusPolling` 指向同一实现；行为验证 = operation-polling/operation-session-epoch/operation-races 22 用例全过（假时钟判据），销账见 [台账 4.2](test-migration-ledger.md)；全量 203 文件/3180 用例 0 失败
- [ ] 4.3 迁移代理订阅句柄与静默等待者，保留 action 启动时点、幂等释放、尾随结算后唤醒；受控 Promise 验证配置和消息入口交错。（资源重复启停保持原有纪律；代理事实和配置协调仍取最新有效读取）
- [ ] 4.4 迁移派生缓存和 runtime 组合，惰性访问完整 state；验证导入/初始化不多发请求，返回事实引用不变且页面稳定，无第二 store。（初始化和派生引用保持稳定；分片组合不覆盖状态或动作）

## 5. 拆 store 功能分片

- [ ] 5.1 迁移 runs/reading，保留列表调度、详情完整性/版本和阅读定位守卫，接回完整组合 store。（迟到读取不能污染当前目标；分片组合不覆盖状态或动作）
- [ ] 5.2 迁移 drafts，保留修订、提交快照、冻结、确认和关闭协议；继续复用既有纯判据。（草稿修订和许可失效不被拆分改变；跨分片协调保持原子更新）
- [ ] 5.3 迁移 navigation/compare，保留来源返回、pair 独立性、导航代次、比较读取和只读文件入口。（迟到读取不能污染当前目标；跨分片协调保持原子更新）
- [ ] 5.4 整体迁移唯一提交适配器和 operations 连接，全部主动执行入口回接同一实现；验证非法回执、丢响应、旧 epoch 和本地门禁。（未知执行只核对且所有主动入口共用适配器；迟到读取不能污染当前目标）
- [ ] 5.5 迁移 results 协调，保留可信 ID 读取去重、按修订收尾、通知及阅读意图判据；验证旧结果不清新草稿、不抢当前页。（草稿修订和许可失效不被拆分改变；迟到读取不能污染当前目标；未知执行只核对且所有主动入口共用适配器）
- [ ] 5.6 迁移 configuration 与录制应用，明确业务状态和 runtime 资源边界；保持配置操作/来源拒绝的原子许可失效、最新代理门禁和录制草稿关闭保护。（代理事实和配置协调仍取最新有效读取；草稿修订和许可失效不被拆分改变；跨分片协调保持原子更新）
- [ ] 5.7 将 store.ts 收敛为唯一 create/组合入口；核对全量键归属、兼容导出、实际初始化键集合及可达导入图，禁止分片回引入口或彼此运行时导入。（分片组合不覆盖状态或动作；原入口导出指向同一实现；内部模块依赖有明确方向）
- [ ] 5.8 完成 store 源码接线断言迁移，对最终组合 store 重跑资源、缓存引用、竞态和原子更新观察测试；按 1.3 台账逐条销账旧保证，复查搬迁后的否定断言未只查空入口、固定清单和计数覆盖实际模块，记录测试增删/跳过差异。（测试迁移保留原有保证；初始化和派生引用保持稳定；资源重复启停保持原有纪律；跨分片协调保持原子更新）

## 6. 最终 Electron 路径与质量门禁

- [ ] 6.1 在独立受控目录实测普通 run 详情、长原文、prompt/result 修改恢复、设置往返和放弃模态；通过真实 DOM/IPC，记录编辑器和焦点状态。（调用详情完整展示与入口保持；prompt 和 result 编辑保持身份与提交边界；真实交互保持数据与执行边界）
- [ ] 6.2.1 通过本地 mock 服务实测普通与隔离 result 提交/结果闭环，核对各单次提交的请求数、真实 operation/结果关联及原轮末检查点语义。（未知执行只核对且所有主动入口共用适配器；真实交互保持数据与执行边界）
- [ ] 6.2.2 通过本地 mock 服务实测普通 prompt 与模型实验提交/结果闭环、隔离父本拒绝；核对请求数、完整结果关联和按修订收尾。（未知执行只核对且所有主动入口共用适配器；真实交互保持数据与执行边界）
- [ ] 6.2.3 通过本地 mock 代理实测 messages 单请求重发与配置/代理事实更新后的重新核对；核对门禁、实际请求数和可信结果，不访问付费服务。（代理事实和配置协调仍取最新有效读取；未知执行只核对且所有主动入口共用适配器；真实交互保持数据与执行边界）
- [ ] 6.3.1 实测文件页两侧失败重试和长文件滚动/模式恢复，记录独立 fixture 与受控异常注入、trace/附件/源目录指纹。（两侧读取独立且旧结果不串选择；编辑器资源和阅读位置按原身份恢复；真实交互保持数据与执行边界）
- [ ] 6.3.2 实测比较→合法单运行文件页→返回、来源失效和切换检查点后的定位；核对 run/pair/路径身份及父本/兄弟分支指纹保持。（迟到读取不能污染当前目标；真实交互保持数据与执行边界）
- [ ] 6.3.3 实测合法导出、取消、坏附件/缺来源/非空目标拒绝及切目标反馈，核对实际输出与所选检查点一致，源目录和父/兄弟不变。（导出资格和异步反馈不串目标；真实交互保持数据与执行边界）
- [ ] 6.4 实测 1440/1210/1024/800 CSS px 的详情编辑、文件差异与返回入口；核对实际编辑器尺寸、高度链、导航/专注及无额外执行。（宽度缩放和键盘保持连续流程）
- [ ] 6.5 独立实测 200% 缩放、纯键盘核对/提交/返回和模态关闭焦点恢复；不以截图或调用内部 action 代替键盘交互。（宽度缩放和键盘保持连续流程）
- [ ] 6.6 在最终源码运行 `pnpm check:ci` 并记录各阶段退出码与执行/跳过差异；库构建必须先于测试，不用旧日志替代。（最终源码重新通过质量门禁）
- [ ] 6.7 单独运行 `pnpm --filter @rebaseagent/desktop build`，核对生产入口和 Monaco 懒加载构建，无发布打包；记录所测 Electron 源码/构建与门禁提交的一致性。（内部模块依赖有明确方向；最终源码重新通过质量门禁）

## 7. 证据与归档收口

- [ ] 7.1 逐行回填 19 个 delta 场景的测试/实机日志与判据，核对旧测试保证去向；未测如实保留，不把门禁全绿当全部实机通过。（测试迁移保留原有保证；真实交互保持数据与执行边界；最终源码重新通过质量门禁）
- [ ] 7.2 输出前后模块职责/规模、字段/action/资源归属及导出/导入图报告，复核没有整体搬迁、循环依赖或大杂烩模块；同步架构说明与当前状态。（原入口导出指向同一实现；内部模块依赖有明确方向；分片组合不覆盖状态或动作；最终源码重新通过质量门禁）
- [ ] 7.3 满足验收后按流程归档，核对 ADDED 无同名冲突；保存主 spec 合入前 requirement 与「所属 requirement + scenario」完整集合（当前 95 条 requirement），合入后求差并留档，既有缺失为零、新增集合匹配本 delta，起点变动单列说明，不能只比计数。提交前复查暂存范围；归档不等于新包验收或发布。（最终源码重新通过质量门禁）
