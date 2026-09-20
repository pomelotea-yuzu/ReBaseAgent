# A3-C：隔离文件检查点与差异查看

## Why

A 保存可恢复的文件事实，B 提供桌面隔离执行，但用户仍无法从文件列表检查某轮结果或比较分支起始状态。本 change 提供基于 trace 清单与不可变附件的只读文件视图。

## Goal

查看本 run 初始或自有完成步骤的文件列表和真实文本差异；重启及整体移动数据目录后仍可读，二进制、路径不存在、缺失和损坏各自明确。

## Dependencies

依赖 A `add-sandboxed-rerun` 和 B `add-sandboxed-rerun-desktop` 已归档，按 A → B → C 实施。复用 A 包只读附件接口与 B 的 v2 详情 IPC/来源模型，不重定义其数据契约。

## What Changes

- 新增 workspaces:inspect/readFile 只读 IPC，main 注入 dataDir，依据本 run 自有清单读取附件，不接受任意物理路径。
- 详情文件 tab 支持初始/完成步骤选择，列表展示路径、大小、相对初始新增/修改状态和附件可用性。
- 复用现有 Monaco 离线装配，新增懒加载 DiffEditor 并排对比初始与当前文本；二进制显示大小/哈希，缺失/损坏不伪装成空文本。
- 检查点轮号按所属 run 原始 n 显示，来源标明父 run/step，支持二次分叉。
- 补文件 CDP、重启/迁移及窄窗口截图，按 fixture 哈希验证查看过程无写入。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `desktop-ui`：新增文件检查点与差异只读 requirement；不整体替换 B 已修改的 requirement。

## Impact

影响 apps/desktop 的 shared 通道/schema、main 只读服务、preload 和详情文件视图及测试。复用现有 React、zod、Monaco 和 A 包接口，不新增依赖。预算 9.75h，全部待实现。

## Non-goals

- 不创建或重跑 run，不提供文件编辑、自动回写、合并、执行目录导出或附件 GC。
- 不更改 trace-format/workspace-isolation，不补造旧 run 检查点或恢复缺失附件。
- 不把祖先步骤当成本 run 的文件检查点，不用当前源目录冒充历史内容。
- 不新增隔离 prompt fork/A-B、任意 handler、shell 或外部副作用隔离。
- 不自动提交、归档或发版。

## 保真度边界

本段只读取已校验清单引用的原字节，diff 是初始快照与所选自有步骤的比较。纯查看不调用 LLM/工具、不写入文件。文件不存在、非 UTF-8、缺失和损坏必须区分；权限、时间戳、链接身份及外部世界不在快照内。底层固定快照的 read_file 可确定读取，write_file 仅由 A/B 显式授权执行且只改分支副本；本段不授予执行权限。
