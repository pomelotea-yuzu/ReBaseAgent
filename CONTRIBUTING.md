# 贡献指南

谢谢愿意参与 ReBaseAgent！这是一份简短的合作约定。使用问题请先看
[README](README.md) 与[快速开始](docs/guide/getting-started.md)。

## 参与方式

文档勘误、最小复现、测试改进和代码修复都可以贡献。小范围文档修正可直接提交 PR；功能建议先说明真实使用场景、当前做法和预期结果，再讨论实现范围。

公开反馈可使用 [GitHub Issues](https://github.com/pomelotea-yuzu/ReBaseAgent/issues) 或
[Gitee Issues](https://gitee.com/yuzu-tea-duck/re-base-agent/issues)。已有同一问题时优先补充原记录；跨平台报告请互相链接，并选定一个主讨论位置。两端采用相同的贡献规则，不要求重复提交 PR。

## 开发环境

- Node.js **>= 20**（包管理用 pnpm，版本由 `packageManager` 字段锁定）
- Windows x64（当前唯一打包目标；其余平台欢迎反馈但尚未出包）

```bash
pnpm install --frozen-lockfile
pnpm dev            # 启动桌面应用
pnpm check:build    # 先构建库包，避免缺少 dist 使 CLI 用例跳过
pnpm test           # vitest（全部 mock 注入，零 API 消耗）
pnpm check:ci       # 质量门禁：build → typecheck → test → lint → spec
```

开发约定、OpenSpec 工作流与测试注意点详见
[docs/development/workflow.md](docs/development/workflow.md)。

维护职责、问题分流、审阅决策、贡献许可和发布要求见
[治理与维护安排](docs/development/governance-and-maintenance.md)。当前由单一维护者负责；普通 Issue/PR 尚无固定响应时限。

## 提交改动

1. 从 `main` 创建分支，一个 PR 聚焦一件事；开始前查看关联 Issue/PR 和活动 change，避免重复修改正在处理的内容。
2. 涉及能力语义的变更先提交 [OpenSpec](https://github.com/Fission-AI/OpenSpec) proposal（`openspec/changes/`），说明兼容性和验收条件。文档勘误不需要新建 change。
3. 说明问题、改动、关联 Issue/change、验证结果和剩余限制。未完成的改动可先提交草稿 PR；草稿不等于可合入。
4. 申请合入代码或构建配置前运行 `pnpm check:ci`；涉及界面、打包或真实执行的变更另附对应验证。纯文档改动检查事实、相对链接和格式即可，不为文字修改启动桌面或真实模型请求。
5. 环境限制导致检查未运行时，写明命令、阻碍和未覆盖范围，不勾选通过；由维护者补验或保持待验证。修改后更新受影响的检查结果，旧提交的绿灯不能代替新提交验证。
6. 用户可见行为变化同步 README、使用文档与限制；公开能力说明须区分 `main`、候选包和已发布版本。提交信息用一句话说清改动。

## 审阅与反馈

维护者检查范围、复现、兼容性、测试、文档和第三方来源，再决定合入。尚无强制的独立第二审阅者；单维护者自审应如实记录。CI 通过不代表已经接受贡献，也不证明实包或真实模型行为正确。

审阅意见尽量标明阻塞问题或可选建议，并给出原因。贡献者修订后可在原 PR 请求复审；同一 PR 保留讨论与验证记录。未采纳或关闭时说明原因，重复问题链接原记录。补充新的复现或修订方案后可以申请重新评估。

普通 Issue/PR 没有固定响应时限。等待期间可在原记录补充信息或询问进度，不必跨平台重复开单；合入时间和发布版本以维护者实际记录为准。

## 许可与内容来源

提交贡献表示你有权提供该内容，并同意原创贡献按项目 [MIT 许可证](LICENSE) 分发，不要求转让著作权。第三方内容沿用适用许可，不能仅因进入本仓库就改标 MIT。

引入代码、依赖、图标、字体、文档片段、示例或数据时，请列出来源链接、版本或提交、许可、修改情况及需保留的版权/NOTICE 文件。涉及生成工具辅助的贡献，提交者仍负责核查正确性与来源；工具输出不能替代来源说明或许可授权。当前不要求 CLA 或 DCO 签署，也未配置对应自动检查。

依赖声明与锁文件应一并更新，说明用途和必要性；不要在无关修复中夹带批量升级。更新与兼容规则见[版本与维护政策](docs/development/maintenance-policy.md)，发行物许可要求见[第三方声明与发行说明](docs/development/third-party-notices.md)。

## 报告问题

用 [Issue 模板](.github/ISSUE_TEMPLATE/bug_report.yml)，附运行方式、版本或源码提交、操作系统、最少复现步骤、预期与实际结果。无法稳定复现时说明发生条件，不必提供无关的完整工程。

只附脱敏后的必要日志或示例。trace、模型消息、文件附件和截图都可能包含密钥、业务数据或个人信息；不要直接上传整个 `data/` 目录。若问题涉及泄露、路径逃逸等安全影响，改走下述私密流程。

## 安全问题

**不要用公开 issue 报告安全漏洞**（尤其涉及 API key 处理的），
请按 [SECURITY.md](SECURITY.md) 的渠道私下报告。

## 行为准则

参与社区即表示同意 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
