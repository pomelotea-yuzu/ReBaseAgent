# U4 任务 6.6 — 同 main 重载 vs 真 main 重启（epoch/槽/真实调用次数/旧响应行为，2026-09-27）

采集：`apps/desktop/scripts/u4-66-cdp.cjs`（4 tag：`probe` / `reload-running` / `out-of-order` / `main-restart`）
驱动：`.workbuddy/u4/u4-66/run-all.cjs`（备份 settings → 起 dev(9612) → 顺序跑 tag → 停 dev → 无条件还原 settings）
读数：`.workbuddy/u4/u4-66/<tag>-measurements.json`；截图：本目录 `66-*.png`

## 一、结论

**4 tag / 82 检查 / 0 失败**，还原产品代码后**整跑两次都是 4/4 通过**（`gates.txt` 同目录），零产品代码改动。
覆盖 delta 的三条逐字场景：

| 场景（spec 原文） | 落在哪个 tag | 关键判据 |
| --- | --- | --- |
| `同 main 重载恢复操作` | `reload-running`（28 条） | epoch 不变、main 槽未易主、新 renderer 首次握手即采纳在飞槽、门禁仍按 main 拒绝、零重放 |
| `乱序快照不回退新状态` | `out-of-order`（15 条） | 并发刷新期间采纳版本单调不减、槽不被旧快照抹成空闲、风暴后采纳值 = main 当前值、重载后按身份恢复既有终态 |
| `新 main 会话不伪造旧操作结局` | `main-restart`（25 条） | 新登记一份记录都没有、旧 epoch 的核对/提交整份拒绝且零副作用、旧 ID 只以「未接受」呈现、锁只按新 main 的空槽判定 |

`probe`（14 条）不含新判据，只把两条**决定判据怎么写**的实机原语量出来：真重启（杀进程树→等端口→起新→重连）
与"桥接面可直发任意载荷、但不可包装属性"。

## 二、三条实机口径（与 6.5 的"桥接面注入做不到"并列，后续批次照此写判据）

1. **真 main 重启是可脚本化的**，且不牺牲计数可比性：受控服务起在 tag 进程内 ⇒ 重启 dev 不动它，
   重启前后的模型请求计数直接可比。停/起都走 `u2-dev-host.cjs`（`--stop` 按 pid 文件
   `taskkill /T /F` 整棵进程树，**不按映像名**——WorkBuddy 本身也是 electron.exe）。
   实测：端口空出 0.5 s、新 dev 3 s 监听、重连后 `runs` 可读（工作区指针在盘上，不需重开目录）。
2. **"真在飞"要量出来，不能靠 sleep**：登记 `running` ≠ 请求出了门。第一版拿 `served >= 1` 当基准，
   而那次基准提交已经占掉了 1 ⇒ 判定秒过 ⇒ 杀进程时请求还没出门 ⇒ 打断点假了。
   现在等 `served >= servedBefore + 2` 才杀，实测打断点落在"模型正在回答"上。
3. **`Page.reload` 会偶发不换文档**（本批最重要的一条，见第四节）⇒ 所有"重载后"判据在
   文档没换时空转全绿。现在 `reloadAndWait()` 导航前挂 `window.__u466Doc`，导航后读回来还在就抛错。

## 三、按层交付（真机测到了什么，什么仍归单测）

- **真机覆盖**：登记跨重载存活与恢复、门禁由 main 的槽派生（不是"界面记得"）、
  重载/重启**不重放请求也不重放文件**、`OPERATION_DUPLICATED` / `OPERATION_CONFLICT` /
  `OPERATION_NOT_ACCEPTED` 三类旧身份重放在**跨重载**后仍按身份判定且不改写原登记，
  `OPERATION_STALE_EPOCH` 在**跨真重启**后对核对与提交都成立且零副作用。
- **仍归 §4 单测层**（不冒充实测）：
  - 「status 载荷非法 ⇒ 整份拒收」「通道失联 ⇒ 保持未知」——`window.api` 属性
    `writable:false / configurable:false`（6.5 `probe` 实测），真机改不了返回值；
  - 「换 epoch 的旧提交只进未知历史、不参与门禁」——renderer 随 main 一起死，
    真机上凑不出"同一 renderer 里同时有跨 epoch 在飞关联"这个前提（`stalePendingOf` /
    `hasSameEpochPending` 由 §4 用例承载）；
  - 「核对只解冻匹配那一条」的**跨 epoch** 分支：6.5 的 `lock-isolation` 已在真机证了
    同 epoch 那一条（M-65B 摘掉接线 ⇒ 3 条判红），跨 epoch 需要上面那个凑不出的前提。
- **本批上真机、且原以为只能留在单测的**：status 的代次/版本两条迟到守卫（见第五节 M-66E）。

## 四、本批抓到的是一个**采集面**缺陷，不是产品缺陷

第一次跑 M-66D（摘掉挂载时的补握手）时 `out-of-order` **15/15 全绿**——按判据这不可能。
排查过程（`.workbuddy/u4/u4-66/reload-probe.cjs`）与结论：

- 页内 `window.__alive` 在 `Page.reload` 后为 `null` ⇒ 文档**确实**会换；
- 服务中的 `store.ts` 就是磁盘上那一份（用 `fetch(url,{cache:'no-store'})` 与 node 侧各取一次比对函数体；
  ⚠️ 别用"注释里有没有变异标记"来判断——**Vite 的 transform 会把注释整段剥掉**，这条路量不出 staleness）；
- 挂上 `console.log` 栈探针后确认：握手来源只有 `App.tsx` 挂载时那次 `ensureOperationStatusPolling`，
  摘掉它之后 reload 后读到 `epoch:null / v:0` ⇒ **变异确实生效**；
- 也就是说：变异生效、上下文换新、握手只有一条来源，三件事同时成立时 `out-of-order` 判红 5 条。
  第一次那轮全绿只剩一个解释：**那一次 `Page.reload` 本身没换文档**，旧 store 的状态一路带到最后
  （"重载后 epoch 不变/槽还在"于是全都凭空成立）。
  诱因怀疑是同一条 ws 上挂着一个 25 s 不返回的 `awaitPromise` evaluate（用纯 `setTimeout` 替身复现不出来，
  ⇒ 只登记为未证实的怀疑，不当结论用）。

这类"判据空转"比红更危险，因为它会绿。修法就是第 2.3 条的活体标记：`reloadAndWait()` 现在
导航前写 `window.__u466Doc`、导航后读回来还在就**直接抛错**，不给空转的机会。
加标记后重跑 M-66D ⇒ **5 条判红**；还原产品代码后整跑 4/4 全绿（这一轮才是本批的正式读数）。

## 五、变异反证（每条都为判据的牙齿负责，无牙的也照记）

| 变异 | 位置 | 结果 | 归因 |
| --- | --- | --- | --- |
| M-66A | `operation-endpoints.ts` 把 reconcile 的旧 epoch 守卫条件改恒假 | `main-restart` **2 条真判红** + 1 条连带 | 真红：①"旧 epoch 的核对被整份拒绝"②"零副作用：不建封禁"（登记里凭空多出 `reconcile_tombstone`）。第 3 条红（旧 epoch 提交）是②的连带（`count` 已被污染），非独立证据 |
| M-66B | `exec-endpoints.ts` 摘掉执行入口的旧 epoch 守卫 | `main-restart` **3 条判红** | 旧 epoch 的提交**真的被执行**（回执带 `id:"run_…"`），并连锁打穿"合计零模型请求"与后一条计数判据 ⇒ 「新会话不认领旧请求」这条是真判据 |
| M-66C | `operation-registry.ts` 把「同 ID 同参」不再认成重复 | `reload-running` **1 条判红并中止**（23/28 跑到） | 重放不再返回 `OPERATION_DUPLICATED`，而是进入接受序列，被登记不变式当场挡下（invoke 抛 `同一 operationId 重复登记`）。牙齿咬住了，但归因方式是"中止"而不是"具体那条红"——记在此处以免被当成精确证据 |
| M-66D | `store.ts` 摘掉挂载/重载的补握手 | `out-of-order` **5 条判红** | epoch 未采纳、版本停在 0、重载后按身份恢复失败、自动核对不推进 ⇒ 「同 main 重载恢复操作」的真机面确实依赖这一次握手 |
| M-66E | `applyStatus` 的"低登记版本整份丢弃"守卫恒不触发 + 代次守卫恒等于最新 | `out-of-order` **2 条判红** | 红因是**旧快照把已推进的状态压回去**：界面停在 `v10/running` 而 main 已到 `v11/settled`，60 s 内不再推进 ⇒ 回退不只是"看见旧值"，它还把后续采纳链钉死。**修正**：`probe` 量的 FIFO（并发 8 条 status 乱序 0 次）只是 main 侧应答顺序，renderer 侧多条请求链交错仍能后发先至 ⇒ 这两条守卫在真机**有牙**，不再按"只能单测"分层 |

## 六、门禁与清理

- **正式读数是"还原后连跑两次"**：两轮都 4/4、82 检查 0 失败，且 `reloadAndWait` 的活体标记
  一次也没触发（⇒ 第四节那次空转是偶发，但判据已经不再依赖运气）。
- `apps/desktop` vitest：**103 文件 / 1828 用例 / 0 失败**（本批零产品改动 ⇒ 与 6.5 收尾同一批数）
- `tsc --noEmit -p tsconfig.node.json` / `-p tsconfig.web.json`：均 0 错
- 根 `biome check .`：**417 文件 0 错**（新增 1 个脚本文件）
- `openspec validate add-desktop-operation-tracking --strict`：**valid**
- 驱动收尾无条件还原 `settings.json`；本批产出的 run 靠正文里的 `U4-66` 标记识别并在下次起跑前清理
  （`.rebaseagent/traces` 里遗留的 6 份属采集产物，非用户数据）
