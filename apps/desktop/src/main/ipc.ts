import { appendFileSync, readFileSync } from "node:fs";
import {
  DockerCollectBackend,
  DockerCommandBackend,
  DockerMaterializationBackend,
  DockerPreparationBackend,
  DockerRuntimeBackend,
  DockerStopBackend,
  type LocalBackendEndpoint,
  resolveDockerCli,
} from "@rebaseagent/project-verification";
import { app, dialog, ipcMain } from "electron";
import {
  CHANNELS,
  ForkCapabilityRequestSchema,
  WorkspaceInspectRequestSchema,
  WorkspaceReadFileRequestSchema,
  fail,
  ok,
} from "../shared/ipc";
import type {
  ChooseSourceResult,
  CreateRunResult,
  ForkCapabilityResult,
  ForkRunResult,
  ListRunsData,
  ModelAbResult,
  PromptForkResult,
  ProxyForkResult,
  ProxyState,
  RunDetail,
  SettingsState,
  WorkspaceInspectResult,
  WorkspaceReadFileResult,
} from "../shared/ipc";
import type {
  ExecutedResponse,
  OperationStatusResult,
  ReconcileResult,
} from "../shared/operations";
import { compareRunsEndpoint } from "./compare-endpoints";
import {
  type ConfigEndpointDeps,
  clearRunSettings,
  toggleProxy,
  writeRunSettings,
} from "./config-endpoints";
import {
  type ExecEndpointDeps,
  execCreateRun,
  execForkRun,
  execModelAb,
  execModelAbPlan,
  execPromptFork,
  execProxyFork,
} from "./exec-endpoints";
import { ExecutionConfigState } from "./execution-config-state";
import { ForkError, runForkCapability } from "./fork-runner";
import { runIsolatedPromptCapability } from "./isolated-prompt-endpoints";
import {
  type OperationEndpointDeps,
  type TrustedSender,
  readOperationStatus,
  reconcileOperation,
} from "./operation-endpoints";
import type { OperationRegistry } from "./operation-registry";
import { RequestFingerprinter } from "./operation-request";
import type { ProxyManager } from "./proxy-manager";
import type { RunRepository } from "./run-repository";
import { RunSourceRejection } from "./run-source-gate";
import type { SettingsStore } from "./settings";
import { SourceTokenStore } from "./source-token";
import { execVerificationPrepare, execVerificationRun } from "./verification-endpoints";
import {
  type VerificationReadonlyDeps,
  verificationCapability,
  verificationGet,
  verificationList,
  verificationPreparePlan,
  verificationReadLog,
} from "./verification-read-endpoints";
import {
  compareWorkspaceSnapshotsEndpoint,
  readComparedWorkspaceFileEndpoint,
} from "./workspace-compare-endpoint";
import { exportWorkspaceEndpoint, workspaceExportEnvelope } from "./workspace-export-endpoint";
import type { WorkspaceExportEndpointDeps } from "./workspace-export-endpoint";
import { inspectWorkspace, readWorkspaceFileForView } from "./workspace-view";

/**
 * IPC 处理器注册。任何异常都收敛为信封返回——不让异常跨越进程边界。
 *
 * 通道纪律（U4 之后）：
 * - **主动执行**（runs:fork / runs:promptFork / runs:modelAb / runs:create / proxy:fork）
 *   全部转交 `exec-endpoints`：必须带 `{operation, request}` 信封，main 判重 + 占槽
 *   之后才读配置、消费 sourceToken、导入源目录、调模型/工具。缺身份的直接拒绝——
 *   这里**不留"无身份后门"**（Migration 的硬要求）。
 * - **只读**（runs:list / runs:get / workspaces:* / runs:modelAbPlan / settings:get /
 *   proxy:status / operations:status）不占主动槽、不消耗授权；operations:reconcile
 *   只改 main 内存里的封禁记录。
 * - **配置写**（settings:save/clear、proxy:toggle）经 `config-endpoints` 判锁。
 * apiKey 与代理捕获的 key 永不回传渲染层。
 */
export interface IpcDeps {
  repository: RunRepository;
  settings: SettingsStore;
  /** 工具执行的工作目录（重跑工具与首次同权限同 cwd，落在数据目录） */
  execCwd: string;
  /** 数据目录（隔离创建/续跑的 trace 与附件锚点，main 按便携策略解析） */
  dataDir: string;
  /** 本地录制代理编排（启停/key 暂存/代理分叉） */
  proxy: ProxyManager;
  /**
   * U4：main 会话内唯一的操作登记与主动执行槽（bootstrap 创建一次、全窗口共用）。
   * 判重、占槽、状态快照都以它为准——renderer 的本地 busy 只是补空隙。
   */
  operations: OperationRegistry;
  /**
   * U4：sender 可信度判据——「本应用创建的窗口的**主 frame**」才放行。
   * status/reconcile 与全部主动执行通道都在任何副作用之前过这一关（design D6）。
   */
  isTrustedSender: (sender: TrustedSender) => boolean;
  /** 原生目录选择（可注入测试桩；缺省 = Electron dialog，只选不写） */
  pickDirectory?: () => Promise<string | null>;
}

export function registerIpc(deps: IpcDeps): void {
  const { repository, settings, execCwd, dataDir, proxy, operations, isTrustedSender } = deps;
  const endpointDeps: OperationEndpointDeps = { registry: operations, isTrustedSender };
  /**
   * R2.2：执行配置修订的唯一拥有者（main 装配一次，注入配置写、预检与执行端点）。
   * 只比较 main 内存里的实际值；密钥不离开 main，也不以 secret 哈希构造修订。
   */
  const configState = new ExecutionConfigState(settings);
  /** 配置写通道（settings 保存/清除、代理启停）共用同一份判据与锁（tasks 3.5/3.6） */
  const configDeps: ConfigEndpointDeps = {
    settings,
    proxy,
    registry: operations,
    configState,
    isTrustedSender,
  };
  /**
   * 七个主动执行入口共用同一份依赖与同一套接受序列（tasks 3.1–3.4）。
   * 指纹密钥随 main 会话随机 ⇒ 摘要只在本次会话内有意义，且从不跨进程回传。
   * 会话令牌随应用生命周期存活；15 分钟 TTL 与一次性消费见 source-token.ts——
   * 消费只发生在**已被接受**的操作里（判重先于许可消费）。
   */
  const sourceTokens = new SourceTokenStore();
  const execDeps: ExecEndpointDeps = {
    registry: operations,
    fingerprinter: new RequestFingerprinter(),
    isTrustedSender,
    repository,
    settings,
    execCwd,
    dataDir,
    proxy,
    sourceTokens,
    configState,
    // R3 依赖（4.2）：Docker Desktop CLI 可信位置在场才装配；缺席 ⇒ R3 通道拒绝（P01：
    // 不隐式安装、不回退宿主 Shell）。endpoint 钉死本机管道（schema 枚举），不读 env。
    verification: assembleVerificationDeps(dataDir),
  };
  // R3 只读面依赖（4.3）：与执行面同根；CLI 缺席 ⇒ 引擎健康 available:false（P01）
  const verificationReadonly: VerificationReadonlyDeps = {
    dataRoot: dataDir,
    dataDir,
    docker: assembleVerificationDocker(),
    isTrustedSender,
  };
  const pickDirectory =
    deps.pickDirectory ??
    (async (): Promise<string | null> => {
      // 实机验收钩子（仅 dev；与 REBASEAGENT_ZOOM_FACTOR 同一先例）：OS 原生目录对话框
      // 无法被 CDP 自动化，导出链路的端到端验收用**控制文件**注入目录选择结果——
      // env REBASEAGENT_PICK_DIRECTORY_FILE 指向一个文本文件，每次目录选择时读取：
      //   `__cancel__` → 模拟用户取消（null）；空/缺失/`__real__` → 真原生对话框；
      //   其余非空行 → 作为用户选定的目标路径返回（校验全部照常走）。
      // 每次接管都会向 `<file>.calls.log` 追加一行时间戳（验收可断言"对话框未被打开"）。
      // 打包版永不读取该变量。
      const pickFile = app.isPackaged ? undefined : process.env.REBASEAGENT_PICK_DIRECTORY_FILE;
      if (pickFile !== undefined) {
        let instruction: string | null = null;
        try {
          instruction = readFileSync(pickFile, "utf8").trim();
        } catch {
          instruction = null; // 文件缺失 → 真对话框
        }
        if (instruction !== null && instruction !== "__real__") {
          appendFileSync(`${pickFile}.calls.log`, `${new Date().toISOString()}\n`);
          return instruction === "__cancel__" ? null : instruction;
        }
      }
      const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0] ?? null;
    });

  ipcMain.handle(
    CHANNELS.listRuns,
    (): ReturnType<typeof ok<ListRunsData>> | ReturnType<typeof fail> => {
      try {
        return ok(repository.listRuns());
      } catch (e) {
        return fail("LIST_RUNS_FAILED", e);
      }
    },
  );

  ipcMain.handle(
    CHANNELS.getRun,
    (_event, id: unknown): ReturnType<typeof ok<RunDetail>> | ReturnType<typeof fail> => {
      if (typeof id !== "string") {
        return fail("INVALID_ARGUMENT", new Error("run id 必须是字符串"));
      }
      try {
        return ok(repository.getRun(id));
      } catch (e) {
        return fail("GET_RUN_FAILED", e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // runs:compare —— 只读比较（U7 design D3）：逐项 ready/unavailable，
  // 请求级拒绝走信封失败；单侧读取失败是数据状态，仍以 ok 信封逐项返回
  // -------------------------------------------------------------------------

  ipcMain.handle(
    CHANNELS.compareRuns,
    (
      _event,
      request: unknown,
    ): ReturnType<typeof ok<{ items: unknown[] }>> | ReturnType<typeof fail> => {
      const outcome = compareRunsEndpoint({ tracesDir: repository.tracesDir }, request);
      return outcome.ok
        ? ok({ items: outcome.items })
        : fail(outcome.code, new Error(outcome.message));
    },
  );

  // -------------------------------------------------------------------------
  // 主动执行通道（runs:fork / runs:promptFork / runs:modelAb / runs:create /
  // proxy:fork）：全部经 `exec-endpoints` —— sender/信封/epoch 校验、一次业务解析、
  // 判重与占槽都在那里，端点体不 import electron、可直测。
  // -------------------------------------------------------------------------

  ipcMain.handle(
    CHANNELS.forkRun,
    (event, request: unknown): Promise<ExecutedResponse<ForkRunResult>> =>
      execForkRun(execDeps, senderOf(event), request),
  );

  // -------------------------------------------------------------------------
  // workspaces:chooseSource —— 原生目录选择（只读：不导入、不写 trace/blob）
  // -------------------------------------------------------------------------

  ipcMain.handle(
    CHANNELS.chooseSource,
    async (): Promise<ReturnType<typeof ok<ChooseSourceResult>> | ReturnType<typeof fail>> => {
      try {
        const picked = await pickDirectory();
        if (picked === null) {
          // 取消不签发 token（design §1）
          return ok({ canceled: true } satisfies ChooseSourceResult);
        }
        const issued = sourceTokens.issue(picked);
        return ok({
          canceled: false,
          sourceToken: issued.token,
          name: issued.name,
          path: picked,
          expiresAt: issued.expiresAt,
        } satisfies ChooseSourceResult);
      } catch (e) {
        return fail("CHOOSE_SOURCE_FAILED", e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // workspaces:forkCapability —— 隔离分叉的只读能力预检（确认区数据源）
  // -------------------------------------------------------------------------

  ipcMain.handle(
    CHANNELS.forkCapability,
    async (
      _event,
      request: unknown,
    ): Promise<ReturnType<typeof ok<ForkCapabilityResult>> | ReturnType<typeof fail>> => {
      const parsed = ForkCapabilityRequestSchema.safeParse(request);
      if (!parsed.success) {
        return fail("INVALID_ARGUMENT", parsed.error);
      }
      // 预检不请求模型，但 config_hash 依赖 settings.model/baseURL 的口径与正式提交一致
      const loaded = settings.load();
      if (loaded === null) {
        return fail(
          "SETTINGS_NOT_CONFIGURED",
          new Error("尚未配置运行参数（baseURL / apiKey / model），请先完成运行配置"),
        );
      }
      try {
        const result = await runForkCapability(
          { repository, settings: loaded, dataDir },
          parsed.data,
        );
        return ok(result);
      } catch (e) {
        if (e instanceof ForkError) {
          return fail(e.code, e);
        }
        // U6 §5.8：来源门禁拒绝（ownOnly / 详情不可读）按稳定码回话，不落兜底码
        if (e instanceof RunSourceRejection) {
          return fail(e.code, e);
        }
        return fail("FORK_CAPABILITY_FAILED", e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // workspaces:isolatedPromptCapability —— 隔离 prompt 实验只读预检（R2.2）
  // 领域拒绝以 ok 信封的 status=unavailable 返回（含 rootId 导航建议）；
  // 不登记 operation、不占槽、不写文件、不调模型。
  // -------------------------------------------------------------------------

  ipcMain.handle(CHANNELS.isolatedPromptCapability, async (_event, request: unknown) =>
    runIsolatedPromptCapability({ dataDir, configState }, request),
  );

  // -------------------------------------------------------------------------
  // workspaces:compareSnapshots / compareFile —— 跨运行检查点比较（R2.2 4.x）
  // 两条都只读：清单通道只给引用状态，正文通道按 path 延迟核验并在
  // expectedSnapshotIds 不符时逐侧 selection_changed；不登记/不占槽/不消费授权。
  // -------------------------------------------------------------------------

  ipcMain.handle(CHANNELS.compareSnapshots, (_event, request: unknown) =>
    compareWorkspaceSnapshotsEndpoint({ dataDir }, request),
  );

  ipcMain.handle(CHANNELS.compareFile, async (_event, request: unknown) =>
    readComparedWorkspaceFileEndpoint({ dataDir }, request),
  );

  // -------------------------------------------------------------------------
  // workspaces:inspect / workspaces:readFile —— 文件检查点与差异（只读；C 1.1）
  // -------------------------------------------------------------------------

  ipcMain.handle(
    CHANNELS.inspect,
    async (
      _event,
      request: unknown,
    ): Promise<ReturnType<typeof ok<WorkspaceInspectResult>> | ReturnType<typeof fail>> => {
      const parsed = WorkspaceInspectRequestSchema.safeParse(request);
      if (!parsed.success) {
        return fail("INVALID_ARGUMENT", parsed.error);
      }
      try {
        // 本层不解析"桌面默认"（最近自有完成步骤）：renderer 必须先把默认选择器解析成显式
        // stepSpanId 再调用。请求缺省只等于共享层语义：本 run 的初始快照。
        const outcome = await inspectWorkspace({ dataDir, repository }, parsed.data);
        // 定位失败（非法 runId / 清单被篡改 / 非隔离 run / 祖先 step）是**可展示的拒绝**，
        // 不是异常：渲染层据此给出具体原因，不用"当前目录"或父 run 历史兜底
        return outcome.ok ? ok(outcome.result) : fail(outcome.code, new Error(outcome.message));
      } catch (e) {
        return fail("WORKSPACE_INSPECT_FAILED", e);
      }
    },
  );

  ipcMain.handle(
    CHANNELS.readFile,
    async (
      _event,
      request: unknown,
    ): Promise<ReturnType<typeof ok<WorkspaceReadFileResult>> | ReturnType<typeof fail>> => {
      const parsed = WorkspaceReadFileRequestSchema.safeParse(request);
      if (!parsed.success) {
        return fail("INVALID_ARGUMENT", parsed.error);
      }
      try {
        // 缺省 stepSpanId = 初始快照（共享层语义）；桌面"最近自有完成步骤"由 renderer 先解析为显式 selector。
        // 数据状态（text/binary/not_found/missing/corrupt/rejected）一律**成功返回**：
        // 它们是"这条路径现在是什么"，不是 IPC 故障——渲染层必须能逐态区分展示
        return ok(await readWorkspaceFileForView({ dataDir, repository }, parsed.data));
      } catch (e) {
        return fail("WORKSPACE_READ_FAILED", e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // workspaces:export —— 导出选定检查点（R2.1）：唯一显式写目标目录的
  // workspaces 通道。目标目录只能来自 main 的原生对话框；目录返回后、写入前
  // 重验完整父链；不登记 operation、不占主动槽、不消费授权。同 main 的在飞
  // 保护是闭包变量——renderer 重载不解除（design D5）。结局以判别式 outcome
  // 成功返回，信封失败只留给请求形状非法（端点内部收敛，见 endpoint 模块）。
  // -------------------------------------------------------------------------

  let exportInFlight = false;
  const exportDeps: WorkspaceExportEndpointDeps = {
    dataDir,
    tracesDir: repository.tracesDir,
    pickDirectory,
    acquireSlot: () => {
      if (exportInFlight) return false;
      exportInFlight = true;
      return true;
    },
    releaseSlot: () => {
      exportInFlight = false;
    },
  };

  ipcMain.handle(CHANNELS.exportCheckpoint, async (_event, request: unknown) => {
    const result = await exportWorkspaceEndpoint(exportDeps, request);
    // 端点结果 → IPC 信封（renderer 只认 Envelope；漏包会让反馈永久卡 in-flight）
    return workspaceExportEnvelope(result);
  });

  // -------------------------------------------------------------------------
  // runs:promptFork —— 编辑启动上下文从头重跑（与 runs:fork 语义正交的写通道）
  // -------------------------------------------------------------------------

  ipcMain.handle(
    CHANNELS.promptFork,
    (event, request: unknown): Promise<ExecutedResponse<PromptForkResult>> =>
      execPromptFork(execDeps, senderOf(event), request),
  );
  // -------------------------------------------------------------------------
  // runs:modelAb —— 模型 / 采样参数 A/B 实验（一次调用 = 一批，至少两个 arm）
  // -------------------------------------------------------------------------

  ipcMain.handle(
    CHANNELS.modelAb,
    (event, request: unknown): Promise<ExecutedResponse<ModelAbResult>> =>
      execModelAb(execDeps, senderOf(event), request),
  );

  // runs:modelAbPlan —— A/B 预览的只读分支：不占主动槽、不要求执行身份（design D1/D3）
  ipcMain.handle(
    CHANNELS.modelAbPlan,
    (
      event,
      request: unknown,
    ): Promise<ReturnType<typeof ok<ModelAbResult>> | ReturnType<typeof fail>> =>
      execModelAbPlan(execDeps, senderOf(event), request),
  );
  // -------------------------------------------------------------------------
  // runs:create —— 原生 run 创建（从头执行，无父 run；与上面三条重跑语义正交）
  // -------------------------------------------------------------------------

  ipcMain.handle(
    CHANNELS.createRun,
    (event, request: unknown): Promise<ExecutedResponse<CreateRunResult>> =>
      execCreateRun(execDeps, senderOf(event), request),
  );

  // -------------------------------------------------------------------------
  // verification:prepare / verification:run —— R3 环境准备与项目验证（4.2）：
  // 两条主动执行通道与七入口同一接受序列；领域身份经真实回调关联（M01/D03）
  // -------------------------------------------------------------------------

  ipcMain.handle(CHANNELS.verificationPrepare, (event, request: unknown) =>
    execVerificationPrepare(execDeps, senderOf(event), request),
  );
  ipcMain.handle(CHANNELS.verificationRun, (event, request: unknown) =>
    execVerificationRun(execDeps, senderOf(event), request),
  );
  // verification 只读面（4.3）：不登记 operation、不占槽、不执行/清理
  ipcMain.handle(CHANNELS.verificationCapability, (event, request: unknown) =>
    verificationCapability(verificationReadonly, senderOf(event), request as never),
  );
  ipcMain.handle(CHANNELS.verificationPreparePlan, (event, request: unknown) =>
    verificationPreparePlan(verificationReadonly, senderOf(event), request as never),
  );
  ipcMain.handle(CHANNELS.verificationList, (event) =>
    verificationList(verificationReadonly, senderOf(event), {}),
  );
  ipcMain.handle(CHANNELS.verificationGet, (event, request: unknown) =>
    verificationGet(verificationReadonly, senderOf(event), request as never),
  );
  ipcMain.handle(CHANNELS.verificationReadLog, (event, request: unknown) =>
    verificationReadLog(verificationReadonly, senderOf(event), request as never),
  );
  ipcMain.handle(
    CHANNELS.settingsGet,
    (): ReturnType<typeof ok<SettingsState>> | ReturnType<typeof fail> => {
      let loaded: ReturnType<SettingsStore["load"]>;
      try {
        loaded = settings.load();
      } catch (e) {
        // 解密失败（如系统密钥环境变化）也要能展示，引导用户清除后重配
        return fail("SETTINGS_LOAD_FAILED", e);
      }
      if (loaded === null) {
        return ok({
          configured: false,
          baseURL: null,
          model: null,
          // 未配置时预告"保存后将采用的方式"
          encryption: settings.isEncryptionAvailable() ? "safe" : "plain",
        });
      }
      return ok({
        configured: true,
        baseURL: loaded.baseURL,
        model: loaded.model,
        encryption: loaded.encrypted ? "safe" : "plain",
      });
    },
  );

  ipcMain.handle(
    CHANNELS.settingsSave,
    (
      event,
      input: unknown,
    ): ReturnType<typeof ok<{ configured: true }>> | ReturnType<typeof fail> =>
      writeRunSettings(configDeps, senderOf(event), input),
  );

  ipcMain.handle(
    CHANNELS.settingsClear,
    (event): ReturnType<typeof ok<{ configured: false }>> | ReturnType<typeof fail> =>
      clearRunSettings(configDeps, senderOf(event)),
  );

  // -------------------------------------------------------------------------
  // proxy —— 本地录制代理（启停即保存；key 只回 hasKey 布尔）
  // -------------------------------------------------------------------------

  ipcMain.handle(CHANNELS.proxyStatus, (): ReturnType<typeof ok<ProxyState>> => {
    return ok(proxy.status());
  });

  ipcMain.handle(
    CHANNELS.proxyToggle,
    (event, input: unknown): Promise<ReturnType<typeof ok<ProxyState>> | ReturnType<typeof fail>> =>
      toggleProxy(configDeps, senderOf(event), input),
  );

  ipcMain.handle(
    CHANNELS.proxyFork,
    (event, request: unknown): Promise<ExecutedResponse<ProxyForkResult>> =>
      execProxyFork(execDeps, senderOf(event), request),
  );
  // -------------------------------------------------------------------------
  // operations:status / operations:reconcile —— 状态查询与原子核对（design D4）
  // 都不执行业务、不消费授权、不写 trace/blob/source；reconcile 只改 main 内存封禁
  // -------------------------------------------------------------------------

  ipcMain.handle(
    CHANNELS.operationsStatus,
    (event): ReturnType<typeof ok<OperationStatusResult>> | ReturnType<typeof fail> =>
      readOperationStatus(endpointDeps, senderOf(event)),
  );

  ipcMain.handle(
    CHANNELS.operationsReconcile,
    (event, payload: unknown): ReturnType<typeof ok<ReconcileResult>> | ReturnType<typeof fail> =>
      reconcileOperation(endpointDeps, senderOf(event), payload),
  );
}

/**
 * 从 invoke 事件中提取受限发送者描述。`senderFrame` 取不到时给 -1——
 * 它必然不等于任何主 frame，因此走拒绝分支（宁可不放行，也不猜身份）。
 */
function senderOf(event: {
  sender: { id: number };
  senderFrame?: { routingId: number } | null;
}): TrustedSender {
  return {
    webContentsId: event.sender.id,
    frameRoutingId: event.senderFrame?.routingId ?? -1,
  };
}

/**
 * R3 只读面的 Docker 探测（4.3）：CLI 缺席 ⇒ null（引擎健康 available:false 呈现，
 * 不抛错——只读面要把不可用原因讲清楚，D01）。
 */
function assembleVerificationDocker(): {
  installation: import("@rebaseagent/project-verification").DockerCliInstallation;
  endpoint: import("@rebaseagent/project-verification").LocalBackendEndpoint;
} | null {
  const installation = resolveDockerCli();
  if (installation === null) {
    return null;
  }
  return { installation, endpoint: "npipe:////./pipe/dockerDesktopLinuxEngine" as const };
}

/**
 * R3 依赖装配（4.2）：Docker Desktop CLI 可信绝对路径在场才返回依赖；CLI 缺席 ⇒
 * undefined（verification:* 通道以 R3_NOT_CONFIGURED 拒绝——P01：不隐式安装、不回退）。
 * endpoint 钉死本机管道枚举值（不读 DOCKER_HOST/env，受控 env 见 3.2）。
 */
function assembleVerificationDeps(
  dataDir: string,
): import("./verification-endpoints").VerificationEndpointDeps | undefined {
  const docker = assembleVerificationDocker();
  if (docker === null) {
    return undefined;
  }
  const { installation, endpoint } = docker;
  const runtime = new DockerRuntimeBackend({ installation, endpoint });
  return {
    dataRoot: dataDir,
    backends: {
      preparation: new DockerPreparationBackend({ installation, endpoint }),
      run: {
        lifecycle: runtime,
        materialize: new DockerMaterializationBackend({ installation, endpoint }),
        command: new DockerCommandBackend({ installation, endpoint }),
        workloadStop: new DockerStopBackend({ installation, endpoint }),
        collect: new DockerCollectBackend({ installation, endpoint }),
      },
    },
  };
}
