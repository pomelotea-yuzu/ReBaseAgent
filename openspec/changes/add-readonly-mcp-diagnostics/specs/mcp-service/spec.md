## ADDED Requirements

### Requirement: 本地 stdio 服务使用显式已有数据根

系统 SHALL 以独立 Node 进程提供 MCP stdio 服务，使用官方 SDK 协商协议，启动要求显式已有可读绝对数据目录及 traces/。SHALL NOT 依赖桌面运行、自动发现数据、创建目录或启动网络服务。stdout SHALL 仅协议，受控日志 SHALL 在 stderr。

#### Scenario: 无桌面也能初始化
- **WHEN** 桌面未运行，客户端以合法数据根启动服务
- **THEN** 完成协议初始化和工具发现，只访问该根；空 traces 返回合法空列表

#### Scenario: 无效数据根启动即失败
- **WHEN** 未配置目录、目录不存在/不可读或无 traces/
- **THEN** 非零退出并给固定启动原因，不建目录、不切换数据根、不在 stdout 输出日志

### Requirement: 首版只发布七个诊断工具

系统 SHALL 提供 list_runs、get_run、get_step、compare_runs、inspect_checkpoint、read_checkpoint_file、compare_checkpoint_files，输入 strict 且具有限额。摘要/索引 SHALL 默认不含完整正文；步骤按 section、文件按显式 path 读取。SHALL NOT 发布执行/导出/删除工具或通过 resources/prompts 旁路取正文。

#### Scenario: 发现工具与按需读取正文
- **WHEN** 客户端列工具，先查运行再查指定 span 的 output 和检查点文件
- **THEN** 恰有七个工具，先摘要后正文，引用可回到真实 run/span/检查点

#### Scenario: 未知字段和执行请求拒绝
- **WHEN** 工具参数带 dataDir/handler/未知字段，或请求重跑/写入工具
- **THEN** 返回参数/未知工具错误，不改变服务范围、不调用执行能力

### Requirement: 返回具有版本来源和受控错误

系统 SHALL 使用 rebaseagent.query.v1 的结构化结果，带 observedAt/readVersion、适用来源/限制，未知保持未知。业务失败 SHALL 使用稳定码和 isError，协议失败沿 MCP 标准，SHALL NOT 外发原始异常/宿主路径。content SHALL 仅给有界说明，不复制全部正文。

#### Scenario: 成功结果和未知来源有引用
- **WHEN** 查询来源不完整运行或指定历史文件
- **THEN** 结果带真实身份、读取时点/版本、适用检查点/hash及缺项，不把未知写成可信事实

#### Scenario: 业务错误不泄露内部载荷
- **WHEN** 请求非法标识、不支持版本或触发存储错误
- **THEN** 返回稳定受控码、定位和重试属性，不输出原始参数、物理路径或堆栈

### Requirement: 分页和续读不能混合来源版本

系统 SHALL 为列表/索引/清单提供有界分页，为正文提供范围续读；游标 SHALL 绑定工具/参数/读取版本并认证。参数不匹配/篡改 SHALL 拒绝，来源变化或进程重启 SHALL 返回 STALE_CURSOR，不沿用旧内容。

#### Scenario: 稳定数据完整分页与正文续读
- **WHEN** 不变数据集超过单页，或正文超过单段
- **THEN** 按固定顺序无重漏分页，正文码点范围可重建完整外发内容；失败项不重复回传全部

#### Scenario: 来源变化与游标篡改拒绝
- **WHEN** 翻页前 trace/附件/候选集合变化，服务重启，或修改游标/参数
- **THEN** 变化/重启给 STALE_CURSOR，篡改/异参给 INVALID_ARGUMENT，不拼接新旧结果

### Requirement: 输出按完整序列化预算限制

系统 SHALL 将完整工具结果 UTF-8 JSON 控制在 64 KiB 内；默认条目 20/最大 100、正文默认 4096/最大 8192 Unicode 码点，并按实际信封预算缩小。SHALL 明示范围/截断/下一位置，不切断代理对、不把片段当完整 JSON 对象，不用片段判文件相同。

#### Scenario: 长转义文本和 Unicode 不突破预算
- **WHEN** 正文包含大量转义字符、中文和代理对，来源信息也很长
- **THEN** 完整序列化结果不超 64 KiB，字符完整、范围准确，剩余内容可继续读取

#### Scenario: 单项超限与两侧不同长度诚实返回
- **WHEN** 元数据单项无法容纳，或文件比较两侧长度不同
- **THEN** 前者给 RESPONSE_LIMIT，后者独立续读；不删身份、不拿另一侧补空、不将片段当全量比较

### Requirement: 公开范围明确且凭据不由元数据泄露

系统 SHALL 白名单投影元数据、过滤已知结构凭据和端点凭据，不读取 SettingsStore/key。历史正文 SHALL 标为不可信记录，配置前 SHALL 说明正文可能含自由文本秘密、客户端外发和费用；SHALL NOT 承诺完全脱敏。文件原文不作通用重写，原文件 hash 与外发片段 SHALL 分清。

#### Scenario: 已知结构凭据过滤并标明
- **WHEN** 已录制结构请求含 Authorization/api-key 或端点凭据
- **THEN** 不外发这些字段，返回过滤标记；原始字节/hash不冒充外发片段校验值

#### Scenario: 历史指令不扩展服务权限
- **WHEN** 历史 prompt/文件要求读取其他目录或调用写入工具
- **THEN** 只按原文事实返回，不改变数据根/工具/过滤规则；指南明确自由文本与客户端外发边界

### Requirement: 断连和查询取消不产生执行行为

系统 SHALL 在 EOF/关闭后释放资源，不后台续发请求；取消仅适用于查询，不发布执行取消。重连 SHALL 新建读取上下文。SHALL 以零写入实现只读，不仅依赖 annotations。

#### Scenario: 断连重连只重新查询
- **WHEN** 大结果读取期间断连后重新启动服务
- **THEN** 旧请求不继续外发或后台执行，新会话重新读盘，旧游标不复用

#### Scenario: 取消查询无运行副作用
- **WHEN** 客户端取消在途查询
- **THEN** 只终止该查询的后续工作，零新运行/operation/模型/工具/导出，既有文件哈希不变

### Requirement: 单一真实客户端与可复现接入验收

系统 SHALL 先验收一个选定的真实 MCP 客户端（本轮为 WorkBuddy 5.9.0，Windows），记录实际客户端/Node/服务/SDK 版本和配置。代表任务 SHALL 使用有明确失败事实的运行、指定比较分支和历史文件，核对桌面一致性。SHALL 由另一位使用者依说明完成接入；未完成须保留未验收，不以模拟协议代替。

#### Scenario: 真实客户端完成带来源代表任务
- **WHEN** 选定客户端查询最近出错终止运行、错误调用、指定分支及两侧文件
- **THEN** 全链完成且引用可回查，事实与桌面一致，无自动修复/测试通过断言，记录版本与限制

#### Scenario: 另一位使用者按说明接入
- **WHEN** 另一位使用者按源码构建/启动/数据范围指南配置
- **THEN** 能初始化并查询指定数据；失败先修支持路径，不扩大客户端数量或声称已发行
