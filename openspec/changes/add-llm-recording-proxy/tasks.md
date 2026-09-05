# Tasks: add-llm-recording-proxy

## 1. trace-format：source 元数据 + config_hash 可选（向后兼容）

- [x] 1.1 `packages/trace-sdk`：`RunMetaSchema` 增可选 `source`（zod：`{ kind: literal("proxy"), base_url: string }`）；**`config_hash` 放宽为可选**（`.optional()`，存在时仍 `min(1)`）；导出类型；README 字段表同步（含「无 config\_hash 的 run 不可作 replay 父本」说明）
- [x] 1.2 schema 测试 5 例：代理 meta 带 source 且无 config\_hash 解析通过 / 无 source 的老 meta 解析通过 / 既有含 config\_hash 的 meta 不受影响 / config\_hash 空串仍拒绝 / source 缺失不报错
- [x] 1.3 `packages/replay`：分叉校验对无 `config_hash` 的父本明确拒绝（报错文案「该 run 由代理录制，请使用编辑重发」），测试 2 例（代理 run 拒绝 / 既有 run 不受影响）
- [x] 1.4 验收：trace-sdk / replay 全测绿，`format_version` 不变（既有 62+15 例不回归）

## 2. packages/llm-proxy：转发 + 录制核心（纯 TS，零 Electron）

- [x] 2.1 包脚手架（tsconfig / vitest / biome 对齐既有 packages），`package.json` **显式声明 `eventsource-parser: ^3.0.0`**（pnpm 不隐式共享，勿依赖 hoisting）；`createProxyHandler` 骨架：仅 `127.0.0.1` 语义由服务壳保证，handler 只管路由与方法
- [x] 2.2 路径匹配：`POST /v1/chat/completions` 放行；其余路径 404/501 明确错误（scenario「不支持的路径」）
- [x] 2.3 非流式转发：raw body 读取 → 注入 fetchImpl 原样转发 → 响应逐字节回传（scenario「base_url 一行接入」）；录制提取：`messages` / `model` / `tools`（无则空），顶层其余字段（temperature 等，除 `stream`）平铺进 `params`；`usage` 缺失兜底 `{0,0}`；**`ttft_ms` 记 0**（scenario「非流式请求录制」）
- [x] 2.4 流式转发：SSE 逐 chunk 透传 + eventsource-parser 聚合 delta（usage:null 中间块容错，对齐 llm-client）；scenario「流式请求录制」
- [x] 2.5 错误路径：upstream 4xx/5xx → 原样回传 + recorder 记 `stopped/error`（不写 llm.call span）；客户端断连 → 停止聚合、run 自然 crashed
- [x] 2.6 key 捕获：从 Authorization 头更新 keyStore；录制数据与任何日志不含 key（scenario「trace 中无凭据」的包级保证）
- [x] 2.7 分叉构造：`buildForkRequest(sourceSpan, editedMessages)` 纯函数（messages 用编辑值、params/model/tools 用原值）；未修改（深比较）抛明确错误（空 fork 防线，scenario「未修改拒绝重发」）
- [x] 2.8 `startProxyServer`（node:http 薄壳，仅绑 127.0.0.1）：recorder 接口注入；端口占用抛明确错误
- [x] 2.9 验收：llm-proxy 单测全绿（目标 ~15 例，stub fetchImpl 零真实 API）

## 3. desktop main：生命周期、settings、key 暂存、IPC

- [x] 3.1 settings 增 `proxy: { enabled, port, upstreamBaseUrl }`（默认 8787 / deepseek），SettingsStore 测试
- [x] 3.2 代理生命周期管理：app 启动按 settings 启停；`proxy:toggle` 即时启停；错误信封化（scenario「端口被占用」）
- [x] 3.3 recorder 接 RunRepository：每请求一 run（agent.step(n=1) + llm.call + 终止事件），meta 带 `source` + `task="(llm-proxy)"` + **无 config\_hash**（scenario「每个请求录制为一个 run」）
- [x] 3.4 keyStore 模块级单例 + `proxy:status` 只回 `hasKey`（scenario「key 不落盘且仅内存暂存」）
- [x] 3.5 `proxy:fork` 编排：校验源 run（已封存 + 代理来源）→ buildForkRequest → 用暂存 key 发 upstream → 录 fork run（meta 带 parent/fork.edit）→ 回传新 run id；无 key 时明确 error（scenario「重启后暂存失效」）
- [x] 3.6 `src/shared/ipc.ts` 增三通道 zod schema；preload 暴露 `proxyStatus/proxyToggle/proxyFork`（零第三方依赖）
- [x] 3.7 验收：desktop 新增用例全绿（settings / fork 编排 / schema），既有 52 例不回归

## 4. desktop renderer：状态、过滤、编辑重发

- [x] 4.1 SettingsDialog 代理区（开关/端口/upstream）+ 保存反馈与端口占用错误展示（scenario「启用代理」「端口占用可见」）
- [x] 4.2 header 状态点（running 含端口 / stopped / 未捕获 key 小标）（scenario「key 捕获状态」）
- [x] 4.3 RunList 来源徽标 + 过滤（全部/仅代理/仅本地；无 source 归本地直录）（scenario「徽标与过滤」「老文件无来源」）
- [x] 4.4 DetailPanel「编辑重发」：Monaco 懒加载（复用既有 loader），预填 messages JSON、提交解析失败可见报错；未修改禁用；确认处明示「真实调用 upstream 产生费用」+「使用最近捕获的 key」（scenario「编辑并重发成功」「未修改禁用」「中途换 key 后重发」）
- [x] 4.5 forking 状态机复用三态 + 无 key 明确指引（scenario「未捕获 key」）；成功后 loadRuns + 自动选中（scenario 分叉产物）
- [x] 4.6 非 run/非代理 run 不出现该入口；既有 ForkEditor 行为不变（scenario「SDK run 无此入口」）
- [x] 4.7 **父链列表视图**：分支区对 `fork.edit.field="messages"` 的 run 呈现父链列表（逐代 run + 编辑摘要、点击切换），**不改 `resolveBranch`**；replay 分叉呈现不变（scenario「proxy fork 用父链列表查看」「replay 分叉呈现不变」）
- [x] 4.8 验收：store/UI 相关测试绿；biome 0 errors；双端 typecheck 干净

## 5. 收尾

- [x] 5.1 `gen-smoke-proxy-run.cjs` 冒烟脚本：stub upstream（固定 SSE）+ curl 全链路（录 run → 看时间线 → 编辑重发 → 父链列表），零真实 API
- [x] 5.2 全量门禁：trace-sdk / agent-loop / replay / desktop 四包测试全绿 + biome + 双端 typecheck + electron-vite build
- [x] 5.3 `openspec validate add-llm-recording-proxy --strict` 通过；用户 GUI 冒烟确认后归档
