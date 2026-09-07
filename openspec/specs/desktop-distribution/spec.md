## Purpose

定义 ReBaseAgent Windows x64 portable 发行物的版本身份、体积、品牌标识、离线完整性和既有便携契约激活方式，使构建出的单文件可以直接分发、验证并在受支持环境中稳定运行。

## Requirements

### Requirement: v2 收口使用独立的 v0.2.0 发行身份

系统 SHALL 将根项目与 desktop 发行包版本设为 `0.2.0`，并生成名为 `ReBaseAgent-0.2.0-win-x64-portable.exe` 的新产物。构建与验收 SHALL NOT 覆盖或把既有 v0.1.0 产物误报为本次发行结果；未对外发布的 workspace library 版本不受本要求影响。

#### Scenario: 生成 v0.2.0 产物

- **WHEN** 执行本 change 的 Windows x64 portable 发布构建
- **THEN** 输出文件名和应用版本均为 v0.2.0，v0.1.0 产物仍可独立保留用于回滚

### Requirement: portable 产物遵守严格的分发体积预算

系统 SHALL 生成单个 Windows x64 portable 可执行文件，文件大小必须小于 100,000,000 bytes。发布验收 SHALL 输出产物路径与精确字节数；尺寸达到或超过阈值时 SHALL 失败，且该产物不得被标记为满足 Gitee 附件限制。

#### Scenario: 产物低于体积上限

- **WHEN** 发布构建生成 Windows x64 portable 可执行文件并执行发行验收
- **THEN** 验收输出该文件的精确字节数，且仅在数值小于 100,000,000 时通过

#### Scenario: 产物等于或超过体积上限

- **WHEN** portable 可执行文件大小等于或大于 100,000,000 bytes
- **THEN** 发行验收以非零状态失败，并明确报告实际值、阈值与超出字节数

### Requirement: 发行验收审计编辑器资源集合

发布验收 SHALL 审计 renderer 构建产物中的 Monaco worker 集合。产物必须包含 editor worker 与 JSON worker，且不得包含当前产品不使用的 TypeScript、CSS 或 HTML worker。任一必要资源缺失或禁用资源存在时，验收 SHALL 失败并报告全部违规资源路径，不得仅依靠最终文件体积推断内容正确。

#### Scenario: 构建产物包含未使用的编辑器 worker

- **WHEN** renderer 资源中存在 `ts.worker-*`、`css.worker-*` 或 `html.worker-*`
- **THEN** 发行验收以非零状态失败，并逐项报告检测到的违规资源路径

#### Scenario: 构建产物缺少必要的编辑器 worker

- **WHEN** renderer 资源中缺少 editor worker 或 JSON worker
- **THEN** 发行验收以非零状态失败，并明确报告每项缺失的必要资源

#### Scenario: 编辑器资源集合符合发行约束

- **WHEN** renderer 资源包含 editor worker 与 JSON worker，且不含 TypeScript、CSS 或 HTML worker
- **THEN** 内容审计通过并继续执行体积与 packaged GUI 验收

### Requirement: 发行物使用 ReBaseAgent 品牌图标

portable 可执行文件、运行窗口与 Windows 任务栏 SHALL 使用同一套 ReBaseAgent 品牌图标，而非 Electron 默认图标。图标 SHALL 包含适用于 Windows 常见缩放场景的多尺寸图像，并在 16x16 尺寸仍可辨识。

#### Scenario: 查看文件与运行中的应用

- **WHEN** 用户在 Windows 资源管理器查看 portable 文件并启动应用
- **THEN** 文件图标、窗口图标与任务栏图标均显示 ReBaseAgent 品牌标识，不出现 Electron 默认图标

#### Scenario: 小尺寸与高 DPI 显示

- **WHEN** Windows 在 16x16 列表视图或高 DPI 缩放下选择图标尺寸
- **THEN** 系统可从发行图标中取得匹配尺寸，主体轮廓清晰且无被裁切的文字细节

### Requirement: 瘦身不得削弱现有离线功能

发行物 SHALL 将运行所需资源全部打包在本地，不依赖 CDN。裁剪后的应用 SHALL 保留 JSON 与纯文本 Monaco 编辑、JSON 诊断、预算地图、分支树、轨迹详情和本地录制代理；未使用的编辑器语言或 locale 不构成受支持能力。

#### Scenario: 离线编辑 JSON

- **WHEN** Windows 设备断网，用户在打包应用中打开包含合法 JSON 的 tool_result 或 messages 编辑器
- **THEN** Monaco 在无任何非 localhost 请求的情况下加载，提供 JSON 高亮与诊断，并允许正常编辑

#### Scenario: 离线编辑纯文本

- **WHEN** Windows 设备断网，用户打开不可解析为 JSON 的 tool_result 编辑器
- **THEN** Monaco 以纯文本模式加载并允许正常编辑，不发起任何非 localhost 请求，也不尝试加载未随包提供的语言资源

#### Scenario: 核心可视化与代理仍可用

- **WHEN** 用户在打包应用中依次打开预算地图、分支树和代理设置
- **THEN** 三项功能均正常呈现或启动，且控制台和界面不报告资源缺失错误

### Requirement: 单文件发行物激活既有便携数据契约

单文件 portable 发行物 SHALL 在无需外置 `portable.marker` 的情况下向应用提供可靠的 portable 身份，并以此激活 `desktop-ui` 能力中"数据目录遵循便携策略"的既有契约。Electron 自身的产品运行数据路径 SHALL 在 ready 和 session 创建前锚定到 portable 文件同级 `data/`；直接运行 unpacked 应用时仍 SHALL 支持既有 `portable.marker` 入口。

#### Scenario: 从新目录冷启动

- **WHEN** 用户把唯一的 portable exe 放入一个没有 marker、指针或既有 ReBaseAgent 数据的新目录并首次启动
- **THEN** 应用通过发行环境识别 portable 身份，直接激活既有同级 `data/` 契约且不弹出目录选择，不在 AppData 或注册表创建产品数据

#### Scenario: 直接运行 unpacked 应用

- **WHEN** 用户直接运行旁边存在 `portable.marker`、但没有 portable 发行环境变量的 packaged 应用
- **THEN** 应用继续通过 marker 激活 `desktop-ui` 已定义的便携数据契约，行为不因单文件识别修正而改变

### Requirement: 发布说明只陈述本次产物的实测事实

发布文档 SHALL 从最终通过验收的产物取得展示体积，并正确反映 v2 已交付能力与剩余限制。未经可复现真实链路验证的成本节省比例 SHALL 明示为理论值或不出现，不得表述为确定效果。

#### Scenario: 更新 v2 下载说明

- **WHEN** 最终 portable 产物通过发行验收
- **THEN** README 的版本徽章、下载体积与路线图使用 v0.2.0 产物的实际结果，且不再把默认 Electron 图标列为当前限制

#### Scenario: 缺少真实成本实测

- **WHEN** 本 change 未产生可复现的真实模型调用成本对照数据
- **THEN** 发布说明不新增确定的成本节省比例，并保留其理论或待验证性质