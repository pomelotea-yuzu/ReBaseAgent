# Tasks: add-prompt-replay

## 1. 数据与纯派生

- [x] 1.1 在 packages/replay 增加启动上下文定位 helper：从叶 run 自身的首次 llm.call.request.messages 找到首条字符串 system message 与首条字符串 user message；缺失或位置不合法时返回明确错误。
- [x] 1.2 增加 PromptForkEdit 与纯函数 derivePromptForkState：深拷贝 messages、替换目标字符串、同步 system prompt 配置值、拒绝空 fork；不读文件、不发请求。
- [x] 1.3 单测覆盖 system prompt、首条 user message、一次多字段拒绝、空 fork、非字符串值、缺少首次请求、缺少字符串 system 消息时两种编辑均拒绝、父文件不可用等 scenario。

## 2. replay 编排

- [x] 2.1 新增 prompt fork 编排入口（名称待评审），加载父链并检测环 / 缺失 / 未封存。
- [x] 2.2 拒绝 proxy run、无 config_hash 或首次请求缺少字符串 system 消息的父 run；错误发生在创建 tracer 之前。
- [x] 2.3 计算新 config hash，注入 forkRun（parent、首次 llm.call 的 at_span、单项 prompt edit），从第 1 步调用现有 runLoop。
- [x] 2.4 mock LLM 端到端测试：新 run 从 agent.step n=1 开始、父文件逐字节不变、config hash 改变、trace 可被 readRun 读取。
- [x] 2.5 双真相源测试：system prompt fork 后，config hash 的 systemPrompt 输入与新 run 首次 llm.call.request.messages 的 system content 相同。
- [x] 2.6 连续 fork 测试：以 prompt fork run 为父再改首条 user message，取直接父 run 自身首次请求，不混入祖先 spans。
- [x] 2.7 验收：既有 tool_result replay 全部通过，prompt fork 失败不产生文件。

## 3. trace / IPC 契约

- [x] 3.1 确认 ForkSchema 无需升级版本，补充 system_prompt / user_message 合法 field 的 schema fixture。
- [x] 3.2 扩展 RunSummary fork 摘要字段映射和中文标签，保持列表不透传 edit.value。
- [x] 3.3 为新的 IPC 请求 / 响应增加 zod schema 和统一 envelope；renderer 只经 preload 调用。
- [x] 3.4 测试旧 run、旧 proxy fork、tool_result fork 与 prompt fork 的兼容解析。

## 4. desktop 详情与编辑器

- [x] 4.1 在详情页启动上下文区域增加 system prompt 编辑入口，支持取消、恢复原值、空 fork 校验和提交状态。
- [x] 4.2 增加初始 user message 编辑入口，仅允许首条启动 user message；非字符串、缺少字符串 system 消息或不满足位置条件时禁用提交。
- [x] 4.3 增加重跑前确认信息：从头重跑、将真实调用模型并计费、父 run 不修改、配置指纹变化。
- [x] 4.4 增加成功 / 失败状态处理，成功后选中新 run，失败时不刷新出伪 run。
- [x] 4.5 UI 单测覆盖未配置、空 fork、取消编辑、成功和失败路径。

## 5. 详情解析与分支树

- [x] 5.1 RunRepository.getRun 对 prompt fork 返回新 run 完整 spans + 父级 chain，不调用 resolveBranch。
- [x] 5.2 增加分支边标签：system prompt / user message；保留 result / messages 既有标签。
- [x] 5.3 在详情中区分“父级溯源”和“本次完整执行”，不显示共享前缀或截断拼接文案。
- [x] 5.4 测试 prompt fork 不混入父旧 spans；branch-tree 的本 run 增量只算新 run，自身累计沿 parent 链代数求和并使用既有诚实措辞。

## 6. 门禁与文档

- [x] 6.1 更新主 spec delta：prompt-replay，并同步 replay / desktop-ui / branch-tree 的行为变化。
- [x] 6.2 更新 README 的 v2 能力和限制，明确 prompt fork 从头重跑、proxy fork 与 SDK replay 的区别。
- [x] 6.3 运行 Biome、双端 TypeScript、Vitest、electron-vite build、openspec validate --all --strict。
- [x] 6.4 GUI 冒烟：编辑 system prompt → 生成 fork → 分支树标记 → 打开新 run 查看完整轨迹 → 确认父 run 不变。
- [x] 6.5 评审通过且所有 scenario 有测试后再归档 change；本任务阶段不执行 archive。
