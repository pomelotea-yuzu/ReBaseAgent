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
    liveSeparator: "; ",
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
