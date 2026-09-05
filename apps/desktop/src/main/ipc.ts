import { ipcMain } from "electron";
import {
  CHANNELS,
  ForkRunRequestSchema,
  ProxyForkRequestSchema,
  ProxyToggleInputSchema,
  SettingsInputSchema,
  fail,
  ok,
} from "../shared/ipc";
import type {
  ForkRunResult,
  ListRunsData,
  ProxyForkResult,
  ProxyState,
  RunDetail,
  SettingsState,
} from "../shared/ipc";
import { ForkError, runFork } from "./fork-runner";
import type { ProxyManager } from "./proxy-manager";
import { ProxyForkError } from "./proxy-manager";
import type { RunRepository } from "./run-repository";
import type { SettingsStore } from "./settings";

/**
 * IPC 处理器注册。任何异常都收敛为信封返回——不让异常跨越进程边界。
 *
 * 写通道纪律：runs:fork / proxy:fork 是仅有的两个能产生文件写入的通道
 * （都只新建 fork run 文件）；settings 三通道只读写 <数据目录>/settings.json，
 * apiKey 与代理捕获的 key 永不回传渲染层。
 */
export interface IpcDeps {
  repository: RunRepository;
  settings: SettingsStore;
  /** 工具执行的工作目录（重跑工具与首次同权限同 cwd，落在数据目录） */
  execCwd: string;
  /** 本地录制代理编排（启停/key 暂存/代理分叉） */
  proxy: ProxyManager;
}

export function registerIpc(deps: IpcDeps): void {
  const { repository, settings, execCwd, proxy } = deps;

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

      // 3. 编排重跑；ForkError 的 code 原样透传给渲染层做提示
      try {
        const result = await runFork({ repository, settings: loaded, execCwd }, parsed.data);
        return ok({ id: result.id });
      } catch (e) {
        if (e instanceof ForkError) {
          return fail(e.code, e);
        }
        // replayRun / derive 的领域错误（空 fork、config_hash 不一致、父未封存等）
        return fail("FORK_FAILED", e);
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
}
