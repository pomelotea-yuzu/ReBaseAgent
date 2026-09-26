import { existsSync, mkdirSync, unlinkSync } from "node:fs";
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
import { type DraftCloseGuardHandle, attachDraftCloseGuard } from "./draft-close-attach";
import { registerIpc } from "./ipc";
import type { TrustedSender } from "./operation-endpoints";
import { OperationRegistry } from "./operation-registry";
import { ProxyManager } from "./proxy-manager";
import { RunRepository } from "./run-repository";
import { SettingsStore } from "./settings";
import type { SettingsCipher } from "./settings";
import { installSmokeEventHook } from "./smoke-event-hook";

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
 * 实机验收钩子：**应用级强制 device scale factor**（= 让应用"看到"系统缩放为 X%）。
 *
 * 用途（U2 验收 D-3「系统级原生 DPI」）：真改 OS 缩放会影响整台机器、多数情况还要重新登录，
 * 而 `force-device-scale-factor` 走的是与 OS 缩放**同一条** devicePixelRatio 路径
 * （区别于 `setZoomFactor` 的页面缩放），足以回答"应用在别的系统 DPI 下是否仍可读、不崩版"。
 *
 * ⚠️ 必须在 **app ready 之前**注入（同上面的 `--no-sandbox`），ready 之后再调无效。
 * ⚠️ 未设置或非法时**完全不注入** ⇒ 生产行为逐字节不变（不是授权开关；打包产物无该环境变量）。
 */
const forcedScale = process.env.REBASEAGENT_FORCE_SCALE_FACTOR;
if (forcedScale !== undefined && forcedScale !== "") {
  const scale = Number(forcedScale);
  if (Number.isFinite(scale) && scale > 0) {
    app.commandLine.appendSwitch("force-device-scale-factor", String(scale));
  }
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
/** U3 关闭协商 guard（§4）：窗口创建时装配；4.4 起在 close/app.quit 路径消费 */
let draftClose: DraftCloseGuardHandle | null = null;
/**
 * U4（design D1）：操作登记与主动执行槽在 **main 生命周期**创建一次，全窗口共用。
 * renderer 的文档会话 id（U3 关闭协商）与这里的 epoch 各有职责、不能互代：
 * 同一个 main 内重载 renderer 不会换 epoch，main 重启才会。
 * U4 5.1 起关闭协商也要消费它（closing 标记 + 活跃槽事实），故不再留在 bootstrap 局部。
 */
const operations = new OperationRegistry();
/**
 * U4：本应用创建的窗口 → **主 frame** routingId 的取值函数。
 * 导航会更换 frame 实例，所以存的是取值函数而不是快照值；窗口销毁时移除。
 * 判据只用于「这条 IPC 是不是我创建的窗口的主 frame 发的」——子 frame、其他
 * webContents（含 devtools、外链）一律不信。
 */
const trustedMainFrameOf = new Map<number, () => number>();

function isTrustedSender(sender: TrustedSender): boolean {
  const getMainFrameRoutingId = trustedMainFrameOf.get(sender.webContentsId);
  if (getMainFrameRoutingId === undefined) return false;
  return sender.frameRoutingId === getMainFrameRoutingId();
}

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
  // U4：登记为可信发送者来源（不等 did-finish-load——preload 代码在加载完成前就会发 IPC；
  // 主 frame id 每次导航会变，故存取值函数）。窗口销毁时解除登记。
  const sourceWebContentsId = win.webContents.id;
  trustedMainFrameOf.set(sourceWebContentsId, () => win.webContents.mainFrame.routingId);
  win.on("closed", () => {
    trustedMainFrameOf.delete(sourceWebContentsId);
  });
  // U3 关闭协商：装配受限协议（会话轮换 / 握手 / sender 校验）；销毁时自动解绑
  // U4 5.1：一并接进操作登记（协商期间 closing 封住主动执行与配置变更，clean 判定读活跃槽）
  draftClose = attachDraftCloseGuard(win, operations);

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(resolve(__dirname, "../renderer/index.html"));
  }

  /**
   * 验收钩子（U2 5.2）：从环境变量设置**真实** Electron zoomFactor。
   *
   * 为什么需要：`Emulation.setDeviceMetricsOverride` 虽能伪造视口，但实测会破坏
   * Monaco 的 automaticLayout（几何读出 36px/5px 伪影，不可信）；
   * `Emulation.setPageScaleFactor` 只是视觉缩放、不改布局视口。要验证"独立 zoomFactor=2
   * 后仍可阅读"，必须走主进程 `webContents.setZoomFactor`（真 zoom：CSS 视口按比例缩小）。
   *
   * ⚠️ 必须在**页面加载完成后**设置：Electron 在 `did-finish-load` 时会重置 zoom 到默认值，
   *    加载前调用会被静默覆盖（实测 1210px 窗口下 zoomFactor 仍为 1）。
   *
   * 未设置或非法时完全不调用 ⇒ 生产行为与以前逐字节一致（不是授权开关）。
   * ⚠️ 仅用于 dev 实机验收；打包产物不受影响（无该环境变量）。
   */
  const zoomRaw = process.env.REBASEAGENT_ZOOM_FACTOR;
  if (zoomRaw !== undefined && zoomRaw !== "") {
    const zoom = Number(zoomRaw);
    if (Number.isFinite(zoom) && zoom > 0) {
      win.webContents.on("did-finish-load", () => {
        win.webContents.setZoomFactor(zoom);
      });
    }
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
  /**
   * 冒烟钩子（B 3.2）：显式给出源目录时跳过原生目录选择框。原生对话框无法被
   * CDP/E2E 驱动，而"目录选择 → 隔离创建"又是必须真跑的链路，故留一个环境变量入口。
   * 未设置时 `pickDirectory` 为 undefined ⇒ handler 用 Electron dialog，行为与以前完全一致。
   * ⚠️ 生产调用方不得设置该变量：它不是授权开关（副本写入仍需每次显式 allowFileWrites）。
   */
  const smokePickDir = process.env.REBASEAGENT_SMOKE_PICK_DIR;
  registerIpc({
    repository,
    settings,
    // 工具重跑的工作目录：数据目录（trace 不记录首次 cwd，桌面以数据目录为落点）
    execCwd: dataDir,
    // 隔离创建/续跑的 trace 与附件锚点（B 1.3/1.4）
    dataDir,
    proxy,
    operations,
    isTrustedSender,
    ...(smokePickDir === undefined || smokePickDir === ""
      ? {}
      : { pickDirectory: async (): Promise<string | null> => smokePickDir }),
  });
  /**
   * 代理按 settings 自恢复（端口占用等失败不阻断应用启动，状态可见）。
   * U4（tasks 3.6）：启动恢复同样持「配置变更中」标记——它也要 `await` 换监听器，
   * 不能允许新窗口在这期间提交主动执行或改配置。失败/完成都在 finally 释放。
   */
  operations.beginConfigurationChange();
  void proxy.autoStart().finally(() => {
    operations.endConfigurationChange();
  });
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  /**
   * 验收钩子（U3 任务 6.4）：Windows 上外部**没有**任何路径能调用到 `app.quit()`
   * （没有 quit IPC 通道，也不该为验收新增一条），而「窗口在场时的 app.quit 协商」
   * 是必须真跑的一条分支，故留一个哨兵文件入口：`REBASEAGENT_SMOKE_QUIT_FILE` 给出路径后，
   * 该文件一旦出现 ⇒ 调一次 `app.quit()` 并删除文件（可重复触发，返回后仍可再试）。
   * 未设置或为空 ⇒ 不注册任何定时器与监听，生产行为与以前逐字节一致。
   * ⚠️ 这不是授权开关：quit 之后仍走 design D6 的新鲜查询与用户确认，钩子只负责"发起 quit"。
   */
  const quitSentinel = process.env.REBASEAGENT_SMOKE_QUIT_FILE;
  if (quitSentinel !== undefined && quitSentinel !== "") {
    const timer = setInterval(() => {
      if (!existsSync(quitSentinel)) return;
      try {
        unlinkSync(quitSentinel);
      } catch {
        // 并发触发（文件已消失）：本次不重复 quit，等下一轮轮询
      }
      app.quit();
    }, 250);
    // 真正开始退出时停表；用户选择「返回」使 quit 被阻止时不停表，以便再次触发
    app.on("will-quit", () => clearInterval(timer));
  }
  /**
   * 验收钩子（U3 任务 6.6）：哨兵文件出现 ⇒ 对当前窗口执行一个白名单动作
   * （真崩溃 renderer / 合成系统会话结束事件）。动作语义与边界见
   * `smoke-event-hook.ts` 文件头——本钩子**不注册任何事件监听**，
   * design D6「系统结束会话不接入确认/不阻止」的源码契约（4.4）不因验收而失守。
   * 未设置或为空 ⇒ 不注册任何定时器，生产行为逐字节一致。
   */
  const smokeEventFile = process.env.REBASEAGENT_SMOKE_EVENT_FILE;
  if (smokeEventFile !== undefined && smokeEventFile !== "") {
    const dispose = installSmokeEventHook(smokeEventFile, () =>
      mainWindow !== null && !mainWindow.isDestroyed() ? mainWindow : null,
    );
    app.on("will-quit", dispose);
  }
  /**
   * U3 任务 4.4：常规 app.quit 也走关闭协商（与标题栏关闭/Alt+F4 同一 guard）。
   * - 目标窗口不存在（window-all-closed 后的 quit / 窗口已销毁）⇒ 直接放行；
   * - 否则阻止本次 quit，启动（或复用进行中的）协商：用户确认退出后 flow 已
   *   armed bypass 并触发 win.close()，窗口销毁后的 window-all-closed → quit
   *   会因目标不存在而放行；用户选择返回则维持现状。
   * Windows 注销/关机不走 before-quit（design D6），本处不接入系统会话结束路径，
   * 不为草稿保护阻止系统结束会话。
   */
  app.on("before-quit", (event) => {
    const handle = draftClose;
    const target = handle === null ? undefined : handle.guard.targetOf(handle.webContentsId);
    if (handle === null || target === undefined) return;
    event.preventDefault();
    void handle.flow.requestClose().then((outcome) => {
      // "closed"：窗口正在关闭（bypass 已消费）；"canceled"：用户选择返回
      void outcome;
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

void bootstrap();

export { mainWindow };
