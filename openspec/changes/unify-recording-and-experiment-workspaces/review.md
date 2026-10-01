# U8 起草自检

日期：2026-10-01。本文件记录本轮文档自检，不代表独立评审、实施或实机验收通过。

## 基线与范围

- HEAD `d53b7d0` 已完成 U7 归档，起草前 OpenSpec list 为零活动 change；本次无需重复归档 U7。
- 实测主 spec：desktop-ui 70 requirements / 351 scenarios，model-experiments 13 / 43，llm-proxy 6 / 19。
- 对照拆分计划 U8、UI 方案 §11/§15.4/§16、U3/U4/U5/U6/U7 已归档契约及实际代码；同步拆分计划的 U7 归档状态和 U8 待实施链接。
- 仅修改本 change 与拆分计划；未改产品代码、主 spec、包能力或 HANDOFF.md，未执行 push。

## 代码事实与设计约束

1. `ProxyManager.toggle` 先保存配置再替换服务，端口占用可能已保存 enabled=true；状态分层和失败回读明确承认这一事实，修正旧“开关自动回停用”的界面承诺。
2. ProxyState 只含 enabled/running/port/upstreamBaseUrl/hasKey，没有监听地址、连接测试或最近请求契约；地址从已核实 port 构造，应用在飞/未知时不可复制，不新增仪表。
3. `proxy:toggle` 经过 main 配置锁而不登记主动操作；被动录制不占主动槽，messages 重发仍走已登记的 proxy:fork。停用时 key 可能仍在，但 handler 不在，hasKey 单独不能放行。
4. 现有 ModelAbEditor/MessagesForkEditor 位于 DetailPanel 内，草稿和操作事实已存在；迁移需补全局草稿返回、导航意图与复位表，不能另建一套编排。
5. 桌面 modelAbPlan 仍要求已配置 settings；CLI 无 apiKey 预览能力不变。dry-run 需读取父本，旧场景“不读写 trace”修正为只读校验且不改写/创建运行，保留零模型调用。
6. ModelAbResult.ids 只含成功臂，完整身份来自 operations.arms/target.armCount；dry-run experimentId 不作为真实批次标签。U7 标签仅分组且不豁免实验比较资格。
7. 计划失效绑定配置变更代次，涵盖只轮换 key 及保存后回读失败，不读取 key 值；修改再改回、乱序预览、放弃重建与离开恢复都有明确场景。

## Delta 差集

| Capability | MODIFIED | ADDED | Delta 场景 | 保留旧场景 | 新场景 |
|---|---:|---:|---:|---:|---:|
| desktop-ui | 3 | 6 | 51 | 14 | 37 |
| model-experiments | 2 | 1 | 16 | 6 | 10 |
| 合计 | 5 | 7 | 67 | 20 | 47 |

5 个 MODIFIED 名称与当前主 spec 精确匹配，携带完整最终 requirement，20 个旧场景名全部保留；7 个 ADDED 名称不与主 spec 重名。47 个新场景均有精确任务引用，包括 MODIFIED 中新增的场景，不只统计 ADDED 区块。

有意修改的原行为：

- 代理设置 requirement 从设置分区改独立录制工作区，启用场景通过设置跳转；占用错误从伪回滚改保留输入及已保存/监听事实分层。
- messages requirement 改为通过自有调用入口进入主工作区，原重发、空 fork、凭据及非代理拒绝保持。
- 设置 requirement 不再维护代理未应用字段和重复表单，模型未保存保护及单向密钥保持；原录制入口场景改为真实工作区跳转。
- 实验分组 requirement 去掉 ComparePanel 组件绑定；三臂先进入指标表再选两条，experimentId 仍仅分组，不参与资格或 config_hash。
- 成本 requirement 明确针对当前有效计划确认；无密钥 dry-run 场景允许必要的父本只读校验，继续零 provider 调用、零写入。其他参数、工具、执行和 CLI 规则保持。

## 检查结果

- `openspec validate --all --strict --no-interactive`：13 passed / 0 failed；既有长 requirement 提示为 INFO。
- `openspec status --change unify-recording-and-experiment-workspaces --json`：proposal/specs/design/tasks 均 done，仅表示规划材料齐全。
- 结构核对：MODIFIED 基线/旧场景保留、ADDED 重名、新场景任务映射、所有显式任务场景名、文档相对链接、空白和冲突标记通过。辅助回查脚本 `.rebaseagent/u8-verify-docs.cjs` 为本地过程文件，不作为产品测试。
- 共 52 条任务，全部未勾选；fixtures 和行为反证分拆，单条实现不超过 2h，实际超出时继续拆分。
- `git diff --check` 通过；未跟踪文档额外检查空白和冲突标记，提交前再检查 staged diff。

本轮未运行产品测试、构建或 Electron，未产生功能交付证据。evidence-index 在任务 1.1 建立，所有实现与实机场景仍待验证；历史 U4/U5/U7 环境限制及欠账不在本次文档阶段自动清零。归档与发布另按实施后的真实证据决定。
