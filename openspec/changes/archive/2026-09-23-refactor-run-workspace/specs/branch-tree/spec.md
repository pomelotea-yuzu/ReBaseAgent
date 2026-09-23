## MODIFIED Requirements

### Requirement: 分支树以节点-边图呈现运行与分叉

分支树视图 SHALL 以图形呈现：每个节点代表一次 run 并展示其状态、任务名、创建时间、本 run 增量（步数 · tokens）；每条边代表一次分叉，SHALL 标注分叉摘要与被分叉的 span id——摘要由 `fork.edit.field` 映射（`"result"` → 「改 tool_result」、`"messages"` → 「改 messages」、其他 → 「改 <field>」），SHALL NOT 推断编辑内容。

底层记录状态 SHALL 保持 `completed` / `crashed` 两态；节点展示 SHALL 结合该 run 已校验摘要的状态与终止原因，与运行列表及概览使用一致的状态文字和语义色。`completed` 仅表示封存，SHALL NOT 单凭该值展示正常成功：reason 为 `completed` 时显示「已结束」及正常色，`error` 显示「出错终止」及红色，`max_iterations` / `budget_exceeded` 分别显示「达到迭代上限」/「超出预算」及琥珀色，`aborted` 显示「已中止」及中性色。`crashed` 显示「运行中断」及中性色，SHALL NOT 推断为仍在执行；已封存摘要的 reason 缺失或未知时 SHALL 显示「结束原因未知」、保留可查看的原值并使用中性色。状态 SHALL 有可读文字，不能只依赖颜色；正常结束 SHALL NOT 表示测试通过或任务质量已验证。工具曾出错但最终正常结束时 SHALL 仍按终止原因展示，不将工具错误数当作整次运行失败。

选中某个 run 时，系统 SHALL 高亮从根到该 run 的整条祖先链（该链即它与兄弟分支共享的前缀）。点击节点 SHALL 选中并加载该 run 的详情，行为与在列表中点击该 run 一致。

#### Scenario: 多分支家庭呈现

- **WHEN** 存在根 run A 与两条子分支 B1、B2（均 parent=A，fork.edit.field="result"）
- **THEN** 图上出现一个根节点与两个平级子节点，两条边分别标注「改 tool_result」并各自标出自己的分叉点 span id

#### Scenario: 代理分叉的边标注

- **WHEN** 某 run 由代理重发产生（`fork.edit.field="messages"`）
- **THEN** 其入边标注「改 messages」，与 replay 分叉（「改 tool_result」）在图上可区分；树 SHALL NOT 区分两者的拼接语义（语义差异只在详情面板体现）

#### Scenario: 选中高亮共享前缀

- **WHEN** 用户点击深层分支 C（A → B → C）
- **THEN** A、B、C 三个节点与 A→B、B→C 两条边被高亮，C 的兄弟分支及其子树不高亮

#### Scenario: 无分支时退化呈现

- **WHEN** 数据目录只有一条 run（无 parent、无 fork）
- **THEN** 图上呈现单个节点，无分叉边，不隐藏视图、不提示「无分支可用」

#### Scenario: 节点按封存运行的终止原因区分结局

- **WHEN** 树包含 status 均为 completed、reason 分别为 completed、error、max_iterations、budget_exceeded、aborted 的运行
- **THEN** 节点分别显示已结束、出错终止、达到迭代上限、超出预算、已中止；错误为红色、限制为琥珀色、中止为中性色，与列表/概览一致；底层 status 不变，不因封存全部染成正常绿色

#### Scenario: 节点对中断和未知原因诚实降级

- **WHEN** 树包含 crashed 的运行及已封存但摘要 reason 缺失或未知的运行
- **THEN** 前者显示运行中断，后者显示结束原因未知且原值可查看，均用中性色和明确文字，不伪造活跃执行或正常成功，不为显示状态新增详情读取或放宽格式校验

#### Scenario: 节点不把已恢复的工具错误当作终止失败

- **WHEN** 某运行记录了工具错误，但最终 reason 为 completed
- **THEN** 节点仍显示已结束及正常色，已有工具错误指标仍按原记录呈现，不改成出错终止，也不声称测试通过
