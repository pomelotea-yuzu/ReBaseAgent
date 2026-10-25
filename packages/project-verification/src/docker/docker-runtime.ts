import { classifyStopFailure } from "../execute/stop.js";
import type { RuntimeContainerCreatePort } from "../runtime/create.js";
import { RuntimeCreateStaleNameError, RuntimeCreateUnknownError } from "../runtime/create.js";
import type { RuntimeResourceFacts, RuntimeResourcePort } from "../runtime/reconcile.js";
import { OWNER_LABEL_KEY, OWNER_LABEL_VALUE } from "../runtime/registration.js";
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
 * 运行时资源的 Docker 受控实现（R3 tasks 3.7）：`RuntimeResourcePort`（核查面）与
 * `RuntimeContainerCreatePort`（创建面）。
 *
 * 受控纪律与 3.2 一致：可信绝对路径 CLI、受控 env、`--host` 钉死 endpoint、全程
 * argv 不经 Shell。资源定位按 §1.6 实证口径：**label 过滤 = 精确键值匹配**（定位主
 * 手段）、名字精确比对兜底（`--filter name=` 是子串匹配，不作归属依据）。
 *
 * 错误语义（编排层据此分类）：
 * - 基础设施失败（spawn/超时/daemon 连接族）⇒ 抛错，reconcile 统一阻断（P23）；
 * - 「资源不存在」（inspect/rm 的 No such）⇒ 幂等成功（已停/已移除）；
 * - create 同名冲突 ⇒ RuntimeCreateStaleNameError（残留未清，先核查）；
 * - create 超时/空响应 ⇒ RuntimeCreateUnknownError（响应丢失窗口，按名消解）。
 */

export interface DockerRuntimeConfig {
  readonly installation: DockerCliInstallation;
  readonly endpoint: LocalBackendEndpoint;
  readonly runner?: CliRunner;
  readonly cliTimeoutMs?: number;
  /** `docker stop` 宽限秒数（supervisor TERM 快停 ≈6s 实测，默认 10s 留余量）。 */
  readonly stopGraceSeconds?: number;
}

function stripLeadingSlash(name: string): string {
  return name.startsWith("/") ? name.slice(1) : name;
}

/** CLI 超时（引擎未就绪/不可达）。create 侧据此转译为响应丢失窗口。 */
class DockerCliTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DockerCliTimeoutError";
  }
}

export class DockerRuntimeBackend implements RuntimeResourcePort, RuntimeContainerCreatePort {
  private readonly runner: CliRunner;
  private readonly cliTimeoutMs: number;
  private readonly stopGraceSeconds: number;

  constructor(private readonly config: DockerRuntimeConfig) {
    this.runner = config.runner ?? defaultCliRunner;
    this.cliTimeoutMs = config.cliTimeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
    this.stopGraceSeconds = config.stopGraceSeconds ?? 10;
  }

  private cliOptions() {
    return {
      env: controlledCliEnv(this.config.installation),
      timeoutMs: this.cliTimeoutMs,
      stdoutMaxBytes: DEFAULT_STREAM_MAX_BYTES,
      stderrMaxBytes: DEFAULT_STREAM_MAX_BYTES,
    };
  }

  /** 受控 CLI 调用：spawn 失败/超时 ⇒ 抛错（daemon 不可达族标注）；返回原始结果。 */
  private async run(args: string[], purpose: string) {
    const result = await this.runner(this.config.installation.exePath, args, this.cliOptions());
    if (result.spawnError !== null) {
      throw new Error(
        `${purpose} 时 Docker CLI 无法启动（${result.spawnError.code ?? "unknown"}）：${result.spawnError.message}`,
      );
    }
    if (result.timedOut) {
      throw new DockerCliTimeoutError(`${purpose} 超时（引擎未就绪或不可达）`);
    }
    return result;
  }

  private async runRequired(args: string[], purpose: string) {
    const result = await this.run(args, purpose);
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim().slice(0, 400);
      throw new Error(`${purpose} 非零退出（exit ${String(result.exitCode)}）：${stderr}`);
    }
    return result;
  }

  // ── RuntimeResourcePort（核查面）───────────────────────────────────────────

  /**
   * 枚举本 owner 名下容器：`ps -aq --filter label=<k>=<v>`（label 过滤为精确键值匹配，
   * §1.6）取 ID，再逐容器 `container inspect` 取权威事实。
   *
   * ⚠️ 不用 `ps --format {{json .}}` 一次性取全字段：实测（Docker 29）其 `Labels`
   * 是**逗号拼接字符串**而非对象（`"k1=v1,k2=v2"`），含逗号的标签值无法无歧义还原；
   * inspect 的 `Config.Labels` 才是可靠对象映射。枚举与 inspect 之间容器消失
   * （外部清理竞态）按「已不存在」跳过，不算失败。
   */
  async listOwnedContainers(): Promise<RuntimeResourceFacts[]> {
    const result = await this.runRequired(
      [
        ...pinnedGlobalArgs(this.config.endpoint),
        "ps",
        "-aq",
        "--filter",
        `label=${OWNER_LABEL_KEY}=${OWNER_LABEL_VALUE}`,
      ],
      "按 owner 标签枚举容器",
    );
    const ids = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const facts: RuntimeResourceFacts[] = [];
    for (const id of ids) {
      const inspected = await this.inspectContainerFacts(id);
      if (inspected !== null) {
        facts.push(inspected);
      }
    }
    return facts;
  }

  /** 单容器权威事实（inspect）。目标已不存在 ⇒ null；其余基础设施失败 ⇒ 抛错。 */
  private async inspectContainerFacts(ref: string): Promise<RuntimeResourceFacts | null> {
    const result = await this.run(
      [
        ...pinnedGlobalArgs(this.config.endpoint),
        "container",
        "inspect",
        "--format",
        "{{json .}}",
        ref,
      ],
      "容器详情 inspect",
    );
    if (result.exitCode !== 0) {
      if (/no such/i.test(result.stderr)) {
        return null;
      }
      throw new Error(
        `容器 inspect 失败（exit ${String(result.exitCode)}）：${result.stderr.trim().slice(0, 400)}`,
      );
    }
    const line = result.stdout.trim().split("\n")[0] ?? "";
    // inspect 的主键字段是 `Id`（ps --format 才用 `ID`）；两者兼容
    let parsed: {
      Id?: unknown;
      ID?: unknown;
      Name?: unknown;
      State?: { Status?: unknown };
      Config?: { Labels?: unknown };
    };
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`容器 inspect 输出不可解析：${String(error)}`);
    }
    const containerId = typeof parsed.Id === "string" ? parsed.Id : parsed.ID;
    if (typeof containerId !== "string" || typeof parsed.Name !== "string") {
      throw new Error("容器 inspect 输出缺少 Id/Name 字段");
    }
    return {
      containerId,
      name: stripLeadingSlash(parsed.Name),
      state:
        parsed.State !== null &&
        typeof parsed.State === "object" &&
        typeof parsed.State.Status === "string"
          ? parsed.State.Status
          : "unknown",
      labels:
        parsed.Config !== null &&
        typeof parsed.Config === "object" &&
        parsed.Config.Labels !== null &&
        typeof parsed.Config.Labels === "object"
          ? (parsed.Config.Labels as Record<string, string>)
          : {},
    };
  }

  async stopContainer(containerId: string): Promise<void> {
    const result = await this.run(
      [
        ...pinnedGlobalArgs(this.config.endpoint),
        "stop",
        "-t",
        String(this.stopGraceSeconds),
        containerId,
      ],
      "定向停止遗留容器",
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `docker stop 非零退出（exit ${String(result.exitCode)}；${classifyStopFailure(result.stderr)} 类）：${result.stderr.trim().slice(0, 400)}`,
      );
    }
  }

  /** 启动已创建的容器（运行编排：物化/exec 都要求容器 running）。基础设施失败抛错。 */
  async startContainer(containerId: string): Promise<void> {
    const result = await this.run(
      [...pinnedGlobalArgs(this.config.endpoint), "start", containerId],
      "启动受控容器",
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `docker start 非零退出（exit ${String(result.exitCode)}）：${result.stderr.trim().slice(0, 400)}`,
      );
    }
  }

  async confirmStopped(containerId: string): Promise<void> {
    const result = await this.run(
      [
        ...pinnedGlobalArgs(this.config.endpoint),
        "container",
        "inspect",
        "--format",
        "{{.State.Status}}",
        containerId,
      ],
      "确认容器已停止",
    );
    if (result.exitCode !== 0) {
      if (/no such/i.test(result.stderr)) {
        return; // 已不存在 = 强于已停止（移除竞态/他方清理），不乐观也不阻断
      }
      throw new Error(
        `确认停止失败（exit ${String(result.exitCode)}）：${result.stderr.trim().slice(0, 400)}`,
      );
    }
    const status = result.stdout.trim();
    if (status === "running") {
      throw new Error(`确认停止失败：容器仍在运行（${containerId}）——不乐观宣布`);
    }
  }

  async removeContainer(containerId: string): Promise<void> {
    // -f：编排在确认工作负载停止后仍保留 supervisor（PID 1）以维持 tmpfs 采集，
    // 容器本身仍是 running；不带 -f 的 rm 会被 Docker 拒绝并残留（6.2 实机发现）。
    // 调用方只会删除已确认停止/静止或本次创建失败的 own 容器（归属核查在编排/reconcile）。
    const result = await this.run(
      [...pinnedGlobalArgs(this.config.endpoint), "rm", "-f", containerId],
      "移除遗留容器",
    );
    if (result.exitCode !== 0 && !/no such/i.test(result.stderr)) {
      throw new Error(
        `docker rm 非零退出（exit ${String(result.exitCode)}）：${result.stderr.trim().slice(0, 400)}`,
      );
    }
  }

  // ── RuntimeContainerCreatePort（创建面）────────────────────────────────────

  async createContainer(request: {
    name: string;
    labels: Readonly<Record<string, string>>;
    imageRef: string;
    runFlags: readonly string[];
    command: readonly string[];
  }): Promise<{ containerId: string }> {
    const labelArgs: string[] = [];
    for (const [key, value] of Object.entries(request.labels)) {
      labelArgs.push("--label", `${key}=${value}`);
    }
    let result: Awaited<ReturnType<DockerRuntimeBackend["run"]>>;
    try {
      result = await this.run(
        [
          ...pinnedGlobalArgs(this.config.endpoint),
          "create",
          "--name",
          request.name,
          ...labelArgs,
          ...request.runFlags,
          request.imageRef,
          ...request.command,
        ],
        "创建受控容器",
      );
    } catch (error) {
      if (error instanceof DockerCliTimeoutError) {
        // create 超时 = 响应丢失窗口：请求可能已被引擎处理，按名探查消解（P22）
        throw new RuntimeCreateUnknownError(
          `create 超时（请求可能已被引擎处理）：${error.message}`,
        );
      }
      throw error;
    }
    if (result.exitCode !== 0) {
      if (/already in use/i.test(result.stderr)) {
        throw new RuntimeCreateStaleNameError(
          `容器名已被占用（同名残留未清，先跑启动核查）：${request.name}`,
        );
      }
      throw new Error(
        `docker create 非零退出（exit ${String(result.exitCode)}）：${result.stderr.trim().slice(0, 400)}`,
      );
    }
    const containerId = result.stdout.trim();
    if (!/^[a-f0-9]{64}$/i.test(containerId)) {
      // exit 0 但响应不可解析 ⇒ 无法确认创建身份 ⇒ 响应丢失窗口
      throw new RuntimeCreateUnknownError(
        `docker create 退出码为 0 但容器 ID 不可解析：${JSON.stringify(containerId.slice(0, 80))}`,
      );
    }
    return { containerId };
  }

  async resolveContainerByName(name: string): Promise<RuntimeResourceFacts | null> {
    // 按名精确探查（inspect 对不存在的名字给 No such ⇒ null = 判定未创建）
    return this.inspectContainerFacts(name);
  }
}
