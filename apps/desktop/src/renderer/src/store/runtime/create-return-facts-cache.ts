// 派生缓存 runtime（refactor-renderer 4.4）：`createReturnFactsOf` 的**按引用缓存**
// ——zustand v5 getSnapshot 引用稳定纪律的唯一资源所有者。
//
// 该方法被 selector 直接消费（CreateRunWorkspace「useAppStore((s) => s.createReturnFactsOf())」）；
// 返回值只由 `createReturnLocation` 与 `runs` 两个引用决定 ⇒ 输入引用都没变就返回
// 同一对象（2026-10-15 实机坐实：不缓存会让 getSnapshot 恒新 ⇒ 无限重渲染
// ⇒ 创建页整树卸载白屏）。缓存是派生资源，不是 UI 状态。
//
// 判据本体（decideCreateReturn + 文案派生）仍由 store 的 action 提供（`compute` 回调），
// 本模块只管"按引用命中/失效重建"这一件事；由 store.ts 按实例组合一次（design D3）。
import type { RunSummary } from "@shared/ipc";
import type { CreateReturnFacts, CreateReturnLocation } from "../../lib/create-workspace";

/** 缓存键 = 两个输入引用（浅比较 `===`，与搬迁前逐字一致） */
export interface CreateReturnFactsInputs {
  location: CreateReturnLocation | null;
  runs: RunSummary[];
}

export interface CreateReturnFactsCacheRuntime {
  /** 命中则交回同一 facts 对象；未命中才调用 `compute` 重建并登记 */
  factsOf(
    inputs: CreateReturnFactsInputs,
    compute: (inputs: CreateReturnFactsInputs) => CreateReturnFacts,
  ): CreateReturnFacts;
}

export function createCreateReturnFactsCache(): CreateReturnFactsCacheRuntime {
  let cache: {
    location: CreateReturnLocation | null;
    runs: RunSummary[];
    facts: CreateReturnFacts;
  } | null = null;

  return {
    factsOf(inputs, compute) {
      const hit = cache;
      if (hit !== null && hit.location === inputs.location && hit.runs === inputs.runs) {
        return hit.facts;
      }
      const facts = compute(inputs);
      cache = {
        location: inputs.location,
        runs: inputs.runs,
        facts,
      };
      return facts;
    },
  };
}
