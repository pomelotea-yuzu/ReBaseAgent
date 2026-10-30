import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  promptExperimentVerdictNote,
  promptExperimentViewOf,
} from "../src/renderer/src/lib/prompt-experiment-view";
import type { RunDetail } from "../src/shared/ipc";

/**
 * R2.2 6.6：v3 干预记录与结果入口的纯逻辑。
 *
 * 验收映射（desktop-ui）：
 * - 「比较到导出固定选中侧」：结果页/比较文件视图提供明确单侧入口（接线在源码断言）；
 * - 「正常结束和输出变化不冒充修复证据」：结局说明只复述事实 + 人工判据，不自动判定。
 */

function v3Meta(overrides: Record<string, unknown> = {}): RunDetail["meta"] {
  return {
    type: "run.meta",
    id: "run_child",
    parent: "run_root",
    format_version: 3,
    task: "实验",
    model: "m",
    created_at: "2026-10-21T00:00:00.000Z",
    config_hash: "sha256:x",
    fork: {
      at_span: "s_first",
      edit: { field: "system_prompt", value: "新的启动指令" },
    },
    workspace: {
      profile: "file-tools-v1",
      world_id: "run_child",
      write_authorized: true,
      initial_snapshot: { id: "a".repeat(64), files: [] },
      origin: { kind: "initial", run_id: "run_root", snapshot_id: "a".repeat(64) },
    },
    prompt_experiment: {
      baseline_run_id: "run_root",
      baseline_llm_span_id: "s_first",
      initial_snapshot_id: "a".repeat(64),
      original_value: "旧的启动指令",
      execution: {
        model: "baseline-model",
        params: { temperature: 0.2 },
        provider_endpoint: "https://api.example.com/v1",
        max_iterations: 8,
        budget: 40000,
        config_fingerprint: "fingerprint-1234567890",
      },
      hypothesis: "会多读一次配置",
      acceptance_criterion: "输出包含配置值",
    },
    ...overrides,
  } as unknown as RunDetail["meta"];
}

describe("promptExperimentViewOf：只读干预记录", () => {
  it("v3 记录：字段/原值/新值/假设/判据/执行条件齐全", () => {
    const view = promptExperimentViewOf(v3Meta());
    expect(view).not.toBeNull();
    if (view === null) throw new Error("应为 v3 视图");
    expect(view.field).toBe("system_prompt");
    expect(view.baselineRunId).toBe("run_root");
    expect(view.baselineLlmSpanId).toBe("s_first");
    expect(view.originalValue).toBe("旧的启动指令");
    expect(view.editedValue).toBe("新的启动指令");
    expect(view.hypothesis).toBe("会多读一次配置");
    expect(view.acceptanceCriterion).toBe("输出包含配置值");
    expect(view.execution.model).toBe("baseline-model");
    expect(view.execution.params).toBe('{"temperature":0.2}');
    expect(view.execution.providerEndpoint).toBe("https://api.example.com/v1");
    expect(view.execution.maxIterations).toBe(8);
    expect(view.execution.budget).toBe(40000);
  });

  it("非 v3（无 prompt_experiment）返回 null，普通运行不渲染干预区", () => {
    const meta = v3Meta();
    const { prompt_experiment: _removed, ...rest } = meta as Record<string, unknown>;
    expect(promptExperimentViewOf(rest as unknown as RunDetail["meta"])).toBeNull();
  });

  it("可选字段缺失如实为 null；params 缺省与空对象保持区别", () => {
    const noNotes = v3Meta({
      prompt_experiment: {
        ...(v3Meta().prompt_experiment as Record<string, unknown>),
        hypothesis: undefined,
        acceptance_criterion: undefined,
        execution: {
          ...((v3Meta().prompt_experiment as Record<string, unknown>).execution as Record<
            string,
            unknown
          >),
          params: undefined,
        },
      },
    });
    const view = promptExperimentViewOf(noNotes);
    expect(view?.hypothesis).toBeNull();
    expect(view?.acceptanceCriterion).toBeNull();
    expect(view?.execution.params).toContain("缺省");
  });
});

describe("promptExperimentVerdictNote：不自动判定修复", () => {
  it("正常结束也不写已修复/测试通过；有判据时交还人工核对", () => {
    const withCriterion = promptExperimentVerdictNote({
      status: "completed",
      acceptanceCriterion: "输出包含配置值",
    });
    expect(withCriterion).toContain("不代表改动已达到目的");
    expect(withCriterion).toContain("人工判据");
    expect(withCriterion).not.toContain("本次已修复");
    expect(withCriterion).not.toContain("测试通过");

    const without = promptExperimentVerdictNote({ status: "completed", acceptanceCriterion: null });
    expect(without).toContain("未填写人工判据");
  });

  it("失败/中断只复述事实，不补造成成功", () => {
    const note = promptExperimentVerdictNote({ status: "crashed", acceptanceCriterion: null });
    expect(note).toContain("未正常结束");
    expect(note).not.toContain("本次已修复");
    expect(note).not.toContain("测试通过");
  });
});

describe("6.6 接线契约", () => {
  const read = (path: string): string =>
    readFileSync(resolve(import.meta.dirname, "../src/renderer/src", path), "utf8");

  it("结果概览渲染干预区，并提供与基线比较/文件导出入口", () => {
    const src = read("components/OverviewPanel.tsx");
    expect(src).toContain("PromptExperimentSectionView");
    expect(src).toContain("promptExperimentViewOf(detail.meta)");
    expect(src).toContain("data-prompt-experiment-compare");
    expect(src).toContain("data-prompt-experiment-files");
    expect(src).toContain("data-prompt-experiment-verdict");
    expect(src).toContain("openCompareWithParent");
  });

  it("比较文件视图提供固定该侧检查点的导出入口（复用 R2.1 文件页）", () => {
    const src = read("components/CompareFileWorkspace.tsx");
    expect(src).toContain("data-compare-file-export-side");
    expect(src).toContain("openCompareSideFilesAt");
    expect(src).toContain("state.selection.stepSpanId, currentPath");
    expect(src).toContain("compare.fileExportHint");
  });

  it("导出方向说明仍绑定该 run 初始快照，不相对比较另一侧", () => {
    const compareSide = read("store/slices/compare.ts");
    expect(compareSide).toContain("openCompareSideFilesAt");
    expect(compareSide).toContain("setFileReading(runId");
    const overview = read("components/OverviewPanel.tsx");
    expect(overview).toContain('"run.promptExperimentNote"');
  });
});
