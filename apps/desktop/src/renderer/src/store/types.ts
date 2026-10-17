// AppState 聚合（refactor-renderer 4.1）：8 个分片接口交叉组合成完整类型。
// 单一实现仍在 store.ts 的唯一 create；本文件只做类型组合（design D2「聚合文件只负责交叉类型组合」）。
// 5.1 起分片实现工厂经 SliceContext 以完整 store 的 set/get 为上下文（无第二 create、不导入 useAppStore）。
import type { StoreApi } from "zustand";
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

/**
 * 分片工厂的共享上下文（design D2）：与 `create<AppState>` 回调里的 `set`/`get` 同型。
 * 跨域写入经由它保持原子边界；跨分片**调用**一律走执行时 `get()` 的 action 或
 * 显式注入的协调函数（各分片的 *SliceContext 扩展），分片之间无运行时互相导入。
 */
export interface SliceContext {
  set: StoreApi<AppState>["setState"];
  get: StoreApi<AppState>["getState"];
}
