# U6 evidence-index：场景 → 证据逐行索引

> **范围**：delta（`specs/desktop-ui/spec.md`）全量 **47 条场景（37 ADDED / 10 MODIFIED）**，覆盖 4 条
> requirement（3 ADDED + 1 MODIFIED）。逐行列出：既有单元/契约证据引用、实机/契约验证入口（批次）、当前状态。
>
> **状态口径**：`待验证`（初始，6.2 建立索引时的诚实起点）→ `已交付`（对应批次的判据真的跑过且绿）→
> `实机不成立`（真机无注入面，按单元/集成层承载并注明）。状态翻转发生在 6.3–6.9 各批；本索引随 change 归档。
>
> **引用格式**：`` `文件 › 用例名` `` —— 用例名逐字取自 `it(...)` 第一参数，回查脚本
> `.workbuddy/u6/u6-61/verify-scenario-checklist.cjs` 按点名的那个文件核（含 `--selftest` 反例：
> 漏行 / 虚构场景 / 假用例名 / 假文件 / 标题真实但挂错文件 / 半截引用）。

汇总口径：**47 条场景（37 ADDED / 10 MODIFIED）**，已交付 **40** 条、待验证 **7** 条、实机不成立 **0** 条

### A1. 详情完整性在缺祖先文件时结构化降级（ADDED，22 场景）

| n | 场景 | 用例 | 入口/批次 | 状态 |
|---|---|---|---|---|
| 1 | 普通 result 的完整父链仍合并 | `u6-lineage-read.test.ts › 1.1 完整 v1 父链 → complete:true，记录按根到叶排列` + `u6-detail-project.test.ts › 纯 result 链不受投影改造影响：resolveBranch 既有行为逐 id 不变（对照「普通 result 的完整父链仍合并」）` | 6.9 实机完整链回归（v1 普通 fork 子 complete/resolved、父分叉点前缀合并、链两跳） | 已交付（6.9 实机） |
| 2 | 根 run 以自有轨迹返回 | `u6-detail-contract.test.ts › 2.1 complete/own（根 run）：chain 单跳即根，空 spans + 空 leafSpanIds 合法` | 6.9 实机（夹具根 run：chain 单跳即根、spanScope=own、complete） | 已交付（6.9 实机） |
| 3 | 普通 result 缺祖先只读当前记录 | `u6-detail-project.test.ts › 直接缺父：只读当前已校验自有记录，chain 只剩当前 run` + `u6-lineage-read.test.ts › 普通 result 缺祖先 → 结构化 ownOnly（U6 §3.2 起生效；missingRunId 受校验）` | 6.4 实机（注入=ancestorMissing） | 已交付（6.4 实机） |
| 4 | 普通 result 的隔代祖先缺失 | `u6-detail-project.test.ts › 3.3 隔代缺失：chain 保留当前与直接父，spans 不混入中间祖先轨迹` + `u6-lineage-read.test.ts › 1.1 隔代祖先缺失 → 链保留当前与直接父，missingRunId 是隔代` | 6.4 实机（注入=ancestorMissing） | 已交付（6.4 实机） |
| 5 | prompt、代理和 model_params 的自有范围不等于降级 | `u6-detail-project.test.ts › 3.4 完整父链的 prompt fork：只展示自有 spans，父轨迹不进时间线` + `u6-detail-project.test.ts › 3.6 model_params 臂（完整链）：独立自有轨迹，不再误合并父前缀` | 6.5 实机 | 已交付（6.5 实机） |
| 6 | 独立轨迹缺祖先也返回结构化 ownOnly | `u6-detail-project.test.ts › 3.4 prompt fork 缺祖先：从头轨迹语义不变，不补父 spans，父缺失原因可见` + `u6-detail-project.test.ts › 3.5 proxy fork 缺祖先：保留本次自有事实，缺失原因可见，不借用其他 proxy 记录` + `u6-detail-project.test.ts › 3.6 model_params 臂缺祖先：ownOnly，不算可比较结果，不补父历史` | 6.5 实机（注入=ancestorMissing） | 已交付（6.5 实机） |
| 7 | prompt fork 缺祖先不改变从头轨迹 | `u6-detail-project.test.ts › 3.4 prompt fork 缺祖先：从头轨迹语义不变，不补父 spans，父缺失原因可见` | 6.5 实机（注入=ancestorMissing） | 已交付（6.5 实机） |
| 8 | proxy fork 缺祖先不借用代理记录 | `u6-detail-project.test.ts › 3.5 proxy fork 缺祖先：保留本次自有事实，缺失原因可见，不借用其他 proxy 记录` | 6.5 实机（注入=ancestorMissing） | 已交付（6.5 实机） |
| 9 | model_params 臂缺祖先不变成可比较结果 | `u6-detail-project.test.ts › 3.6 model_params 臂缺祖先：ownOnly，不算可比较结果，不补父历史` | 6.5 实机（注入=ancestorMissing） | 已交付（6.5 实机） |
| 10 | 当前文件或祖先不是可确认的缺失 | `u6-lineage-read.test.ts › 1.1 当前文件缺失 → CURRENT_RUN_NOT_FOUND，原因受控（对应「当前文件或祖先不是可确认的缺失」）` + `u6-lineage-faults.test.ts › currentMissing ⇒ 读取直接失败（缺当前文件不返回 ownOnly）` | 6.6 实机（注入=currentMissing） | 已交付（6.6 实机） |
| 11 | 祖先文件损坏不降级 | `u6-lineage-read.test.ts › 1.2 祖先 JSONL 损坏 → ANCESTOR_INVALID 严格失败，不降级（对应「祖先文件损坏不降级」）` + `u6-lineage-faults.test.ts › ancestorCorrupt ⇒ 严格失败不降级 ownOnly（受控中文，不透传路径）` | 6.6 实机（注入=ancestorCorrupt） | 已交付（6.6 实机） |
| 12 | 未来版本祖先不降级 | `u6-lineage-read.test.ts › 1.3 未来版本祖先 → 版本守卫拒绝，不是缺失（对应「未来版本祖先不降级」）` + `u6-lineage-faults.test.ts › ancestorFutureVersion ⇒ 版本守卫拒绝，schema 转换前失败` | 6.6 实机（注入=ancestorFutureVersion） | 已交付（6.6 实机） |
| 13 | v1 祖先携带隔离字段不降级 | `u6-lineage-read.test.ts › 1.3 v1 祖先私带隔离字段（meta/fork/span 三处，值 null/空对象也算存在）→ 守卫失败而非缺失` | 6.9 实机（ancestorV1IsolationField 注入：getRun 严格失败不降级、不透传路径，还原后重读 complete——实机与单元同形） | 已交付（6.9 实机） |
| 14 | 祖先链成环不降级 | `u6-lineage-read.test.ts › 1.5 祖先链成环 → LINEAGE_CYCLE 终止，不死循环不截断（对应「祖先链成环不降级」）` + `u6-lineage-faults.test.ts › lineageCycle ⇒ 成环严格失败，不截断成 ownOnly` | 6.6 实机（注入=lineageCycle） | 已交付（6.6 实机） |
| 15 | fork 定位非法不降级 | `u6-lineage-read.test.ts › 1.5 v2 整轮边界不在可读直接父自有记录、隔代缺失 → FORK_INVALID 优先（对应「fork 定位非法不降级」）` + `u6-lineage-faults.test.ts › forkInvalid ⇒ at_span 不属于父轨迹 ⇒ 定位非法失败` | 6.6 实机（注入=forkInvalid） | 已交付（6.6 实机） |
| 16 | 父文件恢复后重试全量重验 | `u6-detail-project.test.ts › ownOnly → 恢复父文件 → complete；恢复的是损坏文件 → 仍失败，不缓存旧结论` + `u6-lineage-faults.test.ts › ancestorMissing ⇒ 结构化 ownOnly；还原（父文件恢复）后重读 ⇒ complete/resolved` + `u6-exec-source-gate.test.ts › 5.10 来源拒绝后恢复父文件：同 ID 只命中判重不复活；新 ID 重检后可执行` | 6.6 实机（注入=ancestorMissing 后还原） | 已交付（6.6 实机） |
| 17 | 读取重试不改变阅读位置 | `u6-detail-refresh-guard.test.ts › 重试在飞期间选择别的调用 ⇒ 落地不覆盖新阅读位置` + `u6-detail-refresh-guard.test.ts › 重试在飞期间换页签 ⇒ 落地落在用户新页签上` + `u6-detail-refresh-guard.test.ts › 恢复前的 ownOnly 旧响应后到 ⇒ 不覆盖恢复后的 complete 详情` | 6.7 实机（ownOnly→恢复→complete 三态切换中阅读位置保持；**在飞交叠半边真机无延时注入面 ⇒ 单元承载**） | 已交付（6.7 实机） |
| 18 | 详情完整性字段拒绝错配 | `u6-detail-contract.test.ts › 缺省 completeness 整份拒绝（不允许静默缺省）` + `u6-detail-contract.test.ts › 未知枚举由 schema 拒绝（不能借未知字段剥离接受错配）` + `u6-detail-contract.test.ts › 2.5 U5 后台核实入口对错配载荷返回失败（verifyResultPayload 不放宽）` | —（schema/main 自检/renderer 守卫三层全单元承载；错配载荷无实机注入面：桥接面只回真 main 产出） | 待验证 |
| 19 | 文件身份与路径不能伪造来源 | `u6-lineage-read.test.ts › 1.4 非法请求标识在任何 fs 访问之前拒绝（对应「文件身份与路径不能伪造来源」的路径半边）` + `u6-lineage-read.test.ts › 1.4 祖先 meta.id 与文件名不符 → 拒绝详情，不从错误正文猜缺失 ID` + `u6-lineage-read.test.ts › 非法 run id → 抛受控原因（getRun 与 loadRunRecord 两处都在 fs 之前拒绝）` | —（路径伪造在真机只能经 UI 输入 run id，桌面无该输入面；单元层注入计数已证零 fs 访问） | 待验证 |
| 20 | 已知无效关系不能被更早缺失遮蔽 | `u6-lineage-read.test.ts › 1.5 可读 hop 缺 fork 且更早祖先缺失 → FORK_INVALID 优先于缺失（对应「已知无效关系不能被更早缺失遮蔽」）` + `u6-lineage-read.test.ts › 1.5 祖先未封存且隔代缺失 → 严格失败而非 ownOnly（未封存不能被缺失遮蔽）` | 6.6 实机（注入=lineageCycle 与缺失叠加） | 已交付（6.6 实机） |
| 21 | 合法零 span 记录可部分读取 | `u6-detail-project.test.ts › 合法零 span 记录：空数组不当损坏，自有事件照常保留` + `u6-lineage-read.test.ts › 1.1 合法零 span 当前记录 + 祖先缺失 → 结构化缺失，空数组不当损坏（对照「合法零 span 记录可部分读取」分类半边）` | 6.4 实机 | 待验证 |
| 22 | 读取诊断不泄漏路径和正文 | `u6-lineage-read.test.ts › 1.1 当前文件缺失 → CURRENT_RUN_NOT_FOUND，原因受控（对应「当前文件或祖先不是可确认的缺失」）` + `u6-exec-source-gate.test.ts › 祖先缺失 ⇒ RUN_LINEAGE_INCOMPLETE 并携带受校验的 missingRunId`（该用例断言无盘符/无 traces 路径） | 6.6 实机已覆盖（ancestor-error-gates：诊断不透传盘符/traces 路径 + UI 失败横幅不泄漏盘符，截屏在场）| 已交付（6.6 实机，记账补翻） |

### A2. 运行详情的来源完整性控制主动执行（ADDED，10 场景）

| n | 场景 | 用例 | 入口/批次 | 状态 |
|---|---|---|---|---|
| 23 | ownOnly result 不可重跑 | `u6-exec-source-gate.test.ts › 父文件消失 ⇒ RUN_LINEAGE_INCOMPLETE：settled/rejected 回执 + runIds 空 + 零模型调用 + 零新 trace` | 6.3 变异（摘 execForkRun 门禁须红）+ 6.4 实机 | 待验证 |
| 24 | ownOnly prompt、代理和实验臂不执行 | `u6-exec-source-gate.test.ts › ownOnly prompt 父本 ⇒ RUN_LINEAGE_INCOMPLETE，零模型调用` + `u6-exec-source-gate.test.ts › ownOnly 父本 ⇒ RUN_LINEAGE_INCOMPLETE，代理 fork 零调用` + `u6-exec-source-gate.test.ts › ownOnly 父本 ⇒ RUN_LINEAGE_INCOMPLETE：零臂身份、零模型调用` | 6.3 变异（摘 prompt/proxy/modelAb 门禁须红）+ 6.5 实机 | 已交付（6.5 实机） |
| 25 | ownOnly 隔离 result 不消费副本授权 | `u6-exec-source-gate.test.ts › ownOnly 隔离父本 + 合法 allowFileWrites 请求 ⇒ RUN_LINEAGE_INCOMPLETE，无副本世界/trace 创建` | 6.3 变异 + 6.4 实机 | 待验证 |
| 26 | ownOnly model_params dry-run 保持只读 | `u6-exec-source-gate.test.ts › ownOnly 父本 ⇒ RUN_LINEAGE_INCOMPLETE：无计划、零网络、登记仍为空` + `u6-exec-source-gate.test.ts › 正对照：完整父本的 dry-run 计划可用且不产生登记、零模型调用` | 6.3 变异 + 6.5 实机 | 已交付（6.5 实机） |
| 27 | 读取重试与执行严格分离 | `u6-partial-result-closure.test.ts › 不可读 → ownOnly 正常：重试后按原关联清理；全程零执行通道、不换选中项` + `u6-partial-result-closure.test.ts › store：详情落地 ownOnly ⇒ canExecuteFromSource false；complete ⇒ true` | 6.7 实机（面板「重读」按钮 → 仅 runs:get：零执行/零新 trace/不换选中项；ownOnly ⇒ canExecuteFromSource false，complete 对照 true） | 已交付（6.7 实机） |
| 28 | 详情加载失败在执行入口即拒绝 | `u6-exec-source-gate.test.ts › 当前文件损坏 ⇒ RUN_DETAIL_UNREADABLE（缺失不掩盖损坏，missingRunId 为 null）` + `u6-exec-source-gate.test.ts › 父文件损坏 ⇒ RUN_DETAIL_UNREADABLE（严格失败不降级）` | 6.3 变异 + 6.6 实机（注入=ancestorCorrupt） | 已交付（6.6 实机） |
| 29 | 父链恢复不复活已拒绝操作 | `u6-exec-source-gate.test.ts › 5.10 来源拒绝后恢复父文件：同 ID 只命中判重不复活；新 ID 重检后可执行` | 6.3 + 6.6 实机 | 待验证 |
| 30 | 预检后父链变化仍由 main 拒绝 | `u6-exec-source-gate.test.ts › 5.9 直调端点（绕过 UI）：main 现读磁盘——预检通过后父文件消失仍拒绝` + `u6-partial-result-closure.test.ts › 执行响应以来源类稳定码拒绝 ⇒ 撤销并清空确认；其他错误码不撤销` | 6.3 + 6.6 实机 | 待验证 |
| 31 | 隔离 capability 对不完整来源明确拒绝 | `isolated-desktop-flows.test.ts › 根 trace 消失 ⇒ capability 以 RUN_LINEAGE_INCOMPLETE 拒绝（不授予许可、不写文件）` + `isolated-desktop-flows.test.ts › 正对照：根在场时二次分叉父本的 capability 照常给出` | 6.3 变异 + 6.5 实机 | 已交付（6.5 实机） |
| 32 | 无父本创建和被动录制保持原契约 | `u6-exec-source-gate.test.ts › 5.11 无父本的普通 create 不受已存在的 ownOnly run 阻断` | 6.5 实机（ownOnly 在场时创建照常） | 已交付（6.5 实机） |

### A3. 部分详情沿用自有结果核实与草稿收尾（ADDED，5 场景）

| n | 场景 | 用例 | 入口/批次 | 状态 |
|---|---|---|---|---|
| 33 | ownOnly 正常结果仍按原修订清理 | `u6-partial-result-closure.test.ts › ownOnly + 自有 stopped/completed ⇒ 进入原 U5 清理；读取项携带来源缺失` + `u6-partial-result-closure.test.ts › 面板同一行显示自有结局与来源警告：正常结束不被读成可重跑` | 6.7 实机（UI fork 提交 → 竞速隐藏父本 → 自动核实 ownOnly+正常 ⇒ 按原修订清理 + 面板行同屏「已结束 + 不等于可以重跑」） | 已交付（6.7 实机） |
| 34 | ownOnly 失败定位只使用自有调用 | `u6-partial-result-closure.test.ts › ownOnly + 自有 error 终止 ⇒ 保留草稿；定位给自有失败调用（不取祖先）` + `u6-partial-result-closure.test.ts › ownOnly + error 终止但无自有失败详情 ⇒ 诚实说明，不给定位入口` | 6.7 实机（受控 503 错误子 run + 父本隐藏 ⇒ 保留草稿 + 定位 = 自有失败 span + 面板「查看失败调用」跳自有 span；**「error 但无自有失败详情」半边受控失败必落自有 llm.call.error，真机造不出 ⇒ store 集成承载**） | 已交付（6.7 实机） |
| 35 | 部分实验结果保留完整批次判据 | `u6-partial-result-closure.test.ts › 两臂均为 ownOnly 正常终止 ⇒ 整批照常清理（ownOnly 不另设门槛）` + `u6-partial-result-closure.test.ts › 缺臂 / null ID / 不可读臂任一存在 ⇒ 整批保留，不推断胜出臂` | 6.7 实机（A/B UI 两批：[ok,ok] 两臂 ownOnly 正常 ⇒ 整批清理；[ok,fail] 两臂 ownOnly + 错误臂 ⇒ 整批保留；**缺臂/null ID/不可读臂真机不可达（main 收尾每臂必带 id、逐臂独立读取）⇒ store 集成承载**） | 已交付（6.7 实机） |
| 36 | 后台重试不导航也不重发执行 | `u6-partial-result-closure.test.ts › 不可读 → ownOnly 正常：重试后按原关联清理；全程零执行通道、不换选中项` + `u6-partial-result-closure.test.ts › 重试前草稿已推进新修订 ⇒ 不被删除（无关联/修订不匹配不猜草稿）` | 6.7 实机（两支：不可读首读 → ownOnly 正常重试清理 + 零执行/不导航；修订推进后 ownOnly 正常重试不清新修订） | 已交付（6.7 实机） |
| 37 | 部分详情提示和恢复动作可达 | `u6-detail-ui-completeness.test.ts › 缺失 ID 以 break-all 呈现（窄窗/200% 下长 ID 换行不断版）` + `u6-detail-ui-completeness.test.ts › 复制动作是真按钮：带 aria-label（读屏可辨）且文案明确` | 6.8 实机（**已交付**：1440/1024/800 三档 + 独立 200%（DPR 4.2）+ 真键盘（keybd_event Tab/Enter/Shift+Tab）——提示块在场、缺失 ID break-all 不断版（页面/块双零横向溢出）、复制按钮 aria 带完整缺失 ID 且真 Enter 后剪贴板=完整 ID、禁用原因行（键入 Monaco 后判来源原因）、重读落地仍 ownOnly 不改阅读位置） | 已交付（6.8 实机） |

### M1. 分支 run 展示解析后的完整轨迹（MODIFIED，10 场景）

| n | 场景 | 用例 | 入口/批次 | 状态 |
|---|---|---|---|---|
| 38 | 分支 run 的轨迹 | `u6-detail-project.test.ts › 纯 result 链不受投影改造影响：resolveBranch 既有行为逐 id 不变（对照「普通 result 的完整父链仍合并」）` + `u6-lineage-read.test.ts › 完整链详情与既有语义一致（回归：resolveBranch 经单次上下文的缓存 loader）` | 6.9 实机（v1 普通 fork 子：complete/resolved、父分叉点前缀合并 + 自有重放、链两跳） | 已交付（6.9 实机） |
| 39 | 完整独立分支不拼接父轨迹 | `u6-detail-project.test.ts › 3.4 完整父链的 prompt fork：只展示自有 spans，父轨迹不进时间线` + `u6-detail-project.test.ts › 3.6 model_params 臂（完整链）：独立自有轨迹，不再误合并父前缀` | 6.9 实机（prompt fork 子：spanScope=own、详情 span 集=自有 trace 文件集——父轨迹零拼接、链两跳溯源） | 已交付（6.9 实机） |
| 40 | 部分普通分支不伪造共享前缀 | `u6-detail-ui-completeness.test.ts › ownOnly result 分支：固定提示 + 缺失 ID，且**不出现**「共享前缀」措辞` + `u6-detail-ui-completeness.test.ts › ownOnly result 分支：关系说明不再声称共享前缀，缺失说明带缺失 run ID` | 6.4 实机 | 已交付（6.4 实机） |
| 41 | 部分来源链首项不冒充根 | `u6-detail-ui-completeness.test.ts › ownOnly ⇒ 明确标为截断链（首项不是根 run）` + `u6-detail-ui-completeness.test.ts › ownOnly 首项 parent 非 null ⇒ 链被截断（首项不是根）` | 6.4 实机（隔代缺失标本） | 已交付（6.4 实机） |
| 42 | 完整普通分支保留被编辑字段 | `u6-detail-project.test.ts › 纯 result 链不受投影改造影响：resolveBranch 既有行为逐 id 不变（对照「普通 result 的完整父链仍合并」）` + `u6-detail-ui-completeness.test.ts › ownOnly 分支保留分叉点与被编辑字段标注（记录元数据不因祖先缺失消失）` | 6.9 实机（来源区/分支说明带分叉点 s_03 与编辑字段 result 标注） | 已交付（6.9 实机） |
| 43 | 独立分支来源链完整但不共享执行前缀 | `u6-detail-project.test.ts › 3.4 完整父链的 prompt fork：只展示自有 spans，父轨迹不进时间线` + `u6-detail-ui-completeness.test.ts › ownOnly 独立分支：独立执行措辞保留，缺失说明单独出现` | 6.9 实机（同 #39：链完整溯源两跳但详情 span 集=自有文件，执行前缀零共享） | 已交付（6.9 实机） |
| 44 | ownOnly 文件入口不显示祖先检查点 | `u6-file-entry-ownonly.test.ts › 祖先 step 即使出现在 spans 里也不进选择器（leafSpanIds 界定自有段）` + `u6-file-entry-ownonly.test.ts › 没有自有完成步骤 ⇒ 默认落初始状态（初始快照仍是本 run 的，不是祖先的）` | 6.4 实机 | 已交付（6.4 实机） |
| 45 | 完整隔离 result 保留整轮前缀 | `u6-detail-project.test.ts › 完整隔离链：complete/resolved + 完整 lineage，v2 整轮前缀保留（含恢复点整轮的兄弟工具）` + `u6-detail-project.test.ts › 隔离 result 直接父缺失：ownOnly，missingRunId 是直接父` | 6.9 实机（v2 隔离链：complete/resolved + 父整轮前缀在场（含兄弟工具）+ 自有重放在场 + 链两跳） | 已交付（6.9 实机） |
| 46 | 混合父链不跨独立边界拼接 | `u6-detail-project.test.ts › result 的父是 prompt fork：不跨独立边界拼接（root 轨迹不进 result 时间线），chain 溯源不断` + `u6-detail-project.test.ts › 未知 edit.field：明确拒绝，不默认按 result 拼接` | 6.9 实机（normalRun→promptChild→mixedChild 三跳：详情 span 集 ⊆ 独立父文件 ∪ 自有文件、root 独有 id 零泄漏、自有重放全在场） | 已交付（6.9 实机） |
| 47 | 缺祖先与缺附件分别诊断 | `u6-file-entry-ownonly.test.ts › 附件缺失走原附件错误文案，不提祖先/父链` + `u6-file-entry-ownonly.test.ts › 来源完整性提示与附件诊断是两套文案（互不冒充）` | 6.4 实机 | 已交付（6.4 实机） |
