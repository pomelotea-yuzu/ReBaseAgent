# U3 实施任务

当前仅完成 change 编写，以下实施与验收任务全部待办。基线为已归档 U1/U2；不把旧走查或文档校验算作实施证据。每项预算不超过 2h，超过先拆分；场景名均引用 [desktop-ui delta](specs/desktop-ui/spec.md)。任务完成须有真实消费路径和可复核断言，不能以纯函数存在或字符串快照代替界面接线。

## 1. 草稿状态与身份

- [x] 1.1 实现 result/prompt/messages 草稿键、基线和无损字符串存储，同步写入 store 并保持选择器引用稳定（<=2h）。验收：相同 span ID 和不同字段不串草稿 / 非法 JSON 和空输入仍可暂存。
- [x] 1.2 实现单调 revision、dirty 派生、回基线及按 key/revision 的放弃校验，不自动淘汰 dirty（<=2h）。验收：修订不因删除重建而复用 / 旧放弃确认不能删除新修订。
- [x] 1.3 添加类型化创建与 A/B 批次状态、稳定行 ID/顺序，独立保存创建目录引用，排除授权/凭据/计划（<=2h）。验收：切创建模式保留文本而放弃重置表单 / 实验臂增删和非法参数可恢复 / 设置凭据与调试草稿分离。
- [x] 1.4 将草稿存储与阅读缓存、详情/列表刷新分离，保存源基线，恢复时重验首次调用身份及既有能力，不新增算法版本签名（<=2h）。验收：源记录缺失损坏或发生改变 / 阅读回退不删除草稿且重新校验才能执行 / prompt 和实验恢复重验首次调用资格。

## 2. 现有编辑入口接线

- [x] 2.1 工具结果编辑器改读写 store，普通/隔离共用保留规则，去除重新打开时覆盖输入（<=2h）。验收：result 草稿经步骤页签和运行往返逐字恢复 / 关闭编辑与设置往返保留内容。
- [x] 2.2 prompt 两字段和代理 messages 接入无损草稿，字段切换保留独立值并沿用原校验（<=2h）。验收：相同 span ID 和不同字段不串草稿 / 非法 JSON 和空输入仍可暂存 / 无变化与空字符串按各字段契约处理。
- [x] 2.3 创建表单恢复模式/任务/system，关闭/设置往返保留，显式放弃重置；保留原忙碌关闭限制（<=2h）。验收：创建关闭配置再新建仍有任务 / 切创建模式保留文本而放弃重置表单。
- [x] 2.4 A/B 现有编辑器接入批次状态，增删行/参数保持原始输入，恢复时清理临时计划和许可（<=2h）。验收：实验臂增删和非法参数可恢复 / 实验预览和结果不隐式清理批次。
- [x] 2.5 接通调用草稿标记、本运行与全会话草稿入口、精确目标定位及失效来源的复制/放弃视图（<=2h）。验收：草稿列表返回精确编辑目标 / 源记录缺失损坏或发生改变。
- [x] 2.6 实现原值/草稿核对与响应式排列、收起及按修订明确放弃；空串变更同样确认（<=2h）。验收：放弃可取消且只影响指定目标 / 旧放弃确认不能删除新修订 / 宽窄窗口均可核对完整编辑内容。

## 3. 授权与提交关联

- [x] 3.1 result 恢复/变化/离开后重新预检，副本授权只用于当次提交，守卫迟到预检（<=2h）。验收：隔离编辑恢复后重新预检授权 / 迟到检查不覆盖草稿（隔离预检）。
- [x] 3.2 创建 sourceToken 独立受限引用接线，保留有效选择、切模式清除、无效令牌提示重选，目录选择使用请求代次（<=2h）。验收：sourceToken 在有效期内恢复但授权复位 / sourceToken 失效不清空任务 / 取消目录选择保留原引用 / 迟到检查不覆盖草稿（目录选择）。
- [x] 3.3 A/B 预览绑定批次修订/请求代次，内容变化或恢复后重新预览和副作用确认（<=2h）。验收：实验预览和结果不隐式清理批次 / 迟到检查不覆盖草稿（A/B 预览）。
- [x] 3.4 result/prompt/messages 提交绑定草稿快照并冻结，在 store 收尾，任何响应不清草稿（<=2h）。验收：提交快照独立于编辑器挂载 / 成功错误和部分失败均保留草稿。
- [x] 3.5 创建/A-B 接入同样的整份/整批关联，旧回调守卫及未知状态保留冻结，展示 reset 不解锁（<=2h）。验收：提交快照独立于编辑器挂载 / 成功错误和部分失败均保留草稿 / 迟到回调与未知状态不能错误解冻。

## 4. main 关闭协商

- [x] 4.1 定义严格元数据 schema（含 inputSettled）和 shared/preload 受限接口、订阅/解绑，main 验证 sender/frame/session/sequence（<=2h）。验收：旧会话伪造发送者和乱序消息不影响关闭 / 设置凭据与调试草稿分离。
- [x] 4.2 renderer 订阅 dirty 汇总，查询时同步控件/model 已接收输入，锁定新编辑并应答，取消后解锁恢复焦点（<=2h）。验收：最新 clean 应答才允许直接关闭 / 退出输入锁保留已接收文字且不重放按键（键入/粘贴）。
- [x] 4.3 补齐输入法组合中的锁前快照、inputSettled 和尾随收尾，锁内禁止新输入且不重放（<=2h）。验收：退出输入锁保留已接收文字且不重放按键（中文输入法组合）/ renderer 失联或应答无效仍有退出确认（输入未收尾）。
- [x] 4.4 main 窗口 close/app.quit 接新鲜查询、原生确认、正常取消与单次放行，明确不接入阻止系统结束会话的路径（<=2h）。验收：有草稿时关闭可返回或明确退出 / 最新 clean 应答才允许直接关闭 / 系统会话结束不沿用普通退出承诺。
- [x] 4.5 实现 1.5s 有界查询和 unknown 降级、迟到应答守卫；提示只说明暂时无法确认，不诊断存活状态（<=2h）。验收：renderer 失联或应答无效仍有退出确认 / 慢响应降级后可取消并重新核对。
- [x] 4.6 补齐关闭防重入、取消后的旧请求失效、递归 quit 与一次性 bypass 生命周期（<=2h）。验收：重复关闭取消和迟到应答不会重入 / 有草稿时关闭可返回或明确退出。
- [x] 4.7 处理 renderer 崩溃/重载会话失效、旧 dirty/unknown 标记、窗口重建与资源解绑（<=2h）。验收：重载不能用空仓库抹掉旧会话未知状态 / 旧会话伪造发送者和乱序消息不影响关闭 / 重复关闭取消和迟到应答不会重入。

## 5. 模态与键盘

- [x] 5.1 实现小型原生 dialog 模态包装，创建和设置接入 showModal、初始焦点及关闭恢复（<=2h）。验收：创建设置和放弃确认不泄漏焦点 / 创建忙碌期间不能通过焦点修复绕过关闭锁。
- [x] 5.2 放弃确认接模态包装，最上层 Esc、Monaco 弹层优先和触发点失效回退（<=2h）。验收：Esc 只关闭最上层并恢复焦点 / 放弃可取消且只影响指定目标。

## 6. 集成与实机验收

- [x] 6.1 准备真实读取可通过的普通/隔离/代理/A-B fixture、相同 span ID 对照与本地受控响应；事件驱动全部编辑器导航恢复（<=2h）。验收：result 草稿经步骤页签和运行往返逐字恢复 / 相同 span ID 和不同字段不串草稿 / 非法 JSON 和空输入仍可暂存 / 实验臂增删和非法参数可恢复。断言最后一次键入确实落入 store 和再次挂载的控件。
- [x] 6.2 Electron 复跑 R2、R10 与草稿列表/失效来源复制、放弃取消/确认路径并保存截图和输入对照（<=2h）。验收：创建关闭配置再新建仍有任务 / 草稿列表返回精确编辑目标 / 源记录缺失损坏或发生改变 / 放弃可取消且只影响指定目标。
- [x] 6.3 受控执行覆盖所有入口、503/业务拒绝/部分 A-B 失败、卸载重挂和迟到回调；校验真实 IPC 的提交值、授权复位与原门禁（<=2h）。验收：提交快照独立于编辑器挂载 / 成功错误和部分失败均保留草稿 / 迟到回调与未知状态不能错误解冻 / 原有执行入口和文件阅读继续可用。未知链路用故障注入，不发付费请求。
  证据：`apps/desktop/scripts/u3-63-cdp.cjs`（11 tag / 103 检查 / 0 失败）+ `docs/reviews/2026-09-25-u3-63/README.md`
  + `.workbuddy/u3/u3-63/{measurements.json,gates.txt}`；503 由受控服务剧本注入，零付费请求。
  抓并修 1 处真实缺陷：`fork-runner.ts` 的 `ModelAbResult.ids` 按「id 非空」计成功 ⇒ 部分臂失败被播报「成功 2 臂」，
  改为只取 `error===null` 的臂并补单测（注入旧写法 ⇒ `expected 2 to be 1` 变红）；
  另按仓库根整跑 biome 清掉 6.1/6.2 harness 的 21 处既有违规，并复跑 6.1（29 检查）/6.2（20 检查）证明未改坏。
- [x] 6.4 Electron 验证标题栏关闭、Alt+F4、app.quit 的 dirty/clean、取消/确认与连续关闭（<=2h）。验收：有草稿时关闭可返回或明确退出 / 最新 clean 应答才允许直接关闭 / 重复关闭取消和迟到应答不会重入。确认退出须观察进程/窗口真实结束，不能仅断言 guard 返回值。
  证据：`apps/desktop/scripts/u3-64-cdp.cjs` + `scripts/lib/u3-64-winops.ps1`（CDP × Win32/UIA 双通道，8 tag / 59 检查 / 0 失败）
  + `docs/reviews/2026-09-25-u3-64/README.md` + `.workbuddy/u3/u3-64/{final-run.log,gates.txt}`；关闭经真 `SC_CLOSE`/真 Alt+F4 按键/真 `app.quit`，
  确认框为真 `#32770`（UIA 读文案与按钮、BM_CLICK 真应答），退出判定只看窗口句柄与主进程 PID 真实消失，不看 guard 返回值。
  抓并修 1 处真实缺陷：窗口销毁后 `disposeIpc` 仍访问 `win.webContents` ⇒ 主进程未捕获异常弹「Error」框（干净退出被污染成一次询问），
  改为 `win.isDestroyed()` 时才跳过 webContents 解绑；验收钩子另加 dev-only `REBASEAGENT_SMOKE_QUIT_FILE` 哨兵文件触发 `app.quit`。
- [x] 6.5 Electron 验证最后一键/粘贴、中文输入法组合及其尾随事件，锁内新输入阻止、取消恢复与焦点（<=2h）。验收：退出输入锁保留已接收文字且不重放按键 / 最新 clean 应答才允许直接关闭。真实输入法实测单独留证，合成 composition 事件不能冒充系统输入法已通过。
  证据：`apps/desktop/scripts/u3-65-cdp.cjs` + `scripts/lib/u3-65-input.ps1`（keybd_event 真按键 / Set-Clipboard 真系统剪贴板 /
  GetGUIThreadInfo+ImmGetContext 输入法状态；6 tag / 47 检查 / 0 失败）+ `docs/reviews/2026-09-25-u3-65/README.md`
  + `.workbuddy/u3/u3-65/{run-final.log,gates.txt}`。真实输入法单独留证：`hkl=0x08040804` 下只发 ASCII 拼音与空格却产出汉字，
  全程不合成 CompositionEvent；锁内分「纯锁定期」与「确认框在场（不抬窗口）」两段各断言值不变与插入类事件被阻止。
  两条实现面事实留档（不改判据）：本机 Monaco 走 `native-edit-context` ⇒ document 级 `composition*` 事件 0 条、
  `inputSettled` 实际恒 true（本轮仍出 dirty 询问，但 D6 的 unknown 分支在真输入法下无触发路径，交 §7 决定）；
  未提交候选在确认框抢焦点时被输入法干净丢弃（不留裸拼音），已提交文字实测未被换回旧基线。
- [x] 6.6 独立 Electron 测试进程验证崩溃、失联、重载、旧/伪造消息；隔离事件测试核对系统会话结束边界，不触发宿主机注销/关机（<=2h）。验收：renderer 失联或应答无效仍有退出确认 / 重载不能用空仓库抹掉旧会话未知状态 / 旧会话伪造发送者和乱序消息不影响关闭 / 系统会话结束不沿用普通退出承诺。
  证据：`apps/desktop/scripts/u3-66-cdp.cjs`（5 tag / **64 检查 / 0 失败**：`crash-gone` 真 `forcefullyCrashRenderer` 崩溃、
  `hung-timeout` 真同步忙等冻结（不合成事件）、`reload-empty-repo` CDP 真重载 × 空仓库 clean 应答仍被降级询问、
  `forged-stale` 7 类伪造经真 preload 通道直发 + 反证收口（全被拒 ⇒ 零询问直退真实结束）、
  `session-event` 合成两种系统会话结束事件零确认零阻止 + 普通承诺随后成立）
  + `docs/reviews/2026-09-25-u3-66/README.md`（含 2 张确认框在场屏幕截取）+ `.workbuddy/u3/u3-66/{measurements.json,run-all.cjs}`。
  隔离事件测试：`test/u3-66-smoke-hook.test.ts` 8 用例（动作白名单/哨兵消费/**钩子文件零监听**的 D6 跨文件契约）。
  变异 6 处全捕获：单测面 4 处（`mutate.cjs`）+ 实机面 2 处（`u3-66-guard-mutate.cjs`：撤销轮换评估 ⇒ reload tag 判红；
  跳过 sessionId 校验 ⇒ forged tag 判红，exit=1）。新增 dev-only 钩子 `REBASEAGENT_SMOKE_EVENT_FILE`
  （`src/main/smoke-event-hook.ts`，只合成不监听、白名单外不执行、未设变量生产逐字节不变）。
  ⚠️ 抓到并修 harness 假绿通道：失联后无界 await ⇒ 事件轮排空 ⇒ **node 静默退 0**（判红信息全丢）
  ⇒ 全 CDP 求值 25s 有界 + 截图 15s race + 240s 看门狗 exit 3；后续"会弄死应用"的 tag 一律照此设界。
  sender/frame 冒名实机不可注入（Electron 注入事件对象，渲染层碰不到），由 guard 单测承载，README 已写明边界。
- [x] 6.7 注入小于/超过 1.5s 的应答延迟并辅以 CDP CPU 降速，记录超时提示、取消解锁、迟到应答和下次正常查询（<=2h）。验收：慢响应降级后可取消并重新核对 / 重复关闭取消和迟到应答不会重入。不以“慢 renderer 不能超时”为判据，不宣称开发机注入等同真实慢机校准。
  证据：`apps/desktop/scripts/u3-67-cdp.cjs`（3 tag / **38 检查 / 0 失败**：`slow-fast` 冻结 1.5s ⇒ 阈内慢应答被接受出
  dirty 确认不误降级；`slow-slow` 冻结 4s ⇒ 实测应答迟到 4001ms > 阈值 ⇒ unknown 超时提示（不宣称崩溃/失联）、
  连发关闭 6 采样至多一层、取消解锁、迟到应答解冻后零后续效果（不弹框/不关窗/草稿原样）、下次关闭 fresh dirty、
  放弃后 clean 直退；`cpu-throttle` 20× 降速绝不静默放行（1227ms dirty 如实记录，不设向、不宣称"慢 renderer 不能超时"））
  + `docs/reviews/2026-09-25-u3-67/README.md`（3 张截图含 unknown 超时提示在场）+ `.workbuddy/u3/u3-67/{measurements.json,run-all.cjs}`。
  延迟注入=真同步忙等冻结（不合成事件），应答时刻=页内真 preload 订阅记 `Date.now()`（与客户端 handler 同一次派发）。
  变异 2 处全捕获（`u3-67-flow-mutate.cjs`）：阈值 1500→100 ⇒ slow-fast 判红 exit=1（阈内应答被误降级）；
  1500→60000 ⇒ slow-slow 判红 exit=1（4s 迟到应答被提前接受出 dirty）。零产品代码改动。
  ⚠️ harness 新坑（3/3 复现）：**原生框"返回"首击可被吞**（winops `dialog-text` 增补 `dialog-hwnd` 取证：
  排空两轮同一 hwnd、after=1→0 ⇒ 同一层框未关，排除"产品重弹新框"）⇒ 取消类断言一律"点击-核对框数-重试"
  （`drainDialogs`），6.10 沿用；单发 `dialog-click + waitDialogGone` 会假判"无法取消"。
- [x] 6.8 真窗口/Monaco 验证 1440、1210、1024、800 CSS px 四档的完整原值/草稿核对，记录正文尺寸及截图（<=2h）。验收：宽窄窗口均可核对完整编辑内容（四档宽度）。
  证据：`apps/desktop/scripts/u3-68-cdp.cjs`（3 tag / **96 检查 / 0 失败**，零产品代码改动）：tool-result 四档 ×12/10/10/10 检查、
  prompt 四档（两字段独立草稿不串值 + 各档完整）、model-ab 两极端档；每档记录**实测** innerWidth/DPR（2030/1704/1446/1134 外框 ⇒
  CSS 1441/1207/1023/800，DPR 恒 2.1）+ 截图 10 张（`docs/reviews/2026-09-25-u3-68/`）。改窗一律 Win32 `MoveWindow`
  （**禁 Emulation**——U2 5.1 实证会把 Monaco 压出 36px 伪影；「1440 本机物理不可达」旧结论已被推翻，本次探针复验可达）。
  判据两处校准：内容完整性用 **Monaco model** 子串（虚拟滚动下 DOM 只含视口行，实测输入后"首行"是 L4；且草稿初始值=原值、
  键入合并进行尾）；「操作可达」= scrollIntoView 后落入视口（按钮可在滚动折叠线下）。
  变异 2 处全捕获（`u3-68-panel-mutate.cjs`）：去 `xl:` 断点 ⇒ 三窄档轨道数判红；草稿侧 wordWrap off ⇒ 四档绘制右溢判红
  （18~319px），均 exit=1，跑完 `git diff` 零残留。harness 事实：Monaco 换字段/断点重挂首帧 5px 壳 ⇒ 测量前 `waitGridReady`
  轮询两侧 ≥100px（开发中一次 1210 档"网格未找到"瞬态同源，加等待后 3 轮整跑未复现）。
- [x] 6.9 独立验证 Electron 200% 页面缩放，记录实际 viewport、zoom/DPR 与编辑/操作可达性，不要求各宽度与缩放全组合（<=2h）。验收：宽窄窗口均可核对完整编辑内容（200% 缩放）。
  证据：`apps/desktop/scripts/u3-69-cdp.cjs`（3 tag / **108 检查 / 0 失败**，dev 带 `REBASEAGENT_ZOOM_FACTOR=2`
  经 `.workbuddy/u3/u3-69/run-all.cjs` 每 tag 全新起）：tool-result 三档 41、prompt 三档 38（两字段独立不串值）、
  model-ab 三档 29；三档外框 3610/2030/1134 ⇒ **实测 CSS 1284/720/400、dpr 恒 4.2（=2.1×2）** ⇒
  **200% 下并排档（≥1280）仍可达**；每档断言：缩放真实生效 / 视口命中 / 轨道数=xl 断点 / 两侧 ≥200px（未缩正文）/
  零绘制右溢 / **整页 `scrollWidth≤innerWidth+2`（200% 专属加测）** / 「放弃修改」滚动可达 / model 12 行完整 /
  改窗往返逐字保留；**编辑可达**=极窄档（CSS≈400）现场键入/写入臂参数并核对 store。截图 9 张
  （`docs/reviews/2026-09-25-u3-69/`）。**抓到并修 1 处真实产品缺陷**：model-ab 核对网格臂行无空格 JSON 长拉丁串
  不强制断行 ⇒ 草稿侧绘制右溢 26px(1280)/36px(400) 截文 ⇒ 两侧臂行加 `break-all` + 契约测试 +2 断言
  （变异「去 break-all」⇒ 用例 `1 failed` 变红）；6.8 未抓到系夹具拉丁连段恰短于临界。**回归**：6.8 `model-ab`
  tag（zoom1 两极端档）复跑 16/16 全绿。变异 2 处全捕获（`u3-69-mutate.cjs`）：M1 禁用 main 的 zoom 注入（先清
  持久 zoom）⇒ 基准 dpr 与三档视口共 8 条判红；M2 去草稿侧 `break-all` ⇒ 1280/400 溢出判红，均 exit=1、还原零残留。
  harness 两条新事实：① **MoveWindow 回报不可信**（off-screen 158×26 幽灵窗会让 ps-win 面积筛选选错 hwnd）⇒
  改窗一律 `resizeTo` 以**页内实测 CSS** 复核重试；② 🔴 **`REBASEAGENT_ZOOM_FACTOR` 经 Chromium per-host zoom
  持久化污染后续 dev**（`Preferences.partition.per_host_zoom_levels.*.localhost` ⇒ 不带 env 的 dev 也开在 200%，
  6.8 回归首轮「运行列表未就绪」即此因）⇒ 跑 zoom1 场景前必须 `--reset-zoom`（dev 停止后执行，zoom2 dev 退出会写回）；
  另 200% 下默认窗口 CSS≈605 落窄档、运行导航收起 ⇒ 就绪轮询前先真实改窗到宽档（harness 已内置）。
  门禁：desktop **80 文件 / 1519 用例 / 0 失败** · `biome check .` **364 文件 0 错** · tsc 双 0 ·
  `validate preserve-debugging-drafts --strict` valid 且 `--all --strict` **13 passed**
  （日志 `.workbuddy/u3/u3-69/openspec-{strict,all}.log`、`desktop-full.log`）。
- [x] 6.10 创建/设置/嵌套确认实测 Tab/Shift+Tab/Esc、Monaco 内部弹层及 busy 关闭限制，保存焦点序列与截图（<=2h）。验收：创建设置和放弃确认不泄漏焦点 / Esc 只关闭最上层并恢复焦点 / 创建忙碌期间不能通过焦点修复绕过关闭锁。
  证据：`apps/desktop/scripts/u3-610-cdp.cjs`（7 tag / **63 检查 / 0 失败**；`docs/reviews/2026-09-26-u3-610/`
  README + 截图 7 张 + `measurements.json` 焦点链）：focus-create 9 / focus-settings 8（top layer、初始焦点=
  首个可见可用控件、Tab×16+Shift+Tab×8 禁闭且回绕、背景真鼠标 inert、Esc 关+焦点恢复触发入口）、
  nested-confirm 10 / editor-confirm-esc 10（一次 Esc 只关最上层确认，底层对话框/编辑器仍在，取消不丢草稿，
  焦点逐级恢复，关闭≠放弃）、monaco-esc 7（真 Ctrl+F 弹层先消费第一次 Esc、第二次才收起编辑区）、
  busy-lock 11（受控服务 delayMs=6s：全入口禁用、Esc 被吞、无可用控件态焦点不逃逸背景、恰 1 次请求、
  应答后正常收尾、锁不外泄）、fallback-focus 8（触发点卸载 ⇒ 焦点=回退锚点且真实可见）。键盘/鼠标一律
  CDP trusted 输入；多层模态顶层判据 = `querySelectorAll('dialog:modal')` 末位。
  **抓到并修 2 处真实缺陷 + 1 处接线缺口**：① CreateRunDialog 残留 window keydown Esc 与 cancel 双通道
  ⇒ 嵌套确认一次按键双关（删监听，单通道走 ModalDialog；SettingsDialog 同款 5.1 已删、契约当时只钉了设置侧）；
  ② 🔴 **Chromium 模态框 Esc「两步关闭」**——busy 期第一次 cancel 可 preventDefault，第二次 cancel 以
  `cancelable:false` 派发（preventDefault 无效）⇒ 只在 cancel 上吞必被二次 Esc 绕过；且 React 委托的
  onCancel 第二次不再执行（监听器在场但行为缺席）。修＝cancel 手动绑定/解绑 + 关闭锁主拦截点移到
  document 捕获 keydown（锁定且本模态为最顶层 modal 时吃掉 Escape，嵌套确认上层放行）；
  ③ 编辑区 Esc 收起缺接线（spec L58/L62 + D7 要求）⇒ 新增 `lib/use-escape-close.ts`
  （纯判据 shouldEscapeClose：Escape ∧ ¬defaultPrevented ∧ ¬模态在场 ∧ 栈顶）+ 四编辑器接
  `useEscapeClose(open && !inProgress, 与收起按钮同动作)`。契约：shouldEscapeClose 5 用例 + 接线断言
  （4 处 hook、单通道、手动 cancel、keydown 守卫）+ create-form「原忙碌关闭限制」改钉新通道。
  变异 4 处全捕获（`u3-610-mutate.cjs`）：A 回插双通道 ⇒ nested-confirm 3 红；B 不注册 keydown 守卫 ⇒
  busy-lock 3 红；C 去 modalPresent 让位 ⇒ editor-confirm-esc 2 红；D 删回退锚点 ⇒ fallback-focus 2 红
  （C 第一版注入 defaultPrevented 分支实机**不可观测**——Monaco 消费走 stopPropagation，改注入 modalPresent
  后捕获，该分支由单测钉住，如实记录）。harness 新坑：**Page.reload 后 CDP 真鼠标不再触发 React onClick**
  ⇒ 要干净页面用重启 dev；探针 document 级监听跨轮叠加污染打点。门禁：desktop **80 文件 / 1525 用例 / 0 失败** ·
  biome **366 文件 0 错** · tsc 双 0 · desktop build EXIT=0 · `validate preserve-debugging-drafts --strict` valid。
- [x] 6.11 检查零调用/逐文件哈希/无草稿持久化，重载与重启不恢复草稿；回归 U1/U2 阅读及文件状态（<=2h）。验收：草稿不会跨 renderer 会话持久恢复 / 草稿操作零执行且已有文件不变 / 原有执行入口和文件阅读继续可用。
  证据：`apps/desktop/scripts/u3-611-cdp.cjs`（5 tag / **45 检查 / 0 失败**，零产品代码改动；
  `docs/reviews/2026-09-26-u3-611/` README + 截图 5 张 + `measurements.json`）：
  zero-exec 15（五通道草稿全操作 + 真哨兵 `app.quit`→UIA「返回」取消退出 ⇒ 受控服务 `entries()=0`、
  traces/blobs/source/settings **逐文件 SHA-256 diff=[]**、traces 126→126、localStorage+sessionStorage 零标记、
  取消退出后三区原样）；reload 9（真 `Page.reload` ⇒ store 三区全空、徽标无 dirty、重开编辑器=原值且只登记基线、
  `.rebaseagent` 全树零痕迹）；restart-pre/post 2+6（run-all 每 tag 全新进程 = 真重启 ⇒ 三区全空、磁盘零痕迹、
  重开=原值、计数一致）；regression 13（U1 页签/选中 span 往返恢复、U2 文件列表/选择/path 往返保持/正文渲染、
  result/prompt/messages/A-B/隔离续跑五入口在场、历史草稿零泄漏）。restart 语义由 run-all 固定全序承担
  （pre 落 handoff.json，post 在新进程验证）。变异 3 处全捕获（`u3-611-mutate.cjs`）：A 草稿镜像 localStorage ⇒
  web storage 判红；B 键入顺手 `saveSettings` ⇒ 冻结面 `["settings:settings.json"]` 判红；
  C sessionStorage 跨重载复活 ⇒ reload 3 条判红；还原 `git diff src` 零残留。harness 四条新事实：
  ① IIFE 括号错位求值出函数对象 ⇒ `=== true` 恒假**静默假阴**，`ev()` 加「求值出函数即抛」自防御；
  ② `clickSpan` 的 title 过滤必须 `closest('header')===null`——GlobalBar「运行配置」title 含「LLM」，
  会被先命中**静默打开设置模态**、其后真鼠标全被 backdrop 吞（6.8/6.10 的 LLM 场景同样中招，
  对已出结论无影响——top layer 不改底层布局；本轮起每步 dump dialog 集合防复发）；
  ③ 真鼠标点击前 `scrollIntoView({behavior:'instant'})` + 稳定取 rect + `elementFromPoint` 校验，不过即抛不盲点；
  ④ 文件页默认检查点 auto 过滤会筛空（相对初始无变化）⇒ 先「查看全部」再数 `role=option`。
  另：desktop 全量首轮 2 条 `controlled-entrances` 红为环境 flake（紧邻 run-all 的 mock 端口起停），
  未改一码复跑全绿。门禁：desktop **80 文件 / 1525 用例 / 0 失败** · biome **367 文件 0 错** ·
  `validate preserve-debugging-drafts --strict` valid（零产品改动，tsc/build 沿用上轮绿态）。

## 7. 门禁与证据收口

- [x] 7.1 运行适用包构建、桌面 typecheck、desktop 全量测试、Biome、OpenSpec strict；环境阻塞与产品失败分别记录（<=2h）。覆盖本 change 全部场景对应的自动化断言，不因纯逻辑测试通过而跳过 6.x。
  证据（2026-09-26，HEAD `8e3995b`，零产品代码改动；日志 `.workbuddy/u3/u3-71/gates.txt`）：
  packages build **EXIT=0（5/5，排除 desktop）** · desktop typecheck **node/web 双 0** ·
  desktop 全量 **80 文件 / 1525 用例 / 0 失败 / 无 `Errors` 行**（EXIT=0）·
  **文件级差集**（`.workbuddy/u3/u3-71/file-diff.cjs`）磁盘 80 ↔ 日志 80，**missing 0**（防 EPERM 吞文件）·
  根 `biome check .` **EXIT=0，Checked 367 files / 0 错** ·
  `validate preserve-debugging-drafts --strict` **valid**、`validate --all --strict` **13 passed / 0 failed** ·
  desktop `electron-vite build` **EXIT=0**。
  环境阻塞记录：**本轮 0 次**——6.11 首轮曾出现的 2 条 `controlled-entrances` 红（紧邻 run-all 的 mock 端口起停）
  本轮整跑未复现，未复跑、未改码；产品失败 **0**。实机面（6.1–6.11）未被跳过，逐场景证据见 7.2。
- [x] 7.2 编写 evidence-index，逐场景关联测试/fixture/真实截图与命令结果，核对入口接线和 U4/U5 边界、所有任务实际完成情况（<=2h）。未执行项保持待办，不宣称跨页执行或自动清理完成；归档另行处理。
  产出 `evidence-index.md`：delta **9 requirements / 41 scenarios 全覆盖、未验证 0**（全 ADDED，既有场景零改动）。
  **四项引用回查全部机器化**（脚本在 `.workbuddy/u3/u3-72/`，各带反证证明判据有牙）：
  场景逐条覆盖 41/缺失 0（M1 改名/M2 删行/M3 虚构 三处注入全部判红）；
  **62 个实机 tag 名**在 11 个采集脚本源码内命中；**78 张截图**逐张存在且目录计数相等；
  **79 个用例名片段**命中 `describe/it` 标题（⚠️ 本轮回查抓到并修正 3 处把 describe 与 it 拼接的"非逐字"引用——
  人读没问题、机器判红，已把「用例名逐字取自 `it(...)` 标题」写成索引纪律）。
  三条实现面事实**逐条给结论**：① `native-edit-context` ⇒ `inputSettled` 在输入法路径无触发＝**可接受**
  （保护由 `dirtyCount` 侧承担，spec R7-3 THEN 尾句已覆盖；design D6 需注明通道适用面，**不回 proposal**）；
  ② 未提交候选被输入法丢弃＝**可接受、已写死**（二选一断言 + 已提交文字必须保留）；
  ③ Monaco 弹层 `stopPropagation` ⇒ `defaultPrevented` 让位分支实机不可观测＝**可接受、证据分层**
  （单测钉该分支，实机面由 `modalPresent` 承担；教训：变异要在可观测路径上注入）。
  另列 **9 条已知限制**（零持久化无单测面、真原生目录选择取消不可自动化、`fff6581`/`eef8fed` 无新增单测、
  `event.sender` 冒名不可注入、`u3-64/65` 的 measurements 是修缺陷前中间态等）与 **U4/U5 边界表**
  （操作登记/执行槽/reconcile/自动清理/真实取消全部未做，本索引不宣称）；U2 遗留「渲染层无 error boundary」**不归本 change**。
  复跑门禁（同 7.1，加入索引后复验）：根 `biome check .` **367 文件 0 错**、
  `validate preserve-debugging-drafts --strict` **valid**；日志 `.workbuddy/u3/u3-72/22-biome-root.log`、
  `23-openspec-strict.log`。**tasks 37/37 全勾，仅剩 owner 验收与归档（按约定不自动归档）。**
