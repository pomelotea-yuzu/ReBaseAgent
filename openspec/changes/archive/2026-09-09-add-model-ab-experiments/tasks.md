# 任务

- [x] 1.1 将 replay 的 PromptForkEdit 扩展为 system_prompt、user_message 和组合 model_params；value 增加可选 experimentId 与 allowSideEffects；新增 zod 校验、有限数值 params、空编辑与禁止注入字段。
- [x] 1.2 抽取 prompt fork 共用的父链/首次 llm.call/配置校验，保留 proxy、未封存、缺 config_hash 和零文件零调用门禁；新增"首次请求必须含字符串 system 消息"前置条件。
- [x] 1.3 增加 model_params 派生状态：深拷贝父 run 首次 messages，覆盖 model/params；保持 tools 与父录制定义逐字段一致（含 sideEffect 有无），父 params 缺省视为空对象。
- [x] 1.4 实现双真相源"先校验后覆写"：不等即拒绝，相等时才执行既有覆写；为 replay 与桌面新增对应测试。
- [x] 2.1 实现 modelReplayRunMany：至少两个 arm、同一直接父 run、独立 tracer/client/messages/AbortController（父 signal 级联），顺序执行并隔离单臂错误。
- [x] 2.2 接入完整 RunConfig 构造与校验：baseURL/apiKey 来源、cwd、maxIterations=10 默认、maxTotalTokens=100000 默认、params 为 Record<string, number>。
- [x] 2.3 增加副作用门禁：默认所有工具必须 sideEffect=false；任一工具有副作用时在创建文件和调用模型前拒绝整个实验，错误文本指明触发工具与首期边界；allowSideEffects 全部为真时放行并把声明写入 fork.edit 供审计。
- [x] 2.4 增加 dry-run、--confirm-cost、每臂独立 AbortController、重复执行新 run id 和 provider/工具/预算错误隔离；不自动重试。
- [x] 2.5 实现 experimentId 分批：调用方传入或自动生成，同批 arm 必须相同，随 edit value 落盘。
- [x] 3.1 扩展桌面 promptFork IPC 的 field/value schema 与 main runner，复用 settings 的单一 baseURL/apiKey，renderer 永不接收 apiKey。
- [x] 3.2 在现有 prompt fork UI 增加 model/数值 params 组合编辑、双臂以上选择、费用确认、dry-run/错误状态和副作用提示；含逃生舱确认与"顺序执行可能互相影响"警示徽标。
- [x] 3.3 复用现有分支树与 ComparePanel 展示 A/B；按 experimentId 分组并默认配对同批 arm，补充 model_params fork 标签；只展示各臂相对父 run 的累计增量，不新增臂间差值或第二套指标派生。
- [x] 4.1 为 replay 编排和纯函数增加 fake-client 测试：合法组合、先校验后覆写、config_hash 不变、工具表逐字段一致、sideEffect 拒绝与逃生舱留痕、工具 handler 对齐、缺 system 消息、父 params 缺省、experimentId 分批、空 fork、每臂独立取消和失败隔离。
- [x] 4.2 为桌面 IPC/renderer 增加 schema 与冒烟测试（含同批分组显示）；验证旧 system/user prompt fork、tool-result replay、proxy fork 不回归。
- [x] 4.3 在 packages/replay 增加独立 bin `rebaseagent-model-ab`（不与 rebaseagent-trace-test 合并）：CLI 离线 dry-run 不需要 key，首期仅支持空工具表并在父 run 带工具时提示改用桌面端；真实执行要求 REBASEAGENT_API_KEY 和 --confirm-cost，退出码保持 0/1/2。
- [x] 5.1 修正 spec 格式并运行 `openspec validate --all --strict`；同步 proposal/design/spec/tasks 的路线、Non-goals 和验收门禁。
- [x] 5.2 运行 replay、agent-loop、desktop 包测试、Biome、双端 TypeScript、electron-vite build，并记录真实 provider smoke 仅需用户凭据、不进 CI。
