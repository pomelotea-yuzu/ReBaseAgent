import type {
  ContainerCommandBackend,
  ContainerCommandRequest,
  ContainerCommandRun,
} from "../execute/command-runner.js";
import type { LocalBackendEndpoint } from "../schema.js";
import type { DockerCliInstallation } from "./cli.js";
import { type CliRunner, controlledCliEnv, defaultCliRunner, pinnedGlobalArgs } from "./cli.js";

/**
 * `ContainerCommandBackend` 的 Docker 实现（R3 tasks 3.4）。
 *
 * `docker exec --workdir <cwd> <ctr> <executable> <argv…>`——可执行文件/参数全部走
 * argv 数组（不经 Shell、无注入面），工作目录经 exec 的 workdir 旗标（不进任何
 * 解析器）。超时 ⇒ 击杀 CLI 会话（timedOut 收尾；容器内子孙的定向停止确认归 3.5）。
 */

export interface DockerCommandBackendConfig {
  readonly installation: DockerCliInstallation;
  readonly endpoint: LocalBackendEndpoint;
  /** CLI 硬超时的额外余量（命令超时到点击杀后给 CLI 收尾的窗口）。 */
  readonly graceMs?: number;
  readonly runner?: CliRunner;
}

export class DockerCommandBackend implements ContainerCommandBackend {
  private readonly graceMs: number;
  private readonly runner: CliRunner;

  constructor(private readonly config: DockerCommandBackendConfig) {
    this.graceMs = config.graceMs ?? 10_000;
    this.runner = config.runner ?? defaultCliRunner;
  }

  async runCommand(request: ContainerCommandRequest): Promise<ContainerCommandRun> {
    const result = await this.runner(
      this.config.installation.exePath,
      [
        ...pinnedGlobalArgs(this.config.endpoint),
        "exec",
        "--workdir",
        request.cwd,
        request.containerRef,
        request.executable,
        ...request.argv,
      ],
      {
        env: controlledCliEnv(this.config.installation),
        timeoutMs: request.timeoutMs + this.graceMs,
        stdoutMaxBytes: request.stdoutRetainBytes,
        stderrMaxBytes: request.stderrRetainBytes,
        outputLimitBytes: request.totalOutputLimitBytes,
      },
    );
    if (result.spawnError !== null) {
      throw new Error(
        `docker exec 无法启动（${result.spawnError.code ?? "unknown"}）：${result.spawnError.message}`,
      );
    }
    return {
      exitCode: result.exitCode,
      // CLI 超时（= 命令超时 + 余量）⇒ 判定命令超时被击杀
      timedOut: result.timedOut,
      outputLimitHit: result.outputLimitHit,
      stdout: {
        retainedBytes: result.stdoutBytes,
        totalBytes: result.stdoutTotalBytes,
        truncated: result.stdoutTruncated,
      },
      stderr: {
        retainedBytes: result.stderrBytes,
        totalBytes: result.stderrTotalBytes,
        truncated: result.stderrTruncated,
      },
    };
  }
}
