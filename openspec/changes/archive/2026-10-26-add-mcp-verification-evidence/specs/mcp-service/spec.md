## RENAMED Requirements

- FROM: `### Requirement: 首版只发布七个诊断工具`
- TO: `### Requirement: 只发布只读诊断工具`

## MODIFIED Requirements

### Requirement: 只发布只读诊断工具

系统 SHALL 保留首版 list_runs、get_run、get_step、compare_runs、inspect_checkpoint、read_checkpoint_file、compare_checkpoint_files 的名称、参数和行为，并新增 list_verifications、get_verification、read_verification_log、inspect_verification_artifacts、read_verification_artifact、compare_verifications 六个只读工具。完整实现后 SHALL 恰有十三个工具，输入 strict 且有限额。摘要/索引 SHALL 默认不含完整正文，正文须显式按对象/section/path/stream 读取。SHALL NOT 发布准备/执行/停止/导出/删除工具或通过 resources/prompts 旁路读取。

#### Scenario: 发现工具与按需读取正文
- **WHEN** 客户端列工具，先查运行再查指定 span 的 output 和检查点文件
- **THEN** 恰有十三个工具，原七工具的参数/事实不变，先摘要后正文，引用可回到真实 run/span/检查点

#### Scenario: 未知字段和执行请求拒绝
- **WHEN** 工具参数带 dataDir/handler/未知字段，或请求重跑/写入工具
- **THEN** 返回参数/未知工具错误，不改变服务范围、不调用执行能力

#### Scenario: M01 验证工具发现与独立数据域
- **WHEN** 客户端发现工具并查询验证列表，而数据根同时含 trace 与 verification
- **THEN** 新增六工具均为只读，验证独立 ID 不进入 list_runs、不增加 run/span 或模型消耗，无执行/停止接口和资源旁路

## ADDED Requirements

### Requirement: 验证查询复用实际记录并保留缺失与失败

系统 SHALL 从显式数据根查询独立版本化验证记录，按精确 runId、记录状态与实际 outcome 筛选并有界分页。SHALL 保留不可读/损坏/未知版本项，不因筛选或单项失败伪造空列表。SHALL 区分无目录、空目录、枚举失败。get SHALL 先给身份/摘要/实际命令/环境/日志及产物引用和分页事件索引，不默认展开正文。

#### Scenario: M02 精确筛选与稳定分页
- **WHEN** 多个 run 的验证超过单页，客户端按一个 runId 和 outcome 筛选后连续翻页
- **THEN** 可判定摘要精确筛选，按创建时间倒序/ID 升序固定顺序无重漏分页，无继承/最新分支替换；失败项占额度且仅出现一次

#### Scenario: M03 空数据与读取失败分开
- **WHEN** 验证目录不存在/为空，或目录/单条记录不可读、损坏、版本不支持
- **THEN** 前两者合法空列表且不建目录；目录不可读给受控失败，单项失败/损坏/版本状态显式保留，不吞错

#### Scenario: M04 实际命令与历史环境按记录读取
- **WHEN** 查询有完整环境身份的记录以及缺 environment 的旧记录
- **THEN** 返回实际 executable、有序 argv、容器 cwd、UTC 起止、exit/signal、耗时及实际记录环境；旧字段保持未知，不读当前 manifest/机器补齐，不默认返回日志/全事件正文

### Requirement: 验证结局与记录和证据完整性分层

系统 SHALL 保留 R3 十一种 outcome，区分记录 sealed/unterminated/corrupt/unsupported_version。仅 sealed SHALL 暴露可信终止结局；坏尾/重复终止/终止后事件 SHALL NOT 裁掉或输出 passed。退出码、记录结局、采集完整性与当前附件可用性 SHALL 分开，缺记录/缺日志/exit 0/Agent 自述 SHALL NOT 推导测试通过。

#### Scenario: M05 未封存中断与坏尾不形成成功
- **WHEN** 记录未终止、含 interrupted、坏尾、重复终止或终止后还有事件
- **THEN** 按实际状态诊断，非 sealed 的可信 terminated/outcome 为 null；不声明仍运行、不由查询清理或补写终止，坏记录正文读取受控拒绝

#### Scenario: M06 故障分类与历史结局不被查询改写
- **WHEN** 查询检查失败、环境/启动/进程故障、超时、输出限制、取消、产物无效、证据不完整和 unknown，或历史 passed 的附件后来缺失
- **THEN** 原结局/exit/signal 原样保留，当前附件缺失单列；不把基础设施故障算断言失败，不以 exit 0 升级结论

### Requirement: 验证证据绑定原验证目标与附件

系统 SHALL 从验证内唯一命令/流或产物清单解析附件，拒绝直接 hash/宿主路径/URL。所有请求和记录内标识/逻辑路径 SHALL 校验后使用。SHALL 核对完整资产大小与哈希，区分未记录、合法空内容、缺失、损坏和拒绝。来源缺失/损坏/快照不符 SHALL 保留 recordedTarget 和独立附件，明确标注，不切换检查点或读取当前源目录补齐。

#### Scenario: M07 缺来源和快照漂移仍能定位原验证
- **WHEN** 来源 trace 删除/损坏，或同 selector 定位到与记录不同的 snapshotId
- **THEN** 原 verification/run/checkpoint/snapshot 引用保留，来源状态与完整性分开；独立附件仍按其引用核验，不宣称已核对代码，不从源目录/祖先/最近步骤替代

#### Scenario: M08 附件与身份不可互换
- **WHEN** 请求带裸 hash、额外物理路径，或记录含重复/错配 commandId、重复产物 path、非法内嵌 ID、越界链接/目录替身
- **THEN** 受控拒绝，不读边界外目标、不取第一项或另一验证替换，不泄露宿主路径/原异常

#### Scenario: M09 产物索引和内容来自指定验证
- **WHEN** 查询已采集产物、未采集、合法空清单、缺失/损坏资产及清单外 path
- **THEN** 返回原验证的路径/大小/hash/排除规则和逐项可用性；未采集与空清单不同，清单外 path 拒绝，产物不成为 Agent 检查点

### Requirement: 验证日志与产物支持有界安全续读

系统 SHALL 按验证/命令/流读取日志，按验证/逻辑路径读取产物，并沿用完整结果 64 KiB 预算、认证游标和 content 自足/正文单次承载。SHALL 分开执行采集字节/丢弃和本次响应截断。文本 SHALL 按严格 UTF-8 和 Unicode 码点范围读取，保留换行；二进制或非法编码仅返回元数据。游标 SHALL 绑定工具/参数/模式/验证资产/读取版本。

#### Scenario: M10 长日志保留采集截断与分页事实
- **WHEN** 记录的日志保留字节少于观测字节，客户端逐页读完保留资产
- **THEN** 每页完整结果不超 64 KiB，范围和下一位置准确；读完只表示保留部分结束，capture 截断/缺失仍存在，证据不升级完整

#### Scenario: M11 Unicode 原文与二进制如实读取
- **WHEN** 日志/产物含中文、emoji、转义、CRLF、空串、尾随换行或非法 UTF-8/二进制
- **THEN** 文本按码点续读可重建原文，不拆代理对或以替换字符补字节；非法编码/二进制只给 bytes/hash，无 base64，完整资产 hash 与片段范围分开

#### Scenario: M12 验证与附件变化使游标失效
- **WHEN** 续读前候选集合、验证/准备记录、参与来源或资产变化，服务重启，或游标篡改/改参数/换工具
- **THEN** 来源变化/重启给 STALE_CURSOR，篡改/异参给 INVALID_ARGUMENT，不拼新旧事实、不发无进展游标

#### Scenario: M13 单项超限受控失败
- **WHEN** 最小身份/命令/比较元数据投影仍无法放入完整结果预算
- **THEN** 给 RESPONSE_LIMIT 和安全定位，不删身份伪称完整，不返回超限信封

### Requirement: 验证比较共享条件判据并限制结论

系统 SHALL 比较用户明确指定的两个不同 verification，逐侧保留可读/不可用状态，复用桌面共享纯事实条件与结论。条件不同或未知、任侧非封存或证据不完整 SHALL NOT 合成为同条件失败到通过。SHALL 核验当前必需附件可用性，保留历史 outcome；干预仅取已录制分叉，代码回查使用精确记录快照。

#### Scenario: M14 同条件失败到通过有完整引用
- **WHEN** 左 check_failed/右 passed、两侧封存、证据完整且当前附件可核验，所有条件已知相同，来源分支可核对
- **THEN** 只声明该固定检查失败到通过，提供两个 verification/命令/环境/精确检查点及日志/产物引用；不宣称完整正确或因果，不自动修复

#### Scenario: M15 条件不同未知和参数边界不掩盖
- **WHEN** 任侧环境缺项、镜像/配方/限额不同，或两个 argv 数组 join 后相同但边界不同
- **THEN** 逐条件给 unknown/different，不拿当前 manifest 补齐或以字符串展示相同判条件相同，桌面和 MCP 判据一致

#### Scenario: M16 单侧不可用与当前证据缺项
- **WHEN** 一侧记录损坏/不存在/未封存，或必需日志/已发布产物后来缺失/损坏
- **THEN** 固定原左右身份，另一侧仍可查；分别给 outcome-unknown/evidence-incomplete，保留已录历史 outcome，不自动换验证或发布可核查修复结论

### Requirement: 验证查询保持只读和可信外发边界

系统 SHALL 在桌面/Docker 未运行时读取已有验证，零写入、零模型/工具/执行/清理/导出/登记，无持久索引或网络探测。SHALL 白名单投影元数据和受控错误，不读取 SettingsStore/key/runtime 登记。历史命令/日志/文件 SHALL 标为不可信，正文可能含秘密及客户端外发/费用须在指南说明。查询取消/断连 SHALL 不影响真实验证执行。

#### Scenario: M17 全链零执行零写入与断连取消
- **WHEN** 无桌面/Docker 的服务完成六工具全链，期间取消、断连、重连，数据中含未封存验证与残留登记
- **THEN** 前后文件集合/哈希不变，执行/停止/探测/清理/模型/导出/登记调用为零；只结束查询，旧游标失效，不修改真实验证状态

#### Scenario: M18 历史指令和秘密不扩展权限
- **WHEN** 日志/argv/产物含秘密或要求读取别处/执行命令的文本，或读取触发原始 IO 异常
- **THEN** 只按记录和白名单返回，结构凭据按既有规则过滤，正文不声称彻底脱敏；不扩目录/工具，错误不含原始堆栈/宿主路径

### Requirement: MCP2 通过真实客户端与桌面一致性验收

系统 SHALL 在一个选定真实客户端完成原失败验证到指定修复验证的命令/日志/环境/输入/产物回查，与桌面核对同对象事实和比较结论。SHALL 记录实际客户端/服务/Node/SDK 版本、数据来源和限制，不以 SDK 探针、fixture、MCP1 旧验收代替。实施、验收与发行 SHALL 分开。

#### Scenario: M19 真实客户端完成证据代表任务
- **WHEN** 选定客户端读取 R3 实际保留的失败/通过记录及两侧文件产物，按引用在桌面回查
- **THEN** 命令、结局、环境缺项/差异和日志引用一致，模板/fixture/真实后端来源明确；不声称真实项目接入或自动修复已完成，记录本轮版本和限制

#### Scenario: M20 生产闭包与发行说明可核对
- **WHEN** 对新只读子入口执行生产依赖闭包探针，并更新指南/状态/发行组装断言
- **THEN** 生产目录可发现十三工具并查询已有验证，无开发目录依赖或执行导入；未实际打包的 MCP2 明确标未发行，旧包仍按其原能力说明
