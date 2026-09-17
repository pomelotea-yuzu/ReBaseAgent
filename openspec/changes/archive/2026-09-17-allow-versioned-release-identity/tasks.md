# 任务：发行身份改为可辨认且不冲突的版本标识

预算约 2.5h。阶段 1 改发行验收工具与测试；阶段 2 验证与收口。归档后需回填最后一项并补「归档记录」。

## 1. 版本同源推导

- [x] 1.1 在 `apps/desktop/scripts/release-check.mjs` 增加 `expectedArtifactName(version)`、`parseArtifactVersion(fileName)`、`readAppVersion(appPackagePath)`（读取失败/字段非法一律返回 `null`，不抛错）；`verifyRelease` 改为以**应用包版本为唯一真相**推导期望产物名，返回值带出 `expectedVersion` / `expectedArtifactName` / `artifactVersion`；移除 `EXPECTED_ARTIFACT_NAME` / `EXPECTED_APP_VERSION` 两个导出。（实测：`release-check.test.ts` 15 → **24** 例，desktop 全量 197 → **203** 全绿）
- [x] 1.2 `apps/desktop/scripts/release-verify.mjs` 的帮助文本与摘要改用推导结果，摘要新增「目标版本 / 期望产物名 / 实际产物名」三行，删除其中重复书写的版本与文件名。（实测：`--help` 已无 `0.2.0` 字面量，改用 `<应用包 version>` 占位）
- [x] 1.3 测试改为同源语义：期望值随应用包版本变化、版本与产物名不一致即失败、既有版本产物被拒绝、未提供或不可读应用包不放行、推导模板与 `electron-builder.yml` 的 `artifactName` 一致；保留体积边界与资源审计的等价覆盖。（实测：见下方「实施期发现」第 2 条）
- [x] 1.4 同步注释与用法说明：`release-check.mjs` 顶部门禁注释、`release-verify.mjs` 通过条件，去掉「必须为 v0.2.0」的表述。（实测：`biome check` 3 文件 0 错、无 fix）

## 2. 验证与收口

- [x] 2.1 运行 `pnpm check:ci` 与 `pnpm --filter @rebaseagent/desktop build`。（实测：`check:ci` **15 passed / 0 failed**；desktop build 15.91s 通过，editor/json worker 齐备）
- [x] 2.2 回归与失败路径双向验证：对现有 `release-k0/ReBaseAgent-0.2.0-win-x64-portable.exe` 执行 `release:verify`，**应用包版本未变时仍通过**（退出码 0，体积 94,358,251 / 阈值 100,000,000）；版本不一致、未提供应用包、应用包不可读三条失败路径由 1.3 的合成用例覆盖。
- [x] 2.3 归档

## 实施期发现

1. **`biome.json` 的 `files.ignore` 与 `.gitignore` 是两套独立配置**。新增输出目录 `release-k0/` 时，
   只补 `.gitignore` 不够：`biome check .` 仍会扫到 `release-k0/win-unpacked/vk_swiftshader_icd.json`，
   因格式不符让 `check:ci` 直接失败（**扫描文件数 157 → 158 就是信号**）。
   已在 `biome.json` 的 `files.ignore` 补 `**/release-*/**`，与 `.gitignore` 的 `release-*/` 对齐。
2. **「同源推导」必须用跨版本用例验证**：只测一个版本无法区分"期望值来自应用包"与"期望值是硬编码"。
   1.3 因此对 `0.2.0` 与 `0.3.0-k0` 两个版本各跑一遍完整验收（通过），并用 `0.9.9` 的产物名对 `0.2.0`
   的应用包验证失败路径 —— 三者合起来才排除了"换个写法仍然硬编码"的可能。

## 归档记录

- **命令**：`openspec archive allow-versioned-release-identity -y`
- **输出对照**：`desktop-distribution: update` → `+ 1 added` / `- 1 removed`，
  `Totals: + 1, ~ 0, - 1, → 0` —— 与 delta 文件的 1 条 `REMOVED` + 1 条 `ADDED` **逐项吻合**。
- **tasks 状态**：`Task status: 6/7 tasks` + `Warning: 1 incomplete task(s)` —— 唯一未勾的是"归档"本身，
  符合预期（归档前必然未勾）。
- **落主 spec 后校验**：`validate --all --strict` **14 passed / 0 failed**
  （11 份主 spec + 3 个活动 change，数量自洽；归档前为 15 = 11 + 4）。
- **归档路径**：`openspec/changes/archive/2026-09-17-allow-versioned-release-identity/`
- **主 spec 现状**：`openspec/specs/desktop-distribution/spec.md:101` 为新 requirement
  「发行物使用可辨认且不冲突的版本身份」；旧 requirement「v2 收口使用独立的 v0.2.0 发行身份」已移除。
- **注意**：新 requirement 由 OpenSpec 追加到 requirements 列表**末尾**（原版本身份要求是第一条）。
  这是 ADDED 的既有行为，不影响语义，但 spec 的条目顺序与改动前不同。
