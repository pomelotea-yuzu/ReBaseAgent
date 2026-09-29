import type { NotAcceptedReason, OperationRecord, RequestOutcome } from "@shared/operations";
import { LINEAGE_INCOMPLETE_TEXT } from "./detail-completeness";
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

const NOT_ACCEPTED_TEXT: Record<NotAcceptedReason, string> = {
  busy: "执行槽被占：本次没有开始执行，也不消耗任何许可",
  closing: "主进程正在退出协商：本次未被接受",
  configuration_busy: "配置变更在飞：本次未被接受",
  reconcile_tombstone: "该操作已由核对封禁：迟到请求不会复活它",
};

const DRAFT_GONE_NOTE =
  "该提交的草稿已按修订清理或从未登记：不返回、不复活旧内容（需要旧输入请在草稿列表里复制）";

/** 单条运行的呈现：未读 / 在读 / 不可读 / 已核实（含失败定位可用性与来源警告） */
function itemViewOf(runId: string, entry: ResultReadEntry | undefined): ResultItemView {
  if (entry === undefined) {
    return {
      runId,
      label: "结果待读取",
      tone: "neutral",
      detail: "还没有按这个可信运行 ID 读过；打开即读一次，不会重新执行",
      actions: ["open-result"],
      failureNote: null,
      sourceWarning: null,
    };
  }
  if (entry.phase === "reading") {
    return {
      runId,
      label: "正在读取结果",
      tone: "neutral",
      detail: "只读通道在飞（不重发执行、不改当前阅读现场）",
      actions: [],
      failureNote: null,
      sourceWarning: null,
    };
  }
  if (entry.phase === "unreadable") {
    return {
      runId,
      label: "结果不可读",
      tone: "warn",
      detail: entry.reason,
      // 只按**同一个** runId 重试读取：没有"换个 id 试试"这条路
      actions: ["retry-read"],
      failureNote: "结局读不出来时不做失败定位（不拿别的记录凑原因）",
      sourceWarning: null,
    };
  }
  const facts = entry.facts;
  const failureSpanId = facts?.failure.llmCallSpanId ?? null;
  // U6 任务 4.6：来源警告只来自经核实的 lineage，不从 chain 长度或结局倒推
  const lineage = entry.lineage;
  const sourceWarning =
    lineage?.status === "incomplete"
      ? `${LINEAGE_INCOMPLETE_TEXT}（缺失祖先 run：${lineage.missingRunId}）——只核实了本运行自有记录；正常结束不等于可以重跑`
      : null;
  return {
    runId,
    label: facts?.outcome.label ?? "结局未知",
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
          ? "以错误终止，但本次自有记录里没有失败的模型调用详情（不取祖先调用冒充原因）"
          : "本次不是以错误终止，没有失败调用可定位"
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
export function buildOperationResultViews(input: {
  records: readonly OperationRecord[];
  reads: ResultReadStore;
  draftPresentOf: (record: OperationRecord) => boolean;
}): Readonly<Record<string, OperationResultView>> {
  const out: Record<string, OperationResultView> = {};
  for (const record of input.records) {
    out[resultViewKeyOf(record)] = deriveOperationResultView({
      record,
      reads: input.reads,
      draftPresent: input.draftPresentOf(record),
    });
  }
  return out;
}

/**
 * 由登记记录 + 读取项 + 草稿在场情况派生面板一行的呈现。
 *
 * `draftPresent` 来自"提交关联/收尾关联里的目标键，其草稿是否还在"，
 * **不是**"这次操作成没成功"——草稿被正常结束清理后就不该再有返回入口。
 */
export function deriveOperationResultView(input: {
  record: OperationRecord;
  reads: ResultReadStore;
  draftPresent: boolean;
}): OperationResultView {
  const view = viewOperationResult(input.record, input.reads);
  const canReturnDraft = input.draftPresent;
  const draftNote = input.draftPresent ? null : DRAFT_GONE_NOTE;
  switch (view.kind) {
    case "running":
      return {
        kind: "running",
        label: "执行中",
        detail: "草稿保持冻结；不显示进度、阶段或百分比（主进程没有这些事实）",
        items: [],
        canReturnDraft,
        draftNote,
      };
    case "not-accepted":
      return {
        kind: "not-accepted",
        label: "本次未接受",
        detail:
          view.rejection === null
            ? "未被接受（主进程未给出稳定原因）"
            : NOT_ACCEPTED_TEXT[view.rejection],
        items: [],
        canReturnDraft,
        draftNote,
      };
    case "unlocated":
      return {
        kind: "unlocated",
        label: "结果未定位",
        detail: "登记里没有可信运行 ID：只能核对登记，不按列表最新项或错误文案猜一个结果",
        items: [],
        canReturnDraft,
        draftNote,
      };
    case "results":
      return {
        kind: "items",
        label: view.items.length > 1 ? `${view.items.length} 条结果` : "结果",
        detail: null,
        items: view.items.map((item) => itemViewOf(item.runId, item.entry)),
        canReturnDraft,
        draftNote,
      };
  }
}

// ---------------------------------------------------------------------------
// 任务 5.1a：请求事实（信封侧）单独一行——与运行结局分层，互不覆盖
// ---------------------------------------------------------------------------

const REQUEST_OUTCOME_LABEL: Record<RequestOutcome, string> = {
  returned: "返回",
  failed: "请求异常",
  rejected: "业务拒绝",
};

/**
 * settled 才有请求事实可陈述（running / notAccepted ⇒ null：前者没有结局，
 * 后者的"没有执行"说法由 notAccepted 自己的拒绝文案承担，二者不叠加）。
 */
export function requestFactsLineOf(record: OperationRecord): string | null {
  if (record.state !== "settled" || record.requestOutcome === null) return null;
  const code = record.errorCode === null ? "" : `（稳定码 ${record.errorCode}）`;
  switch (record.requestOutcome) {
    case "returned":
      return record.target?.kind === "modelAb"
        ? `请求事实：主进程按「返回」收口${code}——A/B 的返回可含失败臂，不宣告任何一条运行正常完成`
        : `请求事实：主进程按「返回」收口${code}——各运行的结局只看自有终止事件`;
    case "failed":
      return `请求事实：${REQUEST_OUTCOME_LABEL.failed}${code}——失败信封不影响按可信 ID 打开与核实已登记的运行`;
    case "rejected":
      return `请求事实：${REQUEST_OUTCOME_LABEL.rejected}${code}——拒绝是编排时的分类，不一律等于零模型调用；是否发生过调用看自有终止事实`;
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

const ARM_OUTCOME_TEXT: Record<RequestOutcome, string> = {
  returned: "请求层：该臂返回",
  failed: "请求层：该臂失败",
  rejected: "请求层：该臂被拒绝",
};

function abArmViewOf(
  index: number,
  record: OperationRecord,
  reads: ResultReadStore,
): AbArmResultView {
  const arm = record.arms.find((one) => one.index === index);
  if (arm === undefined || arm.id === null) {
    return {
      index,
      runId: null,
      armOutcome: arm?.outcome ?? null,
      item: null,
      note:
        record.state === "running"
          ? `臂 ${index + 1}：尚无登记的可信运行 ID（执行中，未观察到不代表失败，也不提前给结果入口）`
          : `臂 ${index + 1}：main 未登记可信运行 ID（缺臂 / 未开始）——不生成结果链接，不从信封多报的 id 或邻近记录凑一个`,
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
    ),
    note: null,
  };
}

/**
 * A/B 批次呈现的唯一派生口。`record` 为 null = 提交身份已知但登记快照还没到场
 * （刚提交 / 通信未知）——这时**什么结论都不说**，只留等待事实。
 */
export function deriveAbBatchResult(input: {
  operationId: string;
  record: OperationRecord | null;
  reads: ResultReadStore;
}): AbBatchResultView {
  const { record } = input;
  if (record === null) {
    return {
      operationId: input.operationId,
      epoch: null,
      statusLabel: "等待登记快照",
      statusDetail:
        "本次执行的提交身份已确定，但主进程登记快照尚未到场：不预告结局，可在「操作」入口核对状态",
      requestLine: null,
      experimentId: null,
      arms: [],
    };
  }
  const armCount = record.target?.kind === "modelAb" ? record.target.armCount : record.arms.length;
  const arms =
    record.state === "notAccepted"
      ? []
      : Array.from({ length: armCount }, (_, i) => abArmViewOf(i, record, input.reads));
  switch (record.state) {
    case "running":
      return {
        operationId: record.operationId,
        epoch: record.epoch,
        statusLabel: "执行中",
        statusDetail: "整批按登记逐臂呈现；不显示进度、阶段或百分比（主进程没有这些事实）",
        requestLine: null,
        experimentId: record.experimentId,
        arms,
      };
    case "notAccepted":
      return {
        operationId: record.operationId,
        epoch: record.epoch,
        statusLabel: "本次未接受",
        statusDetail: "整批没有开始执行，也不消耗任何许可；不存在可读的实验结果",
        requestLine: null,
        experimentId: null,
        arms,
      };
    case "settled":
      return {
        operationId: record.operationId,
        epoch: record.epoch,
        statusLabel: "已收口",
        statusDetail: "逐臂状态按登记身份与独立核实呈现：收口不等于全部成功，缺臂与失败臂原样保留",
        requestLine: requestFactsLineOf(record),
        experimentId: record.experimentId,
        arms,
      };
  }
}
