## ADDED Requirements

### Requirement: MCP 启动固定展示语言

MCP SHALL 使用共享 CLI 语言规则，启动参数 --locale 优先于产品环境变量与系统语言；每个 server 独立固定语言，不读取桌面偏好/密钥，不新增切语言工具或语言热更新。已有显式唯一数据根和初始化前校验 SHALL 保持。

#### Scenario: M21 独立语言和十三工具发现

- **WHEN** 不运行桌面，以两个不同显式 locale 分别启动并 initialize/tools:list
- **THEN** 各自恰有十三工具，description/schema 说明/信任声明按语言变化，工具名/参数契约/annotations/只读范围相同，无跨实例污染

#### Scenario: M22 非法语言在初始化前失败

- **WHEN** locale 缺值/重复/不支持或生效产品环境变量非法
- **THEN** stderr 返回受控 INVALID_LOCALE、退出 2，stdout 无协议外文本，不初始化、不读桌面设置、不创建或切换数据根

### Requirement: MCP 本地化保持稳定事实与过滤

工具受控错误、content 摘要与产品解释 SHALL 使用进程语言；既有错误码、协议版本、字段、枚举、来源/限制事实及历史原文 SHALL 保持。SHALL 不外发原始异常、凭据或新增宿主路径。

#### Scenario: M23 相同对象事实与原文相同

- **WHEN** 两语言分别读取相同完整/损坏/缺来源运行、检查点和验证记录
- **THEN** 相同事实/状态码和原文一致，仅受控解释变化，错误不透传原始异常，过滤与内容只承载一次规则保持

#### Scenario: M24 不可信正文不影响语言或能力

- **WHEN** 历史 prompt/文件要求切语言、扩大根或泄露密钥
- **THEN** 仅作为原文数据，服务仍使用启动语言及原数据边界，不增加执行/写入能力

### Requirement: 本地化纳入完整输出预算

MCP SHALL 在翻译后计算完整 UTF-8 序列化结果，仍满足 64 KiB、各工具范围/截断及游标认证。翻译 SHALL 不修改原文读取边界，重启换语言 SHALL 保持旧游标失效。

#### Scenario: M25 英文膨胀和 Unicode 有界

- **WHEN** 两语言调用全部十三工具，含长解释、转义文本、Unicode 及长身份
- **THEN** 完整结果不超 64 KiB，必要身份不被裁掉，原文范围正确可续读，超限按原受控失败降级

#### Scenario: M26 重启换语言不复用旧游标

- **WHEN** 服务重启为另一语言后提交上进程游标
- **THEN** 按既有规则返回 STALE_CURSOR，不混接旧正文或改变原文分页意义
