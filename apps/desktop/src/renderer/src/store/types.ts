// AppState 聚合（refactor-renderer 4.1）：8 个分片接口交叉组合成完整类型。
// 单一实现仍在 store.ts 的唯一 create；本文件只做类型组合（design D2「聚合文件只负责交叉类型组合」）。
import type { CompareState } from "./slices/compare";
import type { ConfigurationState } from "./slices/configuration";
import type { DraftsState } from "./slices/drafts";
import type { NavigationState } from "./slices/navigation";
import type { OperationsState } from "./slices/operations";
import type { ReadingState } from "./slices/reading";
import type { ResultsState } from "./slices/results";
import type { RunsState } from "./slices/runs";

export type AppState = RunsState &
  ReadingState &
  DraftsState &
  OperationsState &
  ResultsState &
  CompareState &
  NavigationState &
  ConfigurationState;
