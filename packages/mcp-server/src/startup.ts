import { constants, accessSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { RunQueryStartupCode } from "@rebaseagent/run-query";

/**
 * 启动期的数据根检查（design D3）。
 *
 * 一句话判据：**只接受一个显式、已存在、可读的绝对目录，且其下必须有 `traces/`**。
 * 任何不满足的情形都归到启动域 `DATA_DIR_INVALID` —— 服务初始化之前不进工具信封，
 * 由 CLI 以 stderr 固定码 + 非零退出承载。
 *
 * 纪律：
 * - **不 mkdir、不兜底、不切换数据根**：绝不因为"这里没有 traces/"就去别处找，
 *   也绝不创建目录把空壳坐实成"有数据"；空 `traces/` 是合法状态（S01），缺目录不是。
 * - **不回显调用方给定的路径**：`reason` 只说"是什么不成立"。路径由操作者自己输入，
 *   把它写进诊断行既无必要，也会把用户参数带进日志（D3 的日志纪律）。
 * - 数据根本身由操作者显式信任；越界与目录替身的拒绝发生在**读取层**的共享边界
 *   （`@rebaseagent/trace-sdk/fs-boundary`），不在这里重复实现。
 */

/** 唯一接受的 CLI 参数（不接受位置参数、不接受第二个数据根） */
export const DATA_DIR_FLAG = "--data-dir";

/** 启动失败的固定退出码（1.1 的实机记录用的就是这个值，保持一致） */
export const STARTUP_EXIT_CODE = 2;

/** 已核验的数据根：服务后续一切读取都锚在这两个目录里 */
export interface DataRoot {
  readonly dataDir: string;
  readonly tracesDir: string;
}

export type StartupOutcome =
  | { readonly ok: true; readonly root: DataRoot }
  | { readonly ok: false; readonly code: RunQueryStartupCode; readonly reason: string };

function reject(reason: string): StartupOutcome {
  return { ok: false, code: "DATA_DIR_INVALID", reason };
}

/**
 * 解析并核验 CLI 参数。
 *
 * @param argv `process.argv.slice(2)`
 */
export function parseStartupArgv(argv: readonly string[]): StartupOutcome {
  let given: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg !== DATA_DIR_FLAG) {
      // 只列参数名，不列取值：取值可能承载正文
      return reject(`未知参数（只接受 ${DATA_DIR_FLAG}）`);
    }
    if (given !== null) {
      return reject(`${DATA_DIR_FLAG} 重复出现（只允许一个数据根）`);
    }
    const value = argv[i + 1];
    i += 1;
    if (value === undefined || value.length === 0) {
      return reject(`缺少 ${DATA_DIR_FLAG} <已有绝对路径>`);
    }
    given = value;
  }

  if (given === null) {
    return reject(`缺少 ${DATA_DIR_FLAG} <已有绝对路径>`);
  }
  if (!isAbsolute(given)) {
    return reject("数据根必须是绝对路径");
  }

  const rootStat = statOrUndefined(given);
  if (rootStat === undefined) {
    return reject("数据根不存在或不可访问");
  }
  if (!rootStat.isDirectory()) {
    return reject("数据根不是目录");
  }

  const tracesDir = join(given, "traces");
  const tracesStat = statOrUndefined(tracesDir);
  if (tracesStat === undefined) {
    return reject("数据根下没有 traces/");
  }
  if (!tracesStat.isDirectory()) {
    return reject("traces/ 不是目录");
  }
  if (!isReadable(tracesDir)) {
    return reject("traces/ 不可读");
  }

  return { ok: true, root: { dataDir: given, tracesDir } };
}

function statOrUndefined(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function isReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
