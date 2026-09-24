# 开发工作流（Development）

## 环境与日常命令

Node + pnpm workspace（`packages/*` + `apps/*`）：

```bash
pnpm install
pnpm dev            # 启动桌面应用
pnpm test           # vitest（零 API 消耗，全部 mock 注入）
pnpm build          # 完整构建（含 desktop 的 electron-vite 前端打包）

pnpm --filter @rebaseagent/desktop dist   # 打包 Windows portable exe
```

## 质量门禁

CI 与本地跑同一条命令链（Gitee Go 流水线 `.workflow/ci.yml`；GitHub Actions 待账号恢复后补配）：

```bash
pnpm check:ci   # = check:build → check:typecheck → check:test → check:lint → check:spec
```

两条构建命令**不可互相替代**：

- `pnpm check:build`（`check:ci` 第一步）只构建 `packages/*` 的库产物，供测试与跨包消费；
- `pnpm build` 是完整构建，额外含 desktop 前端打包，供开发者本地使用。

⚠️ 测试注意：`pnpm check:build` 先于 `pnpm check:test`——缺 dist 时部分用例会静默跳过；并行跑多包测试可能假红，判回归以单包/单文件复跑为准。

## Spec-Driven Development（OpenSpec）

每个能力走完整生命周期，见 `openspec/` 目录：

```text
proposal（提案） → 评审 → apply（实现 + tasks 逐条销账）
→ 验收（质量门禁 + 实机证据） → archive（归档 + evidence-index 证据索引）
```

- 归档后的 change 是能力语义与证据的**权威记录**：`openspec/changes/archive/<date>-<name>/`
- 主 spec（`openspec/specs/`）在归档时被 delta 合并，判现状只认 `src/` + 归档 delta。
- 实机验收截图按批次落 `docs/reviews/<date>-<批次>/`，原始测量数据落 gitignored 的 `.workbuddy/`。

## 文档约定

- 文档地图见 [`../README.md`](../README.md)；跨目录引用用 `docs/<类目>/...` 全路径。
- 会话产物（日志、审阅、报告）带 `YYYY-MM-DD-` 日期前缀；长期文档不带。
