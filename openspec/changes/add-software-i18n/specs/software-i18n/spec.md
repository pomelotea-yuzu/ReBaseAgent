## ADDED Requirements

### Requirement: 同步且实例隔离的双语运行时

系统 SHALL 提供纯 TypeScript 的 zh-CN/en-US 翻译资源与同步实例工厂，支持 Node、React 静态渲染和 Electron。资源 SHALL 本地内置，纯 formatter SHALL 显式接收语言或 translator；SHALL NOT 使用共享可变当前语言、浏览器专属 API 或远程加载。

#### Scenario: S01 无 DOM 同步渲染

- **WHEN** Node 测试显式用任一语言 renderToStaticMarkup 或调用纯 formatter
- **THEN** 首次同步调用得到完整对应文案，无异步等待、网络或 DOM 依赖

#### Scenario: S02 并发语言互不污染

- **WHEN** 两个测试、MCP server 或 formatter 实例交错使用不同语言
- **THEN** 每个实例始终使用自己的语言和资源，不受另一实例切换影响

### Requirement: 参数复数富文本和回退完整

翻译 SHALL 使用语义键、命名参数及对应语言的复数规则，富文本 SHALL 支持受控组件调序，参数 SHALL 安全作为文本。缺键 SHALL 依次回退中文同键及本地化通用提示，不泄漏裸 key/插值秘密；完整交付 SHALL 无缺失资源。

#### Scenario: S03 计数和富文本保持原值与语序

- **WHEN** 显示 0/1/2/大数计数、含路径或字段的长句以及带 HTML 特殊字符的参数
- **THEN** 英文单复数正确，中文量词自然，节点顺序可按语言变化，参数不变且不作为 HTML 执行

#### Scenario: S04 缺键降级不冒充完整

- **WHEN** 受控测试模拟英文缺键或两语言均缺键
- **THEN** 分别回退中文或通用提示并保留稳定 code，诊断只含 locale/namespace/key，资源门禁仍判失败

### Requirement: 领域事实与产品解释分离

产品失败 SHALL 使用稳定 code 和经过严格 schema 校验的受控消息描述/有界参数，由展示端翻译。现有 code/message SHALL 兼容；缺描述的旧错误 SHALL 可读。SHALL NOT 以中文正文匹配猜领域原因，也不能透传任意异常作为翻译键。

#### Scenario: S05 精确原因本地化且兼容旧错误

- **WHEN** 同一端点粗 code 对应不同受控原因，或收到无描述的旧错误/未知异常
- **THEN** 前者用描述区分并翻译，后者显示可得事实/通用本地化摘要和稳定 code；原始详情仅依既有隐私规则显示

#### Scenario: S06 非法描述不能扩大输出

- **WHEN** 消息描述携带未知 id、超限参数、对象/堆栈或未授权敏感字段
- **THEN** 按契约拒绝或降级为受控解释，不将参数当 HTML/资源键，不外发新增秘密；MCP 不输出原始异常

### Requirement: 本地化保持记录与执行内容不变

语言 SHALL 只作用于产品展示及明确纳入的 MCP 元信息；SHALL NOT 改写历史或新产生的 trace、验证记录、文件/日志、模型消息、Agent 工具声明/输出和错误字节，也不能改变哈希、计划或导出内容。原文 SHALL 与产品解释可辨。

#### Scenario: S07 切换读取不改记录和模型内容

- **WHEN** 两语言读取同一 run、验证、日志、检查点，或用相同输入产生受控执行
- **THEN** 原始消息/工具声明/工具结果及持久化业务正文生成规则相同，数据指纹、模型请求与计划不因 locale 变化，外围解释对应当前语言

#### Scenario: S08 导出和技术格式不随语言漂移

- **WHEN** 两语言对相同检查点执行既有授权导出并查看时间/数字
- **THEN** 正文、补丁和清单事实一致，现有时间/时区、数值/计价/技术单位不变，仅外围产品说明翻译

### Requirement: 所有既有 CLI 使用确定的语言选择

现有包层 CLI SHALL 支持 --locale zh-CN|en-US，优先于 REBASEAGENT_LOCALE，之后按 LC_ALL/LC_MESSAGES/LANG/Intl 解析系统语言，再回退英文。系统 zh 变体 SHALL 取简体中文，其余取英文；显式值 SHALL 严格校验。人类产品提示 SHALL 双语，机器契约及原始内容 SHALL 保持。

#### Scenario: S09 优先级和系统回退确定

- **WHEN** 参数、产品环境变量和系统语言冲突，或系统语言为 zh_TW.UTF-8、C、未知值
- **THEN** 使用最高优先级有效选择，系统 zh 取 zh-CN，C/未知取 en-US；帮助/错误/结果使用同一语言

#### Scenario: S10 非法显式语言先于执行失败

- **WHEN** --locale 重复/缺值/不支持，或生效的产品环境变量非法
- **THEN** 退出 2 并给受控说明，尚未加载用户执行配置、写 baseline、调用模型/工具或初始化 MCP

#### Scenario: S11 其余包层 CLI 无遗漏

- **WHEN** 运行归属清单列出的 trace-test 之外的已有包层 CLI 帮助、参数失败与受控执行摘要
- **THEN** 两语言产品提示完整，参数名/退出码/机器报告/原始详情和原有执行门禁保持
