import { RunDetailReadError, classifyReadFailure } from "@rebaseagent/run-query";
import type { RunQueryToolErrorCode } from "@rebaseagent/run-query";
import { z } from "zod";
import { MESSAGE_MAX } from "./limits.js";

/**
 * 业务错误投影（design D4 的错误域 + S06）。
 *
 * 关键取舍：**消息来自码表，不来自异常文本**。共享层的中文原因是给桌面看的，
 * 里面可能出现物理文件位置；MCP 只回"哪一类不成立"，物理路径、errno、堆栈
 * 一律不过这一层。分类一律按结构（`RunDetailReadError.code` /
 * `classifyReadFailure` 的 instanceof 与 code 判定），不解析文字。
 */

/** 每个稳定码一句受控文案（封闭集合：新增码必须同时新增文案） */
export const TOOL_ERROR_MESSAGES: Readonly<Record<RunQueryToolErrorCode, string>> = {
  INVALID_ARGUMENT: "参数不符合本工具的约束",
  RUN_NOT_FOUND: "指定 run 不存在",
  RUN_INVALID: "指定 run 的记录无法通过校验",
  UNSUPPORTED_TRACE_VERSION: "该 run 的 trace 版本不受支持",
  IDENTITY_MISMATCH: "文件名与记录内的 run 标识不一致",
  ANCESTOR_INVALID: "该 run 的祖先记录无法通过校验",
  ANCESTOR_UNREADABLE: "该 run 的祖先记录当前不可读",
  LINEAGE_CYCLE: "该 run 的父链存在环",
  FORK_INVALID: "该 run 的分叉声明不合法",
  /**
   * 同一码承载两件事（4.4 起；4.2 原文只写了检查点那一半）：
   * `inspect_checkpoint` 的「指定 step 不是本 run 自有完成步骤」与
   * `get_step` 的「该 span 被当前投影截断/根本不在投影里」。
   * 两者的对外结论是同一个——**在这个可读投影里定位不到**，而具体是哪一种由 `ref`
   * 区分（`span:<id>` vs `span:<id>@owner:<runId>`），不必再造第二个码（D4 码表封闭）。
   */
  STEP_NOT_FOUND: "指定步骤或 span 在当前可读投影里不可定位",
  SPAN_AMBIGUOUS: "该 span 标识在投影内不唯一，需要显式 owner",
  NO_WORKSPACE: "该 run 不是隔离运行，没有文件检查点",
  CHECKPOINT_NOT_FOUND: "指定检查点不存在",
  STORAGE_IO: "存储读取失败，可稍后重试",
  STALE_CURSOR: "续读游标已过期，请从首页重新查询",
  RESPONSE_LIMIT: "单项结果无法容纳在响应预算内",
} as const;

/** 可重试码：只有"换个时点再来一次"有意义的才 true */
const RETRYABLE_CODES: ReadonlySet<RunQueryToolErrorCode> = new Set<RunQueryToolErrorCode>([
  "STORAGE_IO",
  "STALE_CURSOR",
]);

/**
 * 码表键的运行时枚举：外部投影里凡是带稳定码的字段都用它，码表增删自动跟随，
 * 不存在「投影 schema 忘了同步某个新码」的第二份清单。
 */
export const ToolErrorCodeSchema = z.enum(
  Object.keys(TOOL_ERROR_MESSAGES) as [RunQueryToolErrorCode, ...RunQueryToolErrorCode[]],
);

export interface ProjectedToolError {
  readonly code: RunQueryToolErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export function retryableOf(code: RunQueryToolErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

/** 按结构分类异常，再查码表取文案（异常文本本身不进结果） */
export function projectThrowable(error: unknown): ProjectedToolError {
  const code = error instanceof RunDetailReadError ? error.code : classifyReadFailure(error);
  return { code, message: TOOL_ERROR_MESSAGES[code], retryable: retryableOf(code) };
}

/** 参数校验失败：只回"哪个字段以哪一类方式不合"，不透传 zod issue 原文与取值 */
export function projectArgumentError(
  issues: readonly z.ZodIssue[],
  maxIssues = 3,
): ProjectedToolError {
  const summary = issues
    .slice(0, maxIssues)
    .map((issue) => `${issue.path.join(".") || "(root)"}:${issue.code}`)
    .join(",");
  return {
    code: "INVALID_ARGUMENT",
    message: `参数不符合本工具的约束（${summary}）`,
    retryable: false,
  };
}

/** 已知码判定（实现里若出现码表外的码，宁可判为不可重试也不静默发送） */
export function isKnownToolErrorCode(code: string): code is RunQueryToolErrorCode {
  return Object.prototype.hasOwnProperty.call(TOOL_ERROR_MESSAGES, code);
}

/**
 * 受控文案的码点有界化（design D4/D6）。
 *
 * 两个来源共用这一条口径：码表文案本身，以及共享层带来的**状态原因**
 * （附件不可用/清单缺失的中文说明）。后者是给桌面的展示文本，外发前同样要有界——
 * 按码点截断而不是按 UTF-16 单元，代理对不会被切成半个字符。
 */
export function boundedMessage(text: string): string {
  const chars = [...text];
  return chars.length <= MESSAGE_MAX ? text : `${chars.slice(0, MESSAGE_MAX).join("")}…`;
}
