import { randomUUID } from "node:crypto";
import type { RunSettings, SettingsStore } from "./settings";

/**
 * main 会话内唯一的**执行配置修订**（R2.2 design D2/5.2）。
 *
 * `configRevision` 是 main 生成的不透明标识：不是密钥、不是可重用授权，**不写 trace/
 * operation、不回传密钥**。它的唯一用途是让"用户确认过的计划"绑定到"当前实际生效的
 * 运行配置"——端点、凭据、模型或执行限制变化后，旧确认必须失效。
 *
 * 为什么不用 secret 哈希：修订不是配置的承诺，也不是跨会话可比对的指纹；把密钥派生物
 * 放进任何可观察字段都等于多一个泄漏面。这里只在 main 内存里比较明文配置，变化时生成
 * 新的随机 UUID。
 *
 * 轮换判据只看**运行配置**（baseURL/model/apiKey）与 main 代码内的执行限制：
 * - 相同有效值重复保存/只读刷新 ⇒ 不轮换；
 * - 代理设置单独变化 ⇒ 不影响运行配置 ⇒ 不轮换；
 * - 清除后重配 ⇒ 中间经历 unavailable，修订必然轮换；
 * - 写失败但实际改变了磁盘可读状态 ⇒ 下一次 `refresh` 读到新值后轮换（不凭失败响应猜）。
 */

/** main 当前执行限制（首期代码常量；未来出现可变写入入口必须接同一拥有者） */
export interface ExecutionLimits {
  readonly maxIterations: number;
  readonly budget: {
    readonly maxTotalTokens: number;
    readonly maxCost?: number;
  };
}

export const MAIN_EXECUTION_LIMITS: ExecutionLimits = Object.freeze({
  maxIterations: 10,
  budget: Object.freeze({ maxTotalTokens: 100_000 }),
});

export interface EffectiveConfigSnapshot {
  /** 不透明修订（随机 UUID）；仅在同一 main 会话内有意义 */
  readonly revision: string;
  /** 当前解密的运行配置；未配置/读取失败为 null */
  readonly settings: RunSettings | null;
  /** settings.load 的真实异常（未配置为 null）；端点据此区分"未配置"与"读失败" */
  readonly loadError: unknown | null;
}

/** 刷新入口依赖的最小 settings 面（便于测试注入可变桩） */
export type ExecutionSettingsSource = Pick<SettingsStore, "load">;

export class ExecutionConfigState {
  private revision: string;
  /** 上一次成功读取的**有效运行配置**标识（含密钥明文，只在 main 内存） */
  private lastIdentity = "unavailable";

  constructor(
    private readonly settings: ExecutionSettingsSource,
    private readonly limits: ExecutionLimits = MAIN_EXECUTION_LIMITS,
    private readonly newRevision: () => string = () => randomUUID(),
  ) {
    this.revision = this.newRevision();
  }

  /**
   * 统一刷新：读取当前解密配置 → 与内存中的上次有效值比较 → 变化才轮换修订。
   *
   * 读取失败按 unavailable 处理（不抛错、不把异常文本或密钥带入标识）：
   * 配置写通道在写成功后调用它，写入成功不应因为随后解密失败而被误报为写失败；
   * 预检/提交据 `loadError` 给出 SETTINGS_LOAD_FAILED，而不是伪造一份配置。
   */
  refresh(): EffectiveConfigSnapshot {
    let loaded: RunSettings | null = null;
    let loadError: unknown | null = null;
    try {
      loaded = this.settings.load();
    } catch (error) {
      loadError = error;
    }

    const identity =
      loaded === null
        ? "unavailable"
        : JSON.stringify([
            loaded.baseURL,
            loaded.model,
            loaded.apiKey,
            this.limits.maxIterations,
            this.limits.budget.maxTotalTokens,
            this.limits.budget.maxCost ?? null,
          ]);
    if (identity !== this.lastIdentity) {
      this.revision = this.newRevision();
      this.lastIdentity = identity;
    }

    return { revision: this.revision, settings: loaded, loadError };
  }
}
