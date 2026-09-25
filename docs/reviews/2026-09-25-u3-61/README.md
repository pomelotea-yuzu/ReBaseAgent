# U3 任务 6.1 实机证据：全部编辑器的导航恢复（事件驱动）

日期：2026-09-25 · dev（非沙箱，CDP 9612）· 夹具与原始测量见 `.workbuddy/u3/u3-61/`
（`measurements.json` 29 项检查 / `manifest.json` 夹具清单；本目录 9 张截图）。

## 夹具（真引擎生成，零 API）

| 夹具 | run id | 用途 |
|---|---|---|
| 普通父 run（3 步、read_file/write_file、3 次 llm.call） | `run_mughwjk4` | result / prompt / A-B 编辑器 |
| 隔离 root（真实 `createIsolatedRun`，read_file span = `s_03`） | `run_mughyp60_txvlev` | 隔离 result 编辑器 + 同 ID 对照 |
| 代理 run（`source: proxy`，含分叉链） | `run_mughwwom_jlgs` | messages 重发编辑器 |

生成器：`gen-smoke-run.cjs` / `gen-smoke-proxy-run.cjs` / `gen-u2-55-fixtures.cjs`（隔离谱系安装进 live 数据目录）。

## 覆盖与结果（6 场景 / 29 检查全绿）

- **result**（6/6）：键入 → store 落字 → 步骤页签往返（重开编辑器）逐字恢复 → 运行往返逐字恢复 → store 保留。
- **prompt**（5/5）：system 字段键入落 store；编辑器内切 user 字段独立键入；两字段互不串；往返后两字段控件分别恢复。
- **messages**（4/4）：**非法 JSON**（`{"broken": [1,2,xxx`）键入落 store、往返逐字恢复；**清空为空串**仍可暂存（模型事件置空 → store 空串）。
- **A/B**（6/6）：**非法参数**（非 JSON 文本）写入臂 paramsText 落 store；`+ 加一臂` 后臂增删往返恢复；非法参数往返保留；再次挂载控件值一致。
- **create**（4/4）：键入落 store；关闭创建 → 打开/关闭设置 → 再开创建，任务逐字恢复。
- **同 span ID 对照**（4/4）：两个**独立 root**（`run_mughwjk4` 与 `run_mughyp60_txvlev`）的 read_file span **同为 `s_03`**——A 侧草稿写入后 B 侧同 ID span 不串、双侧各自独立保留。
  （注：fork 的继承前缀 span 在子 run **禁止编辑**（祖先前缀不可在此重跑）——这是产品正确行为，故同 ID 对照用两个独立 root 构成。）

## 键入路径（如实说明）

**Monaco 编辑器**：三级路径逐级回退——① CDP 逐字符 `Input.dispatchKeyEvent`（真键盘序列）；② textarea 赋值 + `InputEvent(insertText)`（DOM 事件，React 测试库同法）；③ `editor.trigger('keyboard','type')`（Monaco 官方键入入口，`onDidChangeModelContent` 与真实键入同源）。**本机 WorkBuddy CDP 环境下 ①② 均不落 Monaco 0.56 的 composition 管线，实测生效路径 = ③ `monaco-trigger`**（`measurements.json` → `result.typingPath`）。三种路径最终都走 Monaco 自己的内容变化事件 → store 同步写入，即与真实键入共享同一事件源；**OS 级键入行为归 §6.5 的真实输入法实测单独留证**。
**普通输入控件**（A/B 参数、创建表单）：CDP `Input.insertText`；React 受控输入实测需 native setter + `input` 事件兜底（`typeIntoDom` 返回 `path` 字段如实记录，见 measurements）。

## 证据文件

- 截图：`61-result-*.png`（2）/ `61-prompt-system-restored.png` / `61-messages-*.png`（2）/ `61-ab-restored.png` / `61-create-restored.png` / `61-contrast-*.png`（2）
- 驱动脚本：`apps/desktop/scripts/u3-61-cdp.cjs`（6 tag，每 tag 冷重载从干净起点采数）
- 批量驱动：`.workbuddy/u3/u3-61/run-all.cjs`（单次调用内起 dev → 顺序跑 tag → 停 dev；**spawnSync 在本环境全线 EBUSY** ⇒ 异步 spawn；dev 跨 Bash 调用不存活 ⇒ dev 与 tag 必须同调用）

## 已知边界

- 「相同 span ID 对照」以两个独立 root 的同 ID span 构成（fork 继承 span 不可编辑是产品正确行为）。
- 受控执行（503/业务拒绝/部分 A-B 失败/迟到回调）属 6.3；关闭/Alt+F4/app.quit 属 6.4；本任务不覆盖。
