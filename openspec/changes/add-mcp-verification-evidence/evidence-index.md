# MCP2 场景证据索引

状态：提案，尚未实现或验收。下表“待验收”不得理解为功能已存在。后续每行回填命令/测试文件、真实数据或 fixture 来源、结果和证据路径；同一证据可覆盖多行，但必须逐场景核对。

## 场景与验证方式

| 场景 | 预期证据 | 状态 |
|---|---|---|
| 原：发现工具与按需读取正文 | 十三工具 stdio 发现 + 原七工具参数/结果回归 | 待验收 |
| 原：未知字段和执行请求拒绝 | strict 参数与未知执行工具协议回归 | 待验收 |
| M01 验证工具发现与独立数据域 | 契约测试（11 passed）+ `packages/mcp-server/test/lifecycle.test.ts`/`trust.test.ts`（tools/list 恰 13、verifications provenance 不带 runs、runs 恒空断言，362 passed） | 部分通过（注册+单元面已证；生产 stdio 与真实客户端随 5.1/5.3 收口） |
| M02 精确筛选与稳定分页 | 共享 scan 测试 + `test/list-verifications.test.ts`（筛选/失败项不消失/翻页无重漏/换参游标拒，7 passed） | 部分通过（工具面已证；5.1 stdio 已证，真实客户端随 5.3） |
| M03 空数据与读取失败分开 | 同上（空目录=合法空列表不建目录；目录级 STORAGE_IO/文件级 UNREADABLE 分域；NOT_FOUND 稳定码） | 部分通过（工具面已证；5.1 stdio 已证，真实客户端随 5.3） |
| M04 实际命令与历史环境按记录读取 | 共享投影测试 + `packages/mcp-server/test/verification-tools.test.ts`（get_verification 实际命令/环境/结局按记录读取、旧缺 environment 保持 null + limitation，22 passed） | 部分通过（工具面已证；真实 R3 记录回查随 5.3 收口） |
| M05 未封存中断与坏尾不形成成功 | 同上（工具面：unterminated terminated=null + limitation、interrupted 只给计数不给容器名；坏记录读正文 VERIFICATION_RECORD_INVALID） | 部分通过（共享层+工具面已证；5.1 stdio 已证） |
| M06 故障分类与历史结局不被查询改写 | `packages/project-verification/test/compare-facts.test.ts`（证据门双来源、历史 outcome 不改写）+ projection/scan 同上 | 部分通过（共享层已证；十一 outcome 逐值回归随 6.2 全仓门禁） |
| M07 缺来源和快照漂移仍能定位原验证 | `test/compare-facts.test.ts`（sourceVerified 三态、expectedSnapshotId 固定 recordedTarget、漂移不改结论）+ `test/assets-view.test.ts`（独立附件按引用核验） | 部分通过（共享层已证；run-query/replay 来源核对接线随 2.6 后续/5.1 收口） |
| M08 附件与身份不可互换 | 形状测试 + `test/verification-tools.test.ts`（重复 command_end=PATH_REJECTED、清单外/重复 path 拒、非法入参拒、log/artifact 分类矩阵） | 部分通过（工具面已证；5.1 stdio 已证，真实客户端随 5.3） |
| M09 产物索引和内容来自指定验证 | `test/verification-tools.test.ts`（inspect available/corrupt 分类、未采集受控失败、read artifact 清单内文本/二进制元数据） | 部分通过（工具面已证；5.1 stdio 已证，真实客户端随 5.3） |
| M10 长日志保留采集截断与分页事实 | `test/verification-tools.test.ts`（逐页读完 capture 截断 limitation 常驻、续读区间连续覆盖、正文单次承载 bodyIn） | 部分通过（工具面已证；64 KiB 信封实测随 4.2/5.1 收口） |
| M11 Unicode 原文与二进制如实读取 | 同上（中文/emoji content 无 U+FFFD、CRLF 保留、二进制 kind=binary 只给元数据） | 部分通过（工具面已证；5.1 stdio 已证，真实客户端随 5.3） |
| M12 验证与附件变化使游标失效 | `test/verification-cursor.test.ts`（5 passed）+ 实机：进程 A 发游标→进程 B（重启）续读 ⇒ STALE_CURSOR（RESTART_STALE_PASS，2026-10-26） | 通过 |
| M13 单项超限受控失败 | `test/verification-budget.test.ts`（超大 argv ⇒ RESPONSE_LIMIT+verification 定位、错误信封不超预算、无宿主路径；五工具正常数据 ≤64KiB，6 passed） | 部分通过（进程内已证；5.1 stdio 已证，真实客户端随 5.3） |
| M14 同条件失败到通过有完整引用 | `test/verification-tools.test.ts`（fixture 同条件对 compare → failed-to-passed、全条件 same、expectedSnapshotIds=recordedTarget） | 部分通过（fixture 已证；真实 R3 记录随 5.3 收口） |
| M15 条件不同未知和参数边界不掩盖 | `test/compare-facts.test.ts`（argv 边界/对象键序）+ `test/verification-tools.test.ts`（旧缺 environment ⇒ conditions-unknown 不补齐） | 部分通过（工具面已证；桌面一致性随 5.2 收口） |
| M16 单侧不可用与当前证据缺项 | `test/verification-tools.test.ts`（一侧不存在/未封存 ⇒ unavailable+outcome-unknown、必需资产缺失 ⇒ evidence-incomplete.fromCurrentAssets） | 部分通过（工具面已证；5.1 stdio 已证，真实客户端随 5.3） |
| M17 全链零执行零写入与断连取消 | ①`test/verification-zero-write.test.ts`（fixture 全链指纹 3 passed）②5.1 stdio 生命周期（取消/EOF/目录树零写入，11 passed）③2026-10-26 真实根五数据目录 801 文件指纹前后逐字相同（含 verification-runtime 残留登记与未封存记录未动）＝零执行/零登记/零清理的数据面佐证 | 通过（执行计数以数据域不变+指纹承载） |
| M18 历史指令和秘密不扩展权限 | `test/verification-trust.test.ts`（data 封闭字段集/容器名不外发/错误无 errno 堆栈宿主路径/秘密原文不声称脱敏/TRUST_INSTRUCTIONS 对齐，6 passed） | 部分通过（工具面已证；指南文档随 6.1，真实客户端注入随 5.3） |
| M19 真实客户端完成证据代表任务 | 2026-10-26 WorkBuddy 5.9.2 真实客户端回查（数据根 .rebaseagent，25 条真实 R3 记录）：①list 25 条 0 不可读 ②双记录 sealed/check_failed+passed、exit 1/0、env 在场 ③日志 TAP 原文（0–500/1014 码点，capture 完整）④compare failed-to-passed+11 same+expectedSnapshotId=recordedTarget——与桌面 CDP 自查逐项一致 ⑤VERIFICATION_NOT_FOUND 受控单行；回放五步调用真实根五数据目录 801 文件 SHA-256 前后逐字相同（ZERO_WRITE_PASS） | 通过（真实项目接入与自动修复未声称完成，模板范围如登记） |
| M20 生产闭包与发行说明可核对 | 生产 deploy 探针/十三工具断言/文档状态 | 待验收 |
| V01 只读入口无执行依赖且无需后端 | `packages/project-verification/test/read-closure.test.ts`（静态导入图禁入 writer/append/assets/prepare/execute/orchestrate/runtime/docker 等 4 passed）+ 纯 Node 探针 `node -e "import('./dist/read.js')…"`（read/facts 均加载） | 部分通过（import 闭包与纯 Node 读取已证；「无需后端」的端到端读取回归随 5.1/4.4 收口） |
| V02 桌面与 MCP 对同对象事实一致 | 2026-10-26 双侧同对象对照：桌面（CDP 附加真实 Electron dev + renderer 真实 compareVerifications）与 WorkBuddy 5.9.2 经 MCP compare_verifications 对同一对记录逐项一致（verdict/11 条件/expectedSnapshotId）；桌面 IPC list/get/readLog 25 条零异常。宽窄窗/200%/键盘视觉抽查未做（留人工，不影响事实判据） | 通过（视觉抽查项未覆盖，如实标注） |
| V03 文本跨段与字节接口兼容 | `test/assets-view.test.ts`（码点切片跨段不丢字；旧字节接口默认 32 KiB/上限 64 KiB 零改动） | 部分通过（共享层已证；旧 IPC schema 全量回归随 5.2 收口） |
| V04 核验与枚举不掩盖坏数据 | `test/scan.test.ts`（失败项/非法名/目录级区分）+ `test/assets-view.test.ts`（symlink/junction 顶替拒绝、字节改写 ASSET_CORRUPT、大小/hash 完整核验） | 部分通过（共享层已证；scan 失败项呈现已证（3.1+5.1）） |

## 实际执行记录（实施时填写）

- 确定性 fixture：`packages/mcp-server/test/verification-fixtures.ts` 已建（tasks 1.3）——11 条具名记录（pass/fail 同条件对、旧缺 environment、unterminated+interrupted、坏尾、未知版本、重复 command_end、附件缺失/被改、冲突产物清单、来源缺失）+ 残留 runtime 登记 + 准备记录；全部经 R3 writer/publishAsset 真写，自证测试 `verification-fixtures.test.ts` 15 passed。整根指纹探针 `snapshotRootFingerprint`/`rootFingerprintDiff` 与真实验证记录复制探针 `copyVerificationRecord` 就绪；R3 实际记录来源（本机数据根与 verificationId）在 5.3 实机轮次回填。
- 生产闭包探针（tasks 5.4，2026-10-25）：pnpm --filter @rebaseagent/mcp-server --prod --config.node-linker=hoisted deploy .rebaseagent/assemble-deploy → 复制到仓库外临时目录（自包含证明）→ 探针 PROBE_PASS：① dist/read.js+facts.js 独立加载（无 Electron/Docker/开发目录）②经生产闭包 writer/publishAsset 真写样本记录 ③stdio initialize→tools/list 恰 13→list_verifications/get_verification/read_verification_log 全通、content 自足；assemble-release-zip.mjs 断言已改 13（3.x）。实际打包/上传另行安排。
- 未完成：5.2 真实 Electron 核对（非自主）、5.3 真实客户端验收（非自主）。
- 客户端名称/版本、Node/服务/SDK 版本、启动路径与数据根选择：WorkBuddy 5.9.2（用户在应用内配置 MCP，2026-10-26）；服务 rebaseagent-mcp 0.1.0（MCP SDK 1.32.1）；Node v24.19.0（PATH node 启动 dist/cli.js）；数据根 D:/ReBaseAgent/.rebaseagent（25 条 R3 实机验证记录 + 配套 prep/traces）。
- R3 实际验证 ID、原 run/检查点/snapshot、命令、历史 manifest 与 preparationId：ver-18cedcbf0f7c3c03（run_r3_63_d12，initial，check_failed，snapshot ab315eb6…）/ ver-0fd97f8ca2567cdc（run_r3_63_slow，initial，passed，snapshot d98dcf53…）；命令 node /opt/r3/runner.mjs test（cwd /work）；manifest v4 · node-ts-v1 · planBindingDigest 0432ef52…；preparationId prep-47c4e5384ed714bd。
- 失败/通过样本的真实后端记录与确定性 fixture 区别、模板支持边界：待填。
- 同条件行逐项结果、当前资产可用性、源码/产物定位与桌面核对：11 条件 same（profile/manifest/planBinding/command/argv/cwd/platform/image/toolchain/limits/security）；currentAssetsAvailable 双侧 true；sourceVerified true；codeSame false（不同 snapshot）；桌面/MCP/客户端三方一致。
- 查询前后文件集合/hash、零执行/写入计数、断连/取消结果：真实根五数据目录 801 文件 SHA-256 前后逐字相同（ZERO_WRITE_PASS）；fixture 全链指纹（3 passed）；stdio 取消/EOF（11 passed）；重启游标 STALE（RESTART_STALE_PASS）。
- 生产依赖闭包、stdio 与全仓检查命令/结果、已知限制：待填。
- 功能实施/客户端验收/打包发行分别标注；未执行的新项目/模型测试不得声称已验证。
