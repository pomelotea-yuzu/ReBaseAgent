## ADDED Requirements

### Requirement: 桌面和 MCP 共享只读事实实现

系统 SHALL 提供无 Electron、renderer、MCP SDK 依赖的共享查询层，供桌面 IPC 与 MCP 调用；SHALL 复用 trace-sdk/replay 的读取、父链、路径和附件校验，不复制解析器或建立第二事实源。单请求同一物理 run SHALL 最多解析一次，缓存 SHALL NOT 跨请求掩盖变化。

#### Scenario: 三个 trace 版本使用同一事实实现
- **WHEN** 桌面和 MCP 查询相同 v1/v2/v3 fixture
- **THEN** 身份、状态、来源完整性、自有消耗和适用比较事实相同，MCP 仅做字段/容量投影

#### Scenario: 请求内复用读取且新请求重新读盘
- **WHEN** 一次比较涉及共同祖先，下一请求前文件发生变化
- **THEN** 首次请求每物理 run 最多解析一次，下一请求重新校验，不返回跨请求旧缓存

### Requirement: 摘要保留读取失败与终止事实

系统 SHALL 从已校验记录派生摘要，保留独立读取失败项；SHALL 区分明确出错终止、限制、中止、正常终止及未记录终止。未知消耗 SHALL 保持未知，SHALL NOT 将终止或工具错误自动判为任务成败，SHALL NOT 从无终止事件断言进程仍运行。

#### Scenario: 失败文件不因筛选消失
- **WHEN** 列表包含合法运行和损坏文件，并按明确出错终止筛选
- **THEN** 合法摘要按记录筛选，损坏文件仍作为独立失败项返回，不伪造为空列表或成功运行

#### Scenario: 未封存与未知消耗不补造
- **WHEN** 可校验记录尚无终止事件且部分 usage 未记录
- **THEN** 返回读取时点、未记录终止和未知消耗；半行或损坏导致解析失败时如实报错，不自行裁尾

### Requirement: 查询身份与数据范围受控

系统 SHALL 仅从配置数据根按合法 run/span/检查点/逻辑路径查询；SHALL 在目标读取前拒绝非法标识，核对文件名与 meta.id，校验父链每个标识，并拒绝通过链接/目录替身越界。SHALL NOT 接受调用方任意物理路径。

#### Scenario: 非法路径与身份错配拒绝
- **WHEN** 请求包含穿越、盘符/UNC/设备路径、ADS、非法父链 ID 或文件名与 meta.id 不同
- **THEN** 返回受控错误，不读取目录外目标、不借另一运行替换结果

#### Scenario: 链接越界与目录替身拒绝
- **WHEN** trace 或附件路径经 symlink/junction/reparse point 指向根外或被目录替代
- **THEN** 共享读取边界拒绝该目标，错误不含宿主物理路径或原始堆栈

### Requirement: 父链和独立执行边界保持既有语义

系统 SHALL 沿用 U6/U7/R2.2 的来源校验：仅已确认祖先文件缺失可 ownOnly，损坏/不可读/成环/无效 fork SHALL 失败。result 前缀与整轮语义 SHALL 保持；prompt、messages、model_params 和 v3 prompt 实验 SHALL 为独立执行边界。

#### Scenario: 缺父与坏父分开处理
- **WHEN** 合法祖先确实缺失，或祖先损坏/不可读/成环
- **THEN** 前者保留自有记录并标来源不完整，后者给结构化失败；不把坏父当缺父、不补零或猜根

#### Scenario: 混合链不跨独立边界拼接
- **WHEN** result 后代的来源链包含普通 prompt、代理 messages、模型实验或 v3 隔离 prompt
- **THEN** 仅按既有投影复用合法前缀，不将独立边界之前的 spans 拼入新执行

### Requirement: 步骤查询保留真实所属运行

系统 SHALL 从共享投影建立 span 所属关系。查询继承步骤 SHALL 返回实际 ownerRunId；重名 span SHALL 要求消歧，SHALL NOT 默认选首项；显式 owner 不能绕过当前投影可见范围。未记录错误、null 和空串 SHALL 分开。

#### Scenario: 重名 span 要求消歧
- **WHEN** 可见来源中两个 owner 含相同 spanId
- **THEN** 返回 SPAN_AMBIGUOUS 和候选引用，指定合法 owner 后返回真实归属和对应事实

#### Scenario: 截断祖先步骤与缺失错误不补造
- **WHEN** 指定被投影截断的祖先 span，或可见 span 没有录制 error
- **THEN** 前者不可读，后者标未记录，不通过 owner 偷读祖先或生成错误正文

### Requirement: 运行比较只返回可比较事实

系统 SHALL 对精确两条不同运行同序逐侧返回 ready/unavailable，并复用祖先、消耗、干预与输出派生。SHALL NOT 根据迭代序号自动对齐步骤、自动判根因或修复成功。

#### Scenario: 单侧失败不替换另一侧
- **WHEN** 左侧损坏而右侧可读
- **THEN** 保留左 run 身份及失败，右侧事实照常，不把坏侧当空运行

#### Scenario: 缺来源不宣称不同根或修复成功
- **WHEN** 任一来源不完整，或分支正常结束但无真实测试证据
- **THEN** 共同祖先/累计按既有未知语义返回，不称不同根、不补测试通过或修复成功

### Requirement: 历史文件与比较固定自有检查点

系统 SHALL 复用 replay 读取本 run 自有初始或完成步骤快照；省略 selector SHALL 明确为初始，显式失效 SHALL NOT 自动换点。清单引用和核验内容 SHALL 分开，二进制/未找到/缺失/损坏 SHALL 保留。SHALL NOT 回读源目录。

#### Scenario: 初始与显式步骤不自动互换
- **WHEN** 省略 stepSpanId，或指定祖先步骤/失效步骤
- **THEN** 前者只取本 run 初始；后者拒绝，不换最近步骤、不将祖先快照充作自有

#### Scenario: 两侧状态与原始文本可核对
- **WHEN** 比较固定两侧检查点，涉及 CRLF/空串/尾随换行、二进制或缺失/损坏附件
- **THEN** 原文本保真、二进制不冒充文本、逐侧状态独立；清单引用相同不能替代附件内容核验

### Requirement: 只读查询不执行或改写

系统 SHALL 保持 trace、附件、源目录和文件集合不变，不写持久索引/日志/session/锁，不调用模型、外部工具、导出或执行登记，不恢复外部状态。并发追加/替换导致不可校验时 SHALL 失败，不发布混合来源结果。

#### Scenario: 查询全链保持零执行零写入
- **WHEN** 完成列表、详情、步骤、运行比较、检查点和文件比较
- **THEN** 既有文件集合/字节哈希不变，模型/工具/导出计数为零，无新运行或 operation

#### Scenario: 源目录变化不能补历史附件
- **WHEN** 历史附件缺失而当前源目录存在同名新文件
- **THEN** 返回附件缺失，既不读取当前源文件补齐，也不修写旧快照
