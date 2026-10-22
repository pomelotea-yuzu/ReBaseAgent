# R2.2 任务 1.1 —— config.json 受控案例基线记录

状态：2026-10-20 建立。fixture 与验收测试已落地，真实模型证据分列（7.1 才补）。
本案例按 proposal「验收口径」固定；**不**宣称已完成真实项目接入（I）或 R3 测试验证。

## 案例定义

场景：原启动指令要求「重写整个 config.json」，会把用户手工加的未知键覆盖掉；
用户只改一条启动消息（system 或首条 user），从**根初始快照 A**（不是父最终 B、
也不是当前源目录 C）重新执行，人工判据 = 未知键保留且目标值正确。

## 三态

| 状态 | config.json 内容 | 未知键 `custom_flag` | 目标键 `retries` |
|---|---|---|---|
| 初始 A（根 initial_snapshot） | 见 `CONFIG_INITIAL_A` | `"keep-me"` ✅ 在 | `1`（错误初值） |
| 父最终 B（根第 1 轮轮末快照） | 见 `CONFIG_FINAL_B` | ❌ 丢失（原指令覆盖） | `3` |
| 源目录 C（真实落盘 `dataDir/source-dir-c`） | 见 `CONFIG_SOURCE_C` | `"changed-by-user"`（值又变过） | `9` |

另有 `README.md` 在源目录 C（证明比较对象是初始 A 的世界而非源目录）。

## 指令与判据（常量即记录，改常量 = 改判据）

- 原指令 system：`ORIGINAL_SYSTEM_PROMPT`（"修改 config.json 时必须用 write_file 重写整个文件内容"）
- 原指令 user：`ORIGINAL_USER_INSTRUCTION`（"直接写入完整新内容 {"retries": 3}" → 产生 B）
- 单项编辑候选一（user_message）：`NEW_USER_INSTRUCTION`（限定只改目标键）
- 单项编辑候选二（system_prompt）：`NEW_SYSTEM_PROMPT`
- 人工判据（v3 `prompt_experiment.acceptance_criterion` 取值）：`ACCEPTANCE_CRITERION`
  —— `retries === 3` 且 `custom_flag === "keep-me"`，其余键与初始 A 一致
- 可选假设示例：`HYPOTHESIS`

## 固定执行配置

- 模型 `BASELINE_MODEL = "deepseek-chat"`；参数 `BASELINE_PARAMS = { temperature: 0.2 }`（仅标量）
- 工具表 `BASELINE_TOOLS = FILE_TOOLS_V1_DEFINITIONS`（file-tools-v1，顺序即注册顺序）
- `config_hash` 由 `configHash(ORIGINAL_SYSTEM_PROMPT, tools)` 计算（与 runLoop 同算法）
- 根 run 是 v2 隔离根：`parent/fork = null`、`origin = {kind:"import"}`、profile `file-tools-v1`
- 兄弟分支：v2 result 分叉（起点 = 父轮末 B），终态 `CONFIG_SIBLING_FINAL`（另一种修复结果）

## 落地位置与复用

- fixture 构造器：`packages/replay/test/isolated-prompt-baseline-fixture.ts`
  （`buildIsolatedPromptBaselineCase({dataDir, emptyInitial?, withSibling?})`）
  - 附件经真实 blob store 发布（真哈希），逐附件字节核验在后续预检/比较中可真实走到
  - `emptyInitial: true` = 空初始世界变体（workspace 场景「空初始世界与后续超限遵守原配额」基座）
  - 输出含各轮清单、快照 id（即树指纹）、span id、源目录路径
- 验收测试：`packages/replay/test/isolated-prompt-baseline-fixture.test.ts`（7 用例，2026-10-20 全绿）
  1. 根初始状态与父最终及源目录分离（三态互异 + 未知键判据）
  2. 首次请求与单项编辑一致（D2 参考实现 `deriveEditedMessages`：只动一条 content，空串是真实变化）
  3. 根 meta 形状（v2 隔离根 + config_hash 同源）
  4. 兄弟分支指纹（起点 = 父轮末 B、终态互异、origin/fork 自洽）
  5. 指纹可复现（全新 dataDir 重建 → A/B/兄弟快照 id 逐字节相同）
  6. 空初始世界变体
  7. 假设/判据常量齐备（供 v3 prompt_experiment 落盘）

## 证据分列

- 本任务 = **mock 层**证据（确定性 fixture + 断言）。
- **真实模型**证据（根→单项编辑→子运行→比较→导出闭环、人工判据实际结果）在任务 7.1 补，
  失败如实保留、不重试挑选成功样本。
