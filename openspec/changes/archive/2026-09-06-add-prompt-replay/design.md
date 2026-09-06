# Design: add-prompt-replay

## 1. 核心语义：独立新轨迹，保留父级溯源

tool_result replay 的关键是“父前缀 + 子增量”。prompt fork 改变了启动上下文，不能复用父轨迹中的任何 span。实现采用：

父 run（只读）
  └─ prompt fork 元数据（parent + fork.edit）
       └─ 新 run：从第 1 个 agent.step 开始完整记录

新 run 仍然写 meta.parent，让分支树保留探索关系；但详情读取必须依据 fork.edit.field 判断该分支是否具备共享前缀。field 为 system_prompt 或 user_message 时，返回本 run 自身完整 spans，并在 chain 中显示父级溯源，不调用 resolveBranch。

这样可以同时满足两个不变量：JSONL 只追加新文件、父 run 不变；以及“共享前缀只在确实共享时才呈现”。

## 2. 支持范围

### 2.1 编辑目标

- system_prompt：取父 run 首次 llm.call.request.messages 中的第一条 role=system 且 content 为字符串的消息。
- user_message：只允许父 run 首次 llm.call.request.messages 中的第一条 role=user 且 content 为字符串的消息。
- 消息内容限定为字符串。多模态对象、消息数组重排、角色修改、工具消息修改均拒绝。
- 一次 fork 只允许修改 system_prompt 或 user_message 其中一个字段。组合实验通过连续 fork 实现，确保每条边只表达一个变量变化。
- 字符串 system 消息是整个 prompt fork 的前置条件：desktop 必须用它重建 RunConfig.systemPrompt。缺失时两种编辑均拒绝；config_hash 不可逆，不能作为 prompt 内容来源。

### 2.2 新 run 的输入

从父 run 首次 llm.call.request.messages 深拷贝启动 messages，替换选中的启动消息；对 system_prompt 同步更新本次 RunConfig.systemPrompt，保持 config_hash 的输入与首次真实请求里的 system 消息使用同一个编辑值。对 user_message 只替换 messages 中对应消息。

如果父 run 没有可还原的首次请求，或启动上下文不满足上述约束，先拒绝，不创建文件。

## 3. config_hash 与 fork 元数据

- 新 run 的 config_hash 由新 system prompt + 原工具表重新计算。
- fork.edit.field 使用自由字符串：system_prompt 或 user_message。
- fork.edit.value 保存编辑后的字符串，沿用现有 trace schema，不增加格式版本。
- at_span 固定为父 run 展开轨迹中的首次 llm.call id；被编辑的 system prompt 与首条 user message 均来自该 span 的 request.messages。
- prompt fork 不要求新 hash 与父 hash 相等；但必须在 UI 和详情中明确显示“配置指纹已变化，这是新实验”。
- 连续 prompt fork 合法：第二次 fork 从直接父 run 自身的首次 llm.call 还原启动 messages，并以该父 run 的 config_hash 作为来源事实。

## 4. 编排 API

新增独立入口（名称可在评审后调整）：

    interface PromptForkEdit {
      field: "system_prompt" | "user_message";
      value: string;
    }

    interface PromptReplayRunOptions {
      parentId: string;
      edit: PromptForkEdit;
      config: RunConfig;
      tools: Tool[];
      load: RunLoader;
      outDir: string;
      llm?: LlmClient;
    }

编排顺序：

1. 沿 parent 链加载父 run，检测成环和缺失。
2. 要求叶 run 已封存、存在 config_hash、首次请求含字符串 system 消息，并拒绝 proxy 来源。
3. 从叶 run 自身的首次 llm.call 还原启动 messages，验证编辑目标、字符串类型与单字段约束。
4. 拒绝编辑前后相同的空 fork。
5. 计算新 config hash，构造 forkRun 元数据，创建新 tracer。
6. 从第 1 步调用 runLoop，新 run 的 spans 全部落在新文件。

现有 replayRun 保持 tool_result 专用，以便其 config_hash 同源校验和 deriveReplayState 的类型继续收窄。若需要共用加载父链逻辑，应抽取无语义的内部 helper，不把两种 fork 合并成一个宽泛的“任意编辑”入口。

## 5. desktop 读取与 UI

### 5.1 详情读取

在 RunRepository.getRun 中新增判断：

- fork.edit.field === result：保持现有 resolveBranch 共享前缀展示。
- fork.edit.field === messages 且来源为 proxy：保持现有 proxy 父链列表语义。
- fork.edit.field === system_prompt 或 user_message：返回当前文件完整 spans，不拼接父文件；chain 仍列出父级溯源。

### 5.2 编辑入口

在 run 详情的启动上下文区域提供两个明确入口：编辑 system prompt、编辑初始 user message。编辑器提交前：

- 显示原值与当前值是否改变；
- 显示“从头重跑，将真实调用模型并计费”；
- 显示“父 run 只作对照，不会修改”；
- 未配置运行参数、缺少字符串 system 消息或父 run 不可用时，在本地校验阶段阻止提交。

提交后使用新的 IPC 写通道（名称待定，如 runs:promptFork），成功后刷新 run 列表并选中新 run；失败时不留下半文件。

### 5.3 分支树

边标签映射扩展为：

- result → 改 tool_result
- messages → 改 messages
- system_prompt → 改 system prompt
- user_message → 改 user message

prompt fork 节点可参与现有 run 级对照。“本 run 增量”只来自新 run 自身完整执行；“累计增量（沿链求和）”是父 run 花费与这次独立完整运行花费的代数和，不是一次连续执行的消耗。详情不将父 run 的 spans 加入 prompt fork 的轨迹。

## 6. 保留的稳定性约束

- 不修改 buildRequestBody 的字段顺序、消息序列化和前缀稳定性实现。
- 不把 prompt 编辑写回父 JSONL；新值只进入新 fork 文件的 meta 和本次实际请求。
- 不在 renderer 直接读文件；所有数据仍经 preload / IPC / zod。
- 所有计数和成本仍从新 run spans 现算，不增加缓存或累计字段。
- 工具失败仍是 tool_result 数据；副作用工具仍按当前 agent-loop 权限执行。

## 7. 测试策略

- packages/replay：启动 messages 替换、首条 system/user 定位、空 fork、非法目标、缺失首次 llm.call、proxy / 无 config_hash 拒绝。
- packages/trace-sdk：旧 fork 字段继续通过；新 field 值可读；非法空 field 拒绝。
- apps/desktop：prompt fork 详情不调用 resolveBranch、分支树标签、IPC envelope 和失败不落盘。
- 端到端 mock：父 run → 修改 system prompt → 新 run 从 agent.step n=1 开始，父文件字节不变，新的 config_hash 与父不同。
- 双真相源守护：修改 system prompt 后，config_hash 使用的新值与新 run 首次 llm.call.request.messages 中的 system content 完全一致。
- 连续 fork：以一条 prompt fork run 为父再修改首条 user message，第二条分支从直接父 run 自身的首次 llm.call 还原上下文，不混入祖先 spans。
- GUI 冒烟：打开 prompt 编辑器 → 修改并确认 → 分支树看到 prompt 边 → 打开新 run 确认没有父旧 spans 混入。

## Risks / Trade-offs

- 无法复用前缀，成本可能高：这是 prompt 变化的诚实语义；先保证正确性，再由 provider cache 和后续 A/B 能力优化。
- 首条 user 消息的定位可能不适配复杂 Agent：先收窄到可验证范围，后续可扩展为启动消息选择器。
- 父 metadata 与完整新轨迹同时存在可能让用户困惑：详情必须显式显示“父级溯源”与“本次完整执行”两种关系，禁止复用“共享前缀”文案。
- 旧消费者可能把所有 parent 都当成可拼接分支：读取层按 fork field 分流；分支树只依赖摘要标签，不主动拼接 spans。

## 已确认决策

- at_span 使用首次 llm.call 的真实 span id；UI 显示“从头重跑”，不显示普通分叉点标签。
- 一次只修改一个字段，连续 fork 表达组合实验。
- trace 缺少字符串 system message 时拒绝整个 prompt fork，因为 RunConfig.systemPrompt 无法从 config_hash 或桌面设置还原。
- prompt fork 保留 parent，但不经过 resolveBranch。
