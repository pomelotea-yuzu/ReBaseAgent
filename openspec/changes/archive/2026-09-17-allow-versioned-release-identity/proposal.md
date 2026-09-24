# 发行身份改为可辨认且不冲突的版本标识

## Why

`openspec/specs/desktop-distribution/spec.md` 的既有 requirement「v2 收口使用独立的 v0.2.0 发行身份」（第 7–14 行）把发行身份**固定为 `0.2.0`**：

> 系统 SHALL 将根项目与 desktop 发行包版本设为 `0.2.0`，并生成名为 `ReBaseAgent-0.2.0-win-x64-portable.exe` 的新产物。

该约束使任何非 `0.2.0` 的打包与规范直接冲突。2026-09-17 构建 K0 已完成功能体验包时正撞上此约束：`docs/engineering/plans/2026-09-16-isolated-rerun-roadmap.md` §9.1 要求「新体验包使用可辨认的预发布版本**或**独立构建标识**与输出目录**……不覆盖成同名『新旧混合包』」——改版本号违反 spec，不改版本号则与既有产物同名。当次只能取后半条（输出到 `release-k0/`），代价是 K0 包与 09-07 正式版**完全同名**（均为 `ReBaseAgent-0.2.0-win-x64-portable.exe`），仅能靠目录与 SHA-256 区分。

roadmap §9.1 已规划 K0–K4 六个打包节点，自 K1 起会持续产出体验包。若身份继续固定，同名产物将逐节点累积，误用与误发的风险随之上升。

此外，现有实现把目标版本与产物名**重复写在多处**：真相在 `apps/desktop/scripts/release-check.mjs:17,19` 的两个常量，而 `release-verify.mjs:42,43,89,90` 又把同样的字面量各写了两遍（帮助文本与摘要输出）。切换版本需人工同步多处，漏改会让门禁输出与实际产物不一致。

## What Changes

- **放开固定的 `0.2.0` 身份**：把该 requirement 改为「发行物使用可辨认且不冲突的版本身份」。每次发行 SHALL 确定并记录目标版本与产物名；应用版本与产物名 SHALL 由**同一来源**推导，二者不一致时发行验收 SHALL 失败；新产物 SHALL 与既有产物隔离——SHALL NOT 覆盖、移动或删除既有产物，也 SHALL NOT 把既有产物误报为本次结果。
- **版本值收敛到单一来源**：以 `apps/desktop/package.json` 的 `version` 为唯一真相，产物名按既有 `artifactName` 模板 `ReBaseAgent-${version}-win-x64-portable.${ext}` 推导。删除 `release-verify.mjs` 中重复的字面量，改为引用推导结果，使切换版本只需改动一处。
- **门禁语义保持不放宽**：体积上限（严格小于 `100,000,000` bytes）、renderer 源码导入审计、构建产物 worker 集合审计三项 SHALL 保持不变；验收仍 SHALL 拒绝把既有产物当作本次结果。
- **体验包与正式发行可分辨**：记录并区分二者的版本/标识与输出位置，使同名产物不可能被混淆。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `desktop-distribution`：把固定的 `v0.2.0` 发行身份改为可辨认且不冲突的版本身份，新增「应用版本与产物名同源推导」与「新产物与既有产物隔离」两项验收要求；体积与资源审计要求保持不变。

## Impact

| 范围 | 预期改动 |
|---|---|
| `openspec/specs/desktop-distribution/spec.md` | 改写该 requirement 正文与场景；改名以匹配新语义 |
| `apps/desktop/scripts/release-check.mjs` | 目标版本与产物名改为从应用包推导；保留体积与资源审计的纯函数与阈值 |
| `apps/desktop/scripts/release-verify.mjs` | 删除重复字面量，帮助与摘要文案改由推导结果生成 |
| `apps/desktop/test/release-check.test.ts` | 断言从「钉死字面量」改为「同源推导与不一致即失败」；保留体积与资源审计的等价覆盖 |
| `apps/desktop/electron-builder.yml` | 不改动（`artifactName` 模板已按 `${version}` 生成） |

不增加第三方依赖，不改动产品运行时行为，不影响既有 trace 或用户数据。

## 源码依据

以下为当前源码事实：

- `openspec/specs/desktop-distribution/spec.md:7-14`：现有 requirement 与场景把产物名与应用版本同时固定为 `0.2.0`。
- `apps/desktop/scripts/release-check.mjs:15,17,19`：`BYTE_LIMIT` / `EXPECTED_ARTIFACT_NAME` / `EXPECTED_APP_VERSION` 三个导出常量；`verifyRelease()` 用后两者判定 `fileNameOk` 与 `appVersionOk`。
- `apps/desktop/scripts/release-verify.mjs:42,43,89,90`：帮助文本与摘要输出中重复书写 `ReBaseAgent-0.2.0-win-x64-portable.exe` 与 `0.2.0`。
- `apps/desktop/test/release-check.test.ts:178,181,207-209`：用例名与 fixture 使用 `0.2.0`，并有三条 `toBe("0.2.0")` 式断言钉死三个常量。
- `apps/desktop/electron-builder.yml:66,71`：`win.artifactName` 与 `portable.artifactName` 均为 `ReBaseAgent-${version}-win-x64-portable.${ext}`，即 builder 已按应用包版本生成文件名。
- `docs/engineering/reports/2026-09-17-k0-experience-build.md`：K0 构建记录，含撞约束的实证、产物哈希与「包名与正式版同名」的已知限制。

## 验收标准

1. **版本可辨认且同源**：仅改动 `apps/desktop/package.json` 的 `version` 后，产物名与发行验收的期望值同步变化，无需修改任何脚本；应用版本与产物名不一致时验收以非零状态失败，并报告期望值与实际值。
2. **既有产物隔离**：使用与既有产物相同的产物名重新构建时，新产物输出到不同位置，既有产物的字节数与哈希保持不变。
3. **门禁不放宽**：体积上限、renderer 源码审计、worker 集合审计三项的判定行为与阈值与改动前等价；切换版本不能绕过任何一项。
4. **不误报**：既有版本的产物不能被本次验收判为通过。
5. **回归**：现有 `release-check` 测试的等价覆盖保留（体积边界、资源审计、文件名与版本判定），桌面端质量门禁全绿。

本次 proposal 编写不代表上述实现验收已经通过。

## Non-goals

- 不引入自动版本提升、changelog 生成或 release notes 自动化。
- 不改动 `electron-builder.yml` 的 `artifactName` 模板，也不改 `BYTE_LIMIT` 的数值。
- 不做 CI 自动打包或自动发布，不接入发布渠道。
- **不重新打包 K0**：本 change 只改规范与发行工具；使用可辨认版本重打体验包是归档之后的操作，另行记录。
- 不改动产品运行时行为、trace 格式或用户数据。
