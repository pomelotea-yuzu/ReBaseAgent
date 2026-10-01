# U8 evidence-index：场景 → 证据逐行索引

> **范围**：两份 delta（`specs/desktop-ui/spec.md` 51 条、`specs/model-experiments/spec.md` 16 条）
> 全量 **67 条场景（保留旧场景 20 / 新场景 47；MODIFIED 块内 31 + ADDED 36）**，
> 覆盖 12 条 requirement（desktop-ui 3 MODIFIED + 6 ADDED；model-experiments 2 MODIFIED + 1 ADDED）。
> 逐行列出：任务映射、既有单元/契约证据引用、实机入口（批次）、当前状态。
>
> **状态口径**：`待验证`（1.1 建立索引时的诚实起点——即便引用了既有单元证据，对应实机批次尚未执行、
> 迁移后形态尚未回归）→ `已交付`（对应批次的判据真的跑过且绿）→ `实机不成立`
> （真机无注入面，按单元/集成层承载并注明）。状态翻转发生在 6.3–6.11 各批；本索引随 change 归档。
> **未知不得填已完成。** 既有用例被迁移合法改判时，两边留痕（测试注释 + tasks 注记）。
>
> **引用格式**：`` `文件 › 用例名` `` —— 用例名逐字取自 `it(...)` 第一参数（无斜杠前缀 =
> `apps/desktop/test/` 下文件；含 `/` = 仓库相对路径）。由 `.workbuddy/u8/u8-11/verify-scenario-checklist.cjs`
> 逐条核对（文件存在 + 用例名在场 + 场景名逐字在 delta + 任务引用真实），含 `--selftest` 反例。
> 标注「2.x 落地后补」的行 = 该行为尚不存在、无既有证据可引（诚实留白，不造弱用例凑数）。

汇总口径：**67 条场景（保留 20 / 新 47）**，已交付 **54** 条、待验证 **12** 条、实机不成立 **1** 条（行 6；6.6 交付 13 行、6.7 交付 11 行、6.8 交付 4 行、6.9 交付 16 行、6.10 交付 2 行、6.11 交付 4 行；6.12 前回填翻转 4 行 = #26/#60/#65/#67，并回填全部「落地后补」占位为真实用例名）。剩余 12 条待验证：#7/#11/#14/#15/#16/#17/#18/#19/#33/#35/#36/#51——全部指派 6.12 实机批。

---

## 一、desktop-ui delta（51 条）

### DU1. 代理设置与运行状态可观测可控（MODIFIED，7 场景）

| n | 场景 | 保留/新 | 任务 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|---|---|
| 1 | 启用代理 | 保留 | 1.4, 6.6 | `settings.test.ts › 无文件 → loadProxy 返回默认值；saveProxy 后可读回`（main 侧持久化；UI 迁工作区后 2.7/2.10 复核） | 6.6 实机 | 已交付（6.6 实机） |
| 2 | 端口占用可见 | 保留 | 2.5, 6.1, 6.6 | main 事实：`toggle` 先保存后启停、启动失败可 enabled=true/running=false（源码锚点 proxy-manager.ts L98–106，review 已核实） + `recording-draft-store.test.ts › 「端口占用可见」：toggle 失败 + 回读成功 ⇒ 保留输入与诊断，已保存/监听事实分层可辨`（2.5 回填） | 6.1 注入 + 6.6 实机 | 已交付（6.3 反证 + 6.6 实机：PROXY_START_FAILED 分层呈现） |
| 3 | key 捕获状态 | 保留 | 2.7 | `controlled-proxy.test.ts › 未捕获 key 时分叉 → PROXY_NO_KEY，且受控服务零请求（门禁在联网之前）` + `recording-workspace-view.test.tsx › running+hasKey ⇒ 三层事实分行可辨；未监听 ⇒ 明说启用不等于监听成功`（2.7 回填） | 6.6 实机 | 已交付（6.6 实机） |
| 4 | 接入地址只来自已核实监听 | 新 | 2.8, 6.3 | main 构造地址事实（proxy-manager.ts L124，review 已核实） + `recording-workspace-view.test.tsx › running ⇒ 地址由真实端口构造且可复制；复制零测试请求的说明在场` + `recording-workspace-view.test.tsx › 未监听 / 读取未知 ⇒ 地址不可复制（不提供草稿端口的假地址）`（2.8 回填） | 6.3 反证 + 6.6 实机 | 已交付（6.3 反证 + 6.6 实机） |
| 5 | 停止或未知状态撤销地址 | 新 | 2.7 | `recording-workspace-view.test.tsx › 应用在飞 ⇒ 地址撤销（应用结束并核实监听后才可复制）`（撤销呈现半边；停止/未知态不可复制由同文件「未监听 / 读取未知 ⇒ 地址不可复制」用例承载，2.7 回填） | 6.6 实机 | 已交付（6.6 实机） |
| 6 | 应用失败回读也失败保留输入 | 新 | 2.5, 6.1, 6.6 | `recording-draft-store.test.ts › 「应用失败回读也失败保留输入」：两层诊断 + 状态待读取 + 只读重试不重新 toggle`（2.5 回填）；main 非事务事实见 n2 | 6.1 注入 + 6.6 实机 | 实机不成立（6.1 探明：proxy:status handler 恒 ok + loadProxy 全容错 ⇒ 错误信封真机不可达；按 recording-draft-store 单元承载，6.6 探针登记） |
| 7 | 代理应用沿用配置互斥 | 新 | 2.4, 6.6 | `config-gate.test.ts › 主动操作占槽时：save/clear 被拒、配置文件字节不变、registry 不被写入` + `entry-gate.test.ts › deriveConfigGate 与提交门禁同源：空闲放行、有操作在跑/未握手/未知都拒写` | 6.6 实机 | 待验证 |

### DU2. 代理 run 的 llm.call 可编辑 messages 重发（MODIFIED，6 场景）

| n | 场景 | 保留/新 | 任务 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|---|---|
| 8 | 编辑并重发成功 | 保留 | 5.3 | `exec-prompt-proxy.test.ts › 成功：登记身份 = 本次 fork 返回的 id，目标只带定位事实不带 messages` + `controlled-proxy.test.ts › 外部非流式请求 JSON 直通 + 编辑 messages 分叉按 stream:true 重发：受控日志两种模式、fork run 落盘、父不改写` | 6.9 实机 | 已交付（6.9 实机） |
| 9 | 未修改禁用 | 保留 | 5.1, 6.9 | `exec-prompt-proxy.test.ts › PROXY_* 拒绝（未捕获 key / 空 fork）：settled + 原稳定码 + 零身份，且重复不重试消费`（main 空 fork 防线） + `prompt-messages-editor-draft.test.ts › U8 5.1b：工作区形态参数在场（目标作用域源可用性覆盖 + 常开无收起）`（unchanged 禁用判据随编辑器迁工作区原样继承） | 6.9 实机 | 已交付（6.9 实机） |
| 10 | 未捕获 key | 保留 | 5.2, 6.9 | `exec-prompt-proxy.test.ts › PROXY_* 拒绝（未捕获 key / 空 fork）：settled + 原稳定码 + 零身份，且重复不重试消费` + `messages-eligibility.test.ts › 「未捕获 key」：running 正常但 hasKey=false ⇒ 提示先把应用经代理跑一次` + `execution-confirmation.test.ts › messages 未捕获 key ⇒ 事实里就写「本次无法重发」，不等提交才发现` | 6.9 实机 | 已交付（6.9 实机：重启段正面呈现） |
| 11 | SDK run 无此入口 | 保留 | 1.4, 5.1, 6.9 | `prompt-messages-editor-draft.test.ts › DetailPanel 不再挂载编辑器；入口按 canResend 给出（SDK run 无此入口）`——canResend = proxy 来源 + 自有调用 + 已封存 | 6.12 实机 | 待验证 |
| 12 | 停用代理仍有凭据不能重发 | 新 | 5.2, 6.5 | main 事实：`fork` 以 lastKey 与 handler 双条件拒绝（proxy-manager.ts L169–176，review 已核实） + `messages-eligibility.test.ts › 「停用代理仍有凭据不能重发」：running=false 且 hasKey=true ⇒ 仍被监听检查挡住（顺序有牙）` + `messages-eligibility.test.ts › 状态未知（running=null）不能按「可能在跑」放行` | 6.5 反证 + 6.9 实机 | 已交付（6.5 反证 + 6.9 实机） |
| 13 | 主动重发结果不借被动记录 | 新 | 5.5, 6.2, 6.9 | `exec-prompt-proxy.test.ts › 重发等待期间被动录制落盘 ⇒ 登记只认本次 fork 的 id，不借用被动 run` + `exec-prompt-proxy.test.ts › 本次录制写入失败 ⇒ 明确失败且不借用在场被动 run 的 id` + `messages-results.test.ts › 列表里被动录制与重发的新 run 并存 ⇒ 结果区只呈现登记的可信 ID（不从列表/目录猜）`（工作区层：deriveMessagesResults 只按 target.kind=proxy + run/span 逐字匹配圈定） + `messages-results.test.ts › 结果区不自建执行/写通道；呈现层不摸草稿正文与凭据` | 6.2 标本 + 6.9 实机 | 已交付（6.2 标本 + 6.9 实机） |

### DU3. 设置往返保留编辑并真实反馈配置结果（MODIFIED，8 场景）

| n | 场景 | 保留/新 | 任务 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|---|---|
| 14 | 两模式配置后返回任务 | 保留 | 6.12 | `settings-roundtrip-invalidate.test.ts › 隔离 result 与创建页：配置指纹变化 ⇒ 本次副本授权作废；目录引用/模式照旧保留` + `settings-roundtrip-invalidate.test.ts › 设置往返改了配置 ⇒ config-stale，且**优先于**修订变化（先说打到哪变了）` | 6.12 实机 | 待验证 |
| 15 | 重跑编辑配置往返保持阅读 | 保留 | 1.3, 6.12 | `fork-editor-draft.test.ts › 打开 → 编辑 → 切页签/切运行（其他状态翻动）→ 重开：草稿逐字恢复` + `settings-roundtrip-invalidate.test.ts › ModelAbEditor：计划安装同时记录配置指纹；activePlan 只认 fresh；失效措辞分两种`（⚠️ messages/A-B 编辑器迁工作区后往返起终点改变，1.3 改判时两边留痕） | 6.12 实机 | 待验证 |
| 16 | 未保存设置关闭可继续或放弃 | 保留 | 2.10 | `settings-save-feedback.test.ts › 与已保存/已应用值逐项相同 ⇒ 不脏（trim 同值也没改）` + `settings-save-feedback.test.ts › 设置对话框不冒充连通、不清调试草稿、防重入双保险、只读重试走读通道` | 6.12 实机 | 待验证 |
| 17 | 单向密钥与保存反馈不冒充连通 | 保留 | 6.12 | `settings-save-feedback.test.ts › 单向 key：apiKey 只要打过字就算未保存输入（它从未离开渲染层暂存）` + `settings-save-feedback.test.ts › SettingsState 的键集里**没有** apiKey：回读只含配置状态` + `settings.test.ts › 明文落盘 + apiKeyEncrypted false + encrypted false（UI 据此明示风险）` | 6.12 实机 | 待验证 |
| 18 | 保存失败和保存后回读失败区分 | 保留 | 6.12 | `settings-save-feedback.test.ts › 「保存失败和保存后回读失败区分」：回读失败 ⇒ reread-failed，且**不把旧摘要当新配置事实**（settings 清空）` + `settings-save-feedback.test.ts › 保存失败 ⇒ save-failed，错误入 store，settings 原样（没写进去也不该动事实）` | 6.12 实机 | 待验证 |
| 19 | 清除确认包含凭据且受槽约束 | 保留 | 6.12 | `settings-clear-confirm.test.ts › 确认文案点名保存凭据一并删除且不可恢复；走 requestConfirm 真模态` + `settings-clear-confirm.test.ts › 清除按钮受 U4 配置门禁（busy 防重入 + configGate），而「关闭/✕」不吃这把锁（查看返回可用）` | 6.12 实机 | 待验证 |
| 20 | 录制入口保持现有代理区可达 | 保留 | 1.4, 2.10 | `settings-roundtrip-invalidate.test.ts › 「录制入口保持现有代理区可达」：全局/空态的录制入口打开独立录制工作区` + `settings-roundtrip-invalidate.test.ts › 录制入口的 GlobalBar 一跳必须走不清 section 的专用开器（6.7 实机缺陷的契约）`（⚠️ 前者在 1.4 有意改判：旧判据「定位设置代理分区、禁止 RecordingWorkspace」翻转为「打开独立录制工作区」，两边留痕；后者仍成立——录制入口不经 openSettings） | 6.6 实机 | 已交付（6.6 实机） |
| 21 | 设置跳转录制先处理未保存模型字段 | 新 | 2.10 | adjacent：`settings-save-feedback.test.ts › 模型字段任何一项偏离 ⇒ 脏`（dirty 判据基础；⚠️ 2.10 有意改判：代理表单已移除，"代理字段"分支删除并留痕）；`settings-roundtrip.test.ts` 的跳转先处理 dirty 用例承载就近确认 | 6.6 实机 | 已交付（6.6 实机） |

### DU4. 录制配置草稿在会话内保留并参与关闭保护（ADDED，5 场景）

| n | 场景 | 保留/新 | 任务 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|---|---|
| 22 | 录制配置跨页恢复原始输入 | 新 | 2.1, 6.6 | adjacent：`debugging-drafts.test.ts › 非法 JSON 原样保留，不被格式化或替换为原值`（原文保留纪律） + `recording-draft.test.ts › 已有草稿原样返回：重进页面不覆盖输入` + `recording-draft-store.test.ts › 已有草稿重进页面原样保留（输入不被状态覆盖）`（2.1 回填） | 6.6 实机 | 已交付（6.6 实机） |
| 23 | 录制端口校验不接受部分整数 | 新 | 2.4 | main schema 事实：zod 端口 int min(1) max(65535)（review 观察项 1） + `recording-workspace-view.test.tsx › 非法端口 ⇒ 字段处错误 + 原文保留 + 应用按钮逐控件 disabled` + `recording-draft.test.ts › 非法字段 ⇒ 不产出请求（ok:false + 双字段错误），不可能发出半截配置写调用`（2.4 回填；零配置写调用判据在后者） | 6.6 实机 | 已交付（6.6 实机：UI 门禁 + 字段错误 + 原文保留；零写调用机器判据按单元） |
| 24 | 录制放弃取消及修订竞争 | 新 | 2.2, 6.11 | adjacent（CAS 纪律同源）：`debugging-drafts.test.ts › 旧放弃确认不能删除新修订：确认后内容又变 ⇒ 拒绝删除，重新核对后才可放弃` + `recording-draft.test.ts › 修订一致 ⇒ 恢复 baseline 值且拿新修订（防 ABA 复用旧确认）` + `recording-draft.test.ts › 旧修订确认不能删除新输入（确认后内容又变 ⇒ 拒绝）` + `recording-draft-store.test.ts › 修订一致 ⇒ 恢复 baseline；修订竞争 ⇒ 拒绝且草稿原样`（2.2 回填） | 6.11 实机 | 已交付（6.11 实机） |
| 25 | 录制未应用修改参与退出保护 | 新 | 2.3, 6.11, 7.1 | adjacent：`draft-close-client.test.ts › 调用类 + A/B 批次 + 创建表单的 dirty 条目计数，clean 条目不计` + `draft-close-guard.test.ts › 旧会话 dirty ⇒ 轮换置遗留标志；新会话 clean 上报不能抹掉它（空仓库不消音）` + `recording-draft-store.test.ts › 只有录制草稿未应用 ⇒ 计一条；与其他草稿并存 ⇒ 合计；默认表单不计` + `recording-draft.test.ts › 未偏离 baseline ⇒ 不 dirty；偏离任一字段 ⇒ dirty；running 状态不参与判定`（2.3 回填） | 6.11 实机 | 已交付（6.11 实机） |
| 26 | 录制应用收尾不覆盖后来输入 | 新 | 2.6, 6.3 | `recording-draft-store.test.ts › 「录制应用收尾不覆盖后来输入」：在飞期间的新输入不被旧响应覆写基线` + `recording-draft-store.test.ts › 「迟到守卫」在回读失败半边也有牙：toggle 成功 + 回读失败 + 在飞后来输入 ⇒ baseline 不被旧响应抬回`（2.6 回填；adjacent 引用 `result-verification.test.ts › 旧代次的迟到响应整份丢弃：不覆盖新读取，也不碰其他键` 保留作代次守卫同型旁证） | 6.3 反证 | 已交付（6.3 反证：M1 去 stale 修订比较暴露原用例无牙 ⇒ 补牙用例变异恰红，还原复绿） |

### DU5. 录制工作区提供真实接入提示和只读记录入口（ADDED，5 场景）

| n | 场景 | 保留/新 | 任务 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|---|---|
| 27 | 查看代理记录保留选择和搜索 | 新 | 2.9 | `recording-workspace-view.test.tsx › 记录入口与只读刷新按钮在场`（入口半边；筛选/搜索/保留当前运行由 6.6 实机承载，2.9 回填） | 6.6 实机 | 已交付（6.6 实机） |
| 28 | 录制刷新只读且错误可重试 | 新 | 2.9, 6.6 | adjacent：`entry-gate.test.ts › 读取、关闭与回读不被门禁锁掉（spec：settings:get / proxy:status 仍可用）` + `recording-workspace-view.test.tsx › 视图渲染状态行与只读重试入口（重试 = 只读，不重新应用）` + `recording-workspace-view.test.tsx › 读取失败 / 未读到 ⇒ 「状态待读取」显式呈现，不拿默认值冒充事实`（2.9 回填） | 6.6 实机 | 已交付（6.6 只读半边；错误呈现半边实机不成立⇒单元承载） |
| 29 | 重启后凭据失效历史仍可读 | 新 | 5.2 | main 事实：代理 key 仅内存暂存（重启即失） + `aux-workspace-store.test.ts › 只读 runs:get：读到目标详情，不改选中项、不切视图、不动阅读代次`（源读取与历史阅读不依赖凭据；重发资格由 messages-eligibility 的 running/hasKey 判据单独挡） | 6.9 实机 | 已交付（6.9 实机：真实 dev 重启段） |
| 30 | 录制状态不冒充接入验证 | 新 | 2.8 | ProxyState 契约事实：仅 enabled/running/port/upstreamBaseUrl/hasKey 五字段（shared/ipc.ts L474–483，review 已核实） + `recording-workspace-view.test.tsx › running+hasKey ⇒ 三层事实分行可辨；未监听 ⇒ 明说启用不等于监听成功`（2.8 回填） | 6.6 实机 | 已交付（6.6 实机：状态区仅意图/监听/凭据三分事实行，无连通测试/速率字段） |
| 31 | 停止服务不称取消运行 | 新 | 2.7 | 判据由 6.6 实机承载（真实 toggle 停用 + 停止文案只述本地接入，无独立单元用例——诚实登记，2.7 回填） | 6.6 实机 | 已交付（6.6 实机） |

### DU6. 模型实验工作区绑定父本和完整批次草稿（ADDED，5 场景）

| n | 场景 | 保留/新 | 任务 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|---|---|
| 32 | 运行入口打开明确实验目标 | 新 | 1.2, 1.4, 3.1 | adjacent：`model-ab.test.ts › 未配置运行参数 → 拦截`（门禁沿用） + `aux-workspace-entries.test.tsx › 普通 run ⇒ open，目标绑定**首次**自有 llm.call（不得用后续调用）` + `aux-workspace-store.test.ts › 从轨迹视图进入 ⇒ 视图切到实验、来源记全、目标显式绑定、代次推进`（1.2/1.4/3.1 回填） | 6.7 实机 | 已交付（6.7 实机） |
| 33 | 切运行不更换实验父本 | 新 | 1.2, 1.5, 3.1 | adjacent（目标定位既有模式）：`draft-list.test.ts › 调用类目标：切运行（需要时）+ 步骤页签 + 选中 span + 登记 pending` + `aux-workspace-store.test.ts › 实验页在场时选中另一运行 ⇒ 离开到轨迹视图，但目标与来源引用都原样保留`（1.2/1.5 回填；store 半边已证，实机半边归 6.12） | 6.7 实机 | 待验证 |
| 34 | 实验空参数与显式空对象区分 | 新 | 3.3, 6.7 | `model-ab.test.ts › 空串 = 沿用父 run params（undefined）` + `model-ab.test.ts › params 的空对象等价沿用父值：model 也相同则仍判空 fork` + `model-ab-guard-parity.test.ts › 逐臂空 fork 判据与内核 sameParams 逐例对照（矩阵）` | 6.7 实机 | 已交付（6.7 实机：空 fork 拦截/显式 {} 沿用父/非法原文三态） |
| 35 | 实验来源失效仍能返回草稿 | 新 | 3.2 | adjacent：`model-ab-editor-draft.test.ts › 打开即清理临时计划与许可（授权不随草稿恢复）；放弃只经失效视图 CAS，预览/执行不隐式清理批次` + `aux-workspace-store.test.ts › 读取失败 ⇒ phase failed + 错误保留（允许只读重试，不动草稿）`（实验源读取失败态；3.2 回填；实机半边归 6.12） | 6.7 实机 | 待验证 |
| 36 | 离开实验恢复不带计划许可 | 新 | 1.3, 3.10 | `model-ab-editor-draft.test.ts › 内容变化作废副作用许可；恢复/离开后计划与许可均须重来（组件局部态）` + `execution-confirmation-ab.test.ts › 重新预览推进检查代次 ⇒ 那份确认作废，登记口当场拒绝`（迁移后复核） | 6.7 实机 | 待验证 |

### DU7. 实验结果工作区消费可信完整批次并连接比较（ADDED，6 场景）

| n | 场景 | 保留/新 | 任务 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|---|---|
| 37 | 成功臂集合不隐去失败臂 | 新 | 4.1, 6.2, 6.5, 6.8 | `exec-model-ab.test.ts › A-B 部分失败：失败臂带真实 id 与 failed 结局，ids 只含成功臂，批次不冒充全臂成功` + `operation-request-facts.test.ts › 「实验缺臂部分失败」逐臂诚实：登记短于 armCount 也不从信封多报的 id 凑` + `draft-closure-store.test.ts › 执行信封把 ids 全带回来，但登记与核实未跟上 ⇒ 整批保留` + `experiment-results.test.ts › experimentId 缺席如实呈现为 null；逐臂呈现复用 deriveAbBatchResult（armCount 基准）`（工作区层） | 6.2 标本 + 6.5 反证 + 6.8 实机 | 已交付（6.2 标本 + 6.5 反证 + 6.8 实机：部分失败批逐臂 [returned, failed]、失败臂真实 id/顶层 error/errored 终态、结果区按目标圈定） |
| 38 | 实验结果不可读仅重试读取 | 新 | 4.3, 6.8 | `operation-request-facts.test.ts › 不可读臂只给同一 ID 的重读动作；渲染后不出现臂间差值/胜出臂结论，也无` + `result-verification.test.ts › 已在读 / 已核实 ⇒ 视为已处理；不可读 ⇒ 不算（只能显式只读重试）` + `draft-closure-store.test.ts › 一条臂结果不可读 ⇒ 整批保留（部分成功不冒充全臂成功）` + `experiment-results-actions.test.ts › 不可读臂只按同一条可信 ID 重试：文件依旧坏 ⇒ 诊断保留、仍不换 id 不触发执行` + `experiment-results.test.ts › 4.3 未关联臂零动作：全部臂都无可信 ID ⇒ 整个结果区没有一个可点的按钮（只留诚实说明）` | 6.8 实机 | 已交付（6.8 实机：fileMissing 注入 ⇒ unreadable 只给重读动作；同 ID 重试；还原后恢复 verified；零新建文件） |
| 39 | 全臂核实才按提交修订清理 | 新 | 4.4, 6.8 | `draft-closure-store.test.ts › 两条预期臂各自核实正常结束 ⇒ 整批一次清干净（不逐臂删配置）` + `draft-closure-store.test.ts › 缺臂 / null ID / 失败臂 ⇒ 整批配置与关联都保留` + `experiment-results.test.ts › 4.4 清理只归 U5：结果区容器不自建第二套收尾/清理/执行路径`（源码级反证） | 6.8 实机 | 已交付（6.8 实机：[ok,ok] 批与部分失败批并存——失败批整批保留；清理/缺臂形态由 draft-closure-store 单元承载） |
| 40 | 实验结果选两到四条进入共用比较 | 新 | 4.5, 6.9 | `store.test.ts › 对照上限 4：第 5 条被拒绝并给出提示，已选集合不变` + `compare-metrics.test.ts › 三条 ⇒ 提示显式选两条；四条同口径（列数与集合一致）` + `experiment-records.test.ts › 同父合法两臂 ⇒ eligible，批次身份保留各臂已记录 experimentId` + `experiment-results-actions.test.ts › 两条按选择顺序进入详细比较；比较入口只读——登记/读取项引用原样` + `experiment-results.test.ts › 4.5 进入比较按钮：少于两条禁用；两条启用给顺序说明；store 提示（超上限）原样呈现` | 6.9 实机 | 已交付（6.9 实机） |
| 41 | 比较拒绝和返回实验不改批次事实 | 新 | 1.6, 4.5, 6.9 | `experiment-records.test.ts › 异父臂 ⇒ ineligible PARENT_DIFFERS；相同 experimentId 不能绕过` + `compare-workspace-store.test.ts › 返回来源：恢复视图与阅读位置，凭据一次性用掉` + `experiment-results-actions.test.ts › 比较读取被拒绝（信封错误）后返回实验：视图恢复、对照集合保留、批次事实仍原样`（1.6 落地的返回位置扩展已被该用例覆盖） | 6.9 实机 | 已交付（6.9 实机） |
| 42 | 跨页结束与重载恢复实验结果 | 新 | 4.6, 6.8 | `navigation-intent.test.ts › A/B 批次 ⇒ drop：永不自动聚焦，由用户挑臂` + `navigation-intent.test.ts › 本会话没提交过（重载恢复）⇒ none：不凭「结果可读」就跳` + `experiment-results-actions.test.ts › 重载后由登记快照恢复：批次呈现恢复、结果读取可重建、内存草稿与待定提交零补造` + `experiment-results-actions.test.ts › 后台结束不抢页：采纳已收口批次快照时，人在别的页面就留在别的页面（A/B 意图恒 drop）` | 6.8 实机 | 已交付（6.8 实机：执行期切页不抢导航（A/B drop）+ 重载后登记快照恢复两批呈现，零补造） |

### DU8. messages 编辑工作区保留单请求来源与返回路径（ADDED，4 场景）

| n | 场景 | 保留/新 | 任务 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|---|---|
| 43 | messages 工作区恢复完整非法文本 | 新 | 1.5, 5.1 | `prompt-messages-editor-draft.test.ts › messages 草稿：非法 JSON 与空输入原样暂存（不 format / 不 trim / 不替换）` + `debugging-drafts.test.ts › 空串、仅空白、末尾空白与换行逐字保留（不 trim）` + `aux-workspace-store.test.ts › messages 草稿 ⇒ 进入 messages 工作区；草稿正文原样留在仓库（路由不触碰内容）`（迁移后复核） | 6.9 实机 | 已交付（6.9 实机） |
| 44 | 缺凭据转录制再返回精确编辑 | 新 | 1.3, 5.2, 6.9 | `aux-workspace-store.test.ts › 从 messages 进录制 ⇒ 录制来源记 messages 视图；返回录制来源 ⇒ 回到 messages`（store 路径） + `messages-eligibility.test.ts › 「未捕获 key」：running 正常但 hasKey=false ⇒ 提示先把应用经代理跑一次`（recordingEntry=true ⇒ 就近「打开录制工作区」入口，源码级 `data-messages-recording-entry` 在 MessagesForkEditor） | 6.9 实机 | 已交付（6.9 实机） |
| 45 | messages 确认仍是单请求 | 新 | 5.3, 6.9 | `proxy.test.ts › 全链路：经代理录制 → key 捕获 → 编辑 messages 分叉 → fork run 落盘` + `exec-prompt-proxy.test.ts › 同 ID 重复 ⇒ 代理只被调用一次；running 期间的重复只等不二次调用` + `execution-confirmation.test.ts › messages：只重发这一个请求，不执行外部工具、不恢复其工作区` + `prompt-messages-editor-draft.test.ts › U8 5.3：提交只走登记 + proxy:fork；确认凭据绑定提交；无第二执行通道` | 6.9 实机 | 已交付（6.9 实机） |
| 46 | messages 失败定位与返回不丢草稿 | 新 | 5.4, 6.9 | `draft-closure-store.test.ts › 运行 error / 中止 / 不可读 ⇒ 草稿逐字保留，关联留着等下一次核实` + `messages-results.test.ts › 提交失败后读取项不可读只给重试，草稿在场 ⇒ 返回编辑入口保留（失败不丢输入）` + `messages-results.test.ts › MessagesWorkspace 接线：deriveMessagesResults 按目标圈定，动作走既有 store 口` | 6.9 实机 | 已交付（6.9 实机） |

### DU9. 辅助工作区在窄窗与键盘下保持连续流程（ADDED，5 场景）

| n | 场景 | 保留/新 | 任务 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|---|---|
| 47 | 辅助页面窄窗和缩放完整可用 | 新 | 6.10 | adjacent：`focus-escape-responsive.test.ts › 设置模态受 85vh 钳制并内部滚动（长表单/200% 缩放在框内滚，不撑破屏幕）` | 6.10 实机 | 已交付（6.10 实机） |
| 48 | 长模型上游和告警可完整核对 | 新 | 3.4, 6.10 | adjacent：`draft-list.test.ts › copyText 完整不截断；preview 截断且换行可见化（正文不丢）`（LongText 契约） | 6.10 实机 | 已交付（6.10 实机） |
| 49 | 键盘完成录制到重发闭环 | 新 | 6.11 | 无单元判据——6.11 实机系统级 keybd_event 全闭环承载（keyboard-flows 34 检查，6.11 回填） | 6.11 实机 | 已交付（6.11 实机） |
| 50 | 键盘完成实验到比较闭环 | 新 | 6.11 | 无单元判据——6.11 实机承载（增删臂/预览/放弃模态/执行/比较/返回，6.11 回填） | 6.11 实机 | 已交付（6.11 实机） |
| 51 | 辅助页面不改变已有主流程 | 新 | 6.12, 7.1 | `store.test.ts › 切换不重载：setView 与 selectRun 都不触发列表请求` + `compare-store.test.ts › 进入、重试、离开全程只有 runs:compare 调用，零执行通道、零列表刷新` | 6.12 实机 | 待验证 |

---

## 二、model-experiments delta（16 条）

### ME1. 同一批实验必须可分组（MODIFIED，4 场景）

| n | 场景 | 保留/新 | 任务 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|---|---|
| 52 | 同批 arm 自动配对 | 保留 | 4.2 | `experiment-records.test.ts › 同父合法两臂 ⇒ eligible，批次身份保留各臂已记录 experimentId` + `compare-metrics.test.ts › 三条 ⇒ 提示显式选两条；四条同口径（列数与集合一致）` + `experiment-results.test.ts › 每批独立成块：批次 operationId 与实验组标签（main 登记）逐字在场`（同批同组标签逐字呈现） | 6.7/6.9 实机 | 已交付（6.9 实机） |
| 53 | 多批实验共存 | 保留 | 4.2 | adjacent：`experiment-records.test.ts › 异父臂 ⇒ ineligible PARENT_DIFFERS；相同 experimentId 不能绕过` + `experiment-results.test.ts › 多批共存：同父两批各自成组，按 startedAt + operationId 确定排序` | 6.7/6.9 实机 | 已交付（6.9 实机） |
| 54 | 预览标签不充当真实批次身份 | 新 | 4.2 | main 事实：dry-run experimentId 与真实执行各自生成、不可复用（fork-runner.ts L58–71，review 已核实） + `experiment-results.test.ts › 呈现层纯度：结果区组件与派生层不摸草稿正文/授权/计划/凭据`（结果区派生输入无计划 ⇒ 预览标签结构上进不了结果区） + `experiment-results.test.ts › experimentId 缺席如实呈现为 null；逐臂呈现复用 deriveAbBatchResult（armCount 基准）` | 6.7/6.9 实机 | 已交付（6.9 实机：预览不产批） |
| 55 | 同父同模型仍按真实批次分组 | 新 | 4.2 | `experiment-results.test.ts › 同父同模型仍按真实批次分组：experimentId 相同也不合并， operationId 才是分组键` | 6.7/6.9 实机 | 已交付（6.9 实机） |

### ME2. 成本确认和 dry-run 必须显式（MODIFIED，6 场景）

| n | 场景 | 保留/新 | 任务 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|---|---|
| 56 | 未确认时阻断真实调用 | 保留 | 3.9 | `execution-confirmation-ab.test.ts › 执行按钮受确认约束，且原因就近给出（不是只禁不给话）` + `execution-confirmation-ab.test.ts › 确认成立 ⇒ 登记成功并一次性消费：第二次执行要重新确认` | 6.7 实机 | 已交付（6.7 实机：确认前执行禁用；本批零执行纪律） |
| 57 | dry-run 无密钥 | 保留 | 3.5 | `controlled-proxy.test.ts › 经受控服务创建父本后：dry-run 零请求；真实执行每臂恰一次（请求日志证明）` + `exec-model-ab.test.ts › 批次占槽期间预览照常可用：零模型调用、零文件、不产生登记`（旧场景「不读写 trace」按 delta 修正为「不改写 trace、不创建运行」——事实修正非放松） | 6.7 实机 | 已交付（6.7 实机：served 计数不变 + traces 零新增） |
| 58 | dry-run 暴露整体替换的代价 | 保留 | 3.4 | `fork-runner.test.ts › dry-run 返回 plan，含 params / overridden / added / discarded / warnings` | 6.7 实机 | 已交付（6.7 实机：三段计划；覆盖/丢弃形态按 fork-runner 单元分层） |
| 59 | dry-run 每臂三段固定展示 | 保留 | 3.4 | `fork-runner.test.ts › Ollama baseURL + num_ctx → 告警经 IPC 到渲染层；非 Ollama 不告警` + `fork-runner.test.ts › dry-run 返回 plan，含 params / overridden / added / discarded / warnings` | 6.7 实机 | 已交付（6.7 实机） |
| 60 | 桌面预览沿用配置前置且零执行 | 新 | 3.5 | `exec-model-ab.test.ts › 批次占槽期间预览照常可用：零模型调用、零文件、不产生登记` + `exec-model-ab.test.ts › 预览的四类拒绝都在副作用之前：非 dryRun / 臂数不足 / 非法形状 / 伪造 sender` | 6.7 实机 | 已交付（6.7 实机：合法 dry-run 零调用零落盘——served 计数不变 + traces 零新增 + previewing 独立请求状态；缺配置拒绝与占槽预览可用两半边由 exec-model-ab 两条单元承载） |
| 61 | 费用确认区分臂数和请求数 | 新 | 3.9 | adjacent：`execution-confirmation-ab.test.ts › 披露喂的是 activePlan：属于旧修订的计划不进确认`（臂数措辞判据由 6.7 实机核——「2 臂」在场、无「次真实调用」宣称；无独立单元用例，诚实登记，3.9 回填） | 6.7 实机 | 已交付（6.7 实机：「2 臂」措辞、无「次真实调用」宣称） |

### ME3. 桌面实验计划绑定当前编辑与来源并拒绝迟到恢复（ADDED，6 场景）

| n | 场景 | 保留/新 | 任务 | 单元/契约证据 | 实机入口/批次 | 状态 |
|---|---|---|---|---|---|---|
| 62 | 计划直接展示生效覆盖新增丢弃告警 | 新 | 3.4, 6.7 | `fork-runner.test.ts › dry-run 返回 plan，含 params / overridden / added / discarded / warnings` + `model-ab-plan-row.test.tsx › 短值 ⇒ 内联原形态（无折叠、无 details）` + `model-ab-plan-row.test.tsx › 超长 model ⇒ 折叠摘要（带字符数）+ details 可展开，完整原文仍在 DOM`（直读渲染半边，3.4 回填） | 6.7 实机 | 已交付（6.7 实机：新增形态直读渲染；覆盖/丢弃分层登记） |
| 63 | 修改臂再改回不恢复计划 | 新 | 3.6, 6.7 | `model-ab-editor-draft.test.ts › 计划与当前批次修订同源：修订推进即失效，改走又改回也不复活` + `execution-confirmation-ab.test.ts › 绑定取的是**整批**修订：改任一臂即作废（不是只认第一次写入的那一版）` | 6.7 实机 | 已交付（6.7 实机：修订推进 + 计划区消失 + 按钮禁用 + 重新校验恢复） |
| 64 | 配置轮换与来源撤销作废计划 | 新 | 3.7, 6.4, 6.7 | adjacent（现行分规则基线）：`settings-roundtrip-invalidate.test.ts › 与 settingsStampOf 分离：代理启停/凭据波动**不该**作废 A/B 计划（delta 明文分规则）`——⚠️ U8 有意契约变更：已核实保存/清除（含仅轮换 key）推进配置变化代次；与既有「代理启停不作废」并存的是**代理状态刷新**路径，3.7 落地时两路判据都要有 | 6.4 反证 + 6.7 实机 | 已交付（6.4 反证 + 6.7 实机：仅换 key 保存作废、proxy 刷新不误杀由单元） |
| 65 | 迟到和乱序预览不能安装旧计划 | 新 | 3.8, 6.4 | `model-ab-editor-draft.test.ts › 预览发起时记录批次修订；迟到响应按它校验，且先守卫后安装` + `model-ab-editor-draft.test.ts › 批次修订随语义变化推进：迟到响应因此拿不到旧修订（守卫判据有效）` | 6.4 反证 | 已交付（6.4 反证：M1 去 doPreview 迟到守卫 ⇒ 恰红源码级含顺序有牙支，还原 12/12 复绿） |
| 66 | 无有效计划和确认不提交实验 | 新 | 3.10, 6.7 | `execution-confirmation-ab.test.ts › 没有生效计划就不给确认按钮（确认的必须先是被校验的那一份）` + `execution-confirmation-ab.test.ts › 重新预览 = 重启检查：先推进代次再发只读请求，且只在资格齐备时` | 6.7 实机 | 已交付（6.7 实机：无计划/未确认双态执行禁用） |
| 67 | 副作用声明不承诺公平隔离 | 新 | 3.9, 6.7 | `model-ab.test.ts › 带副作用工具且未确认 → 拦截；勾选后放行，且声明展开到每一臂` + `experiment-records.test.ts › 风险工具 + 未声明 ⇒ ineligible（SIDE_EFFECT_UNDECLARED，如实拒绝）` | 6.7 实机 | 已交付（分层：U5 6.5 实机 guard 拒绝+勾选放行+披露、U8 3.1a ModelAbEditor 逐字提取零行为变化、单元判据有牙（6.5 反证 M2 同文件）；U8 6.7 零执行纪律不重跑副作用批） |

---

## 三、U7 基线与历史未验证限制（1.1 登记）

- **基线**：U7 `improve-branch-comparison` 已归档（`d53b7d0`，2026-10-01）；U8 起草 `371c0be`、复审修订 `53936ee`。
  主 spec 现状：desktop-ui **70 req / 351 scen**、branch-tree 11/34、model-experiments **13/43**、llm-proxy 6/19。
  U8 delta 差集：5 MODIFIED + 7 ADDED、67 场景（20 保留 + 47 新），已由
  `.workbuddy/u8/u8-11/extract-scenarios.cjs` 机器核对（未引用场景 0、重名 0、MODIFIED 名与主 spec 逐字匹配）。
- **U4 归档后仍属事实的四条欠账**（U8 不自动清零，触及才处理）：
  ① 真机 IPC 往返与满载诊断体积未测；② `configurationBusy` 合并档关闭确认文案未实机诱发；
  ③ 跨 epoch 的**在飞**关联真机无前提；④ 🔴 `ProxyManager` 层「被动录制同窗落盘 ⇒ 主动身份不变」无有牙反证（端点层有）。
- **两条待与用户定口径**（改契约须回 proposal，不在实现里静默改）：
  隔离父本守卫无稳定业务码；「响应已转发、录制写盘失败」记成 `rejected` 的字面歧义。
- **窄窗 N1**（`<Dialog>` 系缺 `max-width`，1/2/3 节点窄窗横向溢出）= 用户未定口径的独立欠账，与 U8 无关；
  U8 新工作区不用模态承载正文（design D8），不受其影响但不修它。
- **U7 归档遗留待定三项**：① 6.2 手工臂 ea/eb 标本现实性缺口（REQUEST_PARAMS_MISMATCH 实证）是否修标本；
  ② `setCompareSide` 无 renderer UI 消费是否补入口；③ 操作结果侧父子入口待 ResultReadEntry 携带 parentRunId
  （U8 4.5 结果区选两条进比较不依赖该入口，如触及如实登记）。
- **desktop 测试目录 tsc 既有噪声**：`compare-ipc.test.ts` 2 条（1.6 遗留）、`call-detail-view.test.ts` 6+2 条、
  `controlled-isolated/controlled-service/create-run-dialog/reading-scroll-restore/operation-session-store/store.test.ts` 各若干、
  `monaco-bootstrap` `?worker` 2 条 ⇒ `.rebaseagent/tsconfig.desktop-test.json` 只作"看自己改的文件"的辅助工具，
  真正 src 门禁是 `tsc -p tsconfig.node.json` / `-p tsconfig.web.json` 双 0。
- **已知 flake 名单**（并行端口紧邻起停）：`controlled-proxy` / `proxy` / `proxy-fork-identity` / `controlled-service` /
  `controlled-entrances` ⇒ 单跑复现、单跑全绿即 flake；环境阻塞与产品真实失败分开登记。
- **replay 环境受阻基线**：12 条（model-ab-cli 9 = 沙箱 spawn EBUSY + symlink 3 = 沙箱伪造 symlink），
  与 U5/U6/U7 登记构成一致；packages 侧本轮若零改动则以 U7 归档基线（404 过 + 12 受阻 + trace-sdk 191/191）为准。
