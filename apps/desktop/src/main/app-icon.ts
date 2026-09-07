import { join } from "node:path";

/**
 * 品牌图标源图路径（design D4）：
 * icon.png 同时随 asar 打包（electron-builder files 含 build/icon.png），
 * 因此开发态（app.getAppPath() = apps/desktop）与打包态（asar 内虚拟路径）
 * 用同一相对路径即可解析到 BrowserWindow 图标。
 */
export function resolveAppIconPath(appPath: string): string {
  return join(appPath, "build", "icon.png");
}
