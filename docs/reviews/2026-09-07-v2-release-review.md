# ReBaseAgent v2 发行收口评审记录

> 日期：2026-09-07
>
> 范围：`finish-v2-desktop-release` OpenSpec change 的评审、修订与校验。
>
> 说明：本文记录规划讨论，不代表本 change 已进入 apply 或完成发布。

## 一、背景

v2 的主要能力已经落地：本地 LLM 录制代理、分支树、多分支对照和 prompt fork 均已完成。下一步不再扩展新的时间旅行语义，而是完成 Windows x64 portable 的发行收口：

- 当前 v0.1.0 portable 基线为 `113,095,437 bytes`。
- Gitee 单附件目标按严格的 `100,000,000 bytes` 判断，不按 100 MiB 解释。
- 当前还存在默认 Electron 图标、Monaco 资源过大、Electron locale 未裁剪和 packaged 离线/便携边界未充分验收等问题。

因此创建 `finish-v2-desktop-release`，范围限定为发行工程和验收，不重新打开 replay、prompt fork 或分支树的产品语义。

## 二、首轮评审结论

外部评审首先提出四点：

1. spec 只写了最终文件大小，没有显式规定 renderer 构建产物内容审计。
2. Task 5.2 的 portable 数据边界策略偏被动，应该在 Electron ready 前主动设置 `userData`。
3. Task 4.1 的“无新依赖”表述可能混淆运行时依赖与开发时依赖。
4. Monaco 设计应明确导入 JSON language contribution，避免 JSON 高亮失效。

逐项核对后，前两轮修订作出以下判断：

- 内容审计属于可验证的发行验收契约，因此最终补入独立 spec Requirement；但具体 hash 文件名、静态 import 路径等仍保留在 design/tasks，不把实现细节扩散到行为 spec。
- portable 数据问题是实质性问题，不能等冒烟发现 AppData 泄漏后再补救。
- 图标不需要手写 ICO 生成器。现有 electron-builder 能把 PNG 转换成 Windows 图标，因此规划改为仓库保存 PNG 源图，不增加图标生成 npm 依赖；检查脚本只负责验证资源，不负责重复实现 ICO 容器。
- Monaco 规划明确使用 `monaco-editor/esm/vs/editor/editor.api` 和 `monaco-editor/esm/vs/language/json/monaco.contribution`；`plaintext` 使用 editor 内建语言 id，不导入基础语言聚合入口。

## 三、第二轮修订决策

### 1. 明确 v0.2.0 发行身份

首轮规划提到“保留 v0.1.0 回滚产物”，但没有定义新版本，存在继续生成 `ReBaseAgent-0.1.0-win-x64-portable.exe` 的风险。

修订后：

- 根项目和 `apps/desktop` 版本提升为 `0.2.0`。
- workspace library 暂不单独发布，保持 `0.1.0`。
- 新产物固定为 `ReBaseAgent-0.2.0-win-x64-portable.exe`。
- 发行检查同时校验文件名和应用版本。
- v0.1.0 产物不移动、不删除、不覆盖，作为回滚下载保留。

### 2. 修正 portable 数据路径初始化

核对发现，portable 单文件外层通常只有 exe；`extraFiles` 中的 `portable.marker` 会进入内部临时解压目录，不能作为外层单文件的唯一识别依据。当前 main 也在 `app.whenReady()` 后才解析数据目录，且没有主动重定向 Electron 默认 `userData` / `sessionData`。

修订后的统一规则：

- 优先使用 electron-builder 注入的 `PORTABLE_EXECUTABLE_DIR` 识别单文件 portable，数据目录为其同级 `data/`。
- 没有该环境变量时，packaged 应用才检查实际 exe 旁的 `portable.marker`。
- 任一 portable 信号成立时，在 Electron ready、session 和 BrowserWindow 创建前设置运行数据路径。
- 没有 portable 信号的普通 packaged 应用继续走 `data-dir.json` 指针或用户选择流程。

这样既修复单文件首次启动弹目录选择的问题，也保留 `win-unpacked` marker 入口的兼容性。

### 3. 将内容审计写入 spec

`desktop-distribution/spec.md` 新增“发行验收审计编辑器资源集合”Requirement，明确：

- 必须包含 editor worker 和 JSON worker。
- 不得包含 TypeScript、CSS、HTML worker。
- 缺失或混入违规资源时，发行验收必须以非零状态失败。
- 失败信息必须报告具体资源路径，而不是只报告最终体积不合格。

对应场景覆盖：违规 worker 存在、必要 worker 缺失、资源集合符合约束三种状态。

### 4. 强化 packaged 离线冒烟

仅在 dev 模式拦截 CDN 请求不足以证明最终包离线可用。修订后要求 packaged 冒烟：

- 浏览器上下文置为 offline。
- 拦截并记录所有 HTTP(S) 请求。
- 除 localhost 代理控制链路外，任何外部请求都使测试失败。
- 在该条件下验证 JSON/plaintext Monaco、预算地图、分支树、轨迹详情和代理设置。

## 四、最终规划边界

### 目标

- portable 严格小于 `100,000,000 bytes`。
- Monaco 只保留 editor/JSON 所需资源和内建 plaintext 能力。
- Electron 只保留 `zh-CN` 与 `en-US` locale，不删除未经验证的 Chromium 运行时组件。
- 使用统一品牌 PNG 和 electron-builder 转换链替换默认 Electron 图标。
- 发行检查可重复执行，并覆盖版本、体积、资源集合和 packaged GUI。
- README 使用最终 v0.2.0 产物的真实测量结果。

### 明确不做

- 不新增中间消息编辑、span diff、模型 A/B 或预算地图手术预览。
- 不改变 tool_result replay、prompt fork、proxy fork 的执行和保真度语义。
- 不交付 NSIS、macOS、Linux 或 Windows arm64 产物。
- 不升级 Electron 以赌体积，也不删除 Chromium DLL、pak、snapshot、ICU 或 license。
- 没有真实可复现数据时，不把“约四分之一成本”写成确定宣传结论。

## 五、规划文件与验收状态

本次修订涉及：

- `openspec/changes/finish-v2-desktop-release/proposal.md`
- `openspec/changes/finish-v2-desktop-release/specs/desktop-distribution/spec.md`
- `openspec/changes/finish-v2-desktop-release/design.md`
- `openspec/changes/finish-v2-desktop-release/tasks.md`

当前状态：

- OpenSpec `validate --strict`：通过。
- OpenSpec change：`4/4 artifacts complete`。
- 当前仍停留在 planning 阶段。
- 本轮讨论没有进入 apply，也没有因这份讨论文档触发实现、打包或发布。

## 六、后续执行顺序

进入实现时应保持以下顺序：

1. 先完成 v0.2.0 版本身份和发行检查器。
2. 修复 portable pre-ready 数据路径，并补纯函数和冷启动测试。
3. 收窄 Monaco，再单独测量 renderer 资源变化。
4. 加入 Electron locale 白名单并重新打包测量。
5. 接入品牌图标并执行 Windows 图标人工验收。
6. 在强制离线条件下执行 packaged GUI 冒烟。
7. 所有门禁通过后才更新 README、保留 v0.1.0 回滚文件并进入 archive。

