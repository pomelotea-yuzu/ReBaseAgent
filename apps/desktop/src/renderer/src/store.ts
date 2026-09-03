import type { FailedFile, RunDetail, RunSummary, SettingsInput, SettingsState } from "@shared/ipc";
import { ListRunsDataSchema, RunDetailSchema, SettingsStateSchema } from "@shared/ipc";
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

  /** 分叉重跑进行中状态（runs:fork 的唯一写通道） */
  forking: "idle" | "in_progress" | "success" | "error";
  /** 分叉失败的展示信息（来自信封 error） */
  forkError: string | null;
  /** 分叉失败的错误码（渲染层据此给针对性提示，如未配置） */
  forkErrorCode: string | null;

  /** 运行配置状态（不含 apiKey；null = 尚未加载成功） */
  settings: SettingsState | null;

  loadRuns: () => Promise<void>;
  selectRun: (id: string) => Promise<void>;
  selectSpan: (id: string) => void;
  toggleStep: (id: string) => void;

  /** 编辑某 tool.invoke 的 result 并重跑；成功刷新列表并自动选中新 run */
  forkAt: (parentRunId: string, atSpanId: string, value: string) => Promise<boolean>;
  /** 打开新的分叉编辑前复位状态 */
  resetFork: () => void;

  loadSettings: () => Promise<void>;
  saveSettings: (input: SettingsInput) => Promise<boolean>;
  clearSettings: () => Promise<boolean>;
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

  forking: "idle",
  forkError: null,
  forkErrorCode: null,
  settings: null,

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

  async forkAt(parentRunId, atSpanId, value) {
    set({ forking: "in_progress", forkError: null, forkErrorCode: null });
    const envelope = await api.forkRun({
      parentRunId,
      atSpanId,
      edit: { field: "result", value },
    });
    if (!envelope.ok) {
      set({
        forking: "error",
        forkError: envelope.error.message,
        forkErrorCode: envelope.error.code,
      });
      return false;
    }
    // 成功：刷新列表（新 run 带分支徽章）并自动选中新 run（合并轨迹 + 分叉点标注）
    set({ forking: "success" });
    await get().loadRuns();
    await get().selectRun(envelope.data.id);
    return true;
  },

  resetFork() {
    set({ forking: "idle", forkError: null, forkErrorCode: null });
  },

  async loadSettings() {
    const envelope = await api.getSettings();
    if (!envelope.ok) {
      set({ settings: null, error: `读取运行配置失败：${envelope.error.message}` });
      return;
    }
    const parsed = SettingsStateSchema.safeParse(envelope.data);
    if (!parsed.success) {
      set({ settings: null, error: `运行配置数据结构校验失败：${describeZodError(parsed.error)}` });
      return;
    }
    set({ settings: parsed.data });
  },

  async saveSettings(input) {
    const envelope = await api.saveSettings(input);
    if (!envelope.ok) {
      set({ error: `保存运行配置失败：${envelope.error.message}` });
      return false;
    }
    // 回读状态（baseURL/model/加密方式；apiKey 永不回传）
    await get().loadSettings();
    return true;
  },

  async clearSettings() {
    const envelope = await api.clearSettings();
    if (!envelope.ok) {
      set({ error: `清除运行配置失败：${envelope.error.message}` });
      return false;
    }
    set({ settings: null });
    return true;
  },
}));
