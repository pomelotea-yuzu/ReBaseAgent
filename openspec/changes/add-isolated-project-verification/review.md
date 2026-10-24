# R3 add-isolated-project-verification 审阅

> 日期：2026-10-24
> 审阅对象：proposal.md / design.md / prototype.md / tasks.md / evidence-index.md / specs 三份 delta（提案完成、0/36 任务、实现未开始状态）
> 结论：整体质量高，可进入阶段 1 技术验证。无阻塞性问题；1 项低-中建议实施前决策（P1），其余为低/微备注。
> 后续处理：2026-10-24 已按用户指示依审阅意见修订 change（P1–P3、P5、P6 采纳，P4 依 U1-P5 先例维持现状），落点见第四节；第一至三节保留为修订前审阅记录，不构成实施验收证据。

## 一、核对项

### 1. OpenSpec 校验

`openspec validate add-isolated-project-verification --strict` 通过（输出 valid）。

### 2. MODIFIED requirement 完整性

两条被修改 requirement 均携带完整最终文本，既有场景逐字保留（与主 spec 原文逐段比对）：

| Requirement | 主 spec 场景 | delta 场景 | 既有场景保留 |
|---|---|---|---|
| 主动执行由 main 会话身份登记和去重 | 6 | 7 | 保留。正文仅在第 1 段登记枚举插入"、R3 环境准备/项目验证"，第 2 段不动，新增第 3 段领域身份规则；新增 M01 |
| main 原子执行槽覆盖所有主动编排 | 6 | 7 | 保留。原段逐字不动，新增 R3 占槽/定向停止/启动互斥一段；新增 M02 |

evidence-index 所称"完整保留原 6+6 场景"属实。桌面 `desktop-distribution` 等其他 capability 不受本 delta 影响。

### 3. 场景编号三向一致

tasks.md ↔ evidence-index.md ↔ specs/*.md 的 P01–P26、W01–W04、D01–D12、M01–M02（共 44 个）经程序化集合比对完全相等，无孤儿编号、无未映射任务。

### 4. 事实性声明抽查（均属实）

- R1 配额数字与 workspace-isolation 主 spec 逐项一致：2000 文件 / 单文件 8 MiB / 快照 64 MiB / 新增唯一内容 128 MiB / 路径 512 / 深度 32（spec.md:74）。
- `locateWorkspaceSnapshot` 确在 `@rebaseagent/replay` 导出；源码证实"省略 stepSpanId 取 initial 快照、自有 agent.step 才有检查点、祖先/非 step/缺检查点均拒绝"（read-api.ts locateSnapshotInRun）。design D1 的现状描述与"新接口必须显式选择"的理由成立，delta selector（`{kind:"initial"}|{kind:"step",stepSpanId}`）与之同构。
- v2/v3 trace 口径与 trace-sdk/src/schema.ts 一致（v3＝隔离 prompt 实验）；proposal"不把测试作为 trace v4"与之相容。
- 引用文档可解析：evolution-roadmap §6（R3 运行测试和构建）、§11（执行顺序）、能力细化稿 §6 均为对应章节；"I"定义在 roadmap §2 里程碑表与 §3.2。
- 仓库布局与 Impact 相符：桌面在 apps/desktop；packages/ 现有 7 包，新增 `project-verification` 命名一致。
- "约 800 CSS px、200% 缩放"口径与 desktop-ui 主 spec 既有 3 处使用一致。
- 设计基线 `3d207eb`（2026-10-24）提交存在。

## 二、问题与建议

### P1（低-中）：单 change 体量与阶段 1 假设风险的销账节点

36 项、估时约 60h，为仓库史上最大 change（此前最大 13 项）；第 2–5 组全部以阶段 1 待冻结论（digest、非 root 物化、静止采集、停止/重启核查）为前提。缓解已内置：阶段 1 是硬门槛、"未通过不开放"、"发现设计不成立先修 proposal/design/spec"。建议不拆 change（跨 change 双重簿记成本更高），但把 1.1–1.6 的探针产物（backend-verification.md）作为独立提交节点尽早落库——阶段 1 失败时以最小代价冻结后续组并走提案修订，避免探针结论散在本地。

### P2（低）：基线指针已漂移

design D1 基线 `3d207eb`；本审阅当日 add-mcp-to-release-zip 归档（`52c8a6a`）向 desktop-distribution spec 增 1 条 requirement。已复核：不影响本 change 三个 capability 的 delta 完整性。实施启动时应更新基线引用至届时 HEAD，归档差集核对以届时主 spec 为准。

### P3（低）：部分单项 2h 估计偏紧

3.3（物化拒绝矩阵：穿越/链接/特殊对象/碰撞/配额 × 多条目）、4.5（启动互斥核查 + 分层可用性）、6.2（9 个 P 编号的故障注入回归）最可能触发"超时须先拆分"条款。建议预先按拒绝类别（3.3）和 P 编号组（6.2）拆子任务，避免实施中途拆分打断证据链。

### P4（微）："七类主动入口"标题与增补后正文枚举计数不一致

MODIFIED 登记要求正文枚举已含 R3 准备/验证（共 9 类），scenario 标题仍为"七类主动入口均绑定身份"，其 WHEN 只列旧七类。M01 承接 R3 侧绑定，语义无缺口；保留原标题利于差集零噪音（同 U1-P5 先例），仅提示归档后主 spec 将出现标题计数与正文枚举不一致的措辞张力。可接受现状，或把标题改为"主动入口均绑定身份"。

### P5（微）：`verification:capability` 的引擎健康检查建议枚举允许的 docker 子命令

D3 表允许"有限 inspect/version"，D1 已约束 CLI 可信绝对路径与 shell:false。P02/P03 已定义行为边界；建议实施 4.3 时把允许的 docker 子命令（如 version/info）显式写入 schema 白名单断言，防止"健康检查"漂移为任意 CLI 透传。

### P6（微）：术语"I"未在 change 内展开

"I"（真实项目接入 persona）定义在 evolution-roadmap §2/§3.2，proposal 已链接该文档、跟随可解析。建议 tasks §7 标题旁加半句括注（如"I＝路线 §3.2 真实项目接入"），降低新读者成本；不改也不阻塞。

## 三、亮点

- 状态诚实性纪律贯穿全链路：所有文档标注"仅提案/待验证"，evidence-index 明示"文档/strict 校验通过不代表功能、隔离或实机验收通过"，P26 把模板成功与真实项目支持显式分开——防"冒进宣称"的口径在提案层写死。
- 停止/结局语义（design D6 九行表）与 P19–P23、M02 一一对应；"settled≠passed、stopping≠cancelled、更晚 exit 0 不得覆盖取消/超时/OOM"的分层在 spec、任务、原型三处一致，无互相矛盾的措辞。
- 资源先登记后创建、确定性唯一命名覆盖 create 响应丢失窗口（D4 + P22），恢复日志与"registry 仅存 main 内存"的既有契约明确切分——正面堵住了断连/崩溃类问题最隐蔽的窗口。
- 安全边界成体系：固定 digest、cap-drop ALL、no-new-privileges、网络 none、无宿主挂载/凭据继承、日志按不可信文本处理、renderer 不得输入命令/路径/环境/镜像——与仓库既有"渲染层不可信"的 IPC 纪律同构。
- 保真度边界一节把"R1 副本不恢复权限/可执行位/链接/空目录、模板不得依赖这些状态"写进提案，避免了测试环境验证最容易被过度宣称的维度。

## 四、审阅后修订记录（2026-10-24）

本节记录提案修订，不改写原审阅结论，也不作为实施验收证据。

| 意见 | 处理与落点 |
|---|---|
| P1 | 采纳：不拆 change；tasks.md 状态段增补"1.1–1.6 探针产物（backend-verification.md 与结论）作为独立提交节点尽早落库，任一门槛未过即冻结第 2–6 组并先修提案"。 |
| P2 | 采纳：design.md D1 基线更新为 `52c8a6a`，注明较 `3d207eb` 仅并入一条 desktop-distribution requirement、与本 change 三个 capability 无交集。 |
| P3 | 采纳：tasks.md 3.3/4.5/6.2 预置拆分点备注（3.3 按拒绝类别三段、4.5 按核查/分层两段、6.2 按 P 编号组），状态段说明拆分不改编号与 evidence-index 映射。 |
| P4 | 维持现状（U1-P5 先例）：scenario 标题保留"七类主动入口均绑定身份"，R3 侧由 M01 承接；evidence-index"名称/正文/场景零丢失"承诺不变。 |
| P5 | 采纳：design.md D3 与 tasks.md 4.3 增补"capability 引擎健康仅使用枚举的只读 docker 子命令（version/info 类），由 schema 白名单断言，不透传任意参数"。 |
| P6 | 采纳：proposal.md 验收口径与 tasks.md §7 标题补 I 定义括注（真实项目接入，见路线 §3.2）。 |
