# U2 文件阅读布局原型（任务 1.2）

> **这是原型，不是已通过验收的产品界面。** 页面内的运行、检查点、文件快照、附件与
> 二进制样本均为**内置示例数据**（页面顶部有提示条），不读取真实 trace，也不发起任何请求。
> 本目录的作用是：在写文件阅读组件之前，把 **D4 的两个宽度阈值** 和 **diff 模式切换决策**
> 用**已安装 Monaco 自己的公开布局 API**量出来、留成可复核的数字。
>
> ⚠️ **原型几何证据 ≠ 真实桌面验收。** 真实 Electron 窗口 / 真实 DPI / 真实系统缩放下的
> 表现归 5.1 / 5.2，不能由本目录代替。

## 文件

| 文件 | 说明 |
|---|---|
| `index.html` | 单文件可点击原型（含 mock 排版与**真 Monaco**两套正文来源，可 A/B 切换） |
| `measurements.json` | 各视口 / 目录宽 / 缩放下的实测几何（由 `apps/desktop/scripts/u2-file-prototype-shots.cjs` 生成） |
| `screenshots/` | 截图（含 `real-monaco-*` 真 Monaco 逐档与容器变化证据） |

复现测量与截图：

```bash
cd apps/desktop
NODE_PATH="C:/Users/28145/.workbuddy/binaries/node/workspace/node_modules" \
  node scripts/u2-file-prototype-shots.cjs
```

## 为什么必须有「真 Monaco」这一段

mock 排版的文字区是**按自己写的 chrome 常数算出来的**。拿 mock 的数字证明
「800px 的 inline 文字区够 480」是**自证**——只要常数写宽松一点，结论就能翻过来。

因此本原型加了一段：用**与产品同一份**本地 Monaco 0.56 实例、**同一组 options**装配，
读 `getLayoutInfo().contentWidth`（Monaco 自己算出来的正文可用宽）。`measure()` 同时返回
两套数字（`schemaTextWidths` / `monacoContentWidths`）并给出 `crossCheck` 差值，
让「模型 vs 实测」的偏差**一眼可见、不可藏**。

---

## 1.2 核对结论

### ① Monaco 公开命令 / 布局 / 定位 API 核对（对照 0.56.0 实装）

全部以 `node_modules/.pnpm/monaco-editor@0.56.0/.../esm/vs/editor/editor.api.d.ts`
的声明为准，并在原型里**真调用过**（不是只读文档）：

| 用途 | API | 实测结论 |
|---|---|---|
| 正文可用宽 | `ICodeEditor.getLayoutInfo().contentWidth` | ✅ 唯一可作为 D4 证据的数字 |
| 行号槽宽 | `getLayoutInfo().lineNumbersWidth` | ✅ 实测 **36**（产品未开 glyph margin ⇒ 该值 0） |
| 装饰 / 滚动条 / minimap | `decorationsWidth` / `verticalScrollbarWidth` / `minimap.minimapWidth` | ✅ 实测 0 / 0（auto 且未溢出） / 0（已关） |
| 代码字号 | `getOption(EditorOption.fontSize)` | ⚠️ **枚举值 = 61**，**不是 48**。误用 48 会返回字符串（实测拿到 `"modified-in-monaco-diff-editor"`） |
| 上一/下一差异 | `IDiffEditor.goToDiff('next' \| 'previous')` | ✅ 可调用，无异常 |
| 首个差异 | `IDiffEditor.revealFirstDiff()` | ✅ 可调用 |
| 差异块列表 | `IDiffEditor.getLineChanges()` | ✅ 返回 `ILineChange[] \| null` |
| 差异更新事件 | `IDiffEditor.onDidUpdateDiff` | ✅ 事件可订阅并 dispose |
| 取两侧编辑器 | `getOriginalEditor()` / `getModifiedEditor()` | ✅ 返回 `IStandaloneCodeEditor` |
| 查找 | `getContribution('editor.contrib.findController').getState().change(...)` | ✅ 可回填搜索词 |

> 结论：**1.2 需要的命令、布局与定位 API 在 0.56 全部可用**，无需私有/内部 API。

### ② D4 阈值：真 Monaco 实测（权威数字）

视口 1440 / 1360 / 1210 / 1024 / 800 / 640，目录默认、diff 模式 auto：

| 视口 | 目录宽 | 正文区宽 | 落地模式 | Monaco 每侧文字区 | 是否达标 |
|---|---|---|---|---|---|
| 1440×900 | 203 | 968 | 并排 | **429** | 并排 ≥320 ✅ |
| 1360×860 | 200 | 891 | 并排 | **391** | 并排 ≥320 ✅ |
| 1210×800 | 200 | 997 | 并排 | **443** | 并排 ≥320 ✅ |
| 1024×768 | 200 | 819 | 并排 | **354** | 并排 ≥320 ✅ |
| 800×600 | 200 | 331 | inline | **273** | inline ≥480 ❌ **差 207px** |
| 640×640 | 200 | 376 | inline | **312** | （<800，不参与 480 判据） |

**800px 档的结论：`P4` 的担心被证实，不是被推翻。** 800px 视口下 inline 正文区实测只有
**273px**，离 D4 要求的 480px 差 207px——**在满足「文字至少 13px、不整页横向滚动」的前提下，
800px 视口无论怎么调目录宽都到不了 480**（目录已在最小 200px、再收起目录正文区也只有 331px）。

### ③ 阈值扫描：临界视口是 960，不是 800

在 720–1280 之间细扫（目录默认 200–232）：

| 视口 | 落地模式 | 每侧文字区 | inline 达 480？ | 并排达 320？ |
|---|---|---|---|---|
| 720 | inline | 193 | ❌ | — |
| 760 | inline | 233 | ❌ | — |
| **800** | inline | **273** | ❌ | — |
| 840 | inline | 312 | ❌ | — |
| 880 | inline | 352 | ❌ | — |
| 920 | inline | 392 | ❌ | — |
| **960** | 并排 | **323** | — | ✅ **首个达标** |
| 1024 | 并排 | 354 | — | ✅ |
| 1100 | 并排 | 393 | — | ✅ |
| 1200 | 并排 | 439 | — | ✅ |
| 1280 | 并排 | 350 | — | ✅ |

> 客观事实：**「正文达标」的最小视口是 960px**（此时走并排、每侧 ≥320）。
> 960px 以下到 720px 这一段，inline 文字区从 392 一路掉到 193，**没有任何一档达到 480**。

### ④ 两次 800px 决策（D4 明文要求的单独记录）

**决策一：800px 下目录常不常驻？**
- 目录常驻判据 = 「扣掉目录后 inline 文字区 ≥ 480」。800px 下即使目录取最小 200px，
  文字区也只有 273px < 480 ⇒ **判据要求收起目录**。
- 但收起目录后正文区 331px、文字区仍是 273px，**依然不达 480** ⇒ 收起目录也救不回 480。
- 结论：**800px 下目录是否常驻对「是否达 480」已无决定意义**——这一档本来就达不到。

**决策二：800px 下 diff 用并排还是 inline？**
- 并排每侧 = (331 − 56) / 2 ≈ 137px < 320 ⇒ **必须 inline**（并排会挤成两条 137px 窄条）。
- 实测：真 Monaco 在 800px 果然落地 inline，每侧文字区 273px。

> 两次决策都成立、且互相独立（与 D4「目录常驻与并排互不蕴含」一致）。
> **但二者合起来说明：800px 这一档「能看清正文」这个前提本身就不成立。**

### ⑤ 同视口下响应容器变化（真 Monaco，`automaticLayout` 是否真生效）

视口固定 1440px，只把目录宽从 203 → 320：

- 正文区 968 → 909（−59）
- **Monaco 文字区 429 → 400**（−29）
- 视口未变 ⇒ 判据「不是吃窗口断点」成立 ✅

> 这也验证了 `automaticLayout: true` 在容器变化时确实 relayout（不是只在窗口 resize 上触发）。

### ⑥ 极窄与放大后仍可阅读

- 200% 缩放（等价 CSS 视口减半）：字号仍 **13px**（不靠缩字号达标）✅，无整页横向滚动 ✅。
- 640×640：inline、文字区 312px，可阅读，且并排会明确降级并说明原因 ✅。

### ⑦ 异常状态不渲染伪空编辑器

- 缺失 / 损坏附件：只渲染**状态块**（含「不是空文件」口径），正文编辑器节点数 **0** ✅。
- 二进制：只提示大小与哈希，不做有损文本比较 ✅。

---

## 原型阶段抓到并修掉的真实缺陷

本轮在把真 Monaco 跑起来的过程中撞到四个缺陷，**前两个是"只有真跑才会暴露"的**：

1. **`EditorOption.fontSize` 枚举值不是 48，是 61。**
   首版按 48 取，`getOption(48)` 返回了字符串 `"modified-in-monaco-diff-editor"`
   （那是 DOM class 名，不是数值选项）。症状是「字号 ≥13」判据报 `…px`（非数字）。
   修法：核对 `editor.api.d.ts` 第 5146 行 `fontSize = 61`，改用 61。

2. **真 Monaco 直接挂进 flex 容器会被压成几十像素。**
   `#editorwrap` 是 `display:flex; flex-direction:row; gap:10px`。mock 侧每列有 `.pane`
   包着（`flex:1 1 0`），但真 Monaco 是**直接子节点**，被当成不可伸缩的 flex item ⇒
   diff 容器实测只剩 **74px**、`contentWidth` 变成 **−9**（负数）。
   修法：给直挂的 `.monaco-diff-editor` / `.monaco-editor` 补 `flex:1 1 0; min-width:0`。

3. **`getLayoutInfo()` 依赖已完成 layout，需先强制 `layout()`。**
   容器刚变宽 / 首帧尺寸为 0 时，读到的是上一轮尺寸。
   修法：读之前显式 `e.layout({width: host.clientWidth, height: host.clientHeight})`。

4. **静态服务三连坑**（不是产品缺陷，但会伪装成"Monaco 装配失败"）：
   ① Monaco ESM 里有裸 CSS 副作用导入（`import './standalone-tokens.css'`），
   裸浏览器按模块脚本拉会因 MIME `text/css` 报错 ⇒ 服务按扩展名把 CSS 伪装成 JS 模块；
   ② pnpm 下 `node_modules/<pkg>` 是符号链接目录，必须请求 `.pnpm` 实体路径；
   ③ Windows `join()` 产反斜杠、与正斜杠 `startsWith` 前缀比较失配 ⇒ 全 404；
   另加目录 URL 需补 `index.html`。

---

## 对 D4 与实现常数的结论（必须执行，不得靠"降低正文要求"绕过）

按 review `P4` 的约定——**若无法满足，先修设计再实施，不通过降低正文要求掩盖问题**——
本轮实测给出两条明确动作：

1. **`lib/file-layout.ts` 的 chrome 常数按实测校正**（已完成）：
   - `INLINE_CHROME`：74 → **64**（实测 58–64）
   - `DIFF_CHROME_PER_SIDE`：88 → **56**（实测 55–56）
   - 原值偏大 ⇒ 会**误收目录**（inline）与**误判并排空间不足**（并排）。
   实测依据：inline 正文区 − contentWidth = 58/64；并排每侧正文区/2 − contentWidth = 55/56。

2. **800px 档「inline 文字区 ≥ 480」在几何上不可达**——不是实现没做好，是该档位与
   该阈值不自洽。需在 design D4 / spec 场景 / tasks 三处之一明确：

   > **✅ 已结案（2026-09-23，用户拍板候选 (a)）**：
   > 采用「把 480 的下限限定到 **≥960px 视口**」——960px 是实测的几何临界视口。
   > spec delta 主 requirement 加分档句、`文件正文在代表视口可读` 场景的 WHEN 去掉 800px
   > 并加 AND、`极窄与放大后仍可阅读` 场景纳入「800px 及以下为窄档：目录一律收起、
   > diff 强制 inline、正文按可得主区自适应，不要求 480」；design D4 写入分档依据；
   > review P4 已结案。**实现侧 `INLINE_MIN_TEXT=480` 未动**（仅收窄语境）。
   > 详见 `openspec/changes/improve-workspace-file-reading/{specs/desktop-ui/spec.md,design.md}`。

---

## 未验事项（不得当作已通过）

- **真实 Electron 窗口 / 真实 DPI / 真实系统缩放**：本轮用 Chrome CSS 视口等价测量，
  未在 Electron 内实测 `zoomFactor`（归 5.1 / 5.2）。
- **真实数据**：全部为内置示例数据；真实 trace 上的文件正文需实施后用同一组 fixture 复现。
- **语言 worker / 语法高亮**：原型刻意不装配 worker（纯文本 diff），本地高亮的视觉行为未验。
- **长路径与超长单行**：原型含长路径样例，但超长单行的换行/横向滚动交互未逐项截图。
- 因此 1.2 的勾选仅代表 **原型与阈值核对完成**，不代表 U2 的文件阅读桌面验收通过。
