import { MAX_LOGICAL_PATH_DEPTH, MAX_LOGICAL_PATH_LENGTH } from "@rebaseagent/trace-sdk";

/**
 * 隔离文件世界的**首期固定配额**（A design §3 末段）。
 *
 * 本模块只做两件事：**集中定义上限**、**给出可复用的纯判定**。它不碰文件系统、不碰 trace，
 * 因此导入预检与运行期写入能共用同一组数字与同一套边界语义。
 *
 * ## 归属：为什么有一半的字段是从 trace-sdk 引用过来的
 *
 * - **文件数 / 单文件字节 / 快照合计字节 / 一次运行新增内容字节**只在隔离编排里有意义，
 *   故定义在这里；
 * - **路径长度 512 / 深度 32** 由 `@rebaseagent/trace-sdk` 的 `logical-path.ts` **强制**
 *   （清单 schema 与工具写入共用那份校验），这里只是把它们收进同一个对象，避免调用方
 *   从两处各取一半。所以真值源仍是 trace-sdk，此处不得另写字面量。
 *
 * ## 调用方不能放宽
 *
 * 设计明确"配额不是授权开关，调用方不能覆盖上限"，因此这些判定函数**不接受 quota 参数**：
 * 想改上限只能改本文件（并同步 spec）。
 *
 * ## 边界语义（各段用例钉住的那几条）
 *
 * - 上限本身**合法**：2000 个文件、单文件恰好 8 MiB、合计恰好 64 MiB、新增恰好 128 MiB 都放行；
 * - **零字节文件合法**（空文件是合法内容，不计为"无内容"）；
 * - "新增内容字节"按**本 run 产出的唯一哈希集合**求和（同内容写两次只算一次）——
 *   该派生本身在 2.5/3.2，这里只判它的结果。
 *
 * ## 本模块**不做**的事（别把勾打错）
 *
 * - 导入时的两遍集合/内容核对、LLM 前的整体拒绝 → 2.4；
 * - 运行期写入超限转成**工具错误**并保持旧映射 → 3.2；
 * - "当前快照/新增内容"两套配额的派生与分支级映射 → 2.5。
 * 也就是说：这里交付的是**契约与判定**，接线在后续任务。
 */

/** 1 MiB = 1024² 字节。配额用二进制单位，与"8 MiB 单文件"这类口径一致 */
export const BYTES_PER_MIB = 1024 * 1024;

/** 隔离文件世界的容量上限（全部为硬上限，第一版不可配置） */
export interface WorkspaceQuota {
  /** 世界内文件数上限 */
  readonly maxFiles: number;
  /** 单个文件字节数上限 */
  readonly maxFileBytes: number;
  /** 当前快照（清单内全部文件）合计字节上限 */
  readonly maxSnapshotBytes: number;
  /** 一次运行新增的唯一内容字节上限 */
  readonly maxNewContentBytes: number;
  /** 单条逻辑路径长度上限（UTF-16 单元，含分隔符）——真值源在 trace-sdk */
  readonly maxPathLength: number;
  /** 单条逻辑路径深度上限（段数，含文件名段）——真值源在 trace-sdk */
  readonly maxPathDepth: number;
}

/** 首期配额数值（A design §3：2000 / 8 MiB / 64 MiB / 128 MiB / 512 / 32） */
export const WORKSPACE_QUOTA: WorkspaceQuota = Object.freeze({
  maxFiles: 2000,
  maxFileBytes: 8 * BYTES_PER_MIB,
  maxSnapshotBytes: 64 * BYTES_PER_MIB,
  maxNewContentBytes: 128 * BYTES_PER_MIB,
  maxPathLength: MAX_LOGICAL_PATH_LENGTH,
  maxPathDepth: MAX_LOGICAL_PATH_DEPTH,
});

/** 参与文件集合配额判定的最小信息：逻辑路径 + 字节数（顺序用于让报错稳定） */
export interface QuotaFileEntry {
  readonly path: string;
  readonly bytes: number;
}

/**
 * 一组文件的静态配额判定：文件数 → 单文件 → 合计；超限返回中文原因，合规返回 `null`。
 *
 * 两个调用点用**同一个**函数是刻意的：导入（2.4，对采集到的集合判，超限则零 LLM 拒绝）与
 * 运行期写入（3.2，对写入后的映射判，超限则成为工具错误）如果各写一份，两处的边界迟早不一致。
 *
 * 判定顺序固定（先集合规模、再单文件、后合计）：同一组文件在任何机器上报同一条原因。
 */
export function findFileSetQuotaViolation(files: readonly QuotaFileEntry[]): string | null {
  if (files.length > WORKSPACE_QUOTA.maxFiles) {
    return `文件数超过上限 ${WORKSPACE_QUOTA.maxFiles}（当前 ${files.length}）`;
  }

  for (const entry of files) {
    if (entry.bytes > WORKSPACE_QUOTA.maxFileBytes) {
      return `单文件超过上限 ${WORKSPACE_QUOTA.maxFileBytes} 字节：${entry.path} 为 ${entry.bytes} 字节`;
    }
  }

  let total = 0;
  for (const entry of files) {
    total += entry.bytes;
  }
  if (total > WORKSPACE_QUOTA.maxSnapshotBytes) {
    return `快照合计超过上限 ${WORKSPACE_QUOTA.maxSnapshotBytes} 字节（当前 ${total}）`;
  }

  return null;
}

/**
 * 一次运行新增唯一内容的配额判定；超限返回中文原因，合规返回 `null`。
 *
 * `newBytes` 由调用方按"本 run 实际产出的唯一哈希集合"求和（2.5/3.2 派生）：同内容写两次
 * 只算一次，因此重复写入不会把配额耗光——这也正是它必须与单文件/合集配额分开判的原因。
 */
export function findNewContentQuotaViolation(newBytes: number): string | null {
  if (newBytes > WORKSPACE_QUOTA.maxNewContentBytes) {
    return `本次运行新增内容超过上限 ${WORKSPACE_QUOTA.maxNewContentBytes} 字节（当前 ${newBytes}）`;
  }
  return null;
}
