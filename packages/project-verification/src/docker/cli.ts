import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LocalBackendEndpoint } from "../schema.js";

/**
 * 受控 Docker CLI 原语（R3 tasks 3.2；验收 P01/P02/P09 的静态面）。
 *
 * design D1/D3 硬规则在此落牙：
 * - **CLI 用可信绝对路径**：只认两处已知安装位置的 `docker.exe`（用户级
 *   `%LOCALAPPDATA%\Programs\DockerDesktop` 与系统级 `C:\Program Files\Docker\Docker`），
 *   **绝不扫 PATH**——PATH 上的同名可执行文件不可信（backend-verification.md §1.2）；
 * - **受控 env，零继承**：不继承 `DOCKER_HOST` 覆盖、代理、API key 或项目 env 文件
 *   （§1.2 实证 `DOCKER_HOST` 可把 CLI 重定向到任意 endpoint，P02）；
 * - **钉死 endpoint**：`--host <本机管道>` 进 argv（不依赖 env/context 解析顺序），
 *   env 侧同时设同值——双保险，结构上排除「环境漂移」；
 * - **不经 Shell**：全程 argv 数组 spawn（`shell:false` 语义），无引号/转义面
 *   （Git Bash 的 MSYS 路径改写只发生在 Bash 调用层，node spawn 不经过）。
 */

/** 已知可信安装位置（按优先级；路径来自阶段 1 实测 + Docker Desktop 官方默认）。 */
export function defaultDockerCliCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  // R3 只声明 Windows x64 后端；其他平台没有受信安装位置，明确返回空表
  // （不猜 PATH，也不把 Windows 路径带到 Linux/macOS）。
  if (platform !== "win32") return [];
  const localAppData = env.LOCALAPPDATA ?? "";
  const candidates: string[] = [];
  if (localAppData.length > 0) {
    candidates.push(
      join(localAppData, "Programs", "DockerDesktop", "resources", "bin", "docker.exe"),
    );
  }
  candidates.push(
    join("C:", "Program Files", "Docker", "Docker", "resources", "bin", "docker.exe"),
  );
  return candidates;
}

export interface DockerCliInstallation {
  readonly exePath: string;
  /** CLI 同目录（credential 助手 `docker-credential-desktop` 所在地，§1.2）。 */
  readonly binDir: string;
}

/**
 * 解析受信 CLI：逐个候选**绝对路径**检查存在性，取第一个在场的；全不在场返回 null
 * （P01：明确不可用，不隐式安装、不回退宿主 Shell）。候选表可注入（测试用）。
 */
export function resolveDockerCli(
  candidates: ReadonlyArray<string> = defaultDockerCliCandidates(),
): DockerCliInstallation | null {
  for (const exePath of candidates) {
    if (existsSync(exePath)) {
      return { exePath, binDir: join(exePath, "..") };
    }
  }
  return null;
}

/**
 * 受控 env：**完全替换**（不展开宿主环境）。仅三键：
 * - `PATH` = CLI bin 目录（credential 助手可发现；不透传宿主 PATH，§1.2）；
 * - `SystemRoot` = 宿主系统目录（Windows 进程基线事实，非凭据）；
 * - `USERPROFILE` = 宿主用户目录（`~/.docker/config.json` 的 credsStore 发现路径，
 *   pull 需要凭据助手时才生效——这是阶段 1 实测的凭据机制，不是「透传凭据」；
 *   构建与测试路径不触网拉私有镜像时不会用到）。
 * 宿主侧的 `DOCKER_HOST`/代理/其余变量一律不出现（测试有敌意 env 断言）。
 */
export function controlledCliEnv(
  installation: DockerCliInstallation,
  hostEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = { PATH: installation.binDir };
  const systemRoot = hostEnv.SystemRoot ?? hostEnv.SYSTEMROOT;
  if (typeof systemRoot === "string" && systemRoot.length > 0) {
    env.SystemRoot = systemRoot;
  }
  const userProfile = hostEnv.USERPROFILE;
  if (typeof userProfile === "string" && userProfile.length > 0) {
    env.USERPROFILE = userProfile;
  }
  return env;
}

/** 全局旗标：钉死 endpoint（argv 面）。放在子命令之前（docker 全局旗标位置）。 */
export function pinnedGlobalArgs(endpoint: LocalBackendEndpoint): string[] {
  return ["--host", endpoint];
}

/** `docker version --format {{json .}}` 的受控 argv（预检用）。 */
export function dockerVersionArgv(endpoint: LocalBackendEndpoint): string[] {
  return [...pinnedGlobalArgs(endpoint), "version", "--format", "{{json .}}"];
}

/** 受控 CLI 运行选项：env 完全替换；输出逐流按字节截断（内存有界，P13 同纪律）。 */
export interface CliRunOptions {
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
  readonly stdoutMaxBytes: number;
  readonly stderrMaxBytes: number;
  /**
   * 提供给子进程 stdin 的字节（如 `docker exec -i … tee` 的文件内容）。
   * 缺省时子进程 stdin 为 ignore；给出时写入后立即收尾——写入失败（如对端已关）
   * 记为 spawnError，不静默吞掉（物化字节必须确认送达）。
   */
  readonly stdinBytes?: Uint8Array;
  /**
   * 双流合计观测字节上限（P13「总观测阈值触发停止」的接线，3.5）：超过即击杀子进程，
   * 结果以 outputLimitHit 标记。缺省 = 不做运行中阈值击杀（计数照常上报）。
   */
  readonly outputLimitBytes?: number;
}

export interface CliRunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
  /** spawn 本身失败（ENOENT 等）时给出；正常退出（含非零）不设。 */
  readonly spawnError: { readonly code: string | undefined; readonly message: string } | null;
  /** 保留区原始字节（= 截断前的捕获内容；哈希/资产发布用，P13）。 */
  readonly stdoutBytes: Uint8Array;
  readonly stderrBytes: Uint8Array;
  /**
   * 全部观测字节（保留 + 超限丢弃）——「持续读取丢弃并计数」的计数面（P13）；
   * 总观测阈值（output_limit 触发判定）以此为输入。
   */
  readonly stdoutTotalBytes: number;
  readonly stderrTotalBytes: number;
  /** 双流合计观测超过 outputLimitBytes 而被击杀（P13/3.5；timedOut 与其互斥语义）。 */
  readonly outputLimitHit: boolean;
}

/**
 * 受控 CLI 运行器。可注入（包内测试零 Docker 依赖）；默认实现 spawn + 字节上限捕获 +
 * 超时击杀。**非零退出是结果不是异常**（调用方按命令语义分类）。
 */
export type CliRunner = (
  exePath: string,
  args: string[],
  options: CliRunOptions,
) => Promise<CliRunResult>;

function captureStream(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
  onObserved: (deltaBytes: number) => void,
): {
  text: () => string;
  bytes: () => Uint8Array;
  truncated: () => boolean;
  totalBytes: () => number;
} {
  const chunks: Buffer[] = [];
  let retained = 0;
  let dropped = 0;
  stream.on("data", (chunk: Buffer) => {
    onObserved(chunk.length);
    // 超限后**持续读取并丢弃计数**（不停读——停读会让子进程在满管道上阻塞，P13）
    if (retained >= maxBytes) {
      dropped += chunk.length;
      return;
    }
    const take = chunk.subarray(0, maxBytes - retained);
    if (take.length < chunk.length) {
      dropped += chunk.length - take.length;
    }
    chunks.push(take);
    retained += take.length;
  });
  return {
    text: () => Buffer.concat(chunks).toString("utf8"),
    bytes: () => Buffer.concat(chunks),
    truncated: () => dropped > 0,
    totalBytes: () => retained + dropped,
  };
}

export const defaultCliRunner: CliRunner = (exePath, args, options) =>
  new Promise<CliRunResult>((resolve) => {
    const stdinPiped = options.stdinBytes !== undefined;
    const child = spawn(exePath, args, {
      env: options.env,
      windowsHide: true,
      stdio: [stdinPiped ? "pipe" : "ignore", "pipe", "pipe"],
    });
    // 双流共享观测计数：超过 outputLimitBytes 即击杀（P13 总观测阈值，3.5 接线）
    const observation = { total: 0, limitHit: false };
    const observe = (delta: number) => {
      observation.total += delta;
      if (
        options.outputLimitBytes !== undefined &&
        observation.total > options.outputLimitBytes &&
        !observation.limitHit
      ) {
        observation.limitHit = true;
        child.kill();
      }
    };
    const stdout = captureStream(
      child.stdout as NonNullable<typeof child.stdout>,
      options.stdoutMaxBytes,
      observe,
    );
    const stderr = captureStream(
      child.stderr as NonNullable<typeof child.stderr>,
      options.stderrMaxBytes,
      observe,
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    if (stdinPiped && child.stdin !== null) {
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        // stdin 写入失败（管道早关/EPIPE）：字节未确认送达，按 spawn 错误上报
        child.kill();
        clearTimeout(timer);
        resolve({
          exitCode: null,
          stdout: stdout.text(),
          stderr: stderr.text(),
          stdoutTruncated: stdout.truncated(),
          stderrTruncated: stderr.truncated(),
          timedOut: false,
          stdoutBytes: stdout.bytes(),
          stderrBytes: stderr.bytes(),
          stdoutTotalBytes: stdout.totalBytes(),
          stderrTotalBytes: stderr.totalBytes(),
          outputLimitHit: observation.limitHit,
          spawnError: { code: error.code, message: `stdin 写入失败：${error.message}` },
        });
      });
      child.stdin.end(Buffer.from(options.stdinBytes));
    }
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated(),
        stderrTruncated: stderr.truncated(),
        timedOut,
        stdoutBytes: stdout.bytes(),
        stderrBytes: stderr.bytes(),
        stdoutTotalBytes: stdout.totalBytes(),
        stderrTotalBytes: stderr.totalBytes(),
        outputLimitHit: observation.limitHit,
        spawnError: { code: error.code, message: error.message },
      });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated(),
        stderrTruncated: stderr.truncated(),
        timedOut,
        stdoutBytes: stdout.bytes(),
        stderrBytes: stderr.bytes(),
        stdoutTotalBytes: stdout.totalBytes(),
        stderrTotalBytes: stderr.totalBytes(),
        outputLimitHit: observation.limitHit,
        spawnError: null,
      });
    });
  });

export const DEFAULT_CLI_TIMEOUT_MS = 30_000;
export const DEFAULT_STREAM_MAX_BYTES = 2 * 1024 * 1024;
