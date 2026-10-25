// AppState 分片：Verification 域（R3 任务 5.1）。
// 工厂以完整 store 的 set/get 为上下文（design D2：无第二 create、不导入 useAppStore）。
// 本分片持有 R3 验证的**核对与确认**状态：显式 selector、capability/preparePlan 只读
// 核对缓存（代次守卫）、两份独立确认（准备/执行）与提交呈现面。提交动作住在
// operations 分片（唯一提交适配器 submitActive 在它的闭包里），经本分片公开的
// action 驱动这里的状态——跨分片调用走执行时 get()（design D2）。
import type {
  VerificationCapabilityResult,
  VerificationCheckpoint,
  VerificationPreparePlanResult,
} from "@shared/ipc";
import {
  VerificationCapabilityResultSchema,
  VerificationPreparePlanResultSchema,
} from "@shared/ipc";
import { api } from "../../lib/api";
import { describeZodError } from "../../lib/describe-zod-error";
import {
  type VerificationArmedConfirmation,
  type VerificationTargetRef,
  verificationTargetKey,
} from "../../lib/verification-entry";
import type { SliceContext } from "../types";

/** 提交呈现面（5.1 最小面：请求收尾 + 领域结局一行；完整分层呈现归 5.2/5.4） */
export interface VerificationOutcomeView {
  readonly kind: "prepare" | "run";
  /** 提交那一刻的显式目标键（迟到结果不得显示在新目标下） */
  readonly targetKey: string;
  /** 提交那一刻的目标代次（open/close 推进；不匹配 ⇒ 丢弃） */
  readonly atOutcomeGeneration: number;
  /** prepare 成功时：真实创建的准备记录身份 + 镜像事实 */
  readonly preparationId?: string;
  readonly imageDigest?: string;
  /** run 返回时：请求收尾（ok 信封）+ 领域结局（D04 分层的原始事实，5.2 精化） */
  readonly verificationId?: string;
  readonly outcome?: string;
  readonly detail?: string;
  readonly evidenceComplete?: boolean;
}

/** 提交失败的呈现面（请求层失败：门内拒绝稳定码 / 本地拒发） */
export interface VerificationSubmitError {
  readonly code: string;
  readonly message: string;
}

export interface VerificationState {
  /**
   * 显式 selector：只有「打开验证面板」这个显式动作能写它；检查点选择器的变化
   * 绝不无声改写 target（design D3「UI 不得无声换点」——换点必须重新打开面板）。
   */
  verificationTarget: VerificationTargetRef | null;
  /** 只读核对结果（capability）；null = 尚未核对/已随目标重置 */
  verificationCapability: VerificationCapabilityResult | null;
  verificationCapabilityState: "idle" | "loading" | "ready" | "error";
  verificationCapabilityError: { code: string; message: string } | null;
  /** 核对代次：发出请求前捕获，迟到响应按代次整包丢弃 */
  verificationCapabilityGeneration: number;
  /** 固定准备计划预览（preparePlan） */
  verificationPlan: VerificationPreparePlanResult | null;
  verificationPlanState: "idle" | "loading" | "ready" | "error";
  verificationPlanError: { code: string; message: string } | null;
  verificationPlanGeneration: number;
  /** 执行确认绑定的固定命令（选择器状态；确认绑定它的当下值） */
  verificationCommand: "typecheck" | "test";
  /**
   * 两份**独立**确认（D02：准备与执行许可不互相替代）。
   * 失效不靠"记得清"：判定是现算比对（`decideVerificationConfirmation`），
   * 目标/计划 token/命令任一漂移 ⇒ stale。
   */
  verificationPrepareConfirmation: VerificationArmedConfirmation | null;
  verificationRunConfirmation: VerificationArmedConfirmation | null;
  /** 目标代次：open/close 推进；提交结果按代次 + 目标键守卫（迟到结果不显示在新目标下） */
  verificationOutcomeGeneration: number;
  /** 请求在飞标记（请求层；领域结局另见 lastOutcome） */
  verificationSubmitting: "idle" | "prepare" | "run";
  verificationSubmitError: VerificationSubmitError | null;
  verificationLastOutcome: VerificationOutcomeView | null;
}

export interface VerificationSliceActions {
  /**
   * 显式进入验证核对（检查点入口的唯一写入口）：绑定当前显式 selector，清空旧核对/
   * 旧确认/旧结果（新目标必须重新核对），并自动发起 capability + preparePlan 两个只读加载。
   */
  openVerification: (runId: string, checkpoint: VerificationCheckpoint) => void;
  /** 收起面板：整域复位（target 清空 ⇒ 一切确认自然失效） */
  closeVerification: () => void;
  /** 重新核对（只读）：capability 聚合（来源/环境/引擎/当前计划 token） */
  refreshVerificationCapability: () => Promise<void>;
  /** 重新加载固定准备计划预览（只读） */
  loadVerificationPreparePlan: () => Promise<void>;
  /** 切换固定命令选择（确认绑定命令：切换后旧执行确认现算判 stale） */
  setVerificationCommand: (commandId: "typecheck" | "test") => void;
  /** 显式确认环境准备（绑定当前计划 token 与目标；核对缺失时拒绝武装） */
  confirmVerificationPrepare: () => boolean;
  /** 显式确认固定检查执行（另绑定当前选择的命令） */
  confirmVerificationRun: () => boolean;
  /** 撤销两份确认（换检查点/显式放弃时调用；面板收起走 closeVerification 全清） */
  revokeVerificationConfirmations: () => void;

  // —— 提交呈现面的驱动口（operations 分片的提交动作调用；组件不直接调）——
  beginVerificationSubmit: (kind: "prepare" | "run") => void;
  endVerificationSubmit: () => void;
  /** 提交失败（请求层失败或本地拒发）；迟到失败按代次丢弃 */
  failVerificationSubmit: (error: VerificationSubmitError, atOutcomeGeneration?: number) => void;
  /** 提交明确返回（ok 信封）；迟到结果按代次 + 目标键丢弃 */
  noteVerificationOutcome: (
    outcome: Omit<VerificationOutcomeView, "targetKey" | "atOutcomeGeneration">,
    atOutcomeGeneration: number,
  ) => void;
}

export type VerificationSlice = VerificationState & VerificationSliceActions;

/** 目标代次的起点（open/close 各推进一次；0 = 从未打开） */
const INITIAL_OUTCOME_GENERATION = 0;

export function initialVerificationState(): VerificationState {
  return {
    verificationTarget: null,
    verificationCapability: null,
    verificationCapabilityState: "idle",
    verificationCapabilityError: null,
    verificationCapabilityGeneration: 0,
    verificationPlan: null,
    verificationPlanState: "idle",
    verificationPlanError: null,
    verificationPlanGeneration: 0,
    verificationCommand: "test",
    verificationPrepareConfirmation: null,
    verificationRunConfirmation: null,
    verificationOutcomeGeneration: INITIAL_OUTCOME_GENERATION,
    verificationSubmitting: "idle",
    verificationSubmitError: null,
    verificationLastOutcome: null,
  };
}

export function createVerificationSlice({ set, get }: SliceContext): VerificationSlice {
  /**
   * 内容字段的复位形状。⚠️ 三个代次计数**不在复位面**：它们是分片全生命周期的单调
   * 计数器——若随 open 清零，「开目标 A → 开目标 B」后 A 的迟到响应会与 B 的新请求
   * 同代次碰撞，迟到守卫失效。open/close 清的是内容（核对/确认/呈现），代次只进不退。
   */
  const resetContent = () => ({
    verificationTarget: null,
    verificationCapability: null,
    verificationCapabilityState: "idle" as const,
    verificationCapabilityError: null,
    verificationPlan: null,
    verificationPlanState: "idle" as const,
    verificationPlanError: null,
    verificationCommand: "test" as const,
    verificationPrepareConfirmation: null,
    verificationRunConfirmation: null,
    verificationSubmitting: "idle" as const,
    verificationSubmitError: null,
    verificationLastOutcome: null,
  });

  return {
    ...initialVerificationState(),

    openVerification(runId, checkpoint) {
      const target: VerificationTargetRef = { runId, checkpoint };
      set((state) => ({
        ...resetContent(),
        verificationTarget: target,
        verificationOutcomeGeneration: state.verificationOutcomeGeneration + 1,
      }));
      void get().refreshVerificationCapability();
      void get().loadVerificationPreparePlan();
    },

    closeVerification() {
      set((state) => ({
        ...resetContent(),
        verificationOutcomeGeneration: state.verificationOutcomeGeneration + 1,
      }));
    },

    async refreshVerificationCapability() {
      const target = get().verificationTarget;
      if (target === null) return;
      const commandId = get().verificationCommand;
      // 代次先捕获再发请求：期间的目标切换/重开让本响应整包过期（迟到响应不覆盖新核对）
      const generation = get().verificationCapabilityGeneration + 1;
      set((state) => ({
        verificationCapabilityGeneration: generation,
        verificationCapabilityState: "loading",
        verificationCapabilityError: null,
      }));
      let envelope: Awaited<ReturnType<typeof api.verificationCapability>>;
      try {
        envelope = await api.verificationCapability({
          runId: target.runId,
          checkpoint: target.checkpoint,
          profileId: "node-ts-v1",
          commandId,
        });
      } catch (error) {
        if (get().verificationCapabilityGeneration !== generation) return;
        set({
          verificationCapabilityState: "error",
          verificationCapabilityError: {
            code: "R3_CAPABILITY_CHANNEL_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
        });
        return;
      }
      if (get().verificationCapabilityGeneration !== generation) return;
      if (!envelope.ok) {
        set({
          verificationCapabilityState: "error",
          verificationCapabilityError: {
            code: envelope.error.code,
            message: envelope.error.message,
          },
        });
        return;
      }
      // 跨进程数据不可信：确认卡的数字原样展示给用户，先校验形状（不合法整包丢弃）
      const parsed = VerificationCapabilityResultSchema.safeParse(envelope.data);
      if (!parsed.success) {
        set({
          verificationCapabilityState: "error",
          verificationCapabilityError: {
            code: "R3_CAPABILITY_SCHEMA_INVALID",
            message: `核对结果结构校验失败：${describeZodError(parsed.error)}`,
          },
        });
        return;
      }
      set({
        verificationCapability: parsed.data,
        verificationCapabilityState: "ready" as const,
        verificationCapabilityError: null,
      });
    },

    async loadVerificationPreparePlan() {
      const generation = get().verificationPlanGeneration + 1;
      set((state) => ({
        verificationPlanGeneration: generation,
        verificationPlanState: "loading",
        verificationPlanError: null,
      }));
      let envelope: Awaited<ReturnType<typeof api.verificationPreparePlan>>;
      try {
        envelope = await api.verificationPreparePlan({ profileId: "node-ts-v1" });
      } catch (error) {
        if (get().verificationPlanGeneration !== generation) return;
        set({
          verificationPlanState: "error",
          verificationPlanError: {
            code: "R3_PLAN_CHANNEL_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
        });
        return;
      }
      if (get().verificationPlanGeneration !== generation) return;
      if (!envelope.ok) {
        set({
          verificationPlanState: "error",
          verificationPlanError: { code: envelope.error.code, message: envelope.error.message },
        });
        return;
      }
      const parsed = VerificationPreparePlanResultSchema.safeParse(envelope.data);
      if (!parsed.success) {
        set({
          verificationPlanState: "error",
          verificationPlanError: {
            code: "R3_PLAN_SCHEMA_INVALID",
            message: `计划预览结构校验失败：${describeZodError(parsed.error)}`,
          },
        });
        return;
      }
      set({
        verificationPlan: parsed.data,
        verificationPlanState: "ready" as const,
        verificationPlanError: null,
      });
    },

    setVerificationCommand(commandId) {
      set({ verificationCommand: commandId });
    },

    confirmVerificationPrepare() {
      const state = get();
      // 没有当前核对就没有可绑定的计划 token：拒绝武装（不是"先确认后核对"）
      if (state.verificationTarget === null || state.verificationCapability === null) return false;
      set({
        verificationPrepareConfirmation: {
          planToken: state.verificationCapability.planToken,
          targetKey: verificationTargetKey(state.verificationTarget),
        },
      });
      return true;
    },

    confirmVerificationRun() {
      const state = get();
      if (state.verificationTarget === null || state.verificationCapability === null) return false;
      set({
        verificationRunConfirmation: {
          planToken: state.verificationCapability.planToken,
          targetKey: verificationTargetKey(state.verificationTarget),
          commandId: state.verificationCommand,
        },
      });
      return true;
    },

    revokeVerificationConfirmations() {
      set({
        verificationPrepareConfirmation: null,
        verificationRunConfirmation: null,
      });
    },

    beginVerificationSubmit(kind) {
      set({ verificationSubmitting: kind, verificationSubmitError: null });
    },

    endVerificationSubmit() {
      set({ verificationSubmitting: "idle" });
    },

    failVerificationSubmit(error, atOutcomeGeneration) {
      // 迟到失败守卫：提交期间目标已切换/收起 ⇒ 这条失败已不属于当前目标，整包丢弃
      if (
        atOutcomeGeneration !== undefined &&
        atOutcomeGeneration !== get().verificationOutcomeGeneration
      ) {
        return;
      }
      set({ verificationSubmitError: error });
    },

    noteVerificationOutcome(outcome, atOutcomeGeneration) {
      const state = get();
      if (state.verificationTarget === null) return;
      if (atOutcomeGeneration !== state.verificationOutcomeGeneration) return;
      set({
        verificationLastOutcome: {
          ...outcome,
          targetKey: verificationTargetKey(state.verificationTarget),
          atOutcomeGeneration,
        },
      });
    },
  };
}
