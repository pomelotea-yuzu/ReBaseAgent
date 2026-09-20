import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { BrowserWindow, app, dialog, safeStorage } from "electron";
import { resolveAppIconPath } from "./app-icon";
import {
  derivePortableIdentity,
  ensureTracesDir,
  portableRuntimePaths,
  resolveAnchorDir,
  resolveDataDir,
  saveDataDirPointer,
} from "./data-dir";
import { registerIpc } from "./ipc";
import { ProxyManager } from "./proxy-manager";
import { RunRepository } from "./run-repository";
import { SettingsStore } from "./settings";
import type { SettingsCipher } from "./settings";

/**
 * 应用入口。数据目录解析 → 注册 IPC → 建窗口。
 * 窗口安全基线：nodeIntegration 关闭、contextIsolation 开启、sandbox 开启。
 */

/**
 * 沙箱环境（CI / 受限容器 / 部分 Agent 运行环境）下，Chromium 的 GPU 子进程
 * 会因无法初始化而反复崩溃，最终导致整个 Electron 进程 FATAL 退出。
 * 仅当显式设置 NO_SANDBOX=1 时，才在 app ready 前注入 --no-sandbox，
 * 让 GPU 子进程能在无特权沙箱中启动。正常桌面环境不会设置该变量，保持默认安全基线。
 */
if (process.env.NO_SANDBOX === "1" || process.env.NO_SANDBOX === "true") {
  app.commandLine.appendSwitch("no-sandbox");
}

/**
 * pre-ready 便携路径初始化（design D3）：
 * 必须在 app.whenReady() 和任何 session / BrowserWindow 创建之前执行。
 * 单文件 portable 由 electron-builder 注入的 PORTABLE_EXECUTABLE_DIR 识别；
 * unpacked 便携则由实际 exe 旁的 portable.marker 识别。
 * 任一信号成立时，把默认落入 AppData 的 userData / sessionData 锚定到
 * 便携数据目录下的明确子目录，保证产品数据不出 exe 同级 data/。
 * 普通 packaged（无 portable 信号）保持既有指针 / 选择流程，此处不动作。
 */
function initializePortablePaths(): void {
  const identity = derivePortableIdentity({
    portableExeDir: process.env.PORTABLE_EXECUTABLE_DIR,
    exeDir: dirname(app.getPath("exe")),
    packaged: app.isPackaged,
  });
  if (identity === null) return;
  const { userData, sessionData } = portableRuntimePaths(identity.anchorDir);
  mkdirSync(userData, { recursive: true });
  mkdirSync(sessionData, { recursive: true });
  app.setPath("userData", userData);
  app.setPath("sessionData", sessionData);
}

initializePortablePaths();

/** 开发模式下的仓库根（apps/desktop 的上两级） */
function repoRoot(): string {
  return resolve(app.getAppPath(), "..", "..");
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    title: "ReBaseAgent",
    // 品牌图标：开发态与打包态同路径解析（build/icon.png 随 asar 打包）
    icon: resolveAppIconPath(app.getAppPath()),
    webPreferences: {
      // main 产物为 CJS，__dirname 直接可用；preload 强制输出为 index.cjs
      preload: resolve(__dirname, "../preload/index.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow = win;

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(resolve(__dirname, "../renderer/index.html"));
  }
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  const exeDir = dirname(app.getPath("exe"));
  // 单文件 portable 版会解压到临时目录再运行，此时 exeDir 是临时目录。
  // 环境变量 PORTABLE_EXECUTABLE_DIR 才是用户双击 exe 的目录，必须优先用它锚定数据。
  const portableExeDir = process.env.PORTABLE_EXECUTABLE_DIR;
  const resolved = resolveDataDir({
    packaged: app.isPackaged,
    exeDir,
    portableExeDir,
    devDir: repoRoot(),
  });

  let dataDir: string;
  if (resolved.kind === "resolved") {
    dataDir = resolved.dir;
  } else {
    // 非便携且从未选择过：请用户指定，选定前不创建任何文件
    const picked = await dialog.showOpenDialog({
      title: "选择 ReBaseAgent 数据目录",
      properties: ["openDirectory", "createDirectory"],
      message: "数据将只保存在该目录内。也可在程序旁放置 portable.marker 使用便携模式。",
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      app.quit();
      return;
    }
    const chosen = picked.filePaths[0];
    if (chosen === undefined) {
      app.quit();
      return;
    }
    dataDir = chosen;
    saveDataDirPointer(resolveAnchorDir({ exeDir, portableExeDir }), dataDir);
  }

  const tracesDir = ensureTracesDir(dataDir);
  // apiKey 优先经系统密钥环加密（Linux 无 keyring 时 safeStorage 自身不可用，降级明文）
  const cipher: SettingsCipher = {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString("base64"),
    decrypt: (encoded) => safeStorage.decryptString(Buffer.from(encoded, "base64")),
  };
  const settings = new SettingsStore({ dataDir, cipher });
  const repository = new RunRepository(tracesDir);
  const proxy = new ProxyManager({ repository, settings, tracesDir });
  registerIpc({
    repository,
    settings,
    // 工具重跑的工作目录：数据目录（trace 不记录首次 cwd，桌面以数据目录为落点）
    execCwd: dataDir,
    // 隔离创建/续跑的 trace 与附件锚点（B 1.3/1.4）
    dataDir,
    proxy,
  });
  // 代理按 settings 自恢复（端口占用等失败不阻断应用启动，状态可见）
  void proxy.autoStart();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

void bootstrap();

export { mainWindow };
