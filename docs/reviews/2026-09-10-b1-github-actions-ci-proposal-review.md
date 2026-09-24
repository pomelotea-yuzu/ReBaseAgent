# 审阅：`add-github-actions-ci`（B1）proposal

- 日期：2026-09-10
- 审阅对象：`openspec/changes/add-github-actions-ci/`（proposal.md / design.md / tasks.md / specs/ci-gates/spec.md）
- 审阅方式：逐条比对仓库实际结构（6 个 `package.json`、`pnpm-workspace.yaml`、`biome.json`、测试文件、`electron.vite.config.ts`、`release-check.mjs`、`README.md`、归档 proposal 范式）
- 结论：**方向正确，但有 5 个必须先修的硬缺陷**，其中 P0 两条会导致"CI 假绿"或"CI 直接红"。修完可以 apply。

---

## 总评

这是本仓第一个"非产品功能类"的 change——它不改任何运行时行为，只把已有基线固化成门禁。定位选得对：B1 排在 D-A / D3 / A1 之前，正是因为在动内核边界之前先要有安全网。design.md 的"一条命令是唯一事实源"论证质量高，cwd 陷阱那节把本仓踩过的坑写进了设计，这是好习惯。

问题全部集中在**"照当前 tasks.md 写下去会出错"**这一类具体性缺陷上，不是路线问题。

---

## P0：会导致 lead 结果错误，必须改

### P0-1 `pnpm -r build` 会在 CI 首次运行就红

`apps/desktop` 的 `build` 是 `electron-vite build`，**不是** `tsc -p tsconfig.json`（实测 `apps/desktop/package.json:25`）。design.md 第 40 行断言：

> **build**（`pnpm -r build`，让每个包的 `tsc -p tsconfig.json` 产出 dist）

这句话对 5 个 `packages/*` 成立，对 `apps/desktop` 不成立。而 `pnpm -r build` 会在每个 workspace 包里执行 build 脚本，于是 CI 在"构建"这一步就会去跑完整的 Vite 前端打包 + 加载 monaco/echarts/tailwind 插件链。

至少三处后果：

1. **与本 change 的 Explicit Non-goal 自相矛盾**。proposal Non-goals 写着"不跑 Electron 打包与 GUI 冒烟"、spec 的 `不覆盖发布与 GUI 验证` 也要求 CI SHALL NOT 执行 Electron 打包。而 `electron-vite build` 正是 `electron-builder dist` 的前半段——CI 会执行它。
2. **新增大量与门禁无关的失败面**：Tailwind v4 的 `@tailwindcss/vite`、Monaco worker 解析、`EPERM` 类插件报错，任何一个红掉都不是"我的测试挂了"。
3. **耗时**：实测本机完整 electron-vite build 明显长于 5 个 tsc 之和，每次 CI 都付这笔钱。

**建议改法**（三选一，推荐第 1 个）：

- **① 需要哪些包 build 就列哪些包**：`check:build` = `pnpm --filter "./packages/*" build`。理由是跨包消费者只存在于 `packages/*` 之间（`replay` 的 bin 取 `../dist/model-ab-cli.js`、`desktop` 运行时解析 workspace 包），`apps/desktop` 没有跨包消费者——它自己就是链路终点。
- ② 保留全量但显式声明豁免：`pnpm -r --filter "!@rebaseagent/desktop" build`，并在 proposal/design 里写明"刻意不构建 desktop，因为其 build 是打包链路而非类型构建"。
- ③ 若真想让 desktop 也过类型检查：加一个 `check:typecheck` step 走 `pnpm --filter @rebaseagent/desktop typecheck`（`tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.web.json --noEmit`），这是无副作用的纯检查，和"打包"性质完全不同。

无论选哪个，**design.md 第 40 行的括号注释必须改**——它现在写死了错误的实现细节。

### P0-2 `check:test` 依赖 `dist/`，而 build 不产出全部所需产物

design.md 第 33 行说：

> workspace 包的 `package.json` 的 `exports` 只指向 `./dist/`。跨包消费者（`replay` 的 `rebaseagent-model-ab` bin、`desktop` 的运行时解析、`scripts/*.mjs` 里显式写的 `dist/index.js`）全部取 dist。

**这句话漏了最关键的一类消费者：测试自己。** 实测 `packages/replay/test/model-ab-cli.test.ts:17`：

```ts
const CLI_PATH = resolve(import.meta.dirname, "../dist/model-ab-cli.js");
const skip = !existsSync(CLI_PATH);
...
describe.skipIf(skip)("rebaseagent-model-ab CLI（dist 冒烟）", () => { ... });
```

这个文件里有**完整的一整组 CLI 冒烟用例**（`--dry-run` 免密钥退出 0、`require_empty` 拒绝父 run 退出 2 等），它们的守卫条件是 `dist/model-ab-cli.js` 是否存在。

把两个约束叠起来看：

- build 若按 P0-1 的选项 ① 收窄到 `packages/*` → `model-ab-cli.js` 有产出，**这组用例会真实执行**。这是好事，前提是它们真的能过（见 P1-1）。
- build 若误配成不含 `replay`、或 CI 顺序被后人改成 test → build → **这组用例会静默 `skip`，434 这个数字当场缩水**，而 CI 依然全绿。

所以：**这个 skip 守卫是 CI 里的静默失真源，必须被显式写进 spec，而不是留给读者从 `dist` 推断。** 建议加一条 Requirement 或至少在 `构建先于测试` 的 Scenario 里点明：跨包 CLI 冒烟用例以 `dist` 存在为前置；CI 顺序固定为 build → test 就是为了让它们被执行而非跳过。

顺带：`packages/trace-test` 的 8 个测试文件（含 `rerun.test.ts` / `run-test.test.ts`）**没有任何 CLI spawn**，记忆里"trace-test 含 CLI spawn 冒烟"这一条不准确——B1 落地时不要按那条记忆去配 build 范围。

---

## P1：会在 apply 阶段暴露的具体性缺陷

### P1-1 「Linux 首期」的结论缺依据，且仓库确有触碰网络的测试

design.md 的 OS 矩阵一节写：

> 仓库代码是纯 TS + Node 工具链，无 Windows API 依赖

**依据不足，但结论可能是对的。** 实测两个真实的网络/端口用例：

- `packages/llm-proxy/test/handler.test.ts:447` — `startProxyServer({ port: 0 })` 然后 `fetch(\`http://127.0.0.1:${server.port}/v1/chat/completions\`)`，回环 + 真实 HTTP 客户端。
- 同文件 `:472` — 用**硬编码端口 58772** 断言"重复监听报错"。这是经典的 CI 并行隐患：GitHub runner 上另一个进程或同 job 的其它并发占掉 58772 就会假红。
- `apps/desktop/test/proxy.test.ts:150,166` — `toggle({ enabled: true, port: 0, upstreamBaseUrl: "https://upstream.test" })`（`upstreamBaseUrl` 是 stub 域名，不会真解析，这点没问题）。

另外两个**平台相关断言**：

- `packages/replay/test/model-ab-cli.test.ts:63` — `spawnSync(process.execPath, [CLI_PATH, ...args])` 直接 spawn `dist/*.js`。这个写法跨平台安全（不依赖 shebang/sh 权限位），是正确姿势，无需改。
- `apps/desktop/test/app-icon.test.ts:7` — 期望值直接写死 `"D:/ReBaseAgent/apps/desktop"`。这是纯字符串拼接断言，Linux 上**恰好**也能过（`join` 在这条路径上没有分歧），但它是一颗埋着的地雷：一旦 os 矩阵扩到 Windows 与 Linux 同时跑、或有人拿它当路径语义的守卫，就会出问题。

**建议**：① 把 CI 的 OS 选择理由从"假设无平台依赖"改成"已核查 X/Y/Z 三类用例，结论为首期 Linux 可跑"；② 在 tasks 里加一条"记录首期 Linux 若出现的失败，逐条判为'平台无关化'还是'补 Windows 矩阵'"，这条应写进 spec 的 Scenario，而不只是 design 的散文。

### P1-2 P0 缺陷的根因：把「构建顺序」当 design 细节，没进 spec 的可验证契约

spec.md 的 `构建先于测试` 只说了"CI SHALL 在运行测试之前先构建全部 workspace 包"，但**"全部 workspace 包"包含了不该被构建的 desktop**，"构建使用各包自身的构建脚本"又把 `electron-vite build` 合法化了。

这是 P0-1 能在 spec 层面成立的原因：**约束写得太宽，宽到把 non-goal 反向包含进来。** 建议把这条 Requirement 重写为可判定的形式：

> CI SHALL 在测试前构建 workspace 包中**被测试或跨包消费的**构建产物。构建 SHALL NOT 执行前端打包链（electron-vite）或产出可分发产物。

### P1-3 proposal 缺 `## Capabilities` 章节，与仓库范式不一致

实测：本 proposal 的章节是 `Why / What Changes / Goals / Non-goals / 保真度边界 / 影响范围`；而已归档的 `2026-09-07-finish-v2-desktop-release/proposal.md` 用的是 `Why / What Changes / **Capabilities（New + Modified）** / Non-goals / Impact`。

`specs/ci-gates/spec.md` 已经放好了新能力，但 proposal 正文里没有 `### New Capabilities` 声明它。这会让归档工具/读者无法从 proposal 直接对上 spec delta，也破坏"每份 proposal 结构一致"的可扫读性。**补上**：

```markdown
## Capabilities

### New Capabilities

- `ci-gates`: 持续集成质量门禁——单命令校验入口、逐包测试语义、构建先于测试、零密钥、OpenSpec 固定版本、失败可见性。

### Modified Capabilities

（无。本 change 不改变任何既有能力的用户可见行为。）
```

### P1-4 `check:ci` 的脚本名与既有 `build` / `test` / `lint` 的关系没交代

根 `package.json` 已有 `build` / `test` / `lint`。design 提的 `check:build / check:test / check:lint / check:spec` 是**新的一套平行命名**。风险是两套命令逐渐分叉（`pnpm test` 跑 A，`pnpm check:test` 跑 B），恰好违背这个 change 的核心动机"消除口径漂移"。

**建议**：明确写清命名意图——`check:*` 是"CI 口径"的显式命名，`build/test/lint` 是"开发者随手用"的快捷方式，并**让快捷方式指向 check 实现**（例如 `test` → `pnpm -r --filter "./packages/*" --filter "./apps/desktop" test`，与 `check:test` 同源），而不是各写一份。或者直接删掉旧的 `test`/`build` 改名为 `check:*`，但那会破坏 README 里已写的 `pnpm test`，需要一并更新（tasks 3.2 已覆盖 README）。

这条不修也能跑，但它正是这个 change 要防的那类腐化，值得在 design.md 里多写两行。

---

## P2：建议项，不阻塞

- **`apps/desktop` 有 12 个测试文件（156 用例）**，`check:test` 的 filter 已包含 `apps/desktop`，正确。但 design 里没说明"desktop 测试与 renderer 构建无关"——实测 12 个测试全部只 import `../src/main/*` 与 `../scripts/*.mjs`，**不读 `dist/renderer/`**，所以 P0-1 收窄 build 范围不会让 desktop 测试失去覆盖。这一点值得写进 design 当作"为什么可以不给 desktop build"的论据。
- **`release-check.mjs` 的 monaco 静态审计**（`apps/desktop/scripts/release-check.mjs:30-50`：禁包根导入、禁 basic-languages 聚合入口）在 CI 里**永不执行**——它属于 `release:verify`，需要 artifact 路径。proposal 说"CI 不证明打包产物可用"已经诚实声明了，但可以考虑加一句显式说明："renderer 源码级 monaco 规范由 `release:verify` 在本地守，CI 不覆盖"，避免读者以为 CI 绿=渲染资源正确。
- **`npx -y @fission-ai/openspec@1.12.0` 每次 CI 联网下载**。design 已说明"必须固定版本"并解释了原因，判断正确。可选优化：CI 里缓存 npx 的 `_npx` 目录，省一次下载（非必需，别为它增加复杂度）。
- **`concurrency` 取消在途运行**：spec 有对应 Scenario，好。注意 `pull_request` 触发时 `github.ref` 是 `refs/pull/N/merge`，按 ref 分组语义正确。
- **`check:spec` 未说明是否需要在 CI 里保留 `--strict`**——tasks 1.3 写了 `--all --strict`，spec 的 Requirement 也写了，一致，无误。
- 一处小瑕疵：`spec.md:25` 用「系统 SHALL NOT 使用『根运行器 + `--root <包路径>`』形式」，这句是**实现方式的负向约束**，本身没问题（它有真实的技术理由：模块双实例导致 `instanceof` 假阳性），但建议在同一 Requirement 的 Purpose 或 Scenario 里补一句"该约束来自 2026-09-10 实测"，让后来者不敢顺手改掉。

---

## 与既有基线的一致性核对

| 项 | proposal 声称 | 实测 | 结论 |
|---|---|---|---|
| 包数 / 测试数 | 6 包 434 测试 | 6 个 `package.json`（5 packages + 1 app）✓ | 一致 |
| `packageManager` | pnpm 9.15.9 | `package.json:7` = `pnpm@9.15.9` ✓ | 一致 |
| `engines.node` | `>=20` | `package.json:20` = `>=20` ✓ | 一致 |
| openspec CLI | `@fission-ai/openspec@1.12.0` | 与工程约定一致 ✓ | 一致 |
| biome | `biome check .` | `package.json:11` = `biome check .` ✓ | 一致 |
| lockfile | `--frozen-lockfile` | `pnpm-lock.yaml` 存在，`lockfileVersion: 9.0` ✓ | 一致 |
| desktop 无跨包消费者 | （design 未讨论） | `apps/desktop` 无 `exports`，无人依赖它 | **需补进 design** |
| 测试读 dist | design 未提 | `model-ab-cli.test.ts` 有 `skipIf(!existsSync(dist))` | **P0-2** |

---

## 修复清单（按顺序）

1. **P0-1** 改 `check:build` 范围为 `pnpm --filter "./packages/*" build`（或显式豁免 desktop），同步修 design.md 第 40 行的括号注释。
2. **P0-2** 在 spec 的 `构建先于测试` 里写明"跨包 CLI 冒烟以 dist 存在为前置"，并补一条 Scenario 断言"CI 中这些用例被执行而非 skip"。
3. **P1-2** 重写 `构建先于测试` 的 Requirement 措辞，把"全部 workspace 包"改成"被测试或跨包消费的包"，并加"不得执行前端打包链"。
4. **P1-1** 把 OS 结论的依据写成"已核查三类用例"而非"假设无依赖"；把 `handler.test.ts:472` 的硬编码端口 58772 记为已知风险（可开后续小 change 修，本 change 只记录）。
5. **P1-3** proposal 补 `## Capabilities`（New: `ci-gates` / Modified: 无）。
6. **P1-4** design.md 补一段"`check:*` 与既有 `build/test/lint` 的命名关系"，避免两套命令分叉。
7. **P2** 择要补进 design 的"与既有约定的关系"一节（desktop 测试不依赖 renderer dist、release:verify 不在 CI 覆盖范围）。

修完 1–4 即可 apply；5–6 建议同批处理（都是一句话的事）。

---

## 附：一处值得表扬的设计

design.md 的「关键约束：vitest 的 cwd 陷阱」把本仓 2026-09-10 实测的 `--root` 双实例问题写进了设计文档并给出正确的替代形式（`pnpm -r` 逐包执行），同时 spec 用 Requirement 把它固化。这正是"踩过的坑变成不会复发的门禁"的正确做法——后续 D-A / D3 动内核时，这个约束会自动保护它们。

---

# 复审（2026-09-10 19:25）—— 改后结果

判定：**可以放行。** 5 项缺陷全部修入，且本次独立实跑验证了其中最关键的声称值。

## 逐项核对

| 编号 | 修复情况 | 证据 |
|---|---|---|
| P0-1 构建范围 | ✅ 修入 | `check:build` = `pnpm --filter "./packages/*" build`；新增 `check:typecheck` 承接 desktop 类型安全；design §`check:*` 与既有脚本的关系 整节专门论证；tasks 头部加了 P0 提醒 |
| P0-2 静默跳过 | ✅ 修入 | spec 新增独立 Requirement「跨包 CLI 冒烟不得静默跳过」+ 2 个 Scenario；design 新增专节含 66 vs 62 对照表；tasks 1.5 有反向验证任务 |
| P1-1 OS 依据 | ✅ 修入 | design 新增「OS 选择的依据（已核查，非"假设无依赖"）」——列出 4 类核查项，含端口 58772 风险登记与 app-icon 地雷 |
| P1-2 措辞过宽 | ✅ 修入 | Requirement 重写为「构建范围限于被测试或跨包消费的包」，明确 SHALL NOT 执行 `electron-vite`、SHALL NOT 产出可分发产物 |
| P1-3 Capabilities | ✅ 修入 | proposal 第 18–26 行补 `## Capabilities`（New: `ci-gates` / Modified: 无） |
| P1-4 命名关系 | ✅ 修入 | design 第 24–40 行表格 + 「唯一一处差异」说明，并声明既有 `build` 保持不变 |
| P2 边界澄清 | ✅ 修入 | design 末节补「desktop 测试不依赖 renderer 产物」「renderer 资源规范不在 CI 覆盖范围」 |

## 独立实跑验证（本次）

```
$ npx -y @fission-ai/openspec@1.12.0 validate --all --strict
✓ change/add-github-actions-ci
✓ spec/agent-loop ... ✓ spec/trace-format      (10 个主 spec)
Totals: 11 passed, 0 failed (11 items)          耗时 6184ms
```

与 proposal §证据 表格声称的 **11/11** 一致；status=0。另确认 `openspec/specs/` 仍为 10 个主 spec（无 `ci-gates`）、`.github/workflows/ci.yml` 尚不存在 —— 符合"proposal 阶段未动代码"的预期。

stderr 的 2 条 `[INFO] Requirement text is very long (>500 characters)` 经定位出自**既有主 spec**：`agent-loop[3]`（517 字）、`llm-proxy[1]`（590 字）。本 change 的 10 条 Requirement 正文最长仅 271 字，**不是本 change 引入的噪音**，且为 INFO 级不影响退出码。

## 残留 P1（不阻塞放行，建议 apply 时顺手改）

**`check:test` / `check:lint` / `check:typecheck` 在字面上就是复制体，与 design 自称相反。**

design.md 第 30–31 行写：

> `check:test` | `pnpm -r test` | **与既有 `test` 同一条命令**（不是复制体，是同一个表达式）
> `check:lint` | `biome check .` | **与既有 `lint` 同一条命令**

但实测根 `package.json` 既有值为 `"test": "pnpm -r test"`、`"lint": "biome check ."` —— design 给的取值与它们**逐字相同**。也就是说字面上它们恰恰**就是**复制体，design 把这个结论写反了（意图对、事实错）。

而且 `check:typecheck` 有同样问题，还被漏掉了：根 `package.json` **本来就有** `typecheck`（值 = `pnpm --filter @rebaseagent/desktop typecheck`，与 `check:typecheck` 逐字相同）。design 与 tasks 1.1 都把它措辞为"新增"，读者会以为此前不存在。

真正做到"物理上无法分叉"只能靠**引用既有脚本**：

```json
"check:typecheck": "pnpm typecheck",
"check:test": "pnpm test",
"check:lint": "pnpm lint"
```

这样只有一处定义，后人改 `test` 时 `check:test` 自动跟随。无递归风险（`pnpm test` → `test` 脚本 → `pnpm -r test`，无回路）。`check:build` 保持现状正确 —— 它与既有 `build` 取值不同，是设计里明说的**刻意收窄**。

这条之所以值得改：它精准命中本 change 的核心动机（防口径漂移）。文档承诺了"同一个表达式"，实现层面却是两份字面量 —— 后续若要改测试命令，两份都得改，漏一处就是本 change 想消灭的那种漂移。

## 流程提醒（非缺陷）

tasks 4.3 要求「在真实 GitHub 上触发一次 push 与一次 PR，确认工作流变绿」。按本仓约定 **push 由用户手动执行**（沙箱凭证限制），所以 apply 阶段 agent 能交付的是"workflow 写完 + 本地 `check:ci` 跑通"，**绿不绿必须等用户 push 后才能确认**。建议 apply 收尾时明确产出交接单，把这条挂起项写清楚，不要默认 agent 能自证。
