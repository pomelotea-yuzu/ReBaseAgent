# Tasks: add-replay

## 1. replay 包脚手架与核心纯函数

- [x] 1.1 `packages/replay` 脚手架：package.json（依赖 @rebaseagent/trace-sdk、@rebaseagent/agent-loop）/ tsconfig / 接入根 biome / vitest 配置；包零 Electron 依赖（对应 replay spec Purpose）
- [x] 1.2 `deriveReplayState`：输入展开轨迹（RunRecord + chain）+ `at_span` + 编辑值，定位分叉点后首次 llm.call，取录制 request.messages 深拷贝并把被编辑 tool 消息的 content 替换为新值；纯函数无副作用（对应"编辑 tool_result 得到新前缀"、"前缀即录制请求"Scenario）
- [x] 1.3 校验器：at_span 必须是父轨迹中存在的 `tool.invoke`；编辑字段必须为 `result`；非法输入返回明确错误（对应"分叉点必须是被编辑的 tool.invoke"Scenario）

## 2. agent-loop fork 元数据注入

- [x] 2.1 `runLoop` 增加可选第 6 参 `forkRun: { id, parent, fork }`，注入后 startRun 使用注入值；单测未注入时行为与旧版一致（对应"未注入时行为不变"Scenario）
- [x] 2.2 单测注入 forkRun 后 run.meta 的 id/parent/fork 正确、config_hash 仍现算（对应"fork run 元数据落盘"Scenario）；既有 45 测试全绿不回归

## 3. replay 编排与落盘

- [x] 3.1 `replayRun`：加载父 run（readRun + resolveBranch）→ 校验封存（assertForkable）→ config_hash 一致性校验（现算 vs 父 meta）→ 调用 deriveReplayState → 新建 JsonlTracer 跑 runLoop（注入 forkRun）→ 返回新 run id（对应 replayRun 各 Scenario）
- [x] 3.2 mock LLM 全链路测试（零 API）：对 normal fixture 编辑第 2 步 read_file result 重跑，断言新文件 meta.parent/fork 正确、spans 从分叉点后开始、readRun 通过、父文件逐字节不变（对应"生成分支 run 文件"、"父文件不可变"Scenario）
- [x] 3.3 拒绝路径测试：crashed 父 run / config_hash 不一致 / at_span 非法，各自报错且不产生文件、零调用（对应"崩溃的 run 拒绝分叉"、"源代码变化拒绝分叉"Scenario）
- [x] 3.4 分支 run 再分叉：以 r_02 类 fork run 为父再 fork，resolveBranch 三层展开正确（对应"分支 run 再分叉"Scenario）

## 4. desktop IPC 与写通道

- [x] 4.1 `src/shared/channels.ts` 增 `forkRun: "runs:fork"`；`src/shared/ipc.ts` 定义 `ForkRunRequest`（parentRunId/atSpanId/edit）与响应信封 zod 校验（空 fork 即编辑前后相同的请求在 main 拒绝）（对应 desktop-ui delta 各 Scenario）
- [x] 4.2 main 注册 `runs:fork` 处理器：加载父 run → 校验 → 调 replayRun（真实 LLM，config 来自运行配置）→ 返回新 id；异常收敛为信封（对应"非法请求被拒绝"）
- [x] 4.3 preload 暴露 `forkRun`；renderer DetailPanel 的 tool.invoke 详情加"在此重跑"操作：编辑 result → 确认 → 提交（对应"编辑 tool_result 并重跑"）

## 5. 运行配置（safeStorage）

- [x] 5.1 运行配置模块：baseURL/apiKey/model 经 safeStorage 加密写数据目录 `settings.json`；safeStorage 不可用时明文降级 + 风险提示；不写 AppData/注册表（对应"配置后重跑可用"）
- [x] 5.2 设置对话框：填写/保存/清除；未配置时点"重跑"提示先配置（对应"未配置时提示"Scenario）
- [x] 5.3 config 同源约束：fork 重跑时 system prompt + 工具表与父 run 一致才放行；异源拒绝并提示（对应"同源重放"、"异源拒绝"Scenario）

## 6. UI 状态与端到端冒烟

- [x] 6.1 zustand：forking 状态（进行中/成功/错误）、成功后刷新列表并自动选中新 run；单测流转正确
- [x] 6.2 手工冒烟（NO_SANDBOX=1，本地或 mock LLM 端点）：对 normal fixture 编辑 read_file result → 新 run 出现在列表（分支徽章）→ resolveBranch 合并轨迹展示、分叉点标注（**用户本机 GUI 实测通过 2026-09-03**：真实 deepseek 调用，verify ①空 fork 禁用/②未配置提示/③分支徽章/④分叉点标注/⑤前缀不可分叉/⑥三层链式再分叉 run_mtljcbrr→run_mtljzb01_3a0q→run_mtlkfjy1_l3t1，write_file 真实落盘 summary.md）
- [x] 6.3 全仓回归：trace-sdk / agent-loop / replay / desktop 测试全绿（零真实 API：60/48/15/37）、`biome check .` 0 errors、双端 typecheck 通过
