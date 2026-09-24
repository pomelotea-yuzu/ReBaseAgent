# 贡献指南

谢谢愿意参与 ReBaseAgent！这是一份简短的合作约定。使用问题请先看
[README](README.md) 与[快速开始](docs/guide/getting-started.md)。

## 开发环境

- Node.js **>= 20**（包管理用 pnpm，版本由 `packageManager` 字段锁定）
- Windows x64（当前唯一打包目标；其余平台欢迎反馈但尚未出包）

```bash
pnpm install
pnpm dev            # 启动桌面应用
pnpm test           # vitest（全部 mock 注入，零 API 消耗）
pnpm check:ci       # 质量门禁：build → typecheck → test → lint → spec
```

开发约定、OpenSpec 工作流与测试注意点详见
[docs/development/workflow.md](docs/development/workflow.md)。

## 提交改动

1. 从 `main` 拉出分支；
2. 一个 PR 聚焦一件事，提交信息一行说清本单元改动；
3. 跑通 `pnpm check:ci` 后再提 PR，模板里的自查清单逐项确认；
4. 涉及行为变化的：同步 README 的「当前限制」「路线图」；
5. 涉及能力语义的：本项目用 [OpenSpec](https://github.com/Fission-AI/OpenSpec)
   做 Spec-Driven Development——请先提 proposal（`openspec/changes/`）再动代码。

## 报告问题

用 [issue 模板](.github/ISSUE_TEMPLATE/bug_report.yml)，附版本号与最少复现路径。
大陆网络环境可用 [Gitee 镜像](https://gitee.com/yuzu-tea-duck/re-base-agent)。

## 安全问题

**不要用公开 issue 报告安全漏洞**（尤其涉及 API key 处理的），
请按 [SECURITY.md](SECURITY.md) 的渠道私下报告。

## 行为准则

参与社区即表示同意 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
