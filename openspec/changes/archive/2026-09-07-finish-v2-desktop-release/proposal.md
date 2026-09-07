## Why

v2 的本地录制代理、分支树、多分支对照与 prompt fork 已全部交付，但当前 Windows portable 包仍为 113,095,437 bytes，超过 Gitee 单附件 100 MB 上限，且沿用 Electron 默认图标。功能已闭环、分发却尚未闭环；现在应先消除下载与产品识别上的最后两处阻力，再进入 v3。

## What Changes

- 将本次 v2 收口发行明确为 `v0.2.0`，生成与 v0.1.0 不同名的 Windows x64 portable 产物并保留旧版本作为回滚下载。
- 建立 Windows x64 portable 的可验证发布预算：最终单文件产物必须小于 100,000,000 bytes，并在构建输出中记录精确字节数。
- 收窄 Monaco 的打包面，只保留产品实际使用的 JSON 与纯文本编辑能力及必要 worker；清除 TypeScript、CSS、HTML 和其余未使用语言资源。
- 按运行时可达性把 asar 内 renderer 专属依赖整包排除（monaco-editor / echarts / react / react-dom 等只被 Vite 打进 dist/renderer，main/preload 运行时不 require），消除 asar 内的死重（实测占未压缩 161 MB）。
- 裁剪 Windows 发行包中未使用的 Electron locale，仅保留简体中文与英文回退；任何运行时组件的移除都必须经过冷启动、Monaco、ECharts 和代理链路冒烟验证。
- 增加 ReBaseAgent 品牌图标，使 portable exe、资源管理器、窗口与任务栏不再显示 Electron 默认图标，并覆盖 Windows 常用缩放尺寸。
- 修正单文件 portable 身份传递：外层目录只有 exe、没有外置 `portable.marker` 时，应用仍须依靠 electron-builder 注入的 portable 环境识别自身，并在 Electron ready 前把运行数据路径锚定到 exe 同级 `data/`；`portable.marker` 继续服务于直接运行 unpacked 应用的场景。
- 增加可重复执行的发布验收：校验产物身份、尺寸达标和关键资源未误删，并在阻断全部非 localhost 网络访问的条件下对打包应用执行 GUI 冒烟，而非只验证 dev 模式。
- 同步 README 中的下载体积、当前限制与 v2 状态；所有体积和成本数字只允许引用本次实际测量结果，未完成真实链路实测前不把“约 1/4 成本”写成确定结论。

## Capabilities

### New Capabilities

- `desktop-distribution`: Windows x64 portable 发行物的版本身份、体积预算、品牌标识、离线资源、既有便携数据契约激活与发布验收。

### Modified Capabilities

（无。Monaco、预算地图、代理、replay 和 prompt fork 的既有用户行为不变。）

## Non-goals

- 不新增 v2 功能：不做任意中间消息编辑、span 级 diff、树折叠、模型 A/B 或预算地图“手术预览”。
- 不改变 tool_result replay、prompt fork 或 proxy fork 的执行与保真度语义；不增加真实 LLM 或工具调用路径。
- 不交付 NSIS 安装包，不新增 macOS、Linux 或 Windows arm64 产物；本 change 只收口现有 Windows x64 portable。
- 不以更换 Electron 主版本作为瘦身手段，也不删除 Chromium sandbox、safeStorage、网络栈、GPU/软件渲染回退等基础能力。
- 不移除 Monaco、ECharts 或将编辑器降级为 textarea；JSON 高亮/校验、纯文本编辑和预算地图必须保留。
- 不新增运行时依赖或远程 CDN；图标和编辑器资源必须随包提供，离线可用。
- 不统一提升未对外发布的 workspace library 包版本；本 change 只提升根项目与 desktop 发行包到 `0.2.0`。
- 不把 100 MB 解释为 100 MiB；验收阈值严格使用 100,000,000 bytes，不通过时不得宣称可上传 Gitee。
- 不在无可复现真实链路数据时对外发布“节省 1/4 成本”等确定数字；成本实测可作为后续独立内容任务。

## Impact

- `apps/desktop/electron.vite.config.ts` 与 Monaco 启动配置：改为编辑器核心、JSON/纯文本语言贡献和必要 worker 的显式入口，阻止未使用语言进入 renderer 产物。
- `apps/desktop/electron-builder.yml`：接入品牌图标、locale 白名单与发行资源过滤（含 asar 内 renderer 专属依赖按包排除），保持 portable、asar、maximum compression 和 `portable.marker` 语义。
- 根 `package.json` 与 `apps/desktop/package.json`：发行版本同步为 `0.2.0`；其余 workspace library 保持既有版本。
- `apps/desktop/src/main/data-dir.ts` 与 `src/main/index.ts`：让 `PORTABLE_EXECUTABLE_DIR` 成为单文件 portable 的可靠身份，并在 app ready 前锚定 Electron 运行数据路径；不改变普通 unpacked/显式目录选择行为。
- `apps/desktop/build/`：新增高分辨率源图；Windows 图标由既有 electron-builder 转换链生成，不引入图标生成依赖。
- `apps/desktop/scripts/`：新增或扩展发布验收脚本，输出精确字节数并检查构建资源；打包后 GUI 冒烟复用现有 CDP/Playwright 管线。
- `README.md`：以 v0.2.0 新产物实测结果更新版本徽章、下载体积、默认图标限制和 v2 路线图。
- 不修改 trace 格式、IPC、JSONL 数据、agent-loop 或 replay 包；无数据迁移、无 API 破坏性变更、无新增运行时依赖。
