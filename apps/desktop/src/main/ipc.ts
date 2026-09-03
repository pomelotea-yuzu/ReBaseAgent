import { ipcMain } from "electron";
import { CHANNELS, fail, ok } from "../shared/ipc";
import type { ListRunsData, RunDetail } from "../shared/ipc";
import type { RunRepository } from "./run-repository";

/**
 * IPC 处理器注册。任何异常都收敛为信封返回——不让异常跨越进程边界。
 * 只读：本文件不提供任何写通道。
 */
export function registerIpc(repository: RunRepository): void {
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
}
