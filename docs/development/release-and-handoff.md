# 发布与维护交接指南

修订日期：2026-09-27。本文整理现有命令与执行要求，本轮没有运行构建、验收、上传、推送或交接。脚本以目标提交中的 [根 package.json](../../package.json)、[桌面 package.json](../../apps/desktop/package.json) 和 [打包配置](../../apps/desktop/electron-builder.yml) 为准。

## 发布前确定基线

1. 记录目标版本、源码提交、包含范围、平台和未完成项，核对 OpenSpec 与验收记录。活动 change 的部分实现不能作为整项交付证据。
2. 在独立 checkout 中固定候选提交，核查工作树和锁文件；有本地改动时先说明并纳入候选来源，不把单个提交号当作完整构建来源。不要在其他会话的研发工作区安装依赖、重建共享产物或占用验收实例。
3. 核对 `apps/desktop/package.json` 的版本与预期产物名 `ReBaseAgent-<version>-win-x64-portable.exe`，为本次候选选择未使用的输出目录。不要覆盖、移动或删除旧包；已公开版本不静默替换同名资产。
4. 记录实际 Windows、Node、pnpm 版本和锁文件 SHA-256。pnpm 版本取根 `packageManager`，依赖按锁文件安装；下载失败或环境不满足时保留错误，不放宽锁文件凑出构建。

## 构建与静态检查

以下命令供正式发布工作使用，工作目录为独立 checkout 的仓库根。在 Windows PowerShell 使用 `pnpm.cmd`，避免调用受执行策略限制的 `.ps1`。逐条执行并检查退出码，某一步失败就停止后续步骤。

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd check:ci
pnpm.cmd build
```

`check:ci` 构建库包后依次做类型、测试、风格和规范检查；它不构建桌面前端或发行包。`pnpm build` 补完整构建。原始日志保留实际用例数、失败及跳过原因，不沿用旧发布数字；环境问题导致检查未完成时不宣称通过。

默认 `dist` 脚本使用固定输出目录 `release/stable`。候选发布采用已经完成的桌面构建，并显式指定独立输出目录。下列候选标识需要按实际日期、版本和提交替换；确认没有其他发布进程使用该目录后再执行：

```powershell
$candidateId = 'candidate-YYYYMMDD-version-commit'
$candidateDir = Join-Path (Get-Location) "release/$candidateId"
if (Test-Path -LiteralPath $candidateDir) { throw '候选目录已存在，请使用新的标识' }
pnpm.cmd --filter @rebaseagent/desktop exec electron-builder --win --config electron-builder.yml "--config.directories.output=$candidateDir"
```

打包成功后，在同一 checkout、同一次构建产物上执行：

```powershell
$appVersion = (Get-Content apps/desktop/package.json -Encoding UTF8 -Raw | ConvertFrom-Json).version
$artifactPath = Join-Path $candidateDir "ReBaseAgent-$appVersion-win-x64-portable.exe"
node apps/desktop/scripts/release-verify.mjs "$artifactPath" --json
Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256
(Get-Item -LiteralPath $artifactPath).Length
```

`release:verify` 当前核查产物名与应用版本、严格小于 100,000,000 字节、指定 renderer 源码及 worker 资源。它检查的是外部构建目录，不能单独证明 exe 内实际资源一致，也不覆盖启动、界面、执行结果或许可证。旧包验收应使用对应源码和构建输出，不能混用当前 `main` 的文件。

## 实包与声明验收

使用本次哈希对应的 portable exe，在独立目录和独立数据副本中核查冷启动、离线阅读/编辑资源、便携数据位置，以及本次承诺的用户流程。按[桌面发行规范](../../openspec/specs/desktop-distribution/spec.md)和各能力验收要求记录证据，不把开发模式通过当作 portable 包通过。

需要真实模型的验证单独说明配置、费用与数据范围；离线资源检查不能替代真实执行验证。本指南不自动启动任何模型或实验。旧冒烟脚本须先确认仍适用于候选界面，不能因脚本名称含“验收”就把旧断言当成当前覆盖。

第三方内容按[第三方声明说明](third-party-notices.md)核对实际 bundle、asar、运行时和声明交付位置。发现许可或必需功能问题时保持候选状态，修复后记录新的产物哈希与受影响项复验。

## 发布记录与双端同步

建议每次候选在 `docs/engineering/reports/` 新建带日期和版本的记录，至少包含：

| 字段 | 应记录的内容 |
|---|---|
| 来源 | 提交、工作树状态、锁文件哈希、构建环境、目标版本与范围 |
| 产物 | 文件名、精确字节数、SHA-256、独立输出目录 |
| 验证 | 命令与退出码、实际测试与跳过项、实包证据、未验证或失败项 |
| 声明 | 实际组件清单、许可/NOTICE 位置、用户取得声明的方法及核查记录 |
| 发布 | 标签对应提交、预览/正式状态、GitHub/Gitee 的下载地址和核验结果 |
| 维护 | 支持范围、升级与备份说明、已知问题和处理入口 |

由维护者确认候选具备发布条件后再创建对应标签、Release 和资产。两个平台分别记录结果；一端完成不能标为双端已发布。重新下载后核对哈希，确认 README、更新日志和下载链接指向本次版本，避免指向持续变化的 `main` 作为唯一版本依据。

若已发布包存在问题，说明受影响版本、临时规避和后续版本；必要时撤下有问题的下载并保留原因记录，不静默重写标签或同名资产。退回旧包前按[维护政策](maintenance-policy.md)核查数据兼容性，不直接用旧程序覆盖新数据。

## 维护交接

| 交接项 | 接收方需要得到的内容 |
|---|---|
| 范围与状态 | 模块职责、支持版本、活动 change、未解决问题及当前承担者 |
| 技术入口 | 规范、构建/测试命令、数据格式与兼容边界、最近一次发布记录 |
| 发行资产 | 版本、提交、哈希、第三方声明位置、各平台同步情况 |
| 平台权限 | 仓库审阅、合入、发布、安全报告等必要权限及授予人；不移交个人账号密码 |
| 未完成事项 | 未验证流程、环境限制、需要补齐的公开证据和接收日期 |

接收人实际完成相关任务后记录结果；仅阅读指南不算完成交接。先授予所需的最小权限，确认接收后再处理原维护者权限。凭据通过合适的私密渠道配置或轮换，不写入仓库、日志、Issue 或交接表。目前没有第二维护者，本文件不表示任何权限或责任已经转交。
