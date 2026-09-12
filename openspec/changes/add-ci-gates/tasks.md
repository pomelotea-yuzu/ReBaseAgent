# 任务

> 前置：本 change 的设计与命令均已在本机实跑验证（见 proposal §证据）。实现时逐条对齐即可，无需重新探路。
> **P0 提醒**：`check:build` 必须收窄到 `packages/*`；若误写成 `pnpm -r build`，CI 会去跑 `electron-vite` 前端打包链，既与 non-goal 冲突又每次白付打包时间。

## 1. 根脚本（唯一事实源）

- [x] 1.1 在根 `package.json` 新增 `check:build`（`pnpm --filter "./packages/*" build`）、`check:typecheck`（`pnpm --filter @rebaseagent/desktop typecheck`）、`check:test`（`pnpm -r test`）、`check:lint`（`biome check .`）、`check:spec`（`npx -y @fission-ai/openspec@1.12.0 validate --all --strict`）与汇总的 `check:ci`（按 build → typecheck → test → lint → spec 串联）；**不改动** dependencies / devDependencies，**不改动**既有 `build` / `test` / `lint`。
- [x] 1.2 `check:test` 复用既有 `test` 的同一条表达式（`pnpm -r test`），确保每个包的 vitest cwd = 包目录；**禁止**使用根 vitest + `--root` 形式（模块双实例 → `instanceof` 假阳性）。
- [x] 1.3 确认 `check:build` 不包含 `apps/desktop`（其 `build` 是 `electron-vite build`）；desktop 的类型安全由 `check:typecheck` 承担，且 `check:typecheck` 排在 build 之后（解析 workspace 包的 `dist/*.d.ts`）。
- [x] 1.4 本机完整跑通 `pnpm install --frozen-lockfile && pnpm check:ci`，逐项核对实测基线：build Scope **5 of 7**、typecheck 0、test Scope **6 of 7** 且 **434 通过**、lint **139 文件 0 error**、spec **11/11**。（2026-09-12 复跑全绿，见 proposal §证据）
- [x] 1.5 反向验证"跨包 CLI 冒烟不静默跳过"：确认 `packages/replay/test/model-ab-cli.test.ts` 的 4 个 dist 冒烟用例**实际执行**（replay 计 66 而非 62），证明 build → test 顺序生效。

## 2. 流水线（Gitee Go）

- [x] 2.1 新增 `.workflow/ci.yml`：`push` 精确匹配 `main` + `pr` 精确匹配 `main` 触发；全程无任何 secrets 注入。
- [x] 2.2 `build@nodejs` 步骤：`nodeVersion` 取 Node 20 系；commands 顺序 = 装 pnpm 9.15.9（npmmirror）→ `pnpm install --frozen-lockfile` → `pnpm check:build` → `pnpm check:typecheck` → `pnpm check:test` → `pnpm check:lint` → `pnpm check:spec`，**逐条列出**（日志逐条可定位），无任何"忽略错误"机制；五道校验调用的是根脚本的对应子命令，不得另写校验逻辑。
- [x] 2.3 确认流水线中**不存在** electron-vite build、electron-builder、Release 相关命令；确认 `check:build` 收窄到 `packages/*`。
- [ ] 2.4 用户侧一次性动作：在 Gitee 仓库网页开通 Gitee Go（需绑定手机号），push 后触发一次流水线，确认变绿（或明确记录失败原因与处置判定——如 `nodeVersion` 被插件拒绝，改选 Node 20 系可用版本并回写 yml）。

## 3. 文档

- [x] 3.1 `README.md`「开发」段落加入 `pnpm check:ci`，**讲清三件事**：① `check:build` 与 `pnpm build` 的分工（前者只构建库包供门禁使用，后者含 desktop 前端资源、供开发者本地完整构建）；② CI 载体为首期 Gitee Go（GitHub 账号受限申诉中，解封后补 Actions 调同一条命令）；③ 本地如何复现整套校验。
- [x] 3.2 `README.md` 路线图中把「GitHub Actions CI」一项从 📋 移至已完成（措辞改为「CI 质量门禁（Gitee Go 承载）」，保留其余工程与分发项）。
- [x] 3.3 **不加 CI 徽章**：Gitee Go 无官方状态徽章；GitHub Actions 徽章留待解封后补配 Actions 时一并加。

## 4. 验证与风险登记

- [x] 4.1 校验 spec 覆盖：本 change 的每个 Scenario 都有对应的可验证手段（本机实跑输出或流水线结构断言）。
- [x] 4.2 运行 OpenSpec strict 校验与 Biome，确认本 change 自身合规。
- [x] 4.3 登记已知平台/环境风险（不在本 change 修）：`packages/llm-proxy/test/handler.test.ts:472` 的硬编码端口 `58772`（runner 端口被占会假红）、`apps/desktop/test/app-icon.test.ts:7` 的写死绝对路径（本机已核为纯字符串拼接断言，Linux 恰好可过）。若首期云端运行出现平台相关失败，逐条判定为「改测试使其平台无关」或「扩运行矩阵」，**不得跳过或删除失败用例**。

## 5. 归档前核对

- [x] 5.1 核对：未改任何 package 的 `src` / `test` / 依赖；既有本地分步校验命令（`pnpm build` / `pnpm test` / `pnpm lint`）仍可用且语义未变。
- [x] 5.2 核对：测试总数仍为 434（CI 与本地一致），未因构建范围或跳过守卫而缩水。

> 归档条件：2.4（Gitee Go 真机流水线变绿）完成后勾选并 `archive`。当前 change 保持活跃。
