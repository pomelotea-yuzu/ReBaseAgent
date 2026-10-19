# 静态测试迁移基线

日期：2026-10-16。源码基线 `ddcfd2a`。对 `apps/desktop/test/` 全量搜索三个目标路径并核对读取上下文，共 **36 个测试文件**直接通过 `readFileSync` 或其封装读取旧源码；与独立 [review](review.md) 的计数一致。本文件只建立文件级范围和定位，未迁移测试、未运行产品测试，任务 1.3 尚未完成。

以下位置相对 `apps/desktop/test/`，行号是本次读取快照，实施时按测试名和断言重新定位。目标缩写：S = `src/renderer/src/store.ts`；D = `src/renderer/src/components/DetailPanel.tsx`；W = `src/renderer/src/components/WorkspaceFileView.tsx`。单文件可同时含动态导入/行为测试，不能因列入静态表就只处理静态部分。

| 编号 | 测试文件 | 读取旧目标的位置 | 迁移时重点核对 | 状态 |
|---|---|---|---|---|
| T01 | `aux-workspace-entries.test.tsx` | S:194 | 辅助入口与 store 接线仍是同一生产路径 | 待迁移 |
| T02 | `budget-reachability.test.ts` | D:245、327、337；W:328、338 | 错误详情可达；325–338 的固定 Monaco 清单、懒包装接线随实际编辑器模块迁移 | 待迁移 |
| T03 | `cache-display.test.ts` | D:203、288 | 缓存命中行和 result 编辑器缓存提示分别追踪实际组件 | 待迁移 |
| T04 | `call-detail-view.test.ts` | D:805、875 | 原始字段、详情外壳和消息正文转换的真实接线 | 待迁移 |
| T05 | `confirm-dialog.test.ts` | D:54 | 放弃确认调用点与跨编辑器计数按新模块逐项映射 | 待迁移 |
| T06 | `create-entry-closure.test.ts` | S:477 | 旧局部分支不得复活，否定检查跟随实际创建 action | 待迁移 |
| T07 | `create-workspace-store.test.ts` | S:464、472 | 结果导航与旧创建对话框通道的否定检查不只查空入口 | 待迁移 |
| T08 | `draft-closure-store.test.ts` | S:674 | 收尾判据的唯一消费者和组件禁用第二份规则 | 待迁移 |
| T09 | `draft-compare-grid.test.tsx` | D:107、108、120、129 | prompt/result 分别挂对照区；固定文件清单及窗口断点出现次数不因搬迁变弱 | 待迁移 |
| T10 | `draft-list.test.ts` | D:225 | 本运行草稿、来源失效提示和编辑器核对调用点 | 待迁移 |
| T11 | `draft-submission.test.ts` | D:30；S:48 | 提交快照/冻结与各执行通道真实消费关系 | 待迁移 |
| T12 | `entry-gate.test.ts` | D:26（路径常量） | 来源/配置门禁仍控制实际入口，不只保留展示 | 待迁移 |
| T13 | `execution-confirmation-store.test.ts` | D:167、187、198、210、221、233、247、274 | 固定组件列表、绑定/披露、确认块计数与隔离授权判据分别承接 | 待迁移 |
| T14 | `experiment-results.test.ts` | D:353 | 批次旧挂载/死导入否定断言覆盖实际详情模块 | 待迁移 |
| T15 | `file-checkpoint-resolve.test.ts` | W:177；S:205 | 默认检查点和 fileReadingEntered 的实际消费方 | 待迁移 |
| T16 | `file-diff-height-chain.test.ts` | W:35 | diff DOM 高度/overflow 链迁移后仍查实际渲染模块 | 待迁移 |
| T17 | `file-single-side-view.test.ts` | W:47 | 单侧查看与缺失内容语义 | 待迁移 |
| T18 | `file-two-side-read.test.ts` | W:40 | 两侧读取、错误/重试及只读接线各有真实消费者 | 待迁移 |
| T19 | `file-view-scroll-wiring.test.ts` | D:58；W:78、136 | openFileAt、滚动恢复和失效定位清理贯通新层次 | 待迁移 |
| T20 | `file-view-session-state.test.ts` | W:108 | 文件选择来自会话状态，禁止第二份组件选择库 | 待迁移 |
| T21 | `focus-escape-responsive.test.ts` | D:70 | 冻结/收尾文案仍表达可信正常结果及匹配修订 | 待迁移 |
| T22 | `fork-editor-draft.test.ts` | D:31（切片:37–40） | 按旧函数边界截源码必须迁移，保留 result 草稿/恢复保证 | 待迁移 |
| T23 | `fork-entry-closure.test.ts` | S:342 | result/prompt 旧局部分支不得复活 | 待迁移 |
| T24 | `modal-dialog.test.ts` | D:171 | prompt/result Esc 规则与常开工作区模态约束保持 | 待迁移 |
| T25 | `monaco-view-state.test.ts` | W:183 | 文件 diff 沿用文件阅读状态，不能误入调用编辑器状态通道 | 待迁移 |
| T26 | `navigation-intent-store.test.ts` | S:461；D:489 | 唯一导航消费点和禁止组件自行导航的固定列表覆盖新模块 | 待迁移 |
| T27 | `notice-disclosure.test.tsx` | D:176 | 首次调用的适用性提示与 run 级展开键 | 待迁移 |
| T28 | `operation-result-actions.test.ts` | S:422 | 结果定位/跳转仍从实际 store action 唯一接入 | 待迁移 |
| T29 | `panel-collapse-headers.test.tsx` | W:59 | 目录折叠入口位置和真实布局保持 | 待迁移 |
| T30 | `prompt-messages-editor-draft.test.ts` | D:27、192 | prompt 草稿与代理 messages 入口；详情不重新内嵌 messages 编辑器 | 待迁移 |
| T31 | `proxy-ab-entry-closure.test.ts` | S:367；D:371 | messages/A-B 旧局部成功分支不复活，统一执行链保持 | 待迁移 |
| T32 | `refine-ui-return.test.ts` | S:164 | 返回事实仍唯一派生并同时控制文案与动作 | 待迁移 |
| T33 | `run-list-nav.test.ts` | S:194、242、256 | ShortIdState 实例；238–250 固定清单及旧标签否定检查跟随实际实现 | 待迁移 |
| T34 | `settings-roundtrip-invalidate.test.ts` | D:173 | 配置指纹改变撤销隔离写入授权，草稿及目录模式保留 | 待迁移 |
| T35 | `workspace-file-view.test.ts` | D:380 | 文件页入口沿用工作区页签，不恢复局部 tab | 待迁移 |
| T36 | `workspace-focus-mode.test.ts` | D:256 | 专注隐藏范围与无条件保留的异常提示保持 | 待迁移 |

## 任务 1.3 的逐断言建档要求

对上表每个文件列出所有受影响测试名/断言，不只为每文件留一行。建档字段为：旧文件/行号、测试名、静态/动态类别、原保证、计划的新模块、实际生产消费者、拟用断言方式、最终断言位置、运行日志和执行/跳过差异。静态否定断言须覆盖迁移后的实现及其调用路径，跨文件计数须注明原计数与新计数如何对应相同保证。

动态导入另列完整清单，继续从原入口验证真实组件/组合 store 的兼容导出和实例；覆盖所有生产导入方，保持初始化时点，不以重新排序导出或新增顶层调用改变资源启动顺序。任务 1.3、5.8、7.1 分别负责建档、迁移销账、最终证据复核。

以上 36 个文件为本轮范围核对结果，逐断言台账和行为基线尚待实施。后续新测试、间接 helper 或不同路径写法导致范围变化时，记录相对本表的差集及搜索方法；不能把固定文件数作为扫描停止条件。
