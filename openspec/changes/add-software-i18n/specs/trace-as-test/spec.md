## ADDED Requirements

### Requirement: trace-test 人类报告完整双语

trace-test SHALL 使用共享 CLI 语言规则，覆盖帮助、参数错误、配置/运行失败、断言定位、漂移说明、隐私提示、baseline 反馈和汇总。命令参数、脱敏、退出码及 baseline 写入条件 SHALL 保持；用户/记录正文 SHALL 不自动翻译。

#### Scenario: C01 人类报告与限制事实等价

- **WHEN** 两语言运行受控通过、断言失败、配置失败及配置/请求/参数漂移案例
- **THEN** 人类产品提示完整且事实同义，退出码分别遵守既有 0/1/2，敏感字段继续脱敏，原始用户内容不改写

#### Scenario: C02 语言选择不触发 baseline 写入

- **WHEN** --help、非法 locale 或未显式 --update-baseline 的测试使用另一语言
- **THEN** 不写 baseline，非法语言先于用户模块加载失败；显式更新仍按原成功与写入判据

### Requirement: trace-test JSON 报告与语言无关

--report json SHALL 保持现有报告字段、值、原始 detail、脱敏和退出码；内存翻译描述 SHALL 不进入报告。stdout SHALL 是可解析报告，产品诊断及显式 baseline 文本反馈 SHALL 在 stderr。

#### Scenario: C03 两语言机器报告契约等价

- **WHEN** 相同确定性 fixture 分别用两语言输出 JSON
- **THEN** 解析后的报告深度相等（仅原有非确定字段按相同规则归一），无新增翻译内部字段或本地化值，退出码相同

#### Scenario: C04 baseline 文本不污染 JSON

- **WHEN** 显式 --update-baseline 与 --report json 同用并满足原写入条件
- **THEN** stdout 仍可解析单份 JSON，更新反馈在 stderr，写入内容及原 trace 保护规则不随 locale 变化
