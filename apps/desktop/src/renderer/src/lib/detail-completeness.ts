import type { RunDetail } from "@shared/ipc";

/**
 * U6（add-partial-run-reading）任务 4.1–4.3：详情完整性在**展示层**的纯判据。
 *
 * 为什么单独成文件：本包没有 jsdom，且 `DetailNotices` 各块全部读 store
 * （zustand v5 在静态渲染下走 `getServerSnapshot`，喂不进状态）⇒
 * 「ownOnly 该显示什么」必须抽成纯函数，才能在没有 DOM 的用例里钉住文案与分型。
 * 渲染层（`DetailNotices` / `OverviewPanel`）只消费这里的结论，不另写一套判断。
 *
 * 三条不许含糊的纪律（对应 delta「部分普通分支不伪造共享前缀」「部分来源链首项
 * 不冒充根」「父文件恢复后重试全量重验」）：
 *
 * 1. **固定提示 + 缺失 ID 是最低展示义务**：ownOnly 时界面必须出现
 *    「仅显示本运行记录，父链不完整」和缺失祖先 run ID——措辞唯一来源是
 *    `LINEAGE_INCOMPLETE_TEXT`，各处拼接不得改写（改写 = 口径分叉）。
 * 2. **own 不是降级、ownOnly 不是执行资格**：本模块只产出**展示**事实，
 *    执行资格（§5 的 main 来源门禁）与清理判据（U5 终止事实）一概不看这里。
 * 3. **沿链指标未知不补零**：ownOnly 的共享前缀 / 祖先增量 / 共同祖先一概
 *    「未知」，不显示 0、不推算、不把 chain 断点两侧拼成完整轨迹。
 */

/** 固定提示（唯一文案来源；delta 场景原文） */
export const LINEAGE_INCOMPLETE_TEXT = "仅显示本运行记录，父链不完整";

/** ownOnly 沿链指标的固定口径说明（概览消耗区/来源区共用） */
export const LINEAGE_METRICS_UNKNOWN_TEXT = "父链不完整：沿链祖先的指标未知，不补零、不推算。";

/** ownOnly 时来源区/详情提示区的完整展示事实 */
export interface LineageIncompleteView {
  /** 恒为 true（调用方据此渲染；类型上收窄便于排他分支） */
  readonly incomplete: true;
  /** 固定提示（`LINEAGE_INCOMPLETE_TEXT`，不改写） */
  readonly text: string;
  /** 缺失祖先 run id（载荷受校验：非空且不在 chain 内） */
  readonly missingRunId: string;
  /** 缺失 ID 的一行说明（供来源区/通知区直接展示） */
  readonly missingNote: string;
  /**
   * 来源链是否在缺失点截断（ownOnly 首项 parent 必等于 missingRunId ≠ null
   * ⇒ **首项恒不是根**；此字段保留为显式判据，供来源链列表标注「截断链」，
   * 防止将来 integrity 放宽时这里静默跟着错）。
   */
  readonly chainTruncated: boolean;
}

/**
 * ownOnly 详情的展示事实；complete ⇒ null（调用方不渲染任何不完整提示）。
 *
 * ⚠️ 判 `completeness` 而不是从 chain 长度猜完整性（design D1：renderer
 *    不自行推断）；`lineage.status` 与 completeness 不一致时按「不可信载荷」
 *    返回 null 交由上层 schema 兜底——本函数**绝不**把 ownOnly 误判成 complete。
 */
export function lineageIncompleteViewOf(detail: RunDetail): LineageIncompleteView | null {
  if (detail.completeness !== "ownOnly") return null;
  if (detail.lineage.status !== "incomplete") return null;
  const first = detail.chain[0];
  const chainTruncated = !(first !== undefined && first.meta.parent === null);
  return {
    incomplete: true,
    text: LINEAGE_INCOMPLETE_TEXT,
    missingRunId: detail.lineage.missingRunId,
    missingNote: `缺失的祖先运行：${detail.lineage.missingRunId}`,
    chainTruncated,
  };
}

/**
 * ownOnly 分支 run 的提示文案（`BranchNotice` 的 ownOnly 分流）。
 *
 * result / 隔离续跑分支在 ownOnly 下**不得**再声称「共享前缀」（父前缀根本
 * 没进时间线）；独立分支（prompt / 代理 / model_params）本来就只显示自有轨迹，
 * 但父文件缺失这一事实仍要如实标注。分叉点与被编辑字段的标注**保留**——
 * 那是记录里的真实元数据，不因祖先缺失而消失。
 *
 * @returns null = 非 ownOnly（调用方走既有完整分支文案，本函数不参与）
 */
export function ownOnlyBranchNoticeOf(detail: RunDetail): string | null {
  const view = lineageIncompleteViewOf(detail);
  if (view === null) return null;
  const fork = detail.meta.fork;
  const lines: string[] = [`${view.text}（缺失祖先 run：${view.missingRunId}）。`];
  if (fork !== null) {
    lines.push(
      `编辑字段：${fork.edit.field} · 分叉点 ${fork.at_span}（标注保留；父前缀未并入时间线）。`,
    );
  }
  return lines.join("\n");
}

/**
 * 来源链列表的标题（`ParentChainList` 消费）。
 *
 * ownOnly ⇒ 明确标为**截断链**：链首项 parent = missingRunId ≠ null，
 * 「最早可读 hop」不等于根 run，不得绘制一条虚假的根到叶连接
 * （delta「部分来源链首项不冒充根」）。complete ⇒ null（调用方用既有标题）。
 */
export function truncatedChainTitleOf(detail: RunDetail): string | null {
  const view = lineageIncompleteViewOf(detail);
  if (view === null) return null;
  return view.chainTruncated
    ? "分叉链（截断：父链不完整，首项不是根 run）"
    : "分叉链（父链不完整）";
}
