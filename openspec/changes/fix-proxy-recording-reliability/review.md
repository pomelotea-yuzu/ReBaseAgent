# fix-proxy-recording-reliability change 审阅

> 日期：2026-10-06。对象：proposal / design / tasks / llm-proxy delta / desktop-ui delta。范围：文档与源码核对，未实施产品代码、未运行功能或 Electron 验收。本文件为该 change 的首轮独立评审记录。

## 结论

**修订 1 项 P2 后可作为实施基线**：失败 run 获得失败 `llm.call` span 后，「单请求级最小分叉（方案 a）」的适用面被隐式改变（失败 run 从结构上不可分叉变为落入 SHALL 范围），delta 未对此显式决策。其余契约、源码锚点、数量与 strict 校验全部通过。

## 对照依据

- 主 spec：`llm-proxy` 6 requirements（L27「每个请求录制为一个 run」、L77「单请求级最小分叉（方案 a）」、L105「代理 run 写入与引擎一致的配置指纹」）；`desktop-ui` 76 requirements（重点核对 L645「失败 LLM 调用的标记与错误详情」、L677「错误详情缺失的诚实提示」、L364「代理设置与运行状态可观测可控」）。
- 源码核对：`packages/llm-proxy/src/{handler,types,server}.ts`、`packages/agent-loop/src/diagnostic.ts`、`packages/trace-sdk/src/schema.ts`、`apps/desktop/src/main/{proxy-manager,index,exec-endpoints,ipc}.ts`、`apps/desktop/src/shared/ipc.ts`、`apps/desktop/src/renderer/src/{lib/execution-confirmation,components/MessagesForkEditor}.tsx` 附近。
- 基线核对：`openspec validate fix-proxy-recording-reliability --strict` 通过；实测反馈 `D:/ReBaseAgentVideo/ReBaseAgent-实测反馈-2026-10-05.md` 三条现象（L15-17 列表不刷新、L26-28 hasKey 缓存门禁、L36 编辑器 0×0）逐条可在文档定位；`docs/reviews/2026-10-06-ui-density-review.md` 存在。
- 注意：change 目录当前**未提交**（untracked），提交时随本 review 一并入库。

## 已核实事实（全部属实）

1. **数量与结构**（独立解析）：delta **1 MODIFIED + 2 ADDED（llm-proxy）+ 4 ADDED（desktop-ui）**、共 28 scenarios（llm-proxy 13 + desktop-ui 15），全部被 tasks 括号精确引用（5.1/5.2 兜底「本 change 全部场景」）；MODIFIED 名称与主 spec L27 精确匹配，4 个旧场景名零丢失（upstream 失败为语义修订，非流式/流式/断连保留原义）。
2. **现行失败行为即修订对象**：`handler.ts:178` 注释「run 只落 meta + stopped/error，不写 llm.call span」与 `types.ts:33` 一致，即主 spec L47 场景「upstream 失败」的现行实现；`handler.ts:162-172` 连接失败确实给客户端本地 502。proposal 声称的缺口与源码一致。
3. **LlmCallErrorSchema 复用可行**：`trace-sdk/schema.ts:72-77` 正是 `message(min 1) + optional status`，注释「无状态码的失败（网络异常 / 流中断）省略该字段」与 delta「连接失败不伪造上游状态码」场景语义精确对齐。
4. **DIAGNOSTIC_MAX_LENGTH=1024** 属实（`agent-loop/diagnostic.ts:16`），脱敏→限长顺序由既有测试锁定（`diagnostic.test.ts:112-117`）。
5. **autoStart 已存在**（`proxy-manager.ts:110`，`index.ts:242` 调用），proposal 如实声明「不作为缺失功能重写」，只补恢复阶段/失败诊断。
6. **keyCaptureRevision 为新增概念**：当前 `ProxyState` 仅 `hasKey` 布尔（`shared/ipc.ts:482`），execution-confirmation 的代次推进规则（`execution-confirmation.ts:169`「普通 proxy:status 刷新不推进」）与 D2 的「重复同事实读取不撤销确认」意图吻合，新增捕获版本是对既有代次机制的细化而非冲突。
7. **与主 spec「错误详情缺失的诚实提示」自洽**（这点做得干净）：主 spec 该 requirement 是条件式表述——「自身没有任何 llm.call 的代理失败 run 同样 SHALL 显示该提示」。新失败 run 有 llm.call 且带 error 后走既有场景「本 run 有详情时不显示缺失提示」，旧文件继续走「代理失败 run 同样提示缺失」；**无需修改主 spec 即逻辑兼容**。delta 新增「旧代理失败仍提示详情未记录」与「代理失败概览只使用自有已记录诊断」分别覆盖新旧两端，且与 L645「失败 LLM 调用的标记与错误详情」（节点详情层）互补不重叠（新 requirement 是运行概览层 + 定位动作）。
8. **反馈三现象与源码对得上**：列表不刷新（无被动通知通道，`proxy:changed` 不存在）、hasKey 缓存（`MessagesForkEditor.tsx:140` 读 store 的 `proxy?.hasKey`）、编辑器 0×0（反馈 L36）。
9. evidence-index 6 组覆盖 28 场景；「问题证据≠通过证据」「编辑器原路径未复现不得凭源码勾选」的边界声明符合项目纪律。

## 发现与处置建议

| 级别 | 问题 | 建议处置 |
|---|---|---|
| P2 | **失败 run 可分叉性变化未被显式决策**。MODIFIED「每个请求录制为一个 run」使新失败 run 含完整 `llm.call.request`，而主 spec「单请求级最小分叉（方案 a）」写「对已封存的代理 run，用户 SHALL 能编辑其 llm.call.request.messages 并经代理重发」——现状失败 run 无 llm.call、结构上被排除；修改后新失败 run 落入该 SHALL 范围（用当前凭据重试失败请求成为可能）。design D4 只写「是否可手动 messages 重发继续遵守已封存代理来源、合法修改、当前凭据与独立确认，不自动扩展配置型 replay 能力」，未回答意图是放行还是拒绝：(a)「已封存」对 stopped/error 终止是否成立无定义；(b) 无任何 delta scenario 覆盖失败 run 的重发结局；(c) 主 spec「代理 run 写入与引擎一致的配置指纹」末句「不含 llm.call span 的 run 仍会被 fork 门禁的既有条件拒绝」在新数据流下仅剩历史意义，fork 门禁的实际行为变化未被任何 requirement 表达。实施者可能分歧：一个放行失败 run 重发，另一个在门禁加拦截 | 在 delta 中显式决策并补 scenario（二选一）：**方案 A**——接受失败 run 可用当前凭据重试（对用户是合理的能力增益），补「失败 run 重发产出新 run，parent/fork 语义与既有分叉一致」场景，并在 design 说明门禁沿用既有条件；**方案 B**——维持失败 run 不可重发，在 desktop-ui「重发门禁」requirement 中写明 error 终止 run 的拒绝条件与文案，并在 design 记录理由（例如失败请求的 params 完整性存疑）。无论哪种，顺带在 design 澄清「已封存」对 error 终止的定义 |

## 不阻塞观察项

1. **「写入失败不报告新记录」THEN 措辞含糊**：「主动重发仍通过本次局部写入诊断失败」语义不明（是说该次写入失败可在诊断中查明，还是重发操作自身失败走既有通道？）。建议改写为具体可验证行为。
2. **恢复 requirement 的 capability 归属**：「保存的监听意图在启动时恢复且失败可诊断」置于 llm-proxy，但正文含顶栏/录制页呈现与「显式保存并应用重试」等桌面 UI 行为；desktop-ui 侧无对应呈现要求（先例：代理启停在 desktop-ui L364 有独立 requirement）。可接受（llm-proxy 已有「端口被占用」UI 场景先例），但归档 sync 后 UI 行为只活在 llm-proxy spec 里，建议至少在 design 标注这个分层选择。
3. **1024 常量双源风险**：llm-proxy 保持零 agent-loop 依赖需复制 `DIAGNOSTIC_MAX_LENGTH` 的值。design 已写「测试与现有 helper 共用脱敏边界输入验证一致行为」，建议任务 3.1 把「两处常量一致性锁定测试」写实，防未来单边改动漂移。
4. **与 improve-workspace 的合并回归单向承载**：D6 写「修改同一组件时须复核合并」，但 tasks 无对称任务；对方 4.4 已承载「合入可靠性 change 后重跑」。若本 change 先行实施，建议在 5.1 或新任务中补一句「improve-workspace-reading-and-editing 合入后重跑编辑器恢复场景」，把双向依赖从文字落到任务。
5. 场景「保存停用不启动代理」THEN「无捕获凭据」表述冗余（新 main 会话 hasKey 本来就是 false），无害。

## 实施时继续遵守的边界

- 通知/回读/重试/恢复不消费授权、不占执行槽、不产生模型调用——与「主动执行由 main 会话身份登记和去重」「main 原子执行槽覆盖所有主动编排」的既有分层一致，实施时不得让 `proxy:changed` 走 exec-endpoints。
- 客户端字节保真与历史文件不改写是硬边界；脱敏只作用于诊断文本，不碰转发字节。
- 本轮为文档与源码核对，不构成功能交付或归档放行；19 条任务全部未勾选。
