import type { MetricsRow, MetricsTableModel } from "../lib/compare-metrics";
import { ShortIdLabel } from "./ShortIdLabel";

/**
 * U7 任务 5.2：宽幅指标表（branch-tree delta「对照身份与四列指标保持可辨」）。
 *
 * - **只吃 props**（本包无 jsdom，判据由 `lib/compare-metrics.ts` 派生后传入）；
 * - 首列 = 指标名称，`sticky left-0` 固定可见且宽度大于零；运行列带最小宽度，
 *   四条时表格容器**内部横向滚动**——不压扁名称列、不把应用整体撑出横滚；
 * - 运行标题 = 任务摘要 + 会话稳定短 ID（复制按钮复制完整 ID）+ 模型 + 状态；
 * - 不可读列如实呈现受控原因，不借列表数据补标题、不悄悄换对象；
 * - 三态关系（共同祖先 / 无 / 判定不完整）单列呈现；口径说明恒定在场。
 */
export function CompareMetricsTable(props: {
  readonly model: MetricsTableModel;
  /** 本次比较读取在飞（读取中不伪结论） */
  readonly loading: boolean;
  /** 请求级拒绝（信封失败 / 载荷不合法）；null = 无 */
  readonly rejected: { readonly code: string; readonly reason: string } | null;
  readonly onRetry: () => void;
  /**
   * U7 5.3：指标表内**显式选两条**的两步挑选状态（容器本地，pair 之外）。
   * 提供时列头出现「设为左列/右列」按钮 + 顶部挑选条。
   */
  readonly pick?: {
    readonly left: string | null;
    readonly right: string | null;
  };
  readonly onPickSide?: (side: "left" | "right", runId: string) => void;
  /** 两步挑选齐备后「打开详细比较」的提交动作 */
  readonly onOpenPair?: () => void;
  readonly onClearPick?: () => void;
  /** 挑选提交被拒（同 ID / 集合外）时的就地解释 */
  readonly pickError?: string | null;
}) {
  const { model } = props;

  // 请求级拒绝（信封失败 / 载荷不合法）优先呈现：稳定码 + 受控原因 + 重试入口。
  // ⚠️ 此时结论为 null，model 是空态——拒绝信息不能被空态引导吞掉。
  if (props.rejected !== null) {
    return (
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden" aria-label="指标对照">
        <div className="px-4 py-2">
          <div className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
            [{props.rejected.code}] {props.rejected.reason}
          </div>
          <button
            type="button"
            aria-label="重试比较读取"
            onClick={props.onRetry}
            className="mt-2 rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
          >
            重试读取
          </button>
        </div>
      </div>
    );
  }

  if (model.kind === "empty") {
    return (
      <div
        className="flex min-w-0 flex-1 items-start justify-center overflow-y-auto p-6"
        aria-label="指标对照"
      >
        <div className="rounded bg-gray-50 px-4 py-3 text-xs leading-5 text-gray-600">
          {model.hint}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden" aria-label="指标对照">
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2">
        <h2 className="text-sm font-medium text-gray-800">指标对照（{model.columns.length} 条）</h2>
        {model.hint !== null ? (
          <span className="text-[11px] text-gray-500">{model.hint}</span>
        ) : null}
      </div>

      {props.loading ? (
        <div className="px-4 py-1 text-[11px] text-gray-500">正在读取比较对象…</div>
      ) : null}

      {/* U7 5.3：两步挑选条——两侧齐备才可打开详细比较（相同 ID 由 store 拒绝） */}
      {props.pick !== undefined && model.columns.length >= 2 ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-4 py-1.5">
          <span className="text-[11px] text-gray-500">
            已选：左 {pickLabel(props.pick.left, model.columns) ?? "（未选）"} · 右{" "}
            {pickLabel(props.pick.right, model.columns) ?? "（未选）"}
          </span>
          <button
            type="button"
            aria-label="打开所选两条的详细比较"
            onClick={props.onOpenPair}
            disabled={props.pick.left === null || props.pick.right === null}
            className="rounded border border-gray-300 px-2 py-0.5 text-[11px] text-gray-700 enabled:hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            打开详细比较
          </button>
          {props.pick.left !== null || props.pick.right !== null ? (
            <button
              type="button"
              aria-label="清除挑选"
              onClick={props.onClearPick}
              className="rounded px-1.5 py-0.5 text-[11px] text-gray-500 hover:bg-gray-100"
            >
              清除
            </button>
          ) : null}
          {props.pickError !== null && props.pickError !== undefined ? (
            <output className="text-[11px] text-amber-800">{props.pickError}</output>
          ) : null}
        </div>
      ) : null}

      {/* 横滚只在表格容器内：名称列 sticky，运行列保持可读最小宽度 */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="border-collapse text-xs">
          <thead>
            <tr>
              <th
                scope="col"
                className="sticky left-0 z-10 min-w-[128px] border-b border-gray-200 bg-white px-3 py-2 text-left text-[11px] font-normal text-gray-500"
              >
                指标
              </th>
              {model.columns.map((column) => (
                <th
                  key={column.runId}
                  scope="col"
                  className="min-w-[220px] border-b border-l border-gray-200 bg-white px-3 py-2 text-left align-top"
                >
                  <div className="max-w-[280px]">
                    <div
                      className="truncate text-[11px] text-gray-700"
                      title={column.task ?? undefined}
                    >
                      {column.task ??
                        (column.unavailableReason !== null ? "（不可读）" : "未记录任务")}
                    </div>
                    <div className="mt-0.5">
                      <ShortIdLabel id={column.runId} shortId={column.shortId} />
                    </div>
                    <div className="mt-0.5 text-[11px] text-gray-500">
                      {column.model ?? "未记录模型"}
                    </div>
                    {column.statusLabel !== null ? (
                      <div className={`mt-0.5 text-[11px] ${statusTextClass(column.statusTone)}`}>
                        {column.statusLabel}
                      </div>
                    ) : null}
                    {column.unavailableReason !== null ? (
                      <div className="mt-1 rounded bg-amber-50 px-1.5 py-1 text-[11px] text-amber-800">
                        不可读：{column.unavailableReason}
                      </div>
                    ) : null}
                    {props.onPickSide !== undefined && column.unavailableReason === null ? (
                      <div className="mt-1 flex gap-1">
                        <button
                          type="button"
                          aria-label={`设为左列 ${column.runId}`}
                          aria-pressed={props.pick?.left === column.runId}
                          onClick={() => props.onPickSide?.("left", column.runId)}
                          className="rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-600 hover:bg-gray-50"
                        >
                          设为左列
                        </button>
                        <button
                          type="button"
                          aria-label={`设为右列 ${column.runId}`}
                          aria-pressed={props.pick?.right === column.runId}
                          onClick={() => props.onPickSide?.("right", column.runId)}
                          className="rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-600 hover:bg-gray-50"
                        >
                          设为右列
                        </button>
                      </div>
                    ) : null}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {model.rows.map((row) => (
              <MetricsRowView key={row.label} row={row} />
            ))}
          </tbody>
        </table>
      </div>

      {model.relation !== null ? (
        <div
          className={`border-t border-gray-200 px-4 py-2 text-xs ${
            model.relation.incomplete ? "text-amber-800" : "text-gray-700"
          }`}
        >
          {model.relation.note}
        </div>
      ) : null}
      <div className="border-t border-gray-100 px-4 py-2 text-[11px] leading-4 text-gray-500">
        {model.scopeNote}
      </div>
    </div>
  );
}

function statusTextClass(tone: MetricsTableModel["columns"][number]["statusTone"]): string {
  switch (tone) {
    case "success":
      return "text-emerald-700";
    case "danger":
      return "text-red-700";
    case "warn":
      return "text-amber-700";
    case "neutral":
      return "text-gray-600";
    default:
      return "text-gray-500";
  }
}

/** 挑选条里的短 ID 标签（查不到回退完整 id；null = 未选） */
function pickLabel(
  runId: string | null,
  columns: MetricsTableModel["columns"],
): string | null {
  if (runId === null) return null;
  return columns.find((column) => column.runId === runId)?.shortId ?? runId;
}

/** 指标行：sticky 名称格 + 逐列值（null = 该侧不可得，显示 —，不补 0） */
function MetricsRowView({ row }: { row: MetricsRow }) {
  return (
    <tr className="border-b border-gray-100">
      <th
        scope="row"
        className="sticky left-0 z-10 bg-white px-3 py-1.5 text-left text-[11px] font-normal text-gray-500"
        title={row.label}
      >
        {row.label}
      </th>
      {row.values.map((value, index) => (
        <td
          key={`${row.label}:${index}`}
          className="border-l border-gray-100 px-3 py-1.5 font-code text-gray-800"
          title={row.titles?.[index]}
        >
          {value ?? <span className="text-gray-400">—</span>}
        </td>
      ))}
    </tr>
  );
}
