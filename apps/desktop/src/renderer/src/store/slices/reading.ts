// AppState 分片：Reading 域（refactor-renderer 4.1；成员逐字随迁，归属依据 change 的 ownership-map.md）
import type { fileReadingOf } from "../../lib/reading-state";
import type {
  CallReadingState,
  FileReadingState,
  ReadingStateByRun,
  RunReadingState,
} from "../../lib/reading-state";

export interface ReadingState {
  readingByRun: ReadingStateByRun;
  /**
   * 恢复阅读位置时发生了失效回退（保存的 span / 展开对象已不在详情里，或文件页签不再适用）。
   * 只作一次性提示：用户下一次明确选择 span 即清除。**不**用来选另一个 run 的同 ID span。
   */
  selectedSpanId: string | null;
  /** 当前 run 的展开 step 集合（**派生视图**，真源同 `readingByRun`） */
  expandedSteps: Record<string, boolean>;
  /**
   * 会话内按运行保存的阅读状态（页签/调用/展开/滚动）。
   * 只存会话、不落盘、不保存授权或草稿；切运行再返回据此恢复。
   */
  readingInvalidated: boolean;
  pendingFileTarget: { runId: string; file: { stepSpanId: string | null; path?: string } } | null;
  /** 登记一次性文件目标（切到该 run 的文件页） */
  readingOf: (runId: string) => RunReadingState;
  /** 切换某 run 的页签（首次默认概览） */
  setReadingTab: (runId: string, tab: RunReadingState["tab"]) => void;
  /** 记录某 run 某处的滚动位置（概览/步骤目录） */
  setReadingScroll: (runId: string, where: "overview" | "steps", top: number) => void;
  /** 记录某 run 某次调用的分区阅读状态（io 切换/展开块/内部滚动） */
  setCallReading: (runId: string, spanId: string, patch: Partial<CallReadingState>) => void;
  /**
   * UI 密度 change 1.3：切换某 run 的说明/技术详情展开键
   * （`readingByRun[runId].noticesExpanded`；键是静态 UI 键，按 run 隔离）。
   */
  toggleNoticeExpanded: (runId: string, key: string) => void;

  /**
   * U2 文件阅读状态（任务 2.1/2.4）：读取与不可变更新。
   * 与 `readingOf` 同法——按 run 隔离，组件卸载不丢。
   */
  toggleStep: (id: string) => void;

  /**
   * 首次自动选择（任务 3.5）：列表首次成功加载且无选中项时，
   * 尝试「最近可读摘要」对应的运行并进入概览。只尝试**一条**，失败即停。
   */
  selectSpan: (id: string) => void;
  fileReadingOf: (runId: string) => FileReadingState;
  /**
   * 该 run 是否**进入过**文件页（会话里 `files !== undefined`）。
   *
   * ⚠️ 必须与 `fileReadingOf(...).checkpoint === null` 分开用：`null` 明确代表"要看初始"，
   * 而"从未进入"要套**默认检查点**（最近自有完成步骤）——U2 5.6 实机缺陷正是把两者混为一谈。
   */
  fileReadingEntered: (runId: string) => boolean;
  /** 更新某 run 的文件阅读状态片段（undefined 值视为不改该项） */
  setFileReading: (runId: string, patch: Partial<FileReadingState>) => void;
  /**
   * U2 任务 2.3：一次性显式文件目标（如从步骤页「打开该轮文件」）。
   *
   * 与阅读历史分开存：历史是"上次读到哪"，目标是"这次要看哪"——混在一起会让普通
   * 页签返回被误当成定位请求（delta 明文禁止）。由文件页承载组件消费一次后清空，
   * 且与目标 run 的身份绑定（旧目标不抢回当前页）。
   */
  openFileAt: (runId: string, file: { stepSpanId: string | null; path?: string }) => void;

  /**
   * U3 会话调试草稿仓库（任务 1.1/1.2/1.3）：调用类（result / system_prompt /
   * user_message / messages）+ 创建表单 + A/B 批次，三区共享会话内单调修订计数器。
   * 只存 renderer 会话内存——不落 localStorage / URL / 日志 / settings / trace，
   * 也不保存授权、凭据或 dry-run 计划（design D1/D4）。
   */
}
