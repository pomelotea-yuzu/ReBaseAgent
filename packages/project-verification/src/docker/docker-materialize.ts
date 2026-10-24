import type { ContainerWriteBackend } from "../materialize/materialize.js";
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
 * `ContainerWriteBackend` 的 Docker 实现（R3 tasks 3.3）。
 *
 * 命令形态全部**不经 Shell**（busybox 工具 + argv 路径，无引号/注入面）：
 * - 建目录：`docker exec <ctr> mkdir -p <dirs…>`；
 * - 写文件：`docker exec -i <ctr> tee <path>`，文件字节走 stdin——阶段 1 §1.5
 *   实测的字节流物化模型，tee 以 argv 接路径，路径不进任何解析器；
 * - 哈希复核：`docker exec <ctr> sha256sum <paths…>`，解析 `<hash>  <path>` 行。
 *
 * argv 预算：Windows 命令行总量有限（≈32K 字符），mkdir/sha256sum 按**字符预算 +
 * 条数上限**双重分批（路径配额上限 512 字符/条 ⇒ 定长分批不安全）。
 * `sha256sum` 个别文件缺失 ⇒ exit 1 但已输出其余行——解析保留部分结果（缺席路径
 * 由编排侧判 mismatch 指名）；基础设施失败（无输出可解析/容器不可用）抛错。
 */

/** argv 字符预算（每批路径合计，留足余量）与条数上限。 */
const ARGV_CHAR_BUDGET = 8000;
const ARGV_MAX_ITEMS = 200;

export interface DockerMaterializationConfig {
  readonly installation: DockerCliInstallation;
  readonly endpoint: LocalBackendEndpoint;
  readonly runner?: CliRunner;
  readonly cliTimeoutMs?: number;
}

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

/** sha256sum 输出行解析：`<64hex>  <path>`（busybox 两空格；容忍 \r）。 */
export function parseSha256SumLines(output: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (match === null) {
      continue;
    }
    map.set(match[2], match[1]);
  }
  return map;
}

export class DockerMaterializationBackend implements ContainerWriteBackend {
  private readonly runner: CliRunner;
  private readonly cliTimeoutMs: number;

  constructor(private readonly config: DockerMaterializationConfig) {
    this.runner = config.runner ?? defaultCliRunner;
    this.cliTimeoutMs = config.cliTimeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  }

  private cliOptions(stdinBytes?: Uint8Array) {
    return {
      env: controlledCliEnv(this.config.installation),
      timeoutMs: this.cliTimeoutMs,
      stdoutMaxBytes: stdinBytes === undefined ? DEFAULT_STREAM_MAX_BYTES : 4096,
      stderrMaxBytes: DEFAULT_STREAM_MAX_BYTES,
      stdinBytes,
    };
  }

  /** spawn/超时 ⇒ 基础设施失败抛错；非零退出返回结果由调用方按命令语义判。 */
  private async exec(args: string[], stdinBytes?: Uint8Array) {
    const result = await this.runner(
      this.config.installation.exePath,
      [...pinnedGlobalArgs(this.config.endpoint), "exec", ...args],
      this.cliOptions(stdinBytes),
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

  async mkdirAll(containerRef: string, dirs: readonly string[]): Promise<void> {
    for (const batch of batchByBudget([...dirs])) {
      const result = await this.exec([containerRef, "mkdir", "-p", ...batch]);
      if (result.exitCode !== 0) {
        throw new Error(
          `mkdir -p 非零退出（exit ${String(result.exitCode)}）：${result.stderr.trim()}`,
        );
      }
    }
  }

  async writeFile(containerRef: string, containerPath: string, bytes: Uint8Array): Promise<void> {
    // tee 以 argv 接路径、字节走 stdin；stdout 回显丢弃（4096 上限，截断无碍）
    const result = await this.exec(
      ["-i", containerRef, "tee", containerPath],
      Buffer.from(bytes),
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `tee 写入非零退出（exit ${String(result.exitCode)}）：${result.stderr.trim()}`,
      );
    }
  }

  async sha256OfFiles(
    containerRef: string,
    containerPaths: readonly string[],
  ): Promise<Map<string, string>> {
    const merged = new Map<string, string>();
    let lastStderr = "";
    for (const batch of batchByBudget([...containerPaths])) {
      const result = await this.exec([containerRef, "sha256sum", ...batch]);
      const parsed = parseSha256SumLines(result.stdout);
      for (const [path, hash] of parsed) {
        merged.set(path, hash);
      }
      if (result.exitCode !== 0 && parsed.size === 0) {
        // 非零且完全无输出可解析 ⇒ 基础设施性失败（容器不可用/工具缺失）
        lastStderr = result.stderr.trim();
        if (lastStderr.length > 0) {
          throw new Error(
            `sha256sum 无可解析输出（exit ${String(result.exitCode)}）：${lastStderr}`,
          );
        }
      }
    }
    return merged;
  }
}
