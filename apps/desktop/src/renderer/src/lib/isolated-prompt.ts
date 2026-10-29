import type { Translator } from "@rebaseagent/i18n";
import type { SpanLine } from "@rebaseagent/trace-sdk";
import type { IsolatedPromptCapabilityResult, RunDetail } from "@shared/ipc";
import type { PromptForkGuardInput, PromptForkGuardResult } from "./prompt-fork";

/**
 * R2.2 6.1：隔离 prompt 实验的**桌面入口判据**（纯函数）。
 *
 * 三类运行走三条路，界面不靠文案猜：
 * - 普通 run（无 `meta.workspace`）⇒ null，继续用既有普通 prompt fork；
 * - 隔离根（parent/fork 均为 null、origin=import）⇒ 独立初始快照实验；
 * - 隔离分支（result 续跑 / v3 实验子）⇒ 只给「前往经验证的根」导航，
 *   绝不把分支自有消息当作根启动上下文，也不自动搬运草稿。
 *
 * 根资格只做**入口层**事实检查；完整来源/附件/配置判据仍在 main/包层预检。
 */

export type IsolatedPromptEntry =
  | {
      readonly kind: "root";
      readonly rootId: string;
      readonly firstLlmSpanId: string;
      readonly firstLlm: Extract<SpanLine, { kind: "llm.call" }>;
    }
  | { readonly kind: "branch"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * 隔离 prompt 入口判据。返回 null = 不是隔离运行（普通入口不变）。
 */
export function isolatedPromptEntryOf(
  run: RunDetail | null,
  translator: Translator,
): IsolatedPromptEntry | null {
  if (run === null || run.meta.workspace === undefined) return null;
  if (run.meta.parent !== null || run.meta.fork !== null) {
    return {
      kind: "branch",
      reason: translator.t("fork.isoBranchEntry"),
    };
  }
  if (run.meta.workspace.origin.kind !== "import") {
    return {
      kind: "unavailable",
      reason: translator.t("fork.isoNotImportRoot"),
    };
  }
  if (run.status !== "completed") {
    return {
      kind: "unavailable",
      reason: translator.t("fork.isoNotSealed", { status: run.status }),
    };
  }
  if (run.meta.config_hash === undefined) {
    return {
      kind: "unavailable",
      reason: translator.t("fork.isoNoConfigHash"),
    };
  }
  const firstLlm = run.spans.find((span) => span.kind === "llm.call");
  if (firstLlm === undefined || firstLlm.kind !== "llm.call") {
    return {
      kind: "unavailable",
      reason: translator.t("fork.isoNoLlmCall"),
    };
  }
  if (!run.leafSpanIds.includes(firstLlm.id)) {
    return {
      kind: "unavailable",
      reason: translator.t("fork.isoFirstCallNotOwn"),
    };
  }
  return {
    kind: "root",
    rootId: run.meta.id,
    firstLlmSpanId: firstLlm.id,
    firstLlm,
  };
}

/**
 * 隔离实验的本地提交前拦截：比普通 prompt fork 多一条「启动消息至少各一条」。
 * 没有字符串 system 时两种编辑都不可用（不以 config_hash / 桌面设置 / 空串补造）。
 */
export function isolatedPromptGuard(
  input: PromptForkGuardInput,
  translator: Translator,
): PromptForkGuardResult {
  if (!input.settingsConfigured) {
    return { canSubmit: false, reason: translator.t("run.settingsRequiredForFork") };
  }
  if (!input.hasSystem) {
    return { canSubmit: false, reason: translator.t("fork.isoNoSystem") };
  }
  if (!input.hasUser) {
    return { canSubmit: false, reason: translator.t("fork.isoNoUser") };
  }
  if (input.unchanged) {
    return { canSubmit: false, reason: translator.t("fork.isoUnchanged") };
  }
  return { canSubmit: true, reason: null };
}

/** 根导航探测的结果：成功只给经验证的 rootId（不是执行授权） */
export type VerifiedRootNavigation =
  | { readonly kind: "root"; readonly rootId: string }
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * 把 `workspaces:isolatedPromptCapability` 的响应折成导航建议。
 *
 * 分支用一次只读预检探测根：包层在检查编辑之前就跑完完整父链，非根返回
 * `parent_not_root` + 经核实的 `rootId`。缺父链/成环时没有 `rootId`，这里
 * 不猜根；其余拒绝原样展示理由。
 */
export function verifiedRootNavigation(
  response:
    | { readonly ok: true; readonly data: IsolatedPromptCapabilityResult }
    | { readonly ok: false; readonly code: string; readonly message: string },
): VerifiedRootNavigation {
  if (!response.ok) {
    return { kind: "blocked", reason: `${response.code}：${response.message}` };
  }
  if (response.data.status === "ok") {
    return { kind: "root", rootId: response.data.rootId };
  }
  const data = response.data;
  if (data.code === "parent_not_root" && data.rootId !== undefined) {
    return { kind: "root", rootId: data.rootId };
  }
  return { kind: "blocked", reason: data.reason };
}
