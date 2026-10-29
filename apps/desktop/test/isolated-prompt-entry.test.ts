import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * R2.2 6.1：隔离 prompt 入口的**接线契约**（本包无 jsdom，组件状态喂不进静态渲染）。
 *
 * 判据：
 * - 根/分支/不可用三态由纯判据决定，LlmCallDetail 不再用一条“prompt 与 A/B 都不支持”
 *   的合并文案把新入口一起禁掉；
 * - 根走既有 PromptForkEditor（mode=isolated），分支只给经验证根的导航；
 * - 概览页头提供「修改启动指令」；草稿身份带模式，假设/判据随草稿写入。
 */

function read(path: string): string {
  return readFileSync(resolve(import.meta.dirname, "../src/renderer/src", path), "utf8");
}

describe("隔离 prompt 入口接线", () => {
  it("LlmCallDetail：根复用 PromptForkEditor(mode=isolated)，分支只给导航，A/B 提示独立", () => {
    const src = read("components/detail/LlmCallDetail.tsx");
    expect(src).toContain("isolatedPromptEntryOf(run, translator)");
    expect(src).toContain('mode="isolated"');
    expect(src).toContain(
      "<IsolatedPromptBranchNavigation detail={run} reason={isolatedPrompt.reason} />",
    );
    expect(src).toContain("<IsolatedParentUnsupportedNotice run={run} />");
    expect(src).toContain("data-isolated-prompt-unavailable");
  });

  it("概览页头：隔离根/分支入口挂到 OverviewResultView，普通运行由纯判据返回 null", () => {
    const overview = read("components/OverviewPanel.tsx");
    expect(overview).toContain("startupPromptAction");
    expect(overview).toContain(
      "startupPromptAction={<IsolatedPromptEntryAction detail={detail} />}",
    );
    const entry = read("components/detail/IsolatedPromptEntry.tsx");
    expect(entry).toContain("isolatedPromptEntryOf(detail, translator)");
    expect(entry).toContain('mode: "isolated"');
    expect(entry).toContain("verifiedRootNavigation");
    expect(entry).toContain("data-isolated-prompt-goto-root");
  });

  it("PromptForkEditor：隔离模式用专属 guard/draft 键，假设与判据随草稿写入", () => {
    const src = read("components/detail/PromptForkEditor.tsx");
    expect(src).toContain("isolatedPromptGuard");
    expect(src).toContain("mode?: CallDraftMode");
    expect(src).toContain('...(isolated ? { mode: "isolated" as const } : {})');
    expect(src).toContain("writeCallDraftNotes");
    expect(src).toContain('data-isolated-note="hypothesis"');
    expect(src).toContain('data-isolated-note="acceptance-criterion"');
    // 隔离模式没有普通 prompt 提交按钮（6.1 仅入口与草稿；提交归 6.3）
    expect(src).toContain("isolated\n        ? null\n        : (() => {");
    expect(src).toContain("{isolated ? null : (");
  });

  it("6.3：提交走独立 channel 与统一主动通道，响应按关联收尾", () => {
    const src = read("components/detail/PromptForkEditor.tsx");
    expect(src).toContain("resolveIsolatedPromptSubmission(");
    expect(src).toContain('channel: "prompt_experiment"');
    expect(src).toContain("confirmation: promptBinding");
    expect(src).toContain("promptExperiment(isolatedSubmission.request, assoc)");
    expect(src).toContain("data-isolated-prompt-submit-button");
    const ops = read("store/slices/operations.ts");
    expect(ops).toContain("async promptExperiment(request, submission)");
    expect(ops).toContain("submitActive(api.promptFork, request, submission)");
    // 与普通 prompt/result 同一收尾：明确响应之后才解除冻结，任何响应都不删草稿
    const start = ops.indexOf("async promptExperiment(request, submission)");
    const body = ops.slice(start, ops.indexOf("async modelAb(", start));
    expect(body).toContain("get().finishDraftSubmission(submission, envelope)");
    expect(body).not.toContain("loadRuns()");
    expect(body).not.toContain("selectRun(");
  });

  it("分支导航只采纳预检返回的 rootId：缺 rootId 时展示原因，不猜根", () => {
    const src = read("components/detail/IsolatedPromptEntry.tsx");
    expect(src).toContain("verifiedRootNavigation(response)");
    expect(src).toContain('navigation.kind === "blocked"');
    expect(src).toContain("selectRun(navigation.rootId)");
  });

  it("6.2：只读核对走 capability 端点，费用确认/副本授权默认未选并绑定现场", () => {
    const src = read("components/detail/PromptForkEditor.tsx");
    expect(src).toContain("loadIsolatedPromptCapability");
    expect(src).toContain("data-isolated-prompt-check-button");
    expect(src).toContain("restartExecutionCheck(draftKeyOf(field))");
    expect(src).toContain("lastSettingsStamp");
    expect(src).toContain("data-isolated-billing");
    expect(src).toContain("data-isolated-writes-authorization");
    // 默认未选：授权键初值为 null；勾选才写当前现场的 key
    expect(src).toContain("useState<string | null>(null)");
    expect(src).toContain("setAuthorizedKey(event.target.checked ? authorizationKey : null)");
    // 离开/切字段撤销：清理与取消路径都释放确认
    expect(src).toContain("releaseExecutionConfirmation(draftKeyOf(field))");
    // 不能把授权写进草稿仓库（注释里提到历史字段名不算）
    const draftsLib = read("lib/debugging-drafts.ts");
    expect(draftsLib).not.toContain("readonly writesAuthorized");
    expect(draftsLib).not.toContain("readonly allowFileWrites");
  });
});
