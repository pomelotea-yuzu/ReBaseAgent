# U3 任务 6.8 实机证据：真窗口四档 CSS px × 原值/草稿核对网格

日期：2026-09-25 · dev（非沙箱，CDP 9612，**无新增钩子、零产品代码改动**）
驱动：`apps/desktop/scripts/u3-68-cdp.cjs`（**3 tag / 96 检查 / 0 失败**）
改窗：`.workbuddy/ps-win.ps1`（Win32 `MoveWindow` 真实改外框，最大化先 SW_RESTORE）
批量驱动：`.workbuddy/u3/u3-68/run-all.cjs`（每 tag 全新 dev）· 数据 `.workbuddy/u3/u3-68/measurements.json`
夹具：复用 6.1 运行清单（`run_mughwjk4`；s_03=read_file 工具结果、s_02=首次 llm.call）。零模型调用。

## 验收判据与档位

「宽窄窗口均可核对完整编辑内容」= 每档四件套：**视口实测命中** + **网格轨道数符合 xl=1280 断点**
（≥1280 并排 2 列 / <1280 上下 1 列）+ **两侧完整可读**（各 ≥200px、绘制零右溢、草稿 model 含全部
12 行首/末标记、原值侧非空）+ **操作可达**（滚动后「放弃修改」/臂输入框完整落入视口）。

| 编辑器 | 1440（并排） | 1210（上下） | 1024（上下） | 800（上下） |
| --- | --- | --- | --- | --- |
| tool-result（Monaco×Monaco） | ✓ 12/12 | ✓ 10/10 | ✓ 10/10 | ✓ 10/10 |
| prompt（两字段独立草稿） | ✓ 10/10 | ✓ 10/10 | ✓ 9/9* | ✓ 9/9* |
| model-ab（静态基线 vs 批次草稿） | ✓ 8/8 | — | — | ✓ 8/8 |

\* prompt 的两字段不串值检查在开编辑器时执行一次；A/B 只测两极端档（并排/上下形态各一次即覆盖两种布局）。
每档记录实际 `innerWidth/DPR`（本机 DPR 恒 2.1；请求外框 2030/1704/1446/1134 → 实测 CSS 1441/1207/1023/800）
与截图（`68-<编辑器>-<档>.png` 共 10 张）。

## 机制口径（沿用 U2 5.1 权威结论 + 2026-09-25 探针复验）

- **禁用 `Emulation.setDeviceMetricsOverride`**（实测把 Monaco automaticLayout 压出 36px 伪影，几何不可信）
  ⇒ 一律 `MoveWindow` 真实改窗口；窗口可超出物理屏 ⇒ 1440 档可达（旧"本机物理不可达"结论已被 U2 5.1 推翻，
  本次探针再次实证：外框 2031×1310 ⇒ CSS 1441×887）。
- 起点统一复原到 1210 档再进矩阵，避免继承上一 tag 的窗口尺寸。

## 判据的两处"反直觉"校准（都写进了脚本头注）

1. **内容完整性用 Monaco model 判，不用 DOM 行**：140px 高的编辑器是虚拟滚动，DOM 只渲染视口内行
   （实测输入后视图停在中部，DOM"首行"是 L4）⇒ 拿"首行在不在 DOM"当判据必假。
   改判 `model.getValue()` 含 `L1-*`/`L12-*`/`12末` 三个标记 + `getLineCount()≥12`。
   另一处实测事实：**草稿初始值=原值**（2.1 ensure 幂等），键入合并进行尾
   （末行实测 `…12末内容(README.md)`）⇒ 用子串判定，不断言整行相等。
2. **「操作可达」= 滚动后可达**：编辑器区在可滚动面板内，按钮初始可在折叠线下
   ⇒ 判据 = `scrollIntoView({block:'center'})` 后 rect 完整落入视口（不是"初始可见"）。

## 变异（先证明有牙，再宣布通过）

| 变异 | 注入点（DetailPanel，跑完还原） | 结果 |
| --- | --- | --- |
| P-A | tool-result 网格去掉 `xl:` 断点（恒并排 2 列） | **1210/1024/800 三档轨道数判红**（tracks=2≠1），exit=1 |
| P-B | tool-result 草稿侧 `wordWrap` 改 off | **四档绘制右溢判红**（实测溢出 18~319px），exit=1 |

脚本 `.workbuddy/u3/u3-68/u3-68-panel-mutate.cjs`；跑后 `git diff apps/desktop/src/` 零残留已核。
长行草稿（单行 ≈1100px）是专门为 P-B 造的：wordWrap 开 ⇒ 换行零右溢；关 ⇒ 必超任何档的盒宽。

## harness 侧事实（后续档位类 tag 沿用）

- **Monaco 换字段/断点会重挂**：prompt 编辑器切字段后新实例首帧可能是 5px 未布局壳
  ⇒ 测量前必须 `waitGridReady`（轮询两侧盒宽 ≥100px，上限 12s）。开发中一次 1210 档
  "网格未找到"的瞬态与此同源；加就绪等待后 3 轮整跑未再复现。
- 改窗走 stdout 的 ps-win 与走 OutFile 的 winops 两类通道并存：OutFile 必须**同时**传给
  参数与读取方（本次踩过一次：只传参数 ⇒ 读 `undefined` ⇒ resolve 恒空）。

## 边界

- 200% 独立页面缩放归 **6.9**（本任务全程 DPR 2.1 系统缩放、zoomFactor 1）。
- 创建表单/设置对话框的焦点与 Esc 归 **6.10**；messages 编辑器与 tool-result 同构（同一网格组件），
  本任务不重复宣称 messages 的四档实测。
- 本任务不触发关闭协商/退出（核对网格为纯布局面），不宣称 §6.4–6.7 的任何行为。

## 复现命令

```bash
node .workbuddy/u3/u3-68/run-all.cjs [tool-result prompt model-ab]
# 变异：node .workbuddy/u3/u3-68/u3-68-panel-mutate.cjs --inject=A|B | --restore（跑完必须 --restore）
```

## 门禁（2026-09-25 实测）

- desktop vitest 全量：**80 文件 / 1519 用例 / 0 失败**（零产品代码改动，基线不动）
- `biome check .` 仓库根整跑：**363 文件 0 错**
- `tsc` 双配置 0；`openspec validate --all --strict` **13 passed / 0 failed**
