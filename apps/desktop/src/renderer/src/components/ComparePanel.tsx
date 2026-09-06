import { deriveComparison } from "@shared/derive";
import type { ComparisonEntry } from "@shared/derive";
import { useMemo } from "react";
import { formatDuration, formatTime, formatTokens, reasonLabel } from "../lib/format";
import { MAX_COMPARE, useAppStore } from "../store";

function Cell({ value }: { value: string }) {
  return <span className="w-14 shrink-0 text-right font-code text-[11px]">{value}</span>;
}

function Row({
  label,
  values,
  keys,
  title,
}: {
  label: string;
  values: string[];
  /** 与 values 等长的 React key（run id），避免用数组下标做 key */
  keys: string[];
  title?: string | undefined;
}) {
  return (
    <div className="flex items-center gap-1 py-0.5" title={title}>
      <span className="min-w-0 flex-1 truncate text-[11px] text-gray-500">{label}</span>
      {keys.map((key, index) => (
        <Cell key={key} value={values[index] ?? ""} />
      ))}
    </div>
  );
}

/** 共同祖先三态：有 / 无（链完整） / 判定不完整（存在父缺失） */
function CommonAncestorRow({
  id,
  incomplete,
}: {
  id: string | null;
  incomplete: boolean;
}) {
  if (incomplete) {
    return (
      <div className="rounded bg-amber-50 px-2 py-1.5">
        <div className="text-[11px] text-gray-500">共同祖先</div>
        <div className="text-xs font-medium text-amber-800">
          {id === null ? "判定不完整（存在父缺失）" : `${id}（判定不完整）`}
        </div>
        <div className="mt-0.5 text-[11px] leading-4 text-amber-700">
          链上有 run 的父 run 不在数据目录，无法确认更深的共同祖先——不是"本来就不同源"
        </div>
      </div>
    );
  }
  if (id === null) {
    return (
      <div className="rounded bg-gray-50 px-2 py-1.5">
        <div className="text-[11px] text-gray-500">共同祖先</div>
        <div className="text-xs font-medium text-gray-700">无（分属不同根）</div>
        <div className="mt-0.5 text-[11px] leading-4 text-gray-500">
          两条链都完整但无公共祖先，没有可比基线
        </div>
      </div>
    );
  }
  return (
    <div className="rounded bg-gray-50 px-2 py-1.5">
      <div className="text-[11px] text-gray-500">共同祖先</div>
      <div className="truncate font-code text-xs text-gray-800">{id}</div>
    </div>
  );
}

/** 增量差：不可得时明确说原因，不补 0 */
function DeltaRow({ entries }: { entries: ComparisonEntry[] }) {
  if (entries.length < 2) return null;
  const deltas = entries.map((entry) => entry.deltaFromAncestor);
  if (deltas.some((delta) => delta === null)) {
    return (
      <div className="mt-2 border-t border-gray-100 pt-2">
        <div className="text-[11px] text-gray-500">相对共同祖先的增量差</div>
        <div className="text-[11px] leading-4 text-gray-500">
          {deltas[0] === null && entries.every((e) => e.totals === null)
            ? "不可得：链上存在父缺失，累计增量无法计算"
            : "不可得：无可比基线（无共同祖先或判定不完整）"}
        </div>
      </div>
    );
  }

  const tokensList = deltas.map((delta) => delta?.tokens ?? 0);
  const spread = Math.max(...tokensList) - Math.min(...tokensList);

  return (
    <div className="mt-2 border-t border-gray-100 pt-2">
      <div className="text-[11px] text-gray-500">相对共同祖先的增量差</div>
      {entries.map((entry, index) => (
        <div key={entry.run.id} className="flex items-center gap-1 py-0.5">
          <span className="min-w-0 flex-1 truncate font-code text-[11px] text-gray-500">
            {entry.run.id}
          </span>
          <Cell value={`+${formatTokens(deltas[index]?.tokens ?? 0)}`} />
          <Cell value={formatDuration(deltas[index]?.durationMs ?? null)} />
        </div>
      ))}
      <div className="mt-1 text-[11px] text-gray-500">tokens 差 {formatTokens(spread)}</div>
    </div>
  );
}

export function ComparePanel() {
  const runs = useAppStore((s) => s.runs);
  const compareIds = useAppStore((s) => s.compareIds);
  const toggleCompare = useAppStore((s) => s.toggleCompare);
  const clearCompare = useAppStore((s) => s.clearCompare);
  const compareNotice = useAppStore((s) => s.compareNotice);

  const comparison = useMemo(() => deriveComparison(runs, compareIds), [runs, compareIds]);
  const entryKeys = comparison.entries.map((entry) => entry.run.id);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-l border-gray-200 bg-white">
      <div className="border-b border-gray-200 px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="text-sm font-semibold text-gray-800">对照</div>
          <div className="text-[11px] text-gray-500">
            已选 {compareIds.length} / {MAX_COMPARE}
          </div>
          {compareIds.length > 0 ? (
            <button
              type="button"
              onClick={clearCompare}
              className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-gray-500 hover:bg-gray-100"
            >
              清空
            </button>
          ) : null}
        </div>
      </div>

      {compareNotice !== null ? (
        <div className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800">
          {compareNotice}
        </div>
      ) : null}

      {compareIds.length === 0 ? (
        <div className="px-3 py-6 text-xs leading-5 text-gray-500">
          勾选分支树上的节点即可加入对照。
          <br />
          对照会给出共同祖先，以及各分支相对它的增量差。
        </div>
      ) : null}

      {compareIds.length === 1 ? (
        <div className="px-3 py-2 text-[11px] text-gray-500">再选一条即可对照。</div>
      ) : null}

      {comparison.entries.length > 0 ? (
        <div className="flex-1 overflow-y-auto px-3 py-2">
          <CommonAncestorRow
            id={comparison.commonAncestor.id}
            incomplete={comparison.commonAncestor.incomplete}
          />

          <div className="mt-3">
            <div className="flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate text-[11px] text-gray-400">指标</span>
              {comparison.entries.map((entry, index) => (
                <span
                  key={entry.run.id}
                  className="w-14 shrink-0 text-right text-[11px] text-gray-400"
                >
                  {`分支 ${index + 1}`}
                </span>
              ))}
            </div>

            <Row
              keys={entryKeys}
              label="run id"
              values={comparison.entries.map((entry) => entry.run.id.slice(0, 7))}
            />
            <Row
              keys={entryKeys}
              label="状态"
              values={comparison.entries.map((entry) =>
                entry.run.status === "crashed" ? "运行中断" : reasonLabel(entry.run.reason),
              )}
            />
            <Row
              keys={entryKeys}
              label="创建时间"
              values={comparison.entries.map((entry) => formatTime(entry.run.created_at))}
            />
            <Row
              keys={entryKeys}
              label="分叉点"
              values={comparison.entries.map((entry) => entry.run.fork?.at_span ?? "—")}
            />
            <Row
              keys={entryKeys}
              label="本 run 步数"
              values={comparison.entries.map((entry) => String(entry.run.steps))}
            />
            <Row
              keys={entryKeys}
              label="工具 / 出错"
              values={comparison.entries.map(
                (entry) => `${entry.run.toolCalls}/${entry.run.toolErrors}`,
              )}
            />
            <Row
              keys={entryKeys}
              label="本 run tokens"
              values={comparison.entries.map((entry) =>
                formatTokens(entry.run.tokensIn + entry.run.tokensOut),
              )}
            />
            <Row
              keys={entryKeys}
              label="本 run 耗时"
              values={comparison.entries.map((entry) => formatDuration(entry.run.durationMs))}
            />
            <Row
              keys={entryKeys}
              label="累计增量（步数）"
              values={comparison.entries.map((entry) =>
                entry.totals === null ? "—" : String(entry.totals.steps),
              )}
              title="沿 parent 链求和"
            />
            <Row
              keys={entryKeys}
              label="累计增量（tokens）"
              values={comparison.entries.map((entry) =>
                entry.totals === null ? "—" : formatTokens(entry.totals.tokens),
              )}
              title="沿 parent 链求和；不等于从头连续跑一次的消耗"
            />
            <Row
              keys={entryKeys}
              label="累计增量（耗时）"
              values={comparison.entries.map((entry) =>
                formatDuration(entry.totals?.durationMs ?? null),
              )}
              title="各段墙钟跨度之和，中间含用户思考与编辑的空档"
            />
          </div>

          <DeltaRow entries={comparison.entries} />

          <div className="mt-3 border-t border-gray-100 pt-2">
            {comparison.entries.map((entry) => (
              <div key={entry.run.id} className="flex items-center gap-1 py-0.5">
                <span className="min-w-0 flex-1 truncate font-code text-[11px] text-gray-500">
                  {entry.run.id}
                </span>
                <button
                  type="button"
                  onClick={() => toggleCompare(entry.run.id)}
                  className="rounded px-1 text-[11px] text-gray-400 hover:bg-gray-100"
                >
                  移出
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
