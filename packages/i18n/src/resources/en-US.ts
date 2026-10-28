import type { ResourceShape } from "./zh-CN.js";

export const enUS = {
  common: {
    appName: "ReBaseAgent",
    unknown: "Unknown",
    notRecorded: "Not recorded",
    notPreserved: "Not preserved (original state unknown)",
    notSupported: "Not supported",
    cancel: "Cancel",
    confirm: "Confirm",
    back: "Back",
    loading: "Loading…",
    empty: "Nothing here yet",
    messageUnavailable: "This message is unavailable",
    select: "Select",
    close: "Close",
    copy: "Copy",
    copied: "Copied",
    stepCount: { one: "{{count}} step", other: "{{count}} steps" },
    runSummary: "{{duration}} · {{stepCount}} steps · {{runId}}",
    runSummaryRich: "{{duration}} · <strong>{{stepCount}}</strong> steps · <code>{{runId}}</code>",
    deleteRunConfirm: "Delete <code>{{name}}</code>? This removes the local record.",
    chooseDataDirTitle: "Choose a ReBaseAgent data directory",
    chooseDataDirMessage:
      "Data is stored only in this directory. You can also place a portable.marker next to the app to use portable mode.",
    chooseDirectoryTitle: "Choose a directory",
    quit: "Quit",
    quitAndDiscardDraft: "Quit and discard drafts",
    draftCloseTitle: "Quit ReBaseAgent",
    draftCloseMessageDirty: "There are unsaved debugging drafts",
    draftCloseMessageDirtyWithOperation:
      "There are unsaved debugging drafts and an operation is in flight",
    draftCloseMessageUnknown: "The draft state cannot be confirmed right now",
    draftCloseMessageUnknownWithOperation:
      "The draft state cannot be confirmed and an operation is in flight",
    draftCloseMessageConfigurationBusy: "A configuration change has not completed",
    draftCloseMessageActiveOperation: "An operation is in flight",
    draftCloseNoteDraftLost:
      "Debugging drafts entered in this session will be lost after quitting and cannot be recovered.",
    draftCloseNoteDraftUnknown:
      "The draft state cannot be confirmed, so unsaved edits may exist. Choose Back to keep using the app; quitting again later will re-check.",
    draftCloseNoteActiveOperation:
      "Registered active operations have not finished: quitting does not cancel upstream requests or undo costs or side effects, and their records are not marked as cancelled.",
    draftCloseNoteConfigurationBusy:
      "A configuration change (saving settings or toggling the proxy) has not completed; quitting does not roll it back.",
    draftCloseNotePendingLoss:
      "In addition, drafts from a previous session may already be lost (that session did not finish its close check before exiting or reloading).",
    draftCloseNoteContinue: "Choose Back to continue editing or keep the current operation.",
    viewRuns: "Runs",
    viewTree: "Branch tree",
    viewSwitchLegend: "Switch main view",
    viewRunsHint: "Run view: run list plus overview, steps, and file tabs",
    viewTreeHint: "Wide branch tree: nodes are runs, edges are forks; select several to compare",
    collapseRunList: "Collapse run list",
    openRunList: "Open run list",
    newRun: "New run",
    newRunHint:
      "Start a run directly in the desktop app (plain chat or an isolated file run; no proxy or code needed)",
    connectRecording: "Connect recording",
    connectRecordingHint:
      "Open the recording workspace and point your existing agent's base_url here to record",
    recordingEntry: "Connect recording",
    runConfig: "Run settings",
    runConfigHint:
      "Configure the LLM endpoint (baseURL / apiKey / model) for real calls from “Rerun here”",
    proxyStatusHint:
      "Local recording proxy: point your agent's base_url at http://127.0.0.1:port/v1; keep the key unchanged to record",
    proxyNoKey: "No key captured",
    proxyOpenRecordingFailedHint:
      "Open the recording workspace to see the controlled reason, re-read status, or save and apply again",
    proxyOpenRecordingRecoveringHint:
      "Open the recording workspace to see how this startup recovery is going",
    proxyFixInRecording: "Fix in recording",
    proxyRecovering: "Recovering…",
    focusHint:
      "Temporarily hide auxiliary areas; exiting restores the previous layout and reading state",
    exitFocus: "Exit focus",
    focusDiff: "Focus diff",
    focusEdit: "Focus editing",
    backToCompare: "Back to comparison",
    backToCompareAria: "Back to the comparison workspace",
    comparePairKept: "Comparison kept: left {{left}} → right {{right}}",
    reopenSteps: "Reopen step directory",
    noRunsTitle: "No runs in the data directory yet",
    noRunsBody:
      "You can start a run right here (plain chat or an isolated file run; no proxy or code needed), or open the recording proxy in settings and point your existing agent's base_url here.",
    noRunsCreate: "New run",
    noRunsRecord: "Connect recording",
    noRunsJsonlHint:
      "You can also put existing *.jsonl files into traces/ in the data directory and reopen the app.",
    confirmDiscard: "Discard",
    discardDraftTitle: "Discard draft",
    discardDraftMessage:
      "Discard the draft for “{{title}}”?\nIts content will be deleted and cannot be recovered.",
    discardDraftMessageScoped:
      "Discard the draft for “{{title}}” ({{scope}})?\nIts content will be deleted and cannot be recovered.",
    detailsBoundary: "Detail boundaries",
    detailsSummary: "Details",
    expand: "Expand",
    collapse: "Collapse",
    disclosureLabel: "{{summary}} ({{action}})",
    expandNamed: "Expand {{name}}",
    collapseNamed: "Collapse {{name}}",
    resizeGripTitle: "{{label}} {{width}}px ({{min}}–{{max}}) · drag or press ←/→ to resize",
    longTextCollapsed: "{{label}} ({{count}} characters; click to show the full text)",
    copyOriginal: "Copy original",
    copiedOriginal: "Original copied",
    copyUnavailable: "Copying is unavailable here (select the text manually)",
    findInOriginal: "Find in original",
    findWithinLabel: "Find in {{label}}",
    previous: "Previous",
    next: "Next",
    noMatches: "No matches",
    matchPosition: "{{index}} / {{total}}",
    sessionActivity: "Session activity",
    sessionActivityHint:
      "This session's activity: unsubmitted edits, active operations, and results to review (one entry point, no second state source)",
    draftCount: "Changes {{count}}",
    operationCount: "Operations {{count}}",
    resultCount: "Results {{count}}",
    sectionDrafts: "Unsubmitted edits",
    sectionOperations: "Active operations",
    sectionResults: "Results to review",
    needsAttentionDrafts: "Edits needing attention",
    needsAttentionDraftsCount: "Edits needing attention · {{count}}",
    recordingDirty: "Recording settings have unapplied changes",
    goRecording: "Go to recording",
    cleanSessions: "Unchanged editing sessions · {{count}}",
    noDirtyDrafts: "No draft edits need attention.",
    noDirtyDraftsWithRecording:
      "No draft edits need attention; the recording changes above are still pending.",
    noCleanSessions: "No unchanged editing sessions.",
    sessionOperations: "Operations in this session",
    sessionOperationsCount: "Operations in this session · {{count}}",
    refresh: "Refresh",
    refreshHint: "Re-read the main process operation snapshot (read-only)",
    noOperations:
      "No active operations in this session yet. After you create a run, rerun a result, edit a prompt, resend via the proxy, or submit a model A/B, its real status and trusted run ID appear here.",
    resultsPending: "Results to review",
    resultsPendingCount: "Results to review · {{count}}",
    noResultNotices: "No result notifications to review.",
    activityNote:
      "“Check status” only looks up operation records (it does not read run files or switch pages); choose “Open result” to see content. When this panel is closed, result notifications are still announced through a polite live region and do not take over the current page. Drafts are not persisted and are cleared when the app closes.",
    closeActivityPanel: "Close session activity panel",
    truncatedPreview: "{{text}}… ({{count}} characters total)",
    localFieldCheck:
      "Local field check: required fields, mode, and authorization (no network, no model calls)",
    checksDone: "Checks performed",
    boundaryThisRun: "Boundaries for this run",
    notSelected: "Not selected",
    checked: "Checked",
    unchecked: "Not checked",
    fieldOldValue: "Original value",
    fieldNewValue: "New value",
    fieldWrites: "File writes in this submit",
  },
  run: {
    createSummaryChat: "One real model call · billed by actual usage · plain chat calls no tools",
    createSummaryIsolated:
      "Isolated collection reads the source directory only · file writes require this submit's check · real calls are billed by usage",
    fieldTask: "Task (User Message)",
    fieldEndpoint: "Endpoint",
    fieldSourceDir: "Source directory",
    fieldToolTable: "Tool table",
    systemPromptEmpty: "Left empty (config_hash is computed with an empty system)",
    emptyToolTable: "Empty (plain chat calls no tools)",
    createLimitChatNoWorkspace:
      "No directory or workspace is involved: this sends one plain chat request.",
    createLimitChatNoPrecheck:
      "There is no separate model connectivity precheck: the main process validates at submit time (an unconfigured endpoint is rejected without consuming a model call).",
    createLimitIsolatedNoPreview:
      "There is no directory collection preview: file count, size, and rejections are only known after submit, so none are promised here.",
    createLimitIsolatedWrites:
      "Isolated runs use a fixed tool set, and collected text enters the model request; file writes land only in immutable attachments under the data directory.",
  },
  detail: {},
  fork: {
    cacheHint:
      "The parent run used {{parentModel}} for this step; the current configuration is {{configModel}} — prefix cache may miss and billing may change (informational only; rerun is not blocked).",
    plainSummary:
      "Plain continuation · tools invoked later by the model will really run · the parent run is not modified",
    fieldParentRun: "Parent run",
    fieldEditedCall: "Edited call",
    fieldModelPrefix: "Model and prefix",
    modelSameAsParent: "Same as the model recorded for this step in the parent run ({{model}})",
    modelUnknown: "Parent model or current configuration is unknown; consistency is not inferred",
    plainLimitNoWorld:
      "The world is not isolated: this is a plain replay continuation — recorded tool results are fed back by default, but tools newly invoked by the model will really run and may have external side effects.",
    plainLimitNoPrecheck:
      "There is no separate continuation precheck endpoint (only the isolated path has one): conditions here are re-checked by the main process at submit time.",
    plainLimitParentUnchanged:
      "The parent run and its later steps are not modified; the rerun produces a new run.",
    isolatedSummary:
      "Whole-turn continuation · other tools in this turn are not re-run · file writes require this submit's check",
    fieldContinueCondition: "Continuation conditions",
    precheckMissing: "No read-only precheck result yet (the items below require a precheck)",
    fieldDirectParent: "Direct parent",
    fieldLocalTurn: "Local turn",
    fieldTurnEndCheckpoint: "End-of-turn checkpoint",
    fieldContinueMode: "Continuation mode",
    fieldRealCall: "Real calls",
    writesCheckedOneShot: "Checked (valid only for this submit)",
    writesUncheckedRejected: "Not checked (the isolated submit will be rejected)",
    precheckCheck:
      "Read-only precheck `runs:forkCapability`: creates no run, writes no file, and calls no model",
    isolatedLimitNoRedo:
      "Whole-turn continuation: the other tools in this turn are not re-run (each appears once in the child run prefix); steps after the edit point are regenerated by the model.",
    isolatedLimitWrites:
      "Writes that already happened are not undone: the source directory and parent trace are untouched, and writes land only in this copy's mapping; a historical authorization marker on the parent trace does not authorize this submit.",
    isolatedLimitRights:
      "File writes require an explicit check in this submit; reopening the editor or changing the directory requires checking again, and historical records never restore authorization.",
    promptSummary:
      "New trajectory from the start · real model calls are billed · the parent run is reference only",
    fieldParentRunCompare: "Parent run (reference only)",
    fieldStartField: "Edited startup field",
    promptLimitNewTrace:
      "Runs a new trajectory from the start: it reuses no execution prefix, replays no tool result, and does not modify the parent run.",
    promptLimitOneField:
      "Only one startup field can change at a time (system or the first user message); the rest of the context and later steps are regenerated by the model.",
    promptLimitContextRecorded:
      "The startup context comes from the first llm.call recorded for that call (system + first user message); config_hash changes with the edit.",
    promptLimitContextUnavailable:
      "The startup context cannot be rebuilt from the first call: this entry is unavailable, with the reason shown next to the entry.",
    messagesSummary:
      "Resend this one request · external tools are not executed · credentials use the key most recently captured by the proxy session",
    fieldTargetCall: "Target run · call",
    fieldMessages: "Messages in this request",
    messagesCount: "{{count}} messages (sent as a full replacement, not truncated)",
    upstreamMissing: "(Proxy is not running; no upstream)",
    fieldCredentials: "Credentials",
    credsCaptured: "Uses the key most recently captured by the proxy session",
    credsMissing: "No key captured: this resend cannot run",
    fieldModel: "Model",
    messagesCheck:
      "Local structure check: messages must be a non-empty JSON array (invalid input errors locally; no request or model call)",
    messagesLimitSingle:
      "Resends only this request: it executes no external agent tools and restores neither its workspace nor later steps.",
    messagesLimitCreds:
      "Credentials are the proxy session's most recently captured key, which may differ from the one recorded for this run (or be missing, in which case the resend is rejected).",
    messagesLimitNoConfigHash:
      "A passively recorded run has no config_hash of its own: it remains a comparable trace, but this path creates no parent-child continuation.",
  },
  experiment: {
    localBatchCheck:
      "Local batch check: configuration is filled in, at least two arms exist, each arm has a model, parameters are parseable JSON, and each arm differs from the parent run (an arm identical to the parent rejects the whole batch)",
    abSummaryNoPlan:
      "No plan for the current batch yet ({{count}} arms): validate and preview first",
    abSummaryPlan: "{{count}} real model calls · billed per arm",
    abSummarySideEffects:
      "{{count}} real model calls · billed per arm · tools with side effects will really run",
    fieldExecutionPlan: "Execution plan",
    abPlanMissing:
      "No plan for the current batch yet ({{count}} arms): choose “Validate and preview plan” first so you review the parameters each arm will actually use",
    fieldExperimentGroup: "Experiment group",
    abRealCalls: "{{count}} calls (one per arm, each saved as a separate new run)",
    fieldArmEffective: "Arm {{index}} effective settings",
    fieldSideEffectTools: "Tools with side effects",
    abSideEffectsAllowed: "Allowed: tools with side effects will really run",
    abSideEffectsNotAllowed: "Not allowed: this call has no side-effect tools that need approval",
    abCheckDryRun:
      "Read-only check `runs:modelAbPlan` (dry run): no network, no file writes, no active execution slot",
    abLimitPerArm:
      "One execution makes real model calls and incurs charges per arm (currently {{count}} arms); arms run in order, and one arm failing does not affect the others.",
    abLimitParent:
      "The parent run is reference only and is not modified; each arm is saved as a separate new trajectory, and the batch shares one experiment group ID.",
    abLimitSideEffectWarning:
      "⚠ External side effects from an earlier arm change the starting point of later arms: comparisons may not be trustworthy (this declaration is recorded with the experiment).",
    abLimitPlanBinding:
      "The plan is bound to the batch revision: changing arms, parameters, side-effect permission, or run configuration invalidates the old plan and confirmation, so preview and confirm again.",
    armLineNoParams: "(reuse the parent run's sampling parameters)",
    armLineDiscarded: " · discards parent values {{values}}",
    armLineWarnings: " · ⚠ {{keys}} may not take effect",
  },
  compare: {},
  files: {},
  verification: {},
  recording: {},
  settings: {},
  export: {},
  errors: {
    generic: "The operation did not complete. Check the current state before continuing.",
    invalidArgument: "The request parameters are invalid.",
    notFound: "The requested resource was not found.",
    unknownOperation: "The operation status is unknown. Check it first.",
    unsupported: "This operation is not supported in this release.",
    conflict: "This operation was already submitted or is in flight.",
    staleCursor: "The cursor is stale. Start a new query.",
    preparationRequired:
      "The environment has not been prepared, or its preparation record is unavailable.",
  },
  mcp: {},
  cli: {},
} satisfies ResourceShape;
