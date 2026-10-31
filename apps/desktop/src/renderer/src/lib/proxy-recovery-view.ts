import type { Translator } from "@rebaseagent/i18n";
import type { ProxyState } from "@shared/ipc";

/**
 * tasks 2.3b：代理启动恢复的**唯一措辞源**（design D6「呈现由判据派生，不各写一套」）。
 *
 * 顶栏与录制工作区都从这份派生取值。理由很实际：这两个位置回答的是同一组问题
 * （用户保存了开启吗、真的在监听吗、为什么没起来），一旦各写一套文案，就会出现
 * "顶栏说恢复失败、录制页还写着已停"这种自相矛盾——而用户正是靠这两处判断
 * 要不要去改端口。
 *
 * 四条判据纪律（逐条对应 llm-proxy delta「保存的监听意图在启动时恢复且失败可诊断」
 * 与 desktop-ui「代理启动恢复结果就近可见」）：
 *
 * 1. 🔴 **保存启用 ≠ 真实监听**：`enabled` 只说明配置已保存。`running` 才是监听事实。
 *    失败时两行必须同时说"已启用"和"未监听"，不能只说一边。
 * 2. 🔴 **失败不说成已停用**：失败时 `enabled` 仍是 true（2.3a 刻意不回滚），
 *    措辞不能说成"已停用"，否则用户以为是自己关的。
 * 3. 🔴 **恢复中不是停止**：`recovering` 期间必须显式说"正在恢复"，
 *    否则启动那几秒界面会闪一个"已停"，正好停在用户最该知道真相的时刻。
 * 4. 🔴 **诊断只在有诊断时出现**，且原样透出受控文案（2.3a 已脱敏限长）；
 *    没有诊断就明说"原因未记录"，不编一个。
 */

export type ProxyRecoveryPhase = "unknown" | "recovering" | "listening" | "stopped" | "failed";

export interface ProxyRecoveryView {
  /** 四态 + 未知（状态未读到）。渲染层据此选圆点颜色与文案，不自己判断 */
  readonly phase: ProxyRecoveryPhase;
  /** 顶栏用的短文案（按钮内一行说完，不放长诊断） */
  readonly headline: string;
  /** 录制页「本地监听」行的值 */
  readonly listenLine: string;
  /** 本地化失败摘要（仅 failed 时非 null；按稳定 code 投影，可行动） */
  readonly reason: string | null;
  /** 受控失败的原始诊断（仅确有诊断时非 null；原样透出，不二次加工） */
  readonly reasonDetail: string | null;
  /**
   * 是否需要在顶栏给出录制页入口。
   * 恢复中与失败都要：这两态用户都需要"为什么 / 怎么办"的详情，就近可得的成本最低。
   */
  readonly needsRecordingEntry: boolean;
}

function unknownView(translator: Translator): ProxyRecoveryView {
  return {
    phase: "unknown",
    headline: translator.t("recording.unknownHeadline"),
    listenLine: translator.t("recording.unknownListenLine"),
    reason: null,
    reasonDetail: null,
    needsRecordingEntry: false,
  };
}

/** 失败摘要按稳定类别投影（原始诊断另走 reasonDetail，不把中文原文当产品解释） */
function failureReasonText(
  code: "PORT_UNAVAILABLE" | "LISTEN_FAILED" | "UNKNOWN",
  translator: Translator,
): string {
  switch (code) {
    case "PORT_UNAVAILABLE":
      return translator.t("recording.failedReasonPortUnavailable");
    case "LISTEN_FAILED":
      return translator.t("recording.failedReasonListenFailed");
    case "UNKNOWN":
      return translator.t("recording.failedReasonUnknown");
  }
}

/**
 * 从只读代理状态派生恢复视图。
 *
 * ⚠️ `statusReadFailed` 与 `proxy === null` 走同一条路：两者都意味着"没有可核实的
 * 当前事实"。此时**不沿用上一次的值**——沿用会把"上次成功"说成"现在还好着"，
 * 那正是 delta「恢复中到监听成功同步呈现」要防的那类假事实。
 */
export function proxyRecoveryView(
  proxy: ProxyState | null,
  statusReadFailed: boolean,
  translator: Translator,
): ProxyRecoveryView {
  if (statusReadFailed || proxy === null) return unknownView(translator);

  // 判据 3：恢复中优先于 running。恢复期间 running 必为 false，但"正在恢复"
  // 才是此刻最有价值的事实，不能退化成"已停"。
  if (proxy.recovery === "recovering") {
    return {
      phase: "recovering",
      headline: translator.t("recording.recoveringHeadline"),
      listenLine: translator.t("recording.recoveringListenLine", { port: proxy.port }),
      reason: null,
      reasonDetail: null,
      needsRecordingEntry: true,
    };
  }

  if (proxy.recovery === "failed") {
    const failure = proxy.recoveryFailure;
    return {
      phase: "failed",
      // 判据 2：不说"已停"。enabled 仍为 true，用户没关过。
      headline: translator.t(
        proxy.enabled ? "recording.failedHeadlineEnabled" : "recording.failedHeadline",
      ),
      // 判据 1：意图与监听两件事分别说清，不混成一句
      listenLine: translator.t(
        proxy.enabled ? "recording.failedListenEnabled" : "recording.failedListen",
      ),
      // 判据 4：没有诊断就明说没记录，不编
      reason:
        failure === null
          ? translator.t("recording.failedReasonNoDiagnostic")
          : failureReasonText(failure.code, translator),
      reasonDetail: failure === null ? null : failure.message,
      needsRecordingEntry: true,
    };
  }

  if (proxy.running) {
    return {
      phase: "listening",
      headline: translator.t("recording.listeningHeadline", { port: proxy.port }),
      listenLine: translator.t("recording.listeningLine", { port: proxy.port }),
      reason: null,
      reasonDetail: null,
      needsRecordingEntry: false,
    };
  }

  // stopped：区分"用户本来就没开"与"开着但已停"，文案不混
  return {
    phase: "stopped",
    headline: translator.t(
      proxy.enabled ? "recording.stoppedHeadlineEnabled" : "recording.stoppedHeadline",
    ),
    listenLine: translator.t(
      proxy.enabled ? "recording.stoppedLineEnabled" : "recording.stoppedLine",
    ),
    reason: null,
    reasonDetail: null,
    needsRecordingEntry: false,
  };
}

/** 顶栏圆点颜色：跟随 phase，文字另有 headline，两者不靠颜色单打独斗 */
export function proxyPhaseDotClass(phase: ProxyRecoveryPhase): string {
  switch (phase) {
    case "listening":
      return "bg-emerald-500";
    case "recovering":
      return "bg-amber-500";
    case "failed":
      return "bg-red-500";
    default:
      return "bg-gray-300";
  }
}
