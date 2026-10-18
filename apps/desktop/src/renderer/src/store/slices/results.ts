// AppState 分片：Results 域（refactor-renderer 4.1；成员逐字随迁，归属依据 change 的 ownership-map.md）
import type { NavigationIntentStore } from "../../lib/navigation-intent";
import type {
  ResultReadEntry,
  ResultReadIdentity,
  ResultReadStore,
} from "../../lib/result-verification";

export interface ResultsState {
  /**
   * U5 任务 1.2：按可信身份读取到的**结果读取项**（design D3）。
   * 键为 `(epoch, operationId, runId)`；只存 renderer 会话内存，
   * 不落盘、不进 URL/日志/操作 IPC，也**不是**第二套执行真相源——
   * 它只说明"renderer 看到了哪条已校验的结局"。
   */
  resultReads: ResultReadStore;

  /**
   * U5 任务 3.4：**阅读代次**（design D6）。每次"用户主动换阅读对象或进出覆盖模态"都推进它，
   * 提交时登记的导航意图与它一比就知道用户有没有离开本次流程。
   * ⚠️ 单调递增、永不倒退 ⇒「离开再返回同一位置」不恢复旧资格（位置相等恒成立，代次不等）。
   */
  navGeneration: number;
  /** 本次会话各提交的导航意图（键 = operationId；renderer 内存，不落盘 / 不进 IPC / 不进日志） */
  navIntents: NavigationIntentStore;
  /**
   * U5 任务 1.2：**与导航分离**的结果核实。按 main 登记的 runId 独立读取并校验
   * （归属 → 版本 → schema → 自有终止事件归属），只写本条读取项。
   *
   * ⚠️ 刻意不调 `selectRun`/`reopenRun`，也不刷新列表、不写全局 `error`：
   * 核实一次结局不得改掉用户正在读的运行、页签、调用、滚动或焦点（spec
   * 「列表失败不阻断已知结果」「读取途中离页仍不抢焦点」）。零执行通道调用。
   */
  seenNoticeKeys: Readonly<Record<string, true>>;
  /** 标记为已看（展开操作面板、或用户明确打开某条结果时调用）；无变化 ⇒ 引用不变 */
  verifyRunResult: (identity: ResultReadIdentity) => Promise<ResultReadEntry>;
  /**
   * U5 任务 1.3：**显式只读重试**。只对同一条可信 runId 重读详情（`attempt` 递增），
   * 零执行通道调用——"重试读取"绝不复用执行通道、不重发模型请求（spec
   * 「结果不可读只重试同一记录」；重新执行必须换新 operationId 并重新授权）。
   * 与 `verifyRunResult` 的分工：后者对已在读/已核实的身份去重，本动作绕过那道去重。
   */
  retryResultRead: (identity: ResultReadIdentity) => Promise<ResultReadEntry>;

  /**
   * U7 任务 1.4/1.5：比较选择集的**会话读取状态**（design D3 渲染层半边）。
   * 只存 renderer 内存，不落盘、不进 URL/日志；不是执行真相源——比较全程只读。
   * 选择集代次、在飞请求守卫与结论撤销见 `lib/compare-state.ts`。
   */
  openOperationResult: (identity: ResultReadIdentity) => Promise<void>;
  /**
   * U5 任务 3.5：**失败定位只到真实自有调用**。
   *
   * 判据取 `deriveOwnTerminalFacts` 的 `failure`（`deriveErrorTarget` 已在 `leafSpanIds` 内找）；
   * 拿不到自有失败 span ⇒ 返回 false 且**一点也不动页面**——绝不跳祖先的错误调用、
   * 绝不跳"最后一个调用"凑数。诚实说明由视图给（`lib/operation-result-view` 的 `failureNote`）。
   */
  openOperationFailure: (identity: ResultReadIdentity) => Promise<boolean>;
  /**
   * U5 任务 3.5：**返回该提交对应的草稿**（复用既有草稿定位通道）。
   *
   * 目标键按身份查：先看待定关联（还在跑/未接受时正文与关联都在），再看收尾关联（解冻后）。
   * 草稿已被清理或从未登记 ⇒ 返回 false，由视图给回退说明；**不复活**旧内容，也不恢复旧授权。
   */
  returnOperationDraft: (identity: {
    epoch: string;
    operationId: string;
  }) => Promise<boolean>;
  /**
   * U5 任务 3.5：该操作对应的草稿**是否仍在**（面板据此决定给不给「返回草稿」）。
   * 按身份找回目标键（待定关联优先，其次收尾关联）后再查草稿仓库 ——
   * 与清理判据同一份仓库，不建"我以为还在"的第二套存在性。
   */
  isOperationDraftPresent: (identity: { epoch: string; operationId: string }) => boolean;

  /**
   * U5 任务 3.6：**已看过的结果通知键**（会话内）。
   * 通知本身是**现算派生**（组件用 `deriveResultNotices` 从订阅状态算），这里只存"哪些键已看过"，
   * 不存在通知队列 ⇒ 重复快照不可能堆出第二份（红线「数据派生不累积」）。
   */
  markNoticesSeen: (keys: readonly string[]) => void;

  /**
   * U3 任务 2.5：一次性草稿定位目标（草稿列表「定位」动作的载体，与 U2 的
   * pendingFileTarget 同法）。由对应编辑器消费一次后经 `consumeDraftTarget` 清空；
   * 定位失败（运行不可达 / span 不在详情）时保留——列表的复制/放弃仍可用。
   */
}
