import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  PreparationBackend,
  TrustedEnvironmentBuildOutcome,
  TrustedEnvironmentBuildRequest,
} from "../prepare/backend.js";
import { ImageDigestSchema, type LocalBackendEndpoint, type ProfileManifest } from "../schema.js";
import { verifyNodeTsV1Assets } from "../trusted-env/node-ts-v1.js";
import {
  type CliRunResult,
  type CliRunner,
  DEFAULT_CLI_TIMEOUT_MS,
  DEFAULT_STREAM_MAX_BYTES,
  type DockerCliInstallation,
  controlledCliEnv,
  defaultCliRunner,
  pinnedGlobalArgs,
} from "./cli.js";
import { containerRunFlags } from "./container-flags.js";
import { preflightLocalBackend } from "./preflight.js";

/**
 * Docker 受控后端（R3 tasks 3.2）：`PreparationBackend` 端口的真实实现。
 *
 * 纪律（每一款都是验收面，实机证据归 backend-verification.md §3.2 / 6.2）：
 * - **不经 Shell**：全程 argv 数组 spawn；endpoint 以 `--host` 钉死在 argv；
 * - **无宿主挂载/凭据**：构建上下文是**受信资产字节的临时副本**（不是宿主挂载、
 *   不读项目目录）；env 完全替换（`controlledCliEnv`），敌意宿主变量不可达 CLI；
 * - **digest/平台校验**：构建产物以 `docker image inspect` 取 ImageId/平台，
 *   平台 ≠ `profile.platform` ⇒ 漂移拒绝（P02）；manifest 冻结的**基础镜像**由
 *   Dockerfile 内 `FROM …@sha256:` 钉死（内容寻址）；
 * - **工具链实测**：以受限旗标（复用 `containerRunFlags`）在镜像内跑
 *   `node --version` / `tsc --version`，实测 ≠ manifest 声明 ⇒ `BACKEND_DRIFT`——
 *   端口契约「返回实测值」在此收紧为「实测与声明一致才放行」（冻结环境的本意）；
 * - **限额旗标唯一映射**：`containerRunFlags(profile)`，数字只来自 manifest（P10）。
 *
 * 失败一律抛 `PreparationBackendError`（code 前缀进 message）；3.1 编排捕获后写
 * failed 准备记录——「已接受后失败保留真实诊断」（design D3）。
 */

export type DockerBackendFailureCode =
  | "BACKEND_MISSING"
  | "BACKEND_REMOTE_REFUSED"
  | "BACKEND_DRIFT"
  | "TRUSTED_ENVIRONMENT_DRIFT"
  | "BUILD_FAILED"
  | "CONTEXT_IO_FAILED"
  | "VERIFY_FAILED";

export class PreparationBackendError extends Error {
  constructor(
    public readonly code: DockerBackendFailureCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "PreparationBackendError";
  }
}

export interface DockerBackendConfig {
  readonly installation: DockerCliInstallation;
  readonly endpoint: LocalBackendEndpoint;
  /** 本地构建 tag（digest 才是身份；tag 仅为本机引用）。 */
  readonly tag?: string;
  /** 构建上下文临时目录根（默认 os.tmpdir()；测试注入）。 */
  readonly tempRoot?: string;
  readonly runner?: CliRunner;
  readonly cliTimeoutMs?: number;
}

/** 构建输出诊断尾部的保留长度（stderr 末尾；完整输出不落盘，有界纪律）。 */
const DIAGNOSTIC_TAIL_CHARS = 1500;

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= DIAGNOSTIC_TAIL_CHARS
    ? trimmed
    : `…（截断）${trimmed.slice(-DIAGNOSTIC_TAIL_CHARS)}`;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

/**
 * 构建上下文落盘：受信资产字节写入一次性临时目录（UTF-8 精确字节；上下文只含
 * 资产表内容，不含宿主任何其他文件）。返回目录；清理责任在调用方（finally）。
 */
export function writeBuildContext(
  assets: Readonly<Record<string, string>>,
  tempRoot: string,
): string {
  const contextDir = mkdtempSync(join(tempRoot, "r3-build-ctx-"));
  try {
    for (const [relativePath, content] of Object.entries(assets)) {
      const target = join(contextDir, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
  } catch (error) {
    rmSync(contextDir, { recursive: true, force: true });
    throw error;
  }
  return contextDir;
}

/** 版本号提取：`v22.23.4` / `Version 5.9.3` / `5.9.3` 都归一为 `22.23.4` 形态。 */
export function extractSemanticVersion(text: string): string | null {
  const match = /\d+\.\d+\.\d+/.exec(text);
  return match === null ? null : match[0];
}

export class DockerPreparationBackend implements PreparationBackend {
  private readonly tag: string;
  private readonly tempRoot: string;
  private readonly runner: CliRunner;
  private readonly cliTimeoutMs: number;

  constructor(private readonly config: DockerBackendConfig) {
    this.tag = config.tag ?? "rebaseagent-r3/node-ts-v1:prepared";
    this.tempRoot = config.tempRoot ?? tmpdir();
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

  /** 受控 CLI 调用：spawn 失败归类缺失；非零退出带 stderr 尾部诊断。 */
  private async run(args: string[], purpose: string): Promise<CliRunResult> {
    const result = await this.runner(this.config.installation.exePath, args, this.cliOptions());
    if (result.spawnError !== null) {
      throw new PreparationBackendError(
        "BACKEND_MISSING",
        `${purpose} 时 Docker CLI 无法启动（${result.spawnError.code ?? "unknown"}）：${result.spawnError.message}`,
      );
    }
    if (result.timedOut) {
      throw new PreparationBackendError("BACKEND_MISSING", `${purpose} 超时（引擎未就绪或不可达）`);
    }
    if (result.exitCode !== 0) {
      throw new PreparationBackendError(
        "BUILD_FAILED",
        `${purpose} 非零退出（exit ${String(result.exitCode)}）：${tail(result.stderr) || tail(result.stdout)}`,
      );
    }
    return result;
  }

  /** 镜像内版本实测（受限旗标同正式容器；网络 none）。 */
  private async measureVersion(
    profile: ProfileManifest,
    imageRef: string,
    command: string[],
  ): Promise<string> {
    const result = await this.run(
      [
        ...pinnedGlobalArgs(this.config.endpoint),
        "run",
        "--rm",
        ...containerRunFlags(profile),
        imageRef,
        ...command,
      ],
      `镜像内实测 ${command.join(" ")}`,
    );
    return extractSemanticVersion(result.stdout) ?? "";
  }

  async buildTrustedEnvironment(
    request: TrustedEnvironmentBuildRequest,
  ): Promise<TrustedEnvironmentBuildOutcome> {
    const { profile, assets } = request;

    // 0. 端口内再过完整性门（防线纵深；3.1 编排已检——篡改字节不过此门）
    const integrity = verifyNodeTsV1Assets(assets, profile);
    if (!integrity.ok) {
      throw new PreparationBackendError("TRUSTED_ENVIRONMENT_DRIFT", integrity.reason);
    }

    // 1. 预检（P01/P02：缺失/不可达/远程/平台漂移在构建前明确拒绝）
    const pre = await preflightLocalBackend({
      installation: this.config.installation,
      endpoint: this.config.endpoint,
      runner: this.runner,
    });
    if (!pre.ok) {
      throw new PreparationBackendError(pre.code, pre.reason);
    }

    // 2. 临时构建上下文（仅受信资产字节；finally 清理）
    let contextDir: string;
    try {
      contextDir = writeBuildContext(assets, this.tempRoot);
    } catch (error) {
      throw new PreparationBackendError(
        "CONTEXT_IO_FAILED",
        `构建上下文落盘失败：${String(error)}`,
      );
    }
    try {
      // 3. 构建（--host 钉死 endpoint；--platform 与 manifest 一致；诊断有界捕获）
      await this.run(
        [
          ...pinnedGlobalArgs(this.config.endpoint),
          "build",
          "--progress",
          "plain",
          "--platform",
          profile.platform,
          "--tag",
          this.tag,
          contextDir,
        ],
        "受信环境镜像构建",
      );

      // 4. 产物校验：ImageId + 平台（P02 漂移门；containerd 镜像存储下 Id=manifest digest）
      const inspect = await this.run(
        [
          ...pinnedGlobalArgs(this.config.endpoint),
          "image",
          "inspect",
          this.tag,
          "--format",
          "{{.Id}}|{{.Os}}|{{.Architecture}}",
        ],
        "镜像身份核验",
      );
      const [imageId = "", imageOs = "", imageArch = ""] = inspect.stdout.trim().split("|");
      if (!ImageDigestSchema.safeParse(imageId).success) {
        throw new PreparationBackendError(
          "VERIFY_FAILED",
          `镜像身份不可解析（应为 sha256:<64 位十六进制>）：${firstLine(inspect.stdout)}`,
        );
      }
      const actualPlatform = `${imageOs}/${imageArch}`;
      if (actualPlatform !== profile.platform) {
        throw new PreparationBackendError(
          "BACKEND_DRIFT",
          `构建产物平台漂移：实测 ${actualPlatform} ≠ 固定计划 ${profile.platform}——拒绝（P02）`,
        );
      }

      // 5. 工具链实测（受限旗标；实测 ≠ manifest 冻结值 ⇒ 漂移拒绝）
      const measuredNode = await this.measureVersion(profile, imageId, ["node", "--version"]);
      const measuredTypescript = await this.measureVersion(profile, imageId, [
        "/opt/r3/node_modules/.bin/tsc",
        "--version",
      ]);
      if (
        measuredNode !== profile.toolchain.node ||
        measuredTypescript !== profile.toolchain.typescript
      ) {
        throw new PreparationBackendError(
          "BACKEND_DRIFT",
          `工具链漂移：实测 node=${measuredNode || "(未测得)"} typescript=${measuredTypescript || "(未测得)"} ≠ manifest 冻结 ${profile.toolchain.node}/${profile.toolchain.typescript}`,
        );
      }

      // 网络口径：准备阶段是唯一允许联网的阶段，构建是否命中缓存不可测 ⇒
      // networkUsed 如实为 true、downloadedBytes 如实为 null（测不得 ≠ 0，P04）。
      return {
        imageDigest: imageId,
        toolchain: { node: measuredNode, typescript: measuredTypescript },
        networkUsed: true,
        downloadedBytes: null,
      };
    } finally {
      rmSync(contextDir, { recursive: true, force: true });
    }
  }
}
