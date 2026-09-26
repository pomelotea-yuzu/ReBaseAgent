import { ModelAbError } from "@rebaseagent/replay";
import { dialog } from "electron";
import { ipcMain } from "electron";
import {
  CHANNELS,
  CreateRunRequestSchema,
  ForkCapabilityRequestSchema,
  ForkRunRequestSchema,
  ModelAbRequestSchema,
  PromptForkRequestSchema,
  ProxyForkRequestSchema,
  ProxyToggleInputSchema,
  SettingsInputSchema,
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
import type { OperationStatusResult } from "../shared/operations";
import {
  ForkError,
  runFork,
  runForkCapability,
  runForkIsolated,
  runModelAb,
  runPromptFork,
} from "./fork-runner";
import type { OperationRegistry } from "./operation-registry";
import type { ProxyManager } from "./proxy-manager";
import { ProxyForkError } from "./proxy-manager";
import { CreateRunError, runCreate, runCreateIsolated } from "./run-create";
import type { RunRepository } from "./run-repository";
import type { SettingsStore } from "./settings";
import { SourceTokenStore } from "./source-token";
import { inspectWorkspace, readWorkspaceFileForView } from "./workspace-view";

/**
 * IPC 处理器注册。任何异常都收敛为信封返回——不让异常跨越进程边界。
 *
 * 写通道纪律：runs:fork / runs:create / proxy:fork 是仅有三个能产生 run 文件
 * 写入的通道；workspaces:chooseSource / workspaces:forkCapability 只读
 * （目录选择不落盘、能力预检不写 trace/blob 不请求模型）；
 * settings 三通道只读写 <数据目录>/settings.json，
 * apiKey 与代理捕获的 key 永不回传渲染层。
 * operations:status 只读——返回 main 会话的操作快照，不执行业务、不改登记。
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
  /** 原生目录选择（可注入测试桩；缺省 = Electron dialog，只选不写） */
  pickDirectory?: () => Promise<string | null>;
}

export function registerIpc(deps: IpcDeps): void {
  const { repository, settings, execCwd, dataDir, proxy, operations } = deps;
  const pickDirectory =
    deps.pickDirectory ??
    (async (): Promise<string | null> => {
      const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0] ?? null;
    });
  // 会话令牌随应用生命周期存活；15 分钟 TTL 与一次性消费见 source-token.ts
  const sourceTokens = new SourceTokenStore();

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

  ipcMain.handle(
    CHANNELS.forkRun,
    async (
      _event,
      request: unknown,
    ): Promise<ReturnType<typeof ok<ForkRunResult>> | ReturnType<typeof fail>> => {
      // 1. 请求形状校验（parentRunId/atSpanId/edit 齐全、field 为 result）
      const parsed = ForkRunRequestSchema.safeParse(request);
      if (!parsed.success) {
        return fail("INVALID_ARGUMENT", parsed.error);
      }

      // 2. 运行配置必须已就绪（未配置不发任何网络请求）
      const loaded = settings.load();
      if (loaded === null) {
        return fail(
          "SETTINGS_NOT_CONFIGURED",
          new Error("尚未配置运行参数（baseURL / apiKey / model），请先完成运行配置"),
        );
      }

      // 3. 编排重跑；ForkError 的 code 原样透传给渲染层做提示。
      //    隔离父本必须走 execution 分支（replayIsolatedRun）；不带 execution 的请求
      //    落进普通 runFork，会被 A 的隔离父本门禁拒绝（严格匹配、不降级——见 design §1）
      try {
        const result =
          parsed.data.execution !== undefined
            ? await runForkIsolated(
                { repository, settings: loaded, dataDir },
                {
                  parentRunId: parsed.data.parentRunId,
                  atSpanId: parsed.data.atSpanId,
                  edit: parsed.data.edit,
                  execution: parsed.data.execution,
                },
              )
            : await runFork({ repository, settings: loaded, execCwd }, parsed.data);
        return ok({ id: result.id });
      } catch (e) {
        if (e instanceof ForkError) {
          return fail(e.code, e);
        }
        // replayRun / replayIsolatedRun / derive 的领域错误（空 fork、config_hash 不一致、父未封存等）
        return fail("FORK_FAILED", e);
      }
    },
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
    async (
      _event,
      request: unknown,
    ): Promise<ReturnType<typeof ok<PromptForkResult>> | ReturnType<typeof fail>> => {
      // 1. 请求形状校验（parentRunId/edit 齐全、field 为两个 prompt 字段之一）
      const parsed = PromptForkRequestSchema.safeParse(request);
      if (!parsed.success) {
        return fail("INVALID_ARGUMENT", parsed.error);
      }

      // 2. 运行配置必须已就绪（未配置不发任何网络请求）
      const loaded = settings.load();
      if (loaded === null) {
        return fail(
          "SETTINGS_NOT_CONFIGURED",
          new Error("尚未配置运行参数（baseURL / apiKey / model），请先完成运行配置"),
        );
      }

      // 3. 编排从头重跑；ForkError 的 code 原样透传（如 PROMPT_FORK_NO_SYSTEM）
      try {
        const result = await runPromptFork({ repository, settings: loaded, execCwd }, parsed.data);
        return ok({ id: result.id });
      } catch (e) {
        if (e instanceof ForkError) {
          return fail(e.code, e);
        }
        // promptReplayRun / derive 的领域错误（proxy run、空 fork、父未封存等）
        return fail("PROMPT_FORK_FAILED", e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // runs:modelAb —— 模型 / 采样参数 A/B 实验（一次调用 = 一批，至少两个 arm）
  // -------------------------------------------------------------------------

  ipcMain.handle(
    CHANNELS.modelAb,
    async (
      _event,
      request: unknown,
    ): Promise<ReturnType<typeof ok<ModelAbResult>> | ReturnType<typeof fail>> => {
      const parsed = ModelAbRequestSchema.safeParse(request);
      if (!parsed.success) {
        return fail("INVALID_ARGUMENT", parsed.error);
      }

      // 运行配置必须已就绪（未配置不发任何网络请求；dry-run 也要展示 provider）
      const loaded = settings.load();
      if (loaded === null) {
        return fail(
          "SETTINGS_NOT_CONFIGURED",
          new Error("尚未配置运行参数（baseURL / apiKey / model），请先完成运行配置"),
        );
      }

      try {
        return ok(await runModelAb({ repository, settings: loaded, execCwd }, parsed.data));
      } catch (e) {
        // 编排层的稳定错误码（父不可 fork / 工具策略 / 双真相源 / 未确认费用…）
        if (e instanceof ModelAbError) {
          return fail(`MODEL_AB_${e.code}`, e);
        }
        if (e instanceof ForkError) {
          return fail(e.code, e);
        }
        return fail("MODEL_AB_FAILED", e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // runs:create —— 原生 run 创建（从头执行，无父 run；与上面三条重跑语义正交）
  // -------------------------------------------------------------------------

  ipcMain.handle(
    CHANNELS.createRun,
    async (
      _event,
      request: unknown,
    ): Promise<ReturnType<typeof ok<CreateRunResult>> | ReturnType<typeof fail>> => {
      // 1. 请求形状校验（systemPrompt 可空、userMessage 非空）
      const parsed = CreateRunRequestSchema.safeParse(request);
      if (!parsed.success) {
        return fail("INVALID_ARGUMENT", parsed.error);
      }

      // 2. 运行配置必须已就绪（未配置不发任何网络请求、不产生任何文件）
      const loaded = settings.load();
      if (loaded === null) {
        return fail(
          "SETTINGS_NOT_CONFIGURED",
          new Error("尚未配置运行参数（baseURL / apiKey / model），请先完成运行配置"),
        );
      }

      // 3. 从头执行；CreateRunError 的 code 原样透传给渲染层做提示。
      //    workspace 存在 = 隔离文件模式：先消费 sourceToken 换出真实路径（一次性，
      //    失败也视为已消费——每次新操作都要重新选择与确认），再交 A 包编排
      const workspaceSelection = parsed.data.workspace;
      try {
        const result =
          workspaceSelection !== undefined
            ? await ((): Promise<{ id: string }> => {
                const consumed = sourceTokens.consume(workspaceSelection.sourceToken);
                if (!consumed.ok) {
                  throw new CreateRunError(
                    "INVALID_SOURCE_TOKEN",
                    consumed.reason === "expired"
                      ? "所选目录的确认已过期（超过 15 分钟），请重新选择目录并确认副本写入"
                      : "目录选择凭证无效（不存在、已被使用或来自其他会话），请重新选择目录",
                  );
                }
                return runCreateIsolated(
                  {
                    repository,
                    settings: loaded,
                    execCwd,
                    dataDir,
                    sourcePath: consumed.path,
                  },
                  {
                    systemPrompt: parsed.data.systemPrompt,
                    userMessage: parsed.data.userMessage,
                    workspace: workspaceSelection,
                  },
                );
              })()
            : await runCreate({ repository, settings: loaded, execCwd }, parsed.data);
        return ok({ id: result.id });
      } catch (e) {
        if (e instanceof CreateRunError) {
          return fail(e.code, e);
        }
        return fail("CREATE_RUN_FAILED", e);
      }
    },
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
    async (
      _event,
      input: unknown,
    ): Promise<ReturnType<typeof ok<{ configured: true }>> | ReturnType<typeof fail>> => {
      const parsed = SettingsInputSchema.safeParse(input);
      if (!parsed.success) {
        return fail("INVALID_ARGUMENT", parsed.error);
      }
      try {
        settings.save(parsed.data);
        return ok({ configured: true });
      } catch (e) {
        return fail("SETTINGS_SAVE_FAILED", e);
      }
    },
  );

  ipcMain.handle(CHANNELS.settingsClear, (): ReturnType<typeof ok<{ configured: false }>> => {
    try {
      settings.clear();
      return ok({ configured: false });
    } catch (e) {
      return fail("SETTINGS_CLEAR_FAILED", e);
    }
  });

  // -------------------------------------------------------------------------
  // proxy —— 本地录制代理（启停即保存；key 只回 hasKey 布尔）
  // -------------------------------------------------------------------------

  ipcMain.handle(CHANNELS.proxyStatus, (): ReturnType<typeof ok<ProxyState>> => {
    return ok(proxy.status());
  });

  ipcMain.handle(
    CHANNELS.proxyToggle,
    async (
      _event,
      input: unknown,
    ): Promise<ReturnType<typeof ok<ProxyState>> | ReturnType<typeof fail>> => {
      const parsed = ProxyToggleInputSchema.safeParse(input);
      if (!parsed.success) {
        return fail("INVALID_ARGUMENT", parsed.error);
      }
      try {
        return ok(await proxy.toggle(parsed.data));
      } catch (e) {
        return fail("PROXY_START_FAILED", e);
      }
    },
  );

  ipcMain.handle(
    CHANNELS.proxyFork,
    async (
      _event,
      request: unknown,
    ): Promise<ReturnType<typeof ok<ProxyForkResult>> | ReturnType<typeof fail>> => {
      const parsed = ProxyForkRequestSchema.safeParse(request);
      if (!parsed.success) {
        return fail("INVALID_ARGUMENT", parsed.error);
      }
      try {
        return ok(await proxy.fork(parsed.data));
      } catch (e) {
        if (e instanceof ProxyForkError) {
          return fail(e.code, e);
        }
        return fail("PROXY_FORK_FAILED", e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // operations:status —— 只读握手/快照（design D4）：无参、不执行业务、不消费授权
  // -------------------------------------------------------------------------

  ipcMain.handle(
    CHANNELS.operationsStatus,
    (): ReturnType<typeof ok<OperationStatusResult>> | ReturnType<typeof fail> => {
      try {
        // snapshot() 出口自带契约与自洽校验：main 一旦造出矛盾快照就抛错 ⇒ 失败信封，
        // renderer 据此保留未知与锁，而不是部分采纳所谓成功字段
        return ok(operations.snapshot());
      } catch (e) {
        return fail("OPERATIONS_STATUS_FAILED", e);
      }
    },
  );
}
