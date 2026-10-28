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
  },
  run: {},
  detail: {},
  fork: {},
  experiment: {},
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
