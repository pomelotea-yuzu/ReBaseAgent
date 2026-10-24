/**
 * 工作负载停止与静止确认（R3 tasks 3.5；验收 P19/P21 + P10/P20 的停止接线）。
 *
 * 纪律（design D5.5/D6 + 阶段 1 实测）：
 * - **保留容器**：停止的是工作负载进程，不是容器——采集窗口内「仅 supervisor 存活」
 *   以保留 tmpfs（先 stop/remove 容器再假称可采集 = 伪造）；容器移除归编排收尾；
 * - **按 PID 定向**：停止经受信脚本 `/opt/r3/stop-workloads.sh`（排除 PID 1 与自身，
 *   绝不模式匹配——§1.5 探针 O 自杀反证）；脚本 TERM → 2s → KILL 兜底 → 存活清点；
 * - **静止确认**（P19「确认后文件不再变化」）：/work 状态快照（路径+大小+mtime）
 *   间隔复扫，两次一致才 quiescent——采集稳定性（P17）在 3.6 另做内容级双扫；
 * - **幂等**：重复停止 = 对已死 PID 的 no-op（stoppedPidCount=0，仍可再次调用）；
 * - **未知阻断**（P21）：daemon 不可达/停止响应丢失 ⇒ `unknown`——保留可信身份，
 *   **不声明已停止**，只允许核对与再次定向停止；槽位语义归操作登记层（4.x）。
 */

/** 脚本单次执行的清点结果（解析 stop-workloads.sh 的三行输出）。 */
export interface WorkloadStopCounts {
  /** 收到 TERM 的进程数（含后续被 KILL 兜底者）。 */
  readonly termSent: number;
  /** 2s 宽限后仍存活、被 KILL 升级者。 */
  readonly killEscalated: number;
  /** 终态存活清点（0 = 进程层面已清空；僵尸由 supervisor 收割）。 */
  readonly survivors: number;
}

export interface WorkloadStopBackend {
  /** 在容器内执行受信停止脚本；基础设施失败抛错（由编排分类 unknown/failed）。 */
  runStopWorkloads(containerRef: string): Promise<WorkloadStopCounts>;
  /** /work 状态快照（规范化排序串：路径+大小+mtime）；基础设施失败抛错。 */
  scanWorkState(containerRef: string): Promise<string>;
}

/** 停止脚本输出解析：`TERM_SENT=<n>` / `KILL_ESCALATED=<n>` / `SURVIVORS=<n>`。 */
export function parseStopWorkloadsOutput(output: string): WorkloadStopCounts | null {
  const read = (key: string): number | null => {
    const match = new RegExp(`^${key}=(\\d+)$`, "m").exec(output);
    return match === null ? null : Number(match[1]);
  };
  const termSent = read("TERM_SENT");
  const killEscalated = read("KILL_ESCALATED");
  const survivors = read("SURVIVORS");
  if (termSent === null || killEscalated === null || survivors === null) {
    return null;
  }
  return { termSent, killEscalated, survivors };
}

export type StopWorkloadsResult =
  | {
      readonly ok: true;
      readonly stoppedPidCount: number;
      readonly survivors: number;
      readonly quiescent: boolean;
      /** 静止确认实际耗时（双扫间隔；quiescent=false 时为已用的确认窗口）。 */
      readonly quiescenceMs: number;
    }
  | { readonly ok: false; readonly kind: "unknown"; readonly reason: string }
  | { readonly ok: false; readonly kind: "failed"; readonly reason: string };

export interface StopWorkloadsInput {
  readonly containerRef: string;
  readonly backend: WorkloadStopBackend;
  /** 双扫间隔（默认 2000ms——阶段 1 §1.5 的静止判定窗口）。 */
  readonly quiescenceIntervalMs?: number;
}

/** daemon 断开/资源不可达形态（§1.6 错误族）⇒ 未知；其余为失败。 */
export function classifyStopFailure(reason: string): "unknown" | "failed" {
  const text = reason.toLowerCase();
  if (
    text.includes("cannot find the file specified") ||
    text.includes("failed to connect") ||
    text.includes("is the docker daemon running") ||
    text.includes("error during connect") ||
    text.includes("无法启动") ||
    text.includes("超时")
  ) {
    return "unknown";
  }
  return "failed";
}

/**
 * 停止全部工作负载并确认静止。**幂等**：对已停止的容器重复调用，
 * 脚本清点为 0、双扫一致 ⇒ ok 且 stoppedPidCount=0。
 * 结果永不「乐观」：进程未清空（survivors>0）或文件仍在变化 ⇒ quiescent=false，
 * 调用方不得据此发布任何完成/取消结论（P19/P21）。
 */
export async function stopWorkloadsAndConfirm(
  input: StopWorkloadsInput,
): Promise<StopWorkloadsResult> {
  const intervalMs = input.quiescenceIntervalMs ?? 2000;
  let counts: WorkloadStopCounts;
  try {
    counts = await input.backend.runStopWorkloads(input.containerRef);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, kind: classifyStopFailure(reason), reason };
  }
  const scan = async (): Promise<string> => {
    try {
      return await input.backend.scanWorkState(input.containerRef);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`__STOP_SCAN__${reason}`);
    }
  };
  const startedAt = Date.now();
  try {
    const before = await scan();
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const after = await scan();
    const quiescent = before === after;
    return {
      ok: true,
      stoppedPidCount: counts.termSent + counts.killEscalated,
      survivors: counts.survivors,
      quiescent: quiescent && counts.survivors === 0,
      quiescenceMs: Date.now() - startedAt,
    };
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).replace(
      "__STOP_SCAN__",
      "",
    );
    return { ok: false, kind: classifyStopFailure(reason), reason };
  }
}
