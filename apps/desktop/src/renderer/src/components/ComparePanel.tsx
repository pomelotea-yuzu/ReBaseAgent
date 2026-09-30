import { deriveComparison } from "@shared/derive";
import type { ComparisonEntry } from "@shared/derive";
import type { RunSummary } from "@shared/ipc";
import { classifyOutcome, outcomeTextClass } from "@shared/outcome";
import { useMemo } from "react";
import { formatDuration, formatTime, formatTokens } from "../lib/format";
import { MAX_COMPARE, useAppStore } from "../store";
import { ShortIdLabel } from "./ShortIdLabel";

/**
 * 多分支对照面板（U1 任务 6.3 回归）。
 *
 * 判据来源：
 *   - branch-tree 主 spec「多分支对照到 run 级指标与共同祖先」：上限 4 条（超出拒绝 + 提示）、
 *     并排展示状态与终止原因 / 步数 / 工具数与出错数 / tokens / 耗时 / 分叉点 / 创建时间，
 *     给出**共同祖先**与**各自**相对它的增量差；共同祖先三态（有 / 无 / 判定不完整）
 *     不得把「判定不完整」呈现成「分属不同根」；判定不完整时不算增量差。
 *   - model-experiments 主 spec「比较沿用共同祖先和现有派生口径」：复用 `deriveComparison` /
 *     `deriveChainTotals` / ComparePanel 状态展示；**只展示各臂相对父 run 的累计增量**，
 *     SHALL NOT 产出臂间差值、胜出臂或最佳模型结论；沿链数字禁用「总耗时 / 总成本」。
 *   - desktop-ui delta 场景「既有四条指标对照仍可使用」：既有指标与本 run/沿链口径保持，
 *     超出上限或不可比仍按原规则提示，**不新增**臂间差值、胜出结论或未实现的输出比较入口。
 *
 * ⚠️ 6.3 修的一处不一致：状态行原用 `reasonLabel` ⇒ `completed` 显示「**已完成**」，
 *    与列表/概览/树（6.2 起统一为「已结束」）不同口径。现改由 `classifyOutcome` 驱动，
 *    与其余视图同源。密集表格放不下带内边距的徽章，故用 `outcomeTextClass` 的纯文字色
 *    （文字仍是主要载体，颜色只做辅助，不新增判断）。
 *
 * ⚠️ 取值与渲染分离（`ComparePanelView`）：本包无 jsdom，store 薄壳在 `renderToStaticMarkup`
 *    下走 `getServerSnapshot`（恒初始值）⇒ 组件测试喂不进状态。抽成纯展示层后，
 *    "四条指标在不在、三口径是否并列、不可比时给不给差值"才能被直接断言。
 */

function Cell({ value, className }: { value: string; className?: string }) {
  return (
    <span className={`w-14 shrink-0 text-right font-code text-[11px] ${className ?? ""}`}>
      {value}
    </span>
  );
}

function Row({
  label,
  values,
  keys,
  title,
  valueClass,
}: {
  label: string;
  values: string[];
  /** 与 values 等长的 React key（run id），避免用数组下标做 key */
  keys: string[];
  title?: string | undefined;
  /** 整行值的附加类名（如状态行的语义文字色） */
  valueClass?: string[] | undefined;
}) {
  return (
    <div className="flex items-center gap-1 py-0.5" title={title}>
      <span className="min-w-0 flex-1 truncate text-[11px] text-gray-500">{label}</span>
      {keys.map((key, index) => (
        <Cell key={key} value={values[index] ?? ""} className={valueClass?.[index]} />
      ))}
    </div>
  );
}

/** 共同祖先三态：有 / 无（链完整） / 判定不完整（存在父缺失） */
export function CommonAncestorRow({
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
export function DeltaRow({ entries }: { entries: ComparisonEntry[] }) {
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
    </div>
  );
}

/** store 薄壳：只把 store 数据与动作接进纯展示层 */
export function ComparePanel() {
  const runs = useAppStore((s) => s.runs);
  const compareIds = useAppStore((s) => s.compareIds);
  const toggleCompare = useAppStore((s) => s.toggleCompare);
  const clearCompare = useAppStore((s) => s.clearCompare);
  const compareNotice = useAppStore((s) => s.compareNotice);
  // U7 5.1：对照身份复用全量已加载记录范围的会话稳定短 ID（与树/运行导航同一实例），
  // 替换原先可能碰撞的 `slice(0, 7)` 前缀
  const shortIdState = useAppStore((s) => s.shortIdState);
  const shortIds = shortIdState.update(runs.map((run) => run.id));

  return (
    <ComparePanelView
      runs={runs}
      compareIds={compareIds}
      compareNotice={compareNotice}
      shortIds={shortIds}
      onToggleCompare={toggleCompare}
      onClear={clearCompare}
      maxCompare={MAX_COMPARE}
    />
  );
}

/** 纯展示层：只吃 run 列表 + 已选 id，派生与排版全在这里（可直接喂数据断言） */
export function ComparePanelView({
  runs,
  compareIds,
  compareNotice,
  shortIds,
  onToggleCompare,
  onClear,
  maxCompare = MAX_COMPARE,
}: {
  runs: ReadonlyArray<RunSummary>;
  compareIds: ReadonlyArray<string>;
  compareNotice: string | null;
  /**
   * U7 5.1：会话稳定短 ID（容器从 ShortIdState 现算后传入）。
   * 对照的 run 身份列不再用可能碰撞的 7 字符前缀；「复制」按钮复制完整 ID。
   */
  shortIds: ReadonlyMap<string, string>;
  onToggleCompare: (id: string) => void;
  onClear: () => void;
  maxCompare?: number;
}) {
  const comparison = useMemo(() => deriveComparison(runs, compareIds), [runs, compareIds]);
  const entryKeys = comparison.entries.map((entry) => entry.run.id);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-l border-gray-200 bg-white">
      <div className="border-b border-gray-200 px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="text-sm font-semibold text-gray-800">对照</div>
          <div className="text-[11px] text-gray-500">
            已选 {compareIds.length} / {maxCompare}
          </div>
          {compareIds.length > 0 ? (
            <button
              type="button"
              onClick={onClear}
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

            {/*
             * U7 5.1：run 身份列 = 会话稳定短 ID + 复制完整 ID（碰撞时延长且会话内
             * 不缩短；左右编号随位置更新但不改变 run 身份）。不再用 slice(0,7) 前缀。
             */}
            <div className="flex items-center gap-1 py-0.5">
              <span className="min-w-0 flex-1 truncate text-[11px] text-gray-500">run id</span>
              {comparison.entries.map((entry) => (
                <span key={entry.run.id} className="w-14 shrink-0 text-right">
                  <ShortIdLabel
                    id={entry.run.id}
                    shortId={shortIds.get(entry.run.id) ?? entry.run.id}
                  />
                </span>
              ))}
            </div>
            {/*
             * 状态与终止原因：与列表/概览/树**同一判据**（`classifyOutcome`）。
             * 6.3 之前这里用 `reasonLabel` ⇒ completed 显示「已完成」（其余视图是「已结束」）。
             */}
            <Row
              keys={entryKeys}
              label="状态"
              values={comparison.entries.map(
                (entry) =>
                  classifyOutcome({ status: entry.run.status, reason: entry.run.reason }).label,
              )}
              valueClass={comparison.entries.map((entry) =>
                outcomeTextClass(
                  classifyOutcome({ status: entry.run.status, reason: entry.run.reason }).tone,
                ),
              )}
            />
            {/*
             * 终止原因**原值**单列（未知时不丢）：状态列给结论，本列给记录值。
             * 两列互不冒充——状态说「结束原因未知」时这里仍能看到原始 reason。
             */}
            <Row
              keys={entryKeys}
              label="终止原因"
              values={comparison.entries.map((entry) => entry.run.reason ?? "—")}
              title="记录里的原始 reason；— 表示该 run 没有终止事件"
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
              label="实验组"
              values={comparison.entries.map((entry) =>
                entry.run.fork?.experiment_id === null || entry.run.fork === null
                  ? "—"
                  : (entry.run.fork?.experiment_id ?? "—"),
              )}
              title="同一批模型 A/B 的所有臂共享一个 experimentId"
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
            {/* 沿链累计：口径名必须在场（与「本 run」并列，两者不混） */}
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
                  onClick={() => onToggleCompare(entry.run.id)}
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
