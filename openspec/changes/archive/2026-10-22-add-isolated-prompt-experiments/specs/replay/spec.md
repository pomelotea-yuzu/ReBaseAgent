## ADDED Requirements

### Requirement: 隔离 prompt 构成独立执行边界且可继续 result 续跑

v3 隔离 prompt SHALL 作为独立完整执行读取，父链仅溯源，SHALL NOT 通过 resolveBranch 混入根 spans。合法已封存 v3 run SHALL 可作为既有隔离 result 续跑的直接父，仍只接受自有工具点、整轮文件检查点、完整 profile/config_hash 和当前写入授权。result 子 run SHALL 继续写 v2；前缀解析 SHALL 截止在 v3 自身对应整轮，不穿过独立边界继承根执行。普通 replay 与隔离 model_params SHALL 保持原拒绝边界。

#### Scenario: v3 详情只呈现自有完整步骤
- **WHEN** 根与 v3 子都含 s_01/第 1 步，读取完整详情或 ownOnly 详情
- **THEN** 子时间线只有自身步骤与文件事实，来源链另列，重复 span ID 按 owner run 区分，不把父第 1 步加入子执行

#### Scenario: v3 后的 result 分支保留正确前缀
- **WHEN** 从 v3 自有第 2 轮工具结果合法隔离续跑
- **THEN** 子写 v2，从 v3 第 2 轮轮末文件开始，保留同轮兄弟工具结果，读取前缀只含 v3 对应自有执行，不执行或拼入实验根的历史步骤

#### Scenario: 新版本不扩大普通执行和卡带权限
- **WHEN** 对 v3 使用普通 replay/prompt、隔离模型实验，或生成 trace-test 卡带
- **THEN** 不受支持的执行路径明确拒绝；卡带仍仅录制结果/桩工具，不真实读写文件世界；既有删除子分支保护与来源门禁不因版本变化失效
