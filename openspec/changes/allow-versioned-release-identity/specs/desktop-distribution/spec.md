# desktop-distribution Delta: 发行身份改为可辨认且不冲突的版本标识

## REMOVED Requirements

### Requirement: v2 收口使用独立的 v0.2.0 发行身份

固定的 `v0.2.0` 身份无法支撑 K0–K4 多个打包节点，由下面的新 requirement 取代。

## ADDED Requirements

### Requirement: 发行物使用可辨认且不冲突的版本身份

系统 SHALL 为每次发行确定一个可辨认的版本身份，并据此生成产物名。应用版本（`apps/desktop/package.json` 的 `version`）与产物文件名 SHALL 由**同一来源**推导；二者不一致时，发行验收 SHALL 以非零状态失败，并报告期望值与实际值。

发行准备 SHALL 记录本次的目标版本、预期产物名与包含范围。新产物 SHALL 与既有产物隔离：SHALL NOT 覆盖、移动或删除既有产物，也 SHALL NOT 把既有产物判定为本次发行的结果。体验包与正式发行 SHALL 使用可分辨的身份与输出位置，使同名产物不会被混淆。

未对外发布的 workspace library 版本不受本要求影响。

#### Scenario: 生成带版本身份的产物

- **WHEN** 仅修改应用包版本后执行 Windows x64 portable 发布构建
- **THEN** 产物名按 `ReBaseAgent-<version>-win-x64-portable.exe` 生成、应用版本与该版本一致，且无需改动任何发行校验脚本

#### Scenario: 版本与产物名不一致时验收失败

- **WHEN** 产物文件名或应用版本与发行准备记录的目标版本不一致
- **THEN** 发行验收以非零状态失败，并输出期望值与实际值

#### Scenario: 既有产物不被覆盖

- **WHEN** 新构建产生与既有产物相同的文件名
- **THEN** 新产物输出到与既有产物不同的位置，既有产物的字节数与哈希保持不变

#### Scenario: 既有产物不被误报为本次结果

- **WHEN** 对非本次目标版本的既有产物执行发行验收
- **THEN** 验收失败，SHALL NOT 判定为通过
