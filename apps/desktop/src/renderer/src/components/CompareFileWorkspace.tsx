import type {
  ComparePathEntry,
  CompareSideResult,
  CompareWorkspaceSnapshotsResult,
  ComparedWorkspaceFileResult,
  RunDetail,
} from "@shared/ipc";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslator } from "../i18n";
import {
  type CompareFileSide,
  type CompareFileSideState,
  compareFileSelectionKey,
  compareFileSelectorOf,
  compareSideFailureLabel,
  comparedFileSideLabel,
  expectedSnapshotIdsOf,
  referenceLabel,
  resolveCompareFileSide,
  textDiffSidesOf,
} from "../lib/compare-file-view";
import { formatBytes } from "../lib/format";
import { isIsolatedRun } from "../lib/isolated-fork";
import {
  defaultCheckpointStepId,
  detectFileLanguage,
  validateCheckpointStepId,
} from "../lib/workspace-files";
import { useAppStore } from "../store";
import { LongText } from "./LongText";
import { MonacoDiffEditor } from "./MonacoEditor";
import { ShortIdLabel } from "./ShortIdLabel";

/**
 * R2.2 6.4/6.5：双运行比较的**文件视图**。
 *
 * 两侧 selector 独立，默认各取最近自有完成步骤（无则初始），并在桌面层解析成
 * 显式 step ID；只有初始快照才省略 IPC 字段。清单与正文请求都带身份/代次守卫：
 * 换点/换 path/换对时旧响应整份丢弃，不拼混合差异。
 */

function sideLabelOf(side: CompareFileSide, translator: ReturnType<typeof useTranslator>): string {
  return translator.t(side === "left" ? "compare.sideLeft" : "compare.sideRight");
}

function sideStateReason(state: CompareFileSideState): string {
  switch (state.kind) {
    case "unavailable":
    case "not-isolated":
    case "stale":
      return state.reason;
    case "ready":
      return "";
  }
}

function sideResultOf(
  manifest: CompareWorkspaceSnapshotsResult | null,
  side: CompareFileSide,
): CompareSideResult | null {
  if (manifest === null) return null;
  return side === "left" ? manifest.left : manifest.right;
}

export function CompareFileWorkspace({
  pair,
  leftDetail,
  rightDetail,
  leftUnavailable,
  rightUnavailable,
  onBack,
  stacked = false,
}: {
  readonly pair: { readonly leftRunId: string; readonly rightRunId: string };
  readonly leftDetail: RunDetail | null;
  readonly rightDetail: RunDetail | null;
  readonly leftUnavailable: string | null;
  readonly rightUnavailable: string | null;
  readonly onBack: () => void;
  readonly stacked?: boolean;
}) {
  const translator = useTranslator();
  const fileView = useAppStore((s) => s.compareFileView);
  const ensureSelection = useAppStore((s) => s.ensureCompareFileSelection);
  const setCheckpoint = useAppStore((s) => s.setCompareFileCheckpoint);
  const setPath = useAppStore((s) => s.setCompareFilePath);
  const openSideFilesAt = useAppStore((s) => s.openCompareSideFilesAt);
  const loadSnapshots = useAppStore((s) => s.loadCompareWorkspaceSnapshots);
  const loadFile = useAppStore((s) => s.loadComparedWorkspaceFile);
  const runs = useAppStore((s) => s.runs);
  const shortIdState = useAppStore((s) => s.shortIdState);
  const shortIds = shortIdState.update(runs.map((run) => run.id));
  const pairKey = `${pair.leftRunId}\n${pair.rightRunId}`;
  const samePair = fileView.pairKey === pairKey;

  // 首次打开：在已校验详情上显式解析默认检查点（最近自有完成步骤；无则初始）
  useEffect(() => {
    if (leftDetail === null || rightDetail === null) return;
    ensureSelection({
      pairKey,
      leftStepSpanId: isIsolatedRun(leftDetail) ? defaultCheckpointStepId(leftDetail) : null,
      rightStepSpanId: isIsolatedRun(rightDetail) ? defaultCheckpointStepId(rightDetail) : null,
    });
  }, [pairKey, leftDetail, rightDetail, ensureSelection]);

  const leftState = resolveCompareFileSide(
    {
      detail: leftDetail,
      runId: pair.leftRunId,
      unavailableReason: leftUnavailable,
      savedStepSpanId: samePair ? fileView.leftStepSpanId : undefined,
    },
    translator,
  );
  const rightState = resolveCompareFileSide(
    {
      detail: rightDetail,
      runId: pair.rightRunId,
      unavailableReason: rightUnavailable,
      savedStepSpanId: samePair ? fileView.rightStepSpanId : undefined,
    },
    translator,
  );
  const ready = leftState.kind === "ready" && rightState.kind === "ready";
  const requestKey = ready
    ? compareFileSelectionKey(leftState.selection, rightState.selection)
    : null;
  const leftStep = leftState.kind === "ready" ? leftState.selection.stepSpanId : null;
  const rightStep = rightState.kind === "ready" ? rightState.selection.stepSpanId : null;
  const selectors = useMemo(() => {
    if (!ready || requestKey === null) return null;
    return {
      left: compareFileSelectorOf({ runId: pair.leftRunId, stepSpanId: leftStep }),
      right: compareFileSelectorOf({ runId: pair.rightRunId, stepSpanId: rightStep }),
    };
  }, [ready, requestKey, pair.leftRunId, pair.rightRunId, leftStep, rightStep]);

  const [manifest, setManifest] = useState<{
    readonly key: string;
    readonly result: CompareWorkspaceSnapshotsResult;
  } | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [manifestNonce, setManifestNonce] = useState(0);
  const [fileResult, setFileResult] = useState<{
    readonly key: string;
    readonly result: ComparedWorkspaceFileResult;
  } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [sideOpenError, setSideOpenError] = useState<string | null>(null);
  const manifestSeq = useRef(0);
  const fileSeq = useRef(0);

  // 清单读取：请求身份 = 两侧 selector 冻结值；迟到响应按序号丢弃
  // biome-ignore lint/correctness/useExhaustiveDependencies: manifestNonce 是显式刷新触发，不参与请求体
  useEffect(() => {
    if (selectors === null || requestKey === null) return;
    const seq = manifestSeq.current + 1;
    manifestSeq.current = seq;
    setManifestLoading(true);
    setManifestError(null);
    setManifest(null);
    setFileResult(null);
    setFileError(null);
    void loadSnapshots({ left: selectors.left, right: selectors.right }).then((response) => {
      if (seq !== manifestSeq.current) return;
      setManifestLoading(false);
      if (!response.ok) {
        setManifestError(`${response.code}：${response.message}`);
        return;
      }
      setManifest({ key: requestKey, result: response.data });
    });
  }, [requestKey, selectors, manifestNonce, loadSnapshots]);

  const currentManifest = manifest !== null && manifest.key === requestKey ? manifest.result : null;
  const expected = useMemo(() => expectedSnapshotIdsOf(currentManifest), [currentManifest]);
  const currentPath = samePair ? fileView.path : null;

  // 正文读取：path + 冻结 selectors + expectedSnapshotIds；任一项变化都换代次
  useEffect(() => {
    if (selectors === null || requestKey === null || expected === null || currentPath === null) {
      setFileLoading(false);
      setFileResult(null);
      setFileError(null);
      return;
    }
    const seq = fileSeq.current + 1;
    fileSeq.current = seq;
    const key = `${requestKey}|${currentPath}`;
    setFileLoading(true);
    setFileError(null);
    setFileResult(null);
    void loadFile({
      left: selectors.left,
      right: selectors.right,
      path: currentPath,
      expectedSnapshotIds: expected,
    }).then((response) => {
      if (seq !== fileSeq.current) return;
      setFileLoading(false);
      if (!response.ok) {
        setFileError(`${response.code}：${response.message}`);
        return;
      }
      setFileResult({ key, result: response.data });
    });
  }, [requestKey, selectors, expected, currentPath, loadFile]);

  const showManifest = currentManifest;
  const diff =
    fileResult !== null && fileResult.key === `${requestKey}|${currentPath}`
      ? textDiffSidesOf(fileResult.result)
      : null;
  const file =
    fileResult !== null && fileResult.key === `${requestKey}|${currentPath}`
      ? fileResult.result
      : null;

  const chooseCheckpoint = (side: CompareFileSide, value: string): void => {
    setCheckpoint(side, value === "initial" ? null : value);
    setSideOpenError(null);
  };

  const useDefaultCheckpoint = (side: CompareFileSide): void => {
    const detail = side === "left" ? leftDetail : rightDetail;
    if (detail === null || !isIsolatedRun(detail)) return;
    setCheckpoint(side, defaultCheckpointStepId(detail));
  };

  const openSide = (side: CompareFileSide): void => {
    const state = side === "left" ? leftState : rightState;
    if (state.kind !== "ready") return;
    setSideOpenError(null);
    void openSideFilesAt(side, state.selection.stepSpanId, currentPath).then((result) => {
      if (result === "opened") return;
      setSideOpenError(
        result === "unsupported"
          ? translator.t("compare.fileOpenUnsupported", { side: sideLabelOf(side, translator) })
          : translator.t("compare.fileOpenInvalid", { side: sideLabelOf(side, translator) }),
      );
    });
  };

  const checkpointSelect = (side: CompareFileSide, state: CompareFileSideState) => {
    if (state.kind !== "ready") return null;
    const selected = state.selection.stepSpanId ?? "initial";
    return (
      <label className="flex min-w-0 flex-wrap items-center gap-1 text-[11px] text-gray-600">
        <span>{translator.t("compare.fileCheckpoint")}</span>
        <select
          value={selected}
          onChange={(event) => chooseCheckpoint(side, event.target.value)}
          className="min-w-0 max-w-full rounded border border-gray-300 bg-white px-1 py-0.5 text-[11px]"
          data-compare-file-checkpoint={side}
        >
          {state.options.map((option) => (
            <option key={option.stepSpanId ?? "initial"} value={option.stepSpanId ?? "initial"}>
              {option.label}
            </option>
          ))}
        </select>
        {state.defaulted ? (
          <span className="text-gray-400" data-compare-file-default={side}>
            {translator.t("compare.fileDefaultNote")}
          </span>
        ) : null}
      </label>
    );
  };

  const sideHeader = (
    side: CompareFileSide,
    state: CompareFileSideState,
    detail: RunDetail | null,
  ) => {
    const runId = side === "left" ? pair.leftRunId : pair.rightRunId;
    const sideResult = sideResultOf(showManifest, side);
    const sideFailure = sideResult === null ? null : compareSideFailureLabel(sideResult);
    const exportAvailable = state.kind === "ready" && sideResult?.status === "ok";
    return (
      <div
        key={side}
        className="min-w-0 rounded border border-gray-200 bg-white px-2 py-1.5"
        data-compare-file-side={side}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-medium text-gray-700">
            {sideLabelOf(side, translator)}
          </span>
          <ShortIdLabel id={runId} shortId={shortIds.get(runId) ?? runId} />
          {isIsolatedRun(detail) ? (
            <span className="rounded bg-violet-100 px-1 text-[10px] text-violet-800">
              {translator.t("compare.fileIsolationBadge")}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => openSide(side)}
            disabled={state.kind !== "ready"}
            className="ml-auto rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
            data-compare-file-open-side={side}
          >
            {translator.t("compare.fileOpenSide", { side: sideLabelOf(side, translator) })}
          </button>
          <button
            type="button"
            onClick={() => openSide(side)}
            disabled={!exportAvailable}
            title={
              exportAvailable
                ? translator.t("compare.fileExportHint")
                : translator.t("compare.fileExportUnavailable")
            }
            className="rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
            data-compare-file-export-side={side}
          >
            {translator.t("compare.fileExportSide", { side: sideLabelOf(side, translator) })}
          </button>
        </div>
        {state.kind === "ready" ? (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {checkpointSelect(side, state)}
            {sideFailure !== null ? (
              <span className="text-[10px] text-amber-800">{sideFailure}</span>
            ) : null}
          </div>
        ) : (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] leading-4 text-amber-800">
            <span>{sideStateReason(state)}</span>
            {state.kind === "stale" ? (
              <button
                type="button"
                onClick={() => useDefaultCheckpoint(side)}
                className="rounded border border-amber-400 px-1.5 py-0.5 text-[10px] text-amber-900 hover:bg-amber-50"
                data-compare-file-use-default={side}
              >
                {translator.t("compare.fileUseDefault")}
              </button>
            ) : null}
          </div>
        )}
      </div>
    );
  };

  const renderPathRows = (entries: readonly ComparePathEntry[]) => {
    if (entries.length === 0) {
      return (
        <div className="px-2 py-3 text-[11px] text-gray-500">
          {translator.t("compare.fileNoUnion")}
        </div>
      );
    }
    return (
      <ul className="divide-y divide-gray-100" data-compare-file-path-list>
        {entries.map((entry) => (
          <li key={entry.path}>
            <button
              type="button"
              onClick={() => setPath(entry.path)}
              aria-pressed={currentPath === entry.path}
              className={`w-full px-2 py-1.5 text-left text-[11px] leading-4 hover:bg-gray-50 ${
                currentPath === entry.path ? "bg-sky-50" : ""
              }`}
            >
              <div className="break-all font-code text-gray-800">{entry.path}</div>
              <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-gray-500">
                <span>{referenceLabel(entry, translator)}</span>
                {entry.left !== null ? (
                  <span>
                    {translator.t("compare.fileBytesLeft", {
                      bytes: formatBytes(entry.left.bytes),
                    })}
                  </span>
                ) : null}
                {entry.right !== null ? (
                  <span>
                    {translator.t("compare.fileBytesRight", {
                      bytes: formatBytes(entry.right.bytes),
                    })}
                  </span>
                ) : null}
              </div>
            </button>
          </li>
        ))}
      </ul>
    );
  };

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white"
      aria-label={translator.t("compare.fileViewAria")}
      data-compare-files-view="true"
    >
      <div className="shrink-0 border-b border-gray-200 px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm text-gray-800">{translator.t("compare.fileTitle")}</h2>
          <span className="text-[11px] text-gray-500">
            {translator.t("compare.fileTarget", {
              left: pair.leftRunId,
              right: pair.rightRunId,
            })}
          </span>
          <button
            type="button"
            onClick={onBack}
            className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
            data-compare-files-back
          >
            {translator.t("compare.backToDetail")}
          </button>
          <button
            type="button"
            onClick={() => setManifestNonce((value) => value + 1)}
            disabled={!ready || manifestLoading}
            className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-40"
            data-compare-files-refresh
          >
            {translator.t("compare.fileRefresh")}
          </button>
        </div>
        <div className="mt-1 text-[10px] leading-4 text-gray-500">
          {translator.t("compare.fileIntro")}
        </div>
      </div>

      <div
        className={`grid min-h-0 flex-1 gap-2 overflow-hidden p-2 ${stacked ? "grid-cols-1" : "grid-cols-[minmax(220px,320px)_minmax(0,1fr)]"}`}
      >
        <div className="flex min-h-0 flex-col gap-2 overflow-hidden">
          {sideHeader("left", leftState, leftDetail)}
          {sideHeader("right", rightState, rightDetail)}
          {sideOpenError !== null ? (
            <div className="rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
              {sideOpenError}
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto rounded border border-gray-200">
            {!ready ? (
              <div className="px-2 py-3 text-[11px] text-gray-500">
                {translator.t("compare.fileNeedBoth")}
              </div>
            ) : manifestLoading ? (
              <div className="px-2 py-3 text-[11px] text-gray-500">
                {translator.t("compare.fileManifestLoading")}
              </div>
            ) : manifestError !== null ? (
              <div
                className="px-2 py-3 text-[11px] text-amber-800"
                data-compare-file-manifest-error
              >
                {manifestError}
                <button
                  type="button"
                  onClick={() => setManifestNonce((value) => value + 1)}
                  className="ml-2 rounded border border-amber-400 px-1.5 py-0.5 text-[10px]"
                >
                  {translator.t("compare.fileRetry")}
                </button>
              </div>
            ) : showManifest !== null ? (
              <>
                {!showManifest.unionComplete ? (
                  <div className="border-b border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] leading-4 text-amber-900">
                    {translator.t("compare.fileUnionIncomplete")}
                    {showManifest.left.status === "unavailable" ? (
                      <div>
                        {translator.t("compare.fileSideFailure", {
                          side: sideLabelOf("left", translator),
                          failure: `${showManifest.left.failure.code}: ${showManifest.left.failure.reason}`,
                        })}
                      </div>
                    ) : null}
                    {showManifest.right.status === "unavailable" ? (
                      <div>
                        {translator.t("compare.fileSideFailure", {
                          side: sideLabelOf("right", translator),
                          failure: `${showManifest.right.failure.code}: ${showManifest.right.failure.reason}`,
                        })}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {renderPathRows(showManifest.entries)}
              </>
            ) : (
              <div className="px-2 py-3 text-[11px] text-gray-500">
                {translator.t("compare.fileWaiting")}
              </div>
            )}
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded border border-gray-200">
          {currentPath === null ? (
            <div className="px-3 py-4 text-[11px] text-gray-500">
              {translator.t("compare.fileChoosePath")}
            </div>
          ) : fileLoading ? (
            <div className="px-3 py-4 text-[11px] text-gray-500">
              {translator.t("compare.fileLoading")}
            </div>
          ) : fileError !== null ? (
            <div className="px-3 py-4 text-[11px] text-amber-800" data-compare-file-error>
              {fileError}
            </div>
          ) : file !== null ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="shrink-0 border-b border-gray-100 px-3 py-1.5">
                <div className="break-all font-code text-[11px] text-gray-800">{file.path}</div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-[10px] text-gray-500">
                  <span data-compare-file-conclusion={file.conclusion}>
                    {translator.t("compare.fileConclusion", { conclusion: file.conclusion })}
                  </span>
                  <span>
                    {comparedFileSideLabel(file.left, translator.t("compare.sideLeft"), translator)}
                  </span>
                  <span>
                    {comparedFileSideLabel(
                      file.right,
                      translator.t("compare.sideRight"),
                      translator,
                    )}
                  </span>
                </div>
                {!file.textDiffEligible ? (
                  <div className="mt-1 text-[10px] leading-4 text-amber-800">
                    {translator.t("compare.fileNoDiff")}
                  </div>
                ) : null}
              </div>
              {diff !== null ? (
                <div
                  className="min-h-[200px] flex-1 overflow-hidden p-2"
                  data-testid="compare-files-diff-panel"
                >
                  <MonacoDiffEditor
                    height="100%"
                    data-monaco-host="compare-files-diff"
                    data-monaco-target={`${pair.leftRunId}:${pair.rightRunId}:${file.path}`}
                    original={diff.original}
                    modified={diff.modified}
                    language={detectFileLanguage(diff.modified)}
                    options={{ readOnly: true, renderSideBySide: true }}
                    data-testid="compare-files-diff-editor"
                  />
                </div>
              ) : (
                <div className="flex-1 overflow-y-auto p-2">
                  <FileSideFallback side={file.left} label={translator.t("compare.sideLeft")} />
                  <FileSideFallback side={file.right} label={translator.t("compare.sideRight")} />
                </div>
              )}
            </div>
          ) : (
            <div className="px-3 py-4 text-[11px] text-gray-500">
              {translator.t("compare.filePickPath")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 没有文本 diff 时的单侧呈现：文本侧仍可读原文；其他状态只给真实原因。 */
function FileSideFallback({
  side,
  label,
}: {
  readonly side: ComparedWorkspaceFileResult["left"] | ComparedWorkspaceFileResult["right"];
  readonly label: string;
}) {
  const translator = useTranslator();
  return (
    <section className="mb-2 rounded border border-gray-200 bg-white" data-compare-file-side-body>
      <div className="border-b border-gray-100 px-2 py-1 text-[11px] font-medium text-gray-600">
        {label} · {side.status}
      </div>
      {side.status === "text" ? (
        <div className="p-2">
          <LongText text={side.text} label={translator.t("compare.fileBodyLabel", { label })} />
        </div>
      ) : (
        <div className="px-2 py-2 text-[11px] leading-4 text-gray-600">
          {side.status === "binary"
            ? translator.t("compare.fileBinary", {
                bytes: formatBytes(side.file.bytes),
                sha: side.file.sha256.slice(0, 12),
              })
            : side.status === "not_found"
              ? translator.t("compare.fileNotFound", { reason: side.reason })
              : side.status === "selection_changed"
                ? translator.t("compare.fileSelectionChanged", {
                    expected: side.expectedSnapshotId.slice(0, 12),
                    actual: side.actualSnapshotId.slice(0, 12),
                  })
                : side.status === "unavailable"
                  ? translator.t("compare.fileSideUnavailable", {
                      code: side.failure.code,
                      reason: side.failure.reason,
                    })
                  : "reason" in side
                    ? side.reason
                    : translator.t("compare.fileSideUnavailableFallback")}
        </div>
      )}
    </section>
  );
}
