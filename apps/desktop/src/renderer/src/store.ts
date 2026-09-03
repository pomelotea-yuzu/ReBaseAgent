import type { FailedFile, RunDetail, RunSummary } from "@shared/ipc";
import { ListRunsDataSchema, RunDetailSchema } from "@shared/ipc";
import { create } from "zustand";
import { api } from "./lib/api";

/**
 * UI 状态：只存选择状态与原始数据。
 * 聚合数字一律在组件里用 shared/derive 的纯函数现算，不进 store、不落缓存。
 */
interface AppState {
  runs: RunSummary[];
  /** 读取失败的文件（隔离展示，不拖垮列表） */
  failed: FailedFile[];
  detail: RunDetail | null;
  selectedRunId: string | null;
  selectedSpanId: string | null;
  /** 展开的 step span id 集合 */
  expandedSteps: Record<string, boolean>;
  loadingList: boolean;
  loadingDetail: boolean;
  error: string | null;

  loadRuns: () => Promise<void>;
  selectRun: (id: string) => Promise<void>;
  selectSpan: (id: string) => void;
  toggleStep: (id: string) => void;
}

/** 跨进程数据不可信：统一用 schema 校验后再进状态 */
function describeZodError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export const useAppStore = create<AppState>((set, get) => ({
  runs: [],
  failed: [],
  detail: null,
  selectedRunId: null,
  selectedSpanId: null,
  expandedSteps: {},
  loadingList: false,
  loadingDetail: false,
  error: null,

  async loadRuns() {
    set({ loadingList: true, error: null });
    const envelope = await api.listRuns();
    if (!envelope.ok) {
      set({ loadingList: false, error: `读取 run 列表失败：${envelope.error.message}` });
      return;
    }
    const parsed = ListRunsDataSchema.safeParse(envelope.data);
    if (!parsed.success) {
      set({ loadingList: false, error: `列表数据结构校验失败：${describeZodError(parsed.error)}` });
      return;
    }
    set({ runs: parsed.data.runs, failed: parsed.data.failed, loadingList: false });
  },

  async selectRun(id) {
    if (get().selectedRunId === id) return;
    set({
      selectedRunId: id,
      selectedSpanId: null,
      detail: null,
      loadingDetail: true,
      error: null,
    });
    const envelope = await api.getRun(id);
    if (!envelope.ok) {
      set({ loadingDetail: false, error: `读取 run 失败：${envelope.error.message}` });
      return;
    }
    const parsed = RunDetailSchema.safeParse(envelope.data);
    if (!parsed.success) {
      set({
        loadingDetail: false,
        error: `轨迹数据结构校验失败：${describeZodError(parsed.error)}`,
      });
      return;
    }
    // 默认展开全部 step，用户可折叠
    const expandedSteps: Record<string, boolean> = {};
    for (const span of parsed.data.spans) {
      if (span.kind === "agent.step") expandedSteps[span.id] = true;
    }
    set({ detail: parsed.data, expandedSteps, loadingDetail: false });
  },

  selectSpan(id) {
    set({ selectedSpanId: id });
  },

  toggleStep(id) {
    const { expandedSteps } = get();
    set({ expandedSteps: { ...expandedSteps, [id]: !expandedSteps[id] } });
  },
}));
