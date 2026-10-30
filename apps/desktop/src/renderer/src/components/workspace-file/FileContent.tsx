import type { WorkspaceReadFileResult } from "@shared/ipc";
import type { editor as MonacoEditorNs } from "monaco-editor/editor/editor.api";
import { useCallback, useRef, useState } from "react";
import { useTranslator } from "../../i18n";
import {
  type DiffMode,
  decideDiffMode,
  initialFileLayoutPrefs,
  preserveFilePrefs,
} from "../../lib/file-layout";
import {
  type ContentScrollAnchor,
  anchorMatches,
  buildContentAnchor,
  clampAnchorLine,
  resolveAnchorScrollTop,
  sameAnchor,
} from "../../lib/file-scroll";
import {
  type SideReadiness,
  copyableMeta,
  copyableText,
  resolveToolEnablement,
  sideReadiness,
} from "../../lib/file-tools";
import { formatBytes } from "../../lib/format";
import {
  type DiffSides,
  availabilityLabel,
  canCompareText,
  canEnterTextDiff,
  detectFileLanguage,
  resolveDiffSides,
} from "../../lib/workspace-files";
import { MonacoCodeEditor, MonacoDiffEditor } from "../MonacoEditor";

/** Monaco diff 编辑器实例类型（U2 任务 4.5 差异导航用） */
type IStandaloneDiffEditor = MonacoEditorNs.IStandaloneDiffEditor;

/** 复制反馈的短暂状态（就近提示，不假报成功） */
type CopyFeedback = { readonly kind: "ok" | "fail"; readonly message: string } | null;

/**
 * 单个文件的内容区。
 *
 * U2 任务 3.2 起两侧数据都由连接层独立提供，本组件只排版；任务 4.2 起按**容器宽**决定
 * inline/并排（消去固定 `lg` 与 420px），任务 4.4/4.5 起提供复制/查找/换行/差异导航。
 */
export function FileContent({
  path,
  file,
  current,
  currentLabel,
  loading,
  error,
  initial,
  initialKey,
  loadingInitial,
  initialFailed,
  selectedFailed,
  onRetryContent,
  onRetryInitial,
  contentAreaWidth,
  diffPreference,
  onDiffPreference,
  wordWrap,
  onWordWrap,
  stepSpanId,
  contentAnchor = null,
  onContentAnchor,
}: {
  path: string;
  file: {
    bytes: number;
    sha256: string;
    availability: string;
    unavailableReason: string | null;
  } | null;
  current: WorkspaceReadFileResult | null;
  currentLabel: string;
  loading: boolean;
  error: { code: string; message: string } | null;
  initial: WorkspaceReadFileResult | null;
  initialKey: string | null;
  loadingInitial: boolean;
  initialFailed: boolean;
  selectedFailed: boolean;
  fetchInitial: (
    stepSpanId: string | null,
    path: string,
  ) => Promise<WorkspaceReadFileResult | null>;
  onRetryContent?: () => void;
  onRetryInitial?: () => void;
  contentAreaWidth: number;
  diffPreference: "auto" | "inline" | "sideBySide";
  onDiffPreference?: (pref: "auto" | "inline" | "sideBySide") => void;
  wordWrap: boolean;
  onWordWrap?: (on: boolean) => void;
  /** U2 任务 4.3：本位置属于哪个检查点（锚点匹配用；null = 初始状态） */
  stepSpanId: string | null;
  contentAnchor?: ContentScrollAnchor | null;
  onContentAnchor?: (anchor: ContentScrollAnchor) => void;
}) {
  const translator = useTranslator();
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback>(null);

  /**
   * U2 任务 4.5：**真实差异导航**。
   *
   * `diffEditorRef` 接住 `@monaco-editor/react` 经 `onMount` 外抛的 `IStandaloneDiffEditor`
   * 实例——没有它，差异导航在结构上无法发命令（4.5 被误勾的根因）。`diffCount` 由
   * `onDidUpdateDiff` 在 diff **真正算完**后从 `getLineChanges()` 取真实条数，绝不凭空写死。
   *
   * ⚠️ 静态渲染（`renderToStaticMarkup`）不跑 effect、也不挂载 monaco ⇒ 这里恒为
   *    `null` / `0`，判据必须能优雅退化（按钮禁用 + 诚实说明），不能崩。
   */
  const diffEditorRef = useRef<IStandaloneDiffEditor | null>(null);
  const copyMenuRef = useRef<HTMLDetailsElement | null>(null);
  /**
   * U2 任务 5.4：**单侧只读视图**的编辑器实例。
   *
   * `diffEditorRef` 在单侧视图下恒为 null（那条路径不渲染 diff）⇒ 若查找只认 diff 编辑器，
   * 单侧可读时"查找"会点在空气上（按钮可用但无反应，正是本段禁止的"看着像能用"）。
   */
  const singleEditorRef = useRef<MonacoEditorNs.IStandaloneCodeEditor | null>(null);
  const [diffCount, setDiffCount] = useState(0);
  /** 最近一次上报/恢复的锚点：用于滚动事件去重（位置没变就不写 store） */
  const lastAnchorRef = useRef<ContentScrollAnchor | null>(null);

  /**
   * U2 任务 4.3：把当前可见位置上报为锚点（首个可见行 + 相对该行的偏移）。
   *
   * 两条拒绝条件，都是"宁可不记，也不能记错"：
   * - `onContentAnchor` 未接线 ⇒ 不报（静态渲染/能力缺失）；
   * - 编辑器尚未布局（`scrollHeight` 为 0）⇒ 此刻 `scrollTop` 恒为 0，记下去等于把位置抹掉。
   */
  const reportAnchor = useCallback(
    (editor: MonacoEditorNs.IStandaloneCodeEditor): void => {
      if (onContentAnchor === undefined) return;
      if (editor.getScrollHeight() <= 0) return;
      const ranges = editor.getVisibleRanges();
      const first = ranges[0] ?? null;
      const topLine = first === null ? 1 : first.startLineNumber;
      const anchor = buildContentAnchor({
        stepSpanId,
        path,
        topLine,
        lineTop: editor.getTopForLineNumber(clampAnchorLine(topLine)),
        scrollTop: editor.getScrollTop(),
      });
      if (sameAnchor(anchor, lastAnchorRef.current)) return;
      lastAnchorRef.current = anchor;
      onContentAnchor(anchor);
    },
    [onContentAnchor, stepSpanId, path],
  );

  const refreshDiffCount = useCallback((editor: IStandaloneDiffEditor | null): void => {
    if (editor === null) {
      setDiffCount(0);
      return;
    }
    const changes = editor.getLineChanges();
    setDiffCount(changes === null ? 0 : changes.length);
  }, []);

  const onDiffMount = useCallback(
    (editor: IStandaloneDiffEditor): void => {
      diffEditorRef.current = editor;
      refreshDiffCount(editor);
      // diff 是异步算的：首次 mount 时可能还没算完，靠这个事件拿到真实条数
      editor.onDidUpdateDiff(() => refreshDiffCount(editor));
      const modified = editor.getModifiedEditor();

      /**
       * U2 任务 4.3：**恢复正文滚动位置**。
       *
       * ⚠️ 这是 4.3 被误勾的缺口之二：连接层只保存了列表偏移，正文位置**根本没有字段**
       *    ⇒「滚动到长文本中部再往返」实测必然回到顶部。
       *
       * 只在锚点**属于当前 (检查点, 路径)** 时套用；按保存的首个可见行重算该行顶部像素
       * 再叠加偏移 —— 内容变长/变短/换行开关变化都不会指向错误位置（越界由统一裁剪处理）。
       */
      if (anchorMatches(contentAnchor, stepSpanId, path)) {
        const top = resolveAnchorScrollTop(contentAnchor, {
          lineTop: modified.getTopForLineNumber(clampAnchorLine(contentAnchor.line)),
          scrollHeight: modified.getScrollHeight(),
          clientHeight: modified.getLayoutInfo().height,
        });
        if (top !== null) {
          modified.setScrollTop(top);
          lastAnchorRef.current = contentAnchor;
        }
      }

      // 之后每次滚动把新位置写回会话状态（去重后写，避免每次滚动都改 store）
      modified.onDidScrollChange(() => reportAnchor(modified));
    },
    [refreshDiffCount, contentAnchor, stepSpanId, path, reportAnchor],
  );

  /** 上一/下一差异：驱动真实 Monaco 命令（不是装饰性按钮）。 */
  const goPrevDiff = useCallback((): void => {
    diffEditorRef.current?.goToDiff("previous");
  }, []);
  const goNextDiff = useCallback((): void => {
    diffEditorRef.current?.goToDiff("next");
  }, []);
  /** 查找：走 Monaco 内置查找控件（只读，不开放替换/写入）——当前**活动**编辑器优先。 */
  const openFind = useCallback((): void => {
    const editor = diffEditorRef.current?.getModifiedEditor() ?? singleEditorRef.current ?? null;
    editor?.trigger("u2-toolbar", "actions.find", null);
  }, []);

  /**
   * U2 任务 5.4：单侧只读视图挂载后**接住实例**（供"查找"用；无此接线按钮即空转）。
   *
   * ⚠️ 静态渲染不跑 effect / 不挂 monaco ⇒ 恒不触发，调用方判据须能退化。
   */
  const onSingleSideMount = useCallback((editor: MonacoEditorNs.IStandaloneCodeEditor): void => {
    singleEditorRef.current = editor;
  }, []);

  /**
   * U2 任务 5.4 实机缺陷修复（第二处）：**初始侧是否有可展示的原文**。
   *
   * 下面三个早返回（"所选侧加载中 / 失败 / 还没结果"）原本是**独占卡**：一旦命中就直接
   * return，**整张卡只有一句话**。若此时初始侧**已读到文本**，可读侧原文就此消失、复制/查找
   * 也被判禁 —— 违反 delta「可读侧完整展示并可复制查找」（实机 `sides` B 型即此形态）。
   *
   * 因此给三个早返回追加"另一侧也读不出东西"的条件：另一侧可读时**不**走独占卡，落入
   * 下方统一的两侧呈现（`!diffEligibility.ok` 分支：两侧状态行 + 单侧只读编辑器 + 重试）；
   * 所选侧的失败明细（`error.code`/`message`）在该分支内一并补出，错误码不丢。
   */
  const initialReadableText = initial !== null && initial.status === "text" ? initial.text : null;

  // 所选侧：加载中（且尚无结果）⇒ 该侧是"读取中"，**不是**不存在
  if (loading && current === null && initialReadableText === null) {
    return (
      <div className="px-4 py-6 text-[11px] text-gray-400">
        {translator.t("files.readingContent")}
        {loadingInitial ? (
          <span className="ml-2 text-gray-300">{translator.t("files.readingInitialSync")}</span>
        ) : null}
      </div>
    );
  }
  if (error !== null && initialReadableText === null) {
    return (
      <div className="m-4 rounded border-l-2 border-red-400 bg-red-50 px-2 py-1.5 text-[11px] leading-4 text-red-800">
        {translator.t("files.readFailed", { code: error.code, detail: error.message })}
        <div className="mt-0.5 text-red-600">{translator.t("files.readFailedNotMissing")}</div>
        {onRetryContent === undefined ? null : (
          <button
            type="button"
            onClick={onRetryContent}
            className="mt-1 rounded border border-red-300 bg-white px-2 py-0.5 text-[11px] text-red-700 hover:bg-red-50"
          >
            {translator.t("files.retryFile")}
          </button>
        )}
      </div>
    );
  }
  if (current === null && initialReadableText === null) {
    return (
      <div className="px-4 py-6 text-[11px] text-gray-400">
        {loadingInitial ? translator.t("files.readingInitial") : translator.t("files.notRead")}
      </div>
    );
  }
  // ⚠️ 走到这里 `current` 可能为 null（另一侧可读时不再走上面的独占卡）⇒ 必须先判非空
  if (current !== null && current.status === "rejected") {
    return (
      <div className="m-4 rounded border-l-2 border-red-400 bg-red-50 px-2 py-1.5 text-[11px] leading-4 text-red-800">
        {translator.t("files.requestRejected", {
          code: current.code,
          reason: current.reason,
        })}
      </div>
    );
  }
  if (current !== null && current.status === "not_found") {
    return (
      <div className="m-4 rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1.5 text-[11px] leading-4 text-amber-900">
        {translator.t("files.notInManifest", { reason: current.reason })}
      </div>
    );
  }

  const comparability = canCompareText(current, translator);
  const sides = resolveDiffSides(initial, current, {
    initial: translator.t("files.initialCheckpoint"),
    selected: currentLabel,
  });

  const rightReady = sideReadiness(current, { loading, failed: selectedFailed });
  const leftReady = sideReadiness(initial, { loading: loadingInitial, failed: initialFailed });
  const rights = copyableText(current);
  const lefts = copyableText(initial);
  const diffEligibility = canEnterTextDiff(sides, translator);
  /**
   * U2 任务 5.4 实机缺陷修复：**唯一可读的那一侧**。
   *
   * 两侧都 text 时它是"多余的"（此时走 diff）；只有进不了 diff 时它才决定"谁被完整展示"。
   * `null` 表示两侧都没有文本可展示（都不可读 / 都未读）——那种情况**不渲染任何编辑器**。
   */
  const readableSide: "left" | "right" | null =
    sides.leftNote === "text" ? "left" : sides.rightNote === "text" ? "right" : null;
  const modeDecision = decideDiffMode(
    {
      prefs: preserveFilePrefs({ ...initialFileLayoutPrefs, diffPreference, wordWrap }),
      contentAreaWidth,
    },
    translator,
  );
  const mode: DiffMode = modeDecision.mode;

  const doCopy = async (text: string | null, label: string): Promise<void> => {
    if (text === null) return;
    copyMenuRef.current?.removeAttribute("open");
    copyMenuRef.current?.querySelector<HTMLElement>("summary")?.focus();
    if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
      setCopyFeedback({
        kind: "fail",
        message: translator.t("files.clipboardUnsupported", { label }),
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedback({ kind: "ok", message: translator.t("files.copied", { label }) });
    } catch (e: unknown) {
      setCopyFeedback({
        kind: "fail",
        message: `${label}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  const tools = resolveToolEnablement({
    hasPath: path.length > 0,
    left: leftReady as SideReadiness,
    right: rightReady as SideReadiness,
    diffEligible: diffEligibility.ok,
    // U2 5.4：编辑器就绪 ≠ 能进 diff —— 单侧只读视图同样"就绪"（见 file-tools.ts 注释）
    editorReady: diffEligibility.ok || readableSide !== null,
    mode,
    // U2 任务 4.5：**真实**差异条数（由 onDidUpdateDiff 从 Monaco 取），不再写死
    diffCount,
  });

  const meta = copyableMeta(current);

  /**
   * 头部的大小/哈希来源：所选侧读出来了就用它，否则退回**清单里的记录**（`file`）。
   *
   * U2 5.4 实机修复后 `current` 可能为 null（另一侧可读 ⇒ 不再走独占卡），此处必须先兜底，
   * 否则头部的 `current.bytes` 会直接抛异常（新测试 `初始侧 text + 所选侧加载中` 已坐实）。
   */
  const headerMeta: { bytes: number; sha256: string } | null = current ?? file;

  const header = (
    // §2.1（design D3）：header/toolbar 在主 diff 分支的高度链里 shrink-0——
    // 正文（diff 容器 flex-1）吃掉全部剩余高度后，头两行按内容定高，不被压缩。
    <div className="min-w-0">
      <div className="break-all font-code text-reading-meta font-medium text-gray-800">{path}</div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[10px] text-gray-500">
        {headerMeta === null ? null : (
          <>
            <span>{formatBytes(headerMeta.bytes)}</span>
            <span className="font-code">sha256 {headerMeta.sha256.slice(0, 12)}…</span>
          </>
        )}
        {file === null ? null : (
          <span
            className={
              file.availability === "ok" ? "text-gray-400" : "rounded bg-red-100 px-1 text-red-700"
            }
          >
            {availabilityLabel(file.availability as "ok" | "missing" | "corrupt", translator)}
          </span>
        )}
      </div>
    </div>
  );

  /**
   * U2 任务 4.4/4.5/4.6：**只读工具栏**——复制路径/两侧原文/元信息、查找、换行、
   * 上一/下一差异、inline/并排模式。所有按钮按 `tools` 的诚实判据启用/禁用，
   * 禁用时用 `title` 说明原因。**没有**任何编辑/替换/回写入口。
   */
  const toolbar = (
    // shrink-0：同 header（§2.1 高度链纪律）
    <div className="flex flex-wrap items-center justify-end gap-1 text-[10px]">
      <details ref={copyMenuRef} className="relative">
        <summary
          title={translator.t("files.copyMenuTitle")}
          className="min-h-[28px] cursor-pointer rounded border border-gray-300 px-1.5 py-0.5 text-gray-600 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
        >
          {translator.t("files.copy")}
        </summary>
        <div className="absolute right-0 top-full z-20 mt-1 flex min-w-[160px] flex-col gap-1 rounded border border-gray-200 bg-white p-1.5 shadow-md">
          <button
            type="button"
            disabled={!tools.copyPath}
            onClick={() => void doCopy(path, translator.t("files.labelPath"))}
            title={translator.t("files.copyPathTitle")}
            className="rounded border border-gray-300 px-1.5 py-0.5 text-gray-600 disabled:opacity-40"
          >
            {translator.t("files.copyPath")}
          </button>
          <button
            type="button"
            disabled={!tools.copyLeftText}
            onClick={() => void doCopy(lefts, translator.t("files.labelInitialText"))}
            title={
              tools.copyLeftText
                ? translator.t("files.copyInitialTitle")
                : translator.t("files.copyInitialDisabled")
            }
            className="rounded border border-gray-300 px-1.5 py-0.5 text-gray-600 disabled:opacity-40"
          >
            {translator.t("files.copyInitial")}
          </button>
          <button
            type="button"
            disabled={!tools.copyRightText}
            onClick={() => void doCopy(rights, translator.t("files.labelSelectedText"))}
            title={
              tools.copyRightText
                ? translator.t("files.copySelectedTitle")
                : translator.t("files.copySelectedDisabled")
            }
            className="rounded border border-gray-300 px-1.5 py-0.5 text-gray-600 disabled:opacity-40"
          >
            {translator.t("files.copySelected")}
          </button>
          {meta === null ? null : (
            <button
              type="button"
              onClick={() =>
                void doCopy(`${meta.bytes} B\n${meta.sha256}`, translator.t("files.labelMeta"))
              }
              title={translator.t("files.copyMetaTitle")}
              className="rounded border border-gray-300 px-1.5 py-0.5 text-gray-600"
            >
              {translator.t("files.copyMeta")}
            </button>
          )}
        </div>
      </details>
      <button
        type="button"
        disabled={!tools.wordWrap}
        onClick={() => onWordWrap?.(!wordWrap)}
        title={
          tools.wordWrap
            ? translator.t("files.wordWrapToggle")
            : translator.t("files.wordWrapUnavailable")
        }
        className="rounded border border-gray-300 px-1.5 py-0.5 text-gray-600 disabled:opacity-40"
      >
        {translator.t("files.wordWrap", {
          state: translator.t(wordWrap ? "files.wordWrapOn" : "files.wordWrapOff"),
        })}
      </button>
      <button
        type="button"
        disabled={!tools.find}
        onClick={openFind}
        title={tools.find ? translator.t("files.findTitle") : translator.t("files.findUnavailable")}
        className="rounded border border-gray-300 px-1.5 py-0.5 text-gray-600 disabled:opacity-40"
      >
        {translator.t("files.find")}
      </button>
      <button
        type="button"
        disabled={!tools.prevDiff}
        onClick={goPrevDiff}
        title={
          tools.prevDiff
            ? translator.t("files.prevDiffTitle")
            : diffCount === 0
              ? translator.t("files.noDiffToNavigate")
              : translator.t("files.diffNavUnavailable")
        }
        aria-label={translator.t("files.prevDiffAria")}
        className="rounded border border-gray-300 px-1.5 py-0.5 text-gray-600 disabled:opacity-40"
      >
        {translator.t("files.prevDiff")}
      </button>
      <button
        type="button"
        disabled={!tools.nextDiff}
        onClick={goNextDiff}
        title={
          tools.nextDiff
            ? translator.t("files.nextDiffTitle")
            : diffCount === 0
              ? translator.t("files.noDiffToNavigate")
              : translator.t("files.diffNavUnavailable")
        }
        aria-label={translator.t("files.nextDiffAria")}
        className="rounded border border-gray-300 px-1.5 py-0.5 text-gray-600 disabled:opacity-40"
      >
        {translator.t("files.nextDiff")}
      </button>
      {tools.modeToggle && onDiffPreference !== undefined ? (
        <button
          type="button"
          onClick={() => onDiffPreference(diffPreference === "inline" ? "sideBySide" : "inline")}
          title={translator.t("files.modeTitle")}
          className="rounded border border-gray-300 px-1.5 py-0.5 text-gray-600"
        >
          {translator.t("files.mode", {
            mode:
              diffPreference === "auto"
                ? translator.t("files.modeAuto")
                : diffPreference === "inline"
                  ? "inline"
                  : translator.t("files.modeSideBySide"),
          })}
        </button>
      ) : null}
      {copyFeedback === null ? null : (
        <span
          className={`ml-1 ${copyFeedback.kind === "ok" ? "text-emerald-600" : "text-red-600"}`}
        >
          {copyFeedback.message}
        </span>
      )}
    </div>
  );

  const fileHeader = (
    <div className="file-content-heading shrink-0 border-b border-gray-200 px-4 py-2">
      {header}
      {toolbar}
    </div>
  );

  /**
   * 一侧的状态说明文案（两个"进不了 diff"分支共用；`failed`/`loadingWhile` 分侧传入）。
   */
  const noteText = (
    note: DiffSides["leftNote"],
    failed: boolean,
    loadingWhile: boolean,
  ): string => {
    switch (note) {
      case "not_found":
        return translator.t("files.noteNotFound");
      case "unavailable":
        return translator.t("files.noteUnavailable");
      case "unread":
        return failed
          ? translator.t("files.noteReadFailed")
          : loadingWhile
            ? translator.t("files.noteReading")
            : translator.t("files.noteNotRead");
      case "text":
        return translator.t("files.noteText");
    }
  };

  /**
   * U2 任务 5.4 实机缺陷修复：**单侧可读时的完整展示通道**（只读，绝非 diff）。
   *
   * spec delta「不可用侧不伪装为空差异」（原文）：两侧分别标出真实状态，**可读侧完整展示并可
   * 复制查找**，禁止把不可用侧置空进行 diff；**左右互换同样成立**。
   *
   * 5.4 实机坐实：两个早返回分支（所选侧不可比较 / 不能进 diff）都只渲染 header + toolbar +
   * 状态卡、**没有任何编辑器** ⇒ 可读侧原文既拿不到、查找/换行还被判禁（左右互换亦然）。
   * 这里补一条**只读单侧编辑器**压住该缺口：
   * - 锚点用**独立**的 `single-side-editor`（**不得**复用 `diff-editor`：那会让"绝不置空 diff"
   *   的既有断言失去意义）；
   * - 不可比较的那一侧仍只出状态卡，绝不置空参与 diff（不渲染任何 diff 编辑器）；
   * - `readOnly: true` + 无替换入口，与 diff 侧同一条只读红线。
   */
  const singleSideView =
    readableSide === null || diffEligibility.ok ? null : (
      <>
        <div className="px-4 py-1.5 text-[10px] text-gray-400">
          {translator.t("files.singleSide", {
            side: translator.t(
              readableSide === "left" ? "files.sideShortLeft" : "files.sideShortRight",
            ),
            label: readableSide === "left" ? sides.leftLabel : sides.rightLabel,
          })}
        </div>
        {/* ⚠️ 锚点挂在**真实 DOM 包裹层**上，不挂在 <Editor> 上：`@monaco-editor/react` 只通过
            `wrapperProps` 透传 `data-*`，直接给 <Editor> 的 `data-testid` 在编辑器**已加载**
            时不落到 DOM（只在懒加载占位期间存在）⇒ 用它判"有没有单侧视图"会得到假结果。 */}
        <div
          data-testid="single-side-editor"
          className="mx-4 mb-4 overflow-hidden rounded border border-gray-200"
        >
          <MonacoCodeEditor
            height="min(60vh, 640px)"
            data-monaco-host="file-single-side"
            language={detectFileLanguage(readableSide === "left" ? sides.left : sides.right)}
            value={(readableSide === "left" ? sides.left : sides.right) ?? ""}
            onMount={onSingleSideMount}
            options={{
              readOnly: true,
              fontSize: 13,
              minimap: { enabled: false },
              lineNumbers: "on",
              scrollBeyondLastLine: false,
              wordWrap: wordWrap ? "on" : "off",
              scrollbar: { vertical: "auto", horizontal: "auto" },
              folding: true,
              showFoldingControls: "always",
            }}
          />
        </div>
      </>
    );

  // 不可比较：只呈现状态，明确不渲染伪空文件
  // ⚠️ `current !== null` 是**类型收窄 + 语义显式**：`canCompareText(null)` 恒为 ok，故此分支
  //    本来就不会被"所选侧无结果"命中；但 5.4 的门控让 `current` 之后可能为 null，TS 需要它。
  if (current !== null && !comparability.ok) {
    return (
      <>
        {fileHeader}
        <div className="m-4 rounded border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] leading-5 text-gray-700">
          <div className="font-semibold text-gray-800">
            {current.status === "binary"
              ? translator.t("files.binaryTitle")
              : translator.t("files.unreadableTitle")}
          </div>
          <div className="mt-0.5">{comparability.reason}</div>
          {current.status === "binary" ? (
            <div className="mt-1 font-code text-[10px] text-gray-500">
              {translator.t("files.originalSize", {
                bytes: formatBytes(current.bytes),
                sha: current.sha256,
              })}
            </div>
          ) : null}
          {current.status === "missing" || current.status === "corrupt" ? (
            <div className="mt-1 text-gray-500">
              {translator.t("files.manifestSize", {
                bytes: formatBytes(current.bytes),
                sha: current.sha256,
              })}
            </div>
          ) : null}
          {/* U2 5.4：本分支原先**只标所选侧**（卡片标题/原因都是它），初始侧状态完全不可见 ⇒
              左右互换（初始侧可读、所选侧不可比较）时用户看不到"另一侧有文本"。补统一的
              两侧状态行，与「不进入文本差异」分支同源同文案。 */}
          <div className="mt-1 text-gray-600">
            {translator.t("files.bothSidesStatus", {
              left: noteText(sides.leftNote, initialFailed, loadingInitial),
              right: noteText(sides.rightNote, selectedFailed, loading),
            })}
          </div>
          {sides.leftNote === "unread" && onRetryInitial !== undefined ? (
            <div className="mt-1">
              <button
                type="button"
                onClick={onRetryInitial}
                className="rounded border border-gray-300 bg-white px-2 py-0.5 text-[11px] text-gray-700 hover:bg-gray-50"
              >
                {translator.t("files.retryInitial")}
              </button>
            </div>
          ) : null}
        </div>
        {singleSideView}
      </>
    );
  }

  /**
   * ⚠️ 这里不再有"两侧都没有可显示内容 ⇒ 不渲染编辑器"的粗暴判据（C 时代的它把
   * "初始侧没读出来"和"初始侧确实不存在"混为一谈）。改为先问 `canEnterTextDiff`，
   * 不够格时按**具体原因**分流，绝不置空 diff。
   */
  const leftMissing = sides.left === null;
  const rightMissing = sides.right === null;
  const initialNotRead = initial === null && (loadingInitial || initialFailed);

  if (!diffEligibility.ok) {
    return (
      <>
        {fileHeader}
        <div className="m-4 rounded border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] leading-5 text-gray-700">
          <div className="font-semibold text-gray-800">{translator.t("files.notEnterDiff")}</div>
          <div className="mt-0.5">{diffEligibility.reason}</div>
          <div className="mt-1 text-gray-600">
            {translator.t("files.bothSidesStatus", {
              left: noteText(sides.leftNote, initialFailed, loadingInitial),
              right: noteText(sides.rightNote, selectedFailed, loading),
            })}
          </div>
          <div className="mt-1 text-gray-500">{translator.t("files.noEmptyDiff")}</div>
          {/* U2 5.4：所选侧通道失败时不再走独占错误卡（其条件是"另一侧也读不出东西"），
              错误码/原因必须在这里补出，否则"读取失败"只剩一句状态、丢失可诊断信息。 */}
          {error === null ? null : (
            <div className="mt-1 text-red-700">
              {translator.t("files.readFailedInline", {
                code: error.code,
                detail: error.message,
              })}
            </div>
          )}
          {onRetryInitial === undefined && onRetryContent === undefined ? null : (
            <div className="mt-1 flex gap-2">
              {sides.leftNote === "unread" && onRetryInitial !== undefined ? (
                <button
                  type="button"
                  onClick={onRetryInitial}
                  className="rounded border border-gray-300 bg-white px-2 py-0.5 text-[11px] text-gray-700 hover:bg-gray-50"
                >
                  {translator.t("files.retryInitial")}
                </button>
              ) : null}
              {sides.rightNote === "unread" && onRetryContent !== undefined ? (
                <button
                  type="button"
                  onClick={onRetryContent}
                  className="rounded border border-gray-300 bg-white px-2 py-0.5 text-[11px] text-gray-700 hover:bg-gray-50"
                >
                  {translator.t("files.retrySelected")}
                </button>
              ) : null}
            </div>
          )}
        </div>
        {singleSideView}
      </>
    );
  }

  /**
   * 一侧的状态说明。走这里时已由 `canEnterTextDiff` 保证两侧**只有** `text` 或 `not_found`。
   */
  const sideNote = (note: DiffSides["leftNote"]): string =>
    note === "not_found" ? translator.t("files.sideMissingNote") : "";

  return (
    /*
     * §2.1（design D3 / task 2.1）：**文件页 diff 的高度链**。
     *
     * 此前 diff 编辑器 `height="min(60vh, 640px)"` 固定高、坐在内容列的
     * `overflow-y-auto` 滚动流里：视口矮时正文只有 60vh 的固定份额，且外层滚动与
     * 编辑器内部滚动相互踩（基线截图 y≈509 的正文塌缩即此形态）。
     *
     * 现在主 diff 分支自建高度链：`h-full flex flex-col` 占满内容列，
     * header/toolbar/身份行 shrink-0 按内容定高，diff 容器 `min-h-0 flex-1` 吃掉
     * **全部剩余高度**，编辑器 `height="100%"` 只在自身内部滚动（外层不再滚动）。
     * 1210×713 视口下正文可得约 400px+（验收目标 ≥357px）。异常分支（状态卡/单侧
     * 视图）仍走普通流，由内容列的 overflow-y-auto 承载。
     *
     * 挤压退路：根容器自身 `overflow-y-auto`、diff 容器 `min-h-[200px]`——窄窗下
     * toolbar 换行变高把剩余空间吃穿时，diff 保住 200px 下限、根容器兜底滚动，
     * 而不是把正文压缩到 0（spec「低高度设备通过内部滚动保持操作可达」）。
     */
    <div className="flex h-full min-h-0 flex-col overflow-y-auto" data-file-diff-chain="true">
      {fileHeader}
      <div className="shrink-0 px-4 py-1.5 text-[10px] text-gray-400">
        {translator.t("files.sideHeaderInitial", {
          label: translator.t("files.initialCheckpoint") + sideNote(sides.leftNote),
        })}{" "}
        ·{" "}
        {translator.t("files.sideHeaderSelected", {
          label: sides.rightLabel + sideNote(sides.rightNote),
        })}
        {diffCount > 0 ? (
          <span className="ml-2 text-gray-500">
            {translator.t("files.diffCount", { count: diffCount })}
          </span>
        ) : null}
        {modeDecision.downgraded && modeDecision.reason !== null ? (
          <span className="ml-2 text-amber-700">{modeDecision.reason}</span>
        ) : null}
      </div>
      <div className="mx-4 mb-4 min-h-[200px] flex-1 overflow-hidden rounded border border-gray-200">
        <MonacoDiffEditor
          data-testid="diff-editor"
          data-monaco-host="file-diff"
          height="100%"
          language={detectFileLanguage(sides.right ?? sides.left)}
          original={leftMissing ? "" : (sides.left ?? "")}
          modified={rightMissing ? "" : (sides.right ?? "")}
          onMount={onDiffMount}
          options={{
            readOnly: true,
            renderSideBySide: mode === "sideBySide",
            // ⚠️ U2 5.1 实机缺陷修复（2026-09-23）：
            //   Monaco 默认 `useInlineViewWhenSpaceIsLimited: true` +
            //   `renderSideBySideInlineBreakpoint: 900`：只要**编辑器元素宽 ≤900px**，
            //   Monaco 就无视本层传入的 `renderSideBySide: true` 强行改渲染 inline。
            //   实测复现（CSS 视口 1210，容器 1210）：目录 248 时 monoW=909 正常并排
            //   （447/448，sash=1）；目录 264 时 monoW=893 突变为 36/827、sash 消失 ——
            //   左侧栏被压成 36px 不可读细条。而本层判据 `decideDiffMode` 按
            //   `(contentArea-56)/2 >= 320` 仍判并排（perSide 439），**两层结论冲突**。
            //   spec/design D4 明写并排条件由本层按两侧实际文字区决定，故关闭 Monaco
            //   自己的空间启发式，让 `renderSideBySide` 成为唯一权威。
            useInlineViewWhenSpaceIsLimited: false,
            fontSize: 13,
            minimap: { enabled: false },
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            wordWrap: wordWrap ? "on" : "off",
            scrollbar: { vertical: "auto", horizontal: "auto" },
            folding: true,
            showFoldingControls: "always",
            originalEditable: false,
          }}
        />
      </div>
      {leftMissing ? (
        <div className="mx-4 mb-4 shrink-0 rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1.5 text-[10px] leading-4 text-amber-900">
          {translator.t("files.leftAbsent")}
        </div>
      ) : null}
      {rightMissing ? (
        <div className="mx-4 mb-4 shrink-0 rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1.5 text-[10px] leading-4 text-amber-900">
          {translator.t("files.rightAbsent")}
        </div>
      ) : null}
    </div>
  );
}
