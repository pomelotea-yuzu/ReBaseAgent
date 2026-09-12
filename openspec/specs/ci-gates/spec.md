# ci-gates Specification

## Purpose
定义 ReBaseAgent 仓库的自动化质量门禁：在云端 CI（首期为 Gitee Go 流水线；GitHub Actions 待账号解封后补配，两者调用同一条根级校验命令）上执行构建、类型检查、测试、代码风格与规范一致性校验，全程零密钥、零网络模型调用。

## Requirements

### Requirement: 单一可复现的校验入口

仓库 SHALL 在根 `package.json` 提供一个汇总脚本（`check:ci`），依次执行构建、类型检查、测试、Biome 检查与 OpenSpec strict 校验。CI 流水线 SHALL 直接调用该脚本或它的同名子命令，SHALL NOT 在流水线中另写一套未被根脚本覆盖的校验逻辑。对同一条命令，CI 与本地 SHALL 复用同一表达式而非各写一份。

#### Scenario: 本地复现 CI

- **WHEN** 开发者在全新克隆的仓库执行 `pnpm install` 后运行根 `check:ci` 脚本
- **THEN** 该命令执行与 CI 完全相同的校验集合，且无需任何密钥或额外环境变量

#### Scenario: CI 与本地口径一致

- **WHEN** 根 `check:ci` 在某次提交上失败
- **THEN** 同一提交在 CI 上同样失败，不出现一方绿一方红

### Requirement: 测试以包目录为工作目录执行

测试校验 SHALL 让每个 workspace 包的测试运行器以其包目录作为工作目录（例如通过在每个包内执行该包自身的 `test` 脚本）。系统 SHALL NOT 使用「根运行器 + `--root <包路径>`」形式执行测试。

> 该约束来自 2026-09-10 本仓实测：`--root` 会让同一模块被解析成两份实例，`instanceof` 断言因此假阳性（`trace-test` 实测报 2 个 `instanceof TraceTestConfigError` 失败）。请勿顺手改回。

#### Scenario: 跨包类身份断言

- **WHEN** 某包测试对自定义错误类做 `instanceof` 断言
- **THEN** 断言在 CI 中与在本机一致地通过，不因模块重复解析而失败

### Requirement: 构建范围限于被测试或跨包消费的包

CI SHALL 在测试前构建 workspace 包中**被测试或跨包消费的**构建产物。构建 SHALL NOT 执行前端打包链（`electron-vite`），SHALL NOT 产出可分发产物。对仅有类型检查需求、且不作为任何包依赖的工程（如桌面应用），SHALL 以无副作用的类型检查（`tsc --noEmit`）代替构建。

#### Scenario: 不触发前端打包

- **WHEN** CI 执行构建环节
- **THEN** 只对库包执行各自的 `tsc -p tsconfig.json`，不执行 `electron-vite build`，不产生打包产物

#### Scenario: 跨包消费者拿到最新产物

- **WHEN** 某库包 `src` 被修改且 CI 校验通过
- **THEN** 依赖该包的其它包在测试与运行中解析到的是本次构建的 `dist/`，而非陈旧产物

### Requirement: 跨包 CLI 冒烟不得静默跳过

对于以构建产物存在为前置条件的测试（如直接 spawn `dist/*.js` 的 CLI 冒烟），CI SHALL 保证这些用例被执行而非跳过；同一提交的测试总数 SHALL NOT 因产物缺失而静默缩减。

> 实测依据（2026-09-10）：`packages/replay/test/model-ab-cli.test.ts` 以 `existsSync(dist/model-ab-cli.js)` 为守卫。`dist/` 存在时执行 4 个用例（replay 合计 66）；`dist/` 缺失时静默跳过（replay 降到 62），而 CI 依然全绿。

#### Scenario: 产物缺失导致静默缩水

- **WHEN** 测试在构建产物缺失的状态下运行
- **THEN** 依赖产物的用例会跳过，CI SHALL 通过"构建先于测试"的顺序避免这种状态，不得让缩减后的通过被当作成功

#### Scenario: 构建先于测试使冒烟生效

- **WHEN** CI 按既定顺序先构建再测试
- **THEN** 依赖 `dist/` 的 CLI 冒烟用例实际执行，其数量体现在测试总数中

### Requirement: 校验在零密钥下完成

CI SHALL NOT 注入任何模型 API 密钥或等价凭据，环境变量中 SHALL NOT 出现用于真实模型调用的密钥。测试矩阵 SHALL 保持零网络模型调用、零真实 API 消耗。

#### Scenario: 无密钥运行

- **WHEN** CI 在某次 push 上运行完整校验
- **THEN** 全流程在没有任何 API 密钥的环境变量下完成，且不发起真实模型请求

### Requirement: OpenSpec 校验固定版本

规范校验 SHALL 通过固定版本的 OpenSpec CLI 执行（`validate --all --strict`），版本号 SHALL 显式钉在命令中而非使用浮动的 `latest`。

#### Scenario: 工具版本漂移不误报

- **WHEN** 上游发布新的 OpenSpec 版本
- **THEN** CI 仍使用钉住的版本，不因上游变更而使未改动的提交突然失败

### Requirement: 运行环境与平台风险显式登记

CI 首期运行环境 SHALL 基于对既有用例的核查结论选定并记录依据；已知的平台相关或环境相关风险（如依赖硬编码端口的断言）SHALL 在规范或文档中登记。当出现平台相关失败时，SHALL 逐条判定为「使测试平台无关」或「扩展运行矩阵」，SHALL NOT 通过跳过或删除失败用例来消除红灯。

#### Scenario: 平台失败不被静默掩盖

- **WHEN** 某项校验在首期运行环境上因平台差异失败
- **THEN** 该失败被记录并给出处置判定（改测试或扩矩阵），而不是被跳过、标记忽略或删除

### Requirement: 触发条件与失败可见性

CI SHALL 在 push 到 `main` 与 pull request 上触发。任一校验环节失败 SHALL 使整体状态为失败，SHALL NOT 使用任何「忽略错误」机制掩盖失败，SHALL NOT 出现「前序环节失败而整体被判绿」的假绿（如平台逐条命令不短路时，SHALL 以链式 `&&` 执行或等价 fail-fast 语义保证失败传播）。各校验环节 SHALL 日志可单独定位（分步、逐条命令或经根脚本串联输出分节均可），使失败一眼可归因到「构建 / 类型 / 测试 / 风格 / 规范」中的哪一道。

#### Scenario: 测试失败即红

- **WHEN** 某包的一个测试用例失败
- **THEN** 该环节失败并输出包名与失败用例，流水线整体状态为失败

### Requirement: 不覆盖发布与 GUI 验证

CI SHALL NOT 执行 Electron 打包、Release 发布或 GUI/运行时冒烟。需要打包产物的检查（如渲染资源规范审计）SHALL 保留在本地发布校验流程中，CI SHALL NOT 因未覆盖它们而宣称打包产物正确。

#### Scenario: CI 不产出安装包

- **WHEN** CI 在 main 上成功运行
- **THEN** 不产生 portable exe 或 Release 资产，发布仍由人工在本地执行

### Requirement: 既有能力不回归

引入 CI SHALL NOT 修改任何 workspace 包的 `src`、`test` 或依赖声明，也 SHALL NOT 改变既有测试数量与语义。既有的本地校验命令 SHALL 保持可用。

#### Scenario: 引入 CI 后本地测试不变

- **WHEN** CI 落地后在本机执行既有的分步校验命令
- **THEN** 结果与引入前一致，测试数量与通过状态不变
