import type { ProxyState, ProxyToggleInput } from "@shared/ipc";

/**
 * U8 任务 2.1–2.4：**录制配置草稿**（design D2）。
 *
 * 独立数据结构（不进 `debugging-drafts` 仓库，也不进创建/A-B 那套修订体系——
 * design D2 明文「复用 U3 修订/CAS 放弃规则，但保持独立数据结构」）：
 *
 * - **baseline**（最近可核实的代理配置）：dirty 的唯一参照。`null` = 代理状态尚未读到
 *   （「状态待读取」）——没有可比的「当前应用值」，此时**不**把字段算作修改
 *   （与 `settings-form` 的「代理状态未读到 ⇒ 不算修改」同一口径）；
 * - **原始文本**（portText / upstreamText）：无损保存——无效端口、未完成 URL 原样保留，
 *   明确应用时才解析；默认值 18787 / deepseek 只作输入起点，**不充当已保存事实**；
 * - **单调修订**：任何字段实际变化推进修订；相同写入返回原引用（防 ABA 与无谓订阅）。
 *   草稿不含凭据值、执行许可或持久化计划；只存 renderer 会话，不落盘、不进 IPC。
 */

export interface RecordingBaseline {
  readonly enabled: boolean;
  readonly port: number;
  readonly upstreamBaseUrl: string;
}

export interface RecordingDraft {
  readonly baseline: RecordingBaseline | null;
  readonly enabled: boolean;
  readonly portText: string;
  readonly upstreamText: string;
  readonly revision: number;
}

/** 默认输入起点（delta：默认端口 18787 / upstream deepseek；不充当已保存事实） */
export const RECORDING_DEFAULT_PORT_TEXT = "18787";
export const RECORDING_DEFAULT_UPSTREAM = "https://api.deepseek.com";

/** 已核实的 ProxyState → baseline（字段同源照抄，不推断） */
export function recordingBaselineOf(state: ProxyState): RecordingBaseline {
  return { enabled: state.enabled, port: state.port, upstreamBaseUrl: state.upstreamBaseUrl };
}

/**
 * 确保草稿在场：已存在原样返回（重进页面不覆盖输入，U3 ensure 同纪律）；
 * 不存在时从已核实状态初始化（读到什么填什么），状态未读 ⇒ 用默认值起点且 baseline 为 null。
 */
export function ensureRecordingDraft(
  existing: RecordingDraft | null,
  verified: RecordingBaseline | null,
): RecordingDraft {
  if (existing !== null) return existing;
  return {
    baseline: verified,
    enabled: verified?.enabled ?? false,
    portText: verified !== null ? String(verified.port) : RECORDING_DEFAULT_PORT_TEXT,
    upstreamText: verified?.upstreamBaseUrl ?? RECORDING_DEFAULT_UPSTREAM,
    revision: 1,
  };
}

/** 状态回读落地：更新 baseline（最近可核实事实），**不动**用户输入（导航/读取不得清输入） */
export function applyRecordingBaseline(
  draft: RecordingDraft,
  verified: RecordingBaseline | null,
): RecordingDraft {
  if (
    draft.baseline?.enabled === verified?.enabled &&
    draft.baseline?.port === verified?.port &&
    draft.baseline?.upstreamBaseUrl === verified?.upstreamBaseUrl
  ) {
    return draft;
  }
  return { ...draft, baseline: verified };
}

export interface RecordingDraftPatch {
  readonly enabled?: boolean;
  readonly portText?: string;
  readonly upstreamText?: string;
}

/** 字段写入：任一字段实际变化推进修订；零变化返回原引用（相同写入不换引用） */
export function writeRecordingDraft(
  draft: RecordingDraft,
  patch: RecordingDraftPatch,
): RecordingDraft {
  const enabled = patch.enabled ?? draft.enabled;
  const portText = patch.portText ?? draft.portText;
  const upstreamText = patch.upstreamText ?? draft.upstreamText;
  if (
    enabled === draft.enabled &&
    portText === draft.portText &&
    upstreamText === draft.upstreamText
  ) {
    return draft;
  }
  return { ...draft, enabled, portText, upstreamText, revision: draft.revision + 1 };
}

/**
 * dirty = 未应用字段偏离**已核实** baseline。
 * baseline 尚未读到（null）⇒ 不是 dirty（没有可比的当前应用值，默认表单也不误报）；
 * 服务是否 running 不参与 dirty 判定（design D2 明文）。
 */
export function isRecordingDraftDirty(draft: RecordingDraft): boolean {
  if (draft.baseline === null) return false;
  return (
    draft.enabled !== draft.baseline.enabled ||
    draft.portText !== String(draft.baseline.port) ||
    draft.upstreamText !== draft.baseline.upstreamBaseUrl
  );
}

export interface RecordingDiscardResult {
  readonly draft: RecordingDraft | null;
  readonly discarded: boolean;
}

/**
 * 明确放弃（CAS）：修订一致才恢复 baseline 值（新修订，防 ABA 复用旧确认）；
 * 不一致 ⇒ 原样返回且 discarded=false（旧确认不能删除新输入）。
 * **不调用任何配置写通道**（放弃只是本地恢复，与 main 无关）。
 */
export function discardRecordingDraft(
  draft: RecordingDraft,
  expectedRevision: number,
): RecordingDiscardResult {
  if (draft.revision !== expectedRevision) return { draft, discarded: false };
  const restored: RecordingDraft = {
    baseline: draft.baseline,
    enabled: draft.baseline?.enabled ?? false,
    portText: draft.baseline !== null ? String(draft.baseline.port) : RECORDING_DEFAULT_PORT_TEXT,
    upstreamText: draft.baseline?.upstreamBaseUrl ?? RECORDING_DEFAULT_UPSTREAM,
    revision: draft.revision + 1,
  };
  return { draft: restored, discarded: true };
}

// ---------------------------------------------------------------------------
// 任务 2.4：应用前字段校验（完整整数 + URL；拒绝在字段处发生，零配置写调用）
// ---------------------------------------------------------------------------

/**
 * 端口校验：**完整**整数文本 1–65535。
 * 不用 parseInt——`18787abc`、小数、空值、0、65536 全部在字段处拒绝
 * （renderer 的字段级拒绝严于 main schema 的 number 类型，属纵深防御；
 * 判据核心是「拒绝时不产生任何配置写调用」，见定向测试）。
 */
export function recordingPortError(portText: string): string | null {
  if (!/^-?\d+$/.test(portText)) {
    return portText === "" ? "端口不能为空" : `端口必须是完整整数（收到「${portText}」）`;
  }
  const value = Number(portText);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    return "端口必须在 1–65535 之间";
  }
  return null;
}

/** upstream 校验：与 main schema 的 z.string().url() 同判据（URL 构造器） */
export function recordingUpstreamError(upstreamText: string): string | null {
  if (upstreamText === "") return "upstream 不能为空";
  try {
    new URL(upstreamText);
    return null;
  } catch {
    return `upstream 必须是合法 URL（收到「${upstreamText}」）`;
  }
}

export interface RecordingFieldErrors {
  readonly port: string | null;
  readonly upstream: string | null;
}

export type RecordingApplyRequest =
  | { readonly ok: true; readonly input: ProxyToggleInput }
  | { readonly ok: false; readonly errors: RecordingFieldErrors };

/** 应用请求构造（判据与提交同源）：任一字段非法 ⇒ 不产出请求（零配置写调用） */
export function recordingApplyRequest(
  draft: RecordingDraft,
): { ok: true; input: ProxyToggleInput } | { ok: false; errors: RecordingFieldErrors } {
  const portError = recordingPortError(draft.portText);
  const upstreamError = recordingUpstreamError(draft.upstreamText);
  if (portError !== null || upstreamError !== null) {
    return { ok: false, errors: { port: portError, upstream: upstreamError } };
  }
  return {
    ok: true,
    input: {
      enabled: draft.enabled,
      port: Number(draft.portText),
      upstreamBaseUrl: draft.upstreamText,
    },
  };
}
