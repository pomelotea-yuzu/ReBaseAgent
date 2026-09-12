# 设计

## 为什么是「一条命令」而不是「CI 里堆步骤」

CI 最常见的腐化方式是：workflow YAML 里散落着 `cd packages/x && ...`、`pnpm --filter ...` 之类的拼装逻辑，与本地跑法逐渐分叉，最后变成"CI 绿了但本地跑不过"或反之。

本设计把**校验逻辑的唯一事实源放在根 `package.json` 的脚本里**：

```json
{
  "scripts": {
    "check:build": "pnpm --filter \"./packages/*\" build",
    "check:typecheck": "pnpm --filter @rebaseagent/desktop typecheck",
    "check:test": "pnpm -r test",
    "check:lint": "biome check .",
    "check:spec": "npx -y @fission-ai/openspec@1.12.0 validate --all --strict",
    "check:ci": "pnpm check:build && pnpm check:typecheck && pnpm check:test && pnpm check:lint && pnpm check:spec"
  }
}
```

流水线只做三件事：装环境、`pnpm install`、`pnpm check:ci`。这样本机开发者跑 CI 全部内容只需一条命令，CI 平台只是它的执行器。

### `check:*` 与既有 `build` / `test` / `lint` 的关系

根 `package.json` 已有 `build` / `test` / `lint`。两者不是两套平行实现，关系如下（**这是本 change 要防的腐化点，特此写明**）：

| 命令 | 取值 | 关系 |
|---|---|---|
| `check:test` | `pnpm -r test` | **与既有 `test` 同一条命令**（不是复制体，是同一个表达式）。两边永远一致 |
| `check:lint` | `biome check .` | **与既有 `lint` 同一条命令** |
| `check:build` | `pnpm --filter "./packages/*" build` | **比既有 `build` 窄**，见下 |
| `check:typecheck` | `pnpm --filter @rebaseagent/desktop typecheck` | 复用 desktop 包自己的 `typecheck` 脚本 |

`check:build` 与 `build` 的差异是**刻意的**，且是唯一一处差异：

- 既有 `build` = `pnpm -r build`，会在**每个** workspace 包跑 `build`——包括 `apps/desktop`，而它的 `build` 是 `electron-vite build`，即前端打包链（Vite + Monaco/echarts/tailwind 插件）。
- 门禁只需要"供测试与跨包消费的构建产物"。把 desktop 的打包链拉进 CI 会：① 与「不跑 Electron 打包」的 non-goal 直接冲突；② 引入大量与门禁无关的失败面（worker 解析、EPERM 类插件报错）；③ 每次 CI 白付一笔打包时间。
- `apps/desktop` **没有跨包消费者**（它没有 `exports`，也没有别的包依赖它），所以不构建它不会让任何消费方拿到旧产物；而 desktop 自身的类型安全由 `check:typecheck`（`tsc --noEmit`，无副作用）覆盖。
- 既有 `build` **保持不变**：开发者需要完整构建（含前端资源）时仍用 `pnpm build`。README 的说明一并更新，讲清两者分工。

> ⚠️ 这是 P0 级修正：若按 `pnpm -r build` 写，CI 首次运行就会去跑 electron-vite 打包。实测 `pnpm --filter "./packages/*" build` 的 Scope 是 **5 of 7**（11.5s），而 `pnpm -r build` 会把 desktop 也算进去。

## 关键约束：vitest 的 cwd 陷阱

本仓实测过一个非平凡坑位：**跑 vitest 必须让 cwd = 包目录**。若用「根 vitest + `--root <包路径>`」的写法，同一模块会被解析成两份实例，导致 `instanceof` 断言假阳性（2026-09-10 实测 `trace-test` 因此报 2 个 `instanceof TraceTestConfigError` 失败）。

因此 `check:test` **不得**写成根级 vitest 遍历，而应逐包执行，让每个包的 vitest 在自己的 cwd 下运行。pnpm workspace 天然满足这个语义：

```text
pnpm -r test          # 实测 Scope: 6 of 7 workspace projects
```

`pnpm -r test` 会在每个包的目录里执行它自己的 `test` 脚本（每个包都是 `vitest run`），cwd 即包目录——这正是我们想要的。**不要**改成根 `vitest --root` 形式。

实测覆盖范围：`pnpm -r test` 的 Scope 是 **6 of 7**（5 个 `packages/*` + `apps/desktop`；第 7 个是根本身，被 `-r` 排除），合计 **434 测试**。

## 构建顺序：为什么先 build 再 test

workspace 包的 `package.json` 的 `exports` 只指向 `./dist/`。跨包消费者（`replay` 的 `rebaseagent-model-ab` bin、`desktop` 的运行时解析、`scripts/*.mjs` 里显式写的 `dist/index.js`）全部取 dist。

但**包内 vitest 用的是相对 `../src`**，所以"包内测试全绿"并不能证明跨包边界已更新。CI 里如果跳过 `build` 直接跑 test，就可能出现"测试全绿、但真实消费方拿的是旧 dist"的假绿。

因此 CI 顺序固定为：

1. `pnpm install --frozen-lockfile`（锁定 `pnpm-lock.yaml`，避免 CI 静默升级依赖）
2. **build**（`pnpm --filter "./packages/*" build`，5 个库包各自 `tsc -p tsconfig.json` 产出 dist；实测 11.5s）
3. **typecheck**（desktop 的 `tsc --noEmit`，纯检查、无产物；实测 5.4s。必须排在 build 之后，因为它解析 workspace 包的 `dist/*.d.ts`）
4. **test**（`pnpm -r test`，逐包，cwd = 包目录；实测 33.8s）
5. **lint**（根 `biome check .`；实测 3.0s）
6. **spec**（`openspec validate --all --strict`）

> 注：把 build / typecheck / test / lint / spec 拆成流水线里的**独立命令**（便于失败定位与耗时观察），但每条命令调用的仍是根脚本的对应子命令 —— 保证 CI 与本地同一套命令。

## 跨包 CLI 冒烟的静默跳过（P0 级）

`packages/replay/test/model-ab-cli.test.ts` 开头是这样的：

```ts
const CLI_PATH = resolve(import.meta.dirname, "../dist/model-ab-cli.js");
const skip = !existsSync(CLI_PATH);   // dist 不存在 → 整组跳过
describe.skipIf(skip)("rebaseagent-model-ab CLI（dist 冒烟）", () => { ... });
```

也就是说**整组 CLI 冒烟用例以 `dist/` 存在为前置条件**。实测（2026-09-10）：

| 条件 | 结果 |
|---|---|
| `dist/` 存在（先 build） | `model-ab-cli.test.ts` **执行 4 个用例**（约 4.9s），replay 合计 **66** |
| `dist/` 缺失（跳过 build） | 该文件 4 个用例**静默 skip**，replay 降到 **62**，而 CI 依然全绿 |

结论：**这个 skip 守卫是 CI 里的静默失真源。** 若后人把构建范围改错、或把 CI 顺序改成 test → build，测试数会悄悄缩水而门禁不响。因此把它提为 spec 的显式 Requirement（"跨包 CLI 冒烟不得静默跳过"），而不是留给读者从 dist 推断。

> 附带更正一条既有认知：`packages/trace-test` 的 8 个测试文件（`assertions` / `cassette` / `definition` / `loader` / `rerun` / `run-test` / `shape-align` / `stub-tools`）**没有任何 CLI spawn**（实测 grep `spawn|child_process|dist/` 零命中）。CLI 冒烟在 `replay` 包里，配 build 范围时不要按别处的记忆去配。

## OpenSpec CLI 的调用方式

仓库里的 openspec CLI 不是本仓依赖，走 npx 拉固定版本：

```text
npx -y @fission-ai/openspec@1.12.0 validate --all --strict
```

必须**固定版本号**。`@fission-ai/openspec` 是唯一可用的发行包（npm 上的裸 `openspec` 是占位包），但 next 版本可能改变 strict 校验口径，从而导致"代码没动，CI 突然红"。把版本号钉在脚本里，升级作为独立提交。

> 该命令需要网络（npx 下载）。CI 环境有网；若 `--all --strict` 因规范内容变化而失败，属**真实信号**（spec 写得不合规范），不应通过跳过该步骤来绕过。
>
> 可选优化：缓存 npx 的 `_npx` 目录省一次下载。非必需，别为它增加复杂度。

## CI 载体：为什么是 Gitee Go

GitHub 账号受限（申诉中），仓库暂不可达，Actions 无法使用。**B1 的核心资产是根 `check:ci` 命令链，与平台无关**，因此把载体换成 Gitee Go（Gitee 官方 CI/CD，仓库根 `.workflow/*.yml` 声明式配置，云端 Linux 容器执行）不损失任何东西：

- Gitee 侧免费额度：单仓库 200 分钟（永久）+ 每月赠送时长；本流水线单次约 3-5 分钟（装依赖为主，五道校验合计约 1 分钟），额度充裕。
- `.workflow/` 与 `.github/workflows/` 可共存。GitHub 解封后补一份 Actions workflow 调同一条 `check:ci`（预计 30 分钟翻译工作），届时可停用 Gitee 流水线或留作兜底门禁。
- 不写两份的原因：GitHub 不可达期间 Actions 白跑不了，且避免双平台同时红绿不一致带来的维护噪音。

### Gitee Go 语法要点（apply 时的实现决策）

| 决策 | 内容 | 理由 |
|---|---|---|
| 配置位置 | `.workflow/ci.yml` | Gitee Go 约定目录，入仓库即代码化 |
| 插件 | `build@nodejs`（`nodeVersion` + `commands` 列表） | commands 逐条串行执行；`strategy: fast` 下 step 失败即整体红 |
| **Node 由 commands 自装** | 首条命令从 npmmirror 拉 `node-v20.19.0-linux-x64.tar.gz` 解到 `/usr/local`（curl/wget 兜底），node/npm/npx 进系统 PATH | **首跑教训（2026-09-12）**：插件对 `nodeVersion` 的支持清单不可靠——v20.15.0 被静默跳过，容器内无 node/npm（仅自带 standalone pnpm，内嵌 node ⇒ pnpm install 能跑但一切 postinstall / tsc / vitest / biome / npx 全灭）。旧官方文档支持清单仅 8.16.2~15.12.0。自装方案不依赖插件行为，`nodeVersion` 字段仅作必填占位 |
| **失败链收成单条命令** | `pnpm install --frozen-lockfile && pnpm check:ci` 一条命令完成安装与五道门 | **首跑实证**：commands 逐条执行、单条失败**不短路**（ELIFECYCLE 后后续命令照跑）。若逐条写且退出码按最后一条算，存在「前面红后面绿 → 假绿」风险；`check:ci` 内部即 `&&` 链，任一道门失败即非零退出，从根上排除 |
| 触发 | `push` 精确匹配 `main` + `pr` 精确匹配 `main` | 与原设计一致；PR 按源分支最新 commit 的 yml 触发 |
| pnpm 安装 | `npm install -g pnpm@9.15.9 --registry=https://registry.npmmirror.com`（Node 装好后 npm 可用） | 版本钉死对齐 `packageManager`；走 npmmirror 提升国内拉速 |
| 连续推送收敛 | **首期不做**（Gitee Go 未见 concurrency 等价物） | 这是 GitHub Actions 的 `concurrency` 专属能力，解封后配 Actions 时补上；Gitee 侧连续 push 会排队执行，不影响红绿正确性 |

### CI 环境与矩阵

| 项 | 取值 | 理由 |
|---|---|---|
| 触发 | `push` → `main` + `pull_request` → `main` | main 保绿 + PR 前置拦截 |
| 平台（首期） | Gitee Go 云端 Linux 容器 | 见上「CI 载体」 |
| Node | 20 系（`engines.node` 要求 `>=20`） | 与 `engines.node` 一致 |
| pnpm | 9.15.9（commands 内 `npm i -g` 钉版本） | 与根 `packageManager` 字段一致 |
| 密钥 | **无** | 测试零 API 消耗，任何 key 注入都意味着测试设计出了问题 |
| 依赖安装 | `pnpm install --frozen-lockfile` | 锁定 `pnpm-lock.yaml`，避免 CI 静默升级依赖 |

### OS 选择的依据（已核查，非"假设无依赖"）

早期草稿的理由写的是"仓库代码是纯 TS + Node 工具链，无 Windows API 依赖"——**这个依据不足**。实测核查了三类"看起来可能平台相关"的用例后，结论仍是首期可跑 Linux（Gitee Go 云端容器同为 Linux，以下核查结论原样适用）：

1. **真实网络/端口用例**（不是纯 mock）：
   - `packages/llm-proxy/test/handler.test.ts:447` — `startProxyServer({ port: 0 })` 后 `fetch("http://127.0.0.1:<port>/v1/chat/completions")`。回环 + 真实 HTTP 客户端，Linux 上正常。
   - `apps/desktop/test/proxy.test.ts:150,166` — `toggle({ port: 0, upstreamBaseUrl: "https://upstream.test" })`。`upstreamBaseUrl` 是 stub 域名、不会真解析，无外网依赖。
2. **已知风险（登记，不在本 change 修）**：`packages/llm-proxy/test/handler.test.ts:472` 用**硬编码端口 58772** 断言"重复监听报 EADDRINUSE"。这是经典 CI 隐患：runner 上若有其它进程占用该端口，会**假红**。本 change 只登记，修复留给后续小 change。
3. **跨平台写法已确认无需改**：`packages/replay/test/model-ab-cli.test.ts:63` 用 `spawnSync(process.execPath, [CLI_PATH, ...args])` 直接以 node 启动 `dist/*.js`，不依赖 shebang 或可执行位，跨平台安全。
4. **一颗埋着的地雷（登记）**：`apps/desktop/test/app-icon.test.ts:7` 期望值写死 `"D:/ReBaseAgent/apps/desktop"`。它是纯字符串拼接断言，Linux 上**恰好**也能过（`join` 在这条路径上无分歧），但一旦扩到 Windows + Linux 双跑、或有人拿它当路径语义守卫，就会出问题。

因此 **首期只跑 Linux，不预先上 Windows 矩阵**（那会把 CI 耗时翻倍，而目前没有平台相关失败证据）。若首期真出现平台相关失败，**逐条判定**为「修测试使其平台无关」或「补 Windows 矩阵」，**不得直接跳过或删掉失败用例**——这条写进 spec。

## 失败处理与可见性

- step 名要能一眼定位是"构建挂了 / 类型挂了 / 测试挂了 / 风格挂了 / 规范挂了"。
- 测试失败时输出**包名 + 失败用例名**（vitest 默认 reporters 已够用，首期不加自定义 reporter）。
- 不设置 `continue-on-error`——任一环节失败即整体红。安全网的价值在于它**会响**。

## 与既有约定的关系

- **不改 `packageManager`/`engines`**：CI 反向校验它们，而不是被它们迁就。
- **不改 `biome.json` 的 ignore 列表**：`release/`、`dist/`、`.rebaseagent/` 已忽略，CI 环境里这些目录不存在。
- **`docs/` 与 `HANDOFF.md` 不入库**：CI 不依赖它们，也不要求它们存在。
- **本机与 CI 的 pnpm storeDir 差异**：本机用 `D:\.pnpm-store\v3`，CI 用默认 store。store 位置不影响校验结果，无需对齐。
- **desktop 测试不依赖 renderer 产物**：实测 `apps/desktop/test/` 下 12 个文件全部 import `../src/main/*` 或 `../scripts/*.mjs`，**不读 `dist/renderer/`**。这正是"可以不给 desktop 跑 `electron-vite build`"的论据——收窄构建范围不会让 desktop 测试失去覆盖。
- **renderer 资源规范不在 CI 覆盖范围**：`apps/desktop/scripts/release-check.mjs` 的 Monaco 静态审计（禁包根导入、禁 `basic-languages` 聚合入口）属于 `release:verify`，需要产物路径，**在 CI 里永不执行**。这是有意的：CI 绿 ≠ 渲染资源正确，这条边界由 `release:verify` 在本地守。
