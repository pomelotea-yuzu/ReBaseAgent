import { isAbsolute, join } from "node:path";
import { TraceReadError, readRun } from "@rebaseagent/trace-sdk";
import type { Fork, RunRecord } from "@rebaseagent/trace-sdk";
import { FORMAT_VERSION } from "@rebaseagent/trace-sdk/schema";

/**
 * U6（add-partial-run-reading）design D2：桌面读取适配层的**单次读取上下文**。
 *
 * 职责：把「祖先文件确实不存在」与其他一切读取失败建模为不同的结构化诊断——
 * - 只有对合法祖先 trace 路径的原生 `ENOENT` 才记缺失（ANCESTOR_NOT_FOUND ⇒ ownOnly 的唯一入口）；
 * - EACCES/EPERM/EISDIR 等按 errno code 判定（结构化，不比较异常文本），损坏/版本/身份
 *   等可证明错误优先拒绝；缺失不能遮蔽已可读 hop 上的已知无效关系（缺 fork、成环、
 *   未封存、v2 边界不属于可读直接父）；
 * - 所有失败原因都是受控中文文案：不透传物理路径、errno 原文、堆栈或解析器原始载荷；
 *   成功降级只暴露受校验的 `missingRunId`。
 *
 * 归属边界：本模块只做读取与分类；ownOnly 详情信封（completeness/spanScope/lineage）
 * 与轨迹投影在 tasks §2/§3 落地。当前 `RunRepository.getRun` 对普通/隔离 result 的
 * incomplete 结果保持严格失败（受控原因），prompt/proxy 的「链到此为止」行为不变。
 */

/** 内部读取诊断六分类（design D2；`null` = 当前 run 的普通严格读取失败） */
export type RunLineageDiagnostic =
  | "CURRENT_RUN_NOT_FOUND"
  | "ANCESTOR_NOT_FOUND"
  | "ANCESTOR_INVALID"
  | "ANCESTOR_UNREADABLE"
  | "LINEAGE_CYCLE"
  | "FORK_INVALID";

/** 严格读取失败：信封保持 GET_RUN_FAILED，message 已收敛为受控中文原因 */
export interface RunLineageFailure {
  readonly ok: false;
  readonly diagnostic: RunLineageDiagnostic | null;
  readonly message: string;
}

/**
 * 单次读取结果。`complete: false` 即 ANCESTOR_NOT_FOUND 的结构化缺失：
 * records 为「最早可读 hop → 当前 run」的连续已校验记录，missingRunId 来自
 * 最接近断点的已校验 `meta.parent`。
 */
export type RunLineageOutcome =
  | { readonly ok: true; readonly complete: true; readonly records: RunRecord[] }
  | {
      readonly ok: true;
      readonly complete: false;
      readonly records: RunRecord[];
      readonly missingRunId: string;
    }
  | RunLineageFailure;

/**
 * 校验 run 标识是否可安全拼进 `<tracesDir>/<id>.jsonl`。
 * 返回违规原因（中文短语），合法返回 `null`。
 *
 * 无分隔符 + 无 `..` ⇒ 拼接结果必然落在 tracesDir 内，无需再做 resolve 包含性判断。
 */
export function findIllegalRunIdViolation(id: string): string | null {
  if (id.length === 0) return "不能为空";
  if (id.includes("\0")) return "不能包含空字符";
  if (id.includes("/") || id.includes("\\")) return "不能包含路径分隔符";
  if (id.includes("..")) return "不能包含目录穿越片段";
  if (isAbsolute(id) || /^[a-zA-Z]:/.test(id)) return "必须是相对文件标识";
  return null;
}

/**
 * 读取一条父链：先完整校验当前 run，再逐 hop 向上。
 *
 * 每个 hop 的结构检查（身份、span 唯一性、fork/parent 自洽、封存、v2 边界）
 * 都在尝试读取更早祖先**之前**完成 ⇒ 更早祖先缺失不可能遮蔽已可证明的错误。
 * `readFile` 仅供测试注入 errno 形状的故障；生产调用方使用默认 `readRun`。
 */
export function readRunLineage(
  tracesDir: string,
  id: string,
  readFile: (file: string) => RunRecord = readRun,
): RunLineageOutcome {
  const illegal = findIllegalRunIdViolation(id);
  if (illegal !== null) {
    return { ok: false, diagnostic: null, message: `run 标识非法：${illegal}` };
  }

  // 叶 → 根顺序收集；walked[walked.length - 1] 恒为「当前 hop 的直接子 hop」
  const walked: RunRecord[] = [];
  const seen = new Set<string>([id]);
  let currentId = id;

  for (let isCurrent = true; ; isCurrent = false) {
    let record: RunRecord;
    try {
      record = readFile(joinTraceFile(tracesDir, currentId));
    } catch (e) {
      if (isMissingFileError(e)) {
        if (isCurrent) {
          return {
            ok: false,
            diagnostic: "CURRENT_RUN_NOT_FOUND",
            message: `run ${id} 的 trace 文件不存在`,
          };
        }
        // 祖先 trace 文件确实不存在：唯一允许的结构化缺失入口
        return {
          ok: true,
          complete: false,
          records: walked.slice().reverse(),
          missingRunId: currentId,
        };
      }
      if (e instanceof TraceReadError) {
        // JSON/schema/版本/跨行错误是「内容非法」，不是缺失——祖先不降级，当前 run 照常严格失败
        return readFailure(isCurrent, currentId, "ANCESTOR_INVALID", `校验失败：${e.message}`);
      }
      // 无 errno 类型的未知异常一律按不可读处理，绝不落进缺失分支（拒绝通用 catch）
      return readFailure(isCurrent, currentId, "ANCESTOR_UNREADABLE", "的 trace 文件无法读取");
    }

    if (record.meta.id !== currentId) {
      return readFailure(
        isCurrent,
        currentId,
        "ANCESTOR_INVALID",
        "的文件内容与声明的运行身份不符",
      );
    }

    const dupSpan = findDuplicateSpanIdViolation(record);
    if (dupSpan !== null) {
      return readFailure(isCurrent, currentId, "ANCESTOR_INVALID", `存在重复 span：${dupSpan}`);
    }

    const { parent, fork } = record.meta;
    if (parent !== null && fork === null) {
      return structuralFailure(`分支 run ${currentId} 缺少 fork 元数据（parent 已指向 ${parent}）`);
    }
    if (parent === null && fork !== null) {
      return structuralFailure(`根 run ${currentId} 不应携带 fork 元数据（没有可续跑的父）`);
    }

    // 关系检查用「已读到的直接子 hop」：本 hop 是它的 fork 来源，必须已封存；
    // 子 hop 是 v2 时，整轮边界必须落在本 hop 的自有记录里（resolveWholeRound 判据的
    // 可证明前半部分；前缀扫描只有完整链才能做，留给 resolveBranch）。
    const child = walked[walked.length - 1];
    if (child !== undefined) {
      if (record.status !== "completed") {
        return structuralFailure(
          `只能从已完成的 run 分支：${record.meta.id} 缺失终止事件（crashed）`,
        );
      }
      const boundary = findV2BoundaryViolation(child.meta, record);
      if (boundary !== null) {
        return structuralFailure(boundary);
      }
    }

    walked.push(record);
    if (parent === null) break;

    const illegalParent = findIllegalRunIdViolation(parent);
    if (illegalParent !== null) {
      return structuralFailure(`run ${currentId} 声明的父标识非法：${illegalParent}`);
    }
    if (seen.has(parent)) {
      return {
        ok: false,
        diagnostic: "LINEAGE_CYCLE",
        message: `parent 链成环：${parent} 重复出现`,
      };
    }
    seen.add(parent);
    currentId = parent;
  }

  return { ok: true, complete: true, records: walked.slice().reverse() };
}

/** 当前 run 的普通严格读取失败（不携带祖先诊断）；祖先失败携带对应诊断 */
function readFailure(
  isCurrent: boolean,
  runId: string,
  ancestorDiagnostic: RunLineageDiagnostic,
  reason: string,
): RunLineageFailure {
  const subject = isCurrent ? `run ${runId}` : `祖先 run ${runId}`;
  return {
    ok: false,
    diagnostic: isCurrent ? null : ancestorDiagnostic,
    message: `${subject} ${reason}`,
  };
}

/** 链上已可证明的结构/定位/关系错误（父链来源类，对当前 run 同样成立） */
function structuralFailure(message: string): RunLineageFailure {
  return { ok: false, diagnostic: "FORK_INVALID", message };
}

/** 只把原生 ENOENT 判为「文件缺失」；按 errno code 结构化判定，不比较错误文本 */
function isMissingFileError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as NodeJS.ErrnoException).code === "ENOENT";
}

function findDuplicateSpanIdViolation(record: RunRecord): string | null {
  const seen = new Set<string>();
  for (const span of record.spans) {
    if (seen.has(span.id)) return span.id;
    seen.add(span.id);
  }
  return null;
}

/**
 * v2 整轮边界对「可读直接父」的可证明校验（判据与 trace-sdk `resolveWholeRound`
 * ①②一致；③的前缀扫描依赖完整链，留给 resolveBranch 权威判定）。
 * `resume_after_step` 缺失按理到不了这里（RunMetaSchema superRefine 已拒），
 * 保留显式分支作为运行期保险。
 */
function findV2BoundaryViolation(child: RunRecord["meta"], parent: RunRecord): string | null {
  if (child.format_version !== FORMAT_VERSION || child.fork === null) return null;
  const fork: Fork = child.fork;
  const stepId = fork.resume_after_step;
  if (stepId === undefined) {
    return `v2 隔离分支 ${child.id} 缺少 fork.resume_after_step（整轮续跑边界）`;
  }
  const owned = new Map(parent.spans.map((span) => [span.id, span]));
  const step = owned.get(stepId);
  if (step === undefined) {
    return `resume_after_step ${stepId} 不在直接父 run ${parent.meta.id} 的自有记录中`;
  }
  if (step.kind !== "agent.step") {
    return `resume_after_step ${stepId} 必须是 agent.step（实际 kind=${step.kind}）`;
  }
  const edited = owned.get(fork.at_span);
  if (edited === undefined) {
    return `fork.at_span ${fork.at_span} 不在直接父 run ${parent.meta.id} 的自有记录中`;
  }
  if (edited.id === stepId) {
    return `fork.at_span 不能等于 resume_after_step（${stepId}）：编辑点是轮内工具调用，不是轮次容器`;
  }
  let ancestor: string | null = edited.parent;
  while (ancestor !== null) {
    if (ancestor === stepId) return null;
    ancestor = owned.get(ancestor)?.parent ?? null;
  }
  return `fork.at_span ${fork.at_span} 不属于 resume_after_step ${stepId} 所指的那一轮`;
}

function joinTraceFile(tracesDir: string, id: string): string {
  return join(tracesDir, `${id}.jsonl`);
}
