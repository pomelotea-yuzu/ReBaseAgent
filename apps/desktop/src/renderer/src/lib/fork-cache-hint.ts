/**
 * 分叉形态 → 缓存提示判据（spec `desktop-ui`「缓存命中可视化」第三条）。
 *
 * spec 原文：**仅 tool_result 分叉**的确认编辑器 SHALL 在当前运行配置的 `model`
 * 与父 run 该 step 录制的 `model` 不一致时给出「缓存可能不命中、计费口径可能变化」
 * 的**信息性**提示；SHALL NOT 拦截或改变 fork 门禁，**prompt fork 与代理 messages
 * 分叉 SHALL NOT 加此提示**。
 *
 * 为什么要把这条抽成纯函数：原先这段判断内联在 `ForkEditor`（一个重度依赖 store 的
 * 组件）里，本包无 jsdom ⇒ 「prompt fork 不该有提示」「模型一致时不该有提示」这两条
 * **负面**判据在 UI 层根本断言不到，只能靠人眼。
 *
 * ⚠️ 两个容易搞混的边界：
 *   1. **提示与门禁是两回事**：`hint !== null` 只影响“说不说这句话”，
 *      `canSubmit` / `capability` 等既有闸门一个字都不动（spec 明写不得拦截）。
 *   2. **「未知」不是「不一致」**：父模型或当前配置模型任一为 `null`（缺记录 / 未配置）
 *      时**不给提示**——凭空说“可能不命中”是把“不知道”说成“有风险”。
 */

/** 分叉形态；只有 `"tool-result"` 共享前缀，缓存提示才有意义 */
export type ForkKind = "tool-result" | "prompt" | "proxy-messages";

export interface ForkCacheHintInput {
  /** 分叉形态（由调用方按入口确定） */
  kind: ForkKind;
  /** 父 run 该 step 录制的模型；缺记录为 null */
  parentModel: string | null;
  /** 当前运行配置的模型；未配置为 null */
  configModel: string | null;
}

export interface ForkCacheHint {
  /** 父 run 该步录制的模型（提示文案里点名用） */
  parentModel: string;
  /** 当前运行配置的模型（提示文案里点名用） */
  configModel: string;
  /** 完整提示文案（唯一文案来源） */
  text: string;
  /** 该提示是信息性的，不改变门禁（spec 显式要求，供测试钉住） */
  informational: true;
}

/**
 * 算出该分叉入口要不要给缓存提示；`null` = 不给（形态不符 / 模型一致 / 任一未知）。
 */
export function forkCacheHint(input: ForkCacheHintInput): ForkCacheHint | null {
  // 只有 tool_result 分叉共享父前缀：其它形态（prompt fork / 代理 messages）根本不
  // 沿用父上下文，谈"前缀缓存"是无意义的——spec 明令不加此提示。
  if (input.kind !== "tool-result") return null;
  // 未知 ≠ 不一致：任一为 null 就不说，不把"不知道"包装成"有风险"
  if (input.parentModel === null || input.configModel === null) return null;
  if (input.parentModel === input.configModel) return null;

  return {
    parentModel: input.parentModel,
    configModel: input.configModel,
    text: `父 run 该步使用 ${input.parentModel}，当前运行配置为 ${input.configModel}——前缀缓存可能不命中，计费口径可能变化（仅提示，不阻止重跑）。`,
    informational: true,
  };
}
