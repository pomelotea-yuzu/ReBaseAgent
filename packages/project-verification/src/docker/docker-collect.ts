import type { ArtifactCollectionBackend } from "../collect/collect.js";
import type { LocalBackendEndpoint } from "../schema.js";
import type { DockerCliInstallation } from "./cli.js";
import {
  type CliRunner,
  DEFAULT_STREAM_MAX_BYTES,
  controlledCliEnv,
  defaultCliRunner,
  pinnedGlobalArgs,
} from "./cli.js";

/**
 * `ArtifactCollectionBackend` 的 Docker 实现（R3 tasks 3.6）。
 *
 * 全部命令 argv 直传（不经 Shell）：find 双形态（普通文件清单 / 非普通对象核查）、
 * sha256sum 与 stat 按字符预算分批（复用物化模块的分批参数口径）、cat 字节流读取
 * （宿主侧哈希复核的输入，上限 = 单文件配额）。容器内路径一律 /work 绝对路径。
 */

export interface DockerCollectBackendConfig {
  readonly installation: DockerCliInstallation;
  readonly endpoint: LocalBackendEndpoint;
  readonly runner?: CliRunner;
  readonly cliTimeoutMs?: number;
  /** 单文件读取字节上限（默认取 R1 单文件配额 8 MiB；超出由配额判定先行拒绝）。 */
  readonly readFileMaxBytes?: number;
}

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

/** stat 行解析：`<path> <size>`（%n %s；容忍 \r）。 */
export function parseStatSizeLines(output: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const separator = line.lastIndexOf(" ");
    if (separator <= 0) {
      continue;
    }
    const size = Number(line.slice(separator + 1));
    if (Number.isSafeInteger(size) && size >= 0) {
      map.set(line.slice(0, separator), size);
    }
  }
  return map;
}

export class DockerCollectBackend implements ArtifactCollectionBackend {
  private readonly runner: CliRunner;
  private readonly cliTimeoutMs: number;
  private readonly readFileMaxBytes: number;

  constructor(private readonly config: DockerCollectBackendConfig) {
    this.runner = config.runner ?? defaultCliRunner;
    this.cliTimeoutMs = config.cliTimeoutMs ?? 30_000;
    this.readFileMaxBytes = config.readFileMaxBytes ?? 8 * 1024 * 1024;
  }

  private cliOptions(stdoutMaxBytes = DEFAULT_STREAM_MAX_BYTES) {
    return {
      env: controlledCliEnv(this.config.installation),
      timeoutMs: this.cliTimeoutMs,
      stdoutMaxBytes,
      stderrMaxBytes: DEFAULT_STREAM_MAX_BYTES,
    };
  }

  private async exec(args: string[], stdoutMaxBytes?: number) {
    const result = await this.runner(
      this.config.installation.exePath,
      [...pinnedGlobalArgs(this.config.endpoint), "exec", ...args],
      this.cliOptions(stdoutMaxBytes),
    );
    if (result.spawnError !== null) {
      throw new Error(
        `docker exec 无法启动（${result.spawnError.code ?? "unknown"}）：${result.spawnError.message}`,
      );
    }
    if (result.timedOut) {
      throw new Error("docker exec 超时：容器未就绪或命令挂起");
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `docker exec 非零退出（exit ${String(result.exitCode)}）：${result.stderr.trim()}`,
      );
    }
    return result;
  }

  async listNonRegularObjects(containerRef: string): Promise<string[]> {
    // 形态二：/work 下既非目录也非普通文件的对象（链接/设备/socket 等）
    const result = await this.exec([
      containerRef,
      "find",
      "/work",
      "!",
      "-type",
      "d",
      "!",
      "-type",
      "f",
    ]);
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async listWorkFilesWithSizes(
    containerRef: string,
  ): Promise<Array<{ path: string; size: number }>> {
    const list = await this.exec([containerRef, "find", "/work", "-type", "f"]);
    const absPaths = list.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .sort();
    if (absPaths.length === 0) {
      return [];
    }
    const sizes = new Map<string, number>();
    for (const batch of batchByBudget(absPaths)) {
      const stat = await this.exec([containerRef, "stat", "-c", "%n %s", ...batch]);
      for (const [path, size] of parseStatSizeLines(stat.stdout)) {
        sizes.set(path, size);
      }
    }
    return absPaths
      .filter((absPath) => absPath.startsWith("/work/"))
      .map((absPath) => {
        const size = sizes.get(absPath);
        if (size === undefined) {
          throw new Error(`stat 缺尺寸：${absPath}`);
        }
        return { path: absPath.slice("/work/".length), size };
      });
  }

  async sha256OfFiles(
    containerRef: string,
    paths: readonly string[],
  ): Promise<Map<string, string>> {
    const merged = new Map<string, string>();
    for (const batch of batchByBudget([...paths])) {
      const result = await this.exec([containerRef, "sha256sum", ...batch]);
      for (const rawLine of result.stdout.split("\n")) {
        const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(rawLine.trim());
        if (match !== null) {
          merged.set(match[2], match[1]);
        }
      }
    }
    return merged;
  }

  async readFile(containerRef: string, path: string): Promise<Uint8Array> {
    const result = await this.exec([containerRef, "cat", path], this.readFileMaxBytes);
    if (result.stdoutTruncated) {
      throw new Error(
        `${path}：超出单文件读取上限 ${String(this.readFileMaxBytes)} B（应被配额先行拒绝）`,
      );
    }
    return result.stdoutBytes;
  }
}
