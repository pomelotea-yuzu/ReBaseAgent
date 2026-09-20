依赖 A、B 已归档。预算 9.75h，全部待实现。括号列原任务来源；验证场景均来自本段 desktop-ui delta。复用 B 的详情校验，不重定义 trace-format/workspace-isolation 或创建执行入口。

## 1. 文件读取与派生

- [x] 1.1 增 inspect/readFile 只读 IPC、main 服务及 preload/schema，注入 dataDir，调用 A 包接口，仅按 trace 引用读取自有检查点文件（2h，原 5.3）。验证：`文件读取 IPC 拒绝越权`、`二进制和不可用附件分别显示`、`文件浏览过程无写入`；非法 runId/清单外路径、祖先 step、物理路径拒绝，状态分开返回。
- [x] 1.2 派生初始/步骤文件差异与检查点选择模型，保留 ownerRunId/stepSpanId/localIteration，按路径/hash 判定新增/修改，不持久化缓存（0.75h，原 5.4-C）。验证：`初始与各轮文件快照可选择`、`文件选择器轮号不沿链累加`、`重启后查看文件差异`。

## 2. 文件视图

- [x] 2.1 增文件 tab、选择器、紧凑列表和附件状态，返回轨迹保留 run/步骤（2h，原 6.3）。验证：`初始与各轮文件快照可选择`、`文件选择器轮号不沿链累加`、`二进制和不可用附件分别显示`、`失败运行已记录文件可查看`、`文件浏览过程无写入`。
- [x] 2.2 基于现有 Monaco 装配接懒加载 DiffEditor、二进制大小/哈希和窄窗口列表/内容切换，文本完整，无回写按钮（2h，原 6.4）。验证：`长文本及窄窗口`、`重启后查看文件差异`、`二进制和不可用附件分别显示`。

## 3. 文件验收与文档

- [x] 3.1 以 A fixture 或 B 创建的 run 做文件 CDP，重启和整体迁移 dataDir 后复查；比较源/父/兄弟及附件哈希（0.5h，原 7.4-C）。验证：`重启后查看文件差异`、`数据目录迁移后文件仍可查`、`失败运行已记录文件可查看`、`文件浏览过程无写入`。→ CDP `--phase=files` 20/20、`--phase=files-restart` 4/4、`--phase=files-migrate` 6/6（Node 侧按新 dataDir 直调 A 包逐份对哈希）；单测补「errored 封存 run 的已记录检查点仍可查」
- [x] 3.2 Windows 桌面/窄窗口截图核对文件表、长路径与长文本 diff；不得以截图代替哈希验证（0.25h，原 7.5-C）。验证：`长文本及窄窗口`。→ CDP `--phase=files-narrow` 16/16（长路径换行、900px<lg 切换、IPC 读回 sha256=磁盘哈希、8528 字符逐字一致、截图 16~19）
- [x] 3.3 先包 build，再执行 pnpm check:ci、OpenSpec 全量 strict 与 pnpm --filter @rebaseagent/desktop build，记录结果（1h，原 7.6-C）。验证：本段全部场景测试，尤其 `文件读取 IPC 拒绝越权`、`文件浏览过程无写入`。→ 沙箱 check:ci 不可跑（wmic/npx 被拦），逐段替换：typecheck 双侧 0、biome 223 文件 0 errors、desktop 24 文件/363 passed（单 fork）、validate --all --strict 13 passed、desktop build 三段绿
- [x] 3.4 更新文件检查点/差异、附件备份、迁移及不可用状态说明（0.25h，原 8.1-C）。验证：与 `二进制和不可用附件分别显示`、`数据目录迁移后文件仍可查` 一致。→ README「隔离文件运行」补第 6 步（文件 tab 使用者视角）、旧「文件视图本阶段不交付」条目替换为已交付形态与限制
- [x] 3.5 汇总本段 scenario→测试/fixture/截图索引，核对由 A/B 迁入的显示义务和只读 IPC 约束（1h，原 8.2-C，新增独立收口）。验证：本段全部场景有证据；不把未交付执行能力或缺附件显示当文件恢复成功，不自动提交、归档或发版。→ 见本目录 `evidence-index.md`（9 场景全表）
