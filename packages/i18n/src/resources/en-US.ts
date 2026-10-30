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
    copyFullLabelAria: "Copy full {{label}} {{id}}",
    copyFullIdTitle: "Copy full ID: {{id}}",
    copiedFullId: "Full ID copied",
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
    liveSeparator: "; ",
    draftEditable: "Draft (editable)",
    originalReadOnly: "Original (read-only)",
    collapseOriginalTitle:
      "Collapse the read-only original to give the draft more room (restorable at any time)",
    collapseOriginal: "Collapse original",
    restoreOriginalTitle:
      "Show the read-only original again (full text and read-only identity kept)",
    restoreOriginal: "Show original",
    originalHeightAria: "Resize the original area",
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
    kindCreate: "New run",
    kindResult: "Result rerun",
    kindPrompt: "Prompt rerun",
    kindProxy: "Proxy resend",
    kindModelAb: "Model A/B",
    kindVerificationPrepare: "Verification preparation",
    kindVerification: "Project verification",
    kindOperation: "Operation",
    kindUnknown: "(Unknown type)",
    phaseRunning: "Running",
    phaseSettled: "Settled",
    phaseNotAccepted: "Not accepted",
    phaseUnknown: "Needs check",
    phaseHintRunning: "Running (the desktop allows only one active operation at a time)",
    phaseHintSettled:
      "Settled: the request finished and was wrapped up; this does not mean the run succeeded",
    phaseHintNotAccepted: "Not accepted: nothing ran and no permission was consumed",
    phaseHintUnknown:
      "Outcome unknown: the main-process session changed; this is not resent automatically and associations are not guessed",
    noteRunning: "Created, not yet settled",
    noteReadable:
      "Identity came from the orchestration callback; the file is not confirmed readable",
    targetNoFacts: "(No target facts: the block was created by reconciliation first)",
    targetIsolatedCreate: "Isolated file world creation",
    targetChatCreate: "Plain chat creation",
    targetResult: "Parent {{parent}} · step {{span}} · edit {{field}}{{isolated}}",
    targetIsolatedSuffix: " · isolated",
    targetPrompt: "Parent {{parent}} · edit {{field}}",
    targetProxy: "Parent {{parent}} · step {{span}}",
    targetModelAb: "Parent {{parent}} · {{count}} arms",
    targetVerificationPrepare: "{{target}} · environment preparation",
    targetVerification: "{{target}} · {{command}}",
    checkpointInitial: "Initial checkpoint",
    checkpointStep: "Step {{span}}",
    stepMissing: "(missing)",
    parentCheckpoint: "Parent {{runId}} · {{checkpoint}}",
    unknownTarget:
      "(This submit belongs to a previous main-process session; its registration facts are not in the current snapshot)",
    badgeOperations: "Operations {{count}}",
    badgeRunning: "Running {{count}}",
    badgeUnknown: "Needs check {{count}}",
    badgeUnread: "Results to review {{count}}",
    noticeNotAccepted:
      "{{kind}} was not accepted by the main process: nothing ran and the input is preserved",
    noticeUnlocated:
      "{{kind}} ended but its result was not located: the registration has no trusted run ID",
    unreadable: "Result unreadable",
    unreadableVerdict: "result cannot be read",
    hasResult: "has a result",
    noticeItem: "{{kind}} {{verdict}}: {{runId}} ({{label}})",
    waitBasisSubmitted: "Since submit",
    waitBasisAccepted: "Since acceptance",
    waitUnknownElapsed:
      "{{basis}}: {{duration}} elapsed (outcome unknown: this period does not indicate progress)",
    waitRunning:
      "{{basis}}: waiting {{duration}} (wait time, not model time, and no progress meaning)",
    waitSettled: "{{basis}}: settled after {{duration}} (timer stopped)",
    notAcceptedBusy:
      "The execution slot is occupied: nothing started and no permission was consumed",
    notAcceptedClosing: "The main process is negotiating shutdown: this submit was not accepted",
    notAcceptedConfigurationBusy:
      "A configuration change is in flight: this submit was not accepted",
    notAcceptedTombstone:
      "This operation was blocked by reconciliation: late requests will not revive it",
    draftGoneNote:
      "The draft for this submit was cleared by revision or was never registered: it is not returned and old content is not revived (copy old input from the draft list if needed)",
    resultUnread: "Result not read yet",
    resultReading: "Reading result",
    resultNotReadDetail:
      "This trusted run ID has not been read yet; opening reads it once and does not rerun anything",
    resultReadingDetail:
      "A read-only channel is in flight (no execution is resent and the current reading view is unchanged)",
    resultUnreadableFailureNote:
      "Failure location is not attempted when the outcome cannot be read (no other record is used as a substitute)",
    resultNotErrorFailureNote:
      "This run did not end with an error, so there is no failed call to locate",
    resultMissingFailureDetail:
      "The run ended with an error, but its own records contain no failed model call detail (ancestor calls are not presented as the cause)",
    sourceIncompleteWarning:
      "{{text}} (missing ancestor run: {{missingRunId}}) — only this run's own records were verified; a normal end does not mean it can be rerun",
    operationRunning: "Running",
    runningNoProgress:
      "The draft stays frozen; progress, stages, or percentages are not shown (the main process has no such facts)",
    operationNotAccepted: "Not accepted",
    notAcceptedUnknownReason: "Not accepted (the main process gave no stable reason)",
    resultUnlocated: "Result not located",
    unlocatedDetail:
      "The registration has no trusted run ID: only registration facts can be checked; no result is guessed from the latest list item or error text",
    resultsCount: "{{count}} results",
    resultSingle: "Result",
    requestReturnedAb:
      "Request facts: the main process settled as returned{{code}} — an A/B return may include failed arms, so no run is declared successful",
    requestReturned:
      "Request facts: the main process settled as returned{{code}} — each run's outcome is determined only by its own terminal events",
    requestFailed:
      "Request facts: request failed{{code}} — a failed envelope does not prevent opening and verifying registered runs by trusted ID",
    requestRejected:
      "Request facts: rejected by business logic{{code}} — rejection is an orchestration classification and does not always mean zero model calls; check own terminal facts for whether calls happened",
    requestStableCode: " (stable code {{code}})",
    requestOutcomeReturned: "returned",
    requestOutcomeFailed: "request failed",
    requestOutcomeRejected: "rejected",
    armOutcomeReturned: "Request layer: this arm returned",
    armOutcomeFailed: "Request layer: this arm failed",
    armOutcomeRejected: "Request layer: this arm was rejected",
    abArmNoIdRunning:
      "Arm {{index}}: no trusted run ID registered yet (running; not observing it does not mean failure, and no result entry is offered early)",
    abArmNoIdSettled:
      "Arm {{index}}: main registered no trusted run ID (missing arm / not started) — no result link is generated and no ID is taken from the envelope or nearby records",
    abStatusWaiting: "Waiting for registration snapshot",
    abStatusWaitingDetail:
      "The submit identity for this execution is known, but the main-process registration snapshot has not arrived: no outcome is predicted; check status from the Operations entry",
    abStatusRunning: "Running",
    abStatusRunningDetail:
      "The batch is presented arm by arm from registrations; progress, stages, or percentages are not shown (the main process has no such facts)",
    abStatusNotAccepted: "Not accepted",
    abStatusNotAcceptedDetail:
      "The whole batch did not start and consumed no permission; there are no readable experiment results",
    abStatusSettled: "Settled",
    abStatusSettledDetail:
      "Each arm is shown by its registered identity and independent verification: settled does not mean all succeeded; missing and failed arms are kept as they are",
    outcomeCompleted: "Completed",
    outcomeError: "Ended with error",
    outcomeMaxIterations: "Reached iteration limit",
    outcomeBudgetExceeded: "Exceeded budget",
    outcomeAborted: "Aborted",
    outcomeInterrupted: "Run interrupted",
    outcomeUnknown: "End reason unknown",
    actionOpenResult: "Open result",
    actionViewFailure: "View failed call",
    actionRetryRead: "Re-read this result",
    actionReturnDraft: "Return to draft",
    actionTitleOpen:
      "Open the overview by trusted run ID (an explicit user action, unrelated to automatic-navigation intent)",
    actionTitleRetry:
      "Re-read only the same trusted run ID ({{runId}}): nothing is rerun and no other record is tried",
    actionTitleFailure:
      "Locate only a failed call owned by this run; ancestor error calls are not this run's cause",
    actionTitleReturn:
      "Return to the draft edited for this submit (permission was reset; check and authorize again)",
    diagnosticStageExecute: "Execute",
    diagnosticStageIdentity: "Identity registration",
    diagnosticStageFinalize: "Finalize",
    diagnosticStageCleanup: "Cleanup",
    diagnosticStageRejection: "Rejection",
    diagnosticLine: "[{{stage}}] {{code}}: {{message}}",
    diagnosticTitle:
      "Controlled diagnostics: stable codes plus redacted, length-limited text (bodies, keys, authorization, and source-directory credentials have no structural path in)",
    diagnosticSummary: "Controlled diagnostics: {{count}} (no bodies or credentials)",
    operationIdLine: "Operation {{id}}",
    experimentLine: "Experiment {{id}}",
    reconcileButton: "Check status",
    reconcileTitle:
      "operations:reconcile({{id}}) — checks operation facts only; it reads no run files and switches no pages",
    modeChat: "Plain chat",
    modeIsolated: "Isolated file run",
    createTitle: "New run",
    createSubtitle:
      "Runs a run from the start (no parent run, no continuation of an existing trajectory)",
    modeLabel: "Run mode",
    userMessageLabel: "User Message (required)",
    userMessagePlaceholder: "The task for the model. It also becomes this run's title in the list.",
    userMessageHelp: "This text becomes the run's title (task) in the list.",
    pickingSource: "Choosing…",
    chooseSource: "Choose directory…",
    rechooseSource: "Choose again…",
    noSourceSelected: "No source directory selected",
    sourceCollectNote:
      "Collects all supported regular files in the selected directory (including hidden files); links, non-regular files, disk roots, and paths inside the data directory are rejected.",
    sourceWritesNote:
      "File contents land only in immutable attachments under the data directory; the source directory is not modified, and later fork writes land only in each copy's mapping.",
    sourceToolsNote: "Text read by the {{tools}} tools enters the model request you configured.",
    allowWrites: "Allow file writes for this execution",
    allowWritesNote:
      "(Off by default; valid only for this submit, and you must check it again after reopening or switching modes)",
    currentEndpoint: "Current endpoint:",
    openSettings: "Run settings…",
    isolatedModelNote: "Text read by isolated-run tools also enters this model request.",
    chatModelNote: "Plain chat requests carry no tool table.",
    advancedSystemPrompt: "Advanced: System Prompt (optional)",
    systemPromptPlaceholder:
      "For example: You are a concise Q&A assistant. Answer in two or three sentences.",
    systemPromptOptionalHint:
      "Leaving it empty is fine: the configuration fingerprint is computed with an empty system{{isolated}}, and the run can still serve as a fork or A/B parent.",
    systemPromptEmptyIsolated: " (empty system + fixed tool set)",
    scopeLabel: "Execution scope:",
    techSummary: "Technical notes",
    techDetails:
      "Plain chat produces a v1 root run; isolated file runs produce a v2 root run (with a checkpoint and initial snapshot, and can be continued from the second turn). config_hash is the configuration fingerprint computed from system and the tool table; changing either changes it.",
    confirmTitle: "Review this submit",
    confirmAccept: "Reviewed — confirm this submit",
    confirmAccepted: "This submit is confirmed",
    confirmHelp:
      "Creation is allowed only after confirmation; changing any input, switching configuration, or visiting another page requires confirming again.",
    formFrozen:
      "This submit is pending: the form is frozen at the submitted revision and cannot be edited, switched, or discarded until the request returns. Switching runs, reading files, and opening settings remain available.",
    formBusy:
      "This creation is still in progress: check its outcome and result from the Operations panel above; staying on this page does not block it.",
    discardButton: "Discard entered content",
    noChangesToDiscard: "No changes to discard",
    submitting: "Creating…",
    submitIsolated: "Create isolated run",
    submitChat: "Create",
    settingsNotLoaded: "Run configuration has not been read",
    settingsSummary: "Current model {{model}} ({{baseURL}})",
    settingsUnconfigured:
      "Run parameters are not configured: the submit will be rejected (SETTINGS_NOT_CONFIGURED)",
    scopeIsolatedExecution:
      "Isolated file run: reads the selected directory only and executes with the fixed {{profile}} tool set ({{tools}}); file writes require an explicit check in this submit. It produces an isolated run with checkpoints (usable as a continuation and comparison parent from the second turn).",
    scopeIsolatedCost:
      "One submit = one real model call (billed by actual usage); collected text enters the model request you configured.",
    scopeChatExecution:
      "Plain chat: tools are disabled and the model produces text only; the configuration fingerprint is computed from system and the tool table (empty here).",
    scopeChatCost: "One submit = one real model call (billed by actual usage).",
    confirmBlocked: "Fill in the required inputs before reviewing this submit",
    discardTitle: "Discard create draft",
    discardMessage:
      "Discard the content entered for this creation?\n\nRun mode, System Prompt, and User Message are all reset (the source directory choice and write authorization are discarded too).",
    createFailureSummary:
      "The run was not created; check the run list for any created record before retrying.",
    createRawDetailLabel: "Original detail (returned by main)",
    createRawDetailHint:
      "The original detail is kept untranslated; use the stable code to interpret it.",
    gateNotHandshaked:
      "Operation status has not been confirmed with the main process; retrying the handshake…",
    gateCommunicationUnknown:
      "Operation status is unconfirmed (the status channel is unreachable or returned an error). Check status first and do not submit again.",
    gateClosing: "The app is quitting and cannot start a new execution.",
    gateConfigurationBusy:
      "Run configuration or the proxy is changing; wait for it to finish before executing.",
    gateOperationRunning:
      "Another operation is running (the desktop allows only one active operation); wait for it to finish.",
    submitBusy: "Running: this run has not finished, so it cannot be submitted again",
    submitUserMessageRequired:
      "User Message cannot be empty (it is both the run's title and its first user message)",
    submitSourceRequired:
      "An isolated file run requires choosing a source directory first (read-only collection; the source directory is not modified)",
    submitWritesRequired:
      "Check “Allow file writes for this execution” — authorization is valid only for this submit and is never restored from history",
    returnTo: "Back to {{destination}}",
    returnToWorkspace: "Back to {{view}}",
    returnFallbackNoLocation:
      "This session recorded no source location (it is lost after reload), so the original page cannot be restored.",
    returnFallbackRunMissing:
      "The source run is no longer in the list, so the original location cannot be restored.",
    workspaceTrace: "Runs",
    workspaceTree: "Branch tree",
    workspaceCreate: "New run",
    workspaceCompare: "Comparison",
    workspaceRecording: "Recording",
    workspaceExperiment: "Model experiments",
    workspaceMessages: "Edit messages",
    tabOverview: "Overview",
    tabSteps: "Call steps",
    tabFiles: "Files",
    tabStepsShort: "Steps",
    listAria: "Run list",
    listReturnCurrent: "Back to the current run (collapse the run list)",
    listReturnCurrentTitle: "Back to the current run",
    listTitle: "Runs",
    listNewRun: "＋ New run",
    listSubtitle: "Newest first · trace is read-only",
    searchPlaceholder: "Search the full task or run ID",
    filterAll: "All",
    filterProxy: "Proxy recordings",
    filterLocal: "Local records",
    metricsToggle: "Metrics",
    metricsToggleHint:
      "Show each record's model and usage metrics (steps, tools, tokens, cache hits, duration)",
    selectedHidden:
      "The current run's record is not in the filtered results; the main workspace still shows it.",
    listStale: "The list was not updated; the previous results are still shown.",
    clearFilters: "Clear filters",
    retry: "Retry",
    emptyFiltered: "No runs match the current filters.",
    emptyNoRecords:
      "No runs yet: choose “＋ New run” above to start one, or put *.jsonl files into traces/ in the data directory.",
    proxyBadgeHint:
      "Recorded through the local recording proxy (its llm.call messages can be edited and resent)",
    fullId: "Full ID: {{id}}",
    branchBadge: "Branch",
    listCacheHint:
      "Recorded cache hits from this run's own llm.call spans (excludes the shared ancestor prefix; not a whole-run hit rate)",
    loadFailed: "Read failed: ",
    navWidth: "Run navigation width",
    toolCount: "{{count}} tools",
    cacheHitShort: "Hits {{value}}",
    zeroUsageHint:
      "Recorded usage is 0; this may be a placeholder for a failed call, so actual zero consumption is not asserted",
    zeroUsageSuffix: " (possibly a failure placeholder)",
    toolErrorsCount: "{{count}} errors",
    copyIdAria: "Copy the full run ID {{id}}",
    copyIdTitle: "Click to copy the full ID: {{id}}",
    copyId: "Copy ID",
    workspaceTabsAria: "Run workspace tabs",
    noRunSelected: "No run selected",
    runIdLabel: "Run ID",
    isolatedBadge: "File-isolated",
    headerParentCheckpoint: "Parent run {{runId}} · checkpoint {{span}}",
    headerParentInitial: "Parent run {{runId}} · initial snapshot",
    headerIndependentWorld: "Independently collected file world",
    statusUnknown: "Status unknown",
    hintInterrupted: "Process interrupted; no terminal event",
    hintUnknownNoReason: "No end reason recorded",
    hintUnknownOriginal: "Original end reason: {{reason}}",
    hintAborted: "The run was aborted (not a normal end)",
    forkEditResult: "Edit tool_result",
    forkEditMessages: "Edit messages",
    forkEditSystemPrompt: "Edit system prompt",
    forkEditUserMessage: "Edit user message",
    forkEditModelParams: "Change model/params (A/B)",
    forkEditOther: "Edit {{field}}",
    forkFromStart: "rerun from start",
    isoParentExecutionNotice:
      "This is an isolated file run: model A/B does not support isolated parents in this release — main and the kernel reject it even if IPC bypasses the UI. Startup-prompt experiments can start only from a verified root run; branches offer explicit navigation back to the root and never treat branch messages as the root startup context.",
    isoOriginImport:
      "Independent file world (world_id {{worldId}}), collected from the chosen source directory",
    isoOriginInitial: "Rerun from the initial snapshot of run {{runId}}",
    isoOriginCheckpoint: "Continued from a checkpoint of run {{runId}}",
    isoNotice:
      'Isolated file run · profile {{profile}} · {{origin}}. File reads and writes happen only in the independent world: the source directory, parent branch, and sibling branches are never modified; the page does not present this run as "restored historical disk state".',
    isoOriginImportCompact: "Independent file world collected from the chosen source directory",
    isoOriginInitialCompact: "Rerun from the initial snapshot of run {{runId}}",
    isoOriginCheckpointCompact: "Continued from a checkpoint of run {{runId}}",
    isoOriginInitialFull: "Rerun from the start using the initial snapshot of run {{runId}}",
    isoCompact: "Isolated file run · {{origin}}",
    isoDetail:
      'File reads and writes happen only in the independent world: the source directory, parent branch, and sibling branches are never modified; the page does not present this run as "restored historical disk state".',
    isoOriginImportTech: "import (source directory collection)",
    isoOriginInitialTech: "initial (source run {{runId}} · snapshot {{snapshotId}})",
    isoOriginCheckpointTech: "checkpoint (source run {{runId}} · step {{span}})",
    isoOriginLabel: "Origin",
    isoContinueLabel: "Continue after turn {{iteration}} of run {{runId}}",
    isoCheckpointLabel: "End-of-turn checkpoint {{snapshot}}… · {{count}} files / {{bytes}}",
    isoBranchBoundaryNoIteration:
      "Continue after that turn of run {{runId}} (the local turn number could not be resolved from the trace; only step {{span}} is reported)",
    isoBranchBoundaryIteration:
      "Continue after turn {{iteration}} of run {{runId}} (whole-turn continuation: tools in that turn are not re-run)",
    checkBusy: "A rerun is in progress; another check cannot start",
    checkingConditions: "Checking continuation conditions…",
    settingsRequiredForFork:
      "Run parameters are not configured (baseURL / apiKey / model); open Run settings first",
    checkUnchanged:
      "It is identical to the original result; edit it before checking, because an unchanged continuation is rejected as-is.",
    submitBusyFork: "A rerun is in progress; this cannot be submitted again",
    submitUnchanged:
      "It is identical to the original result; edit it before rerunning, because an unchanged continuation is rejected as-is.",
    checkRequired:
      "Choose “Check continuation conditions” first to run the read-only precheck (checkpoint and end-of-turn boundary)",
    checkMismatch:
      "The precheck result does not match the current fork point; check the continuation conditions again",
    writesRequiredFork:
      "Check “Allow file writes for this execution” — authorization is valid only for this submit and is never restored from the parent run's write_authorized marker",
    finalOutput: "Final output",
    noFinalOutput: "No final output recorded",
    resultNoLlmCall: "This run recorded no model calls of its own, so there is no output to show.",
    resultEmptyContent: "The last model call of this run returned an empty body.",
    resultReasoningOnly:
      "The last model call recorded reasoning only, with no body — the recorded content type is “reasoning”.",
    resultPendingToolCalls:
      "The last model call recorded tool calls only, with no body — the recorded content type is “tool calls”, and the loop should have continued.",
    resultHasError: "The last model call ended with an error, so there is no usable body.",
    resultNotNormalEnd:
      "This run did not end normally (not a completed terminal event); the last body is not treated as the final result.",
    intermediateBlockLabel: "Last body recorded before the end (not this run's final result)",
    openCallReasoning: "Open this call to view the full reasoning",
    openCallTools: "Open this call to view tool call details",
    outcomeNoteMaxIterations:
      "The loop stopped after reaching the iteration limit; this is not a normal end.",
    outcomeNoteBudgetExceeded:
      "The run stopped after exceeding the token / budget limit; this is not a normal end.",
    outcomeNoteAborted:
      "The run was aborted; this is not a normal end, and recorded content remains below.",
    outcomeNoteInterrupted:
      "No terminal event was recorded (the process may have been killed); this does not mean it is still running.",
    outcomeNoteUnknown:
      "A terminal event exists but its reason is outside the known set; see the run record for the original reason.",
    llmErrorMissingNote:
      "This run ended with an error, but its own records contain no LLM error detail — the cause is not inferred and ancestor errors are not borrowed.",
    consumptionScopeNote:
      "Recorded values from this run's own calls only; the shared ancestor prefix is excluded and missing values are not zero-filled.",
    consumptionZeroUsage:
      "Recorded usage from this run's own calls is 0 — this may be a placeholder for failed calls; actual zero consumption is not asserted.",
    cacheNoCalls: "This run has no model calls of its own, so there is no cache record.",
    cacheNoHitsRecorded:
      "None of this run's {{count}} own model calls recorded cache-hit fields; hits are unknown.",
    cacheCoverageNote:
      "Recorded hits for {{recorded}} / {{total}} own calls (partial records do not make a whole-run hit rate).",
    sourceRootIsolated:
      "This is the root run of an isolated file world: the world was collected from the chosen source directory, and there is no upstream run record.",
    sourceRoot: "This is a root run with no upstream source record.",
    sourceIsolation:
      "Isolated file run: file reads and writes happen only in the independent world; the source directory is not modified.",
    sourceIsolationCheckpoint:
      "Isolated continuation: it starts from the end-of-turn checkpoint of run {{runId}}, and file reads and writes happen only in the independent world.",
    sourceIsolationInitial:
      "Isolated prompt experiment: it starts from the initial file state and startup instructions of run {{runId}}, and file reads and writes happen only in the independent world.",
    sourceRelationProxy:
      "Forked run recorded through the proxy (single-request edit and resend): see the parent chain for the source relation; this run shows only its own records.",
    sourceRelationPromptFork:
      "Prompt fork (rerun from start): this run is an independent execution that shares no parent trajectory prefix; the parent run is only a reference for lineage.",
    sourceRelationModelAb:
      "Model A/B arm (rerun from start): this run is an independent execution that shares no parent trajectory prefix; the parent run is only a reference.",
    sourceRelationIncomplete:
      "The parent chain is incomplete: only this run's own trajectory is shown; the shared prefix and ancestor increments are unknown and are neither zero-filled nor inferred.",
    sourceRelationSharedPrefix:
      "The parent run's trajectory up to the fork point is a shared prefix (from the parent run file; this run records only new spans).",
    sourceIncompleteNote: "{{text}} (missing ancestor run: {{missingRunId}})",
    copyFullOriginal: "Copy the full original {{label}}",
    overviewAria: "Run overview",
    overviewOutcomeAria: "Run outcome",
    overviewLlmErrorAria: "LLM error",
    overviewToolErrorsAria: "Tool errors",
    overviewConsumptionAria: "This run's usage",
    overviewSourceAria: "Source",
    overviewPromptExperimentAria: "Isolated startup-prompt experiment",
    overviewResultAria: "Run result",
    outcomeTitle: "How it ended",
    failureReasonTitle: "Failure reason",
    failedCallTitle: "Failed call",
    directParentTitle: "Direct parent run ID",
    httpStatusUnknown: "HTTP status not recorded",
    cacheHitUnknown: "Cache hits not recorded",
    errorBodyMissing: "This call is marked as an error, but no error body was recorded.",
    notFilled: "Not filled in",
    openCallExpandStep: "Open this call and expand its step",
    backToParent: "Back to parent record",
    toolErrorsTitle: "Tool errors",
    timesCount: "{{count}} times",
    locate: "Locate",
    tokensInLabel: "Input tokens",
    tokensOutLabel: "Output tokens",
    toolCallsLabel: "Tool calls",
    toolErrorsLabel: "Tool errors",
    durationLabel: "Recorded time span",
    cacheHitLabel: "Cache hits",
    durationUnknown: "Time span not recorded",
    compareWithParentAria: "Compare with the parent run (parent on the left, child on the right)",
    baselineRun: "Baseline run",
    baselineCall: "Baseline call",
    experimentOldValue: "Experiment original value",
    experimentNewValue: "Experiment new value",
    noOutputNoCall: "There is no output to show and no call to locate.",
    toolErrorsNotCause: "(not a terminal cause)",
    consumptionOwnNote: "(this run's own)",
    directParentRun: "Direct parent run",
    editedFieldLabel: "Edited field",
    compareWithParent: "Compare with parent run",
    promptExperimentTitle: "This intervention · isolated startup-prompt experiment",
    editingField: "Editing {{field}}",
    initialSnapshot: "Initial snapshot",
    executionModel: "Execution model",
    paramsLabel: "Parameters",
    endpointLabel: "Endpoint",
    limitsBudget: "Limits / budget",
    planFingerprint: "Plan fingerprint",
    iterationsBudget: "{{iterations}} iterations / {{budget}} tokens",
    budgetXAxis: "LLM call order",
    budgetYAxis: "Cumulative tokens",
    budgetMarkLine: "Budget {{value}}",
    budgetNone: "No budget info",
    budgetSummary: "Context budget map · {{budget}}{{exceeded}}",
    budgetSummaryExceeded: " · stopped over budget",
    budgetEmpty: "This run contains no LLM calls, so no curve can be drawn.",
    budgetDetailBase: "Cumulative usage {{total}} tokens (in+out) across {{count}} LLM calls.",
    budgetNoLimitSuffix: "This run recorded no budget limit, so no reference line is drawn.",
    hypothesisLabel: "Hypothesis (user-provided)",
    acceptanceLabel: "Manual criterion (user-provided; never auto-scored)",
    experimentHypothesis: "Experiment hypothesis",
    acceptanceCriterion: "Manual criterion",
    compareWithBaseline: "Compare with baseline run",
    openRunFilesExport: "View this run's files / export",
    promptExperimentNote:
      "Comparison defaults to parent-left, child-right; export uses this run's explicit own checkpoint, and patches are relative to that run's initial snapshot.",
    recorded: "Recorded",
    producingCallTitle: "Call that produced this body",
    bodyLabel: "Body",
    treeTitle: "Branch tree",
    treeSummary: {
      one: "{{count}} run · nodes are runs, edges are forks · read-only",
      other: "{{count}} runs · nodes are runs, edges are forks · read-only",
    },
    treeEmptyTitle: "No runs recorded yet, so no branch tree can be drawn.",
    treeEmptyBody:
      "Run one first (via trace-sdk / agent-loop), or point your agent's base_url at the local recording proxy to record one.",
    treeOpenDetail: "View selected run detail",
    treeScopeAria: "Tree scope",
    treeScopeCurrent: "Current tree",
    treeScopeAll: "All relations",
    treeSearchAria: "Search runs (full ID or task)",
    treeSearchPlaceholder: "Full ID or task keywords",
    treeModeAria: "Presentation mode",
    treeModeGraph: "Graph",
    treeModeList: "Relation list",
    treeCenter: "Center current run",
    treeFit: "Fit canvas",
    treeNoMatch:
      "No runs match “{{query}}” (matched against full IDs and original task text). The existing selection is unchanged.",
    treeHitRoot: "Tree root {{root}}",
    treeHitOutside:
      "This run is outside the current scope (tree root {{root}}); click to center its tree",
    treeHitOutsideShort: "Outside scope",
    treeNodeTooltip: "{{task}} · {{id}} (double-click to open the run)",
    treeOrphanMissing: "Parent missing",
    treeOrphanCycle: "Parent cycle",
    treeOrphanMissingTitle:
      "The parent run is not in the data directory (deleted, or only half the family was copied); promoted to a root",
    treeOrphanCycleTitle:
      "The parent chain contains a cycle; it was broken and this run was promoted to a root",
    treeNodeIdTitle: "Full run id (copyable): {{id}}",
    treeNodeProxy: "Proxy",
    treeNodeModelMissing: "Model: not recorded",
    treeNodeModelMissingTitle: "No model field was recorded",
    treeNodeModel: "Model: {{model}}",
    treeNodeModelTitle: "Recorded model (full value): {{model}}",
    treeNodeDelta: "This run's increment {{steps}} · {{tokens}} tokens",
    treeNodeChained: "Cumulative increment (summed along the chain)",
    treeNodeChainedTitle:
      "Sums each generation's increment along the parent chain; not equal to one continuous run from the start; open run details to copy the full cumulative values",
    treeCompareAria: "Add {{id}} to the comparison",
    treeCompareTitle: "Add to comparison (up to 4)",
    treeMissingParentRich:
      "Missing parent run <code>{{id}}</code> ({{reason}}) — child run {{child}} was promoted to a root",
    treeMissingParentReason:
      "This parent run is not in the data directory and cannot be opened or compared",
    treeSelect: "Select",
    treeOpenRun: "Open run",
    treeRemoveCompare: "Remove from comparison",
    treeAddCompare: "Add to comparison",
    treeFullIdTitle: "Full run id: {{id}}",
    treeExperimentBadgeTitle: "Recorded experiment group label (real experimentId)",
    treeExperimentBadge: "Experiment {{id}}",
    treeExperimentGroup: "Experiment group {{id}} ({{arms}})",
    treeArmCount: { one: "{{count}} arm", other: "{{count}} arms" },
    treeSelectedHeading: "Selected run",
    treeSelectedDetailAria: "Selected run detail",
    treeIncomingEdge: "Incoming edge: {{label}} · fork point {{span}}",
    treeFullTask: "Full task",
    treeCopyFullId: "Copy full ID",
    treeModelMissingFull: "Model: not recorded (not backfilled from current settings)",
    treeChainedTotals:
      "Cumulative along the chain (summed): {{values}}; not equal to the consumption of one continuous run from the start",
    treeChainedUnknown: "— (chain unavailable; not zero-filled)",
    treeFooter:
      "Clicking a node selects the run (same as clicking in the list); after selecting, use the header entry or “Trace” in the global bar to return to details. Check a node to add it to the comparison on the right. Edge labels show which field was edited at the fork; the fork-point span id is shown in the detail panel.",
  },
  detail: {
    lineageIncomplete: "Showing only this run's records; the parent chain is incomplete",
    lineageMetricsUnknown:
      "The parent chain is incomplete: ancestor metrics along the chain are unknown; they are not zero-filled or inferred.",
    missingAncestor: "Missing ancestor run: {{runId}}",
    ownOnlyBranchLine: "{{text}} (missing ancestor run: {{missingRunId}}).",
    ownOnlyEditLine:
      "Edited field: {{field}} · fork point {{span}} (markers kept; the parent prefix was not merged into the timeline).",
    truncatedChain:
      "Fork chain (truncated: parent chain incomplete; the first item is not the root run)",
    incompleteChain: "Fork chain (parent chain incomplete)",
    kindStep: "Step",
    kindTool: "Tool",
    stepTurn: "Turn {{turn}}",
    llmCallLabel: "LLM call",
    expandStepAria: "Expand this step",
    collapseStepAria: "Collapse this step",
    inheritedBadge: "Inherited",
    inheritedTitle: "Shared prefix from the parent run (not this run's own)",
    orphanBadge: "Orphan",
    orphanTitle: "The parent span is not in this trace",
    toolErrorBadge: "Tool error",
    toolErrorRowTitle: "The tool call recorded an error",
    llmErrorBadge: "LLM error",
    llmErrorRowTitle: "The model call recorded an error",
    collapseSteps: "Collapse step directory",
    backToCurrentCall: "Back to the current call (collapse the step directory)",
    collapseStepsTitle:
      "Collapse the step directory (the body keeps a “Reopen step directory” entry; the selected call is not lost)",
    traceHeading: "Trace",
    spanCountReadOnly: {
      one: "{{count}} span · read-only",
      other: "{{count}} spans · read-only",
    },
    noSpans: "This record has no spans — there are no steps to show.",
    noOwnCalls:
      "This run has no model or tool calls of its own; the inherited shared prefix is shown below (the first selection falls back to the first readable span).",
    stepsWidth: "Step directory width",
    selectRunHint: "Select a run from the left.",
    selectSpanEmpty: "No span selected.",
    stepSummary: "Step summary",
    openStepFiles: "Open this turn's files",
    openStepFilesHint:
      "Locates this run's end-of-turn file checkpoint (not a historical checkpoint, and does not borrow the parent run's snapshot).",
    iterationIndex: "Iteration",
    recordedCalls: "Recorded calls",
    errorAmong: "Errors",
    durationLabel: "Duration",
    tokensIn: "Input tokens",
    tokensOut: "Output tokens",
    toolCalls: "Tool calls",
    stepConsumptionNote:
      "The consumption below is derived from this step's subtree (existing trace semantics). Select any call to open its original request and response.",
    recordedCallsTitle: "Recorded calls ({{count}})",
    stepNoCalls: "This step has no directly recorded LLM calls or tool executions.",
    errorBadge: "Error",
    stepExpandHint: "Expand this step to view its LLM calls and tool executions.",
    focusEditActive:
      "Focus editing · drafts and the budget map are temporarily hidden (selection and reading state are unchanged; the original layout returns on exit)",
    focusEditHint:
      "Temporarily hide drafts and the budget map to give editing more room (restores the original layout on exit)",
    summaryTitle: "Summary",
    modelLabel: "Model",
    usageFailed: "Not available (placeholder for a failed call)",
    ttftFailed: "Not applicable (no body arrived for a failed call)",
    toolCallsFailed: "Not applicable (failed call)",
    draftLabel: "Draft",
    ttftLabel: "Time to first token",
    viewLabel: "View",
    viewInput: "Input",
    viewOutput: "Output",
    ioBothHalvesNote: "Both halves remain complete; switching loses no fields",
    failedCallTitle: "Error (the call failed; the error is data)",
    callFailed: "Call failed",
    errorDetailLabel: "Error detail",
    errorPlaceholderRich:
      "This is the recorded failure reason for this call. The tokens and time-to-first-token above are <strong>placeholder zeros for a failed call</strong>; they do not mean zero usage or zero latency. The request remains viewable.",
    reasoningTitle: "Reasoning (reasoning_content)",
    reasoningLabel: "Reasoning",
    responseBodyTitle: "Response body",
    bodyLabel: "Body",
    toolCallsTitle: "Tool calls ({{count}})",
    requestMessagesTitle: "Request messages ({{count}})",
    messageContentLabel: "Content",
    toolTableTitle: "Tool table ({{count}})",
    paramsTitle: "Sampling parameters",
    emptyFailed: "(Call failed; no response body)",
    emptyToolCallsOnly: "(No body; tool calls only)",
    emptyReasoningOnly: "(No body; reasoning only)",
    emptyBody: "(Empty response body)",
    forkFirstCallOnly:
      "prompt fork and Model A/B start only from the first llm.call's startup context; open the first llm.call ({{callId}}) to use the edit entry.",
    editMessagesResend: "Edit messages and resend",
    messagesWorkspaceNote:
      "Opens in the messages editing workspace: single-request fork · the source run is not modified · resend uses the most recently captured key",
    crashedNoResend: "This run was interrupted (not sealed) and cannot be a resend starting point.",
    toolLabel: "Tool",
    execDuration: "Execution time",
    wallDuration: "Wall-clock time",
    toolCompactLine: "Execution {{dur}}ms · wall-clock {{wall}}",
    draftSuffix: " · {{label}}",
    argsAndResult: "Arguments and result",
    toolErrorTitle: "Error (the error is data, not an exception)",
    toolErrorMessage: "Error message",
    argsLabel: "Arguments",
    resultLabel: "Result",
    toolAncestorOnly:
      "This call is in the ancestor prefix (inherited from the parent run) and is not part of this run's own segment — open the run that owns it to rerun here.",
    crashedNoFork: "This run was interrupted (not sealed) and cannot be a fork starting point.",
    resultRunIsolated: "Rerun here (isolated continuation)",
    resultRunPlain: "Rerun here (time travel)",
    resultIsolatedIntro:
      "Isolated continuation: continue after the turn containing this tool (the whole turn is continued; other tools in that turn are not re-run); the parent run, source directory, and sibling branches are never modified.",
    resultPlainIntro:
      'Time travel: rerun this step after this tool call, and write the result into a new branch. It is not "restoring the world" — external calls really executed in the meantime are not undone, and writes from other tools in the same turn are not rolled back.',
    rerunHeadingIsolated: "Rerun here · isolated continuation",
    rerunHeading: "Rerun here",
    rerunSummaryIsolated:
      "Continue from the end-of-turn checkpoint · the parent run and source directory are not modified",
    rerunSummaryPlain: "Rerun after this tool call · the parent run file is not modified",
    rerunDetailsLabel: "Rerun details",
    rerunDetailsIsolated:
      "The text above is sent back to the model as this tool's result; later steps are regenerated by the model, and the file world continues from that turn's end-of-turn checkpoint.",
    rerunDetailsPlain:
      "The text above is sent back to the model as this tool's result; the rest of the context (prompt, tool table, earlier steps) is identical to the parent run.",
    discardResultDraftTitle: "Discard the tool result draft",
    discardResultDraftMessage:
      "Discard this tool result draft? (run {{runId}} · {{spanId}})\n\nCurrent draft content:\n{{content}}\n\nThe discard is checked against the revision at confirmation time: if the content is updated afterwards, this discard will not run.",
    discardResultDraftSimple:
      "Discard this tool result draft? Its content will be deleted and cannot be recovered.",
    precheckTitle:
      "Continuation conditions (read-only precheck: creates no run, writes no file, calls no model)",
    isoWholeTurnNote:
      "(Whole-turn continuation: other tools in this turn are not re-run; each appears once in the child run's prefix.)",
    parentRunLabel: "Parent run",
    editPointLabel: "Edit point",
    allowWrites: "Allow copy writes for this execution",
    allowWritesNote:
      "(Off by default; valid only for this submit. The parent trace's write_authorized marker is a historical audit note — authorization is never restored from it, and reopening requires checking again.)",
    precheckChecking: "Checking…",
    precheckRecheck: "Check again",
    precheckRun: "Check continuation conditions",
    precheckUnavailable: "Continuation conditions unavailable ({{code}}): {{message}}",
    precheckUnavailableNote:
      'The reason comes from the read-only precheck in main; the UI does not fall back to the "current directory" or the parent run\'s historical markers.',
    realModelCallLabel: "Real model call: ",
    realModelCallScoped: "; this operation only calls that model and writes no source directory.",
    modelUnconfiguredShort: " (not configured)",
    modelUnconfigured: "(no model configured)",
    confirmIsolatedTitle: "Review this continuation",
    confirmIsolatedAccept: "Reviewed — confirm this continuation",
    confirmIsolatedAccepted: "This continuation is confirmed",
    confirmIsolatedBlocked:
      "No read-only precheck result yet: choose “Check continuation conditions” above so you review exactly that result.",
    confirmPlainTitle: "Review this rerun",
    confirmPlainAccept: "Reviewed — confirm this rerun",
    confirmPlainAccepted: "This rerun is confirmed",
    draftFrozenNote:
      "This submit is pending: the draft is frozen at the submitted revision and cannot be edited or discarded until the request returns. The draft is kept regardless of success, business rejection, or failure; it is cleaned up automatically only after a trusted identity verifies a normal end and the draft revision still matches the submitted text exactly.",
    rerunInProgress: "Rerunning… (a real LLM call; this may take a while)",
    discardChanges: "Discard changes",
    discardNoChangesTitle: "No changes to discard",
    discardDraftTitle:
      "Discard this draft (confirmation required; checked against the current revision)",
    confirmRerun: "Confirm rerun",
    forkFailedSummary: "The rerun request did not complete (stable code {{code}}).",
    rawFailureDetail: "Raw detail (returned by main):",
    sourceUnavailableExecBlocked:
      "The source record is unavailable; no new execution can start until it is re-read and verified",
    isolatedParentSummary: "Not-applicable details",
    isolatedParentMeta: "Model A/B does not support isolated parents in this release",
    isolatedParentAvailable:
      "Available paths: use “Rerun here (isolated continuation)” on a tool call; start startup-prompt experiments from a verified root run.",
    cacheHitLabel: "Cache hits",
    cacheVerdictEffective: "Prefix cache effective; this call saved cost",
    cacheVerdictPartial: "Partial hits; most input is still billed at full price",
    cacheVerdictFull: "Full billing (no hits)",
    cacheAbnormalNote: "⚠️ Hits exceed total input; truncated to total input (abnormal data)",
    runDraftsTitle: "Drafts for this run ({{count}})",
    runDraftsEmpty: "No drafts for this run yet",
    sourceTechSummary: "Source and technical details",
    isoContinuationBranch:
      "Isolated continuation branch: {{boundary}}; every tool result from that turn appears once as part of the shared prefix.",
    isoContinuationBoundary:
      "Edit position <code>{{span}}</code> · end-of-turn boundary <code>{{boundary}}</code> (the turn number comes from the owning run's original agent.step.n and is not summed along the merged trace)",
    promptForkLine:
      "prompt fork (rerun from start): every span in this run comes from this full execution; the parent run {{parent}} is a lineage reference only — no shared prefix, and the parent trajectory is not merged into this timeline.",
    promptForkField: "Edited field: <code>{{field}}</code>",
    modelAbLine:
      "Model A/B arm (rerun from start): every span in this run comes from this full execution; the parent run {{parent}} is a reference only — no shared prefix.",
    modelAbArmLabel: "This arm: ",
    modelAbGroup:
      " · experiment group <code>{{id}}</code> (arms in the same batch share this label)",
    branchLine:
      "Branch run: the trajectory of <code>{{parent}}</code> up to fork point <code>{{span}}</code> is a shared prefix (from the parent run file; this run records only new spans).",
    chainTitleModelAb: "Fork chain (A/B arm · independent new trajectory from the start)",
    chainTitlePromptFork: "Fork chain (independent new trajectory from the start)",
    chainTitleProxy: "Fork chain (single-request edit and resend)",
    chainCurrent: "Current run",
    chainView: "View this run's detail",
    chainEditedMessages: "messages edited",
    sourceUnavailable: "Source record unavailable: ",
    sourceUnavailableUnreadable:
      "the run's source file could not be read on refresh, so the content below is the previously loaded result, ",
    sourceUnavailableMissing:
      "the run's record is no longer in the traces directory, so the content below is the previously loaded result, ",
    sourceUnavailableTail:
      "new executions that depend on it (rerun, prompt/messages edits, model experiments) are disabled.",
    sourceUnavailableRecover:
      "Recovered automatically after a successful re-read; you can also select another run in the list on the left.",
    reread: "Re-read",
    readingInvalidated: "Previous reading position unavailable: ",
    readingInvalidatedBody:
      "the previously recorded span or expanded item is no longer in the trace read this time (the record may have been rewritten or shrunk). Invalid references were cleared and the default position restored.",
    errorDetailMissing:
      "Error detail not recorded: this run ended with “error”, but it has no LLM call of its own that recorded a failure reason (a proxy-recorded failure, or a historical run older than error-detail recording).",
    errorDetailMissingBody:
      "The failure cause is not inferred here; error markers on the trace tree only reflect each span's own recorded error and do not indicate the cause of this termination.",
    lineageMissingAncestor: "Missing ancestor run: <code>{{runId}}</code>.",
    lineageOwnReadable:
      "This run's own output, steps, consumption, and termination facts remain readable; the shared prefix and ancestor increments are unknown — not zero-filled or inferred.",
    copyMissingRunAria: "Copy the missing ancestor run ID ({{runId}})",
    copyMissingRun: "Copy missing run ID",
  },
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
    draftNoBaseline:
      "The draft has no source baseline, so its source cannot be verified. To avoid executing from the wrong source, submission is blocked (copy the content or discard it explicitly).",
    draftDetailMissing:
      "The detail is missing or could not be read. The draft is kept; re-read it and pass verification before executing, or copy the content from the session drafts entry.",
    draftWrongRun:
      "The current detail does not belong to the draft's run, so the source cannot be verified.",
    draftTargetMissing:
      "The target call is no longer in the current detail (the source record is missing or was changed). The draft is kept for copying or discarding; another call is not substituted.",
    draftStatusChanged:
      "The run status changed ({{before}} when edited, {{now}} now); execution eligibility must be checked again.",
    draftLeafNowOwn:
      "The target call is now an own leaf of this run (it was not when edited); execution eligibility must be checked again.",
    draftLeafNoLongerOwn:
      "The target call is no longer an own leaf span of this run; execution eligibility is lost.",
    draftIsolationChanged:
      "The run's isolated-file metadata changed (isolated parents do not support prompt fork / Model A/B); execution eligibility must be checked again.",
    draftConfigChanged:
      "The source configuration fingerprint (config_hash) changed. The draft is kept for copying or discarding; verify the source again before executing.",
    draftTypeChanged:
      "The target call's type changed; the draft no longer maps to the current source record.",
    draftFieldMismatch: "The draft field does not match the target call's type.",
    draftResultChanged:
      "The source tool result changed. The draft is kept for copying or discarding; to use the new content, discard the old draft explicitly and edit again.",
    draftProxyChanged:
      "The run's recording source (proxy/engine) changed; messages resend eligibility must be checked again.",
    draftFirstCallChanged:
      "The current detail's first llm.call ({{first}}) does not match the draft target ({{target}}). The first call must not be skipped in favor of a later one; the draft is kept for copying or discarding.",
    draftStartupChanged:
      "The source content this edit depends on changed (startup context / model / parameters / tool table). The draft is kept for copying or discarding; the new baseline is not adopted silently.",
    draftMessagesChanged:
      "The source request messages changed. The draft is kept for copying or discarding; to use the new messages, discard the old draft explicitly and edit again.",
    sourceBlockedPrefix: "Source invalid; execution is blocked: ",
    copyDraftContent: "Copy draft content",
    discardDraftAction: "Discard draft",
    draftKeptNote:
      "The draft is kept until you discard it explicitly; execution eligibility returns automatically after re-verification passes.",
    listSeparator: ", ",
    unknownSeparator: "; ",
    promptNoSystem:
      "The first llm.call has no string system message, so RunConfig.systemPrompt cannot be rebuilt; prompt fork is unavailable.",
    promptNoUser:
      "The first llm.call has no string user message, so the initial user instruction cannot be edited.",
    promptUnchanged:
      "It is identical to the original value; edit it before submitting — an unchanged request is rejected as-is.",
    isoNoSystem:
      "The first llm.call has no string system message: the isolated experiment cannot rebuild the startup context, so neither system nor user editing is available (the original is never backfilled from config_hash, desktop settings, or an empty string).",
    isoNoUser:
      "The isolated experiment requires at least one string system and one string user startup message; the user message is missing, so neither edit is available.",
    isoUnchanged:
      "It is identical to the original value; edit it before checking — an unchanged isolated experiment is rejected as-is.",
    isoBranchEntry:
      "This run is an isolated branch: startup-prompt experiments can start only from the root run. Open the verified root explicitly, verify the initial input and files, and edit again; the branch's own messages are never used as the root startup context, and drafts are not moved automatically.",
    isoNotImportRoot:
      "This isolated run is not a root collected from a source directory (origin is not import), so it cannot be the baseline for a startup-prompt experiment; return to the root that collected this world.",
    isoNotSealed:
      "The run is not sealed yet (currently {{status}}): startup-prompt experiments require a sealed root record with a complete source; try again after the run ends.",
    isoNoConfigHash:
      "This root run recorded no config_hash: the original system and fixed tool table cannot be verified, so the startup-prompt experiment is unavailable.",
    isoNoLlmCall:
      "This root run's trace contains no llm.call: the startup context cannot be rebuilt from the real first request, so the startup-prompt experiment is unavailable.",
    isoFirstCallNotOwn:
      "The root run's first llm.call is not its own record (own-read is incomplete): it cannot serve as the startup context for this experiment.",
    isoEditStartPrompt: "Edit startup prompt",
    isoEditStartIntro:
      "Rerun from this root's initial files and startup prompt (real model calls; the parent, siblings, and source directory are not modified).",
    isoGotoRoot: "Go to the root run to view the startup prompt",
    isoVerifyingRoot: "Verifying the root…",
    promptEditSystemPlain: "Edit system prompt and rerun",
    promptEditSystemIsolated: "Edit system prompt (isolated experiment)",
    promptEditUserPlain: "Edit initial user message and rerun",
    promptEditUserIsolated: "Edit the first user message (isolated experiment)",
    promptUnavailableSystem:
      "The first llm.call has no string system message, so the run configuration cannot be rebuilt; prompt fork is unavailable.",
    isoIntro:
      "Isolated startup-prompt experiment: rerun from the root's initial files and startup prompt (real model calls; the parent, siblings, and source directory are not modified). Change only one field at a time.",
    promptIntro:
      "prompt fork: rerun from the start after editing the startup context (an independent new trajectory with no shared parent prefix). Change only one field at a time.",
    isoHeading: "Isolated prompt experiment · rerun from initial files and startup prompt",
    promptHeading: "prompt fork · rerun from start",
    fieldUserMessage: "First user message",
    isoRootLine: "Root run",
    isoStartCall: "Startup call",
    isoRootFixed:
      "The target is fixed to this root; use the tabs above to return to the original reading page — navigation is never automatic.",
    hypothesisLabel: "Hypothesis (optional, ≤4000 characters)",
    hypothesisPlaceholder:
      "For example: change the startup prompt to read the config first, expecting one more read_file call",
    criterionLabel: "Manual criterion (optional, ≤4000 characters)",
    criterionPlaceholder:
      "For example: the output must state the config value; I judge it manually, with no automatic scoring",
    discardPromptTitle: "Discard prompt draft · {{field}}",
    discardPromptMessage:
      "Discard the draft for “prompt fork · {{field}}”? (run {{runId}} · {{spanId}})\n\nCurrent draft content:\n{{content}}\n\nOnly this field is affected; the discard is checked against the revision at confirmation time — if the content is updated afterwards, this discard will not run.",
    discardPromptBannerTitle: "Discard prompt draft",
    discardPromptBannerMessage:
      "Discard this prompt draft ({{field}})? Its content will be deleted and cannot be recovered.",
    promptFrozenNote:
      "This submit is pending: the draft for this field is frozen at the submitted revision and cannot be edited or discarded until the request returns. The other field and other runs are unaffected; the draft is kept regardless of success, business rejection, or failure.",
    plainFieldSystemLabel: "System Prompt (startup system message)",
    plainFieldUserLabel: "First user message",
    confirmPromptTitle: "Review this rerun from the start",
    confirmPromptAccept: "Reviewed — confirm rerun from start",
    confirmPromptAccepted: "Rerun from start is confirmed",
    isoCheckRun: "Check this run (read-only)",
    isoCheckRerun: "Check this run again (read-only)",
    isoChecking: "Checking this run…",
    isoCheckNote:
      "Read-only precheck: no model calls, no file writes, no execution slot; the result is not an execution permit.",
    isoCheckBound:
      "The check is bound to draft revision #{{revision}} and the current settings snapshot; any change requires checking again.",
    isoCheckStale:
      "Input or run configuration changed: the previous check result, fee confirmation, and copy-write authorization are invalid. Check this run again.",
    isoCheckUnavailable: "Check failed ({{code}}): {{reason}}",
    isoVerifiedRootSuffix: " Verified root: {{rootId}} (open the root explicitly and check again.)",
    isoConfirmTitle: "Review this isolated experiment",
    isoConfirmAccept: "Reviewed — confirm real billing",
    isoConfirmAccepted: "Real billing is confirmed",
    feeNotConfirmed:
      "Confirm that this rerun from the start makes real model calls and incurs cost; fee confirmation is never restored from a draft.",
    sourceUnavailableCannotConfirm:
      "The source record is unavailable; confirmation is blocked until it is re-read and verified",
    isoUnknownNone: " Historical unrecorded conditions: none.",
    isoUnknownList: " Historical unknowns: {{list}}",
    isoWritesLabel:
      "Allow copy writes for this execution (only into this new copy's independent file world; the parent, siblings, and source directory are not modified). Authorization is off by default, valid only for this submit, and never restored from the parent trace's write_authorized marker.",
    isoSubmitReady:
      "Fee confirmation and this copy-write authorization are ready; submitting makes a real model call and writes into the independent file world.",
    isoSubmitButton: "Start the experiment (real call)",
    isoSubmitBusy: "Submitting…",
    discardFieldTitle: "Discard the draft for this field (confirmation required; only this field)",
    restoreOriginalValue: "Restore original",
    submitPrompt: "Confirm rerun from start",
    cardParamsMissing: "Default (the root's first request recorded no params)",
    cardParamsEmpty: "Explicit empty object {}",
    cardCostCap: " / cost cap {{value}}",
    cardBudgetRecorded: "recorded on the root",
    cardBudgetCurrent: "current configuration",
    cardBudgetValue: "{{tokens}} tokens ({{source}}){{cost}}",
    cardToolMissing: "(the root's first request recorded no tool table)",
    cardToolList: "{{tools}} (profile fixed by main)",
    cardSummary:
      "Rerun from the initial files of root {{rootId}} ({{files}} / {{bytes}}) and its startup prompt; real model calls are billed, while usage/price/cache are unknown before execution; copies are written only into the independent world.",
    cardFileCount: { one: "{{count}} file", other: "{{count}} files" },
    cardFilesValue: {
      one: "{{count}} file / {{bytes}} · snapshot {{snapshot}}",
      other: "{{count}} files / {{bytes}} · snapshot {{snapshot}}",
    },
    cardMessagesValue: {
      one: "{{count}} message ({{roles}})",
      other: "{{count}} messages ({{roles}})",
    },
    cardEditValue:
      "{{old}} characters → {{new}} characters (see the review grid above for the verbatim difference)",
    cardUnknownNone: "None",
    cardBillingValue:
      "Usage/unit price/cache are unknown before execution; after execution they are shown as recorded, and unknowns are not zero-filled",
    cardWritesValue:
      "Written only into this new copy's independent file world; the parent, siblings, and source directory are not modified",
    cardBilling:
      "Real model calls are billed; usage, unit price, and cache hits are unknown before execution and are shown as recorded afterwards.",
    cardRoot: "Root run",
    cardStartCall: "Startup call",
    cardInitialFiles: "Initial files",
    cardMessages: "Effective startup messages",
    cardTools: "Fixed tools",
    cardBaselineModel: "Baseline model (root's first request)",
    cardParams: "Root parameters",
    cardEndpoint: "Current endpoint",
    cardMaxIterations: "Execution limit",
    cardTokenBudget: "Token budget",
    cardEdit: "Edit",
    cardUnknowns: "Historical unknowns",
    cardBillingLabel: "Real billing",
    cardPlanFingerprint: "Plan fingerprint",
    cardWrites: "Copy writes",
    cardUnknownProvider:
      "The actual server backend/version was not recorded (a strict causal comparison cannot be claimed)",
    cardUnknownIterations:
      "The historical iteration limit was not recorded (the current limit is used)",
    cardUnknownBudget: "The historical token budget was not recorded (the current budget is used)",
    cardMaxIterationsValue: {
      one: "{{count}} iteration",
      other: "{{count}} iterations",
    },
    submitInProgress: "Submission in progress: it cannot be submitted again",
    submitGuardMissing: "This edit does not yet satisfy the isolated experiment conditions",
    submitNeedsCheck:
      "Check this run first (read-only precheck); input or configuration changes require checking again",
    submitCheckMismatch:
      "The check result does not match the current root/original/new value; check again",
    submitNeedsFee:
      "Confirm that this rerun from the start makes real model calls and incurs cost (fee confirmation is never restored from a draft)",
    submitNeedsWrites:
      "Check “Allow copy writes for this execution” — authorization is valid only for this submit and is never restored from the parent trace",
    messagesSourceUnavailable:
      "The source record is unavailable; no resend can start until it is re-read and verified",
    messagesSourceBlocked: "Source invalid; resend is blocked: {{reason}}",
    messagesProxyStopped:
      "The local recording proxy is not running, so there is no upstream to resend to (a key captured in this session does not allow resending while it is disabled)",
    messagesProxyChecking:
      "Checking the current proxy state… (resend is not allowed on a “possibly running” assumption before the latest facts are read)",
    messagesProxyUnknown:
      "The proxy state is unknown (not read yet or the read failed): resend is not allowed on a “possibly running” assumption",
    messagesNoKey:
      "No key was captured in this session: run your agent through the proxy once, then come back to resend",
    messagesEditEntry: "Edit messages and resend",
    messagesOpenWorkspace: "Open in the editing workspace",
    messagesInlineSummary:
      "Single-request fork · the source run is not modified · resend uses the most recently captured key",
    messagesEditHint:
      "Resend after editing any message: model / tool table / sampling parameters match the source run; only messages use the edited value.",
    messagesProxyCheckingLine:
      "Checking the current proxy state (listening and credentials)… resend is not allowed on old facts until this finishes.",
    messagesUnchanged:
      "It is identical to the original value; edit it before submitting — an unchanged resend is rejected as-is.",
    discardMessagesTitle: "Discard the messages resend draft",
    discardMessagesMessage:
      "Discard this messages resend draft? (run {{runId}} · {{spanId}})\n\nCurrent draft content:\n{{content}}\n\nThe discard is checked against the revision at confirmation time: if the content is updated afterwards, this discard will not run.",
    discardMessagesSimple:
      "Discard this messages resend draft? Its content will be deleted and cannot be recovered.",
    messagesProxyNoKeyHint: " (run your agent through the proxy once, then come back to resend)",
    messagesInvalidJson: "messages is not valid JSON: {{detail}}",
    messagesNotEmpty: "messages must be a non-empty array",
    messagesConfirmTitle: "Review this resend",
    messagesConfirmAccept: "Reviewed — confirm this resend",
    messagesConfirmAccepted: "This resend is confirmed",
    messagesRecordingEntry: "Open the recording workspace (enable the proxy / add credentials)",
    messagesRecordingReturnNote:
      "This edit draft and target are kept as-is after returning; the previous confirmation is not restored",
    messagesResending: "Resending… (a real LLM call; this may take a while)",
    messagesSubmit: "Confirm resend",
    messagesProxyStoppedShort: "The proxy is not running; enable it in settings first",
    messagesNoTarget:
      "No editing target is bound (targets are not kept across reloads; re-enter from “Edit messages and resend” on the proxy call).",
    messagesSourceFailed: "Failed to read the source detail: {{detail}}",
    messagesRetryRead: "Read-only retry",
    messagesReadingSource: "Reading the source detail…",
    messagesTargetMissing:
      "The target call was not found in the source detail ({{spanId}}): the detail content may have changed; the edit draft is kept, but the resend entry is unavailable.",
    messagesFrameCompact:
      "Single-request resend · no external tools · uses the key most recently captured in this session",
    messagesFrameDescription:
      "Edit one model request recorded by the proxy and resend it as a single real request (no external tools). The source run is not modified. The resend uses the proxy key captured in this session.",
    messagesSourceRun: "Source run",
    messagesCallLabel: "· call",
    messagesSourceRunIdLabel: "Source run ID",
    messagesResultsTitle: "Resend results",
    messagesResultsCount: { one: "{{count}} time", other: "{{count}} times" },
    messagesResultsEmpty:
      "No resend submitted yet: after you confirm a resend, its results appear here.",
    messagesRetryReadTitle: "Re-read only the same trusted run ID ({{runId}}): nothing is rerun",
    messagesViewFailureTitle: "Locate only a failed call owned by this run",
    messagesOpenResultTitle: "Open the overview by trusted run ID",
    messagesReturnDraft: "Back to editing",
    messagesResultsNoteTitle: "About results",
    messagesResultsNote:
      "Results are shown only by the registered identity of this submit: failures and unknowns keep the edited input, no passive recording is used to fill in results, and the source trace is not rewritten.",
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
  verification: {
    checkpointInitial: "Initial checkpoint",
    checkpointStep: "Step checkpoint {{stepSpanId}}",
    entryOpen: "Project verification",
    entryClose: "Collapse project verification",
    entryTitle:
      "Verify this checkpoint's project in a restricted container: environment preparation and fixed checks are confirmed separately",
    entryDisabledTitle:
      "Normal/proxy runs have no isolated file world (no verifiable checkpoint input); verification supports isolated runs only",
    entryNotIsolated:
      "Only isolated runs can be verified (normal/proxy runs have no checkpoint input)",
    panelHeading: "Verifying “{{checkpoint}}” · run {{runId}}",
    panelReadonlyNote:
      "Opening the panel performs only two read-only checks (capability/source/environment aggregate + fixed plan preview): zero downloads, zero containers, zero executions, zero model calls.",
    conditionCapability: "Check result",
    conditionCapabilityFailed:
      "Read failed (see the reason below) — conditions are unknown and are not shown as available",
    conditionCapabilityPending: "Not available yet (checking or not started)",
    fieldExactInput: "Exact input",
    sourceNotReady: "Source preflight failed (see the reason below)",
    sourceSnapshot: {
      one: "Snapshot {{snapshotId}} · {{count}} file · {{totalBytes}}",
      other: "Snapshot {{snapshotId}} · {{count}} files · {{totalBytes}}",
    },
    fieldPrepared: "Prepared environment",
    preparedMissing: "Not prepared yet (complete environment preparation first)",
    preparedSummary:
      "{{preparationId}} · image {{imageDigest}} · Node {{node}} / TS {{typescript}}",
    fieldBackend: "Local backend",
    backendEngine: "Docker engine {{version}}",
    backendUnavailable: "Unavailable: {{reason}}",
    backendVersionUnknown: "(version unknown)",
    reasonMissing: "no reason provided",
    fieldPlanToken: "Current plan token",
    fieldProfile: "Profile",
    profileSummary:
      "{{profileId}} · manifest v{{manifestVersion}} · {{platform}} · supported source glob {{sourceIncludeGlob}}",
    fieldPreparePlan: "Preparation plan",
    planPreviewFailed: "Preview read failed (see the reason below)",
    planPending: "Not available yet (read-only preview)",
    planSummary: {
      one: "{{count}} fixed download · estimated {{space}} · see the confirmation card for the network and script policy",
      other:
        "{{count}} fixed downloads · estimated {{space}} · see the confirmation card for the network and script policy",
    },
    capabilityCheckFailed: "Capability check failed ({{code}}): {{detail}}",
    retryCapability: "Check again (read-only)",
    planReadFailed: "Preparation plan read failed ({{code}}): {{detail}}",
    retryPlan: "Read again (read-only)",
    checkingReadonly: "Checking (read-only)…",
    blockerEngine:
      "The local restricted backend is unavailable: {{reason}}. Install or start Docker Desktop (Linux containers) and retry; the app never installs it automatically and never falls back to the host shell.",
    blockerSource:
      "The verification input is not valid: {{reason}} (a fixed check can only run from a completed checkpoint owned by a valid isolated run; switch to a run/step with a file world, or fix that run's source integrity first)",
    blockerPrepareMissing:
      "The environment is not prepared: finish “Environment preparation” below (one-time) and wait for it to succeed before running a fixed check. Preparation and execution are confirmed separately.",
    blockerLine: "{{reason}} ({{code}})",
    confirmMissing: "Not confirmed: review this target and its boundaries, then confirm explicitly",
    confirmStaleTarget:
      "The verification target changed: the old confirmation is bound to another checkpoint; review and confirm again",
    confirmStalePlanUnknown:
      "The current plan is unknown (the check result is missing or stale): the old confirmation cannot be reused; check again",
    confirmStalePlanChanged:
      "The plan changed (plan/strategy/recipe drift): the old confirmation is invalid; review the current plan and confirm again",
    confirmStaleCommand:
      "The fixed check command changed: the old confirmation is bound to another command; confirm again",
    limitsLine: {
      one: "CPU {{count}} core · Memory {{memory}} · PIDs {{pids}} · {{commandSeconds}} s per command · {{totalSeconds}} s total",
      other:
        "CPU {{count}} cores · Memory {{memory}} · PIDs {{pids}} · {{commandSeconds}} s per command · {{totalSeconds}} s total",
    },
    fieldTargetRun: "Target run",
    fieldCheckpoint: "Checkpoint (explicitly selected)",
    prepareSummary:
      "One-time environment preparation · network downloads from fixed sources during preparation only · does not run project tests",
    planMissing: "Plan not available yet (opening the panel checks automatically)",
    planProfile: "Profile {{profileId}} · manifest v{{manifestVersion}}",
    fieldDownload: "Download source {{index}}",
    downloadLine: "{{source}} · approx. {{size}} · {{license}}",
    fieldDiskEstimate: "Estimated disk usage",
    fieldLocalBackend: "Local backend",
    backendNotChecked: "Not checked yet",
    fieldAuthorization: "Authorization for this run",
    authorizationPrepare:
      "Confirming grants only this one environment preparation (allowPrepare), not test execution",
    planNote: "Plan original text: {{note}}",
    limitPrepareSeparate:
      "Preparation and tests are confirmed separately: this only builds the environment, materializes no code, and runs no checks; execution requires its own review and confirmation.",
    limitPrepareBinding:
      "Confirmation is bound to the current plan: any plan/strategy/recipe change invalidates the old confirmation and requires a new review; a new plan is never submitted automatically.",
    checkCapabilityReadonly:
      "Read-only check `verification:capability`: zero downloads, zero containers, zero executions, zero model calls",
    checkPlanReadonly:
      "Read-only plan preview `verification:preparePlan`: shows only the fixed plan and installs nothing",
    prepareBlockTitle: "Verify environment preparation",
    prepareConfirm: "Reviewed — confirm environment preparation",
    prepareConfirmed: "Preparation confirmed (bound to the current plan)",
    prepareSubmitting: "Preparing the environment…",
    prepareSubmit: "Start environment preparation",
    prepareSubmitHint:
      "Submittable only when confirmed ∧ the engine is available; an expired confirmation or a plan change disables the button until you review and confirm again.",
    commandLabel: "Fixed check command",
    runBlockTitle: "Verify fixed-check execution",
    runConfirm: "Reviewed — confirm the check execution",
    runConfirmed: "Execution confirmed (bound to the current plan and command)",
    runSubmitting: "Running the check…",
    runSubmit: "Run the fixed check",
    runSubmitHint:
      "Requires the environment to be prepared ∧ the source to be available ∧ this execution confirmation to be valid; switching the command invalidates the old confirmation.",
    runSummary:
      "Run fixed check {{commandId}} · restricted offline container · results come only from exit codes and trusted test reports",
    fieldCommand: "Fixed command",
    commandValue:
      "{{commandId}} (executable/argv/cwd are frozen by the manifest; custom commands, paths, or environment variables are not accepted)",
    runSourceMissing:
      "Source preflight failed (see the reason below): there is no verifiable input",
    fieldExecutionEnv: "Execution environment",
    envMissing: "Not prepared yet (complete environment preparation and wait for success)",
    envPrepared: "Prepared {{preparationId}} · image {{imageDigest}}",
    fieldToolchain: "Toolchain",
    toolchainUnknown: "Unknown (depends on the preparation result)",
    toolchainValue: "Runtime Node {{node}} · TypeScript {{typescript}}",
    fieldLimits: "Resource limits",
    fieldIsolationBaseline: "Isolation baseline",
    isolationBaseline:
      "non-root ({{runAsUser}}) · read-only rootfs · cap-drop ALL · no-new-privileges · offline ({{networkMode}})",
    authorizationRun:
      "Confirming grants only this one execution (allowExecution); a prepared environment is not consent to execute",
    limitEvidence:
      "Results come only from real exit codes and trusted test reports (exact TAP count match): Agent text and log content cannot replace test facts.",
    limitTrustedTests:
      "Tests come from the trusted tests and runner in the fixed environment at /opt/r3: the project's editable test files and npm scripts are not read; changing source to fake a fix is rejected by the collection gate.",
    limitPermits:
      "Preparation and execution permits do not replace each other: execution still requires this explicit confirmation; the confirmation is bound to the current plan and target, expires on change, and is never resubmitted automatically.",
    limitContainer:
      "Execution runs in a restricted container: offline, non-root, read-only rootfs; output and time overruns are stopped and recorded truthfully as the corresponding outcome.",
    submitFailedSummary: "The submission did not run ({{code}}).",
    submitRawDetail: "Raw detail:",
    recordKindPrepare: "Environment preparation",
    recordKindRun: "Project verification ({{commandId}})",
    recordKindUnknown: "Unknown type",
    recordRunning: "Running",
    recordSettled: "Settled ({{outcome}})",
    recordNotAccepted: "Not accepted ({{rejection}})",
    recordUnknownOutcome: "unknown outcome",
    recordUnknownRejection: "unknown reason",
    outcomePassed: "Passed (all fixed checks passed)",
    outcomeCheckFailed: "Check failed (assertion failure/non-zero exit — not a request failure)",
    outcomeEnvironmentFailed: "Environment/process fault (not a project assertion failure)",
    outcomeStopped: "Timed out/over limit/stopped (all stops must be confirmed first)",
    outcomeArtifactInvalid:
      "Invalid artifact (including source edits posing as a fix — changing code is not a fix)",
    outcomeEvidenceIncomplete: "Incomplete evidence (cannot be a green pass)",
    outcomeUnknown: "Unknown (stop unconfirmed or engine disconnected)",
    outcomeUnrecognized: "Unrecognized outcome",
    activePrepare:
      "Preparing the environment: the preparation phase cannot be interrupted (the build is shown as-is; no targeted stop is offered); wait for it to finish.",
    activeRun:
      "Running the fixed check: you can request a targeted stop for this operation (it only affects the controlled resources of this execution).",
    stopRequest: "Request stop",
    stopRequested: "Stop requested (waiting for confirmation)",
    stopHint:
      "The domain ID comes only from the operation registry; repeated clicks are safe (idempotent); the slot stays occupied until all stops are confirmed.",
    stopRequestedNote:
      "The stop signal has reached the orchestrator: the outcome (cancelled/unknown) appears only after all workloads are confirmed stopped and finalized; until then the operation stays occupied and is not shown as finished.",
    stopNoticeLabel: "Stop result (returned by main):",
    stopFailed: "The stop did not run ({{code}}): {{detail}}",
    operationsUnknown:
      "Operation state unknown (the state channel is unreachable or returned invalid data): check the state from the operation entry above first; until a valid snapshot is confirmed, this panel shows no “running/finished” guess and offers no stop.",
    recordsTitle:
      "Verification operations for this checkpoint (from the operation registry; restored from registrations after reload, never guessed)",
    recordsVerifyLabel: "Verification {{ids}}",
    recordsPrepareLabel: "Preparation {{ids}}",
    readingTitle:
      "Verification records and logs (read-only for the trusted identities below; reading executes nothing, writes nothing, and cleans nothing)",
    readingPick:
      "Select a verification identity to view its record and logs (identities come from registered attachments and execution responses, never from time or logs).",
    readingLoading: "Reading the verification record (read-only)…",
    recordReadFailed: "Record read failed ({{code}}): {{detail}}",
    recordEvents: { one: "{{count}} event", other: "{{count}} events" },
    recordStages: "stages: {{stages}}",
    recordOutcome: "Outcome: {{outcome}} ({{label}}). {{detail}}",
    evidenceComplete: "complete",
    evidenceIncomplete: "incomplete",
    evidenceUnknown: "unknown",
    recordNotSealed:
      "The record is unsealed or corrupt: no outcome is shown (unfinished facts are never presented as pass/fail).",
    commandEndLine: "{{commandId}} · {{exit}} · {{duration}}",
    commandExit: "exit code {{exitCode}}",
    commandExitUnknown: "exit code (unknown)",
    commandDuration: "{{durationMs}}ms",
    commandStdout: "stdout kept {{bytes}}{{extra}}",
    commandStderr: "stderr kept {{bytes}}{{extra}}",
    commandStreamExtra:
      " ({{totalBytes}} observed in total; the excess was dropped under the limit and counted)",
    readStdout: "Read stdout",
    readStderr: "Read stderr",
    logSliceHint: "bounded slice (default 32 KiB per page, max 64 KiB)",
    noCommandFacts:
      "The record has no command-execution facts (it may not have reached the execution phase or was interrupted).",
    logLoadingSuffix: " · reading…",
    logReadFailed: "Log read failed ({{code}}): {{detail}}",
    logAssetCorrupt: " (attachment corrupt: corrupt bytes are not presented as text)",
    logAssetMissing: " (attachment missing: it is not rewritten automatically)",
    logAria: "Verification log slice (bounded, read-only; focusable and scrollable)",
    logMeta: "Total {{total}} · read {{read}}",
    logRemaining: " · {{remaining}} remaining",
    logTruncated: " · this slice is truncated",
    logContinue: "Continue to next page",
    logEnd:
      "Reached the end of the retained record (dropped bytes beyond the limit are counted in the observed totals above)",
    logNotComplete:
      "The above is a bounded slice view, not the complete log (P13: a truncated view must not be presented as the complete log).",
    outcomePrepareRequestDone:
      "Request completion: environment preparation returned explicitly (the operation is settled).",
    outcomePrepareFacts:
      "Domain facts: preparation record {{preparationId}} · image {{imageDigest}}. Execution conditions were refreshed by the re-check.",
    outcomeRunRequestDone:
      "Request completion: the execution request returned explicitly (the operation is settled; this is not a request-layer failure).",
    outcomeTestOutcome: "Test outcome: {{outcome}} ({{label}}).",
    outcomeEvidence: "Evidence completeness: {{status}}. {{detail}}",
    outcomeEvidenceIncompleteLong:
      "incomplete (truncated or missing required logs/reports — cannot count as a green pass)",
    outcomeIdentity:
      "Verification identity {{verificationId}} (only this trusted record is reread; no guessing from time or logs).",
    statusSealed: "Sealed (terminal facts can no longer be appended)",
    statusUnterminated:
      "Unsealed (no termination event yet: no outcome is shown; it may still be running or was interrupted)",
    statusCorrupt: "Corrupt ({{detail}}) — not a pass or a failure",
    statusCorruptBadTail: "bad tail",
    statusCorruptDetail: "line {{line}}: {{reason}}",
    statusUnsupported: "Unsupported version (an unknown record version was rejected)",
    cmpProfile: "Profile",
    cmpManifestVersion: "manifest version",
    cmpPlanBinding: "Plan binding digest (plan × strategy × recipe)",
    cmpCommand: "Check command",
    cmpExecutable: "executable + argv",
    cmpCwd: "Working directory",
    cmpPlatform: "Platform",
    cmpImageDigest: "Actual image digest",
    cmpToolchain: "Runtime versions",
    cmpLimits: "Resource limits",
    cmpSecurity: "Isolation baseline",
    cmpCpu: { one: "CPU {{count}} core", other: "CPU {{count}} cores" },
    cmpMemory: "Memory {{memory}}{{tmpfs}}",
    cmpTmpfs: " (tmpfs counts toward memory)",
    cmpPids: "PIDs {{pids}}",
    cmpCommandTimeout: "command timeout {{ms}}ms",
    cmpTotalTimeout: "total timeout {{ms}}ms",
    cmpStdoutRetained: "stdout kept {{bytes}}",
    cmpStderrRetained: "stderr kept {{bytes}}",
    cmpTotalOutput: "total output limit {{bytes}}",
    cmpArtifact: "artifacts {{bytes}}",
    secRunAsUser: "non-root {{runAsUser}}",
    secReadOnlyRoot: "read-only root",
    secWritableRoot: "writable root",
    secCapDropAll: "cap drop all",
    secKeepCaps: "capabilities kept",
    secNoNewPrivileges: "no-new-privileges",
    secAllowPrivilege: "privilege escalation allowed",
    secNetwork: "network {{mode}}",
    secSupervisor: "container init: supervisor PID 1",
    secNoSupervisor: "no supervisor",
    cmpInterventionNoRun:
      "The source run is not in the current list: fork intervention unknown (not guessed)",
    cmpInterventionRoot:
      "No recorded fork (root run; manual file edits cannot be confirmed from records)",
    cmpInterventionParentUnknown: "parent run unknown",
    cmpInterventionParent: "parent {{runId}}",
    cmpInterventionExperiment: ", experiment {{experimentId}}",
    cmpInterventionRecorded: "Recorded fork: edit {{field}} @ {{span}} ({{parent}}{{experiment}})",
    cmpLimitAgentText:
      "Agent text does not enter conditions or conclusions; this area only reads verification records and run fork metadata.",
    cmpLimitNoAutoFix:
      "R3 never starts a model repair automatically; whether an intervention holds is determined by the run's recorded fork metadata.",
    cmpLimitSourceUnverified:
      "At least one side's source trace is missing or its snapshot does not match the record: no claim is made that the fix branch or code causality was verified.",
    cmpLimitSourceMissing:
      "At least one side's source run trace is missing: code differences cannot be checked locally (the verification records remain readable).",
    cmpLimitEnvironmentMissing:
      "At least one record did not store the environment identity (actual image/toolchain/limits): those conditions are treated as unknown and are not filled in from the current manifest.",
    cmpLimitMetaMissing:
      "At least one record header is unreadable (corrupt/unsupported version): conditions and code identity are unknown.",
    cmpLimitPlanBinding:
      "Tests/runner/lockfile/template identity are anchored by the plan binding digest (same digest = same recipe; those details are not expanded separately).",
    cmpLimitEnvVars:
      "Public environment variables: the product injects none (no --env on the command line); the container image is anchored by the actual imageDigest.",
    cmpVerdictOutcomeUnknown:
      "At least one record is unsealed/unreadable: no comparison conclusion is formed (unfinished facts are not presented as results).",
    cmpVerdictAssetsUnverifiable:
      "At least one side's required current assets cannot be verified: no checkable fix conclusion is formed (historical outcomes are not rewritten).",
    cmpVerdictEvidenceIncomplete:
      "At least one side's evidence is incomplete: no fix conclusion is formed (missing items cannot be filled in with model text).",
    cmpVerdictConditionsDiffer: "Conditions differ: this is not a same-condition failed → passed.",
    cmpVerdictConditionsUnknown:
      "Conditions are unknown (records lack fields): this is not a same-condition failed → passed.",
    cmpVerdictFailedToPassed:
      "Same conditions failed → passed: this only means the fixed check changed from check_failed to passed under the same recorded conditions on both sides; it does not claim complete correctness or causality.",
    cmpVerdictSameOther:
      "Conditions match, but the outcome is not failed → passed (actual: {{left}} / {{right}}); only the actual check results are stated.",
    compareSectionTitle:
      "Fix evidence comparison (A original / B fix) — read-only records; no automatic preparation or execution",
    compareClear: "Clear comparison",
    compareSideA: "A · Original",
    compareSideB: "B · Fix",
    compareSelfTitle: "A verification cannot be compared with itself",
    compareSourceLabel: "Source: ",
    comparePickBoth:
      "Explicitly select two verifications for A/B (never auto-pick the “latest”); records are read only when both sides are selected.",
    compareLoading: "Reading both verification records (read-only)…",
    compareReadFailed: "Comparison read failed ({{code}}): {{detail}}",
    compareRetry: "Retry read-only",
    compareDifferences: "Differences: {{list}}",
    compareUnknowns: "Unknowns: {{list}}",
    compareRunUnknown: "source run unknown",
    compareCheckpointUnknown: "checkpoint unknown",
    compareCommandUnknown: "command unknown",
    compareSideSummary: "{{side}} · {{verificationId}}",
    compareSideSource: "Source: {{runId}} · {{checkpoint}} · {{status}}",
    compareRunUnknownShort: "(unknown)",
    compareSnapshot: "Code snapshot: {{snapshotId}}",
    compareIntervention: "Intervention: {{intervention}}",
    compareOutcome: "Outcome: {{outcome}}{{label}}",
    compareOutcomeLabel: " ({{label}})",
    compareEvidence: "evidence {{status}}",
    compareExit: "exit code {{exit}} · {{duration}}",
    compareUnknownShort: "unknown",
    compareLogs:
      "Logs kept stdout {{stdout}} / stderr {{stderr}} (observed total {{stdoutTotal}} / {{stderrTotal}})",
    compareNoCommandFacts: "(no command facts)",
    compareCodeSame: "Code difference: {{status}}",
    codeSameYes: "both snapshots match",
    codeSameNo: "snapshots differ",
    codeSameUnknown: "unknown",
    compareOpenDiff: "View code differences in run comparison",
    compareNoDiffSameRun: "Both sides come from the same run (no cross-run code difference)",
    compareNoDiffMissingRun: "Source run missing: code differences cannot be checked",
    compareConditionsTitle:
      "Conditions (recorded facts only; unknown is not filled in from the current manifest)",
    compareConditionLine: "{{label}}: {{left}} vs {{right}}",
    compareConditionUnrecorded: "(not recorded)",
    compareStateSame: "same",
    compareStateDifferent: "different",
    compareStateUnknown: "unknown",
    sourceStatusPresent: "Source present",
    sourceStatusMissing: "Source missing (record still readable)",
    sourceStatusUnknown: "Source status unknown",
    exportTitle:
      "Export the tested input (R2.1) — file snapshot; no logs/material packages, and not a test pass",
    exportBinding: "Binding: {{runId}} · {{checkpoint}} · snapshot {{snapshotId}}",
    exportStart: "Choose an empty directory and export the exact input",
    exportSealedHint:
      "Choose the target through the native dialog (must be empty); main rechecks the record/source/snapshot ID before exporting.",
    exportBlocked:
      "The record is unsealed: export is not offered (unfinished records are not bound as input).",
    exportInFlight:
      "Exporting this verification's exact input… switching checkpoints/comparison sides or leaving the page does not change the binding; main keeps writing.",
    exportCanceled: "Directory selection canceled: nothing was written.",
    exportFailed: "Export failed ({{code}}): {{reason}}",
    exportRetained: "Target leftovers (cleanup incomplete; not a complete export): {{list}}",
    exportExported: {
      one: "Exported {{count}} file ({{bytes}}) to {{dir}}",
      other: "Exported {{count}} files ({{bytes}}) to {{dir}}",
    },
    exportSnapshotCompare:
      "Verification snapshot {{expected}} · exported snapshot {{actual}} · {{match}}",
    exportSnapshotMatch: "match (bound before writing)",
    exportSnapshotMismatch: "mismatch (unexpected; trust the manifest)",
    exportPatch: "Patch: {{patch}}",
    exportPatchWritten: "changes.patch ({{bytes}} bytes)",
    exportPatchNone: "no text changes",
    exportPatchUnavailable: "unavailable ({{reason}})",
    exportPatchUnavailableNoReason: "unavailable",
    exportRecheck:
      "Recheck: compare source.snapshot_id and files[] hashes in rebaseagent-export.json at the target root.",
    exportNotPass:
      "A file export ≠ a test pass; it is the tested input snapshot, contains no logs/material packages, and does not apply patches.",
  },
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
    createRunFailed:
      "The run was not created; check the run list for any created record before retrying.",
    sourceChooseFailed:
      "Could not choose the source directory. Try again or pick another directory.",
  },
  mcp: {},
  cli: {},
} satisfies ResourceShape;
