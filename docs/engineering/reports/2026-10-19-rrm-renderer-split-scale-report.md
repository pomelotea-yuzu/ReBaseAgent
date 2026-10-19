# 渲染层模块拆分（refactor-desktop-renderer-modules）前后对比报告

> 任务 7.2 交付物（2026-10-19）。核对起点 `379b388`（2026-10-17 固定，见
> [baseline-inventory](../../openspec/changes/archive/2026-10-19-refactor-desktop-renderer-modules/baseline-inventory.md)），
> 终点为本报告撰写时的 main HEAD。物理行数以 `wc -l` 实测。

## 一、三大目标文件：前 → 后

| 文件 | 拆分前 | 拆分后 | 后形态 |
|---|---|---|---|
| `store.ts` | 3769 | **135** | 四 runtime 组合（全 create 前）+ create 块体 8 分片纯组合 + 4 兼容导出 |
| `components/DetailPanel.tsx` | 2161 | **219** | 纯选择/组合层（span kind 分发 + StepDetail/预算地图/草稿列表/滚动恢复） |
| `components/WorkspaceFileView.tsx` | 1866 | **402** | 纯连接层（RequestGuard×3 + 拉取 effect + 失效清理 + 组装） |
| 合计 | 7796 | 756 | 组合层占比 9.2% |

## 二、新模块清单（物理行数 · 职责）

### store 分片（8 件 + 类型 + runtime 3 件 + lib 1 件）

| 模块 | 行数 | 职责（唯一归属） |
|---|---|---|
| `store/slices/runs.ts` | 394 | 列表调度、详情完整性/版本、来源筛选与选择（17 字段 + 10 action） |
| `store/slices/reading.ts` | 188 | 调用/文件阅读状态与定位守卫、详情代次计数（5 字段 + 11 action + DetailReadAttempts） |
| `store/slices/drafts.ts` | 526 | 草稿修订/提交快照/冻结/确认/关闭协议、clearExecutionConfirmations（7 字段 + 27 action） |
| `store/slices/operations.ts` | 778 | 唯一提交适配器（LOCAL_BLOCKED/inspectAck/submitActive）+ 操作登记连接（12 字段 + 17 action） |
| `store/slices/results.ts` | 430 | 结果核实、按修订收尾、通知与导航意图；五个协调者公开成员（4 字段 + 12 action） |
| `store/slices/compare.ts` | 466 | 比较读取、pair、侧目标与返回（8 字段 + 18 action + MAX_COMPARE） |
| `store/slices/navigation.ts` | 542 | 创建/辅助工作区入口与返回、restoreReadingLocation、createReturnFactsOf 判据（11 字段 + 16 action） |
| `store/slices/configuration.ts` | 416 | 设置、代理状态/变化协调消费、录制草稿应用（11 字段 + 13 action） |
| `store/types.ts` | 31 | AppState 聚合与 SliceContext（编译期交叉组合） |
| `store/runtime/operation-polling.ts` | 84 | 状态轮询唯一所有者（ensure/release 幂等、在飞守卫） |
| `store/runtime/proxy-coordination.ts` | 89 | 代理订阅句柄 + 静默等待者（先结算后唤醒） |
| `store/runtime/create-return-facts-cache.ts` | 50 | 按引用命中/失效重建的派生缓存 |
| `lib/describe-zod-error.ts` | 7 | 纯函数（四分片直连，无协调语义） |

字段/action 归属：**197 个成员**（8 分片 interface↔工厂 return 键 1:1，零重复零缺失零多余；
比 4.1 的 192 多 5 = 协调者成员化 noteReadingChanged / revokeSourceBoundPermissions /
consumeSettledOperations / clearExecutionConfirmations / restoreReadingLocation）。

### 详情组件（detail/ 6 件）

| 模块 | 行数 | 职责 |
|---|---|---|
| `detail/DetailShared.tsx` | 203 | 小型公共展示、缓存提示、草稿列表与来源提示 |
| `detail/LlmCallDetail.tsx` | 338 | LLM 调用容器及展示（含长原文折叠/查找/复制） |
| `detail/ToolInvokeDetail.tsx` | 176 | 工具调用容器及展示 |
| `detail/StepDetailView.tsx` | 107 | step 展示 |
| `detail/PromptForkEditor.tsx` | 458 | prompt 草稿、核对和提交接线（含 startupContents） |
| `detail/ResultForkEditor.tsx` | 718 | 原 ForkEditor；普通/隔离 result 接线（684 行逐字随迁 + 壳） |

### 文件组件（workspace-file/ 3 件）

| 模块 | 行数 | 职责 |
|---|---|---|
| `workspace-file/types.ts` | 19 | 原跨层 props/selection 类型 |
| `workspace-file/WorkspaceFileViewBody.tsx` | 711 | 目录、检查点、工具条与导出面板布局 |
| `workspace-file/FileContent.tsx` | 766 | 两侧/单侧查看、差异与编辑器生命周期（零拉取） |

新模块合计 8234 行（拆分前三大文件 7796 行，**净增 438 行 ≈ 5.6%**——来源为各模块
import 头、JSDoc 职责注释与工厂/注入接缝，无逻辑复制）。

## 三、规模复核（design 提示口径）

- 全部业务模块落在 design 提示的 **约 300–800 行**区间内（operations 778 最大）；
  低于 300 行的六件（types 31 / lib 7 / runtime 三件 50–89 / reading 188 / ToolInvoke 176 /
  StepDetail 107 / DetailShared 203）均为设计 D1 点名的独立职责单元（类型聚合、纯函数、
  runtime 资源、小容器），非凑数拆分；
- **无大杂烩模块**：每件单一职责（见上表），三个组合层只做选择/组合/连接；
- **无整体搬迁**：12 批次全部按逐成员判归属纪律迁移（5.3/5.5 两次夹层误删当场恢复并
  留痕），ownership-map 为唯一归属表。

## 四、导出/导入图复核

- **兼容导出 4 件**（store.ts：`MAX_COMPARE` / `ExperimentSourceState` / `idleExperimentSource` /
  `stopOperationStatusPolling`）+ DetailPanel 8 件 + WorkspaceFileView 组件/Props 再导出——
  audit-5.7 ③ 全部有真实消费、指向同一实现；
- **可达运行时导入图**（audit-5.7 ② PASS）：分片零入口导入、零兄弟值导入
  （仅 runs→reading 的 type-only DetailReadAttempts 与 8×types 类型导入，编译期擦除）；
- **Monaco 仍走懒加载包装**（budget-reachability 固定清单核对 + 6.7 build 产物
  MonacoEditors-*.js / editor.api-*.js 懒 chunk 实证）；
- **单次 create**：唯一 `create<AppState>` 在 store.ts；runtime 工厂不导入 useAppStore、
  模块加载不启动任何资源（4.2–4.4 判据）。

## 五、测试迁移等价

- 静态读源码断言：36 文件/631 用例逐断言建账（[test-migration-ledger](../../openspec/changes/archive/2026-10-19-refactor-desktop-renderer-modules/test-migration-ledger.md)），
  断言随载体改读 12 文件，**测试增删/跳过差异 = 零**（恒 203 文件/3180 用例）；
- 否定断言全部读取实际承载模块，无一处只查已搬空的 store.ts；
- 固定清单：run-list-nav 清单随 8 分片扩展、budget-reachability Monaco 清单、
  draft-compare-grid 跨文件计数逐项核对；
- 最终门禁：desktop 全量 203 文件/3180 用例 singleFork **0 失败 exit=0**（多次复现）；
  check:build 5 包 / tsc 双 0 / biome 跟踪树 0 错 / spec 13 项 ✓（6.6 分阶段等价序列）。

## 六、结论

拆分达成 design D1–D6 全部结构判据：三大文件收敛为组合/连接层（≤402 行），新模块
单一职责、依赖方向单向、单一 store 实例、runtime 管资源、测试等价迁移；行为面由
**6.1–6.5 实机批全绿**（rrm-14 9/9 + 补探针 21/21 + 6.2 三批 36 tag + 6.3.1 64 判据 +
6.3.2 34/34 + 6.3.3 36/36 + 6.4 28/28 + 6.5 38/38）与全量门禁共同背书，未发现行为回归。
