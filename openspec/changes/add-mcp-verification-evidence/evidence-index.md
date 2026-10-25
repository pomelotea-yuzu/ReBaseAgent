# MCP2 场景证据索引

状态：提案，尚未实现或验收。下表“待验收”不得理解为功能已存在。后续每行回填命令/测试文件、真实数据或 fixture 来源、结果和证据路径；同一证据可覆盖多行，但必须逐场景核对。

## 场景与验证方式

| 场景 | 预期证据 | 状态 |
|---|---|---|
| 原：发现工具与按需读取正文 | 5.1 stdio（tools/list 恰 13、原七工具契约逐字/结果回归保留，stdio-protocol 全绿） | 通过 |
| 原：未知字段和执行请求拒绝 | 契约形状层 + S04 未知工具协议回归（stdio-lifecycle）+ 5.1 真实 stdio | 通过 |
| M01 验证工具发现与独立数据域 | 契约测试 + lifecycle/trust（恰 13、runs 恒空）+ 5.1 stdio + WorkBuddy 实测 | 通过 |
| M02 精确筛选与稳定分页 | scan 测试 + list 工具测试 + 5.1 stdio + WorkBuddy list（25 条/翻页） | 通过 |
| M03 空数据与读取失败分开 | scan/list 测试 + 5.1 stdio（VERIFICATION_NOT_FOUND 业务失败帧） | 通过 |
| M04 实际命令与历史环境按记录读取 | 共享投影测试 + get 工具测试 + 5.3 WorkBuddy 真实 R3 记录回查（exit/env/source 逐项一致） | 通过 |
| M05 未封存中断与坏尾不形成成功 | 投影/工具测试（unterminated/坏尾/未知版本 terminated=null+诊断）+ 5.1 stdio | 通过 |
| M06 故障分类与历史结局不被查询改写 | `test/scan.test.ts`（十一 outcome 逐值经 writer 写入原样返回、10 passed）+ `test/compare-facts.test.ts`（证据门/历史 outcome 不改写）+ 投影/工具面 | 通过 |
| M07 缺来源和快照漂移仍能定位原验证 | compare-facts（缺来源/漂移/未定位 sourceVerified=false，结论不变）+ assets-view（独立附件按引用核验）；快照漂移的主动定位核对未接线（located 恒 null，保守侧不宣称已核对代码） | 通过（漂移主动定位属后续增强，保守侧满足本场景判据） |
| M08 附件与身份不可互换 | 形状测试 + assets-view 定位拒绝矩阵 + 工具测试（重复命令/清单外/重复 path/非法入参）+ 5.1 stdio | 通过 |
| M09 产物索引和内容来自指定验证 | assets-view + inspect/read artifact 工具测试 + 5.1 stdio | 通过 |
| M10 长日志保留采集截断与分页事实 | assets-view + 工具测试（capture limitation 常驻/区间连续覆盖/正文单次承载）+ 4.2 预算 + 5.1 stdio + WorkBuddy 实测（0–500/1014） | 通过 |
| M11 Unicode 原文与二进制如实读取 | assets-view（码点切片/代理对/二进制元数据）+ 工具测试（content 无 U+FFFD）+ 5.1 stdio | 通过 |
| M12 验证与附件变化使游标失效 | `test/verification-cursor.test.ts`（5 passed）+ 实机：进程 A 发游标→进程 B（重启）续读 ⇒ STALE_CURSOR（RESTART_STALE_PASS，2026-10-26） | 通过 |
| M13 单项超限受控失败 | `test/verification-budget.test.ts`（6 passed）+ 5.1 stdio | 通过 |
| M14 同条件失败到通过有完整引用 | compare-facts + 工具测试 + 5.3 WorkBuddy/桌面/MCP 三方同对象一致（verdict/11 条件/expectedSnapshotId）；2026-10-26 修订：sourceVerified 判据收紧（present+未定位 ⇒ false，D7 保守侧），真实对重放 verdict/条件不变 | 通过 |
| M15 条件不同未知和参数边界不掩盖 | compare-facts（argv 边界/对象键序/缺项 unknown）+ 工具测试（旧缺 environment ⇒ conditions-unknown）+ 桌面同实现 | 通过 |
| M16 单侧不可用与当前证据缺项 | compare-facts（outcome-unknown/evidence-incomplete 双来源）+ 工具测试（unavailable 侧不换验证、当前资产门）+ 5.1 stdio | 通过 |
| M17 全链零执行零写入与断连取消 | ①`test/verification-zero-write.test.ts`（fixture 全链指纹 3 passed）②5.1 stdio 生命周期（取消/EOF/目录树零写入，11 passed）③2026-10-26 真实根五数据目录 801 文件指纹前后逐字相同（含 verification-runtime 残留登记与未封存记录未动）＝零执行/零登记/零清理的数据面佐证 | 通过（执行计数以数据域不变+指纹承载） |
| M18 历史指令和秘密不扩展权限 | `test/verification-trust.test.ts`（6 passed）+ 指南 §7 MCP2 边界补充（6.1 已更新，与 initialize 同文） | 通过 |
| M19 真实客户端完成证据代表任务 | 2026-10-26 WorkBuddy 5.9.2 真实客户端回查（数据根 .rebaseagent，25 条真实 R3 记录）：①list 25 条 0 不可读 ②双记录 sealed/check_failed+passed、exit 1/0、env 在场 ③日志 TAP 原文（0–500/1014 码点，capture 完整）④compare failed-to-passed+11 same+expectedSnapshotId=recordedTarget——与桌面 CDP 自查逐项一致 ⑤VERIFICATION_NOT_FOUND 受控单行；回放五步调用真实根五数据目录 801 文件 SHA-256 前后逐字相同（ZERO_WRITE_PASS） | 通过（真实项目接入与自动修复未声称完成，模板范围如登记） |
| M20 生产闭包与发行说明可核对 | deploy 闭包探针 PROBE_PASS（5.4）+ 发行组装断言 13 + 指南/路线/项目状态发行口径（6.1：MCP2 未打包如实标注） | 通过（实际打包上传另行安排，不等于已发行） |
| V01 只读入口无执行依赖且无需后端 | read-closure 测试（静态导入图）+ 纯 Node/dist 探针 + deploy 闭包探针（5.4，无 Electron/Docker） | 通过 |
| V02 桌面与 MCP 对同对象事实一致 | 2026-10-26 双侧同对象对照：桌面（CDP 附加真实 Electron dev + renderer 真实 compareVerifications）与 WorkBuddy 5.9.2 经 MCP compare_verifications 对同一对记录逐项一致（verdict/11 条件/expectedSnapshotId）；桌面 IPC list/get/readLog 25 条零异常。宽窄窗/200%/键盘视觉抽查未做（留人工，不影响事实判据） | 通过（视觉抽查项未覆盖，如实标注） |
| V03 文本跨段与字节接口兼容 | assets-view（码点切片/旧字节接口零改动）+ desktop 全量 3474 passed（旧 IPC schema 回归） | 通过 |
| V04 核验与枚举不掩盖坏数据 | scan 测试 + assets-view（symlink/改写/歧义拒绝）+ list 工具失败项呈现 | 通过 |

## 实际执行记录（实施时填写）

- 确定性 fixture：`packages/mcp-server/test/verification-fixtures.ts` 已建（tasks 1.3）——11 条具名记录（pass/fail 同条件对、旧缺 environment、unterminated+interrupted、坏尾、未知版本、重复 command_end、附件缺失/被改、冲突产物清单、来源缺失）+ 残留 runtime 登记 + 准备记录；全部经 R3 writer/publishAsset 真写，自证测试 `verification-fixtures.test.ts` 15 passed。整根指纹探针 `snapshotRootFingerprint`/`rootFingerprintDiff` 与真实验证记录复制探针 `copyVerificationRecord` 就绪；R3 实际记录来源（本机数据根与 verificationId）在 5.3 实机轮次回填。
- 生产闭包探针（tasks 5.4，2026-10-25）：pnpm --filter @rebaseagent/mcp-server --prod --config.node-linker=hoisted deploy .rebaseagent/assemble-deploy → 复制到仓库外临时目录（自包含证明）→ 探针 PROBE_PASS：① dist/read.js+facts.js 独立加载（无 Electron/Docker/开发目录）②经生产闭包 writer/publishAsset 真写样本记录 ③stdio initialize→tools/list 恰 13→list_verifications/get_verification/read_verification_log 全通、content 自足；assemble-release-zip.mjs 断言已改 13（3.x）。实际打包/上传另行安排。
- 未完成：5.2 真实 Electron 核对（非自主）、5.3 真实客户端验收（非自主）。
- 客户端名称/版本、Node/服务/SDK 版本、启动路径与数据根选择：WorkBuddy 5.9.2（用户在应用内配置 MCP，2026-10-26）；服务 rebaseagent-mcp 0.1.0（MCP SDK 1.32.1）；Node v24.19.0（PATH node 启动 dist/cli.js）；数据根 D:/ReBaseAgent/.rebaseagent（25 条 R3 实机验证记录 + 配套 prep/traces）。
- R3 实际验证 ID、原 run/检查点/snapshot、命令、历史 manifest 与 preparationId：ver-18cedcbf0f7c3c03（run_r3_63_d12，initial，check_failed，snapshot ab315eb6…）/ ver-0fd97f8ca2567cdc（run_r3_63_slow，initial，passed，snapshot d98dcf53…）；命令 node /opt/r3/runner.mjs test（cwd /work）；manifest v4 · node-ts-v1 · planBindingDigest 0432ef52…；preparationId prep-47c4e5384ed714bd。
- 失败/通过样本的真实后端记录与确定性 fixture 区别、模板支持边界：待填。
- 同条件行逐项结果、当前资产可用性、源码/产物定位与桌面核对：11 条件 same（profile/manifest/planBinding/command/argv/cwd/platform/image/toolchain/limits/security）；currentAssetsAvailable 双侧 true；sourceVerified true；codeSame false（不同 snapshot）；桌面/MCP/客户端三方一致。
- 查询前后文件集合/hash、零执行/写入计数、断连/取消结果：真实根五数据目录 801 文件 SHA-256 前后逐字相同（ZERO_WRITE_PASS）；fixture 全链指纹（3 passed）；stdio 取消/EOF（11 passed）；重启游标 STALE（RESTART_STALE_PASS）。
- 生产依赖闭包、stdio 与全仓检查命令/结果、已知限制：6.2 门禁（2026-10-26）——run-query/project-verification/mcp-server build 全过；pv 288 passed、mcp-server 393 passed（含 MCP1 stdio 全量回归）、desktop 3474 passed（singleFork）、desktop typecheck node+web 0 错误、biome check 0 违规（修复 4 处：2 处 noImplicitAnyLet、2 处 noUnusedTemplateLiteral）、check-spec 16 passed / 0 failed、openspec validate --strict 通过、git diff --check 干净；deploy 闭包探针 PROBE_PASS（5.4）。已知限制：MCP2 未打包进发行 zip；桌面比较面板视觉抽查未做。
- 功能实施/客户端验收/打包发行分别标注；未执行的新项目/模型测试不得声称已验证。
