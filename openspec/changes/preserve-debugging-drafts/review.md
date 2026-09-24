# U3 change 评审：preserve-debugging-drafts

- 评审时间：2026-09-24
- 评审对象：`openspec/changes/preserve-debugging-drafts/`（proposal / design / specs/desktop-ui delta / tasks）
- 评审方式：文档审阅 + 当前源码核对（未执行 GUI 走查）
- 门禁：`openspec validate preserve-debugging-drafts --strict` 通过

> 以下原始评审保留其当时的判断、计数和任务编号；2026-09-24 修订处理见文末第六节。当前实施以更新后的 proposal/design/spec/tasks 为准。

## 结论

**通过，可进入实施。** 文档质量与 U1/U2 归档基线相当：现状断言与源码一致、U4/U5 边界清晰、授权与安全纪律完整、spec 场景与任务验收可对应。以下问题均为建议级，不阻塞开工；其中 B1/B2 建议在实施对应任务组前先小幅修订文档。

## 一、现状断言核对（design.md Context / proposal Why）

| # | 断言 | 结论 | 证据 |
|---|---|---|---|
| 1 | DetailPanel 四类编辑器输入为局部 state，卸载即丢 | 属实 | `DetailPanel.tsx` L161-163（prompt）、L452-459（A/B rows/plan）、L1027（messages）、L1208-1218（result） |
| 2 | prompt 字段切换重新填入原值 | 属实 | `DetailPanel.tsx` L184-188 `switchField` 用 `originalSystem/originalUser` 覆盖 `value` 并 `resetFork()` |
| 3 | 创建表单卸载重置、忙碌关闭限制 | 属实 | `CreateRunDialog.tsx` L34-38 局部 state，L53 `modalLocked`，L58-62 Esc 受锁约束 |
| 4 | main 无关闭协商 | 属实 | `main/index.ts` 仅有数据目录取消时的 `app.quit()`（L157/L162）与 `window-all-closed`（L207-209），无 close 拦截 |
| 5 | preload 只有请求式接口、无订阅/解绑 | 属实 | `preload/index.ts` 全部为 `ipcRenderer.invoke`，文件头注释明确"不暴露 ipcRenderer"、零第三方依赖（zod 未引入） |
| 6 | 现有模态用 `<dialog open>`、无焦点陷阱/恢复 | 属实 | `CreateRunDialog.tsx` L102-107、`SettingsDialog.tsx` L135-136 均为 `<dialog open>`，叠加 fixed 覆盖层，无 showModal/焦点管理 |
| 7 | sourceToken 15 分钟 + 一次性消费 | 属实 | `main/source-token.ts` L38 `SOURCE_TOKEN_TTL_MS = 15 * 60 * 1000`，L62 `consume` 删除条目 |
| 8 | `lib/debugging-drafts.ts`、`main/draft-close-guard.ts` 均为新增 | 属实 | 文件不存在 |

U1/U2 阅读状态 slice 排除草稿/授权一点与 store 现状相符（`store.ts` + `lib/reading-state.ts`）。**未发现任何与源码不符的假设。**

## 二、优点

1. **修订号设计防 ABA**（D1：删除重建不复用 revision；D3：旧放弃确认不能删新修订），并与 U4/U5 的 `{draftKey, submittedRevision}` 交接位预留一致，避免了预先实现假 operationId。
2. **授权纪律一贯到底**：草稿不含授权/预检/sourceToken；关闭 IPC 只传元数据；main 校验 sender/frame/session/sequence/requestId，"renderer 失联 ≠ clean" 的保守默认正确。
3. **无损保存语义明确**：空串、末尾空白、非法 JSON 均保留原文，解析只在提交边界；dirty 比较语义字段而非随机行 ID；"未编辑不产生虚假 dirty"。
4. **保真度边界与 Non-goals 具体**（不含糊地说"不持久化、不承诺崩溃恢复、不伪造执行状态"），比一般 proposal 的 non-goals 更可验收。
5. **tasks 质量高**：每项有预算上限、引用 spec 场景名、要求"真实事件驱动 + store/DOM/实际 IPC 断言"，正面吸收了 U2 "状态函数存在但控件未消费"的教训（design Risks 第 4 条）。
6. **场景覆盖完整**：9 个 requirement、36 个场景，逐场景反查 tasks 均有对应验收项（含 6.4 明确要求"确认退出须观察进程/窗口真实结束"）。

## 三、问题与建议

### B1（建议修文）：任务 3.3 验收引用了不适用的场景片段

tasks 3.3（A/B 预览绑定）验收写"取消目录选择和迟到检查不覆盖草稿"，但 A/B 编辑器没有目录选择（目录选择属创建/隔离流程）。该验收应改为只引用"迟到检查不覆盖草稿"部分，或引用 spec 场景"取消目录选择和迟到检查不覆盖草稿"中适用于 A/B 预览的迟到响应子句。属复制粘贴残留，实施时按 3.3 实际语义执行即可，但建议先改文避免验收歧义。

### B2（建议补一句）：1.5s 超时缺实测依据与慢机校准

D6/规格场景"renderer 失联或应答无效仍有退出确认"使用固定 1.5s。设计未说明该值的来源，也未安排慢速机器/高负载下的校准验证。建议在 tasks 6.4 验收中显式加一条：在受控降速（如 CDP throttle 或忙等）下核对不会把"慢但活着"的 renderer 误判为失联（误判只是降级到确认框，不丢数据，但会造成"无法确认草稿状态"的误导文案）。不阻塞。

### B3（记录为 open question）：Windows 正常注销/关机（session-end）

design 把"系统强杀、断电"排除在保证范围外是合理的，但 Windows 注销/关机走的是正常 `before-quit`/`session-end` 流程，严格说属于"常规退出"。建议在 design 的 Migration / Open Questions 补一句：session-end 路径是否纳入 guard、若纳入其超时行为如何（系统给应用的关机时间有限，1.5s 查询 + 原生确认可能来不及展示）。U3 可先声明"session-end 不保证确认"，但应明示而非留白。

### B4（提示）：prompt 草稿键绑定"首次合法 llm spanId"

D1 中 prompt 身份为 `runId + 首次合法 llm spanId`。trace 文件不可变时该键稳定；但若未来 run 详情重建导致首个 llm span 判定改变（能力校验规则变化、版本升级），旧 prompt 草稿会整体落到 D2 的"来源改变"分支——保留但禁提交、需复制/放弃。该行为可接受，只是注意 D2 的基线签名需把"判定首个 llm span 的依据"一并纳入签名，否则可能出现"键仍匹配但基线语义已漂移"的静默情况。实施 1.4 时确认。

### B5（轻微）：输入锁的 UX 说明

spec 要求"应答前读取最新输入并短暂锁定编辑直至关闭决定"。查询期间（最长 1.5s）用户正在输入的按键会被丢弃还是缓冲，design 未写明（"输入本身不改动"仅覆盖取消路径）。建议实现时选择"锁期间缓冲/忽略新输入但不清除已有内容"，并在 6.4 的"clean 与最后一键竞态"断言中覆盖该路径。

### B6（记录）：任务量与预算的现实性

29 项任务中 4.3（close guard + 原生确认 + 超时 + 一次性放行 + 防重入）、6.4（六场景实机退出验收）、6.5（五档宽度 × 200% 缩放 + 焦点序列）在 2h 内完成偏乐观。tasks 已有"超过先拆分"规则，实施时按实际拆分即可，无需现在改。

## 四、场景 ↔ 任务覆盖抽查

- 主进程关闭 6 场景 → 4.2/4.3/4.4/6.4 ✓（6.4 明确引用"全部六个场景"）
- 模态焦点 3 场景 → 5.1/5.2/6.5 ✓
- 提交冻结 3 场景 → 3.4/3.5/6.3 ✓
- 草稿不持久化 → 6.6 ✓
- 原有入口/阅读回归 → 6.3/6.6 ✓
- 未发现无任务对应的场景，也未发现无场景对应的任务组。

## 五、与项目约束的一致性

- 入库边界：本评审文件位于 change 目录，随 change 制品一并提交（符合 `3fdcf06` 先例）。
- 全中文产出、可视化方向（D3 的响应式原值/草稿核对、草稿标记与列表入口均考虑了直观性，宽度验收含 800px 与 200% 缩放）。
- 不新增依赖（复用 zustand / Monaco 懒加载 / 原生 dialog）。

## 六、评审意见处理（2026-09-24）

本节记录提案修订，不代表重新完成实施审计或 GUI 验收。原评审中的 36 场景、29 任务及旧 4.x/6.x 编号为历史口径；修订后为 9 个 requirement、41 个场景、37 项待办，实施仍未开始。

| 意见 | 处理与核对结论 | 文档落点 |
|---|---|---|
| B1 | 原场景明确包含 A/B 预览迟到响应，不属于错误引用或缺少覆盖；采纳改善清晰度的建议，拆为“取消目录选择保留原引用”和“迟到检查不覆盖草稿”，各任务只引用适用部分。 | spec 授权 requirement；tasks 3.1–3.3 |
| B2 | 采纳慢响应验证；纠正验收目标：超时不是失联判定，慢但存活的 renderer 可以降级到“暂时无法确认草稿状态”。1.5s 是未实测校准的设计初值，补阈值前后应答、CPU 降速、取消解锁与重试核对。 | design D6；spec 慢响应场景；tasks 4.5、6.7 |
| B3 | 采纳显式限定退出保证；纠正原技术描述：Windows 注销/关机/重启不发 before-quit，query-session-end 可请求延迟，session-end 已不可阻止。U3 不阻止系统结束会话、不保证该路径确认，不将其等同 app.quit。事实已核对当前安装 Electron 的 electron.d.ts 事件文档。 | proposal Non-goals；design D6；spec 系统会话结束场景；tasks 4.4、6.6 |
| B4 | 采纳恢复时重验身份和能力，未新增算法版本签名。草稿不跨 renderer 重载，升级迁移不在范围；prompt/A-B 重新求首次 llm.call，不跳过不合法首调用选择后续调用，同 ID 也须重验资格。 | design D1/D2；spec 首次调用资格场景；task 1.4 |
| B5 | 采纳并明确锁持续到关闭决定，不是最长 1.5s。锁前同步控件/model 已接收文字，锁内阻止新编辑且不缓冲重放；未收尾组合不能报告可直接退出的 clean，新增 inputSettled 元数据和中文输入法实测要求。取消恢复输入及焦点，不承诺恢复未进入控件的候选。 | design D6；spec 退出输入锁场景；tasks 4.2/4.3、6.5 |
| B6 | 主动拆细原 4.3、6.4、6.5 等大项，将正常关闭、超时、防重入、输入法、故障注入、慢响应、四档宽度、独立缩放和焦点验收分开。宽度为四档加独立 200% 缩放，不要求全组合；所有任务仍保留超出 2h 先拆分的规则。 | tasks 4.1–4.7、6.4–6.11 |

当前提案已补齐这些设计决定；系统输入法、慢响应和系统事件边界的测试均为后续待办，不能以文档校验通过代替。
