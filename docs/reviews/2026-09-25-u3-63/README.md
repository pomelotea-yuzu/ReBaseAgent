# U3 任务 6.3 实机证据：受控执行覆盖全部入口 + 503/业务拒绝/部分 A-B 失败 + 卸载重挂/迟到回调

日期：2026-09-25 · dev（非沙箱，CDP 9612，`REBASEAGENT_SMOKE_PICK_DIR` 指向本 change 的隔离源目录）
驱动：`apps/desktop/scripts/u3-63-cdp.cjs`（**11 tag / 103 检查 / 0 失败**，EXIT=0）
批量驱动与门禁：`.workbuddy/u3/u3-63/run-all.cjs` · `.workbuddy/u3/u3-63/gates.txt`
原始测量：`.workbuddy/u3/u3-63/measurements.json`（含受控服务请求日志与 `window.confirm` 应答流水）；本目录 11 张截图。
夹具：复用 6.1 的 manifest（普通父 `run_mughwjk4` / 隔离 root `run_mughyp60_txvlev` / 代理 `run_mughwwom_jlgs`）。
零付费：所有模型调用打到**进程内起的**受控服务 `scripts/mock-llm-server.cjs`（剧本制，端口 18799；
录制代理 upstream 按真实口径填**不带路径**的地址）。

## 纪律

真点击 / 真键入 / **真原生模态应答**（`window.confirm` 经 CDP `Page.javascriptDialogOpening` 观察并应答，
流水落 measurements）；真 store、真 Monaco 读回；执行走真 IPC（renderer → main → `OpenAiCompatClient` → 受控服务）；
提交值一律以**落盘 trace 的 `fork.edit.value`** 或受控服务收到的请求体核对，不看界面自述；
每 tag 冷重载从干净起点开始，自行配置 settings/代理并收尾复位；不改产品代码（唯一一处产品改动见下「抓到的缺陷」）。

## 逐入口覆盖（tasks 6.3 的「覆盖所有入口」）

| 入口 | tag | 结果 |
| --- | --- | --- |
| result 时间旅行（普通父本） | `result` 9/9 | 空 fork 禁用提交 → 键入落 store → 真点「确认重跑」→ 登记关联（通道 `result`、修订与快照=草稿）→ 解冻 → 子 run 落盘且 `fork.edit.value` **逐字等于快照**；既有 trace 逐文件哈希不变 |
| prompt fork（system 字段） | `prompt` 6/6 | 原生确认「确认从头重跑？」真出现并被接受；子 run **首次请求的 system 消息 = 提交快照**（模型真收到）；成功后草稿保留 |
| messages 重发（代理通道） | `messages` 15/15 | 起代理（走 store 真动作，界面 `proxy.running` 同源）→ 经代理真跑一次录制出父 run 并捕获 key → 编辑 messages → 重发成功且落盘 `edit.value` 结构逐字段一致；**关代理后**：UI 禁用并写明「代理未运行」，越过 UI 直调同一执行函数仍被 main 以 `PROXY_NO_KEY` 拒绝（渲染层禁用不是安全边界），零请求、解冻、草稿逐字保留 |
| A/B 整批 | `ab` 13/13 | 未声明副作用 ⇒ 预览禁用；未预览 ⇒ 执行禁用；**预览（dry-run）零模型调用且不登记关联**；勾选后真点执行 ⇒ 整批冻结、在飞期间**切页签卸载编辑器**后关联仍在、拒绝改行与按旧修订放弃；两臂真实调用、同实验组落盘、请求体 model 与批次快照逐字对上；成功后整批保留 |
| 创建（纯对话 + 隔离整份） | `create` 15/15 | 空表单禁用提交；纯对话创建登记整份关联、任务原文到达模型、草稿保留；隔离创建产出 v2 隔离 run；**重开恢复目录引用但授权复位**（勾选=未选、按钮变「重新选择…」）；再次提交**已消费 token** ⇒ `INVALID_SOURCE_TOKEN` 业务拒绝、零请求零新 run、任务不清空、引用被清除要求重选 |
| 隔离续跑（result 隔离路径） | `isolated` 8/8 | 未预检禁用 → 真预检显示轮末检查点 → 未授权继续禁用 → 授权后提交成功；子 run `workspace.origin=checkpoint` 指父；重开重新预检后**授权仍复位**、草稿保留、未授权提交继续禁用 |

## 故障与拒绝面

- **503（`fault` 8/8）**：剧本 `mode:fail + status:503` 注入 ⇒ 失败 run 仍正常封存落盘、`llm.call.error.status=503`、
  列表当场可见、解冻、草稿保留、原生确认未被绕过。
- **业务拒绝（`business` 9/9）**：`SETTINGS_NOT_CONFIGURED`（清配置后提交）+ 本地拒绝（messages 非法 JSON：
  即刻收尾、零请求、无损字符串草稿保留）+ **取消确认**（`setAccept(false)`，明确未发请求 ⇒ 不留冻结、零新 run、草稿保留）。
- **部分 A/B 失败（`ab-partial` 7/7）**：臂 A 成功、臂 B 首轮 503 ⇒ 两条都落盘但结局分别为 `completed` / `error`，
  整批仍是「明确返回」⇒ 解冻并保留；界面播报「成功 1 臂（共 2 臂，其余失败或被取消）」。
- **未知态与迟到回调（`fault` + `late` 8/8）**：迟到响应用 6s 延迟剧本造在飞窗口——
  ① 在飞期间同目标**重复登记被拒且不换令牌**（旧响应的收尾只命中自己那次关联）；
  ② 冻结期写入被 store 拒绝（修订不推进）、按旧修订的放弃返回 false；
  ③ 页内注入「旧令牌收尾」⇒ 冻结**不**被错误解除、期间写入仍被拒，同令牌收尾才解冻；
  ④ 解冻后重挂编辑器恢复草稿全文。

## 原有能力未回归（`regression` 5/5）

五个执行入口（时间旅行 / 隔离续跑 / prompt fork / messages 重发 / A/B）+ 创建入口全部可达；
隔离 run 的「文件」页签仍可打开、检查点选择器渲染、清单与内容读取 IPC 真读回内容（U2 阅读面未坏）。

## 抓到的真实缺陷（已改代码，非放宽判据）

**A/B 部分臂失败被播报成「全部成功」**：内核 `modelReplayRunMany` 已按终止事件逐臂判失败（provider 错误不抛异常，
失败臂同样落盘），但 `apps/desktop/src/main/fork-runner.ts` 组装 `ModelAbResult.ids` 时只过滤「id 非空」⇒
界面按 `ids.length` 报「成功 2 臂」。实机 `ab-partial` 首轮即暴露（磁盘一条 `completed`、一条 `error`，界面说成功 2）。
修法＝`ids` 只取 `error === null` 的臂（`ids` 的既有唯一消费者就是那句「成功 N 臂」，失败臂仍可从列表/分支树进入）。
补单测 `controlled-service.test.ts`「部分臂失败：ids 只计成功臂…」（注入退回旧写法 ⇒ `expected 2 to be 1` 变红，还原复绿）。

## 顺手收的门禁债

`biome check .` 按**仓库根**整跑时发现 21 处既有违规全在 6.1/6.2 的 harness 里（`useOptionalChain` /
`noUnusedTemplateLiteral` / `useTemplate` / format）——当时只跑了改动文件，正命中 §九 记过的老坑。
本轮一并修掉，并**复跑两套既有验收**证明未改坏：6.1 复跑 6 tag / 29 检查全绿、6.2 复跑 5 tag / 20 检查全绿。

## 复现命令

```bash
# 非沙箱单次调用内起 dev + 跑全部 tag + 停 dev
node .workbuddy/u3/u3-63/run-all.cjs                    # 11 tag
node apps/desktop/scripts/u3-63-cdp.cjs --tag=late      # 单 tag（需 dev 已在 9612 且带 SMOKE_PICK_DIR）
cd apps/desktop && ./node_modules/.bin/vitest.CMD run   # 79 文件 / 1511 用例 / 0 失败
```
