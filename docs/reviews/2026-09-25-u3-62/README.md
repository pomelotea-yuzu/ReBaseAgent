# U3 任务 6.2 实机证据：R2 / 草稿列表精确定位 / 失效来源 / 放弃取消与确认

日期：2026-09-25 · dev（非沙箱，CDP 9612）· 驱动 `apps/desktop/scripts/u3-62-cdp.cjs`（5 tag）
原始测量 `.workbuddy/u3/u3-62/measurements.json`（**20 项检查 / 0 失败**）；本目录 8 张截图。
夹具同 6.1（`run_mughwjk4` 普通父 / `run_mughwwom_jlgs` 代理；manifest 见 `.workbuddy/u3/u3-61/`）。

## 覆盖与结果（5 场景 / 20 检查全绿）

### R2：创建 → 关闭 → 运行配置 → 再新建（2/2）
- 创建表单键入任务 → 取消 → 打开运行配置 → 关闭 → 再开创建：**任务逐字恢复**（截图 `62-r2-create-restored.png`）。

### R10：草稿列表返回精确编辑目标（6/6）
- 两个 run 各建草稿（result@s_03 / messages@s_02）→ 全局「会话草稿」面板列出**精确目标**（`run <id> · <span>`）；
- 「定位」A：`selectedRunId/selectedSpanId` 精确命中、编辑器打开且含草稿文本（`62-precision-a.png`）；
- 「定位」B：同上（proxy 的 messages，`62-precision-b.png`）。

### 源记录**发生改变**（5/5）
- 建 result 草稿后**篡改磁盘 trace**（tool result 内容改写）→ 切走再切回（`selectRun` 同 run 短路，须经其他 run 强制重拉详情）→ 重开编辑器：
  - `DraftSourceBanner`「来源失效，已禁止执行：…改变…」出现（轮询等待异步重验，`62-source-changed-banner.png`）；
  - 草稿**仍可编辑**且文本保留（readOnly=false）；
  - **执行入口禁用**（确认重跑 disabled）；
  - 「复制草稿内容」→ 剪贴板=草稿全文不截断；
  - 场景尾还原夹具。

### 源记录**缺失**（3/3）
- 摘除 trace 中 `s_03` span 行 → 切走再切回重拉详情：
  - 目标 span 从详情**消失** ⇒ 该编辑器无法打开（没有可恢复的编辑目标——这不是横幅场景；
    `source_missing` 横幅路径由 1.4 单测覆盖，实机「改变」路径见上）；
  - 应用**安全回退**（任务 3.2 语义）：不崩、页签可继续操作；
  - **源 run 数据缺失后草稿仍可复制**（会话级入口 copy 走 store 草稿，`62-source-missing.png`）；
  - 场景尾还原夹具。

### 放弃取消/确认（4/4）
- 会话草稿面板对 A 条目「放弃」→ **真模态**出现且目标明确（文本含 run id 与放弃警示，`62-discard-modal.png`）；
- 「取消」→ A 草稿保留；
- 再次「放弃」→「确认放弃」→ **仅 A 删除**，B（另一 run 的 messages 草稿）不受影响（`62-discard-after-confirm.png`）。

## 过程要点（如实）

- **selectRun 同 run 短路**：篡改/缺失后必须先切到其他 run 再切回，`api.getRun` 才会从磁盘重读——这也是真实用户路径。
- **失效重验是异步的**（IPC 读盘 + 哈希比对）⇒ 横幅断言轮询等待（≤8s）。
- Monaco 键入复用 6.1 三级路径（生效=monaco-trigger）；React 受控输入 native setter 兜底；均如实记录路径。
- 篡改/缺失类场景对磁盘数据的改动在场景尾**全部还原**（复跑安全）。

## 已知边界

- 「损坏」（jsonl 整体非法）会让 run 详情加载失败——与「缺失」同一安全回退面（详情错误原位可重试），未单列截图。
- 503/业务拒绝/部分 A-B 失败等受控执行属 6.3。
