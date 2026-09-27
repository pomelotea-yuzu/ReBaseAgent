import type { OperationRecord } from "@shared/operations";
import type { ResultReadStore } from "./result-verification";
import { resultReadKeyOf, viewOperationResult } from "./result-verification";

/**
 * U5（unify-run-execution-workflow）任务 3.6：**只通知路径与去重**（design D6 + delta
 * 「恢复核对重试与批次结果只通知」）。
 *
 * 3.4 已经保证"核对 / 只读重试 / 批次 / 重载恢复不跳页面"；本模块补的是另一半：
 * **这些路径要把话说给用户听，但同一件事只说一次**。三条判据：
 *
 * 1. **只有落到结论的终态才算通知**：可查看 / 不可读 / 未定位 / 本次未接受。
 *    `running` 与"正在读取"不算 —— 它们没有新事实，报了只是噪音。
 * 2. **去重按身份键**，不按"第几次快照"：轮询每 1s 回全量快照，同一 `(epoch, operationId, runId)`
 *    的同一结论第二次到达不再产生通知（spec「重复状态不重复通知」）。
 * 3. **等待计时不进通知文本**：计时每 tick 都在变，进了文本就等于每秒重复通知。
 *    计时显示属 §5.2 的独立判据，这里刻意不含。
 *
 * ⚠️ 通知是**派生**的，不是队列：store 只存"哪些键已经看过"， unread 集合每次现算
 * （红线「数据派生不累积」）。因此也不存在"通知丢了/重放"的第二套真相源。
 */

/**
 * 通知身份键：**直接复用读取项的键编码**（同一套身份只留一份编码，防两处漂移）。
 * `runId` 为 null 表示**记录级**结论（未定位 / 本次未接受），用 `"-"` 占位——
 * 真实 runId 不可能等于它，所以两个域共用一张"已看过"表是安全的。
 */
export function noticeKeyOf(epoch: string, operationId: string, runId: string | null): string {
  return resultReadKeyOf({ epoch, operationId, runId: runId ?? "-" });
}

/** 一条待通知 */
export interface ResultNotice {
  readonly key: string;
  /** 进 `aria-live` 区域与人话提示的文本（不含正文、密钥、sourceToken） */
  readonly text: string;
  readonly tone: "neutral" | "success" | "danger" | "warn";
}

export interface ResultNotices {
  /** 未看过的通知（按登记的 operationId 顺序） */
  readonly notices: readonly ResultNotice[];
  readonly unreadCount: number;
  /**
   * 给 `aria-live` 区域的整段文本：**只在通知集合变化时**才变化。
   * null = 无未读通知（此时也不该播报）。
   */
  readonly liveText: string | null;
}

function itemNotice(
  record: OperationRecord,
  runId: string,
  label: string,
  tone: ResultNotice["tone"],
  verdict: string,
): ResultNotice {
  return {
    key: noticeKeyOf(record.epoch, record.operationId, runId),
    text: `${kindTextOf(record)} ${verdict}：${runId}（${label}）`,
    tone,
  };
}

/** 类型的中文短名（与操作面板一致，只到 kind，不重抄目标摘要） */
function kindTextOf(record: OperationRecord): string {
  switch (record.target?.kind) {
    case "create":
      return "新建运行";
    case "result":
      return "结果重跑";
    case "prompt":
      return "改提示词重跑";
    case "proxy":
      return "代理重发";
    case "modelAb":
      return "模型 A/B";
    default:
      return "操作";
  }
}

/**
 * 派生未读通知。
 *
 * @param records 会话镜像里的操作登记（`store.operations.operations`）
 * @param reads   结果读取项（1.2/1.3 的产物）
 * @param seenKeys 已看过的通知键（面板展开或用户明确打开时标记）
 */
export function deriveResultNotices(input: {
  records: readonly OperationRecord[];
  reads: ResultReadStore;
  seenKeys: Readonly<Record<string, true>>;
}): ResultNotices {
  const notices: ResultNotice[] = [];
  for (const record of input.records) {
    const view = viewOperationResult(record, input.reads);
    switch (view.kind) {
      case "running":
        continue; // 没有新事实
      case "not-accepted":
        notices.push({
          key: noticeKeyOf(record.epoch, record.operationId, null),
          text: `${kindTextOf(record)} 本次未被主进程接受：未执行，输入仍保留`,
          tone: "warn",
        });
        continue;
      case "unlocated":
        notices.push({
          key: noticeKeyOf(record.epoch, record.operationId, null),
          text: `${kindTextOf(record)} 已结束但结果未定位：登记里没有可信运行 ID`,
          tone: "warn",
        });
        continue;
      case "results":
        for (const item of view.items) {
          const entry = item.entry;
          if (entry === undefined || entry.phase === "reading") continue;
          if (entry.phase === "unreadable") {
            notices.push(itemNotice(record, item.runId, "结果不可读", "warn", "的结果读不出来"));
            continue;
          }
          const label = entry.facts?.outcome.label ?? "结局未知";
          notices.push(
            itemNotice(
              record,
              item.runId,
              label,
              entry.facts?.normalEnd ? "success" : "danger",
              "已有结果",
            ),
          );
        }
        continue;
    }
  }
  // 两层去重：① 用户已看过的键；② **同一身份在一次派生里只报一次**
  //（登记镜像里同 id 的记录理论上不会重复，但快照拼接、旧 epoch 同 id 都可能在数组里出现两次，
  //  而通知是按身份算的 ⇒ 不做这层就会把同一件事报两遍，正是 spec 禁的"重复状态重复通知"）
  const unread: ResultNotice[] = [];
  const announced = new Set<string>();
  for (const one of notices) {
    if (input.seenKeys[one.key] === true || announced.has(one.key)) continue;
    announced.add(one.key);
    unread.push(one);
  }
  return {
    notices: unread,
    unreadCount: unread.length,
    liveText: unread.length === 0 ? null : unread.map((one) => one.text).join("；"),
  };
}
