# 增加 CI 质量门禁：无密钥的安全网（首期 Gitee Go 承载）

## Why

仓库已有干净的本地基线——6 个包 434 个测试全绿（零 API 消耗）、`biome check .` 0 error（139 文件）、`openspec validate --all --strict` 10/10——但这套基线**只在作者的机器上手工跑过**。它的成立依赖一串只存在于本机环境里的隐性约定：pnpm 9.15.9 与 storeDir、各包 `node_modules/.bin` 里的 vitest、以及"测试必须把 cwd 设为包目录""dist 必须先行构建"这类踩过坑才知道的姿势。任何人（包括未来的作者）在别的机器上克隆仓库，都无法复现这组数字。

同时，后续几项工作（D-A 放宽 replay 的 `config_hash` 门禁、D3 provider 参数透传、A1 原生 run 入口）都要动核心内核与跨包边界。**在没有自动化安全网的状态下动内核，等于每次改动都要人工重建全部信任。** 趁基线新鲜把它固化成 CI、成本最低——实测整套校验仅约 1 分钟（见 §证据）。

## What Changes

- 新增 `.workflow/ci.yml`（**Gitee Go 流水线**，云端 Linux 容器）：在 `push` 到 `main` 与 `pull_request` 上触发，执行「装 pnpm → 安装依赖 → 构建 → 类型检查 → 测试 → Biome → OpenSpec strict 校验」。CI 载体选择 Gitee Go 是因为 GitHub 账号受限（申诉中）；校验逻辑与平台无关，GitHub 解封后以独立小 change 补 `.github/workflows/ci.yml` 调同一条 `check:ci`，两者文件共存不冲突。
- 新增**根级 `check:ci` 脚本**及其分步子脚本，把上述校验收敛成一条本机可复现的命令，CI 直接调用它——CI 不另写一套逻辑，避免"CI 绿了本地红"的双口径。
- **构建范围刻意收窄到 `packages/*`**：`apps/desktop` 的 `build` 是 `electron-vite build`（前端打包链），不属于门禁范畴，且与「不跑 Electron 打包」的 non-goal 冲突。desktop 的类型安全改由无副作用的 `tsc --noEmit` 类型检查承担。
- 采用 **pnpm 9.15.9**（与 `packageManager` 一致）+ Node 20（与 `engines.node` 一致），在流水线内用 npm 安装 pnpm 后按 lockfile 安装依赖。
- **全程不注入任何 API key**：测试矩阵必须保持零网络、零 API 调用的既有性质。
- `README.md` 更新「开发」段落为 `pnpm check:ci` 并说明 CI 跑在哪、如何本地复现；**不加 CI 徽章**（Gitee Go 无官方状态徽章；GitHub Actions 徽章留待解封后配 Actions 时一并加）。

## Capabilities

### New Capabilities

- `ci-gates`: 持续集成质量门禁——单命令校验入口与分步契约、逐包测试语义、构建范围与「先构建后测试」、跨包 CLI 冒烟不得静默跳过、零密钥、OpenSpec 固定版本、运行环境与平台风险登记、失败可见性。

### Modified Capabilities

（无。本 change 不改变任何既有能力的用户可见行为，也不修改任何 workspace 包的 src/test/依赖。）

## Goals

- 让 434 测试 / Biome / OpenSpec strict 三条底线在每次 push 与 PR 上自动执行，红绿可见。
- 让 CI 与本机跑的是**同一条命令**（`pnpm check:ci`），消除口径漂移；其中 `check:test` / `check:lint` **直接复用**既有 `test` / `lint` 命令，不是平行实现。
- 让一个新克隆的仓库**不需要任何密钥**就能通过整套检查。
- 让首期运行环境的选择有核查依据（而非"假设无平台依赖"），并把已发现的平台风险登记在案。

## Non-goals

- **不做发布自动化**：不打 tag 触发打包、不自动建 Release、不上传 portable exe。发布流程留在本地手工执行，由独立 change 评估。
- **不跑 Electron 打包与 GUI 冒烟**：CI 不执行 `electron-vite build`、不构建 portable exe、不启动 Electron、不做 CDP 冒烟。这些依赖 GPU/显示环境且耗时长。
- **不引入测试覆盖率门槛**：首期不接 Codecov、不设覆盖率红线——先让既有测试跑起来，覆盖率是后续独立议题。
- **不做依赖升级或版本对齐**：不借机把 workspace 库版本从 0.1.0 提到 0.2.0，不动任何 `package.json` 的依赖声明（除新增脚本外）。
- **首期不配置 GitHub Actions**：GitHub 账号受限（申诉中），仓库暂不可达。解封后以独立小 change 补 `.github/workflows/ci.yml`（约 30 分钟翻译工作，`check:ci` 零改动）。也不接自建 runner。
- **不修改任何被测代码**：本 change 只加 CI 与文档。若 CI 暴露了既存失败（例如平台相关断言），按"先记录、后独立修复"处理，不在本 change 里顺手改内核或改测试。
- **不把 renderer 资源规范检查搬进 CI**：`release-check.mjs` 的 Monaco 静态审计属 `release:verify`，需要产物路径，留在本地。

## 保真度边界

CI 验证的是**确定性、无外部依赖的部分**：纯 TS 库的单元测试、类型检查、代码风格、规范一致性。它**不证明**模型行为正确、不证明 provider 参数生效、不证明打包产物可用——这三件事分别属于 D3、dogfood 与发布流程。CI 绿不等于产品对，只等于"没把已经对的东西弄坏"。

测试矩阵本身依赖"零 API 消耗"这一既有性质（测试全部用 mock/fixture 注入），该性质必须在 CI 里继续保持。另需注意：跨包 CLI 冒烟用例以 `dist/` 存在为前置（见设计 §跨包 CLI 冒烟的静默跳过），若构建范围配错，它们会静默跳过、测试数缩水而 CI 依然全绿——本 change 把这条写进 spec 加以防护。

## 证据（2026-09-10 本机实测）

本条 change 的每个命令都在提交前实跑过，避免"照 tasks 写下去 CI 首次运行就红"：

| 命令 | 结果 | 耗时 |
|---|---|---|
| `pnpm --filter "./packages/*" build` | status 0，Scope **5 of 7**（不含 desktop） | 11.5s |
| `pnpm --filter @rebaseagent/desktop typecheck` | status 0 | 5.4s |
| `pnpm -r test` | status 0，Scope **6 of 7**；**434 测试全通过** | 33.8s |
| `biome check .` | status 0，139 文件 0 error | 3.0s |
| `openspec validate --all --strict` | status 0，**11/11**（10 主 spec + 本 change） | ~5s |

2026-09-12 落地时复跑全链（`check:build` → `check:typecheck` → `check:test` → `check:lint` → `check:spec`）：exit 0 × 5，耗时 11.4s / 5.8s / 31.7s（434 全通过，replay 66 = dist 冒烟真实执行）/ 2.5s（139 文件）/ 78.4s（11/11，含 npx 冷下载）。

其中 `pnpm -r test` 的分包结果为：trace-sdk 75 / agent-loop 56 / replay 66 / llm-proxy 16 / trace-test 65 / desktop 156 = **434**。replay 的 `model-ab-cli.test.ts`（dist 冒烟）**确实执行**了 4 个用例（约 4.9s），而非跳过。

## 影响范围

- 新增 `.workflow/ci.yml`（Gitee Go 流水线定义，随仓库分发）。
- 根 `package.json` 新增 `check:build` / `check:typecheck` / `check:test` / `check:lint` / `check:spec` / `check:ci`（不改依赖）。
- `README.md`：更新「开发」段落（`pnpm check:ci` 与 `check:build` 分工说明、CI 载体说明）、路线图中 CI 一项移至已完成。
- `openspec/specs/ci-gates/`：本 change 落地后新建该能力（spec delta 见 `specs/ci-gates/spec.md`）。
- 不改动任何 package 的 `src`、`test`、`dist`。

## 落地前置（用户侧一次性动作）

Gitee Go 需在仓库网页上开通（账号须绑定手机号）：进入 Gitee 仓库 → 「流水线 / Gitee Go」→ 开通。开通后推入本文件即可被 `triggers` 自动识别。免费额度为单仓库 200 分钟（永久）+ 每月赠送时长；本流水线单次约 3-5 分钟（装依赖为主），额度充裕。
