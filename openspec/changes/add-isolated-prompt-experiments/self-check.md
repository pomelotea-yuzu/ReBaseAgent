# R2.2 提案自检

日期：2026-10-19。性质：文档与规格自检，未实施、未做功能测试、未做 Electron 验收，也不代表独立审阅。

## 范围与一致性

- proposal/design/tasks、5 份 delta、交互状态草案和证据索引齐全；31 个实施/验收任务全部未勾选，76 条 scenario 全部待实施。
- 23 条 requirement 中，11 条为 MODIFIED；逐块核对其主 spec 原场景名，40 个既有场景全部保留。其余为新增契约；没有直接修改主 spec。
- 显式修订了既有隔离 prompt 全面拒绝和禁止跨运行文件 diff 的相关桌面契约；普通宿主 handler 的 workspace 拒绝、隔离模型实验拒绝保持。
- 明确 v1/v2 writer 不跟随最高读取版本升级；v3 独立边界、ownOnly 自有读取、后续合法 v2 result、卡带与删除保护列入任务。
- 模型/参数取基线；已录制预算复用，未录制条件标未知；配置修订独立于公开指纹，避免相同端点但凭据变化继续使用旧确认。
- 根起点、单项内容、当前授权、真实身份、逐侧 selector/快照/正文守卫和单侧 R2.1 导出均有对应 scenario 与任务。
- 正式路线、项目状态和 OpenSpec context 仅同步“提案已建立、未实施”，未改发行物或扩展 R3/R2.3/MCP 排序。

## 已执行的检查

| 检查 | 结果 |
|---|---|
| `openspec validate add-isolated-prompt-experiments --strict --no-interactive` | exit 0，change valid |
| `openspec status --change add-isolated-prompt-experiments` | 4/4 planning artifacts complete；仅表示提案齐全 |
| `pnpm check:spec` | exit 0，13 passed / 0 failed；主 spec 的长段落 INFO 仍为原有非失败提示 |
| 修改块场景保留与 evidence→task 检查 | 40 个原场景无遗漏；76 行 evidence 均映射有效任务，状态均待实施 |
| 本 change 相对文件链接及尾随空白检查 | 无断链或尾随空白 |
| `git diff --check` | exit 0 |

pnpm 首次在沙箱中因 Corepack 缓存读取权限返回 EPERM；随后按权限流程执行同一命令并成功。未绕过门禁或将首次失败写为通过。

## 留给实施的验证

所有运行行为、v3 兼容、附件/消息拒绝、故障/乱序、草稿/操作 CAS、跨运行文件比较与导出字节验证仍待实施。真实模型受控案例、原生目录选择、真键盘/窗口/200% 缩放、源码最终门禁和逐项证据审计均在任务 7.1–7.4，不以本页替代。归档和发布分别核对。

## 审阅回应后的复核

2026-10-19 阅读独立 [review.md](review.md)，接受其“通过，无阻塞问题”结论，5 项观察/提醒的文档落实见 [review-response.md](review-response.md)。本次只补 design、prototype、tasks 和对应证据映射；5 份 delta 未变，仍为 23 条 requirement / 76 条 scenario / 31 项待实施任务。原 review 未改写，审阅通过不表示功能已实现。

- 定向 `openspec validate add-isolated-prompt-experiments --strict --no-interactive`：exit 0。
- `node scripts/check-spec.mjs`（check:spec 脚本入口）：exit 0，13 passed / 0 failed。
- 链接/尾随空白、证据任务引用检查：零错误，全部任务与证据仍待实施。
- `git diff --check`：exit 0。
