import { createHash } from "node:crypto";
import type { WorkspaceFile, WorkspaceSnapshot } from "./schema.js";
import { compareLogicalPath } from "./workspace-snapshot.js";

/**
 * 快照清单的**规范排序与哈希**（Node 专用：依赖 `node:crypto`）。
 *
 * ⚠️ **本模块不得被 renderer 引用**：renderer 没有 Node 的字节哈希 API。因此它**刻意不进
 * `index.ts` 主出口**，只走 `@rebaseagent/trace-sdk/workspace-hash` 子路径——这样渲染层
 * 即使从主出口取别的纯函数，也不会把 `node:crypto` 拉进浏览器 bundle。
 * 纯 schema 与结构校验在 `workspace-snapshot.ts`（renderer 可用），两者职责不重叠：
 * 那边判"清单形状对不对"，这边算"清单的指纹是多少"。
 *
 * ## 规范形式（跨机器必须逐字节一致）
 *
 * `snapshot.id = sha256( utf8( JSON.stringify(files.map(f => [f.path, f.sha256, f.bytes])) ) )`
 * 其中 `files` 已按路径的 UTF-16 代码单元序排序。刻意**不依赖** locale、mtime、源目录
 * 位置或 OS 枚举顺序，也不在序列化时对非 ASCII 字符做转义差异处理——`JSON.stringify` 直接
 * 输出原始字符，再按 UTF-8 取字节。
 *
 * 这条"看起来一样却算出不同哈希"的静默不等在本仓有前科（跨语言复刻 `config_hash` 时踩过），
 * 所以：**任何语言/运行时若要复刻本 id，必须逐条对齐排序键、字段顺序与编码**。
 */

/**
 * 返回按规范序排列的**新数组**（入参不被修改）。
 *
 * 元素仍是原对象引用：清单是只读数据，与"不复制文件字节"的应用层 COW 一致，
 * 不在此处深拷贝。
 */
export function canonicalWorkspaceFiles(files: readonly WorkspaceFile[]): WorkspaceFile[] {
  return [...files].sort((a, b) => compareLogicalPath(a.path, b.path));
}

/** 规范清单的序列化文本（仅本模块使用，不导出：它是 id 的中间表示，不是公开契约） */
function serializeCanonicalFiles(files: readonly WorkspaceFile[]): string {
  return JSON.stringify(files.map((file) => [file.path, file.sha256, file.bytes]));
}

/**
 * 计算快照 id（64 位小写十六进制）。
 *
 * 内部先做规范排序，故**与输入顺序无关**：`compute(files)` 与 `compute(shuffled(files))`
 * 结果相同。乱序清单被拒绝是 **schema** 的职责（`findSnapshotFilesViolation`），不是这里——
 * 本函数只回答"这份清单的指纹是什么"。
 */
export function computeWorkspaceSnapshotId(files: readonly WorkspaceFile[]): string {
  const text = serializeCanonicalFiles(canonicalWorkspaceFiles(files));
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 由一份（可能未排序的）文件清单构造完整快照：排序、算 id 一次完成。写入端用。 */
export function createWorkspaceSnapshot(files: readonly WorkspaceFile[]): WorkspaceSnapshot {
  const canonical = canonicalWorkspaceFiles(files);
  return { id: computeWorkspaceSnapshotId(canonical), files: canonical };
}

/**
 * 校验记录的 `id` 是否真的等于其清单的规范哈希；相符返回 `null`。
 *
 * 为什么必须重算而不是"信任记录里的 id"：清单与 id 之间没有结构性约束，一个被手工篡改或
 * 由错误实现写出的文件可以带任意 id。执行前重算，才能保证"从这份快照恢复文件"恢复的
 * 是被记录过的那个状态，而不是另一份看起来合法的清单。
 */
export function findSnapshotIdViolation(snapshot: WorkspaceSnapshot): string | null {
  const expected = computeWorkspaceSnapshotId(snapshot.files);
  if (snapshot.id !== expected) {
    return `快照 id 与规范清单不符：记录为 ${snapshot.id}，重算为 ${expected}`;
  }
  return null;
}
