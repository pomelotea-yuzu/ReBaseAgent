// AppState 分片：Reading 域（refactor-renderer 4.1 接口 / 5.1 实现迁入；归属依据 change 的 ownership-map.md）
// 工厂以完整 store 的 set/get 为上下文（design D2：无第二 create、不导入 useAppStore）；
// 跨域协调者由 store.ts 显式注入（results 域 5.5 迁出前的注入点）。
import type {
  CallReadingState,
  FileReadingState,
  ReadingStateByRun,
  RunReadingState,
} from "../../lib/reading-state";
import {
  fileReadingOf,
  patchCallReading,
  patchFileReading,
  patchReadingState,
  readingStateOf,
  toggleExpandedKey,
} from "../../lib/reading-state";
import type { AppState, SliceContext } from "../types";

export interface ReadingState {
  readingByRun: ReadingStateByRun;
  /**
   * 恢复阅读位置时发生了失效回退（保存的 span / 展开对象已不在详情里，或文件页签不再适用）。
   * 只作一次性提示：用户下一次明确选择 span 即清除。**不**用来选另一个 run 的同 ID span。
   */
  readingInvalidated: boolean;
  /** 当前 run 的选中 span（**派生视图**，真源同 `readingByRun`） */
  selectedSpanId: string | null;
  /** 当前 run 的展开 step 集合（**派生视图**，真源同 `readingByRun`） */
  expandedSteps: Record<string, boolean>;
  /**
   * U2 任务 2.3：一次性显式文件目标（如从步骤页「打开该轮文件」）。
   *
   * 与阅读历史分开存：历史是"上次读到哪"，目标是"这次要看哪"——混在一起会让普通
   * 页签返回被误当成定位请求（delta 明文禁止）。由文件页承载组件消费一次后清空，
   * 且与目标 run 的身份绑定（旧目标不抢回当前页）。
   */
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
  /** 切换某 run 的某 step 展开/折叠（派生视图与真源两处同步写） */
  toggleStep: (id: string) => void;
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
  openFileAt: (runId: string, file: { stepSpanId: string | null; path?: string }) => void;
}

/** reading 分片工厂上下文：完整 set/get + 跨域协调者的显式注入 */
export interface ReadingSliceContext extends SliceContext {
  /** results 域协调者（5.5 迁出前由 store.ts 注入）：换阅读对象 ⇒ 撤销在飞导航资格 */
  noteReadingChanged: () => void;
}

/**
 * 详情读取代次的唯一持有者（原 store.ts 模块级 `let detailReadAttempt` 的按实例化改造）。
 *
 * 只增不减、不进渲染状态：`selectRun` 每次实际发起 `getRun` 前取新代次，
 * 响应落地只认当代——「迟到读取不能污染当前目标」的判据之一。
 * `selectRun`（runs 域）经注入的 DetailReadAttempts 访问，分片之间无运行时互相导入。
 */
export interface DetailReadAttempts {
  /** 发起一次新读取：递增并返回新代次（原 `++detailReadAttempt`） */
  next(): number;
  /** 当前最新代次（迟到判据 `isCurrentDetailAttempt(attempt, current)` 的右元） */
  current(): number;
}

export function createDetailReadAttempts(): DetailReadAttempts {
  let detailReadAttempt = 0;
  return {
    next() {
      detailReadAttempt += 1;
      return detailReadAttempt;
    },
    current() {
      return detailReadAttempt;
    },
  };
}

export function createReadingSlice({
  set,
  get,
  noteReadingChanged,
}: ReadingSliceContext): ReadingState {
  return {
    readingByRun: {},
    readingInvalidated: false,
    selectedSpanId: null,
    expandedSteps: {},
    pendingFileTarget: null,

    selectSpan(id) {
      const runId = get().selectedRunId;
      // U5 3.4：换"看哪一次调用"= 改变阅读对象 ⇒ 撤销在飞的自动导航资格
      noteReadingChanged();
      // 明确选择即"换到用户要看的位置"⇒ 失效提示作废（它说的是"原位置不可用，已回退"）
      set({ selectedSpanId: id, readingInvalidated: false });
      if (runId !== null) {
        set({ readingByRun: patchReadingState(get().readingByRun, runId, { spanId: id }) });
      }
    },

    toggleStep(id) {
      const { expandedSteps, selectedRunId, readingByRun } = get();
      const next = { ...expandedSteps, [id]: !expandedSteps[id] };
      set({ expandedSteps: next });
      if (selectedRunId !== null) {
        set({
          readingByRun: patchReadingState(readingByRun, selectedRunId, { expandedSteps: next }),
        });
      }
    },

    readingOf(runId) {
      return readingStateOf(get().readingByRun, runId);
    },

    setReadingTab(runId, tab) {
      // U5 3.4：换页签（概览 / 步骤 / 文件）= 改变阅读对象 ⇒ 撤销在飞的自动导航资格
      noteReadingChanged();
      set({ readingByRun: patchReadingState(get().readingByRun, runId, { tab }) });
    },

    setReadingScroll(runId, where, top) {
      set({
        readingByRun: patchReadingState(
          get().readingByRun,
          runId,
          where === "overview" ? { overviewScrollTop: top } : { stepsScrollTop: top },
        ),
      });
    },

    setCallReading(runId, spanId, patch) {
      set({ readingByRun: patchCallReading(get().readingByRun, runId, spanId, patch) });
    },

    toggleNoticeExpanded(runId, key) {
      const current = readingStateOf(get().readingByRun, runId);
      set({
        readingByRun: patchReadingState(get().readingByRun, runId, {
          noticesExpanded: toggleExpandedKey(current.noticesExpanded, key),
        }),
      });
    },

    fileReadingOf(runId) {
      return fileReadingOf(readingStateOf(get().readingByRun, runId));
    },

    fileReadingEntered(runId) {
      return readingStateOf(get().readingByRun, runId).files !== undefined;
    },

    setFileReading(runId, patch) {
      set({ readingByRun: patchFileReading(get().readingByRun, runId, patch) });
    },

    openFileAt(runId, file) {
      // 登记目标并切到该 run 的文件页；目标由文件页承载组件消费一次后清空
      set({
        pendingFileTarget: { runId, file },
        readingByRun: patchReadingState(get().readingByRun, runId, { tab: "files" }),
      });
    },
  };
}
