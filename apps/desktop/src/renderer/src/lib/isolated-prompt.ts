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
export function isolatedPromptEntryOf(run: RunDetail | null): IsolatedPromptEntry | null {
  if (run === null || run.meta.workspace === undefined) return null;
  if (run.meta.parent !== null || run.meta.fork !== null) {
    return {
      kind: "branch",
      reason:
        "该运行是隔离分支：启动指令实验只能从根运行发起。请显式前往经验证的根运行，核对初始输入与文件后重新编辑；分支自有的消息不会被当作根启动上下文，草稿也不会自动搬运。",
    };
  }
  if (run.meta.workspace.origin.kind !== "import") {
    return {
      kind: "unavailable",
      reason:
        "该隔离运行不是从源目录采集的根（origin 不是 import），不能作为启动指令实验的基线；请回到采集该世界的根运行。",
    };
  }
  if (run.status !== "completed") {
    return {
      kind: "unavailable",
      reason: `运行尚未封存（当前 ${run.status}）：启动指令实验需要已封存且来源完整的根记录，请等运行结束后再试。`,
    };
  }
  if (run.meta.config_hash === undefined) {
    return {
      kind: "unavailable",
      reason:
        "该根运行没有录制 config_hash：无法确认原 system 与固定工具表来源，启动指令实验不可用。",
    };
  }
  const firstLlm = run.spans.find((span) => span.kind === "llm.call");
  if (firstLlm === undefined || firstLlm.kind !== "llm.call") {
    return {
      kind: "unavailable",
      reason:
        "该根运行的轨迹里没有 llm.call：无法从真实首次请求重建启动上下文，启动指令实验不可用。",
    };
  }
  if (!run.leafSpanIds.includes(firstLlm.id)) {
    return {
      kind: "unavailable",
      reason:
        "该根运行的首次 llm.call 不是自有记录（自有读取不完整）：不能把它当作本次实验的启动上下文。",
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
export function isolatedPromptGuard(input: PromptForkGuardInput): PromptForkGuardResult {
  if (!input.settingsConfigured) {
    return {
      canSubmit: false,
      reason: "尚未配置运行参数（baseURL / apiKey / model），请先点击右上角“运行配置”",
    };
  }
  if (!input.hasSystem) {
    return {
      canSubmit: false,
      reason:
        "首次 llm.call 不含字符串形式的 system 消息：隔离实验无法重建启动上下文，system 与 user 两种编辑均不可用（不会用 config_hash、桌面设置或空字符串补造原值）。",
    };
  }
  if (!input.hasUser) {
    return {
      canSubmit: false,
      reason:
        "隔离实验要求启动消息至少包含字符串 system 与 user 各一条；当前缺少 user 消息，两种编辑均不可用。",
    };
  }
  if (input.unchanged) {
    return {
      canSubmit: false,
      reason: "与原值相同，请修改后再核对；未做修改的隔离实验会被原样拒绝。",
    };
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
