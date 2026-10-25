import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  CommandEndEventSchema,
  CommandStartEventSchema,
  type ProfileLimits,
  type ProfileManifest,
} from "../schema.js";

/**
 * 固定命令执行（R3 tasks 3.4；验收 P11/P12/P13/P20）。
 *
 * **命令只来自 manifest 查表**（`resolveFixedCommand`：commandId → 冻结的
 * executable/argv/cwd）——调用方不能提供命令、路径或参数（P08 的执行侧面）。
 *
 * 职责边界：
 * - **单调耗时**：`performance.now()`（单调时钟）测量；UTC 起止另行记录（design D6
 *   「记录 UTC 起止与单调实际耗时」——两个时钟各司其职）；
 * - **有界采集**（P13）：stdout/stderr 各保留前 `stdoutBudgetBytes`/`stderrBudgetBytes`
 *   字节，之后**持续读取丢弃并计数**（不停读——停读会让容器内进程在满管道上阻塞）；
 *   总观测阈值（`totalOutputLimitBytes`）只是判定函数，触发停止的接线归 3.5；
 * - **阶段分类**（P20）：执行级结局 = completed / start_failed(126/127) /
 *   process_failed(≥128 信号终止，含 OOM 137) / timed_out；**检查成败不是执行失败**
 *   ——exit 1 的报告照常产出，项目断言层面的结论由编排层结合 TAP 门判定，
 *   基础设施故障不会被统计成代码断言失败；
 * - **TAP 精确门**（P12）：`validateTestReport` 对保留 stdout 解析 `# tests`/`# pass`
 *   并要求与 manifest `expectedTestCount` **精确相等**（零测试/超计数/垃圾输出全拒）；
 *   这是镜像内 runner 同款门的包层复核（纵深），不是替代。
 */

/** manifest 冻结命令的解析结果（executable/argv/cwd 一律来自 manifest，P08）。 */
export interface FixedCommandSpec {
  readonly commandId: "typecheck" | "test";
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
}

/** 按枚举 commandId 查 manifest 冻结命令表；未枚举 ⇒ null（调用方拒绝）。 */
export function resolveFixedCommand(
  profile: ProfileManifest,
  commandId: "typecheck" | "test",
): FixedCommandSpec | null {
  const command = profile.commands.find((entry) => entry.commandId === commandId);
  if (command === undefined) {
    return null;
  }
  return {
    commandId: command.commandId,
    executable: command.executable,
    argv: [...command.argv],
    cwd: command.cwd,
  };
}

/** 单流采集结果：保留资产（内容寻址发布）+ 全观测计数（P13）。 */
export interface StreamCapture {
  /** 保留区原始字节（超出保留上限的部分被丢弃并计入 totalBytes）。 */
  readonly retainedBytes: Uint8Array;
  /** 全部观测字节 = 保留 + 超限丢弃（持续读取计数）。 */
  readonly totalBytes: number;
  readonly sha256: string;
  readonly truncated: boolean;
}

export interface ContainerCommandRequest {
  readonly containerRef: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly stdoutRetainBytes: number;
  readonly stderrRetainBytes: number;
  readonly timeoutMs: number;
  /** 双流合计观测上限（P13/3.5）；undefined = 不做运行中阈值击杀。 */
  readonly totalOutputLimitBytes?: number;
}

export interface ContainerCommandRun {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** 因总观测超限被击杀（P13/3.5）；与 timedOut 互斥发生。 */
  readonly outputLimitHit: boolean;
  readonly stdout: Omit<StreamCapture, "sha256">;
  readonly stderr: Omit<StreamCapture, "sha256">;
}

/**
 * 容器命令执行端口。实现契约：`executable`/`argv` 以 argv 数组直传（不经 Shell）、
 * `cwd` 经 docker exec 的 workdir 旗标设置；超时 ⇒ 击杀 CLI 会话并以 timedOut 收尾
 * （容器内子孙的定向停止确认归 3.5）；基础设施失败抛错。
 */
export interface ContainerCommandBackend {
  runCommand(request: ContainerCommandRequest): Promise<ContainerCommandRun>;
}

export interface FixedCommandReport {
  readonly commandId: "typecheck" | "test";
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  /** UTC 起止（墙钟事实）。 */
  readonly startedAt: string;
  readonly endedAt: string;
  /** 单调时钟实测耗时（design D6）。 */
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly outputLimitHit: boolean;
  readonly stdout: StreamCapture;
  readonly stderr: StreamCapture;
}

export type ExecutionOutcomeKind =
  | "completed"
  | "start_failed"
  | "process_failed"
  | "timed_out"
  | "output_limit_stopped";

export type CommandExecutionResult =
  | { readonly ok: true; readonly report: FixedCommandReport }
  | {
      readonly ok: false;
      readonly failure: { readonly code: "environment_failed"; readonly reason: string };
    };

/**
 * 执行级结局分类（P20）：126/127 = 启动失败（命令不在/不可执行）；≥128 = 信号终止
 * （137 = SIGKILL，OOM 候选；143 = SIGTERM）；0–125 = completed——检查成败由
 * exitCode + TAP 门在编排层判定，不属于本分类。
 */
export function classifyExecutionReport(report: FixedCommandReport): ExecutionOutcomeKind {
  if (report.outputLimitHit) {
    return "output_limit_stopped";
  }
  if (report.timedOut) {
    return "timed_out";
  }
  if (report.exitCode === null) {
    return "process_failed";
  }
  if (report.exitCode === 126 || report.exitCode === 127) {
    return "start_failed";
  }
  if (report.exitCode >= 128) {
    return "process_failed";
  }
  return "completed";
}

/**
 * 信号名推导（**推导不是观测**：docker exec 只给退出码；128+N 约定，其余为 null）。
 * 记录层的 signal 字段用它填充，呈现侧须注明「按退出码推导」。
 */
export function deriveSignalName(exitCode: number | null): string | null {
  if (exitCode === null || exitCode < 128 || exitCode > 191) {
    return null;
  }
  const signals: Record<number, string> = {
    129: "SIGHUP",
    130: "SIGINT",
    131: "SIGQUIT",
    132: "SIGILL",
    134: "SIGABRT",
    135: "SIGBUS",
    136: "SIGFPE",
    137: "SIGKILL",
    141: "SIGPIPE",
    143: "SIGTERM",
  };
  return signals[exitCode] ?? `SIGRTM-${String(exitCode - 128)}`;
}

/**
 * TAP 精确门（P12）：解析保留 stdout 的**最后一个** `# tests`/`# pass` 摘要，要求与
 * `expectedTestCount` 精确相等。零测试（node 22.23 会把零用例文件计作 1 个通过的
 * 伪测试且 exit 0，阶段 1 §1.3 实测）、超计数、垃圾输出、缺摘要一律拒绝。
 */
export function validateTestReport(
  stdoutText: string,
  expectedTestCount: number,
): { ok: true } | { ok: false; reason: string } {
  const testsMatches = [...stdoutText.matchAll(/^# tests (\d+)$/gm)];
  const passMatches = [...stdoutText.matchAll(/^# pass (\d+)$/gm)];
  if (testsMatches.length === 0 || passMatches.length === 0) {
    return { ok: false, reason: "可信测试报告缺失（无 TAP 摘要行）：不能当作通过（P12）" };
  }
  const tests = Number(testsMatches[testsMatches.length - 1]?.[1]);
  const pass = Number(passMatches[passMatches.length - 1]?.[1]);
  if (tests !== expectedTestCount) {
    return {
      ok: false,
      reason: `报告测试数 ${String(tests)} ≠ manifest 冻结期望 ${String(expectedTestCount)}（P12 精确匹配门）`,
    };
  }
  if (pass !== expectedTestCount) {
    return {
      ok: false,
      reason: `报告通过数 ${String(pass)} ≠ manifest 冻结期望 ${String(expectedTestCount)}（有失败/跳过，P12）`,
    };
  }
  return { ok: true };
}

/** 总观测字节（双流合计）；对照 `limits.totalOutputLimitBytes` 判 output_limit 事实。 */
export function totalObservedBytes(report: FixedCommandReport): number {
  return report.stdout.totalBytes + report.stderr.totalBytes;
}

export function exceedsTotalOutputLimit(
  report: FixedCommandReport,
  limits: ProfileLimits,
): boolean {
  return totalObservedBytes(report) > limits.totalOutputLimitBytes;
}

function captureToStreamCapture(capture: Omit<StreamCapture, "sha256">): StreamCapture {
  return {
    ...capture,
    sha256: createHash("sha256").update(capture.retainedBytes).digest("hex"),
  };
}

export interface ExecuteFixedCommandInput {
  readonly containerRef: string;
  readonly command: FixedCommandSpec;
  readonly limits: ProfileLimits;
  readonly backend: ContainerCommandBackend;
  readonly now?: () => Date;
}

/**
 * 执行一个固定命令：查表命令 → 后端执行（保留/计数/超时由后端承载）→ 报告
 * （UTC 起止 + 单调耗时 + 退出事实 + 双流采集）。基础设施失败（容器不可达等）
 * ⇒ environment_failed（P20：与启动/进程/检查失败分开）。
 */
export async function executeFixedCommand(
  input: ExecuteFixedCommandInput,
): Promise<CommandExecutionResult> {
  const startWall = (input.now ?? (() => new Date()))();
  const startMono = performance.now();
  let run: ContainerCommandRun;
  try {
    run = await input.backend.runCommand({
      containerRef: input.containerRef,
      executable: input.command.executable,
      argv: input.command.argv,
      cwd: input.command.cwd,
      stdoutRetainBytes: input.limits.stdoutBudgetBytes,
      stderrRetainBytes: input.limits.stderrBudgetBytes,
      timeoutMs: input.limits.commandTimeoutMs,
      totalOutputLimitBytes: input.limits.totalOutputLimitBytes,
    });
  } catch (error) {
    return {
      ok: false,
      failure: {
        code: "environment_failed",
        reason: `命令执行基础设施失败：${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  const endWall = (input.now ?? (() => new Date()))();
  const durationMs = Math.max(0, Math.round(performance.now() - startMono));
  return {
    ok: true,
    report: {
      commandId: input.command.commandId,
      executable: input.command.executable,
      argv: [...input.command.argv],
      cwd: input.command.cwd,
      startedAt: startWall.toISOString(),
      endedAt: endWall.toISOString(),
      durationMs,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      outputLimitHit: run.outputLimitHit,
      stdout: captureToStreamCapture(run.stdout),
      stderr: captureToStreamCapture(run.stderr),
    },
  };
}

/** 报告 → 记录层 command_start 事件（schema 校验，编排层直接追加）。 */
export function commandStartEvent(report: FixedCommandReport) {
  return CommandStartEventSchema.parse({
    type: "command_start",
    commandId: report.commandId,
    executable: report.executable,
    argv: [...report.argv],
    cwd: report.cwd,
    startedAt: report.startedAt,
  });
}

/** 报告 → 记录层 command_end 事件（byteLength/sha256 描述保留资产，totalBytes 全观测）。 */
export function commandEndEvent(report: FixedCommandReport) {
  return CommandEndEventSchema.parse({
    type: "command_end",
    commandId: report.commandId,
    exitCode: report.exitCode,
    signal: deriveSignalName(report.exitCode),
    durationMs: report.durationMs,
    stdout: {
      byteLength: report.stdout.retainedBytes.length,
      totalBytes: report.stdout.totalBytes,
      sha256: report.stdout.sha256,
      truncated: report.stdout.truncated,
    },
    stderr: {
      byteLength: report.stderr.retainedBytes.length,
      totalBytes: report.stderr.totalBytes,
      sha256: report.stderr.sha256,
      truncated: report.stderr.truncated,
    },
    endedAt: report.endedAt,
  });
}
