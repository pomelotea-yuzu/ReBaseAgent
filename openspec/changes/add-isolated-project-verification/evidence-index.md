# R3 逐场景证据索引

状态：阶段 1 进行中——P01 的 1.1 缺失态子项、P09 的 1.2 切片、P04/P08/P11/P12 的 1.3 切片已实测（backend-verification.md §1.1–§1.3）；除已标注切片外以下待验证；文档/strict 校验通过不代表功能、隔离或实机验收通过。

## 新增场景

| 编号 | capability / 场景 | 对应任务 | 状态与证据 |
|---|---|---|---|
| P01 | project-verification / 后端缺失或未验收 | 1.1、3.2、6.5 | 1.1 缺失态已实测（2026-10-24，backend-verification.md §1.1：PATH/目录/服务/注册表/WSL 发行版/named pipe 六路，0 docker pipe）；3.2/6.5 待执行 |
| P02 | project-verification / 拒绝远程或漂移环境 | 1.1、2.1、3.2 | 待验证；未执行 |
| P03 | project-verification / 只读计划不准备环境 | 3.1、4.3、6.5 | 待验证；未执行 |
| P04 | project-verification / 授权准备成功或失败 | 1.3、3.1、6.5 | 1.3 切片已实测（2026-10-24，backend-verification.md §1.3：镜像构建内 npm install --ignore-scripts 成功、lock/受信文件哈希冻结）；3.1/6.5 待执行 |
| P05 | project-verification / 精确选择初始或自有完成步骤 | 1.5、2.1、2.4、3.3 | 待验证；未执行 |
| P06 | project-verification / 来源或附件不成立 | 2.4、3.3 | 待验证；未执行 |
| P07 | project-verification / 计划或授权失效 | 2.4、3.1、4.2 | 待验证；未执行 |
| P08 | project-verification / 自定义命令和配置被拒绝 | 1.3、2.1、3.1 | 1.3 切片已实测（npm scripts 不执行、恶意 package.json 被模板覆盖、/opt/r3 不可改、/work 测试不扫描）；2.1/3.1 待执行 |
| P09 | project-verification / 越界和网络实际受限 | 1.2、3.2、3.3、6.2 | 1.2 切片已实测（2026-10-24，backend-verification.md §1.2：受限/对照双跑，非 root/cap/nnp/ro-rootfs/断网全生效）；3.2/3.3/6.2 待执行 |
| P10 | project-verification / 资源限额生效 | 1.4、3.2、3.5、6.2 | 待验证；未执行 |
| P11 | project-verification / 已知失败和通过均可回查 | 1.3、2.2、3.4、6.1 | 1.3 切片已实测（已知失败/修复双跑，真实断言与退出码）；2.2/3.4/6.1 待执行 |
| P12 | project-verification / 零测试或不完整报告 | 1.3、3.4 | 1.3 切片已实测（零测试危害形态实测+精确匹配 gate 自检 6 例；发现 node 22.23「零用例文件=1 伪测试 exit 0」形态）；3.4 待执行 |
| P13 | project-verification / 长输出与分页 | 1.4、2.3、3.4、5.3、6.2 | 待验证；未执行 |
| P14 | project-verification / 验证与旧轨迹兼容 | 2.2、6.1 | 待验证；未执行 |
| P15 | project-verification / 损坏未知版本与迁移 | 2.1、2.2、2.3 | 待验证；未执行 |
| P16 | project-verification / 来源删除和只读查询 | 2.3、4.3、5.3 | 待验证；未执行 |
| P17 | project-verification / 停止后采集稳定输出 | 1.5、3.6 | 待验证；未执行 |
| P18 | project-verification / 写者未停或产物非法 | 1.5、3.6、6.2 | 待验证；未执行 |
| P19 | project-verification / 停止覆盖子孙进程 | 1.5、3.5、4.4、6.2 | 待验证；未执行 |
| P20 | project-verification / 启动故障与进程异常 | 3.4、3.5、6.2 | 待验证；未执行 |
| P21 | project-verification / 停止结果未知 | 1.6、3.5、4.4、6.2 | 待验证；未执行 |
| P22 | project-verification / 创建响应丢失与 main 崩溃 | 1.6、3.7、4.5、6.2 | 待验证；未执行 |
| P23 | project-verification / 无法确认清理 | 1.6、3.7、4.5、6.2 | 待验证；未执行 |
| P24 | project-verification / 同条件失败到通过 | 5.4、6.1、7.2 | 待验证；未执行 |
| P25 | project-verification / 条件变化或未知 | 5.4、6.5、7.2 | 待验证；未执行 |
| P26 | project-verification / 模板成功的范围 | 1.1、6.5、7.1、7.2 | 待验证；未执行 |
| W01 | workspace-isolation / 分支输入保持历史字节 | 2.4、3.3、3.6、6.1 | 待验证；未执行 |
| W02 | workspace-isolation / 不扩展文件工具或状态承诺 | 2.4、3.3 | 待验证；未执行 |
| W03 | workspace-isolation / 导出字节对应所测输入 | 5.5、6.1、7.2 | 待验证；未执行 |
| W04 | workspace-isolation / 切换检查点或附件漂移 | 5.5 | 待验证；未执行 |
| D01 | desktop-ui / 计划预览和不可用原因 | 4.3、5.1、6.3 | 待验证；未执行 |
| D02 | desktop-ui / 当前确认与计划漂移 | 4.2、5.1、6.3 | 待验证；未执行 |
| D03 | desktop-ui / 响应丢失与重复提交 | 4.1、4.2、5.2、6.3 | 待验证；未执行 |
| D04 | desktop-ui / 请求结束与测试结局分层 | 4.1、5.2、6.3 | 待验证；未执行 |
| D05 | desktop-ui / 合法停止与迟到停止 | 4.4、5.2、6.3 | 待验证；未执行 |
| D06 | desktop-ui / 非法目标不能执行停止 | 4.4、6.3 | 待验证；未执行 |
| D07 | desktop-ui / 比较原失败与修复结果 | 5.4、6.1、6.3 | 待验证；未执行 |
| D08 | desktop-ui / 结果导出不换点 | 5.5、6.1、6.3 | 待验证；未执行 |
| D09 | desktop-ui / 长日志与迟到响应 | 4.3、5.3、6.3 | 待验证；未执行 |
| D10 | desktop-ui / daemon断开与启动残留 | 4.5、5.2、6.3 | 待验证；未执行 |
| D11 | desktop-ui / 几何和键盘流程 | 5.6、6.3 | 待验证；未执行 |
| D12 | desktop-ui / 返回保留阅读和草稿 | 5.6、6.3 | 待验证；未执行 |
| M01 | desktop-ui / R3 操作复用登记且领域身份不冒充运行 | 4.1、4.2、5.2 | 待验证；未执行 |
| M02 | desktop-ui / R3 全程占槽且停止不提前解锁 | 4.2、4.5、5.2 | 待验证；未执行 |

## 既有场景与差集

两个 MODIFIED requirement 从当前主 spec 原文提取，完整保留原 6 个登记场景和 6 个占槽场景，另各加 M01/M02。实施后必须逐条运行旧回归，不能以新增场景测试代替。归档时保存合并前主 spec 基线，核对名称/正文/场景既有零丢失。

## 证据层级

- 后端：真实 Windows、本地引擎、准确版本/镜像、边界探针与残留/指纹；fake CLI 不代替。
- 包层：确定性 fixture、真实进程日志/exit、损坏/漂移/限额注入、独立输入与导出哈希。
- 桌面：真实 Electron 宽窄窗/200%/键盘，记录实际版本/尺寸/焦点及阅读返回。
- 工程：全仓 build/typecheck/tests/lint/spec、change strict 和 diff 检查；记录用例数/Errors。
- 项目：I 真实任务单列，未完成保持未知，不将受控模板提升为已有项目支持。

## 记录模板

每项填写：提交/版本、任务号、场景、输入身份/哈希、命令、期望、实际、结果、证据路径、失真与未验证范围。失败保留原始尝试；修订和复跑另记，不能覆盖失败或预填通过。
