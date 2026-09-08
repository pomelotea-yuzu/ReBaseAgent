# 增加 Trace-as-Test 运行时回归测试

## Why

V2 已记录完整 Agent trace，但 trace 还只是人工调试资产。V3 需要用已记录的 LLM 响应和工具结果作为卡带，在当前 agent-loop 与当前工具声明下重新执行，从而检验运行时 harness 是否发生回归。

## What Changes

- 增加独立 JSON 测试定义，引用已封存 trace 并声明结构化断言。
- 增加无 Electron 的卡带 LLM client、记录工具表和 headless `runLoop` 编排。
- 默认对新产生的 span 做结构性轨迹对齐，并支持 run outcome、span 选择器、字段和数量断言。
- 配置 hash 漂移不阻止测试，但必须在结果和报告中显式标记；当前工具声明来自用户代码，而非 trace 或测试文件。
- 优先提供 Vitest/Jest 可调用 API，CLI 作为 CI-only 入口和调试工具。
- 提供稳定文本/JSON 报告、明确退出码和 trace 脱敏警告。

## Non-goals

- 不实现模型 A/B、live provider 测试或新的分支树语义；这些属于后续 V3b。
- 不修改 trace v1 JSONL 格式，也不修改既有 replay 的 `config_hash` 门禁。
- 不默认执行真实文件、数据库或网络副作用。
- 不把代理录制 run 当作可卡带重跑对象；代理 run 仅支持明确标注的静态断言。
- 不把全文 snapshot 作为默认断言，也不做 V4 级桌面可视化重构。

## 保真度边界

卡带模式冻结 LLM 响应，验证的是当前 agent-loop/harness 的工具分发、消息构造、终止条件、预算和错误路径，不验证新 prompt 或真实模型行为。配置漂移必须可见，不能被描述为模型回归结论。外部副作用不可回滚；world-free 卡带只返回记录结果。

## 影响范围

- 新增无 Electron 的测试编排模块、测试定义 schema、断言结果模型和 runner 集成 API。
- 新增 CLI 报告和退出码约定。
- 更新 README/HANDOFF 的 V3 状态、隐私警告和使用方式。

