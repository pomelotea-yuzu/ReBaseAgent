# U4 change 评审：add-desktop-operation-tracking

- 评审时间：2026-09-26
- 评审对象：`openspec/changes/add-desktop-operation-tracking/`（proposal / design / 4 个 delta spec / tasks）
- 评审方式：文档审阅 + 当前源码逐条核对（未执行 GUI 走查；本 change 处于纯文档阶段，proposal 已明示"未重新执行 GUI 走查"）
- 门禁：`openspec validate add-desktop-operation-tracking --strict` 通过

## 结论

**通过，可进入实施。** 现状断言与源码一致（8/8，见下表）、MODIFIED 均为完整超集（归档安全）、63 个 delta 场景与 tasks 验收双向闭合、与 U 拆分计划 U4 契约逐条对应。2026-09-26 已落实 B1/B2 的文档修订，并核实 B4 的源码依据；B3/B5 保留为实施注意事项。原评审为 62 场景，本轮新增「指纹与执行使用同一解析快照」。文档意见已处理不代表实施或功能验收完成，48 项实施任务仍全部待办。

## 一、现状断言核对（proposal Why / design Context）

| # | 断言 | 结论 | 证据 |
|---|---|---|---|
| 1 | `CreateRunError` 不含结构化 ID | 属实 | `main/run-create.ts` L46-54：仅 `code/message` 两个字段；runId 只嵌在异常文案里（L119 `run ${runId ...} 已落盘`），调用方只能解析 message 才能取到 |
| 2 | `runModelAb` 的 `ids` 仅保留成功臂 | 属实 | `main/fork-runner.ts` L282-284：注释明确"ids 的语义是**成功臂**的 run id"，`result.arms` 过滤后组装 |
| 3 | `ProxyManager.lastWrittenRunId` 由主动重发和被动录制共用 | 属实 | `main/proxy-manager.ts` L50/L102：recorder 回调对**所有**录制（含被动）写回该字段；`fork()` L181 清空、L193-196 读取——主动重发等待期间任何被动请求都会覆盖此字段，竞争真实存在 |
| 4 | settings 保存/清除只在 UI 侧限制，直接 IPC 可绕过 | 属实 | `main/ipc.ts` L440-463：`settingsSave`/`settingsClear` handler 仅做 schema 解析后直接写，无任何执行槽/关闭互斥检查 |
| 5 | `BaseTracer.startRun` 已在写 meta 后发出 `run.meta`，subscribe 可复用 | 属实 | `packages/trace-sdk/src/tracer.ts` L112-124：先写首行、再 `emit({ type: "run.meta", ... })`；`subscribe` 返回解绑函数（L67） |
| 6 | main 五个主动执行通道 | 属实 | `shared/channels.ts`：`runs:create` / `runs:fork` / `runs:promptFork` / `runs:modelAb` / `proxy:fork` 共 5 条；"七类路径" = create 与 result 各含普通/隔离两模式，D3 已讲清口径，不矛盾 |
| 7 | 基线为 desktop-ui 主 spec 47 requirements / 200 scenarios | 属实 | 实测计数：47 / 200 |
| 8 | 关闭流已有 sender/frame 校验、新鲜查询、1.5s 有界等待、防重入 | 属实 | U3 已归档（commit `3742ba6` 等，6.7/6.10/6.11 实机验收记录在案） |

主 spec 中不存在任何覆盖"busy/互斥/执行槽"的既有 requirement，新增的"main 原子执行槽"ADDED requirement 与未列出的 43 条主 spec requirement 无语义重叠（已按关键词复查）。**未发现任何与源码不符的假设。**

## 二、结构与覆盖核对

1. **MODIFIED 均为完整超集**（OpenSpec 归档约定：MODIFIED 会整体替换主 spec 版本）：
   - 渲染进程无文件权限：2 → 3 场景（+非法操作响应不能解除门禁）
   - 运行配置 safeStorage：2 → 5（+直接 IPC 不能绕过配置锁 / 配置变更与主动接受原子互斥 / settled 后读取失败不阻止配置）
   - 提交绑定草稿修订：3 → 4（+核对终态只解冻对应修订；正文补 epoch/operationId 与"新执行新 ID"）
   - 主进程核对退出：9 → 11（+无草稿的活跃操作也需确认 / 草稿与操作合并且关闭竞争不漏保护）
   归档时不会丢失任何既有场景。
2. **delta 场景 ↔ tasks 验收双向闭合**：修订后 4 个 delta 共 63 场景（desktop-ui 52 / replay 4 / prompt-replay 3 / model-experiments 4），脚本核对 tasks 的具名验收引用全部存在，delta 场景全部被至少一个任务直接引用；新增解析快照场景对应 1.3/3.7。7.2 另负责 evidence-index 收口。无孤儿场景、无悬空引用。
3. **与拆分计划对齐**：`docs/engineering/plans/2026-09-21-ui-change-split-plan.md` U4 契约要点（epoch/operationId/三态、status+原子 reconcile、判重先于副作用、A/B 整批占槽、dry-run 与被动录制不占槽、settings main 校验、可信 ID 不解析 message、全入口迁移、不存正文/凭据）逐条在 proposal/design/spec 中落地。
4. **保真度边界诚实**：settled ≠ 运行成功、`run.meta` 是身份事实而非可读/成功证明、幂等仅限本 epoch、退出不撤销上游费用——这些"不承诺"都写进了规范正文而非仅留在 design。

## 三、优点

1. **身份来源表格（design §已核实的身份来源）是全文档最扎实的部分**：逐入口列出"当前 ID 如何产生/丢失"与"U4 最小扩展"，尤其点出隔离路径"绝不能登记被替换的 loop ID"——这是实施时最容易踩的坑，提前写明。
2. **判重顺序正确且贯彻到底**：D2 五步顺序把"查重 → 占槽 → settings 快照 → 消费 token → 编排"的副作用边界画死；"接受后发现未配置也走 settled/failed，不能反标 notAccepted"堵住了状态机倒流。
3. **proxy 竞争的修复方案克制**：不改 llm-proxy 公共契约，用 `Map<ProxyForkMeta, RequestContext>` 做请求局部关联，替换全局 `lastWrittenRunId`；"被动录制不借另一请求 ID 报成功"的场景（主动代理重发与被动录制交错）直指现存缺陷。
4. **U3 兼容处理细致**：`DraftSubmission` 增补 epoch/operationId 而非另起炉灶；"核对终态只解冻对应修订"与 U3 的修订号防 ABA 设计衔接自然；退出确认合并 dirty+running 时不冒充、不漏保护。
5. **tasks 质量延续 U3 水准**：每项 ≤2h、验收引用具名场景、负面断言明确（"不以 build 替代 6.x""不能给生产接口保留无身份后门""禁止只测纯 reducer"）。
6. **运行时 settings 不参与请求同一性**（D2）：重复请求不能因配置改变而重新执行——与"同 ID 重复请求只执行一次"场景中的 WHEN 子句一致，避免了指纹与业务门禁的循环依赖。

## 四、问题与建议

### B1（文档已修订，性能待实测）：完整快照与轮询成本

全量快照的成本随会话记录数增长，但本轮未做性能测量，不能断言数百次操作已有可感知开销。原建议按 renderer 关联裁剪终态会影响重载恢复，故本阶段保留全部操作的受限元数据（含 settled/notAccepted）；registryVersion 只用于乱序守卫，不引入增量协议。D4/D6 与任务 1.2/4.5 已明确响应完成后计时、不重叠、无 running 或失联停止自动轮询，并在 100/1000 条摘要下测量字节数、main 构造、IPC 往返与 renderer 校验耗时。若实测需要增量/分页，须先修订完整同步、游标恢复和封禁保留契约。

同时纠正查询职责：`reconcile` 按 epoch/operationId 核对操作事实；用户按可信 runId 打开记录仍经既有详情接口与版本守卫，不能用 reconcile 代替文件读取。已同步至 desktop-ui 规范及任务 4.7。

### B2（文档已采纳，测试待实施）：指纹与执行共用解析快照

D2 已明确指纹与编排业务参数来自入口同一次 schema parse 的不可变快照；禁止回用原始 payload、重新补出不同缺省值或生成指纹后修改嵌套字段。包层允许显式映射与既有领域校验，不要求函数间对象引用相等。新增 desktop-ui 场景「指纹与执行使用同一解析快照」，任务 1.3/3.7 要验证缺省值、转换/未知字段处理、修改尝试后的实际参数及真实调用次数，不能只断言引用相同。业务快照不进入长期 registry，敏感数据保留边界不变。

### B3（记录）：轮询初值 1 秒无校准依据

1 秒为初始经验值。实施 4.5 按 D6 测量不同记录规模与高负载下的开销后校准；无论间隔如何调整，均保持单路、不重叠、失联停止及手动核对。当前没有性能通过结论。

### B4（源码已核实，回归待实施）：隔离路径的最终身份观察

已确认 [checkpoint-tracer.ts](../../../packages/replay/src/workspace/checkpoint-tracer.ts) 的 `startRun` 先将 id/world_id 替换为最终隔离 ID，再调用 `delegate.startRun(injected)`；`subscribe` 直接转发到底层。[tracer.ts](../../../packages/trace-sdk/src/tracer.ts) 的 `startRun` 在 `onMeta` 完成后才发出 `run.meta`，符合 D5 的观察方案。任务 2.2/2.3 仍须验证订阅早于首写、仅报告最终 ID、meta 前失败无 ID、后续失败保留 ID，以及观察异常隔离和订阅清理。源码可行性不代替这些测试。

### B5（记录）：任务量与串行依赖

48 项任务（1.x×7 / 2.x×10 / 3.x×8 / 4.x×9 / 5.x×4 / 6.x×8 / 7.x×2），显著大于 U3。1.x（registry）与 2.x（包层身份回调）没有整组硬串行依赖，两者汇合到 3.x 全入口接线，再完成 4.x renderer 和 5.x 关闭保护；6.x 完整实机验收依赖相应实现完成。任务组顺序可作为集成安排，实施时按实际依赖推进。

## 五、评审方法与限制

- 逐条核对了 proposal Why 与 design Context 的全部源码断言（见第一节），并复查了主 spec 47 条 requirement 标题确认无未列出的语义冲突。
- 脚本化双向核对了 delta 场景与 tasks 验收引用。
- 运行了 `openspec validate add-desktop-operation-tracking --strict`：通过。
- 本评审不构成功能验收证据；实施与实机验收以 tasks 6.x/7.x 及 evidence-index 为准。
