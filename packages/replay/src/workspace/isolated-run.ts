import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { OpenAiCompatClient, runLoop } from "@rebaseagent/agent-loop";
import type { LlmClient, Message, RunConfig, RunResult } from "@rebaseagent/agent-loop";
import { JsonlTracer, readRun } from "@rebaseagent/trace-sdk";
import { createWorkspaceSnapshot } from "@rebaseagent/trace-sdk/workspace-hash";
import { observeRunIdentity } from "../run-identity.js";
import type { OnRunIdentified } from "../run-identity.js";
import { createWorkspaceCheckpointTracer } from "./checkpoint-tracer.js";
import { FILE_TOOLS_V1_PROFILE, createFileToolsV1 } from "./file-tools.js";
import { importSourceTree } from "./import-source.js";
import type { SourceImportFailure, SourceImportFailureCode } from "./import-source.js";
import { checkToolProfile, checkWriteAuthority } from "./profile-guard.js";
import { WORKSPACE_TRACES_DIR_NAME } from "./read-api.js";
import { createWorkspaceWorld } from "./world.js";

/**
 * **隔离根运行编排**（A design §5，tasks 4.1）：从一个显式选定的目录创建一个可作分叉父本的根 run。
 *
 * 这个模块只做一件事——把 1.x～3.x 已经分别落地并各自验收过的零件**按正确顺序**串起来：
 *
 * ```
 * 参数形状 → profile 一致性 → 当前请求授权      ← 全部预检，零副作用
 *   → 两遍采集导入（2.3/2.4）                    ← 唯一读源目录的阶段
 *   → 建世界（2.5）
 *   → 建临时 trace（本模块）
 *   → runLoop + 固定受控工具（3.1/3.2）+ 检查点包装器（3.4）
 *   → 按 meta.id 归位（本模块）
 * ```
 *
 * ## 顺序为什么是这个顺序
 *
 * - **预检一律先于副作用**：profile 不一致、本次未授权这类拒绝**必须**发生在采集之前——
 *   否则一个注定被拒的请求会先把整个目录读进内存并发布一堆孤立附件。用例 `预检失败零副作用`
 *   断言的正是"连 dataDir 都没被创建"这种强结论，而不是"没写 trace"这种弱结论。
 * - **导入先于建 trace**：设计 §5 要求"初始文件采集完成后才 SHALL 调用 LLM"。建 trace 紧跟建
 *   世界之后、`runLoop` 之前，因此 `startRun` 里冻结的 `initial_snapshot` 就是导入的真实结果。
 * - **源目录只在导入阶段被读**：世界建好后，工具链只认附件存储，源目录的后续变化与本次运行无关
 *   （2.5 的性质），本模块不再引用 `source`。
 *
 * ## 为什么用临时文件再归位
 *
 * run id 由本层生成、由包装器覆盖进 meta，**但文件名不能靠"我自己知道 id"来取**：归位时从
 * `readRun(tmp).meta.id` 回读，落盘文件名与文件内容里的 id 才不可能不一致（同 A1 的 `runs:create`）。
 * 临时文件不带 `.jsonl` 后缀 ⇒ 列表扫描看不见半成品；`errored` 也是要保留的**事实**，所以成功与
 * errored 都归位，只有"确实没产出文件"才报 `run_not_landed`。
 *
 * ## 失败为什么是返回值而不是抛异常
 *
 * 与 `importSourceTree` / `createWorkspaceWorld` 保持同一种表达：**可通过预检拒绝的事情**返回
 * 可辨认的 `failure`，让 B 侧的 IPC 直接用错误码给中文提示；而 LLM 失败不是异常——loop 把它记成
 * `errored` 终止事件并正常返回（4.x 沿用的既有语义），此时 run 已经落盘且可读，抛错反而会让调用方
 * 以为"什么都没留下"。调用方据 `outcome.event.event` 决定提示文案。
 *
 * ## 本模块刻意不做的事
 *
 * - **不接收 `Tool[]` / handler / 可执行脚本**：工具由 `createFileToolsV1(world)` 从固定工厂造，
 *   世界实例关在工具闭包里（3.1），调用方无法塞入旁路 handler。
 * - **不接 `exec.cwd` 当路径能力**：`RunConfig.exec.cwd` 只是受控运行上下文，文件定位只查世界映射。
 * - **不做隔离能力预检**（4.2）、**不做分叉**（4.3）、**不做普通入口门禁**（4.5）。
 */

/** 创建隔离根 run 的入参 */
export interface CreateIsolatedRunOptions {
  /** 数据目录：trace 与附件都被限制在其下（`<dataDir>/traces`、`<dataDir>/workspace-blobs`） */
  readonly dataDir: string;
  /** 源目录（显式给出；包层在导入时**重新**校验，不信任调用方预检） */
  readonly source: string;
  /**
   * 本次运行配置。`config.tools` **必须逐字段等于**固定 `file-tools-v1` 定义（顺序、name、
   * description、parameters、`sideEffect` 存在性与取值），由 3.3 的 `checkToolProfile` 逐字段核对。
   */
  readonly config: RunConfig;
  /**
   * 起始 user 消息。根运行的起点**恒为** `system + user` 两条（system 取自 `config.systemPrompt`，
   * 内容可为空串）——隔离根不是从任何历史派生的，不存在工具调用前缀。
   */
  readonly userMessage: string;
  /**
   * **当前请求**的副本写入授权，原样交给 3.3 的 `checkWriteAuthority`。
   *
   * 类型是 `unknown` 而不是 `boolean`：门禁的输入本来就来自 IPC/JSON 边界，宽松的静态类型
   * 会让"调用方传了 `"true"` 或 `1`" 变成编译期不可表达的事。唯一通过形状是
   * `{ allowFileWrites: true }`（字面量 `true`）；父 trace 里的 `write_authorized` 标注、
   * 同名字段伪造一律无效。
   */
  readonly authority: unknown;
  /** LLM 客户端（测试注入 mock；缺省真调 `config.baseURL`） */
  readonly llm?: LlmClient;
  /**
   * 可选的可信运行身份观察（U4 design D5）：收到的是 **checkpoint tracer 注入后的最终
   * run id**（= 落盘 meta.id = `workspace.world_id`），绝不是 loop 自造的临时 id。
   * 只观察：不改 ID、不动预检/授权/配额门禁与轮末检查点语义；
   * 之后的归位或收尾失败都不会撤销已报告的身份。
   */
  readonly onRunIdentified?: OnRunIdentified;
}

/** 创建失败的分类码：预检三类 + 导入原始分类 + 建世界/归位 */
export type CreateIsolatedRunFailureCode =
  | "invalid_request"
  | "profile_mismatch"
  | "missing_authority"
  | "invalid_snapshot"
  | "run_not_landed"
  | SourceImportFailureCode;

export interface CreateIsolatedRunFailure {
  readonly code: CreateIsolatedRunFailureCode;
  readonly reason: string;
  /** 导入失败时的原始明细（含出问题的条目路径等），其余情况缺省 */
  readonly sourceFailure?: SourceImportFailure;
}

export type CreateIsolatedRunResult =
  | {
      readonly ok: true;
      /** 新根 run 的 id（文件位于 `<dataDir>/traces/<id>.jsonl`） */
      readonly id: string;
      /** loop 的终止结果（`errored` 也是落盘事实，由调用方决定提示） */
      readonly outcome: RunResult;
    }
  | { readonly ok: false; readonly failure: CreateIsolatedRunFailure };

function fail(code: CreateIsolatedRunFailureCode, reason: string): CreateIsolatedRunResult {
  return { ok: false, failure: { code, reason } };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * 隔离根 run 的 id。与 `runLoop` 自造的 `run_<36进制时间戳>` 同构，但**由编排层生成**——
 * 因为 `world_id` 必须等于本 run id（schema 的跨字段约束），id 只能来自"建世界的那一方"。
 */
function newIsolatedRootRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 从显式选定的源目录创建一个隔离根 run。
 *
 * 返回 `ok: true` 即表示：文件已归位到 `<dataDir>/traces/<id>.jsonl`，它的 meta 是 v2 +
 * `workspace.origin = { kind: "import" }`、`parent`/`fork` 均为 `null`，每个已完成的 `agent.step`
 * 都带检查点 ⇒ 可作隔离 result 分叉的父本（4.2/4.3 消费）。
 */
export async function createIsolatedRun(
  options: CreateIsolatedRunOptions,
): Promise<CreateIsolatedRunResult> {
  const { dataDir, source, config, userMessage, authority, llm } = options;

  // ── 1. 参数形状（同步判定，不碰文件系统）────────────────────────────────────────────
  if (!isNonEmptyString(dataDir)) {
    return fail("invalid_request", `dataDir 必须是非空字符串，实际为 ${JSON.stringify(dataDir)}`);
  }
  if (!isNonEmptyString(source)) {
    return fail("invalid_request", `source 必须是非空字符串，实际为 ${JSON.stringify(source)}`);
  }
  if (typeof userMessage !== "string") {
    return fail("invalid_request", "userMessage 必须是字符串（空串合法，但不能省略）");
  }
  if (typeof config !== "object" || config === null) {
    return fail("invalid_request", "config 必须是 RunConfig 对象");
  }

  // ── 2. profile 一致性：工具定义必须逐字段等于固定 file-tools-v1 ──────────────────────
  // 放在导入之前：改过 sideEffect 或塞了自定义工具的表不该先跑一遍采集。
  const profileCheck = checkToolProfile(config.tools, FILE_TOOLS_V1_PROFILE);
  if (!profileCheck.ok) {
    return fail("profile_mismatch", profileCheck.failure.reason);
  }

  // ── 3. 当前请求的副本写入授权（唯一授权输入）────────────────────────────────────────
  const authorityCheck = checkWriteAuthority(authority);
  if (!authorityCheck.ok) {
    return fail("missing_authority", authorityCheck.failure.reason);
  }

  // ── 4. 导入：两遍采集核对 + 导入配额（此处是唯一读源目录的阶段）─────────────────────
  // 失败收尾由 2.4 定：零 trace、零模型调用，已发布的附件留作孤立内容。
  const imported = await importSourceTree({ source, dataDir });
  if (!imported.ok) {
    return {
      ok: false,
      failure: {
        code: imported.failure.code,
        reason: imported.failure.reason,
        sourceFailure: imported.failure,
      },
    };
  }

  // ── 5. 世界实例：起点清单 = 导入结果；写入授权恒 true（门禁已在第 3 步通过）──────────
  // 用 `createWorkspaceSnapshot` 而不是手拼 `{ id, files }`：id 必须与规范清单的哈希一致，
  // 否则建世界时会被 id 重算拒绝。
  const created = createWorkspaceWorld({
    dataDir,
    snapshot: createWorkspaceSnapshot(imported.value.files),
    allowFileWrites: true,
  });
  if (!created.ok) {
    return fail("invalid_snapshot", created.failure.reason);
  }
  const world = created.value;

  // ── 6. 固定受控工具：从世界造，定义与 `config.tools` 同源（第 2 步已逐字段核对）────────
  const tools = createFileToolsV1(world);

  // ── 7. 临时 trace：此刻起才有落盘副作用 ──────────────────────────────────────────────
  // `root` 省略第 6 参 forkRun：那是"显式的空分叉"才用的通道，根运行的 parent/fork 必须为
  // null，包装器也据此把 origin 记为 `import`。
  const tracesDir = join(dataDir, WORKSPACE_TRACES_DIR_NAME);
  // ⚠️ `JsonlTracer` 只负责写文件、**不建目录**（`onMeta` 直接 `openSync(file, "a")`）——
  // 目录是编排层的活，漏了会得到 ENOENT。
  mkdirSync(tracesDir, { recursive: true });
  const runId = newIsolatedRootRunId();
  const tmpFile = join(
    tracesDir,
    `tmp-isolated-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  const delegate = new JsonlTracer(tmpFile);
  const tracer = createWorkspaceCheckpointTracer({
    delegate,
    world,
    runId,
    origin: { kind: "import" },
  });

  // 起点消息恒为 system + user：system 可取空串（与 A1 的 `runs:create` 同口径，
  // 保证这个 run 也能作为 prompt fork 父本）。
  const messages: Message[] = [
    { role: "system", content: config.systemPrompt },
    { role: "user", content: userMessage },
  ];

  let outcome: RunResult | null = null;
  let landedId: string | null = null;
  // 身份观察挂在**底层 delegate** 上：包装器先把 id/world_id 替换成最终隔离 id 再调
  // delegate.startRun，所以这里收到的一定是最终 meta.id（临时文件名与 loop 自造 id 都不外泄）。
  const releaseIdentityWatch = observeRunIdentity(delegate, options.onRunIdentified);
  try {
    outcome = await runLoop(config, messages, tracer, tools, llm ?? new OpenAiCompatClient(config));
  } finally {
    releaseIdentityWatch();
    // 异常清理（1.5 交付的 `dispose`）：只关句柄、不写终止事件，未封存状态原样保留。
    // **顺序**先于 rename：不要依赖平台的句柄语义（本机实测 Node 在 Windows 上以
    // FILE_SHARE_DELETE 打开文件，未关闭也能改名/删除；换成句柄语义更严的文件系统就会失败）。
    // 显式关闭本次句柄是资源纪律，封存后调用 `dispose` 是幂等的。
    delegate.dispose();

    // 成功与 errored 都归位：errored run 是有价值的失败现场（A4 的详情落盘在其中）。
    // `readRun` 会做完整校验（含 v2 的 workspace/origin 关联），失败即抛——那意味着产出的
    // trace 不合法，保留 tmp 供排查比强行改名更诚实。
    if (existsSync(tmpFile)) {
      landedId = readRun(tmpFile).meta.id;
      renameSync(tmpFile, join(tracesDir, `${landedId}.jsonl`));
    }
  }

  if (outcome === null || landedId === null) {
    return fail(
      "run_not_landed",
      "隔离运行未产出 trace 文件（loop 未走到 startRun，或临时文件已丢失）",
    );
  }

  return { ok: true, id: landedId, outcome };
}
