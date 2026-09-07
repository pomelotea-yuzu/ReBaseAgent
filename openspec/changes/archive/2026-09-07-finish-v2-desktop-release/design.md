## Context

动机见 `proposal.md`。当前发行基线为 `release/ReBaseAgent-0.1.0-win-x64-portable.exe`，大小 113,095,437 bytes；目标不是模糊的“约 100 MB”，而是严格小于 Gitee 单附件阈值 100,000,000 bytes。

现有 `apps/desktop/dist` 共 106 个文件、28,407,557 bytes，其中 renderer 资源占 28,368,264 bytes，Monaco worker 占 17,389,494 bytes；仅 `ts.worker` 就有 13,307,936 bytes。根因是 `src/renderer/src/main.tsx` 的 `import * as monaco from "monaco-editor"` 导入完整入口，连带 TypeScript、CSS、HTML worker 和大量基础语言。Electron 44.1.1 自带 55 个 locale，共 50,644,017 未压缩 bytes；electron-builder 26.15.3 已原生支持 `electronLanguages` 白名单。

当前构建已经使用 `asar: true`、`compression: maximum`、纯 JS 依赖且 `npmRebuild: false`。这些设置不是主要浪费来源，不需要重做打包体系。

portable 数据路径另有一处必须随发行收口修正的既有缺口：`extraFiles` 中的 `portable.marker` 会进入被 portable wrapper 解压的内部应用目录，外层发布目录实际只有单个 exe；但 `resolveDataDir` 在存在 `PORTABLE_EXECUTABLE_DIR` 时改到外层目录找 marker，因此全新目录会错误进入“选择数据目录”。同时 main 当前在 `await app.whenReady()` 后才解析数据目录，且没有重定向 Electron 默认 `userData` / `sessionData`。单文件 wrapper 在启动内部应用前已经注入 `PORTABLE_EXECUTABLE_DIR`，它本身才是可在 ready 前使用的可靠 portable 身份。

## Goals / Non-Goals

**Goals:**

- 通过有依据的资源收窄让 portable 严格小于 100,000,000 bytes，并把阈值变成自动门禁。
- 保留 Monaco 的 JSON/纯文本编辑、JSON worker 诊断和完全离线加载。
- 让品牌图标在构建产物、窗口与任务栏一致，并可在常见 Windows 尺寸辨识。
- 对真正发布的 packaged 应用做冷启动和关键路径冒烟，覆盖 dev 模式无法发现的资源遗漏。
- 用独立 v0.2.0 产物完成 v2 收口，避免覆盖 v0.1.0 回滚文件。

**Non-Goals:**

- 不通过升级/降级 Electron、修改压缩器或删除不明确的 Chromium 二进制来赌体积。
- 不重构编辑器组件、预算图或代理业务逻辑；只调整资源入口与发行配置。
- 不建立通用的多平台资源流水线；本设计只覆盖 Windows x64 portable。

## Decisions

### D1 使用 Monaco ESM 显式入口，只装配 editor 与 JSON worker

新增单独的 Monaco bootstrap 模块，替代 `main.tsx` 对包根入口的全量导入：

- 从 `monaco-editor/esm/vs/editor/editor.api` 引入 editor API；显式导入 `monaco-editor/esm/vs/language/json/monaco.contribution`。`plaintext` 是 editor API 内建语言 id，不导入 `basic-languages/monaco.contribution` 聚合入口。
- 用 Vite `?worker` 入口分别引入 `monaco-editor/esm/vs/editor/editor.worker` 与 `monaco-editor/esm/vs/language/json/json.worker`，通过 `globalThis.MonacoEnvironment.getWorker` 按 `json` label 选择 JSON worker，其余 label 回退到 editor worker。
- 继续调用 `@monaco-editor/react` 的 `loader.config({ monaco })`，确保 loader 使用本地实例，禁止 CDN。
- 静态审计 renderer 源码不得再从 `monaco-editor` 包根或 `basic-languages/monaco.contribution` 导入；构建后审计 assets 必须存在 editor/json worker，且不得出现 `ts.worker-*`、`css.worker-*`、`html.worker-*`。其余体积回归由 renderer 总字节数报告和最终 portable 硬阈值发现，不建立含糊的“已知语言文件名”规则。

选择显式 ESM 入口，是因为它由 bundler 做静态可达性裁剪，行为比构建后按文件名删除可靠。备选方案“保留完整入口再从 dist 删除”被否决：hash 文件名不稳定，入口清单仍可能引用被删 chunk。备选方案“改回 textarea”违反现有产品能力。引入额外 Monaco Vite 插件也没有必要，会新增依赖和另一套资源规则。

### D2 使用 electron-builder 原生 locale 白名单，不手工删 Electron 运行时文件

在构建配置设置 `electronLanguages: [zh-CN, en-US]`。简体中文是产品一等语言，`en-US` 作为 Chromium 和 Monaco 的稳定回退。该选项在打包 Electron framework 时处理 locale，优于 `afterPack` 脚本按路径删除。

不会删除 `swiftshader`、Vulkan/D3D DLL、`resources.pak`、ICU、snapshot 或 Chromium license 文件。它们的运行条件跨显卡、远程桌面和沙箱环境变化，当前没有足够证据证明可移除；靠 Monaco 与 locale 两个已知大项达到阈值，失败时先重新测量，再修订 proposal，而不是扩大删除范围。

### D3 `PORTABLE_EXECUTABLE_DIR` 是单文件 portable 的身份与数据锚点

在 main 模块最早期、`app.whenReady()` 和任何 session/BrowserWindow 创建前解析 portable 身份：优先检查 `PORTABLE_EXECUTABLE_DIR`；若不存在但当前是 packaged 应用，则检查 `app.getPath("exe")` 旁的 `portable.marker`。

- 环境变量存在时，无需再检查外层 `portable.marker`，直接把数据目录解析为 `<PORTABLE_EXECUTABLE_DIR>/data`；没有环境变量但实际 exe 旁存在 marker 时，解析为该 exe 目录下的 `data/`。
- 先确保该目录存在，再用 `app.setPath` 把 `userData`、`sessionData` 以及其他默认落入 AppData 的产品运行路径锚定到该目录下的明确子目录，然后进入既有 bootstrap。
- `resolveDataDir` 增加“portable 环境存在即 resolved”的纯函数场景；marker 和 `data-dir.json` 继续服务于没有 portable 环境变量的 unpacked/普通 packaged 路径。
- `extraFiles/portable.marker` 保留给直接运行 `win-unpacked` 的场景，但不再被误认为外层单文件识别机制。

备选方案“把 marker 复制到外层目录”被否决：单文件发行应只有 exe，且 portable wrapper 已提供稳定身份。备选方案“ready 后观察是否写 AppData 再决定”也被否决：默认 session 可能已在观察前初始化，无法证明没有早期泄漏。

### D4 品牌图标采用单一高对比“分叉轨迹”标记并保留源文件

图标以 ReBaseAgent 的核心概念为图形：一条轨迹在分叉后形成简化的字母 R 轮廓。视觉使用中性深色底、蓝色主轨迹和翠绿色分支点，与现有调试台的中性底及蓝/绿语义色一致；不放产品全名或其他在 16x16 无法读取的细字。

仓库保存至少 512x512、建议 1024x1024 的无损 PNG 源图。既有 electron-builder 会通过其 `getOrConvertIcon("ico")` 链把 PNG 转成 Windows 多尺寸图标并写入 exe，无需新增 npm 图标依赖或手写 ICO 容器；同一 PNG 随包提供给 BrowserWindow，使开发态、窗口和任务栏行为一致。发行验收检查源图尺寸与 alpha，并检查 builder 生成的 Windows 图标资源包含常见尺寸；16x16 与高 DPI 的最终辨识度仍由 Windows 人工截图确认。

备选方案“只配置 exe 图标”被否决：它不能稳定覆盖开发态窗口，也难以在冒烟中确认应用实际使用同一品牌资源。

### D5 发行验收拆成确定性检查与强制离线的 packaged GUI 冒烟

新增 Node 发行检查脚本，输入最终 artifact 路径并执行：

1. 文件存在，且名称严格为 `ReBaseAgent-0.2.0-win-x64-portable.exe`；读取的应用版本同为 0.2.0，旧 v0.1.0 文件不作为候选输入。
2. 读取文件系统精确字节数，要求 `< 100_000_000`；失败输出实际值、阈值、差值并返回非零。
3. 执行 D1 的确定性静态/产物审计：拒绝包根与聚合语言入口、拒绝三类明确 worker，并确认 editor/json worker 存在；同时报告 renderer JS/worker 总字节数供回归比较。
4. 输出结构化摘要，供 README 和 release 文案人工引用；脚本不直接改文档，避免构建副作用。

随后启动最终 portable（不是 `electron-vite dev`），复用现有 Playwright CDP 思路进行冷启动冒烟。测试将浏览器上下文置为 offline，并拦截/记录全部 HTTP(S) 请求：除 localhost 代理控制链路外，任何请求尝试都直接失败测试。在该条件下加载 fixture、打开 JSON 与纯文本编辑器、展开预算地图、切换分支树、启停代理并检查页面/控制台错误。测试使用外层只有 exe 的临时发布目录，断言不弹目录选择、数据落在同级 `data/`、隔离 AppData 中无产品目录；进程按 PID 关闭。

图标的资源写入由构建配置和发行文件检查自动保证，资源管理器/任务栏呈现另做一次 Windows 人工验收，因为 Windows 图标缓存会让像素级自动断言不稳定。

### D6 v0.2.0 版本身份先于打包，README 只在最终产物通过后更新

在任何新 portable 打包前，把根 `package.json` 与 `apps/desktop/package.json` 同步为 `0.2.0`；内部 workspace library 未单独发布，保持 `0.1.0`。artifactName 继续使用 `${version}`，因此自然生成与 v0.1.0 不同名的文件。发行检查拒绝其他版本名，旧产物不移动、不删除、不覆盖。

README 的版本徽章和能力标题更新为 v0.2.0，体积使用发行检查输出的实际字节数换算并标明 `<100 MB`，路线图将 v2 标为完成，当前限制移除默认图标项。历史 devlog 保留当时的 108 MB 记录，不回写历史事实；HANDOFF 只同步当前状态。真实成本对照不阻塞本 change，但没有实测证据时不得新增确定百分比。

### D7 按运行时可达性排除 asar 内的 renderer 专属死重依赖

实测 v0.2.0（Monaco 收窄 + locale 白名单）portable 为 104,018,580 bytes，仍超出阈值约 4 MB。包内分解显示根因不在渲染产物，而在 `app.asar`（175.8 MB 未压缩）里的 `node_modules` 整包：

| 顶层项 | 未压缩 bytes | 判定 |
| --- | --- | --- |
| `node_modules/monaco-editor` | 92.6 MB | renderer 专属，已打进 dist/renderer |
| `node_modules/echarts` | 55.6 MB | renderer 专属（懒加载 chunk 已进 dist） |
| `node_modules/react-dom` | 7.0 MB | renderer 专属 |
| `node_modules/zrender` | 4.0 MB | echarts 的 renderer 专属依赖 |
| `node_modules/zod` | 3.2 MB | **main 运行时 require，保留** |
| `node_modules/@rebaseagent/*` | 0.3 MB | **main 运行时 require，保留** |
| `node_modules/eventsource-parser` | 0.1 MB | llm-proxy 运行时依赖，保留 |
| 其余（react/marked/dompurify/@monaco-editor/scheduler/zustand/tslib/state-local/@types） | ~1.7 MB | 全部 renderer 专属 |
| `dist/renderer` | 11.0 MB | 渲染产物，保留 |
| `dist/main` + `dist/preload` + `package.json` | ~0.04 MB | 保留 |

判定依据是扫描 `dist/main/index.cjs` 与 `dist/preload/index.cjs` 的运行时外部 `require()`：只有 `zod`、`@rebaseagent/{agent-loop,llm-proxy,replay,trace-sdk}`（含 `trace-sdk/schema`）、`eventsource-parser`。react / monaco / echarts 等只被 renderer 源码引用，而 renderer 由 Vite 静态可达性裁剪后整体打进 `dist/renderer`，运行时不再访问 `node_modules` 下的原包。

因此用 electron-builder `files` 否定模式按包排除上述 renderer 专属依赖，预计 asar 从 ~176 MB 降到 ~23 MB，portable 显著低于阈值。这是对构建产物的确定性过滤（有运行时 require 扫描与最终资源审计双重验证），不是盲删 Chromium 运行时组件，也不改变 D2「不手工删 Electron DLL/pak/snapshot/license」的边界。若排除后仍有运行时缺失，由 packaged 冒烟暴露；若仍超限，只重新测量并修订，不放宽阈值。

## Risks / Trade-offs

- **[Monaco 深层 ESM 入口随版本变化]** -> 版本已由 lockfile 固定；typecheck、构建资源审计和 packaged 编辑器冒烟共同门控，未来升级 Monaco 时显式重新验证。
- **[JSON contribution 仍间接带入额外资源]** -> 以构建后的实际 assets 和最终 exe 测量为准；若仍超限，只分析可达图并修订设计，不按文件名盲删。
- **[仅保留两个 locale 导致系统语言回退异常]** -> 在中文系统和强制英文 locale 各冷启动一次；保留 `en-US` 作为通用回退。
- **[Windows 图标缓存显示旧图标]** -> 自动检查配置/资源，人工验收使用新文件名或清洁目录，避免把缓存误判为构建失败。
- **[pre-ready 路径初始化过早创建目录]** -> 只在 electron-builder 明确注入 `PORTABLE_EXECUTABLE_DIR`，或 packaged 实际 exe 旁明确存在 marker 时执行；普通 packaged 的指针/选择流程保持 ready 后处理，并分别测试。
- **[portable 冒烟在临时目录产生数据]** -> 使用明确的测试目录和隔离 AppData，并只按记录的 PID 收尾；验收结束保留目录清单作为证据。
- **[错误版本覆盖旧产物]** -> 打包前先同步 v0.2.0，发行检查按精确文件名与应用版本双重校验；不对 v0.1.0 文件执行移动或删除。
- **[目标仍超过 100,000,000 bytes]** -> 门禁保持失败，输出各层体积用于下一轮决策；不放宽为 100 MiB，也不删除未经验证的 Electron 运行时组件。

## Migration Plan

无数据迁移。先把发行身份提升到 v0.2.0，修正并测试 pre-ready portable 路径，再完成 Monaco 资源收窄、locale 白名单和图标；最后生成全新 portable 产物执行确定性检查与强制离线 GUI 冒烟。旧 v0.1.0 产物原地保留为回滚下载；v0.2.0 未通过全部门禁前不替换发布入口。回滚代码只需恢复发行代码与 builder 资源配置，不触碰任何 trace 或用户数据。
