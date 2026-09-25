# U3 任务 6.11 — 零调用 / 逐文件哈希 / 无草稿持久化的实机验收（2026-09-26）

> 验收（tasks 6.11）：草稿不会跨 renderer 会话持久恢复 / 草稿操作零执行且已有文件不变 /
> 原有执行入口和文件阅读继续可用。对应 spec delta Requirement
> 「草稿交互保持既有执行和数据边界」两场景与 design「无磁盘迁移 / 使用隔离数据、
> 逐文件核对哈希 / 重启时草稿不恢复，磁盘无新增草稿内容」。

## 一、机制与口径

- 冻结面（同 U2 5.5 口径）：**live traces + workspace-blobs + 源目录 + settings.json**
  逐文件 SHA-256 前后 diff=[]；traces 文件计数前后一致。
- 「零执行」双硬证：**受控服务（mock-llm-server，进程内起停）`entries()===0`** +
  冻结面零变化（工具执行只会经 fork/续跑发生，草稿操作不生成任何 run 文件）。
- 「无草稿持久化」三面扫描：`.rebaseagent` **全树逐文件 utf8 含标记子串**、
  **localStorage + sessionStorage** 双 store 含标记、重开编辑器/重开对话框看**值**。
  标记 = 每轮随机 stamp，草稿正文一律带标记写入。
- 「取消退出」走真通道：dev-only 哨兵 `REBASEAGENT_SMOKE_QUIT_FILE` → 真 `app.quit()` →
  真 `#32770` 确认框（UIA `dialog-text` 找「返回」→ `dialog-click`）→ 应用存活 + 草稿保留。
- 重启语义 = **run-all 每 tag 全新 dev 进程**（`restart-pre` 放草稿落 handoff.json，
  下一个 tag `restart-post` 在新进程验证）；重载语义 = 真 `Page.reload`（文档轮换）。
- ⚠️ reload 后 CDP 真鼠标失效（6.10 实测）⇒ reload 后的 UI 驱动一律程序化 click。

## 二、结果（`apps/desktop/scripts/u3-611-cdp.cjs`，5 tag / **45 检查 / 0 失败**）

| tag | 检查 | 覆盖 |
|---|---|---|
| `zero-exec` | 15/15 | 五通道草稿全操作（result 输入+页签往返+放弃-取消+收起、prompt 两字段、messages 非法 JSON 暂存、A/B 改参+放弃整批-取消+收起、创建输入+关闭重开恢复+列表复制+定位自动打开）+ **取消退出**（dirty+真 app.quit ⇒ 原生确认「返回」⇒ 应用存活、三区草稿原样）⇒ 受控服务 0 请求、冻结面 diff=[]、traces 126→126、web storage 零标记；每步 dump dialog 集合防「意外模态」 |
| `reload` | 9/9 | 三区真草稿 → 真 `Page.reload` → store 全空（calls={}/modelAb={}/create=null）、徽标无 dirty、重开编辑器=原值且只登记基线、`.rebaseagent` 全树零痕迹、web storage 零痕迹、traces 计数不变 |
| `restart-pre` | 2/2 | 放三区草稿 + 标记/计数落 handoff.json |
| `restart-post` | 6/6 | **新进程**：三区全空、磁盘全树零痕迹（无草稿持久化文件）、徽标干净、重开编辑器=原值、traces 计数与重启前一致 |
| `regression` | 13/13 | U1 页签/选中 span 往返恢复；U2 隔离子 run 文件页签、列表渲染（默认检查点 auto 过滤筛空 ⇒ 先「查看全部」）、选择写入阅读状态、页签往返 path 保持、文件正文渲染；五个执行入口在场（result/prompt/messages/A-B/隔离续跑——逐工具行尝试，前缀行显示禁用说明属预期）；本会话零草稿操作 ⇒ 三区全空（历史草稿零泄漏） |

截图 5 张（本目录）；测量明细 `.workbuddy/u3/u3-611/measurements.json`。

## 三、本轮**零产品代码改动**

6.11 全部判据在现有实现上直接成立（草稿三区纯内存、无落盘路径；执行只经既有通道）。
harness 侧修了 4 类自身缺陷（见 §四），其中两条曾造成**假失败**、一条造成过**假通过方向的风险**。

## 四、harness 事实与坑（后续复用必照）

1. 🔴 **IIFE 括号错位 ⇒ 表达式求值出函数对象**：`(() => expr())` 与 `(() => expr)()` 一字之差，
   后者返回函数 ⇒ `=== true` 恒假、判据**静默假阴**。修法＝`ev()` 加自防御
   （`result.type === "function"` 直接抛）。6.11 的 A/B 入口检查真实踩过。
2. **`clickSpan` 的 title 过滤必须排除 `header`**：GlobalBar「运行配置」按钮 title 含
   「配置 LLM 接入…」⇒ 含 `LLM` 的片段先命中它 ⇒ **设置模态被静默打开**、其后所有真鼠标
   点击被 `::backdrop` 吞掉（6.8/6.10 的 LLM span 场景同样中招；对已出结论无影响——
   top layer 不改变底层布局，但本轮起 harness 一律 `closest('header') === null` 过滤，
   且 zero-exec 每步 dump dialog 集合防复发）。
3. **真鼠标点击前必须 `scrollIntoView({behavior:'instant'})` + 稳定后取 rect +
   `elementFromPoint` 命中校验，不过就抛错**（盲点会把点击落在别的控件上——上面「误开设置」
   的第二种成因）。
4. 文件页默认检查点=「本 run 初始状态」时 auto 过滤筛空（夹具文件相对初始无变化）⇒
   先点「查看全部」再数 `role=option`。
5. desktop 全量首轮 2 条 `controlled-entrances` 红（`served()=0`）为**环境 flake**
   （紧邻 run-all 的 mock 端口起停），未改一码复跑 80/1525 全绿——如实记录。

## 五、变异（3 处全捕获，`u3-611-mutate.cjs`，注入→判红→还原零残留）

| # | 注入 | 期望 | 实测 |
|---|---|---|---|
| A | `writeCreateRunDraft` 每次改动镜像 localStorage | web storage 零标记判红 | zero-exec `localStorage+sessionStorage 零草稿标记` 红（14/15） |
| B | `writeCallDraftText` 每次改动顺手 `saveSettings` | 冻结面 diff=[] 判红 | `["settings:settings.json"]` 红（14/15） |
| C | result 草稿经 sessionStorage 跨重载复活（store 镜像 + 打开时回灌） | reload 不恢复判红 | **3 条红**（重开=原值、只登记基线、web storage 零痕迹），reload tag 6/9 |

还原后 `git diff apps/desktop/src` 零残留；正式整跑（最终代码态）5/5 全绿。

## 六、门禁（本轮实测）

- desktop 全量 **80 文件 / 1525 用例 / 0 失败**（复跑口径，见 §四.5）
- `biome check .` 仓库根整跑 **367 文件 0 错**
- `openspec validate preserve-debugging-drafts --strict` valid
- 零产品代码改动 ⇒ tsc/build 沿用上轮绿态（`git diff apps/desktop/src` 为空可证）
- 日志：`.workbuddy/u3/u3-611/{desktop-full.log,biome.log,openspec-strict.log,measurements.json}`
