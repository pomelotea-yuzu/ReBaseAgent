# MCP2 场景证据索引

状态：提案，尚未实现或验收。下表“待验收”不得理解为功能已存在。后续每行回填命令/测试文件、真实数据或 fixture 来源、结果和证据路径；同一证据可覆盖多行，但必须逐场景核对。

## 场景与验证方式

| 场景 | 预期证据 | 状态 |
|---|---|---|
| 原：发现工具与按需读取正文 | 十三工具 stdio 发现 + 原七工具参数/结果回归 | 待验收 |
| 原：未知字段和执行请求拒绝 | strict 参数与未知执行工具协议回归 | 待验收 |
| M01 验证工具发现与独立数据域 | 契约测试（11 passed）+ `packages/mcp-server/test/lifecycle.test.ts`/`trust.test.ts`（tools/list 恰 13、verifications provenance 不带 runs、runs 恒空断言，362 passed） | 部分通过（注册+单元面已证；生产 stdio 与真实客户端随 5.1/5.3 收口） |
| M02 精确筛选与稳定分页 | 共享 scan 测试 + `test/list-verifications.test.ts`（筛选/失败项不消失/翻页无重漏/换参游标拒，7 passed） | 部分通过（工具面已证；生产 stdio 随 5.1 收口） |
| M03 空数据与读取失败分开 | 同上（空目录=合法空列表不建目录；目录级 STORAGE_IO/文件级 UNREADABLE 分域；NOT_FOUND 稳定码） | 部分通过（工具面已证；生产 stdio 随 5.1 收口） |
| M04 实际命令与历史环境按记录读取 | 共享投影测试 + `packages/mcp-server/test/verification-tools.test.ts`（get_verification 实际命令/环境/结局按记录读取、旧缺 environment 保持 null + limitation，22 passed） | 部分通过（工具面已证；真实 R3 记录回查随 5.3 收口） |
| M05 未封存中断与坏尾不形成成功 | 同上（工具面：unterminated terminated=null + limitation、interrupted 只给计数不给容器名；坏记录读正文 VERIFICATION_RECORD_INVALID） | 部分通过（共享层+工具面已证；真实 stdio 随 5.1 收口） |
| M06 故障分类与历史结局不被查询改写 | `packages/project-verification/test/compare-facts.test.ts`（证据门双来源、历史 outcome 不改写）+ projection/scan 同上 | 部分通过（共享层已证；十一 outcome 的 MCP 逐值回归随 3.x 收口） |
| M07 缺来源和快照漂移仍能定位原验证 | `test/compare-facts.test.ts`（sourceVerified 三态、expectedSnapshotId 固定 recordedTarget、漂移不改结论）+ `test/assets-view.test.ts`（独立附件按引用核验） | 部分通过（共享层已证；run-query/replay 来源核对接线随 2.6 后续/5.1 收口） |
| M08 附件与身份不可互换 | 形状测试 + `test/verification-tools.test.ts`（重复 command_end=PATH_REJECTED、清单外/重复 path 拒、非法入参拒、log/artifact 分类矩阵） | 部分通过（工具面已证；生产 stdio 随 5.1 收口） |
| M09 产物索引和内容来自指定验证 | `test/verification-tools.test.ts`（inspect available/corrupt 分类、未采集受控失败、read artifact 清单内文本/二进制元数据） | 部分通过（工具面已证；生产 stdio 随 5.1 收口） |
| M10 长日志保留采集截断与分页事实 | `test/verification-tools.test.ts`（逐页读完 capture 截断 limitation 常驻、续读区间连续覆盖、正文单次承载 bodyIn） | 部分通过（工具面已证；64 KiB 信封实测随 4.2/5.1 收口） |
| M11 Unicode 原文与二进制如实读取 | 同上（中文/emoji content 无 U+FFFD、CRLF 保留、二进制 kind=binary 只给元数据） | 部分通过（工具面已证；生产 stdio 随 5.1 收口） |
| M12 验证与附件变化使游标失效 | `test/verification-cursor.test.ts`（新增记录/trace 追加/附件改写/附件删除 ⇒ STALE_CURSOR；篡改/换工具/换参数 ⇒ INVALID_ARGUMENT；尾页无进展不发游标，5 passed） | 部分通过（进程内已证；进程重启换密钥由 cursor.ts 判据承载，真实 stdio 随 5.1 收口） |
| M13 单项超限受控失败 | `test/verification-budget.test.ts`（超大 argv ⇒ RESPONSE_LIMIT+verification 定位、错误信封不超预算、无宿主路径；五工具正常数据 ≤64KiB，6 passed） | 部分通过（进程内已证；生产 stdio 随 5.1 收口） |
| M14 同条件失败到通过有完整引用 | `test/verification-tools.test.ts`（fixture 同条件对 compare → failed-to-passed、全条件 same、expectedSnapshotIds=recordedTarget） | 部分通过（fixture 已证；真实 R3 记录随 5.3 收口） |
| M15 条件不同未知和参数边界不掩盖 | `test/compare-facts.test.ts`（argv 边界/对象键序）+ `test/verification-tools.test.ts`（旧缺 environment ⇒ conditions-unknown 不补齐） | 部分通过（工具面已证；桌面一致性随 5.2 收口） |
| M16 单侧不可用与当前证据缺项 | `test/verification-tools.test.ts`（一侧不存在/未封存 ⇒ unavailable+outcome-unknown、必需资产缺失 ⇒ evidence-incomplete.fromCurrentAssets） | 部分通过（工具面已证；生产 stdio 随 5.1 收口） |
| M17 全链零执行零写入与断连取消 | `test/verification-zero-write.test.ts`（六工具全链+失败路径整根指纹逐字未动，残留 runtime/未封存记录未动；断连/取消属 stdio 服务层由 MCP1 stdio-lifecycle 覆盖，3 passed） | 部分通过（进程内已证；真实 stdio 生命周期与零执行计数随 5.1/5.3 收口） |
| M18 历史指令和秘密不扩展权限 | `test/verification-trust.test.ts`（data 封闭字段集/容器名不外发/错误无 errno 堆栈宿主路径/秘密原文不声称脱敏/TRUST_INSTRUCTIONS 对齐，6 passed） | 部分通过（工具面已证；指南文档与真实客户端注入随 6.1/5.3 收口） |
| M19 真实客户端完成证据代表任务 | 实际客户端版本/配置/完整工具记录 + Electron 同对象回查 | 待验收 |
| M20 生产闭包与发行说明可核对 | 生产 deploy 探针/十三工具断言/文档状态 | 待验收 |
| V01 只读入口无执行依赖且无需后端 | `packages/project-verification/test/read-closure.test.ts`（静态导入图禁入 writer/append/assets/prepare/execute/orchestrate/runtime/docker 等 4 passed）+ 纯 Node 探针 `node -e "import('./dist/read.js')…"`（read/facts 均加载） | 部分通过（import 闭包与纯 Node 读取已证；「无需后端」的端到端读取回归随 5.1/4.4 收口） |
| V02 桌面与 MCP 对同对象事实一致 | `compare-facts.test.ts`（共享判据）+ 桌面 renderer 已接同一实现（`verification-compare.ts` 消费 `@rebaseagent/project-verification/facts`，panel 35 passed 回归） | 部分通过（共享实现已证；真实 Electron 同对象回归随 5.2 收口） |
| V03 文本跨段与字节接口兼容 | `test/assets-view.test.ts`（码点切片跨段不丢字；旧字节接口默认 32 KiB/上限 64 KiB 零改动） | 部分通过（共享层已证；旧 IPC schema 全量回归随 5.2 收口） |
| V04 核验与枚举不掩盖坏数据 | `test/scan.test.ts`（失败项/非法名/目录级区分）+ `test/assets-view.test.ts`（symlink/junction 顶替拒绝、字节改写 ASSET_CORRUPT、大小/hash 完整核验） | 部分通过（共享层已证；scan 失败项的 MCP 呈现随 3.1 收口） |

## 实际执行记录（实施时填写）

- 确定性 fixture：`packages/mcp-server/test/verification-fixtures.ts` 已建（tasks 1.3）——11 条具名记录（pass/fail 同条件对、旧缺 environment、unterminated+interrupted、坏尾、未知版本、重复 command_end、附件缺失/被改、冲突产物清单、来源缺失）+ 残留 runtime 登记 + 准备记录；全部经 R3 writer/publishAsset 真写，自证测试 `verification-fixtures.test.ts` 15 passed。整根指纹探针 `snapshotRootFingerprint`/`rootFingerprintDiff` 与真实验证记录复制探针 `copyVerificationRecord` 就绪；R3 实际记录来源（本机数据根与 verificationId）在 5.3 实机轮次回填。
- 客户端名称/版本、Node/服务/SDK 版本、启动路径与数据根选择：待填。
- R3 实际验证 ID、原 run/检查点/snapshot、命令、历史 manifest 与 preparationId：待填。
- 失败/通过样本的真实后端记录与确定性 fixture 区别、模板支持边界：待填。
- 同条件行逐项结果、当前资产可用性、源码/产物定位与桌面核对：待填。
- 查询前后文件集合/hash、零执行/写入计数、断连/取消结果：待填。
- 生产依赖闭包、stdio 与全仓检查命令/结果、已知限制：待填。
- 功能实施/客户端验收/打包发行分别标注；未执行的新项目/模型测试不得声称已验证。
