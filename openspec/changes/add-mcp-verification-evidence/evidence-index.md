# MCP2 场景证据索引

状态：提案，尚未实现或验收。下表“待验收”不得理解为功能已存在。后续每行回填命令/测试文件、真实数据或 fixture 来源、结果和证据路径；同一证据可覆盖多行，但必须逐场景核对。

## 场景与验证方式

| 场景 | 预期证据 | 状态 |
|---|---|---|
| 原：发现工具与按需读取正文 | 十三工具 stdio 发现 + 原七工具参数/结果回归 | 待验收 |
| 原：未知字段和执行请求拒绝 | strict 参数与未知执行工具协议回归 | 待验收 |
| M01 验证工具发现与独立数据域 | `packages/mcp-server/test/verification-contracts.test.ts`（契约为 6、注册仍 0、合集名唯一=13；枚举/上限/annotations 逐字钉死，11 passed） | 部分通过（契约冻结已证；注册与生产 stdio 发现随 3.x/5.1 收口） |
| M02 精确筛选与稳定分页 | `packages/project-verification/test/scan.test.ts`（createdAt 倒序 + UTF-16 码元升序解同刻、失败项末尾按文件名，9 passed） | 部分通过（共享层排序/失败项已证；筛选与分页跨页重建随 3.1/5.1 收口） |
| M03 空数据与读取失败分开 | 同上（缺目录=合法空且不建目录；目录级 ENOTDIR 抛 VerificationDirReadError；损坏/未知版本以 status 显式保留、不呈现 outcome） | 部分通过（共享层已证；MCP 错误码映射随 3.1 收口） |
| M04 实际命令与历史环境按记录读取 | `packages/project-verification/test/projection.test.ts`（start/end 配对、executable/argv/cwd/UTC 起止/exit/流元数据、旧缺 environment 保持 null、epoch/operationId 不外发，9 passed） | 部分通过（共享投影已证；MCP get_verification 呈现随 3.2 收口） |
| M05 未封存中断与坏尾不形成成功 | 同上（unterminated/corrupt/未知版本 terminated 恒 null + 结构化诊断；坏尾/重复终止/终止后事件不裁尾出 passed；interrupted 只给安全计数） | 部分通过（共享层已证；MCP 呈现随 3.2 收口） |
| M06 故障分类与历史结局不被查询改写 | `packages/project-verification/test/compare-facts.test.ts`（证据门双来源、历史 outcome 不改写）+ projection/scan 同上 | 部分通过（共享层已证；十一 outcome 的 MCP 逐值回归随 3.x 收口） |
| M07 缺来源和快照漂移仍能定位原验证 | `test/compare-facts.test.ts`（sourceVerified 三态、expectedSnapshotId 固定 recordedTarget、漂移不改结论）+ `test/assets-view.test.ts`（独立附件按引用核验） | 部分通过（共享层已证；run-query/replay 来源核对接线随 2.6 后续/5.1 收口） |
| M08 附件与身份不可互换 | `packages/mcp-server/test/verification-contracts.test.ts`（形状层 dataDir/handler/额外键全拒，11 passed）+ `packages/project-verification/test/assets-view.test.ts`（重复 command_end/重复产物 path/清单外/未采集/非法哈希引用结构化拒绝，15 passed） | 部分通过（形状+共享定位已证；MCP 运行期信封随 3.3/3.5 收口） |
| M09 产物索引和内容来自指定验证 | `test/assets-view.test.ts`（未采集 ARTIFACTS_NOT_RECORDED 与合法空清单 ARTIFACT_NOT_FOUND 分开、排除规则带出、坏资产 ASSET_CORRUPT） | 部分通过（共享层已证；inspect 工具呈现随 3.4 收口） |
| M10 长日志保留采集截断与分页事实 | `test/assets-view.test.ts`（capture 双口径与响应范围分开：读完保留部分 capture.truncated 仍 true）+ fixture fail 记录（retained<observed） | 部分通过（共享层已证；逐页重建与 64 KiB 信封随 3.3/4.2 收口） |
| M11 Unicode 原文与二进制如实读取 | `test/assets-view.test.ts`（中文/emoji/CRLF/空串/尾换行码点切片不拆代理对不补替换字符；非法 UTF-8 判 binary 只给元数据） | 部分通过（共享层已证；MCP 正文承载随 3.3/4.2 收口） |
| M12 验证与附件变化使游标失效 | 候选/记录/准备/来源/附件变化、异参/篡改/重启 | 待验收 |
| M13 单项超限受控失败 | 超大元数据/转义与 RESPONSE_LIMIT | 待验收 |
| M14 同条件失败到通过有完整引用 | `packages/project-verification/test/compare-facts.test.ts`（同条件对基线、结论顺序钉死，10 passed）+ mcp-server fixture 同条件对（ver-m2-pass/fail） | 部分通过（共享判据已证；MCP compare 与真实 R3 记录回查随 3.6/5.3 收口） |
| M15 条件不同未知和参数边界不掩盖 | 同上（argv join 同串但边界不同 ⇒ different；对象键序无关深相等；环境缺 ⇒ unknown 不补齐）+ 桌面 `test/verification-compare.test.ts`（共享判据接线后 9 passed） | 部分通过（共享判据已证；桌面/MCP 同对象一致性随 5.2 收口） |
| M16 单侧不可用与当前证据缺项 | `test/compare-facts.test.ts`（非封存 ⇒ outcome-unknown；当前资产缺失 ⇒ evidence-incomplete 且不改写历史 outcome） | 部分通过（共享层已证；MCP 逐侧呈现随 3.6 收口） |
| M17 全链零执行零写入与断连取消 | 全数据根/源目录前后集合 SHA-256，零执行计数，真实 stdio 生命周期 | 待验收 |
| M18 历史指令和秘密不扩展权限 | 结构凭据/自由秘密/注入/受控 IO 错误 + 指南 | 待验收 |
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
