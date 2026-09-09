import type {
  FailedFile,
  ModelAbResult,
  ProxyState,
  ProxyToggleInput,
  RunDetail,
  RunSummary,
  SettingsInput,
  SettingsState,
} from "@shared/ipc";
import type { ModelAbArm, PromptForkRequest } from "@shared/ipc";
import {
  ListRunsDataSchema,
  ProxyStateSchema,
  RunDetailSchema,
  SettingsStateSchema,
} from "@shared/ipc";
import { create } from "zustand";
import { api } from "./lib/api";

/**
 * UI 状态：只存选择状态与原始数据。
 * 聚合数字一律在组件里用 shared/derive 的纯函数现算，不进 store、不落缓存。
 */

/** 分支对照的条数上限：再多是界面放不下，也失去了"并排看"的意义 */
export const MAX_COMPARE = 4;
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

  /** 本地录制代理状态（不含 key 值；null = 尚未加载） */
  proxy: ProxyState | null;
  /** run 列表来源过滤 */
  sourceFilter: "all" | "proxy" | "local";

  /**
   * 主区域视图：trace = 既有三栏（列表 / span 树 / 详情），tree = 分支树。
   * 纯 UI 状态，不进 IPC、不持久化（design D7）。
   */
  view: "trace" | "tree";
  /** 加入对照的 run id（上限 4，分支树的 ComparePanel 消费） */
  compareIds: string[];
  /** 对照集合的操作提示（超上限等），空则无提示 */
  compareNotice: string | null;

  loadRuns: () => Promise<void>;
  selectRun: (id: string) => Promise<void>;
  selectSpan: (id: string) => void;
  toggleStep: (id: string) => void;

  /** 编辑某 tool.invoke 的 result 并重跑；成功刷新列表并自动选中新 run */
  forkAt: (parentRunId: string, atSpanId: string, value: string) => Promise<boolean>;
  /** prompt fork：编辑启动上下文（system prompt / 首条 user message）从头重跑 */
  promptFork: (parentRunId: string, edit: PromptForkRequest["edit"]) => Promise<boolean>;
  /**
   * 模型 A/B：dryRun = true 只校验并返回计划（不联网、不写文件）；
   * 真实执行成功后刷新列表（新 run 带实验组徽章），返回各臂计划与结果。
   */
  modelAb: (
    parentRunId: string,
    arms: ModelAbArm[],
    dryRun: boolean,
  ) => Promise<ModelAbResult | null>;
  /** 打开新的 A/B 编辑前复位状态 */
  resetModelAb: () => void;
  /** A/B 实验进行中（与 fork 状态分离，两者可并存于不同编辑器） */
  modelAbInFlight: boolean;
  modelAbError: string | null;
  modelAbErrorCode: string | null;
  /** 打开新的分叉编辑前复位状态 */
  resetFork: () => void;

  loadSettings: () => Promise<void>;
  saveSettings: (input: SettingsInput) => Promise<boolean>;
  clearSettings: () => Promise<boolean>;

  loadProxyStatus: () => Promise<void>;
  /** 启停即保存（端口/upstream 一并生效）；失败返回 null 并在 error 里给出原因 */
  toggleProxy: (input: ProxyToggleInput) => Promise<ProxyState | null>;
  setSourceFilter: (filter: "all" | "proxy" | "local") => void;

  /** 切换主区域视图；只改 UI 状态，不触发列表重新加载（design D7） */
  setView: (view: "trace" | "tree") => void;
  /** 勾选/取消对照（上限 4，超出不加入并给出提示） */
  toggleCompare: (runId: string) => void;
  clearCompare: () => void;
  /** 代理分叉（编辑 messages 经代理重发）；成功刷新列表并自动选中新 run */
  proxyFork: (
    parentRunId: string,
    atSpanId: string,
    messages: Record<string, unknown>[],
  ) => Promise<boolean>;
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
  modelAbInFlight: false,
  modelAbError: null,
  modelAbErrorCode: null,
  settings: null,
  proxy: null,
  sourceFilter: "all",
  view: "trace",
  compareIds: [],
  compareNotice: null,

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

  async promptFork(parentRunId, edit) {
    set({ forking: "in_progress", forkError: null, forkErrorCode: null });
    const envelope = await api.promptFork({ parentRunId, edit });
    if (!envelope.ok) {
      set({
        forking: "error",
        forkError: envelope.error.message,
        forkErrorCode: envelope.error.code,
      });
      return false;
    }
    // 成功：刷新列表并选中新 run（独立新轨迹 + 父级溯源；失败时不产生伪 run）
    set({ forking: "success" });
    await get().loadRuns();
    await get().selectRun(envelope.data.id);
    return true;
  },

  async modelAb(parentRunId, arms, dryRun) {
    set({ modelAbInFlight: true, modelAbError: null, modelAbErrorCode: null });
    const envelope = await api.modelAb({ parentRunId, arms, dryRun });
    if (!envelope.ok) {
      set({
        modelAbInFlight: false,
        modelAbError: envelope.error.message,
        modelAbErrorCode: envelope.error.code,
      });
      return null;
    }
    set({ modelAbInFlight: false });
    if (dryRun) return envelope.data;
    // 真实执行：刷新列表（各臂新 run 带实验组徽章）；多臂不自动聚焦，由用户在树里挑
    await get().loadRuns();
    return envelope.data;
  },

  resetModelAb() {
    set({ modelAbInFlight: false, modelAbError: null, modelAbErrorCode: null });
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

  async loadProxyStatus() {
    const envelope = await api.proxyStatus();
    if (!envelope.ok) {
      set({ proxy: null, error: `读取代理状态失败：${envelope.error.message}` });
      return;
    }
    const parsed = ProxyStateSchema.safeParse(envelope.data);
    if (!parsed.success) {
      set({ proxy: null, error: `代理状态数据结构校验失败：${describeZodError(parsed.error)}` });
      return;
    }
    set({ proxy: parsed.data });
  },

  async toggleProxy(input) {
    set({ error: null });
    const envelope = await api.proxyToggle(input);
    if (!envelope.ok) {
      set({ error: `代理操作失败：${envelope.error.message}` });
      return null;
    }
    const parsed = ProxyStateSchema.safeParse(envelope.data);
    if (!parsed.success) {
      set({ error: `代理状态数据结构校验失败：${describeZodError(parsed.error)}` });
      return null;
    }
    set({ proxy: parsed.data });
    return parsed.data;
  },

  setSourceFilter(filter) {
    set({ sourceFilter: filter });
  },

  setView(view) {
    set({ view });
  },

  toggleCompare(runId) {
    const { compareIds } = get();
    if (compareIds.includes(runId)) {
      set({
        compareIds: compareIds.filter((id) => id !== runId),
        compareNotice: null,
      });
      return;
    }
    if (compareIds.length >= MAX_COMPARE) {
      set({ compareNotice: `最多同时对照 ${MAX_COMPARE} 条运行` });
      return;
    }
    set({ compareIds: [...compareIds, runId], compareNotice: null });
  },

  clearCompare() {
    set({ compareIds: [], compareNotice: null });
  },

  async proxyFork(parentRunId, atSpanId, messages) {
    set({ forking: "in_progress", forkError: null, forkErrorCode: null });
    const envelope = await api.proxyFork({ parentRunId, atSpanId, messages });
    if (!envelope.ok) {
      set({
        forking: "error",
        forkError: envelope.error.message,
        forkErrorCode: envelope.error.code,
      });
      return false;
    }
    set({ forking: "success" });
    await get().loadRuns();
    await get().selectRun(envelope.data.id);
    return true;
  },
}));
