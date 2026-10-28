import type { MessageKey, Translator } from "@rebaseagent/i18n";
import type { NotAcceptedReason, OperationRecord, RequestOutcome } from "@shared/operations";
import { outcomeLabelOf } from "@shared/outcome";
import { lineageIncompleteText } from "./detail-completeness";
import type { ResultReadEntry, ResultReadStore } from "./result-verification";
import { resultReadOf, viewOperationResult } from "./result-verification";

/**
 * U5（unify-run-execution-workflow）任务 3.5：**操作面板的结果呈现与明确动作**。
 *
 * design D6 末段 + delta「失败定位和返回草稿明确可达」「核对结果只由用户明确打开」的落点。
 * 3.1–3.4 已经把"读到了什么"放进 `resultReads`、把"要不要自动跳"放进导航意图；本模块只管
 * **用户主动点开时能给哪些动作**，以及拿不出事实时**该说什么诚实话**：
 *
 * 1. **动作按可用性给，不猜**：可信 runId 在场才给「打开结果」；只有**本 run 自有**的失败调用
 *    （`facts.failure.llmCallSpanId`，由 `leafSpanIds` 界定）才给「查看失败调用」；
 *    草稿还在才给「返回草稿」。不给的每一种都配一句说明——尤其是
 *    "以 error 终止但自有记录里没有失败调用"与"本次不是 error 终止"这两种，
 *    它们最容易被写成"那就跳祖先的最后一个错误调用"，那是 spec 明令禁止的冒充。
 * 2. **不可读只重试同一记录**：读取失败不给"打开"，给"按同一 runId 重读"（与 1.3 同口径）。
 * 3. **未定位没有链接**：settled 但 `runIds` 为空 ⇒ 只说"核对登记"，不生成伪结果入口。
 * 4. **展示口径复用既有派生**（`classifyOutcome` / `viewOperationResult`），这里不重写第二份判据；
 *    清理判据（严格 `stopped`+`completed`）**不**用于展示，两者刻意不同。
 *
 * 任务 5.1 在本文件追加两族呈现（同一纪律：只报 main / 核实通道给得出的事实）：
 * - `requestFactsLineOf`：**请求事实与运行结局分层**——信封侧结局（returned/failed/rejected +
 *   稳定码）单独一行，不与逐条运行结局互相覆盖；`rejected` 是编排分类，
 *   **不一律称为"零调用未执行"**（design D4，那说法只属于 notAccepted / 本地未发送）。
 * - `deriveAbBatchResult`：A/B 批次结果区改**逐臂读取状态 + 可信 ID 动作**，
 *   集合基准是登记 `target.armCount`（不是信封 `ids`）；缺臂 / null ID 只给诚实说明，
 *   不从邻近记录或信封多报的 id 里凑。
 */

/** 面板上可点的动作（全部由用户主动触发；没有任何"自动跳转"混在这里） */
export type ResultAction = "open-result" | "view-failure" | "retry-read" | "return-draft";

/** 一条可信运行 id 的呈现 */
export interface ResultItemView {
  readonly runId: string;
  /** 短标签：结果待读取 / 正在读取结果 / 正常结束 / 执行出错 / 结果不可读 …… */
  readonly label: string;
  readonly tone: "neutral" | "success" | "danger" | "warn";
  /** 人话补充（失败原因、不可读诊断）；null = 无 */
  readonly detail: string | null;
  readonly actions: readonly ResultAction[];
  /** 拿不到失败调用入口时的诚实说明（与 `view-failure` 互斥） */
  readonly failureNote: string | null;
  /**
   * U6 任务 4.6：来源完整性警告（ownOnly 时非 null）。
   * 与运行结局**分层**呈现——"自有 stopped/completed"与"父链不完整"同时成立，
   * 且"正常结束"绝不暗示可重跑（执行资格由 §5 的 main 来源门禁决定，不由这里声明）。
   */
  readonly sourceWarning: string | null;
}

/** 整条操作的结果呈现 */
export interface OperationResultView {
  /**
   * `running` / `not-accepted` / `unlocated` = 记录级事实（没有逐条结果可列）；
   * `items` = settled 且有可信 runId。
   */
  readonly kind: "running" | "not-accepted" | "unlocated" | "items";
  readonly label: string;
  readonly detail: string | null;
  readonly items: readonly ResultItemView[];
  /** 「返回草稿」是**记录级**动作（草稿按提交目标存，不逐臂重复给） */
  readonly canReturnDraft: boolean;
  /** 草稿已清理 / 从未登记时的回退说明（不复活旧内容与旧授权） */
  readonly draftNote: string | null;
}

const NOT_ACCEPTED_KEYS: Record<NotAcceptedReason, MessageKey> = {
  busy: "run.notAcceptedBusy",
  closing: "run.notAcceptedClosing",
  configuration_busy: "run.notAcceptedConfigurationBusy",
  reconcile_tombstone: "run.notAcceptedTombstone",
};

/** 单条运行的呈现：未读 / 在读 / 不可读 / 已核实（含失败定位可用性与来源警告） */
function itemViewOf(
  runId: string,
  entry: ResultReadEntry | undefined,
  translator: Translator,
): ResultItemView {
  if (entry === undefined) {
    return {
      runId,
      label: translator.t("run.resultUnread"),
      tone: "neutral",
      detail: translator.t("run.resultNotReadDetail"),
      actions: ["open-result"],
      failureNote: null,
      sourceWarning: null,
    };
  }
  if (entry.phase === "reading") {
    return {
      runId,
      label: translator.t("run.resultReading"),
      tone: "neutral",
      detail: translator.t("run.resultReadingDetail"),
      actions: [],
      failureNote: null,
      sourceWarning: null,
    };
  }
  if (entry.phase === "unreadable") {
    return {
      runId,
      label: translator.t("run.unreadable"),
      tone: "warn",
      detail: entry.reason,
      // 只按**同一个** runId 重试读取：没有"换个 id 试试"这条路
      actions: ["retry-read"],
      failureNote: translator.t("run.resultUnreadableFailureNote"),
      sourceWarning: null,
    };
  }
  const facts = entry.facts;
  const failureSpanId = facts?.failure.llmCallSpanId ?? null;
  // U6 任务 4.6：来源警告只来自经核实的 lineage，不从 chain 长度或结局倒推
  const lineage = entry.lineage;
  const sourceWarning =
    lineage?.status === "incomplete"
      ? translator.t("run.sourceIncompleteWarning", {
          text: lineageIncompleteText(translator),
          missingRunId: lineage.missingRunId,
        })
      : null;
  return {
    runId,
    label:
      facts === null
        ? translator.t("run.outcomeUnknown")
        : outcomeLabelOf(facts.outcome.kind, translator),
    tone: facts?.outcome.tone ?? "neutral",
    detail: facts?.failure.message ?? null,
    actions: [
      "open-result",
      ...(failureSpanId === null
        ? []
        : (["view-failure"] as const satisfies readonly ResultAction[])),
    ],
    failureNote:
      failureSpanId === null
        ? facts?.failure.missingDetail === true
          ? translator.t("run.resultMissingFailureDetail")
          : translator.t("run.resultNotErrorFailureNote")
        : null,
    sourceWarning,
  };
}

/** 面板一行的定位键（与 `lib/operation-list` 的 `OperationRow.key` 同编码，两处不各造一份） */
export function resultViewKeyOf(record: OperationRecord): string {
  return `${record.epoch}/${record.operationId}`;
}

/**
 * 批量派生（供操作面板一次渲染用）。
 *
 * `draftPresentOf` 由调用方注入（store 的 `isOperationDraftPresent`）——本模块不 import store，
 * 才能在没有 DOM 的包里逐条单测。
 */
export function buildOperationResultViews(
  input: {
    records: readonly OperationRecord[];
    reads: ResultReadStore;
    draftPresentOf: (record: OperationRecord) => boolean;
  },
  translator: Translator,
): Readonly<Record<string, OperationResultView>> {
  const out: Record<string, OperationResultView> = {};
  for (const record of input.records) {
    out[resultViewKeyOf(record)] = deriveOperationResultView(
      {
        record,
        reads: input.reads,
        draftPresent: input.draftPresentOf(record),
      },
      translator,
    );
  }
  return out;
}

/**
 * 由登记记录 + 读取项 + 草稿在场情况派生面板一行的呈现。
 *
 * `draftPresent` 来自"提交关联/收尾关联里的目标键，其草稿是否还在"，
 * **不是**"这次操作成没成功"——草稿被正常结束清理后就不该再有返回入口。
 */
export function deriveOperationResultView(
  input: {
    record: OperationRecord;
    reads: ResultReadStore;
    draftPresent: boolean;
  },
  translator: Translator,
): OperationResultView {
  const view = viewOperationResult(input.record, input.reads);
  const canReturnDraft = input.draftPresent;
  const draftNote = input.draftPresent ? null : translator.t("run.draftGoneNote");
  switch (view.kind) {
    case "running":
      return {
        kind: "running",
        label: translator.t("run.operationRunning"),
        detail: translator.t("run.runningNoProgress"),
        items: [],
        canReturnDraft,
        draftNote,
      };
    case "not-accepted":
      return {
        kind: "not-accepted",
        label: translator.t("run.operationNotAccepted"),
        detail:
          view.rejection === null
            ? translator.t("run.notAcceptedUnknownReason")
            : translator.t(NOT_ACCEPTED_KEYS[view.rejection]),
        items: [],
        canReturnDraft,
        draftNote,
      };
    case "unlocated":
      return {
        kind: "unlocated",
        label: translator.t("run.resultUnlocated"),
        detail: translator.t("run.unlocatedDetail"),
        items: [],
        canReturnDraft,
        draftNote,
      };
    case "results":
      return {
        kind: "items",
        label:
          view.items.length > 1
            ? translator.t("run.resultsCount", { count: view.items.length })
            : translator.t("run.resultSingle"),
        detail: null,
        items: view.items.map((item) => itemViewOf(item.runId, item.entry, translator)),
        canReturnDraft,
        draftNote,
      };
  }
}

// ---------------------------------------------------------------------------
// 任务 5.1a：请求事实（信封侧）单独一行——与运行结局分层，互不覆盖
// ---------------------------------------------------------------------------

/**
 * settled 才有请求事实可陈述（running / notAccepted ⇒ null：前者没有结局，
 * 后者的"没有执行"说法由 notAccepted 自己的拒绝文案承担，二者不叠加）。
 */
export function requestFactsLineOf(record: OperationRecord, translator: Translator): string | null {
  if (record.state !== "settled" || record.requestOutcome === null) return null;
  const code =
    record.errorCode === null
      ? ""
      : translator.t("run.requestStableCode", { code: record.errorCode });
  switch (record.requestOutcome) {
    case "returned":
      return record.target?.kind === "modelAb"
        ? translator.t("run.requestReturnedAb", { code })
        : translator.t("run.requestReturned", { code });
    case "failed":
      return translator.t("run.requestFailed", { code });
    case "rejected":
      return translator.t("run.requestRejected", { code });
  }
}

// ---------------------------------------------------------------------------
// 任务 5.1b：A/B 批次结果的逐臂呈现（集合基准 = 登记 target.armCount，不是信封 ids）
// ---------------------------------------------------------------------------

export interface AbArmResultView {
  readonly index: number;
  /** 登记的可信运行 id；null = main 未观察到该臂身份（未开始 / 缺臂），不造链接 */
  readonly runId: string | null;
  /** 该臂的请求层结局；null = main 尚未观察到 */
  readonly armOutcome: RequestOutcome | null;
  /** 有可信 id 时的逐条呈现（与单运行同一 itemViewOf）；无 id ⇒ null */
  readonly item: ResultItemView | null;
  /** 无可信 id / 未观察时的诚实说明 */
  readonly note: string | null;
}

export interface AbBatchResultView {
  readonly operationId: string;
  /** 所属 main 会话；登记快照未在场（提交在飞 / 快照未落地）⇒ null，一切动作都不给 */
  readonly epoch: string | null;
  /** 记录级状态行：执行中 / 已收口 / 本次未接受 / 等待登记快照 */
  readonly statusLabel: string;
  readonly statusDetail: string;
  /** 信封侧请求事实（与下方逐臂运行结局分层呈现） */
  readonly requestLine: string | null;
  readonly experimentId: string | null;
  readonly arms: readonly AbArmResultView[];
}

function abArmViewOf(
  index: number,
  record: OperationRecord,
  reads: ResultReadStore,
  translator: Translator,
): AbArmResultView {
  const arm = record.arms.find((one) => one.index === index);
  if (arm === undefined || arm.id === null) {
    return {
      index,
      runId: null,
      armOutcome: arm?.outcome ?? null,
      item: null,
      note: translator.t(
        record.state === "running" ? "run.abArmNoIdRunning" : "run.abArmNoIdSettled",
        { index: index + 1 },
      ),
    };
  }
  return {
    index,
    runId: arm.id,
    armOutcome: arm.outcome,
    item: itemViewOf(
      arm.id,
      resultReadOf(reads, {
        epoch: record.epoch,
        operationId: record.operationId,
        runId: arm.id,
      }),
      translator,
    ),
    note: null,
  };
}

/**
 * A/B 批次呈现的唯一派生口。`record` 为 null = 提交身份已知但登记快照还没到场
 * （刚提交 / 通信未知）——这时**什么结论都不说**，只留等待事实。
 */
export function deriveAbBatchResult(
  input: {
    operationId: string;
    record: OperationRecord | null;
    reads: ResultReadStore;
  },
  translator: Translator,
): AbBatchResultView {
  const { record } = input;
  if (record === null) {
    return {
      operationId: input.operationId,
      epoch: null,
      statusLabel: translator.t("run.abStatusWaiting"),
      statusDetail: translator.t("run.abStatusWaitingDetail"),
      requestLine: null,
      experimentId: null,
      arms: [],
    };
  }
  const armCount = record.target?.kind === "modelAb" ? record.target.armCount : record.arms.length;
  const arms =
    record.state === "notAccepted"
      ? []
      : Array.from({ length: armCount }, (_, i) => abArmViewOf(i, record, input.reads, translator));
  switch (record.state) {
    case "running":
      return {
        operationId: record.operationId,
        epoch: record.epoch,
        statusLabel: translator.t("run.abStatusRunning"),
        statusDetail: translator.t("run.abStatusRunningDetail"),
        requestLine: null,
        experimentId: record.experimentId,
        arms,
      };
    case "notAccepted":
      return {
        operationId: record.operationId,
        epoch: record.epoch,
        statusLabel: translator.t("run.abStatusNotAccepted"),
        statusDetail: translator.t("run.abStatusNotAcceptedDetail"),
        requestLine: null,
        experimentId: null,
        arms,
      };
    case "settled":
      return {
        operationId: record.operationId,
        epoch: record.epoch,
        statusLabel: translator.t("run.abStatusSettled"),
        statusDetail: translator.t("run.abStatusSettledDetail"),
        requestLine: requestFactsLineOf(record, translator),
        experimentId: record.experimentId,
        arms,
      };
  }
}
