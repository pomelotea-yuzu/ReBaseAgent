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
| S07 | 迟到读取不能污染当前目标 | 1.4、3.3、5.1、5.3、5.4、5.5、6.3.2 | store / reading-request-guard / compare-store / result-verification-store / operation-session-epoch 的旧目标/代次/epoch 竞态 | 待验证 |
| S08 | 草稿修订和许可失效不被拆分改变 | 2.2、5.2、5.5、5.6 | draft-submission / draft-closure-store / settings-roundtrip-invalidate / draft-close 系列；正文、revision、冻结及授权逐项比较 | 待验证 |
| S09 | 未知执行只核对且所有主动入口共用适配器 | 2.3、4.2、5.4、5.5、6.2.1–6.2.3 | operation-races / operation-session-store / execution-confirmation / exec-entry-matrix + mock 服务实机；真实组合提交计数及未知核对，不重放 | 待验证 |
| S10 | 代理事实和配置协调仍取最新有效读取 | 4.3、5.6、6.2.3 | proxy-status-store / proxy-recovery-races / proxy-change-store / messages-eligibility；尾随与配置交错、解绑后重订阅 | 待验证 |
| S11 | 调用详情完整展示与入口保持 | 2.1、2.4、6.1 | call-detail-view / cache-display / budget-reachability + Electron；LLM/tool/step 字段、错误、原文工具及入口真实可达 | 待验证 |
| S12 | prompt 和 result 编辑保持身份与提交边界 | 2.2、2.3、2.4、6.1 | prompt-messages-editor-draft / fork-editor-draft / execution-confirmation / isolated-fork + Electron；身份、恢复、确认/放弃和隔离拒绝 | 待验证 |
| S13 | 两侧读取独立且旧结果不串选择 | 3.2、3.3、6.3.1 | file-two-side-read / file-single-side-view / file-reading-state + 受控读取/实机；成功/失败/缺失、旧选择及独立重试 | 待验证 |
| S14 | 编辑器资源和阅读位置按原身份恢复 | 3.2、3.4、6.3.1 | file-view-session-state / file-view-scroll-wiring / monaco-view-state / file-diff-height-chain + Electron 长文件；滚动、模式、监听释放 | 待验证 |
| S15 | 导出资格和异步反馈不串目标 | 3.1、3.5、6.3.3 | workspace-export-state / workspace-export-panel / workspace-export-endpoint + 实际 UI/IPC；成功/取消/拒绝、切目标和返回 | 待验证 |
| S16 | 测试迁移保留原有保证 | 1.3、2.1、2.4、3.4、5.8、7.1 | 从 36 个静态测试文件逐断言建账并核对起点差集；单列动态导入与固定清单/计数，旧保证→新模块/消费者→新断言位置；禁止空入口否定断言、整目录拼接搜索和新增跳过 | 待验证 |
| S17 | 最终源码重新通过质量门禁 | 1.1、1.3、6.6、6.7、7.1、7.2、7.3 | 最终提交的 check:ci + desktop build、测试执行/跳过差异、职责/规模报告与暂存路径复核；主 spec 前后 requirement/带所属条款的 scenario 集合求差留档 | 待验证 |
| S18 | 真实交互保持数据与执行边界 | 1.4、6.1、6.2.1–6.2.3、6.3.1–6.3.3、7.1 | 独立数据目录、现有受控 mock、真实 UI/IPC；纯阅读零调用/写入，执行计数与可信结果、父/源/兄弟指纹和导出内容 | 待验证 |
| S19 | 宽度缩放和键盘保持连续流程 | 3.4、6.4、6.5 | 四档 CSS 宽度、独立 200% 缩放、真实键盘；DOM 尺寸/可达性、偏好/焦点恢复及编辑器高度链 | 待验证 |

## 既有测试迁移台账（实施前补齐）

文件级起点改用 [静态测试迁移基线](test-migration-baseline.md) 的 **36 个文件完整清单**，不再从少量举例增量搜。该表已复核旧路径读取位置及重点清单/计数；逐测试名/断言的原保证、新承载与运行证据仍由任务 1.3 建档，实施起点变化须附文件/断言差集。

每条记录测试名/旧文件位置、原保证、新模块和真实消费者、新断言、运行日志、执行/跳过变化及理由。单列动态导入测试，继续通过原入口验证实际组合 store/组件；同文件包含两类检查时分别登记。特别核对 `run-list-nav`、`budget-reachability` 的固定文件清单和 `draft-compare-grid` 等跨文件计数，否定断言跟随实际实现迁移，不能只检查已搬空的入口。拆分不触及的测试仍在全仓门禁中执行，不要求逐条复制到本表。

## 实施与验收记录（待执行）

- 实施起点、最终源码提交与工作区差异：待填。
- 字段/action/资源归属、导出/依赖图、前后行数报告：待填。
- 旧断言迁移清单及基线/最终执行与跳过差异：待填。
- 最终全仓门禁、desktop build、Electron 数据目录/fixture/mock/构建：待填。
- 新发现问题、未覆盖或实机不成立项：待填，不提前记为无。
- 工作区/暂存路径归属复核与任务组提交：待执行，不混入无关发行文档、截图或脚本。
- 归档与既有 requirement/scenario 集合差集：待执行；保存前后完整标题和场景所属条款，验证旧项缺失为零、新项与 delta 一致；发行不在本 change 范围内。
