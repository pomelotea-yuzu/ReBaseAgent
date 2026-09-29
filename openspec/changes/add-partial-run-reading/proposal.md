# U6：缺父链的只读详情

## Why

U1–U5 已归档。当前 `runs:get` 对普通 result 分支直接调用 `resolveBranch`，任一祖先文件缺失都会让整条详情不可读；prompt 和代理路径虽然只展示自有 spans，却会静默截短来源链，renderer 无法区分“完整链”与“祖先确实缺失”。`RunDetail` 也没有完整性、span 来源范围或结构化缺失原因，因而不能安全地展示已校验的当前记录，也不能让执行入口可靠地拒绝来源不完整的父本。

本 change 对应 [U 拆分计划](../../../docs/engineering/plans/2026-09-21-ui-change-split-plan.md) U6、[UI 方案 V0.2](../../../docs/engineering/plans/2026-09-19-ui-layout-discussion.md) §18.4，以及 V0.1 自审 P2-3。以 U5 归档后的 `desktop-ui` 59 requirements / 278 scenarios 为基线起草。本轮只编写 change 文档，未实施代码或重新执行 GUI 验收。

## What Changes

- 扩展 `runs:get` 的受校验详情信封，固定 `completeness`、`spanScope`、`lineage` 和 `leafSpanIds` 的语义；完整结果与部分结果使用同一响应形状。
- 先完整校验当前 run，再按原有分支语义读取祖先。只有结构化确认祖先文件不存在时，才返回当前 run 的已校验自有 meta/spans/events/status，并附带从当前 run 向上连续可读到缺失点的来源链和缺失 run ID。
- 普通 result 仅在祖先链完整时合并共享前缀；prompt、代理 messages 和 `model_params` 维持从头执行/自有轨迹语义，即使链完整也标为 `spanScope: own`，不把 own 误当成降级。
- 概览、步骤、来源区域和分支入口显示“仅显示本运行记录，父链不完整”及可确认的缺失原因；自有输出、步骤和自有消耗仍可读，继承前缀和祖先增量显示未知。
- 五类引用父本的主动入口（普通/隔离 result、prompt、proxy、A/B）在 U4 判重、占槽之后，由 main 重新读取并检查来源；不可读或 `ownOnly` 均在业务副作用前拒绝，登记仍按 `settled/rejected` 收口。普通/隔离 create 无父本，保持原契约。UI 禁用不能替代 main 门禁。
- A/B dry-run 与隔离 capability 复用来源判据：不完整时返回不可执行原因，不产出有效计划/许可，不占操作槽。父文件恢复不复活旧确认，用户须重新检查后以新 operationId 提交。
- U5 按可信 ID 核实自有终止事实、修订匹配才清理草稿、失败定位和导航意图规则继续生效；`ownOnly` 的自有正常终止可以参与原清理判定，来源缺失提示同时保留，不将来源完整性等同于运行成败。
- 父文件恢复后，重试详情必须重新完成整条链的版本、schema、跨行和分支定位校验，成功后才切回 `complete`；读取始终只读，不修补 trace、不从当前源目录补历史。
- 实施与验收分读取诊断、契约、repository、详情与 U5 收尾、执行门禁、受控实机、证据核对七段；逐场景登记实际证据及未验证限制，不能以文档校验或按钮禁用代替行为验收。

## Capabilities

### New Capabilities

无新增 capability 目录。

### Modified Capabilities

- `desktop-ui`：新增缺父链的结构化只读降级、完整性展示、统一来源诊断和来源不完整执行拒绝；修改分支详情的合并/自有范围语义及详情 IPC 数据契约。

## Impact

主要影响 `RunRepository`、`runs:get` 的 shared/preload schema、详情读取与版本守卫、renderer 的概览/步骤/来源链/文件入口/读取重试、五类主动执行入口门禁，以及 main 的执行前置检查。复用现有 `readRun`、`resolveBranch`、`leafSpanIds`、`RunDetailSchema` 和 U5 的结果读取/操作关联；新增字段只服务详情完整性，不写入 JSONL、不改变 trace-format。

实现需要在桌面读取适配层把“祖先文件不存在”和其他读取失败建模为不同诊断，不能通过匹配异常字符串放行。普通 result、隔离 result、prompt、代理和 model_params 必须共用同一完整性判据，同时保留各自已有的执行门禁与轨迹语义。完整普通 result 的 v1 span 截断、隔离 result 的 v2 整轮截断分别回归；混合来源链逐 hop 区分独立执行与共享前缀，不修改 replay 包的执行解析来迁就只读展示。

## Non-goals

- 不修复、改写或拼接缺失的 trace，不从当前源目录、列表缓存或附件目录补造祖先历史。
- 不放宽 trace v1/v2、schema、版本、权限、跨行、成环或 fork 定位校验；不把未知错误通用 catch 成 ownOnly。
- 不让 `ownOnly` 获得 result/prompt/proxy/model_params 的任何执行资格，不新增执行、真实取消、自动重试或结果比较能力。
- 不接受祖先步骤作为 U2 文件检查点，不改变 C 文件接口的当前 run 自有清单限制；U7 的双运行比较继续独立实现。
- 不新增持久化字段、JSONL 迁移、网络依赖或 UI 框架；不在本 change 内实施、打包、发布或归档。

## 保真度边界

读取详情、恢复父文件后的重验和完整性提示均为本地只读操作，零模型/工具调用、零 trace/blob/source 写入。`ownOnly` 只呈现当前文件中经完整 reader/schema/跨行校验的事实；祖先输出、共享前缀、祖先消耗和无法核对的编辑原值均为未知，不补零、不推断。已有可信自有终止事件仍可用于展示该 run 的结局，但不代表父链完整或可执行。

## 验收口径

实施阶段必须用 fixture 和受控 Electron 场景覆盖：各类分支缺祖先、缺当前 run、祖先损坏、未来版本、v1 非法隔离字段、成环、非法定位、正常完整链、父文件恢复；逐项核对返回字段、界面文本、执行零调用/零写入、只读不变和重试后完整合并语义。文档校验通过不等于功能验收通过。
