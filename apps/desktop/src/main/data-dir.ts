import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 数据目录解析。便携优先：数据只落在数据目录内，永不写 AppData / 用户主目录 / 注册表。
 *
 * 三条路径（见 design D2）：
 * 1. 开发模式 → 仓库根 `.rebaseagent/`
 * 2. 打包 + exe 旁 `portable.marker` → `<exe 目录>/data`
 * 3. 打包 + 无 marker → 读 exe 旁的 `data-dir.json` 指针；再没有则需要用户选择
 */

export const MARKER_FILE = "portable.marker";
export const POINTER_FILE = "data-dir.json";
export const DEV_DIR_NAME = ".rebaseagent";
export const PORTABLE_DIR_NAME = "data";
export const TRACES_DIR_NAME = "traces";

export type DataDirResult = { kind: "resolved"; dir: string } | { kind: "needs-selection" };

export interface DataDirOptions {
  /** 是否打包后运行（app.isPackaged） */
  packaged: boolean;
  /** exe 所在目录（打包后）；开发模式下该值不使用 */
  exeDir: string;
  /** 开发模式的仓库根目录 */
  devDir: string;
  /** 可选的 fs 注入（测试用） */
  fs?: Pick<typeof import("node:fs"), "existsSync" | "readFileSync">;
}

/** 解析数据目录；需要用户选择时返回 needs-selection（此时不创建任何文件） */
export function resolveDataDir(options: DataDirOptions): DataDirResult {
  const fs = options.fs ?? { existsSync, readFileSync };

  if (!options.packaged) {
    return { kind: "resolved", dir: join(options.devDir, DEV_DIR_NAME) };
  }

  if (fs.existsSync(join(options.exeDir, MARKER_FILE))) {
    return { kind: "resolved", dir: join(options.exeDir, PORTABLE_DIR_NAME) };
  }

  const pointer = join(options.exeDir, POINTER_FILE);
  if (fs.existsSync(pointer)) {
    const parsed: unknown = JSON.parse(fs.readFileSync(pointer, "utf8"));
    const dir = (parsed as { dataDir?: unknown })?.dataDir;
    if (typeof dir === "string" && dir.length > 0) {
      return { kind: "resolved", dir };
    }
  }

  return { kind: "needs-selection" };
}

/** 记住用户选择的数据目录（写入 exe 旁的指针文件；非便携安装目录不可写时会抛错） */
export function saveDataDirPointer(exeDir: string, dataDir: string): void {
  writeFileSync(join(exeDir, POINTER_FILE), JSON.stringify({ dataDir }), "utf8");
}

/** trace 文件所在目录（确保存在） */
export function ensureTracesDir(dataDir: string): string {
  const traces = join(dataDir, TRACES_DIR_NAME);
  mkdirSync(traces, { recursive: true });
  return traces;
}
