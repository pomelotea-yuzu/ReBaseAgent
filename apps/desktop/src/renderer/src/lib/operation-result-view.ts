import type { NotAcceptedReason, OperationRecord } from "@shared/operations";
import type { ResultReadEntry, ResultReadStore } from "./result-verification";
import { viewOperationResult } from "./result-verification";

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

/** 单条运行的呈现：未读 / 在读 / 不可读 / 已核实（含失败定位可用性） */
function itemViewOf(runId: string, entry: ResultReadEntry | undefined): ResultItemView {
  if (entry === undefined) {
    return {
      runId,
      label: "结果待读取",
      tone: "neutral",
      detail: "还没有按这个可信运行 ID 读过；打开即读一次，不会重新执行",
      actions: ["open-result"],
      failureNote: null,
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
    };
  }
  const facts = entry.facts;
  const failureSpanId = facts?.failure.llmCallSpanId ?? null;
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
