import type { WorkspaceInspectResult } from "@shared/ipc";
import type { CheckpointOption } from "../../lib/workspace-files";

/** 清单结果别名（语义名：当前检查点下的目录清单） */
export type Selected = WorkspaceInspectResult;

/** 检查点选择项：每次选择都要带上 stepSpanId（null = 初始） */
export interface Selection {
  readonly stepSpanId: string | null;
}

/** 选择项文案（当前检查点的可读名，用于 diff 右侧标题） */
export function checkpointLabel(
  options: readonly CheckpointOption[],
  stepSpanId: string | null,
): string {
  const found = options.find((option) => option.stepSpanId === stepSpanId);
  return found?.label ?? "本 run 当前检查点";
}
