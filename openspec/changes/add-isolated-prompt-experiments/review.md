# R2.2「隔离 prompt 修复实验」提案审阅

日期：2026-10-19。审阅人：Trae 审阅会话。审阅对象为工作区未提交状态（change 目录当前 untracked，源码核对基线 `a833269`）。性质：提案与规格审阅，不含功能实现审查（功能尚未实施）。

## 结论

**通过，无阻塞问题。** 提案、设计、5 份 delta、交互草案、任务与证据索引内部一致，源码事实声明逐条属实，契约修订（禁止跨运行文件 diff 的反转）显式声明而非静默改写。有 3 项低优先级观察项和 2 项实现期提醒，均不阻塞实施。

## 已验证事实

### 源码核对（design.md Context 声明逐条属实）

| 声明 | 核对结果 |
|---|---|
| `promptReplayRun` 经 `loadForkParent` 拒绝 workspace | 属实，[fork-parent.ts](file:///d:/ReBaseAgent/packages/replay/src/fork-parent.ts#L41-L57) 提示改用 `replayIsolatedRun` |
| `runPromptFork` 经 `buildForkConfig` 附加普通宿主文件 handler | 属实，[fork-runner.ts](file:///d:/ReBaseAgent/apps/desktop/src/main/fork-runner.ts#L187-L244) 以 `attachHandlers` 挂普通工具，模型取 `settings.model`，与隔离路径"模型取根请求"的要求冲突，须独立编排 |
| `preflightIsolatedReplay`/`replayIsolatedRun` 只支持 result 整轮续跑 | 属实，均为 workspace 目录既有导出 |
| `WorkspaceOriginSchema` 只有 import/checkpoint | 属实，[schema.ts](file:///d:/ReBaseAgent/packages/trace-sdk/src/schema.ts#L123-L130)，v3 的 `initial` origin 需扩展 union |
| `FORMAT_VERSION=2` 兼作最高读取版本与隔离判据 | 属实，[schema.ts](file:///d:/ReBaseAgent/packages/trace-sdk/src/schema.ts#L11)、[reader.ts](file:///d:/ReBaseAgent/packages/trace-sdk/src/reader.ts#L85-L117)、[branch.ts](file:///d:/ReBaseAgent/packages/trace-sdk/src/branch.ts#L83) 均以 `=== FORMAT_VERSION` 作判据，D3"审计全部消费方"的必要性成立 |
| `compare-files.ts` 与主 spec 明确禁止跨运行文件 diff | 属实，[compare-files.ts](file:///d:/ReBaseAgent/apps/desktop/src/renderer/src/lib/compare-files.ts#L11) 与 [desktop-ui spec](file:///d:/ReBaseAgent/openspec/specs/desktop-ui/spec.md#L2056) 均禁止；本提案经 MODIFIED「比较文件入口保持单运行合法检查点」**显式反转**该契约并保留"不借祖先/兄弟步骤或源目录补历史"的底线，改法正确 |

### 内部一致性（程序化逐行核对，零失配）

- delta 场景 76 条 ↔ evidence-index 76 行：双向零缺失，requirement 名零失配。
- 任务引用：31 个任务定义，76 行 evidence 的任务映射全部有效。
- MODIFIED 块保留主 spec 既有场景 40 个，无一丢失；MODIFIED 块内新增 3 个场景（trace-format 2、prompt-replay 1）；ADDED 块 33 个场景。40 + 3 + 33 = 76，与 evidence-index 声明吻合。
- 23 条 requirement 中 11 条 MODIFIED、12 条 ADDED，与 self-check 声明吻合。
- 版本职责分离自洽：writer 产出 1/2/2/3（普通/隔离根/隔离 result 子/隔离 prompt 子）在 D3、D4、trace-format「三版本读取与写入职责分离」三处口径一致；v3 父的 result 子续写 v2 与"前缀截止在 v3 自有整轮"互洽。
- v3 父本的执行边界闭合：v3 不能作普通 prompt fork 父本（「隔离父本不能转普通 prompt fork」已扩至 v2/v3）、不能叠加隔离编辑（Non-goals + requirement 正文）、只能走 result 续跑（D4）——三条规则无漏洞。

### 门禁复核（独立复跑，非沿用 self-check 记录）

| 检查 | 结果 |
|---|---|
| `openspec validate add-isolated-prompt-experiments --strict --no-interactive` | exit 0，change valid |
| `pnpm check:spec` | exit 0，13 passed / 0 failed |
| `git diff --check` | exit 0 |
| change 内相对链接与尾随空白 | 无断链、无尾随空白 |

## 发现

### 观察项（低优先级，不阻塞）

1. **两层"默认检查点"语义不同，实现时勿混淆。** 包层 `stepSpanId` 缺省 = 初始快照（workspace-isolation delta），桌面默认 = 各侧最近自有完成检查点、无则初始（D7 与 desktop delta）。二者不矛盾——桌面应把默认解析为**显式 selector** 再调包层，不得依赖包层缺省兜底。建议实施 4.1/6.4 时在接口注释中各写明本层默认，防止把"缺省为初始"误当桌面默认行为。

2. **configRevision 的轮换触发点未指定层级。** D2 规定了轮换条件（真实端点含隐藏部分、凭据、执行限制变化）与性质（main 会话内、不从 secret 派生、不落 trace），但未指明在哪个写入路径执行 bump（settings 保存 handler 还是 repository 层）。属实现期澄清项，建议 5.2 落实后回填 design 一行，避免两个写入路径各自维护导致漏轮换。

3. **普通路径"缺 user 消息时 system 编辑是否可用"是主 spec 既有空白，勿顺手填补。** 现行实现（[prompt-fork.ts](file:///d:/ReBaseAgent/packages/replay/src/prompt-fork.ts#L214)）缺 user 时仅拒绝 user_message 编辑，system 编辑仍可用；隔离路径 D1 明确"至少各一条"更严格且有场景支撑。实施 3.1 时保持隔离严格语义即可；若要统一普通路径行为，应先修订主 spec，不在本 change 内夹带。

### 实现期提醒

4. **桌面接入遵守既有 UI 布局约束**：主工作区 `overflow-hidden`、各列容器 `min-h-0`、详情列独立滚动且底部与正文同色。prototype.md 未复述这些约束，但 6.x 任务落地时适用。

5. **「更可视化」长期方向已获回应，验收时保持。** prototype 的双栏 diff、路径并集居中选择、逐侧状态区分（引用相同 ≠ 内容相同）正符合"更可视化"的产品方向；7.2 实机核对时建议把 diff 可读性（CRLF/LF、空串、末尾换行、新增/删除方向）列为逐项核对点——evidence 场景「文本新增删除与原换行可核对」已含此意，勿在实现中以规范化文本"简化"掉原字节语义。

### 值得肯定的处理

- **诚实口径到位**：保真度边界明确"相同模型名不能保证服务商后端版本/随机性/缓存一致""不能声称所有运行条件只变了一项""R3 前文件/输出变化不证明代码正确"；「历史未知条件与真实计费分别表达」「正常结束和输出变化不冒充修复证据」两个场景把不夸大承诺固化成可验收契约，与社区文章口径约束同源。
- **前置零调用纪律贯穿**：所有拒绝路径（缺附件、非根、未封存、配置漂移、空编辑、提交前变更）均要求零子记录/零调用，且把"rejected 操作登记"与"零子记录"显式区分（D5），避免语义混淆。
- **失败码分层清晰**：`storage_io` 不伪装成"不存在"、`parent_not_root` 可带经完整父链验证的 rootId 导航建议但"不得顺便当作已授权目标"——边界意识成熟。
- **不夹带范围**：Non-goals 明确排除 A/B、多臂、任意中间消息编辑、shell/真实测试、自动评分、MCP、持久草稿与真正取消，与「不迁移历史文件、不新增第三方依赖、agent-loop 零 Electron 依赖」的 Impact 声明一致。

## 后续

实施按 tasks.md 顺序推进，每个任务按 evidence-index 回填证据；7.4 的场景审计与全仓门禁不得以文档校验替代功能证据。实施完成后本 review 可归档至 change 目录随附提交（入库边界：change 制品随文档补交）。
