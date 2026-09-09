# 设计

## 1. 路线选择

采用扩展现有 prompt fork 的路线，不创建独立 `ExperimentRecord`。理由是 A/B 分支本质上仍是“从已封存 run 的启动上下文从头重跑”，现有 `promptReplayRun` 已提供父链加载、封存校验、config_hash 存在性校验、零文件零调用前置拒绝、JsonlTracer 落盘和 `ForkRunMeta` 注入。复用这些语义可让分支树和 `deriveComparison` 使用同一共同祖先判据。

本 change 允许一次组合编辑 `model + params`。组合值作为一个 `fork.edit` 记录，避免一次实验产生两个无法区分先后的 fork；trace v1 的 `ForkSchema.edit.field` 已是自由字符串、`value` 已是 unknown，无需 schema 迁移。

放弃 `ExperimentRecord` 的代价是实验清单不再单独落盘，同一父 run 连续做多次实验会产生多个同父兄弟 run，无法区分"哪两个 arm 属于同一批实验"。因此在 edit value 内携带可选 `experimentId`（纯展示与分组用途，不参与任何校验或 hash）：UI 用它分组并在 ComparePanel 默认配对，缺省时退化为手选。这是复用既有 fork 语义所需补的唯一元数据。

## 2. 新编辑契约

在 replay 包新增模型实验编辑类型：

```ts
type ModelParamsEdit = {
  field: "model_params";
  value: {
    model: string;
    params?: Record<string, number>;
    /** 同一批实验的分组标签（可选）：仅供 UI 分组与默认配对，不参与校验与 hash */
    experimentId?: string;
    /** 显式确认允许带副作用的工具（可选）：见 §4 门禁 */
    allowSideEffects?: boolean;
  };
};
type PromptForkEdit =
  | { field: "system_prompt" | "user_message"; value: string }
  | ModelParamsEdit;
```

`model_params` 的 value 必须通过 zod 校验：model 非空，params 的每个值为有限 number，至少有一项配置实际改变；不得携带 baseURL、apiKey、cwd、工具表或 budget。 `ForkSchema` 原样记录 `{ at_span: <父 run 首次 llm.call>, edit: { field: "model_params", value: ... } }`。

`experimentId` 与 `allowSideEffects` 原样落进 fork.edit：前者让多批实验可区分，后者让"带副作用执行"这件事可审计——事后从 trace 就能看出这次实验是在用户确认下放宽了门禁。

模型编辑不改变启动 messages 或 system prompt，因此新 run 的 `config_hash` 必须与父 run 相同。若调用方同时传入不同 system prompt/tools，编排层拒绝，不把模型实验伪装成 prompt fork。

注意 `configHash` 把工具的 `sideEffect` 字段计入指纹（`config-hash.ts`），且"字段缺失"与"显式 false"是两种不同输入：调用方必须与父 run 录制的工具表逐字段一致，不能自作主张补齐或删除 `sideEffect`。这同时堵死了"给 `write_file` 补标记以绕过副作用门禁"的路径——补了就会 hash 不一致被拒。

## 3. 复用和配置构造

新增通用的 replay 配置覆盖层，供 `promptReplayRun` 和模型实验共用：

1. 加载直接父 run，并复用 `assertForkable`、proxy/config_hash/首次 `llm.call` 校验。
2. 从父 run 首次 `llm.call.request.messages` 深拷贝启动 messages；不从 `config_hash` 反推 system prompt，也不另建 `systemPrompt` 真相源。
   2a. **父 run 首次 `llm.call` 必须含字符串 system 消息**（既有 prompt fork 的隐含前提）。缺失时前置拒绝——否则"当前 systemPrompt 与 messages 一致"这条校验无从执行。
   2b. **先校验后覆写**：比较 `config.systemPrompt` 与派生值，不等即拒绝；相等时再执行既有覆写（`{ ...config, systemPrompt: state.systemPrompt }`），此时覆写等价于无操作，既有 prompt fork 行为零变化。直接沿用覆写会让不一致永远被悄悄抹平，该校验形同虚设。
3. 调用方提供完整当前 `RunConfig` 与含 handler 的 `Tool[]`。完整配置必须满足现有 schema：`baseURL`、`apiKey`、`model`、`systemPrompt`、`tools`、`params`、`exec.cwd`、`maxIterations`、`budget`。
3a. **"同源"只硬约束 systemPrompt 与工具表**（它们决定 `config_hash`，必须逐字段与父一致）；`maxIterations`、`budget`、`exec.cwd`、`baseURL`/apiKey 无法从 trace 反推（run meta 只录 `budget.max_total_tokens`），只能由调用方提供并取入口默认值——臂间取同值即保证公平，不必与父相同。
4. 桌面端从 main 的 settings 读取唯一 baseURL/apiKey；CLI 从显式环境变量 `REBASEAGENT_API_KEY` 读取 apiKey。key 只进入 `RunConfig`，不进入 edit value、日志或错误文本。
5. 工具定义必须与 `config.tools` 一一对应并含 handler。默认要求所有工具 `sideEffect === false`；缺失标记按现有 ToolDef 语义视为有副作用并拒绝（唯一的例外是 §4 的显式逃生舱）。V3a 的 StubToolTable 只用于卡带测试，不可用来宣称真实工具结果。

**可用性边界（必须让用户知道）**：桌面内置工具只有 `read_file`（`sideEffect: false`）与 `write_file`（true），而真实 trace 里 `write_file` 往往连标记都没有（`.rebaseagent/traces/` 实测如此），因此首期默认门禁下**只有全程未使用 write_file 的 run 能做 A/B**。这不是缺陷而是诚实的边界，但必须在拒绝错误里说明原因与替代路径，而不是丢一个笼统的"工具不允许"。

`maxIterations` 默认沿用桌面 fork runner 的 10；`budget` 默认使用 `maxTotalTokens: 100000`。这些只是入口默认值，仍在生成 RunConfig 前经过 `parseRunConfig`；调用方可显式覆盖。 `exec.cwd` 使用父运行配置/桌面工作目录，CLI 必须显式提供 `--cwd` 或等价配置。父 run 首次请求未录制 `params` 时，其 params 视为空对象，arm 提供任何数值参数都算"实际改变"。

## 4. 多臂执行语义

新增 `modelReplayRunMany`（名称可在实现阶段按仓库命名约定调整）接收一个父 run 和至少两个 `ModelParamsEdit`，顺序执行每个 edit：

- 每个 arm 使用独立深拷贝的 messages、独立 tracer、独立 LLM client、独立 `AbortController` 和新 run id；各 controller 挂到同一个父 signal 上级联取消，已完成的 arm 不被后续取消误伤。
- 默认顺序执行，保证纯工具实验的确定性；任一 arm 失败只记录该 arm 的错误并继续其余 arm。
- arm 之间不共享父 run 之外的运行时状态；工具若不是 pure，前置阶段直接拒绝整个实验（除非显式逃生舱），避免顺序执行造成系统性偏差。
- **副作用逃生舱**：只有当每个 arm 的 `allowSideEffects` 均为 true 时才放行带副作用的工具，且该声明随 edit value 落进 fork.edit 供审计；UI/报告在该实验的 fork 上标注"含副作用工具、顺序执行、外部状态可能已被前一臂改变"。逃生舱只放宽执行门禁，**不改变比较判据**——既不新增 degraded 状态，也不改写 `deriveComparison`。
- 所有 edit 先完成字段校验、空编辑检查、父链校验、system 消息检查和工具策略校验，再创建第一个 tracer 或发起网络请求。校验失败保证零新文件、零调用。
- 一次调用即一批实验：调用方可传 `experimentId`（缺省时编排层生成一个），同一批内所有 arm 必须相同，不同批允许对同一父 run 连续 fork。每个 arm 的直接 parent 都是同一父 run，`fork.edit.field` 为 `model_params`。重复执行产生新的 run id，不覆盖旧文件。

## 5. 比较和 UI 语义

不新增比较算法。现有 `deriveComparison` 通过共同祖先判定可比，并以 `deriveChainTotals` 派生 tokens/duration 增量；模型实验分支天然共享父 run，因此 ComparePanel 可直接消费。UI 只需：

- 允许用户在同一父 run 上选择至少两个 model/params 编辑，显示当前 settings 的 baseURL/provider。
- 在确认处显示每个 arm 的 model、params、预计调用臂数、工具策略和“将真实调用模型并可能产生费用”的提示。
- 显示每个 fork run 的状态、model、tokens、耗时、工具轨迹和**相对父 run 的累计增量**；原始内容不截断，长内容折叠。措辞沿用既有纪律：沿链数字一律称“累计增量”，禁用“总耗时 / 总成本”。
- **不提供臂间差值列**：`deriveComparison` 只有各臂相对共同祖先的增量，A 与 B 谁减谁需要用户判断基线，本 change 不引入基线臂概念。UI 按 `experimentId` 分组并默认配对同批 arm，避免用户在一堆同父兄弟里手工挑选。
- 对副作用工具（含逃生舱下的警示）、跨 provider、父 run 不可 fork、缺少 system 消息、空编辑和未配置 key 显示明确错误，不显示伪造的配置指纹。

IPC 复用既有 `promptFork` 请求/响应形状并扩展 field/value schema；renderer 不接触 fs 或 apiKey。 `runs:list`、`getRun`、分支树和 ComparePanel 继续使用既有数据通道。

## 6. CLI 与成本

CLI 以新增 bin `rebaseagent-model-ab` 暴露，归属 `packages/replay`（该包目前无 bin 字段）。它与 V3a 的 `rebaseagent-trace-test` 语义相反——一个是卡带回归（冻结回答、零费用），一个是真实调用（产生费用、结果不可复现），**不合并进同一个 bin**，避免用户误用。

CLI 与桌面共用编排层，但 CLI 首期**只支持空工具表**：replay 不提供 handler，桌面内置 handler 不跨进程复用，`StubToolTable` 只能用于卡带测试。父 run 带工具时 CLI 直接返回配置错误并提示改用桌面端。dry-run 只校验父 run、配置与工具策略并列出 arms，不需要 apiKey、不联网、不写文件；真实执行要求 `--confirm-cost` 与 `REBASEAGENT_API_KEY`。退出码沿用 V3a：0 全部成功，1 至少一臂执行失败，2 配置/前置校验错误。成本不内置价格表；若调用方注入 estimator 且 usage 可用才展示估算，否则显示 unknown。

## 7. 失败、取消与兼容

- provider 错误、工具错误、预算耗尽和取消落入对应 run 的已有终止事件；不自动重试，不删除已完成分支。
- 取消当前 arm 后，尚未开始的 arms 不创建 run；CLI 返回部分失败结果，桌面保留已完成分支。
- prompt fork 的 system/user 行为、tool-result `runs:fork`、proxy `proxy:fork` 和 trace v1 reader 必须保持原样。
- `RunSummary`、`deriveRunSummary` 和 `deriveComparison` 不在包层复制；本 change 只通过已有 desktop 派生层展示指标。

## 8. 测试与迁移

新增 replay 包纯函数和编排测试，使用 fake LLM、内存 loader、临时输出目录和含 handler 的 pure tools。覆盖组合 edit、model/params 不进入 hash、工具表逐字段一致（含 sideEffect 字段有无）、**先校验后覆写**、缺少 system 消息、父 params 缺省视为空对象、`experimentId` 分批、sideEffect 拒绝与逃生舱审计标记、缺配置、失败隔离、每臂独立取消、空 fork、重复执行和现有 prompt fork 回归。新增桌面 IPC schema 测试、ComparePanel 同批分组冒烟与 CLI dry-run/退出码测试。trace 文件无需迁移；旧 run 无实验清单时继续正常显示。
