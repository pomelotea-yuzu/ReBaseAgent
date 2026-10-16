# 提案文档自检记录

日期：2026-10-16。范围：提案、设计、delta、任务、证据规划和当前状态链接；本次未实施产品重构、未运行产品测试或 Electron 验收。

## 核对结果

- 基线：`ddcfd2a`；R2.1 归档 `ac8729e`、UI 归档 `00ecab6`、构建提交 `18ebb6f`。版本为 `0.5.0-rc.1`，上传状态依据维护者本轮确认。
- 三个目标物理行数已重读源码核对：store 3769、DetailPanel 2161、WorkspaceFileView 1866；不以行数宣称性能缺陷。
- 范围只包含内部拆分与直接消费方/测试适配；共享 IPC、main/preload、包层能力、格式、依赖、版本和发行配置不变。
- delta 为 **5 条 ADDED requirements / 19 个 scenarios**，与现行 desktop-ui requirement 无同名冲突，不改写既有行为条款。
- **39 项任务全部未勾选**；19 个场景均有精确名称的任务承接及唯一索引行，每个任务均引用有效场景；多路径实机任务分开安排。
- 设计覆盖兼容导出、无循环依赖、唯一状态/字段/资源所有者、原子更新、selector 引用缓存、未知状态与迟到响应、草稿修订、授权失效、编辑器恢复以及测试接线迁移。
- 方案内相对文档链接已检查存在；新建文件尾部空白与 `git diff --check` 已检查。未覆盖或未知的产品验收仍明确留待实施，不预填通过。

## 已执行的文档检查

| 检查 | 结果 |
|---|---|
| `openspec validate refactor-desktop-renderer-modules --strict --no-interactive` | 通过 |
| `pnpm check:spec` | 13 passed / 0 failed，含本 change 与 12 份主 spec |
| 场景→任务→索引、任务场景名称、ADDED 同名冲突与方案内链接核对 | 通过：5 requirements / 19 scenarios / 39 tasks |
| `git diff --check` 与新增文档空白检查 | 通过 |

## 实施时须落实

任务 1.2/1.3 的完整字段/action/资源归属和旧断言迁移台账尚未建立；本文只确认已将其列为实施前交付。运行时单例、依赖图、原子更新及真实 UI 行为仍需实际代码和测试证明，OpenSpec 校验不能替代这些证据。归档与新版本发行均未执行。

## 首轮评审后修订检查（2026-10-16）

依据 [review.md](review.md) 修订设计、任务和证据索引；响应见 [review-response.md](review-response.md)。新增 [静态测试迁移基线](test-migration-baseline.md)，36 个文件与当前全量旧路径搜索命中集合完全一致，逐项核对读取上下文，文件级清单已建立；逐断言台账、动态导入完整清单及测试执行仍待任务 1.1/1.3，不提前勾选。

- `pnpm check:spec` 重新执行：**13 passed / 0 failed**。
- 场景/任务/索引双向映射复核：**5 requirements / 19 scenarios / 39 项未勾选任务**，无遗漏、无未知场景引用。
- 主 spec 当前为 **95 requirements / 457 scenarios**；归档前后须保存完整集合求差，本次仅记录基线，未合入 delta。
- change 顶层文档链接、尾部换行与空白检查、`git diff --check`：通过。
- 原独立评审保持原文；本次只修改 change 内文档，无产品代码、测试、版本或提交操作。未追踪目录的实际入库仍待后续任务组提交，不把已写提交规则记为已经入库。
