import type { RunDetail } from "@shared/ipc";
import { useState } from "react";
import { useTranslator } from "../../i18n";
import { isolatedPromptEntryOf, verifiedRootNavigation } from "../../lib/isolated-prompt";
import { useAppStore } from "../../store";

/**
 * R2.2 6.1：隔离 prompt 实验的桌面入口。
 *
 * - 根：概览/首次 llm.call 提供「修改启动指令」——走进既有 prompt 工作区并绑定
 *   隔离草稿目标（模式 + 根 + 字段），不建第二份编辑器；
 * - 分支：只给「前往根运行查看启动指令」。根 id 必须经一次只读预检的完整父链核实，
 *   拿不到 `rootId` 就不猜、不换点；
 * - 根资格不足（未封存/无首次调用/非 import 根）：常驻原因，不显示可执行动作。
 */

export function IsolatedPromptEntryAction({
  detail,
  compact = false,
}: {
  detail: RunDetail;
  compact?: boolean;
}) {
  const translator = useTranslator();
  const entry = isolatedPromptEntryOf(detail, translator);
  const openDraftAt = useAppStore((s) => s.openDraftAt);
  if (entry === null) return null;
  if (entry.kind === "root") {
    return (
      <div
        className={
          compact
            ? "flex flex-wrap items-center gap-2"
            : "flex flex-wrap items-center gap-2 border-b border-violet-200 bg-violet-50/60 px-3 py-1.5"
        }
        data-isolated-prompt-entry="root"
      >
        <button
          type="button"
          data-isolated-prompt-start
          onClick={() => {
            void openDraftAt({
              runId: entry.rootId,
              spanId: entry.firstLlmSpanId,
              field: "system_prompt",
              mode: "isolated",
            });
          }}
          className="rounded bg-violet-700 px-2 py-0.5 text-reading-meta text-white hover:bg-violet-800"
        >
          {translator.t("fork.isoEditStartPrompt")}
        </button>
        <span className="text-reading-meta leading-5 text-violet-900">
          {translator.t("fork.isoEditStartIntro")}
        </span>
      </div>
    );
  }
  return <IsolatedPromptBranchNavigation detail={detail} reason={entry.reason} compact={compact} />;
}

/**
 * 分支入口：显式导航到经验证的根。预检只读（不占槽、不登记操作、不调模型）；
 * 探测请求的编辑值不被使用——包层在检查编辑前就完成父链/根判定。
 */
export function IsolatedPromptBranchNavigation({
  detail,
  reason,
  compact = false,
}: {
  detail: RunDetail;
  reason: string;
  compact?: boolean;
}) {
  const translator = useTranslator();
  const loadCapability = useAppStore((s) => s.loadIsolatedPromptCapability);
  const selectRun = useAppStore((s) => s.selectRun);
  const setReadingTab = useAppStore((s) => s.setReadingTab);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const goToRoot = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const response = await loadCapability({
      rootRunId: detail.meta.id,
      edit: { field: "system_prompt", value: "" },
    });
    const navigation = verifiedRootNavigation(response);
    if (navigation.kind === "blocked") {
      setBusy(false);
      setError(navigation.reason);
      return;
    }
    await selectRun(navigation.rootId);
    setReadingTab(navigation.rootId, "overview");
    setBusy(false);
  };

  return (
    <div
      className={
        compact
          ? "flex flex-col gap-1"
          : "border-t border-violet-100 bg-violet-50/40 px-4 py-2 text-[11px] leading-5 text-violet-900"
      }
      data-isolated-prompt-entry="branch"
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-isolated-prompt-goto-root
          onClick={() => void goToRoot()}
          disabled={busy}
          className="rounded border border-violet-400 bg-white px-2 py-0.5 text-reading-meta text-violet-800 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {translator.t(busy ? "fork.isoVerifyingRoot" : "fork.isoGotoRoot")}
        </button>
        <span className="text-reading-meta leading-5">{reason}</span>
      </div>
      {error !== null ? (
        <div className="text-reading-meta leading-5 text-red-700" data-isolated-prompt-root-error>
          {error}
        </div>
      ) : null}
    </div>
  );
}
