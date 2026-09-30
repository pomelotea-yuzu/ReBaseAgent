import { deriveVerifiedComparison } from "@shared/compare-derive";
import type { CompareRunItem } from "@shared/ipc";
import { taskSummary } from "@shared/nav";
import { classifyOutcome } from "@shared/outcome";
import type { OutcomeTone } from "@shared/outcome";
import { deriveOwnConsumption } from "@shared/overview";
import type { OwnConsumption } from "@shared/overview";
import { formatDuration, formatTokens } from "./format";

/**
 * U7（improve-branch-comparison）任务 5.2：宽幅指标表的**纯派生**。
 *
 * 判据来源（branch-tree delta MODIFIED「多分支对照到 run 级指标与共同祖先」）：
 * - 指标对照 SHALL 使用**宽幅表格**，固定可见的名称列 + 带任务摘要、稳定唯一短 ID、
 *   模型与状态的运行标题；三或四条通过表内横滚保留完整名称，**不挤入固定窄侧栏**；
 * - 两至四条的共同祖先与累计结论 SHALL 来自**当前已校验比较读取**（`runs:compare`
 *   的 chainSummaries ⇒ `deriveVerifiedComparison`），不能以旧列表缓存覆盖 ownOnly
 *   或读取失败——因此本模块的输入是 `CompareConclusion`（verified）的 items，
 *   **不是** `runs` 列表；
 * - 共同祖先三态（有 / 无且链完整 / 判定不完整）不得混说；判定不完整不算增量差；
 * - 提示按实际对象数量表述；对照不产出运行之间的互差、胜出或最佳结论。
 *
 * 与旧 `ComparePanel`（w-64 窄侧栏 + 列表缓存 `deriveComparison`）的本质差别：
 * 身份与指标全部取自本次已校验详情/链摘要；不可读侧如实呈现受控原因，
 * 不借列表数据补齐、不悄悄换一个对象。
 */

/** 指标表的一列（= 选择集里的一条 run） */
export interface MetricsColumn {
  readonly runId: string;
  /** 会话稳定短 ID（容器从 ShortIdState 现算后传入；完整 ID 复制在组件层） */
  readonly shortId: string;
  /** 以下标题事实仅 ready 侧有（来自已校验详情/链摘要）；unavailable 侧为 null */
  readonly task: string | null;
  readonly model: string | null;
  readonly statusLabel: string | null;
  readonly statusTone: OutcomeTone | null;
  /** unavailable 侧的受控原因（含稳定码） */
  readonly unavailableReason: string | null;
}

/** 指标表的一行：名称 + 与列等长的值（null = 该侧不可得，显示 —） */
export interface MetricsRow {
  readonly label: string;
  readonly values: readonly (string | null)[];
  /** 单元格悬停/辅助解释（与列等长；缺省 = 无解释） */
  readonly titles?: readonly (string | undefined)[];
}

export interface MetricsTableModel {
  /** empty = 选择集为空（组件给引导）；table = 至少一条 */
  readonly kind: "empty" | "table";
  /** 数量提示（单条「再选一条即可对照」/ 空集引导）；null = 无提示 */
  readonly hint: string | null;
  readonly columns: readonly MetricsColumn[];
  readonly rows: readonly MetricsRow[];
  /** 共同祖先三态；null = 可读侧不足两条（不判定、不冒充） */
  readonly relation: {
    readonly ancestorId: string | null;
    readonly incomplete: boolean;
    readonly note: string;
  } | null;
  /** 口径说明（恒定文案，钉住"只呈现事实与相对祖先增量"的限制） */
  readonly scopeNote: string;
}

const EMPTY_MODEL: MetricsTableModel = {
  kind: "empty",
  hint: "在分支树勾选节点加入对照（最多四条）；两条及以上可进入指标对照与详细比较。",
  columns: [],
  rows: [],
  relation: null,
  scopeNote: "",
};

/**
 * 从本次已校验比较结论派生宽幅指标表。
 *
 * `items` 传 verified 结论的 items（无结论 / 请求级拒绝时传 null ⇒ empty，
 * 由组件展示"正在读取 / 读取失败"状态）。`shortIds` 供身份列显示。
 */
export function deriveCompareMetricsTable(input: {
  items: readonly CompareRunItem[] | null;
  shortIds: ReadonlyMap<string, string>;
}): MetricsTableModel {
  if (input.items === null || input.items.length === 0) return EMPTY_MODEL;

  const items = input.items;
  const shortIdOf = (runId: string): string => input.shortIds.get(runId) ?? runId;

  const columns: MetricsColumn[] = items.map((item) => {
    if (item.status === "unavailable") {
      return {
        runId: item.runId,
        shortId: shortIdOf(item.runId),
        task: null,
        model: null,
        statusLabel: null,
        statusTone: null,
        unavailableReason: `${item.reason}（${item.code}）`,
      };
    }
    // 标题事实取自本次已校验链摘要的最后一项（= 该 run 自身），不用列表缓存
    const own = item.chainSummaries[item.chainSummaries.length - 1] ?? null;
    const outcome =
      own !== null ? classifyOutcome({ status: own.status, reason: own.reason }) : null;
    return {
      runId: item.runId,
      shortId: shortIdOf(item.runId),
      task: own !== null && own.task !== "" ? taskSummary(own.task) : null,
      model: own !== null && own.model !== "" ? own.model : null,
      statusLabel: outcome?.label ?? null,
      statusTone: outcome?.tone ?? null,
      unavailableReason: null,
    };
  });

  // 关系与累计只对「可读侧 ≥ 2」判定；单条不判定共同祖先（对照不足两条场景）
  const readyItems = items.filter(
    (item): item is Extract<CompareRunItem, { status: "ready" }> => item.status === "ready",
  );
  const verified =
    readyItems.length >= 2
      ? deriveVerifiedComparison(
          readyItems.map((item) => ({ runId: item.runId, chainSummaries: item.chainSummaries })),
        )
      : null;

  const relation: MetricsTableModel["relation"] =
    verified === null
      ? null
      : verified.relation.kind === "common"
        ? {
            ancestorId: verified.relation.ancestorId,
            incomplete: false,
            note: `共同祖先：${verified.relation.ancestorId}`,
          }
        : verified.relation.kind === "unrelated"
          ? {
              ancestorId: null,
              incomplete: false,
              note: "共同祖先：无（分属不同根）——两条链都完整走到根且无公共祖先，没有可比基线",
            }
          : {
              ancestorId: null,
              incomplete: true,
              note:
                "共同祖先：判定不完整（存在父缺失）——链上有 run 的父 run 不在数据目录，" +
                "无法确认更深的共同祖先；不是「本来就不同源」，祖先增量不计算",
            };

  // 5.2/5.4：行 = 身份与结局（状态/终止原因/创建时间/分叉点/实验组）+
  // 自有消耗（仅 leaf spans）+ 沿链累计与相对祖先增量（沿链求和口径，单列标注）。
  const ownOf = (index: number) => {
    const item = items[index];
    if (item === undefined || item.status !== "ready") return null;
    return item.chainSummaries[item.chainSummaries.length - 1] ?? null;
  };

  // 5.4：自有消耗由每侧 detail 的 leafSpanIds 派生（复用概览同一派生，不重抄）；
  // unavailable 侧无 detail ⇒ null。
  const consumptionOf = (index: number): OwnConsumption | null => {
    const item = items[index];
    if (item === undefined || item.status !== "ready") return null;
    return deriveOwnConsumption({ spans: item.detail.spans, leafSpanIds: item.detail.leafSpanIds });
  };

  // 5.4：沿链累计 / 相对祖先增量（verified 侧序 = ready 侧序，按 runId 对位）
  const sideOf = (runId: string) =>
    verified?.sides.find((side) => side.runId === runId) ?? null;
  const totalsOf = (index: number) => sideOf(items[index]?.runId ?? "")?.totals ?? null;
  const deltaOf = (index: number) => sideOf(items[index]?.runId ?? "")?.deltaFromAncestor ?? null;

  /** 祖先增量不可得时的逐列解释（按三态与该侧累计可得性区分，不冒充 0） */
  const deltaUnavailableNote = (index: number): string | undefined => {
    if (items[index]?.status !== "ready") return undefined;
    if (verified === null) return "可读侧不足两条：不判定共同祖先，不计算祖先增量";
    if (verified.relation.kind === "incomplete") {
      return "共同祖先判定不完整（存在父缺失）：祖先增量不计算";
    }
    if (verified.relation.kind === "unrelated") {
      return "无共同祖先（分属不同根）：没有可比基线，祖先增量不计算";
    }
    if (totalsOf(index) === null) return "该侧沿链累计不可得（链上有段未知）：祖先增量不计算";
    return undefined;
  };

  const rows: MetricsRow[] = [
    {
      label: "状态",
      values: columns.map((column) => column.statusLabel),
      titles: columns.map((column) =>
        column.unavailableReason === null ? undefined : "该运行不可读：无已校验状态",
      ),
    },
    {
      label: "终止原因",
      values: columns.map((column, index) => {
        const own = ownOf(index);
        return own === null ? null : (own.reason ?? "—");
      }),
      titles: columns.map((column, index) => {
        const own = ownOf(index);
        return own !== null && own.reason === null ? "记录里没有终止事件，— 表示无原值" : undefined;
      }),
    },
    {
      label: "创建时间",
      values: columns.map((_column, index) => ownOf(index)?.created_at ?? null),
    },
    {
      label: "分叉点",
      values: columns.map((_column, index) => ownOf(index)?.fork?.at_span ?? null),
      titles: columns.map(() => "分叉编辑发生的 span id；根 run 无分叉点"),
    },
    {
      label: "实验组",
      values: columns.map((_column, index) => ownOf(index)?.fork?.experiment_id ?? null),
      titles: columns.map(() => "同一批模型实验的臂共享一个 experimentId；无标签如实显示 —"),
    },
    {
      label: "本 run 步数",
      values: columns.map((_column, index) => {
        const own = ownOf(index);
        return own === null ? null : String(own.steps);
      }),
    },
    {
      label: "工具 / 出错",
      values: columns.map((_column, index) => {
        const own = ownOf(index);
        return own === null ? null : `${own.toolCalls} / ${own.toolErrors}`;
      }),
      titles: columns.map(() => "工具调用次数 / 其中出错次数"),
    },
    // ---- 5.4：自有消耗（leaf spans；未知不补零）----
    {
      label: "自有 tokens（输入）",
      values: columns.map((_column, index) => {
        const consumption = consumptionOf(index);
        return consumption === null ? null : formatTokens(consumption.tokensIn);
      }),
      titles: columns.map((_column, index) => {
        const consumption = consumptionOf(index);
        return consumption === null
          ? undefined
          : "仅本运行自有调用（leaf spans）的已记录值；祖先共享前缀不计入，缺失不补零";
      }),
    },
    {
      label: "自有 tokens（输出）",
      values: columns.map((_column, index) => {
        const consumption = consumptionOf(index);
        return consumption === null ? null : formatTokens(consumption.tokensOut);
      }),
    },
    {
      label: "自有 tokens（合计）",
      values: columns.map((_column, index) => {
        const consumption = consumptionOf(index);
        return consumption === null
          ? null
          : formatTokens(consumption.tokensIn + consumption.tokensOut);
      }),
      titles: columns.map((_column, index) => {
        const consumption = consumptionOf(index);
        // 失败调用的占位零用量不称实际零消费（5.5 同源判据，随行先行）
        return consumption !== null &&
          consumption.tokensIn === 0 &&
          consumption.tokensOut === 0
          ? "记录用量为 0——可能是失败调用的占位值，不据此断言实际零消费"
          : undefined;
      }),
    },
    {
      label: "自有已记录耗时",
      values: columns.map((_column, index) => {
        const consumption = consumptionOf(index);
        // null（未知）交给组件层显示 —；不在派生层用字符串冒充值
        return consumption === null || consumption.durationMs === null
          ? null
          : formatDuration(consumption.durationMs);
      }),
      titles: columns.map((_column, index) => {
        const consumption = consumptionOf(index);
        return consumption !== null && consumption.durationMs === null
          ? "自有 spans 无已记录时间跨度：保持未知，不补 0"
          : undefined;
      }),
    },
    // ---- 5.4：沿链累计（各代自有值沿链求和；禁称总耗时/总成本）----
    {
      label: "累计增量（步数）",
      values: columns.map((_column, index) => {
        const totals = totalsOf(index);
        return totals === null ? null : String(totals.steps);
      }),
      titles: columns.map(() => "沿 parent 链对各代自有值求和"),
    },
    {
      label: "累计增量（tokens）",
      values: columns.map((_column, index) => {
        const totals = totalsOf(index);
        return totals === null ? null : formatTokens(totals.tokens);
      }),
      titles: columns.map(() => "沿 parent 链对各代自有值求和；不等于从头连续跑一次的消耗"),
    },
    {
      label: "累计增量（耗时）",
      values: columns.map((_column, index) => {
        const totals = totalsOf(index);
        return totals === null || totals.durationMs === null ? null : formatDuration(totals.durationMs);
      }),
      titles: columns.map(() => "各段已记录耗时之和（任一段未知即整体未知）；禁称「总耗时」"),
    },
    // ---- 5.4：相对共同祖先增量（= 该侧累计 − 祖先累计；不是左右臂相减）----
    {
      label: "相对祖先增量（tokens）",
      values: columns.map((_column, index) => {
        const delta = deltaOf(index);
        return delta === null ? null : formatTokens(delta.tokens);
      }),
      titles: columns.map((_column, index) =>
        deltaOf(index) === null
          ? deltaUnavailableNote(index)
          : "该侧沿链累计 − 共同祖先沿链累计（同口径相减）；不是左右两侧互差",
      ),
    },
    {
      label: "相对祖先增量（耗时）",
      values: columns.map((_column, index) => {
        const delta = deltaOf(index);
        return delta === null || delta.durationMs === null ? null : formatDuration(delta.durationMs);
      }),
      titles: columns.map((_column, index) =>
        deltaOf(index)?.durationMs === null
          ? "祖先段耗时未知：增量保持未知，不补 0"
          : deltaOf(index) === null
            ? deltaUnavailableNote(index)
            : "该侧沿链累计 − 共同祖先沿链累计（同口径相减）",
      ),
    },
  ];

  const hint =
    items.length === 1
      ? "再选一条即可对照（最多四条）。"
      : items.length >= 3
        ? "已选三条及以上：可在表内显式选择两条进入详细比较。"
        : null;

  return {
    kind: "table",
    hint,
    columns,
    rows,
    relation,
    scopeNote:
      "指标来自本次已校验比较读取（不可读侧如实呈现原因，不用列表缓存补齐）；" +
      "自有值仅统计本运行自有调用（leaf spans）；沿链累计为各代自有值沿链求和" +
      "（prompt / messages / model_params 为独立执行，各代自有值照记、不当作共享前缀），" +
      "禁称「总耗时 / 总成本」；相对祖先增量 = 该侧累计 − 祖先累计（同口径相减，不是左右臂相减）。" +
      "对照只呈现各运行事实与其相对共同祖先的增量，不产出运行之间的互差、胜出或最佳结论。",
  };
}
