## 1. v0.2.0 发行身份与门禁底座

- [x] 1.1 在任何新打包前，把根 `package.json` 与 `apps/desktop/package.json` 版本同步为 `0.2.0`，按包管理器需要更新 lockfile，但保持四个 workspace library 为 `0.1.0`；验证 builder 解析出的目标名严格为 `ReBaseAgent-0.2.0-win-x64-portable.exe`，且现有 v0.1.0 文件未被移动、删除或覆盖。
- [x] 1.2 在 `apps/desktop/scripts/` 增加可复用的发行检查模块与 `release:verify` CLI：接收 artifact 路径、读取精确字节数、以 `< 100_000_000` 为唯一通过条件，失败输出实际值/阈值/超出量并返回非零；把尺寸判定抽成纯函数，用 `99_999_999`、`100_000_000`、`100_000_001` 三个数字测试通过/边界/失败，不创建百兆测试文件。
- [x] 1.3 为 `release:verify` 增加确定性资源审计：静态拒绝 renderer 源码从 `monaco-editor` 包根或 `basic-languages/monaco.contribution` 导入；产物要求 editor/json worker 存在并拒绝 `ts.worker-*`、`css.worker-*`、`html.worker-*`；同时报告 renderer JS 与 worker 总字节数。用合成目录测试每条缺失/禁用规则，验证错误包含具体路径。
- [x] 1.4 将 `release:verify` 接入 `apps/desktop/package.json`，同时校验输入文件名和应用版本均为 v0.2.0、拒绝把 v0.1.0 当作本次结果；执行 desktop Vitest 以及 `release:verify --help`、无参数、错误版本三条 CLI 路径，验证命令可发现且不会误报成功。

## 2. Monaco 按需打包

- [x] 2.1 新增 renderer Monaco bootstrap 模块：从 `monaco-editor/esm/vs/editor/editor.api` 引入核心，显式导入 `monaco-editor/esm/vs/language/json/monaco.contribution`，不导入基础语言聚合入口；使用 Vite `?worker` 装配 `vs/editor/editor.worker` 与 `vs/language/json/json.worker`，让 `json` label 使用 JSON worker、其余回退 editor worker，并让 `@monaco-editor/react` loader 指向本地实例。验证 renderer typecheck 与现有编辑器测试通过。
- [x] 2.2 删除 `main.tsx` 对 `monaco-editor` 包根的全量导入，执行 `electron-vite build` 和 `release:verify` 的资源审计，记录优化前后 renderer JS/worker 总字节数；验证产物只保留 editor/json worker，不再包含 TypeScript/CSS/HTML worker。
- [x] 2.3 在阻断全部非 localhost 请求的 dev GUI 冒烟中分别打开合法 JSON 与普通文本的 tool_result/messages 编辑器，验证 JSON 高亮/诊断、内建 `plaintext` 编辑、提交前状态和零 CDN 请求；同时展开预算地图，确认 Monaco 收窄未影响 ECharts。（冒烟脚本 `.workbuddy/smoke-monaco-slim/smoke-slim.mjs`；messages JSON 编辑器仅对 proxy run 开放，其 JSON 语言 + json.worker 路径由 JSON 工具结果编辑器同路径覆盖验证）

## 3. 单文件 portable 身份与 pre-ready 数据路径

- [x] 3.1 修改数据目录纯函数：打包环境存在 `PORTABLE_EXECUTABLE_DIR` 时直接解析为其同级 `data/`，不要求外层 marker；补“外层只有 exe”“临时解压目录有 marker 但外层没有”“无 portable 环境时 marker/指针行为不变”测试，验证单文件和 unpacked 两条入口不会混淆。
- [x] 3.2 在 main 最早期增加 portable pre-ready 初始化：优先用 `PORTABLE_EXECUTABLE_DIR` 识别单文件 portable，否则在 packaged 模式检查实际 exe 旁 marker；任一信号成立时先创建对应 `data/`，在 `app.whenReady()` 和任何 session/BrowserWindow 前用 `app.setPath` 把 `userData`、`sessionData` 及经核对会默认落入 AppData 的产品运行路径锚定到 `data/` 下明确子目录。把身份/路径派生抽成纯函数并覆盖环境变量、marker、非 portable 三态，不改变普通 packaged 的指针/选择流程。
- [x] 3.3 执行 main typecheck 与数据目录全量测试，并对 `win-unpacked` 做 marker 回归冒烟：无 portable 环境变量但旁边有 marker 时仍直接使用同级 `data/`；验证 `desktop-ui` 既有“数据目录遵循便携策略”契约没有被单文件修复改写。

## 4. Electron locale 与运行时边界

- [x] 4.1 在 `electron-builder.yml` 使用 builder 原生 `electronLanguages` 仅保留 `zh-CN` 与 `en-US`，不添加 `afterPack` 删除脚本、不删除 Chromium DLL/pak/snapshot/license；执行 v0.2.0 unpacked 构建并检查 `locales/` 恰好保留两个目标 locale。
- [x] 4.2 对加入 locale 白名单后的 v0.2.0 portable 打包并记录精确体积，与“仅 Monaco 收窄”的中间结果分开记录；运行 `release:verify`，若仍未严格低于 100,000,000 bytes，先输出包内体积分解并修订 proposal/design，禁止放宽阈值或扩大未经验证的运行时删除范围。（实测 104,018,580 bytes 超限 → asar 分解定位 renderer 专属依赖死重 161 MB → 新增 design D7 按运行时 require 扫描排除 → 终值 93,919,697 bytes，`release:verify` 全绿）
- [x] 4.3 在简体中文环境和通过 Chromium `--lang=en-US` 指定的英文环境各冷启动一次 unpacked 应用，验证窗口、Monaco、预算地图与分支树无 locale 资源错误。（冒烟脚本 `.workbuddy/smoke-monaco-slim/cold-start-locale.mjs`）

## 5. 品牌图标

- [x] 5.1 产出至少 512x512、建议 1024x1024 的透明无损 PNG 源图：使用“分叉轨迹 R”轮廓、深色底、蓝色主轨迹与翠绿分支点，不含细字；用现有图片读取能力验证像素尺寸、正方形和 alpha，不新增 npm 图标生成依赖。（终稿由 AI 图像生成（粗实心 R + 压在竖干上的翠绿分叉节点 + 深色满幅底），经 System.Drawing 缩放到 1024x1024 并做圆角透明化得到 `build/icon.png`；像素解码验证尺寸/RGBA/四角 alpha=0/蓝绿内容；未新增 npm 图标生成依赖）
- [x] 5.2 在 `electron-builder.yml` 配置 `win.icon` 指向 PNG，让既有 electron-builder `getOrConvertIcon("ico")` 链生成 Windows 图标并写入 v0.2.0 exe；把同一 PNG 随包提供给 BrowserWindow，通过开发态/打包态均可解析的路径显式设置图标，并为路径派生补纯函数测试。
- [x] 5.3 执行 unpacked 构建，确认 builder 图标转换成功且 exe 含自定义 Windows 图标资源；在 16x16 列表和高 DPI 视图检查主体不被裁切，验证不需要手写 ICO 打包器或新增开发依赖。（exe 图标经 ExtractAssociatedIcon 提取核验为蓝色 R 非 Electron 默认；16x16/高 DPI 人工验收在 6.4 截图确认）

## 6. 强制离线的 packaged 冒烟

- [x] 6.1 扩展现有 CDP/Playwright 冒烟为 packaged 模式：把 v0.2.0 portable 单独放进没有 marker/指针的临时发布目录，使用隔离 AppData 启动，确认不弹目录选择且直接创建同级 `data/`；记录隔离 AppData 与注册表观察点，验证没有 ReBaseAgent 产品数据落在外部位置，进程只按本次 PID 收尾。
- [x] 6.2 将 packaged 浏览器上下文设为 offline，并拦截记录全部 HTTP(S) 请求；除 localhost 代理链路外，任何请求尝试都立即失败测试。在该条件下加载离线 fixture，分别验证 JSON/纯文本 Monaco、预算地图、分支树和轨迹详情，且 page error、console error、外部请求计数均为零。
- [x] 6.3 在同一次 packaged 冒烟中启停本地代理并确认端口状态可见、无需访问 upstream 即可启动；随后再次打开 Monaco 和预算地图，验证 locale/资源裁剪没有破坏代理、编辑器或可视化的共同运行环境。
- [x] 6.4 使用新文件名或清洁目录人工核对资源管理器、窗口标题栏与任务栏均显示同一 ReBaseAgent 图标；在 16x16 列表和高 DPI 视图各留一张验收截图，避免 Windows 图标缓存造成误判。（用户已在新目录运行验收，三处图标一致；最终品牌图标 = AI 生成粗实心 R + 竖干翠绿分叉节点，蓝色主轨迹、深色满幅底、圆角透明源图）

## 7. 发布收尾

- [x] 7.1 运行 desktop 全量 Vitest、双端 TypeScript、Biome、`electron-vite build`、Windows x64 portable 打包、`release:verify` 与 packaged GUI 冒烟；记录最终 v0.2.0 artifact 路径、SHA-256 和精确字节数，只有全部通过且 `< 100_000_000` 才接受产物，同时确认 v0.1.0 回滚文件仍存在且哈希未变。
- [x] 7.2 用 7.1 的实测结果更新 README 的 v0.2.0 版本徽章、能力标题、下载体积、当前限制和路线图，将 v2 标为完成并移除默认图标限制；同步 HANDOFF 当前状态但不修改历史 devlog 的 108 MB 事实，且不新增未经真实链路验证的“1/4 成本”结论。
- [x] 7.3 逐条核对 `desktop-distribution` 的全部 scenario 与测试/截图/构建日志对应关系，执行 `openspec validate finish-v2-desktop-release --strict`；验证 proposal、spec、design、tasks 与最终实现一致后再进入 archive 流程。

最终产物（图标定稿后重打包）：`release/ReBaseAgent-0.2.0-win-x64-portable.exe` · 94,316,503 bytes · SHA-256 `CD2E1C9482398604BE07ABDA828C0F225C06B09B2C032C1E159B9B20E8096815` · v0.1.0 回滚文件哈希未变（`47B9AEA2…`）。门禁全绿：Vitest 142 / tsc 双端 / Biome 0 / `release:verify` 通过 / packaged 离线冒烟 PASS / `validate --strict` 通过。
