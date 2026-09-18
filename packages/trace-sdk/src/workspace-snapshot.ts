import { findLogicalPathCollisionViolation, findLogicalPathViolation } from "./logical-path.js";
import type { WorkspaceFile, WorkspaceMeta } from "./schema.js";

/**
 * 快照清单与 workspace 元数据的**纯校验**（无 Node 依赖，renderer 可直接用）。
 *
 * 为什么与哈希分开：清单 id 要按规范清单算 SHA-256，那需要 Node 的 `node:crypto`
 * （见 `workspace-hash.ts`）；而 renderer 既无 Node 也无字节哈希 API。因此本模块只做
 * **不需要字节运算**的判定——类型外的排序性、重复、NFC/大小写碰撞、文件/目录冲突、
 * origin 关系，由 schema 的 refine 自动调用；`snapshot.id` 与规范清单是否相符另由
 * Node 侧重算（`findSnapshotIdViolation`）。
 *
 * 路径规则本身不在这里：**单条/一组逻辑路径的完整契约在 `logical-path.ts`**（长度/深度上限、
 * Windows 平台特性、NFC+小写碰撞），本模块调用它。1.2 落地时这里只做"跨平台通用结构"判定并
 * 刻意放行 `CON` / `a.txt:ads`；2.1 起完整契约生效，清单里的路径与工具写入走的是同一份标准。
 *
 * 文件数与字节配额（2000 / 8 MiB / 64 MiB / 128 MiB）属隔离编排，在
 * `packages/replay/src/workspace/quota.ts`，不在本模块。
 */

/**
 * 逻辑路径的规范比较：**UTF-16 代码单元序**（即 JS 字符串的默认序）。
 *
 * ⚠️ 刻意不用 `localeCompare`——它依赖 locale 与 ICU 数据，同一份清单在不同机器/不同
 * Node 构建上会排出不同顺序，进而算出不同的 `snapshot.id`（静默不等，最难排查的一类）。
 */
export function compareLogicalPath(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** 清单是否已按规范序排列（非降序）。空清单与单元素恒为真。 */
export function isCanonicalWorkspaceOrder(files: readonly WorkspaceFile[]): boolean {
  for (let i = 1; i < files.length; i++) {
    if (compareLogicalPath(files[i - 1].path, files[i].path) > 0) {
      return false;
    }
  }
  return true;
}

/**
 * 清单自身的合法性：规范排序 → 路径契约 → 重复 → 碰撞 → 文件/目录冲突。
 *
 * 顺序是刻意的：
 * - 先判排序，才能用"集合 + 祖先前缀"的方式报出稳定的冲突原因（乱序时相邻性没有意义，
 *   报出来的冲突会随枚举顺序变化，不可复现）；
 * - "逐条路径是否合法"（含长度/深度/平台保留名，见 `findLogicalPathViolation`）先于
 *   集合类判定：一条非法路径的成因通常比"它和谁重复"更值得优先告诉用户；
 * - 真重复先于碰撞，是为了让"完全相同的两条"报出更直接的文案。
 *
 * **冲突的含义**：同一世界内一条路径不能既是文件又是另一条路径的祖先目录。例如
 * `a` 与 `a/b` 同时存在即冲突——一个世界里 `a` 不可能同时是文件和目录。
 *
 * **碰撞的含义**：两条路径在 NFC + 小写意义下等价（`A.txt` 与 `a.txt`、`é` 的两种编码）。
 * 这种清单不可能由导入或写工具产生（两处都用同一份契约拒绝），读到时只说明文件被改过或
 * 写入端有 bug——任其通过会让同一世界出现两条指向不同内容的"同一个文件"。
 */
export function findSnapshotFilesViolation(files: readonly WorkspaceFile[]): string | null {
  if (!isCanonicalWorkspaceOrder(files)) {
    return "清单必须按路径的 UTF-16 代码单元序升序排列（写入端排序，读取端拒绝乱序）";
  }

  const seen = new Set<string>();
  for (const file of files) {
    const pathViolation = findLogicalPathViolation(file.path);
    if (pathViolation !== null) {
      return pathViolation;
    }
    if (seen.has(file.path)) {
      return `清单存在重复路径：${file.path}`;
    }
    seen.add(file.path);
  }

  const collision = findLogicalPathCollisionViolation(files.map((file) => file.path));
  if (collision !== null) {
    return collision;
  }

  // 文件/目录冲突：任一路径的某个真前缀（按 "/" 切分）也在清单里，说明那条前缀既是
  // 文件又是目录。规范序下祖先不一定紧邻其后代（`a` < `a-x` < `a/b`），故必须查全部前缀，
  // 不能只比相邻两项。
  for (const file of files) {
    const segments = file.path.split("/");
    for (let i = 1; i < segments.length; i++) {
      const ancestor = segments.slice(0, i).join("/");
      if (seen.has(ancestor)) {
        return `路径冲突：${ancestor} 既是文件又是 ${file.path} 的祖先目录`;
      }
    }
  }

  return null;
}

/** `findWorkspaceOriginViolation` 的输入：meta 行里与 origin 有关的那几个字段 */
export interface WorkspaceOriginContext {
  /** 本 run id（同时也是 workspace.world_id 的期望值） */
  id: string;
  /** 父 run id；根 run 为 null */
  parent: string | null;
  /** `fork.resume_after_step`（存在时才与 origin.step_span 比对，见下） */
  resumeAfterStep?: string | undefined;
  workspace: WorkspaceMeta;
}

/**
 * workspace 元数据与 parent / fork 的关系一致性（矛盾即拒绝）。
 *
 * 规则：
 * - `world_id` 必须等于本 run id——世界由创建它的 run 标识；
 * - 根 run（`parent === null`）的 origin 必须是 `import`（世界来自导入）；
 * - 分支 run 的 origin 必须是 `checkpoint` 且 `run_id` 指向**直接**父 run，
 *   不能跨代指祖先（分层时直接用父的检查点，否则文件起点会与消息前缀错配）；
 * - `fork.resume_after_step` **存在时**必须等于 `origin.step_span`（两者都表示"该轮末尾"）。
 *
 * ⚠️ "隔离分支**必须**带 `resume_after_step`" 这条必填约束**不在本模块**——它属于任务 1.4
 * 的 v2 整轮截断契约（连同 `resolveBranch` 一起落地）。此处只做"给了就必须自洽"的条件校验，
 * 免得在 1.2 提前收紧、把 1.4 的待实现字段变成写入端的即时失败。
 */
export function findWorkspaceOriginViolation(context: WorkspaceOriginContext): string | null {
  const { id, parent, resumeAfterStep, workspace } = context;

  if (workspace.world_id !== id) {
    return `workspace.world_id 必须等于本 run id：期望 ${id}，实际 ${workspace.world_id}`;
  }

  const origin = workspace.origin;

  if (parent === null) {
    if (origin.kind !== "import") {
      return `根 run 的 workspace.origin.kind 必须是 "import"，实际 "${origin.kind}"`;
    }
    return null;
  }

  if (origin.kind !== "checkpoint") {
    return `分支 run 的 workspace.origin.kind 必须是 "checkpoint"，实际 "${origin.kind}"`;
  }
  if (origin.run_id !== parent) {
    return `分支 workspace.origin.run_id 必须指向直接父 run：期望 ${parent}，实际 ${origin.run_id}`;
  }
  if (resumeAfterStep !== undefined && origin.step_span !== resumeAfterStep) {
    return `workspace.origin.step_span 与 fork.resume_after_step 必须指向同一个 step：origin.step_span=${origin.step_span}，fork.resume_after_step=${resumeAfterStep}`;
  }
  return null;
}
