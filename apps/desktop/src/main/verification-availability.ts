/**
 * R3 可用性状态（4.5 / design D6「启动配置互斥区执行残留核查」）：
 * main 启动时先跑 3.7 启动残留核查，**核查完成且干净才重新开放 R3**；
 * daemon 不可达、归属不明、恢复日志不可信、记录不可写 ⇒ R3 保持 blocked 并
 * 携带诊断——**普通只读与既有 R1/R2 能力按原门禁可用**（分层可用性：只有
 * verification 的执行面 prepare/run/stop 吃这个门，只读端点与其他通道不受影响）。
 *
 * 新 main 用新 epoch、不恢复旧 registry、不继续执行旧任务（D6）：本状态只 gate
 * 新提交，不携带任何旧会话事实。
 */

export type R3AvailabilityState = "checking" | "available" | "blocked";

export type R3GateFailure = {
  readonly ok: false;
  readonly code: "R3_STARTUP_CHECKING" | "R3_BLOCKED";
  readonly reason: string;
};

export class R3Availability {
  private state: R3AvailabilityState = "checking";
  private reason: string | null = null;

  /** 启动核查进行中（缺省初态）：执行面拒绝，呈现「正在核查」 */
  setChecking(): void {
    this.state = "checking";
    this.reason = null;
  }

  setAvailable(): void {
    this.state = "available";
    this.reason = null;
  }

  setBlocked(reason: string): void {
    this.state = "blocked";
    this.reason = reason;
  }

  snapshot(): { state: R3AvailabilityState; reason: string | null } {
    return { state: this.state, reason: this.reason };
  }

  /**
   * 执行面门（prepare/run/stop）：checking 与 blocked 都拒绝——启动核查未完成
   * 前，新提交不与残留清理并发（互斥区语义）；blocked 时诊断透传给 renderer。
   */
  gate(): { ok: true } | R3GateFailure {
    if (this.state === "checking") {
      return {
        ok: false,
        code: "R3_STARTUP_CHECKING",
        reason: "启动残留核查进行中：R3 执行暂不可提交，完成后自动开放",
      };
    }
    if (this.state === "blocked") {
      return {
        ok: false,
        code: "R3_BLOCKED",
        reason: this.reason ?? "R3 已阻断（残留核查未通过）",
      };
    }
    return { ok: true };
  }
}
