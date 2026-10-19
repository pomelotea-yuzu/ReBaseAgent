## ADDED Requirements

### Requirement: 初始快照实验创建独立文件映射

隔离 prompt SHALL 只从根 initial_snapshot 的已核验全部普通文件内容创建独立 world，新 initial_snapshot 的路径/字节/哈希 SHALL 与根初始一致。只共享不可变 blob，不共享可变映射。后续写入、轮末检查点、配额与异常处理 SHALL 沿用固定文件世界契约，不回读源目录或借父最终检查点补起点。普通文件之外的外部状态 SHALL 不承诺恢复。

#### Scenario: 根初始状态与父最终及源目录分离
- **WHEN** 根初始 config.json 为 A、根最终为 B，当前源目录被改为 C，新 prompt 子首次读并写为 D
- **THEN** 子首次读取 A，随后自有检查点为 D，源目录保持 C，根初始/最终与兄弟快照、既有 blob 的字节和哈希不变

#### Scenario: 空初始世界与后续超限遵守原配额
- **WHEN** 根初始清单为空，或合法实验后工具写入超过既有文件/世界/新增内容配额
- **THEN** 空世界可合法从头执行；超限成为工具错误，旧映射和已落盘检查点不变，不回写父/源，不增加隔离权限

### Requirement: 跨运行检查点比较只读取明确的自有快照

系统 SHALL 提供两侧独立 selector（runId、可选自有完成 stepSpanId，缺省为初始）的只读比较。每侧 SHALL 从一次自有记录读取冻结合法清单及 snapshot ID，同 run 两 selector SHALL 共享同一记录读取时点。非法/祖先步骤或不可读一侧 SHALL 返回该侧原因，不能默认换点或当空清单。两个合法清单 SHALL 按路径 UTF-16 序并集呈现，仅左/仅右/双方存在并保留两侧完整身份和初始基线；无须同根或相同步号，不自动对齐事件。

清单引用相同/不同 SHALL 与已核验内容相同/修改区分。路径正文读取 SHALL 逐侧验证字节，区分 text、binary、not_found、missing、corrupt、io；not_found 只来自合法清单。SHALL 仅对 text/text 或 text/已证实不存在生成文本 diff，保留原换行和空串；二进制/不可用/超限明确原因，不造空侧。正文返回 SHALL 匹配 expectedSnapshotIds，否则返回 selection_changed。比较全程不写 trace/blob/源、不调用工具/模型、不登记操作或消费授权。

#### Scenario: 两个自有检查点独立选择与路径并集
- **WHEN** 两侧选择不同 run/不同轮次或初始检查点，清单含共有、仅左和仅右路径
- **THEN** 返回稳定排序并集、各侧 run/step/snapshot/初始基线与引用状态，不借祖先步骤、不按轮号推断对齐；同 run 两 selector 不混用不同读取时点

#### Scenario: 未核验引用不冒充字节相同
- **WHEN** 两侧清单引用哈希相同，但附件尚未核验或其中一份丢失/损坏
- **THEN** 核验前只称引用相同，核验失败逐侧标明；不把相同哈希直接显示为已验证无差异，不把缺附件当删除

#### Scenario: 文本新增删除与原换行可核对
- **WHEN** 两侧选定路径为已校验 UTF-8 文本或一侧合法清单确认不存在，内容含空串、CRLF/LF、无末尾换行
- **THEN** 显示准确只读文本差异及新增/删除方向，原字节语义不因规范化改变，零网络/工具/文件写入

#### Scenario: 二进制和读取错误保留逐侧状态
- **WHEN** 路径一侧为 binary/missing/corrupt/io/超限，或一侧请求 ID 与 meta.id 不符、清单不可读、步骤非法
- **THEN** 逐侧显示原因、可得元信息及独立阅读入口，另一侧仍可读；无合法清单的一侧不当不存在，不生成伪文本 diff 或完整路径并集

#### Scenario: 选择快照变化不能拼出混合差异
- **WHEN** 清单读取后记录被替换或改选 run/step，旧正文请求/响应仍到达
- **THEN** 包层拒绝不匹配 expectedSnapshotIds 的正文读取，桌面按双侧 selector/path/请求代次丢弃旧反馈，等待显式刷新，不自动改点或触发执行
