import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 数据目录解析。便携优先：数据只落在数据目录内，永不写 AppData / 用户主目录 / 注册表。
 *
 * 三条路径（见 design D2）：
 * 1. 开发模式 → 仓库根 `.rebaseagent/`
 * 2. 打包 + exe 旁 `portable.marker` → `<exe 目录>/data`
 * 3. 打包 + 无 marker → 读 exe 旁的 `data-dir.json` 指针；再没有则需要用户选择
 *
 * **portable exe 的陷阱**：单文件 portable 版运行时会先把应用解压到系统临时目录再启动，
 * 因此 `app.getPath("exe")` 指向的是临时目录（退出即被清理），而不是用户双击的那个 exe。
 * 数据若锚定在临时目录，每次运行都会丢。electron-builder 为此注入了环境变量
 * `PORTABLE_EXECUTABLE_DIR`（见 app-builder-lib/templates/nsis/portable.nsi），
 * 它才是用户眼中「程序所在的那个目录」。打包后必须用它作为锚点。
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
  /**
   * portable 版的用户可见目录，取自环境变量 `PORTABLE_EXECUTABLE_DIR`。
   * 仅单文件 portable 版存在；存在时优先于 exeDir 作为锚点。
   */
  portableExeDir?: string | undefined;
  /** 开发模式的仓库根目录 */
  devDir: string;
  /** 可选的 fs 注入（测试用） */
  fs?: Pick<typeof import("node:fs"), "existsSync" | "readFileSync">;
}

/**
 * 数据目录的锚点目录：marker / 指针文件都在这里找，用户选择的结果也写回这里。
 * portable 版必须回落到用户双击 exe 的目录，否则数据会落进临时目录。
 */
export function resolveAnchorDir(
  options: Pick<DataDirOptions, "exeDir" | "portableExeDir">,
): string {
  return options.portableExeDir ?? options.exeDir;
}

/** 解析数据目录；需要用户选择时返回 needs-selection（此时不创建任何文件） */
export function resolveDataDir(options: DataDirOptions): DataDirResult {
  const fs = options.fs ?? { existsSync, readFileSync };

  if (!options.packaged) {
    return { kind: "resolved", dir: join(options.devDir, DEV_DIR_NAME) };
  }

  const anchorDir = resolveAnchorDir(options);

  if (fs.existsSync(join(anchorDir, MARKER_FILE))) {
    return { kind: "resolved", dir: join(anchorDir, PORTABLE_DIR_NAME) };
  }

  const pointer = join(anchorDir, POINTER_FILE);
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
