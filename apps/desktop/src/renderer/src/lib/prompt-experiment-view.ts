import type { Translator } from "@rebaseagent/i18n";
import type { RunDetail } from "@shared/ipc";

/**
 * R2.2 6.6：v3 隔离 prompt 实验在结果页的只读呈现。
 *
 * 三条纪律：
 * - 只展示**实际记录**的干预与结局，不把"正常结束/输出变化"自动判成修复；
 * - 人工判据是用户文字，不自动执行、不评分、不显示"测试通过"；
 * - 未知计费不补零；比较与导出都先定位到明确单侧/自有检查点。
 */

export interface PromptExperimentExecutionView {
  readonly model: string;
  readonly params: string;
  readonly providerEndpoint: string;
  readonly maxIterations: number;
  readonly budget: number;
  readonly configFingerprint: string;
}

export interface PromptExperimentView {
  readonly field: "system_prompt" | "user_message";
  readonly fieldLabel: string;
  readonly baselineRunId: string;
  readonly baselineLlmSpanId: string;
  readonly initialSnapshotId: string;
  readonly originalValue: string;
  readonly editedValue: string;
  readonly hypothesis: string | null;
  readonly acceptanceCriterion: string | null;
  readonly execution: PromptExperimentExecutionView;
}

function paramsLabel(
  params: PromptExperimentExecutionView["params"] | undefined,
  translator: Translator,
): string {
  if (params === undefined) return translator.t("run.promptExperimentParamsMissing");
  return params;
}

/** v3 实验记录 → 结果页只读视图；非 v3 返回 null（普通运行不渲染本区） */
export function promptExperimentViewOf(
  meta: RunDetail["meta"],
  translator: Translator,
): PromptExperimentView | null {
  const experiment = meta.prompt_experiment;
  if (experiment === undefined) return null;
  const forkField = meta.fork?.edit.field;
  const field = forkField === "user_message" ? "user_message" : "system_prompt";
  const edited = meta.fork?.edit.value;
  return {
    field,
    fieldLabel:
      field === "user_message"
        ? translator.t("run.promptExperimentFieldUser")
        : translator.t("run.promptExperimentFieldSystem"),
    baselineRunId: experiment.baseline_run_id,
    baselineLlmSpanId: experiment.baseline_llm_span_id,
    initialSnapshotId: experiment.initial_snapshot_id,
    originalValue: experiment.original_value,
    editedValue: typeof edited === "string" ? edited : "",
    hypothesis: experiment.hypothesis ?? null,
    acceptanceCriterion: experiment.acceptance_criterion ?? null,
    execution: {
      model: experiment.execution.model,
      params: paramsLabel(
        experiment.execution.params === undefined
          ? undefined
          : JSON.stringify(experiment.execution.params),
        translator,
      ),
      providerEndpoint: experiment.execution.provider_endpoint,
      maxIterations: experiment.execution.max_iterations,
      budget: experiment.execution.budget,
      configFingerprint: experiment.execution.config_fingerprint,
    },
  };
}

/**
 * 结局说明：只复述运行事实，并明确"不自动判定修复"。
 * 人工判据存在时提示按判据自行核对；不存在时也不补造。
 */
export function promptExperimentVerdictNote(
  input: {
    readonly status: "completed" | "crashed";
    readonly acceptanceCriterion: string | null;
  },
  translator: Translator,
): string {
  const base =
    input.status === "completed"
      ? translator.t("run.promptExperimentVerdictCompleted")
      : translator.t("run.promptExperimentVerdictCrashed");
  return input.acceptanceCriterion === null
    ? translator.t("run.promptExperimentVerdictNoCriterion", { base })
    : translator.t("run.promptExperimentVerdictWithCriterion", { base });
}
