# desktop-ui Delta

## ADDED Requirements

### Requirement: 缓存命中可视化

llm.call 详情的 usage 区 SHALL 在 `usage.cache_hit` **存在**（`!== undefined`，**`0` 属存在**）时展示缓存命中：命中 tokens、占输入（`usage.in`）的比例，并以视觉强调区分「命中为主」与「全量计费」（着色或同等的直观区分），让用户一眼看出该次调用的前缀是否省钱。判据 SHALL NOT 使用 truthiness——`cache_hit: 0` 恰是"本次全量计费"，SHALL 照常展示（这是最该被看见的一态）。`usage.in` 为 0 时 SHALL 只展示绝对 tokens、不做除法。字段缺失时 SHALL 降级省略展示，SHALL NOT 以 0 或推断值冒充。

run 级的累计缓存命中 SHALL 由共享派生层从**当前 run 文件自有的**各 llm.call 的 usage 现算（不含祖先共享前缀的调用；沿既有「聚合数字从 spans 现算」纪律，不持久化缓存），并 SHALL 在 run 列表条目与既有 token 合计同行展示；无任何命中数据时 SHALL NOT 展示（未知 ≠ 0）。

**仅 tool_result 分叉**（即共享前缀、缓存提示才有意义的唯一形态）的确认编辑器 SHALL 在当前运行配置的 `model` 与父 run 录制的 `model` 不一致时给出信息性提示（缓存可能不命中、计费口径可能变化）；该提示 SHALL NOT 拦截或改变 fork 的既有门禁，prompt fork 与代理 messages 分叉 SHALL NOT 加此提示。

#### Scenario: llm.call 详情展示缓存命中

- **WHEN** 选中一次 `usage` 含 `cache_hit: 800`、`in: 1000` 的 llm.call
- **THEN** usage 区展示缓存命中 800 tokens（占比 80%）并以直观视觉强调命中为主

#### Scenario: 零命中仍展示为全量计费

- **WHEN** 选中一次 `usage` 含 `cache_hit: 0`、`in: 1000` 的 llm.call（DeepSeek 未命中时的常规返回）
- **THEN** usage 区展示缓存命中 0 tokens，并以视觉强调「全量计费」（SHALL NOT 因 `0` 为假值而省略该行）

#### Scenario: 少量命中不得被称为全量计费

- **WHEN** 选中一次 `usage` 含 `cache_hit: 128`、`in: 323` 的 llm.call（实测真机数据）
- **THEN** 展示 128 / 323（40%）与 miss 195，措辞表明"部分命中、多数输入仍按全价计费"，SHALL NOT 写成"全量计费"（命中即已省钱，措辞不得夸大成本）

#### Scenario: 无缓存字段的调用降级

- **WHEN** 选中一次 usage 无 `cache_hit` 的 llm.call（老 trace 或不支持缓存的 provider）
- **THEN** usage 区不展示缓存命中行，不报错、不显示 0

#### Scenario: run 级累计现算

- **WHEN** 打开一个含 3 次 llm.call（其中 2 次带 `cache_hit`）的 run
- **THEN** run 列表条目中的累计缓存命中等于 2 次 `cache_hit` 之和（只算当前 run 文件自有 spans），随数据变化即时反映，无持久化缓存参与

#### Scenario: fork run 的累计不含祖先前缀

- **WHEN** 打开一个 fork run，其展开轨迹含祖先共享前缀中带 `cache_hit` 的 llm.call
- **THEN** run 级累计缓存命中只统计本 run 新增的 llm.call，祖先前缀调用的命中不计入（展开视图中它们各自的单 span 详情照常展示自己的缓存命中）

#### Scenario: tool_result 分叉的模型不一致提示

- **WHEN** 用户在 tool_result 分叉编辑器（「在此重跑」）中，运行配置的 model（如 deepseek-chat）与父 run 在该 step 录制的 model（如 glm-flash）不一致
- **THEN** 编辑器显示缓存可能不命中的信息性提示，用户仍可确认执行 fork，既有校验与执行路径不变；模型一致时 SHALL NOT 显示该提示

#### Scenario: 其它分叉形态不加缓存提示

- **WHEN** 用户打开 prompt fork 编辑器或代理 messages 分叉入口
- **THEN** 界面 SHALL NOT 出现模型缓存提示（这些形态不共享前缀，提示无意义）

