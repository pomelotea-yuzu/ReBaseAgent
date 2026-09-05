import { dirname, resolve } from "node:path";
import { BrowserWindow, app, dialog, safeStorage } from "electron";
import { ensureTracesDir, resolveAnchorDir, resolveDataDir, saveDataDirPointer } from "./data-dir";
import { registerIpc } from "./ipc";
import { RunRepository } from "./run-repository";
import { SettingsStore } from "./settings";
import type { SettingsCipher } from "./settings";

/**
 * 应用入口。数据目录解析 → 注册 IPC → 建窗口。
 * 窗口安全基线：nodeIntegration 关闭、contextIsolation 开启、sandbox 开启。
 */

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
  registerIpc({
    repository: new RunRepository(tracesDir),
    settings: new SettingsStore({ dataDir, cipher }),
    // 工具重跑的工作目录：数据目录（trace 不记录首次 cwd，桌面以数据目录为落点）
    execCwd: dataDir,
  });
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
