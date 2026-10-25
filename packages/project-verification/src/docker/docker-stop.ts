import type { WorkloadStopBackend, WorkloadStopCounts } from "../execute/stop.js";
import { parseStopWorkloadsOutput } from "../execute/stop.js";
import type { LocalBackendEndpoint } from "../schema.js";
import type { DockerCliInstallation } from "./cli.js";
import {
  type CliRunner,
  DEFAULT_CLI_TIMEOUT_MS,
  DEFAULT_STREAM_MAX_BYTES,
  controlledCliEnv,
  defaultCliRunner,
  pinnedGlobalArgs,
} from "./cli.js";

/**
 * `WorkloadStopBackend` 的 Docker 实现（R3 tasks 3.5）。
 *
 * - 停止：`docker exec <ctr> /bin/sh /opt/r3/stop-workloads.sh`（受信脚本，哈希冻结于
 *   manifest.trustedEnvironment.stopWorkloads——完整性由镜像与 manifest 门保证）；
 * - /work 快照：`docker exec <ctr> find /work -type f`（argv，无 Shell）取清单，再按
 *   字符预算分批 `stat -c '%n %s %Y'` 拼接规范化快照（路径+大小+mtime，P19 静止确认）。
 */

export interface DockerStopBackendConfig {
  readonly installation: DockerCliInstallation;
  readonly endpoint: LocalBackendEndpoint;
  readonly runner?: CliRunner;
  readonly cliTimeoutMs?: number;
}

const STOP_SCRIPT_PATH = "/opt/r3/stop-workloads.sh";
const ARGV_CHAR_BUDGET = 8000;
const ARGV_MAX_ITEMS = 200;

function batchByBudget(items: readonly string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const item of items) {
    if (current.length >= ARGV_MAX_ITEMS || chars + item.length > ARGV_CHAR_BUDGET) {
      if (current.length > 0) {
        batches.push(current);
      }
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += item.length;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

export class DockerStopBackend implements WorkloadStopBackend {
  private readonly runner: CliRunner;
  private readonly cliTimeoutMs: number;

  constructor(private readonly config: DockerStopBackendConfig) {
    this.runner = config.runner ?? defaultCliRunner;
    this.cliTimeoutMs = config.cliTimeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  }

  private cliOptions() {
    return {
      env: controlledCliEnv(this.config.installation),
      timeoutMs: this.cliTimeoutMs,
      stdoutMaxBytes: DEFAULT_STREAM_MAX_BYTES,
      stderrMaxBytes: DEFAULT_STREAM_MAX_BYTES,
    };
  }

  private async exec(args: string[]) {
    const result = await this.runner(
      this.config.installation.exePath,
      [...pinnedGlobalArgs(this.config.endpoint), "exec", ...args],
      this.cliOptions(),
    );
    if (result.spawnError !== null) {
      throw new Error(
        `docker exec 无法启动（${result.spawnError.code ?? "unknown"}）：${result.spawnError.message}`,
      );
    }
    if (result.timedOut) {
      throw new Error("docker exec 超时：容器未就绪或命令挂起");
    }
    return result;
  }

  async runStopWorkloads(containerRef: string): Promise<WorkloadStopCounts> {
    const result = await this.exec([containerRef, "/bin/sh", STOP_SCRIPT_PATH]);
    const counts = parseStopWorkloadsOutput(result.stdout);
    if (counts === null) {
      // stderr 必须进消息：daemon 断连族（§1.6 "failed to connect…"）靠它被
      // classifyStopFailure 识别为 unknown（P21）——只带 stdout 会在引擎下线时
      // （stdout 空）把断连误报成确定性"停止失败"并销账登记（6.2 实测泄漏）。
      const stderr = result.stderr.trim().slice(0, 200);
      throw new Error(
        `停止脚本输出不可解析（exit ${String(result.exitCode)}）：${result.stdout.trim().slice(0, 200)}${stderr ? ` | stderr: ${stderr}` : ""}`,
      );
    }
    return counts;
  }

  async scanWorkState(containerRef: string): Promise<string> {
    const list = await this.exec([containerRef, "find", "/work", "-type", "f"]);
    if (list.exitCode !== 0) {
      throw new Error(
        `find /work 非零退出（exit ${String(list.exitCode)}）：${list.stderr.trim()}`,
      );
    }
    const files = list.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .sort();
    if (files.length === 0) {
      return "";
    }
    const parts: string[] = [];
    for (const batch of batchByBudget(files)) {
      const stat = await this.exec([containerRef, "stat", "-c", "%n %s %Y", ...batch]);
      if (stat.exitCode !== 0) {
        throw new Error(`stat 非零退出（exit ${String(stat.exitCode)}）：${stat.stderr.trim()}`);
      }
      parts.push(stat.stdout.trim());
    }
    return parts.join("\n").split("\n").sort().join("\n");
  }
}
