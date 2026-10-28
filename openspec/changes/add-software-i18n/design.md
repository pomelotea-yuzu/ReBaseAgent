# 软件 i18n 设计

状态：待实施。以下默认值、选型与切换规则是本 change 的具体提议，不冒充先前已批准的决定。

## 1. 分类与原文边界

以盘点候选集建立文件/符号级归属表，分为“产品展示 / 原文或模型输入 / 内部诊断 / 生成资产”，记录键或排除理由。3,603 处是候选上界；生成 runner 的四条内嵌脚本排除，用户可见的受控状态仍纳入。renderer lib/ 标签、store 通知和 shared 展示标签必须同组件迁移。英文硬编码产品提示也须双语审查。

一条领域消息可能同时进入 UI 与 tool_result：本地化 UI 投影，保持模型实际输入和记录字节。模型工具声明/描述、消息、工具输出及其错误不随 UI locale 生成。MCP 对外元信息按已定范围单独翻译，不因此修改 Agent 工具定义。

旧及新产生的 trace、验证 detail、stdout/stderr、工件和文件正文均保持既有生成逻辑；读取只翻外围标题、状态码解释与限制，原文标作记录内容。导出正文、补丁和来源清单既有字段不受语言影响。日期保留现有 MM-DD HH:mm:ss 和时区，技术单位 ms/s/k/B/KB、计价/舍入、路径、ID 不改写；只翻外围说明/复数，HTML lang 随语言更新。

## 2. 语言、检测与持久化

| 入口 | 优先级 | 生效 |
|---|---|---|
| 桌面 | 保存的 system / zh-CN / en-US，缺失或损坏按 system | 默认 system，main 解析 Electron 系统语言 |
| MCP / 包层 CLI | --locale > REBASEAGENT_LOCALE > 系统环境 > en-US | 每进程固定；MCP 换语言需重启 |
| 测试 / 库 formatter | 显式 locale 或 translator | 不读宿主环境，无共享当前语言 |

系统语言规范化后 zh 及其区域变体取 zh-CN，其他及检测失败取 en-US，不承诺繁体资源。CLI 系统候选按 LC_ALL > LC_MESSAGES > LANG > Intl 取首个非空值，兼容下划线/编码后缀及 C/POSIX（英文）。显式 --locale 与产品环境变量只接受两个规范值；重复、缺值、不支持时启动失败退出 2。系统未知语言正常回退英文。

桌面独立文件 `ui-preferences.json` 结构为 `{version:1, language:"system"}`。main 严格校验与原子写入；缺失/损坏/未知版本不阻断启动、不自动覆盖，损坏/未知版本给可关闭的本地化提示。无 key 也能保存，清运行配置不删除语言偏好，保存语言不碰 settings.json。换数据根读取该根偏好，不跨目录迁移。

新增 `uiPreferences:get/set` 严格 schema 与 preload 白名单，只接受枚举偏好、不接受物理路径。main 返回保存值/有效语言；业务视图首次挂载前取到偏好，避免语言闪烁。保存成功后一次性切换，失败保留原语言并提示；偏好响应按请求代次隔离。语言控件独立保存，不提交未保存的模型/代理输入。

原生对话框在打开时使用 main 当前语言；已打开的系统模态不强制重建，下次打开取新语言。只翻译应用提供的标题、按钮和说明，OS 自带控件沿用系统语言。

## 3. 运行时和目录

新增 `@rebaseagent/i18n`：纯 TS 的 locale 类型/解析、消息类型、资源、同步实例工厂和 formatter；无 React/Electron/fs/环境变量依赖。静态导入全部资源，同步初始化 i18next，不用 suspense、远程加载或模块级可变当前语言。每个桌面根/CLI/MCP server/测试创建自己的实例，纯函数显式接 translator。React 适配使用 react-i18next Provider，在 Node renderToStaticMarkup 中同步工作。

资源按 common/run/detail/fork/experiment/compare/files/verification/recording/settings/export/errors/mcp/cli 分 namespace；TypeScript 中文目录提供键契约，英文等价。语义命名，不以中文原句或数字索引作键；同形中文不同语义可用不同键。store 保存 code/消息描述与参数，展示时派生；已有展示状态必须可按原事实重算，切换后不遗留旧语言错误。locale 不进入组件 key，不重建编辑器/工作区。

命名参数保留值，使用 React 安全文本节点。复数采用 i18next/Intl，英文 one/other 覆盖 0/1/2/大数，不机械拼中文量词。富文本用受控 Trans 槽位组成可调序完整句子，不固定中英文片段顺序，不注入翻译 HTML；路径/字段/链接目标由代码控制。译文不能改变授权、操作或边界事实。

缺键回退中文同键，再回退当前语言的通用提示并保留 code；不显示裸 key。开发诊断仅记录 locale/namespace/key，不输出插值/密钥。发行目录门禁要求无缺键，回退不计完成。版本及许可证在第 0 批冻结并写 lockfile。

## 4. 产品错误与结构化展示

现有 Envelope.error 为 `{code,message}`，粗粒度端点 code 无法区分所有原因。兼容保留，新增可选 `presentation:{id,params}`，共享 schema 限制内置 id、有界白名单标量/集合，不传 Error、堆栈、任意对象或未经筛选的密钥/宿主路径。领域错误持有 locale 无关的 code/参数，适配层映射描述，不让 agent-loop 依赖当前语言。

renderer 优先翻译已校验描述；旧错误按 namespace/code 映射可得事实，未知/第三方异常用本地化产品摘要、稳定 code 和符合现有隐私规则的原始详情。不能匹配中文 message 猜错误类型或把异常当 key。可行动产品解释必须双语；第三方原始正文不保证翻译。MCP 继续只外发受控错误，不能透传原始异常。

能力/计划 reason、warnings、Zod 提示、比较失败、验证状态采用同样投影。不要为本地化改持久化 schema、计划 hash/token/digest 或授权判据。新记录继续使用既有原文生成逻辑；显示 code 的解释与原文详情分开，不从本地化标签推导通过/取消/零消耗。

## 5. 切换、草稿和确认

语言是展示配置，不轮换模型/代理配置修订，不改草稿 revision、源 token、计划指纹、epoch/operationId 或执行槽。保存成功且有效语言变化时，统一清除尚未提交的费用、副本写入、外部副作用、实验及验证准备/测试确认；当前确认视图保持目标，用新语言重绘，要求重新勾选。仅 system/显式偏好改变但有效语言相同，不额外撤销确认。

保留正文/空白、假设/判据、编辑字段、未保存设置、选择、滚动/编辑器位置及合理焦点。可保留未提交的只读计划事实，提交仍重验现行来源/正文/配置修订；切换不自动再取计划或登记执行。

已提交操作继续，冻结提交快照不受清确认动作影响。保留 loading/unknown/settled、可信子 run/verification ID、定向停止入口及唯一槽。迟到结果按原提交修订关联、用当前语言显示，不清新草稿、不抢导航、不重发。切语言导致模型/工具/准备/测试/导出新增调用数为零。

提交与偏好保存并发，以 renderer 已冻结并交给统一提交适配器的载荷为边界：已冻结按在飞处理，尚未冻结必须重新确认；locale 不进入指纹制造新操作。

## 6. MCP 和 CLI

MCP 工具定义按 server 实例创建；翻译十三工具 description、schema 纯说明、initialize 信任说明、受控启动/业务错误、content 摘要和产品解释。名称、字段、枚举、code、annotations、API version、过滤、只读范围不改。无 set_language 工具，不读桌面偏好/密钥，不发语言热更新。

--locale 不削弱唯一、显式、已有 --data-dir 校验。非法 locale 在协议初始化前以新增受控启动码 INVALID_LOCALE 在 stderr 失败、退出 2，不回显原始参数；原有错误码保持。stdout 始终只有 JSON-RPC 帧。

先本地化再计算完整 UTF-8 序列化预算，两语言覆盖全部十三工具的 64 KiB、content 自足投影、分页/续读、过滤及未知状态。原文范围和游标绑定不改；换语言需新进程，旧游标按已有重启规则过期。

CLI 覆盖 trace-test 和盘点发现的其他现有包层入口（含 replay 模型实验 CLI），包括帮助、参数错误、失败定位、漂移解释、隐私提示和结果摘要。先解析 locale，再加载用户 config/执行；既有授权与 baseline 写入条件不放宽。

trace-test --report json 保留现有 key、值、原始 detail、脱敏和退出码，locale 不改变 JSON 对象。可添加内存描述供人类 formatter 使用，序列化不泄漏翻译内部字段。JSON 模式的 baseline 文本反馈转 stderr，stdout 保持可解析 JSON；其他机器输出同样保持契约。

## 7. 术语

| 语境 | 英文 | 约束 |
|---|---|---|
| 运行/步骤/整轮 | Run / Step / Turn | Step 不代替整轮 |
| 分叉动作/分支对象 | Fork / Branch | 不暗示 Git |
| 回放/重新执行 | Replay / Rerun | 真实调用明确费用和工具副作用 |
| 轮末/初始检查点 | End of turn / Initial checkpoint | 指明隔离文件实际起点 |
| 工具结果/快照 | Tool result / Snapshot | tool_result 与 ID 原值保留 |
| 未知操作核对 | Check operation status | 不用 Retry 暗示再次提交 |
| 未知验证结局 | Unknown | 不补 Passed/Cancelled/零消耗 |

与已完成英文指南复核术语；不机械合并所有重复中文。费用、外发、副本写入、未知价格、unsupported 和零执行边界逐条对照，不为缩短英文删限制。

## 8. 批次和验收

| 批次 | 完整闭环 | 参考规模 |
|---|---|---|
| 0 | 分类、术语、运行时、偏好、错误协议、测试助手/门禁 | 不批量替换业务文案 |
| 1 | 外壳→创建→总览/详情→普通/隔离 result、prompt、messages | renderer 1,142 处及关联包层 |
| 2 | 验证→比较→文件 | renderer 817 处及关联包层 |
| 3 | 模型实验→录制→设置→辅助/导出 | renderer 293 处及关联包层 |
| 4 | 十三 MCP 工具、全部既有包层 CLI、联调 | MCP 163 / trace-test 80 候选 |
| 5 | 全面双语、布局、状态、门禁、指南 | 全部完成才宣称覆盖 |

每个工作区先/同批适配测试，再迁移 UI/共享/包层解释并走完整路径。行为断言优先 code/结构/data-testid；可访问名称仍翻译，不能为了测试固定中文 aria-label。保留独立期望的 zh/en 文案及富文本转义测试，不能全部 expect(t(key)) 自证，不能删除竞态/未知/授权保证。

新增离线 check:i18n 接入 check:ci。检查资源键/参数/复数和归属表；阶段待迁移项带位置/理由，每批递减，收口产品展示待迁移为零。排除项按具体用途审查，不整目录豁免；英文硬编码通过清单审查/双语测试补足，正则不作唯一覆盖判据。

真实 Electron 两语言分别验证 1440/1024/800 CSS px，另做 200% 缩放与键盘全流程；记录实际内容区/zoom/提交/构建/fixture。覆盖长标签、路径、ID、错误、图表、编辑器外围、模态焦点、原生对话框及未授权/已确认未提交/已提交/未知/迟到状态。受控模型/工具桩不产生真实费用，注明哪些是 fixture，不伪称真实模型执行。

实施创建 evidence-index.md，逐场景链接入库测试/可追溯实机证据，未执行如实记录。每任务不超过 2h，超时拆子项而不删保证。全仓 check:ci、单独 desktop build、change strict、diff 检查和双语指南更新后收口；归档不等于发行。
