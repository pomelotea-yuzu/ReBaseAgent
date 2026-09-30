import { dialog, ipcMain } from "electron";
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
import { ForkError, runForkCapability } from "./fork-runner";
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
  /** 配置写通道（settings 保存/清除、代理启停）共用同一份判据与锁（tasks 3.5/3.6） */
  const configDeps: ConfigEndpointDeps = {
    settings,
    proxy,
    registry: operations,
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
  };
  const pickDirectory =
    deps.pickDirectory ??
    (async (): Promise<string | null> => {
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
        // 数据状态（text/binary/not_found/missing/corrupt/rejected）一律**成功返回**：
        // 它们是"这条路径现在是什么"，不是 IPC 故障——渲染层必须能逐态区分展示
        return ok(await readWorkspaceFileForView({ dataDir, repository }, parsed.data));
      } catch (e) {
        return fail("WORKSPACE_READ_FAILED", e);
      }
    },
  );

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
