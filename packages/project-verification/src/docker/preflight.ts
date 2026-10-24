import { type LocalBackendEndpoint, LocalBackendEndpointSchema } from "../schema.js";
import {
  type CliRunner,
  DEFAULT_CLI_TIMEOUT_MS,
  DEFAULT_STREAM_MAX_BYTES,
  type DockerCliInstallation,
  controlledCliEnv,
  defaultCliRunner,
  dockerVersionArgv,
} from "./cli.js";

/**
 * 本机后端预检（R3 tasks 3.2；验收 P01/P02）。
 *
 * 只读（`docker version`），零副作用：不 pull、不 build、不建容器、不写记录。
 * 分类判据全部来自阶段 1 实测（backend-verification.md §1.1/§1.2/§1.6）：
 * - CLI 不在场（候选绝对路径不存在 / spawn ENOENT）⇒ `BACKEND_MISSING`（P01：
 *   明确不可用，不隐式安装、不回退宿主 Shell）；
 * - endpoint 不在枚举内 ⇒ `BACKEND_REMOTE_REFUSED`（P02：TCP/SSH/远程 context 在
 *   类型层不存在表示，运行时同样拒绝）；
 * - 管道连接失败（§1.6 实测错误形态）⇒ `BACKEND_MISSING`（reason 注明「不可达」）；
 * - 服务端平台/架构漂移（非 linux/amd64）⇒ `BACKEND_DRIFT`（P02）。
 */

export interface BackendFacts {
  readonly endpoint: LocalBackendEndpoint;
  readonly clientVersion: string;
  readonly serverVersion: string;
  readonly osType: string;
  readonly arch: string;
  readonly apiVersion: string;
}

export type PreflightFailure =
  | { readonly ok: false; readonly code: "BACKEND_MISSING"; readonly reason: string }
  | { readonly ok: false; readonly code: "BACKEND_REMOTE_REFUSED"; readonly reason: string }
  | { readonly ok: false; readonly code: "BACKEND_DRIFT"; readonly reason: string };

export type PreflightResult =
  | { readonly ok: true; readonly facts: BackendFacts }
  | PreflightFailure;

function missing(reason: string): PreflightFailure {
  return { ok: false, code: "BACKEND_MISSING", reason };
}

function remote(reason: string): PreflightFailure {
  return { ok: false, code: "BACKEND_REMOTE_REFUSED", reason };
}

function drift(reason: string): PreflightFailure {
  return { ok: false, code: "BACKEND_DRIFT", reason };
}

/** `docker version --format {{json .}}` 的输出形状（仅取预检所需字段）。 */
export interface DockerVersionJson {
  Client?: { Version?: string; Os?: string; Arch?: string } | null;
  Server?: { Version?: string; Os?: string; Arch?: string; ApiVersion?: string } | null;
}

/** 纯解析：合法 JSON ⇒ 字段；垃圾输出/Server 缺失 ⇒ null（调用方分类）。 */
export function parseDockerVersionJson(text: string): {
  clientVersion: string | null;
  server: { version: string; osType: string; arch: string; apiVersion: string } | null;
} {
  let parsed: DockerVersionJson;
  try {
    parsed = JSON.parse(text) as DockerVersionJson;
  } catch {
    return { clientVersion: null, server: null };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { clientVersion: null, server: null };
  }
  const server = parsed.Server;
  if (
    server === null ||
    server === undefined ||
    typeof server !== "object" ||
    typeof server.Version !== "string" ||
    typeof server.Os !== "string" ||
    typeof server.Arch !== "string"
  ) {
    return { clientVersion: parsed.Client?.Version ?? null, server: null };
  }
  return {
    clientVersion: parsed.Client?.Version ?? null,
    server: {
      version: server.Version,
      osType: server.Os,
      arch: server.Arch,
      apiVersion: server.ApiVersion ?? "",
    },
  };
}

/**
 * 连接失败形态分类（§1.6 实测：`failed to connect to the docker API at
 * npipe:////./pipe/… The system cannot find the file specified`）。纯函数。
 */
export function classifyDockerConnectionError(stderr: string): string | null {
  const text = stderr.toLowerCase();
  if (
    text.includes("error during connect") ||
    text.includes("failed to connect to the docker api") ||
    text.includes("is the docker daemon running") ||
    text.includes("cannot find the file specified") ||
    text.includes("access is denied")
  ) {
    return "unreachable";
  }
  return null;
}

export interface PreflightInput {
  readonly installation: DockerCliInstallation;
  readonly endpoint: LocalBackendEndpoint;
  readonly runner?: CliRunner;
}

/**
 * 预检本机后端并返回事实（P01/P02）。`docker version` 一次调用拿到 client/server
 * 版本与服务端平台；endpoint 合法性先于一切（枚举外直接拒绝，不发起调用）。
 */
export async function preflightLocalBackend(input: PreflightInput): Promise<PreflightResult> {
  const endpointCheck = LocalBackendEndpointSchema.safeParse(input.endpoint);
  if (!endpointCheck.success) {
    return remote(
      `endpoint 不在本版允许的本机管道枚举内：${String(input.endpoint)}——拒绝远程/漂移环境（P02）`,
    );
  }
  const runner = input.runner ?? defaultCliRunner;
  const result = await runner(input.installation.exePath, dockerVersionArgv(input.endpoint), {
    env: controlledCliEnv(input.installation),
    timeoutMs: DEFAULT_CLI_TIMEOUT_MS,
    stdoutMaxBytes: DEFAULT_STREAM_MAX_BYTES,
    stderrMaxBytes: DEFAULT_STREAM_MAX_BYTES,
  });
  if (result.spawnError !== null) {
    return missing(
      `Docker CLI 无法启动（${result.spawnError.code ?? "unknown"}）：${result.spawnError.message}——后端缺失或未验收，不隐式安装（P01）`,
    );
  }
  if (result.timedOut) {
    return missing("docker version 超时：引擎未就绪或不可达（P01）");
  }
  if (result.exitCode !== 0) {
    const kind = classifyDockerConnectionError(result.stderr);
    return missing(
      kind === "unreachable"
        ? `本机引擎不可达（endpoint=${input.endpoint}）：${result.stderr.trim().split("\n")[0] ?? ""}——后端未运行或未验收（P01）`
        : `docker version 非零退出（exit ${result.exitCode}）：${result.stderr.trim().split("\n")[0] ?? ""}`,
    );
  }
  const parsed = parseDockerVersionJson(result.stdout);
  if (parsed.server === null) {
    return missing(
      `docker version 输出无服务端事实（引擎未运行或输出不可解析）：${result.stdout.trim().slice(0, 200)}`,
    );
  }
  if (parsed.server.osType !== "linux" || parsed.server.arch !== "amd64") {
    return drift(
      `服务端平台漂移：实测 ${parsed.server.osType}/${parsed.server.arch} ≠ 固定计划 linux/amd64——拒绝（P02）`,
    );
  }
  return {
    ok: true,
    facts: {
      endpoint: input.endpoint,
      clientVersion: parsed.clientVersion ?? "",
      serverVersion: parsed.server.version,
      osType: parsed.server.osType,
      arch: parsed.server.arch,
      apiVersion: parsed.server.apiVersion,
    },
  };
}

// ---------------------------------------------------------------------------
// 引擎健康只读子命令白名单（4.3 / design D3）：capability 的引擎健康只允许枚举的
// 只读 docker 子命令（version/info 类），由本断言钉死——不透传任意参数。
// ---------------------------------------------------------------------------

/** 允许的只读子命令（version：版本事实；info：引擎形态事实——均无副作用） */
export const ENGINE_HEALTH_READONLY_SUBCOMMANDS = ["version", "info"] as const;

/** 允许的格式化旗标取值（仅机器可读 JSON 形态） */
export const ENGINE_HEALTH_ALLOWED_FORMAT = "{{json .}}";

/**
 * 断言一组 docker argv 属于引擎健康白名单：首个非全局旗标参数必须是白名单子命令，
 * `--format` 的取值必须是 {{json .}}。越界（任意子命令/任意格式串/多余参数）即抛。
 */
export function assertEngineHealthArgv(argv: readonly string[]): void {
  const sub = argv.find((arg) => !arg.startsWith("--"));
  if (sub === undefined || !ENGINE_HEALTH_READONLY_SUBCOMMANDS.includes(sub as never)) {
    throw new Error(
      `引擎健康白名单拒绝（子命令必须是 ${ENGINE_HEALTH_READONLY_SUBCOMMANDS.join("/")}）：${String(sub)}`,
    );
  }
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (seen.has(arg)) {
      throw new Error(`引擎健康白名单拒绝（重复参数）：${arg}`);
    }
    seen.add(arg);
    if (arg === "--format") {
      const value = argv[i + 1];
      if (value !== ENGINE_HEALTH_ALLOWED_FORMAT) {
        throw new Error(
          `引擎健康白名单拒绝（--format 只允许 ${ENGINE_HEALTH_ALLOWED_FORMAT}）：${String(value)}`,
        );
      }
      i += 1;
    }
  }
}
