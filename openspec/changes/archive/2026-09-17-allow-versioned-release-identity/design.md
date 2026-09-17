# 设计：发行身份的版本同源推导

## Scope and Dependencies

本 change 只改 `desktop-distribution` 这一 capability 的发行身份要求，以及配套的发行验收工具。
不依赖其他 change，也不改动产品运行时、trace 格式或用户数据。

## Goals / Non-Goals

**Goals**

- 让发行身份可辨认：每次发行由目标版本唯一决定产物名，不再有"版本必须等于 `0.2.0`"的硬约束。
- 消除版本值的多副本：应用版本与产物名的真相收敛到一处，切换版本不再需要人工同步多个文件。
- 保持既有门禁不放宽：体积上限、renderer 源码导入审计、worker 集合审计三项行为与阈值不变；验收仍拒绝把既有产物当作本次结果。

**Non-Goals**

- 不引入自动版本提升、changelog 或 release notes 自动化；不做 CI 自动打包或发布。
- 不改动 `electron-builder.yml` 的 `artifactName` 模板，也不改 `BYTE_LIMIT` 数值。
- 不重新打包 K0；用可辨认版本重打体验包是归档之后的操作。

## 决策

### D1 唯一真相 = `apps/desktop/package.json` 的 `version`

产物名由该版本经模板推导，不再维护独立的期望常量。理由：electron-builder 本身就以应用包版本渲染
`artifactName`（`electron-builder.yml:66,71` 的 `ReBaseAgent-${version}-win-x64-portable.${ext}`），
以同一来源推导才能保证"期望值"与"实际产物"不可能各自漂移。

**被否决的方案**：把期望版本改成从命令行参数或环境变量传入。那只是把硬编码从代码搬到调用处，
仍会出现"传参值与 builder 实际使用的版本不一致"的窗口，且给每次验收增加一个易漏的输入。

### D2 模板一致性由测试守护，不在运行时解析 YAML

`expectedArtifactName(version)` 内联模板字符串，并在注释中标明它必须与 `electron-builder.yml` 的
`artifactName` 一致。另加一条测试读 `electron-builder.yml`、断言模板字面量存在，防止二者日后各自演进。

**被否决的方案**：运行时读取并解析 `electron-builder.yml`。该模块是纯函数模块（被 vitest 直接引用），
引入 YAML 解析与文件路径依赖会破坏其可测试性，也会给验收增加一项本可静态保证的前提。

### D3 `verifyRelease` 在返回值中带出期望值

新增返回字段 `expectedVersion` 与 `expectedArtifactName`，供 CLI 展示"期望 vs 实际"。
用户看到失败时能直接知道期望什么，不必回读脚本常量。

### D4 读取应用包失败不抛错，降级为 `appVersionOk: false`

`readAppVersion` 对文件不存在、JSON 非法、`version` 缺失或非字符串一律返回 `null`，不抛异常。
理由：验收的职责是判定并报告，而不是在读取阶段崩溃；`null` 会让 `fileNameOk`/`appVersionOk`
双双为 `false`，从而 `ok: false`，语义正确且可诊断。

**移除的导出**：`EXPECTED_ARTIFACT_NAME`、`EXPECTED_APP_VERSION`。二者是"版本多副本"的来源，
保留会与 D1 冲突。全仓核实其引用只有三处（见下表），随本 change 一并迁移。

## apply 前对真实代码的核实

| 提案假设 | 核实方法与结果 |
|---|---|
| `verifyRelease` 接受 `appPackagePath` 并能从中读版本 | ✓ `apps/desktop/scripts/release-check.mjs:163-173`，已有 `options.appPackagePath` 分支 |
| 两个期望常量只有三处引用 | ✓ 全仓 grep `EXPECTED_APP_VERSION\|EXPECTED_ARTIFACT_NAME`：定义在 `release-check.mjs:17,19`、文案在 `release-verify.mjs:42,43,89,90`、断言在 `release-check.test.ts:8,179,190,199,207,208`；无第四处 |
| `electron-builder.yml` 已按 `${version}` 生成文件名 | ✓ `electron-builder.yml:66,71`；无需改动 |
| 体积与资源审计与版本无关 | ✓ `checkSize`/`auditRendererSource`/`auditWorkerAssets` 均不引用期望常量 |
| 测试既有用例可作为等价覆盖基线 | ✓ `release-check.test.ts:164-211` 共 5 例：旧版本名拒绝、版本匹配通过、版本不匹配失败、体积边界失败、常量口径 |
| 依赖文件名模板的具体形态 | ✓ 现模板为 `ReBaseAgent-<version>-win-x64-portable.exe`，与 `EXPECTED_ARTIFACT_NAME` 的字面量一致 |

## 已知取舍

- **放弃了"硬编码防呆"**：原来改版本必须同时改脚本常量，漏改会被测试拦下（`toBe("0.2.0")`）。
  改为同源推导后该防呆消失——但这正是目的：单副本后不存在"两处不一致"这种故障形态，
  取而代之的是 D2 的模板一致性测试，守护的是另一个真实风险（模板与推导函数漂移）。
- **验收不再能校验"本次是否就是某次记录的目标版本"**：验收以当前应用包版本为准。
  跨版本比对（如"对 0.2.0 的产物验收，而应用包已是 0.3.0"）会判为失败，行为符合
  delta 的 Scenario「既有产物不被误报为本次结果」。
