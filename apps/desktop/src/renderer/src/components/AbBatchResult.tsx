import type { RequestOutcome } from "@shared/operations";
import type {
  AbArmResultView,
  AbBatchResultView,
  ResultAction,
} from "../lib/operation-result-view";
import type { ResultReadIdentity } from "../lib/result-verification";
import { FOCUS_RING } from "./IconButton";
import { ACTION_LABELS, TONE_STYLES } from "./OperationsEntry";

/**
 * U5（unify-run-execution-workflow）任务 5.1：**A/B 批次结果区（逐臂读取状态）**。
 *
 * 3.3 的收口注记欠的那一支：`ModelAbEditor` 原"实验完成"面板显示的是信封 `ModelAbResult`
 * （`ids.length` 计臂数）——那是**请求事实**而非结局。本视图改为消费登记 + 独立核实：
 *
 * 1. **集合基准是登记 `target.armCount`**（main 自己陈述的批规模），不是信封 `ids`——
 *    缺臂时按登记逐 index 呈现"未登记可信 ID"，不生成结果链接、不拿信封多报的 id 凑；
 * 2. **请求事实与逐臂结局分层**：`view.requestLine`（信封侧收口）单独一行，
 *    各臂的读取状态（未读/在读/正常结束/出错/不可读）走与操作面板**同一个**
 *    `itemViewOf` 派生（lib/operation-result-view），动作可用性也同源；
 * 3. **不产出臂间差值 / 胜出臂**（V3b 纪律）：底部说明行把这条写死在界面上。
 *
 * 本组件只吃 props（本包无 jsdom）：派生由 `deriveAbBatchResult` 完成，接线在 DetailPanel。
 */

const ARM_OUTCOME_SHORT: Record<RequestOutcome, string> = {
  returned: "返回",
  failed: "失败",
  rejected: "拒绝",
};

function ArmActionButton({
  action,
  identity,
  onAct,
}: {
  action: ResultAction;
  identity: ResultReadIdentity;
  onAct: (action: ResultAction, identity: ResultReadIdentity) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        onAct(action, identity);
      }}
      title={
        action === "retry-read"
          ? `只按同一个可信运行 ID 重读（${identity.runId}）：不会重新执行，也不会换一条臂试`
          : action === "view-failure"
            ? "只定位这条臂自有的失败调用；祖先或其他臂的错误不算本次原因"
            : "按可信运行 ID 打开概览（用户主动动作，不改动其它臂的阅读现场）"
      }
      className={`shrink-0 rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
    >
      {ACTION_LABELS[action]}
    </button>
  );
}

/** 一条臂：有可信 ID ⇒ 复用逐条呈现（状态 + 动作）；无 ID ⇒ 只有诚实说明，零动作零链接 */
function ArmRow({
  arm,
  epoch,
  operationId,
  onAct,
}: {
  arm: AbArmResultView;
  epoch: string | null;
  operationId: string;
  onAct: (action: ResultAction, identity: ResultReadIdentity) => void;
}) {
  const runId = arm.runId;
  const item = arm.item;
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border border-gray-100 bg-gray-50/60 px-1.5 py-1">
      <span className="shrink-0 text-[10px] font-semibold text-gray-700">臂 {arm.index + 1}</span>
      {runId === null || item === null ? (
        <span className="min-w-0 break-all text-[10px] leading-4 text-gray-500">
          {runId === null
            ? arm.note
            : "该臂已登记可信 ID，但批次呈现未拿到逐条事实（只保留身份，不造状态）"}
        </span>
      ) : (
        <>
          <span className="min-w-0 break-all font-code text-[10px] text-gray-700">{runId}</span>
          <span
            className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${TONE_STYLES[item.tone]}`}
          >
            {item.label}
          </span>
          {arm.armOutcome !== null ? (
            <span className="text-[10px] text-gray-400">
              请求层：{ARM_OUTCOME_SHORT[arm.armOutcome]}
            </span>
          ) : null}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {epoch !== null
              ? item.actions.map((action) => (
                  <ArmActionButton
                    key={action}
                    action={action}
                    identity={{ epoch, operationId, runId }}
                    onAct={onAct}
                  />
                ))
              : null}
          </div>
          {item.detail !== null ? (
            <div className="w-full break-all text-[10px] leading-4 text-gray-500">
              {item.detail}
            </div>
          ) : null}
          {/* U6 4.6：ownOnly 臂的来源警告与该臂结局分层呈现（不推断胜出臂、不暗示可重跑） */}
          {item.sourceWarning !== null ? (
            <div className="w-full break-all text-[10px] leading-4 text-amber-800">
              {item.sourceWarning}
            </div>
          ) : null}
          {item.failureNote !== null ? (
            <div className="w-full break-all text-[10px] leading-4 text-gray-400">
              {item.failureNote}
            </div>
          ) : null}
        </>
      )}
    </li>
  );
}

/** 导出的唯一理由：本包无 jsdom，喂 props 的静态视图可以走 renderToStaticMarkup。 */
export function AbBatchResultSection({
  view,
  onAct,
}: {
  view: AbBatchResultView;
  onAct: (action: ResultAction, identity: ResultReadIdentity) => void;
}) {
  return (
    <div
      className="mt-2 rounded border border-sky-200 bg-white px-2 py-1.5"
      data-ab-batch-result={view.operationId}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[10px] font-semibold text-sky-800">{view.statusLabel}</span>
        {view.experimentId !== null ? (
          <span className="break-all font-code text-[10px] text-gray-400">
            实验组 {view.experimentId}
          </span>
        ) : null}
      </div>
      <div className="mt-0.5 break-all text-[10px] leading-4 text-gray-500">
        {view.statusDetail}
      </div>
      {view.requestLine !== null ? (
        <div className="mt-0.5 break-all text-[10px] leading-4 text-gray-500">
          {view.requestLine}
        </div>
      ) : null}
      {view.arms.length > 0 ? (
        <ul className="mt-1 space-y-1">
          {view.arms.map((arm) => (
            <ArmRow
              key={arm.index}
              arm={arm}
              epoch={view.epoch}
              operationId={view.operationId}
              onAct={onAct}
            />
          ))}
        </ul>
      ) : null}
      <div className="mt-1 text-[10px] leading-4 text-gray-400">
        逐臂只呈现登记身份与独立核实到的事实：不产出臂间差值或"胜出臂"，比较请看分支树与各臂轨迹。
      </div>
    </div>
  );
}
