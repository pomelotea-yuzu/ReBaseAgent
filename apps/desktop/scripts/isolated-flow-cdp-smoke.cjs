/* eslint-disable */
/**
 * B 任务 3.2 / 3.3 的 GUI 冒烟（沙箱自验；配合 `scripts/mock-llm-server.cjs` 做受控模型服务）。
 *
 * 三阶段（**重启/换窗口尺寸都必须真做**，脚本自身不 spawn 任何进程）：
 *
 *   node scripts/isolated-flow-cdp-smoke.cjs --phase=flow       # 浏览 → 隔离创建 → 改 result → 隔离续跑
 *   <杀 dev 再重启 dev>
 *   node scripts/isolated-flow-cdp-smoke.cjs --phase=restart    # 重开后核对轨迹与来源说明
 *   node scripts/isolated-flow-cdp-smoke.cjs --phase=narrow     # 窄窗口 + 长源路径的创建与确认区（3.3）
 *
 * C 段（文件检查点视图）追加四阶段（依赖 flow 阶段产出的 state.json）：
 *
 *   node scripts/isolated-flow-cdp-smoke.cjs --phase=files          # 文件 tab / 检查点 / 差异 / 只读
 *   <杀 dev 再重启 dev>
 *   node scripts/isolated-flow-cdp-smoke.cjs --phase=files-restart  # 重启后文件差异仍可查
 *   node scripts/isolated-flow-cdp-smoke.cjs --phase=files-migrate  # 整体迁移 dataDir 后仍可查
 *   <杀 dev，改以 REBASEAGENT_SMOKE_PICK_DIR=<长路径源> 重启 dev>
 *   node scripts/isolated-flow-cdp-smoke.cjs --phase=files-narrow   # 长路径 + 长文本 diff 的宽/窄窗核对
 *
 * 前置：
 *  1) （flow 阶段）受控模型服务在 127.0.0.1:18799（剧本：read_file → 父完成 → 子完成）；
 *     应用 settings.json 的 baseURL 指向它（脚本自己写入并在结束时还原备份）。
 *  2) dev 已起且带 CDP：`NO_SANDBOX=1 REBASEAGENT_SMOKE_PICK_DIR=<源目录> node scripts/start-dev.cjs --remoteDebuggingPort=9222`
 *     —— REBASEAGENT_SMOKE_PICK_DIR 是 main 的冒烟钩子（原生目录框无法被 CDP 驱动）。
 *     narrow 阶段要求该变量指向**长路径**源目录（脚本会自建，与 LONG_SOURCE 一致）。
 *
 * 覆盖场景：`直接创建隔离文件父本`、`浏览过程无写入`、`分叉不触碰既有文件`、
 * `新建运行不触碰既有文件`、`详情 IPC 快照往返`（flow/restart）、
 * `创建与确认在窄窗口可操作`（narrow）。
 * ⚠️ 按 fixture 哈希逐份核对真实文件的 diff 冒烟**迁 C**（本脚本只核到"源目录 + 既有 trace
 * 逐字节不变"这一层）。
 */
"use strict";

const { chromium } = require("playwright-core");
const { createHash } = require("node:crypto");
const {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} = require("node:fs");
const { join, relative, resolve } = require("node:path");

const REPO = resolve(__dirname, "..", "..", "..");
const DATA_DIR = join(REPO, ".rebaseagent");
const TRACES = join(DATA_DIR, "traces");
const OUT = join(REPO, ".workbuddy", "isolated-flow-smoke");
const SOURCE = join(OUT, "source");
const SETTINGS = join(DATA_DIR, "settings.json");
const SETTINGS_BACKUP = join(OUT, "settings.backup.json");
const STATE = join(OUT, "state.json");
const MOCK_LOG = join(OUT, "mock-requests.jsonl");
const MOCK_URL = "http://127.0.0.1:18799/v1";
const CDP = "http://127.0.0.1:9222";

/** 冒烟里编辑后的 tool result（与源文件内容不同即可；ASCII 便于逐字节核对） */
const EDITED_RESULT = "SMOKE-EDITED alpha";

/** 3.3 用的**长路径**源目录（分段拼出来，总长约 200 字符；必须与 dev 的 SMOKE_PICK_DIR 一致） */
const LONG_SOURCE = join(
  OUT,
  "long-path-fixture",
  "aaaaaaaaaaaaaaaaaaaa",
  "bbbbbbbbbbbbbbbbbbbb",
  "cccccccccccccccccccc",
  "dddddddddddddddddddd",
  "eeeeeeeeeeeeeeeeeeee",
  "ffffffffffffffffffff",
  "source",
);

/** 窄窗口（模拟用户把窗口拉窄）与代表性桌面尺寸 */
const NARROW = { width: 460, height: 720 };
/**
 * ⚠️ 三栏外壳的固定宽度：RunList `w-80`=320px + SpanTree `w-96`=384px = **704px**，
 * 详情列是 `flex-1 min-w-0` ⇒ 窗口窄于约 1000px 时详情列会被压到不可用（实测 770px 时
 * 详情列只剩 51px、编辑器宽 5px 且落到视口外）。这是**既有桌面外壳的固有下限**，不是本次
 * 确认区的问题 ⇒ 确认区读数取"明显窄但仍可用"的 1040px，而"长源路径 + 模态创建框"仍用
 * 最苛刻的 460px 压一压（模态框 width w-120 + max-w-full 会自适应）。
 */
const NARROW_APP = { width: 1040, height: 720 };
/** 文件视图的窄窗核对宽度：< 1024px（lg 断点）⇒ 列表/内容二选一切换生效 */
const FILES_NARROW = { width: 900, height: 720 };
const WIDE = { width: 1360, height: 860 };

const phase = (process.argv.find((a) => a.startsWith("--phase=")) ?? "--phase=flow").slice(8);

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: ok === true, detail: detail ?? null });
  console.log(`${ok === true ? "✓" : "✗"} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
}

// ---------------------------------------------------------------------------
// 夹具与指纹
// ---------------------------------------------------------------------------

function prepareSource() {
  mkdirSync(SOURCE, { recursive: true });
  writeFileSync(join(SOURCE, "a.txt"), "alpha 内容");
  writeFileSync(join(SOURCE, "keep.txt"), "keep");
}

/** 目录/文件清单指纹（相对路径 + 内容哈希）：判"既有一切逐字节不变" */
function fingerprintFiles(paths) {
  const acc = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    if (statSync(path).isDirectory()) {
      const walk = (dir) => {
        for (const name of readdirSync(dir).sort()) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else acc.push(`${relative(REPO, full).replace(/\\/g, "/")} ${hash(full)}`);
        }
      };
      walk(path);
    } else {
      acc.push(`${relative(REPO, path).replace(/\\/g, "/")} ${hash(path)}`);
    }
  }
  return acc.join("\n");
}

function hash(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function traceFiles() {
  try {
    return readdirSync(TRACES)
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => join(TRACES, n));
  } catch {
    return [];
  }
}

function writeMockSettings() {
  if (existsSync(SETTINGS)) copyFileSync(SETTINGS, SETTINGS_BACKUP);
  writeFileSync(
    SETTINGS,
    JSON.stringify(
      {
        baseURL: MOCK_URL,
        model: "mock-model",
        // 受控服务不校验 key；明文降级标记让 main 跳过解密
        apiKey: "sk-mock",
        apiKeyEncrypted: false,
      },
      null,
      2,
    ),
  );
}

function restoreSettings() {
  if (existsSync(SETTINGS_BACKUP)) {
    copyFileSync(SETTINGS_BACKUP, SETTINGS);
    rmSync(SETTINGS_BACKUP, { force: true });
    console.log("✓ 已还原 settings.json 备份");
  }
}

// ---------------------------------------------------------------------------
// CDP 辅助
// ---------------------------------------------------------------------------

async function connect() {
  const browser = await chromium.connectOverCDP(CDP);
  const page = browser
    .contexts()[0]
    .pages()
    .find((p) => p.url().includes("localhost:5173"));
  if (page === undefined)
    throw new Error("未找到渲染层页面（dev 是否带 --remoteDebuggingPort=9222 启动？）");
  await page.waitForTimeout(1200);
  return { browser, page };
}

/**
 * 真正调整窗口大小（不是改 viewport）：**必须真改 OS 窗口**，否则测的是"缩放后的布局"
 * 而不是"窄窗口下的布局"。
 *
 * ⚠️ Electron 的页面级 CDP 会话里**没有 `Browser.getWindowForTarget`**（Browser 域不完整，
 * 实测报 `'Browser.getWindowForTarget' wasn't found`）⇒ 改用渲染层的 `window.resizeTo`
 * （Electron 支持它，等价于 BrowserWindow.setSize），并**回读 innerWidth/innerHeight 自证
 * resize 真的生效**——不然窄窗口结论就是假的。
 */
async function resizeWindow(page, size) {
  await page.evaluate((s) => window.resizeTo(s.width, s.height), size);
  await page.waitForTimeout(900);
  return page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
}

/** 元素是否完整落在当前视口内（"不遮挡"的判据：授权框与提交按钮必须看得到、点得到） */
async function inViewport(page, locator) {
  const box = await locator.boundingBox();
  const size =
    page.viewportSize() ??
    (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  if (box === null) return false;
  return (
    box.x >= -1 &&
    box.y >= -1 &&
    box.x + box.width <= size.width + 1 &&
    box.y + box.height <= size.height + 1
  );
}

/** 横向是否溢出（换行生效的判据） */
async function overflowsHorizontally(locator) {
  return locator.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
}

/** 详情列宽度（三栏外壳的挤压程度；只用于记录，不做判定） */
async function detailColumnWidth(page) {
  const section = page.locator("section.min-w-0.flex-1").first();
  if ((await section.count()) === 0) return -1;
  return Math.round(await section.evaluate((el) => el.getBoundingClientRect().width));
}

/**
 * 截图走 CDP 的 `Page.captureScreenshot`，**不用 `page.screenshot()`**：
 * 后者在截图前会等 `document.fonts.ready`，本机（Monaco 的字体 + 沙箱）实测会偶发挂死到
 * 超时（日志停在 "waiting for fonts to load..."）。CDP 直取没有这一步。
 */
async function shot(page, name) {
  const session = await page.context().newCDPSession(page);
  try {
    const { data } = await session.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, name), Buffer.from(data, "base64"));
  } finally {
    await session.detach().catch(() => {});
  }
}

/** 点列表里的某条 run（列表项按钮含 run id 文本） */
async function selectRunInList(page, runId) {
  await page
    .getByRole("button", { name: new RegExp(runId) })
    .first()
    .click();
  await page.waitForTimeout(700);
}

/**
 * 点 span 树里的某一行。⚠️ 必须用**行内特征**匹配：span 行按钮的可访问名是
 * "工具read_file1ms" 这种拼接，而运行列表项的 task 文本里也可能出现 "read_file"
 * ——只用 /read_file/ 会先命中列表项，把别的 run 选中（实测踩过）。
 */
async function clickSpanRow(page, pattern) {
  const row = page.getByRole("button", { name: pattern }).first();
  await row.click();
  await page.waitForTimeout(700);
}

async function modelCalls() {
  if (!existsSync(MOCK_LOG)) return 0;
  return readFileSync(MOCK_LOG, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0).length;
}

/** 轮询等待 trace 数达到目标（隔离创建/续跑都在 main 里落盘，慢的是模型轮次） */
async function waitForTraceCount(target, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (traceFiles().length >= target) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** 轮询等待 UI 上出现某段文本（异步 IPC + 渲染时序） */
async function waitForText(page, text, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await page.locator(`text=${text}`).count()) > 0) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

async function mockLogLines() {
  if (!existsSync(MOCK_LOG)) return [];
  return readFileSync(MOCK_LOG, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// phase=flow
// ---------------------------------------------------------------------------

async function phaseFlow() {
  mkdirSync(OUT, { recursive: true });
  prepareSource();
  writeMockSettings();
  // 清空本次冒烟的模型请求日志（服务进程会继续追加）
  writeFileSync(MOCK_LOG, "");

  const preexistingTraces = traceFiles();
  const fingerprintBefore = fingerprintFiles([SOURCE, ...preexistingTraces]);
  const countBefore = preexistingTraces.length;

  const { page } = await connect();
  await shot(page, "01-initial.png");

  // 清掉可能残留的对话框（上一轮创建失败时它不会自动关闭，overlay 会挡住后续点击）
  const staleDialog = page.locator('dialog[aria-label="新建运行"]');
  if ((await staleDialog.count()) > 0) {
    await staleDialog.getByRole("button", { name: "取消" }).click();
    await page.waitForTimeout(400);
  }

  // 刷新页面：把上一轮可能残留的分叉编辑器/选中状态清干净（流程从确定状态开始）
  await page.reload();
  await page.waitForTimeout(2200);

  // ── A. 浏览过程无写入：打开既有 run / 展开步骤 / 打开选择器后取消 ──────────────
  await selectRunInList(page, "r_01");
  const detailHasSpans = (await page.locator("text=LLM 调用").count()) > 0;
  check("浏览既有 run：轨迹渲染出 span 节点", detailHasSpans);

  await page
    .getByRole("button", { name: /新建运行/ })
    .first()
    .click();
  const dialog = page.locator('dialog[aria-label="新建运行"]');
  await dialog.waitFor({ state: "visible", timeout: 5000 });
  await dialog.getByRole("button", { name: "隔离文件运行" }).click();
  await page.waitForTimeout(200);
  await dialog.getByRole("button", { name: /选择目录/ }).click();
  await page.waitForTimeout(600);
  const pathShown = await dialog.locator("text=isolated-flow-smoke").count();
  check("选择器签发的目录在对话框内可见（供用户核对）", pathShown > 0);
  await shot(page, "02-picker.png");
  await dialog.getByRole("button", { name: "取消" }).click();
  await page.waitForTimeout(300);

  const countAfterBrowse = traceFiles().length;
  check(
    "浏览过程无写入：trace 数不变、既有一切逐字节不变",
    countAfterBrowse === countBefore &&
      fingerprintFiles([SOURCE, ...preexistingTraces]) === fingerprintBefore,
    `trace ${countBefore} → ${countAfterBrowse}`,
  );

  // ── B. 直接创建隔离文件父本 ─────────────────────────────────────────────────
  await page
    .getByRole("button", { name: /新建运行/ })
    .first()
    .click();
  await dialog.waitFor({ state: "visible", timeout: 5000 });
  await dialog.getByRole("button", { name: "隔离文件运行" }).click();
  await page.waitForTimeout(200);
  await dialog.getByRole("button", { name: /选择目录/ }).click();
  await page.waitForTimeout(600);
  await dialog.locator("textarea").nth(1).fill("读取 a.txt 并复述内容");
  const disabledWithoutAuth = await dialog
    .getByRole("button", { name: "创建隔离运行" })
    .isDisabled();
  check("未勾选副本写入时创建按钮禁用（每次操作独立确认）", disabledWithoutAuth === true);
  await dialog.getByLabel("允许本次执行的副本写入", { exact: false }).check();
  await shot(page, "03-create-ready.png");
  await dialog.getByRole("button", { name: "创建隔离运行" }).click();

  // 等隔离创建结束（模型两次调用：read_file 工具轮 + 收尾）
  const created = await waitForTraceCount(countBefore + 1);
  check("隔离创建落盘（临时文件按 meta.id 归位）", created);
  await page.waitForTimeout(1500);
  const countAfterCreate = traceFiles().length;
  check(
    "新建运行不触碰既有文件：只新增 1 份 trace",
    countAfterCreate === countBefore + 1,
    `+${countAfterCreate - countBefore}`,
  );
  check(
    "新建运行不触碰既有文件：源目录与既有 trace 逐字节不变",
    fingerprintFiles([SOURCE, ...preexistingTraces]) === fingerprintBefore,
  );
  check(
    "隔离世界的不可变附件已落盘（workspace-blobs 新建）",
    existsSync(join(DATA_DIR, "workspace-blobs")),
  );

  const runs = await page.evaluate(async () => {
    const envelope = await window.api.listRuns();
    return envelope.ok ? envelope.data.runs.map((r) => r.id) : [];
  });
  const newIds = runs.filter((id) => !preexistingTraces.some((f) => f.includes(id)));
  check("列表新增 1 条隔离 run", newIds.length === 1, newIds.join(","));
  const parentId = newIds[0];

  // 详情：隔离标注 + v2 载荷经 main/preload/renderer 往返
  const parentEnvelope = await page.evaluate(async (id) => {
    const envelope = await window.api.getRun(id);
    return envelope.ok
      ? {
          ok: true,
          formatVersion: envelope.data.meta.format_version,
          worldId: envelope.data.meta.workspace?.world_id,
          profile: envelope.data.meta.workspace?.profile,
          originKind: envelope.data.meta.workspace?.origin?.kind,
          snapshots: envelope.data.spans.filter((s) => s.kind === "agent.step").length,
          toolSpans: envelope.data.spans.filter((s) => s.kind === "tool.invoke").length,
        }
      : { ok: false, error: envelope.error };
  }, parentId);
  check(
    "详情 IPC 快照往返：v2 + workspace + 检查点齐全",
    parentEnvelope.ok === true &&
      parentEnvelope.formatVersion === 2 &&
      parentEnvelope.worldId === parentId &&
      parentEnvelope.profile === "file-tools-v1" &&
      parentEnvelope.originKind === "import" &&
      parentEnvelope.toolSpans >= 1,
    JSON.stringify(parentEnvelope),
  );

  await selectRunInList(page, parentId);
  const isolatedNotice = await page.locator("text=隔离文件运行 · profile").count();
  check("详情页显示文件隔离标注", isolatedNotice > 0);

  // 打开首次 llm.call：此处才有 prompt fork / A-B 入口（隔离父本应显示为不支持）
  await clickSpanRow(page, /LLM\s*调用/);
  const promptAbDisabled = await waitForText(page, "prompt fork / 模型 A/B 本期不支持", 8000);
  check("隔离父本的 prompt fork / A-B 入口显示为不支持", promptAbDisabled);

  // 重载页面：渲染层重新读一次运行配置（此刻已指向受控模型服务），确认区才会显示真实要调用的模型
  await page.reload();
  await page.waitForTimeout(2000);
  await selectRunInList(page, parentId);

  // ── C. 改 result → 隔离续跑 ────────────────────────────────────────────────
  await clickSpanRow(page, /工具\s*read_file/);
  const forkEntryShown = await waitForText(page, "在此重跑（隔离续跑）", 8000);
  check("隔离 run 的 tool.invoke 提供「在此重跑（隔离续跑）」入口", forkEntryShown);
  await page
    .getByRole("button", { name: /在此重跑（隔离续跑）/ })
    .first()
    .click();
  await page.waitForTimeout(400);

  // Monaco：点编辑区聚焦 → 全选 → 一次性插入文本。
  // ⚠️ 两点实测教训：① Monaco 0.56 的隐藏输入框类名是 `ime-text-area`，不是旧版 `inputarea`；
  // ② **逐键 type() 会被自动补全/IME 处理打散**（实测输入 "SMOKE-EDITED alpha" 落到编辑器里
  // 变成乱序串，且被如实记录进 fork.edit.value）⇒ 用 insertText 一次插入。
  await page.locator(".monaco-editor").first().click();
  await page.waitForTimeout(200);
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(EDITED_RESULT);
  await page.waitForTimeout(700);
  await shot(page, "04-edited.png");

  // 编辑进入界面状态的判据：空 fork 时「校验续跑条件」是禁用的，改过之后必须可用
  const verifyEnabled = await page.getByRole("button", { name: /校验续跑条件/ }).isEnabled();
  check("编辑内容已进入界面状态（「校验续跑条件」由禁用转为可用）", verifyEnabled === true);

  const confirmDisabledBeforeCheck = await page
    .getByRole("button", { name: "确认重跑" })
    .isDisabled();
  check("未校验 + 未授权时「确认重跑」禁用（重复提交保护）", confirmDisabledBeforeCheck === true);

  await page.getByRole("button", { name: /校验续跑条件/ }).click();
  const capabilityShown = await waitForText(page, `从运行 ${parentId} 的第 1 轮结束后继续`);
  await shot(page, "05-capability.png");
  const checkpointCount = await page.locator("text=轮末检查点").count();
  const parentRowCount = await page.locator("text=父 run").count();
  const modelShown = await page.locator("text=mock-model").count();
  check(
    "确认区显示父 run / 本地第 1 轮 / 轮末检查点 / 真实模型",
    capabilityShown && checkpointCount > 0 && parentRowCount > 0 && modelShown > 0,
    `轮号=${capabilityShown} 检查点=${checkpointCount} 父行=${parentRowCount} 模型=${modelShown}`,
  );
  const disabledBeforeAuth = await page.getByRole("button", { name: "确认重跑" }).isDisabled();
  check("校验通过但未勾选本次授权时仍禁用", disabledBeforeAuth === true);

  await page.getByLabel("允许本次副本写入", { exact: false }).check();
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "确认重跑" }).click();
  const forked = await waitForTraceCount(countBefore + 2);
  check("隔离续跑落盘", forked);
  await page.waitForTimeout(2000);
  await shot(page, "06-forked.png");

  const countAfterFork = traceFiles().length;
  check(
    "分叉不触碰既有文件：只新增 1 份 trace",
    countAfterFork === countBefore + 2,
    `+${countAfterFork - countBefore}`,
  );
  check(
    "分叉不触碰既有文件：源目录与既有 trace 逐字节不变",
    fingerprintFiles([SOURCE, ...preexistingTraces]) === fingerprintBefore,
  );

  const childEnvelope = await page.evaluate(async (id) => {
    const envelope = await window.api.listRuns();
    if (!envelope.ok) return null;
    const child = envelope.data.runs.find((r) => r.parent === id);
    return child === undefined ? null : { id: child.id, parent: child.parent };
  }, parentId);
  check(
    "列表出现子 run 且 parent 指向隔离父本",
    childEnvelope !== null,
    JSON.stringify(childEnvelope),
  );

  // 闭环：编辑器里的最终内容被**原样**记录进 fork.edit.value（模型看到的就是它）
  if (childEnvelope !== null) {
    const childMeta = JSON.parse(
      readFileSync(join(TRACES, `${childEnvelope.id}.jsonl`), "utf8").split("\n")[0],
    );
    check(
      "子 run 记录的编辑值 = 编辑器里的最终内容（无乱序/截断）",
      childMeta.fork?.edit?.value === EDITED_RESULT,
      JSON.stringify(childMeta.fork?.edit),
    );
  }

  const boundaryLabel = await waitForText(page, `从运行 ${parentId} 的第 1 轮结束后继续`);
  check("子运行来源说明指向父 run 的本地第 1 轮", boundaryLabel);

  // ── D. 模型调用与工具声明（受控服务的请求日志） ─────────────────────────────
  const lines = await mockLogLines();
  check(
    "受控模型服务收到 3 次真实调用（创建 2 + 续跑 1）",
    lines.length === 3,
    `收到 ${lines.length} 次`,
  );
  const isolatedCalls = lines.slice(0, 2);
  check(
    "隔离创建的模型请求声明固定 file-tools-v1 工具组（read_file / write_file）",
    isolatedCalls.every(
      (l) =>
        l.tools.length === 2 && l.tools.includes("read_file") && l.tools.includes("write_file"),
    ),
    JSON.stringify(isolatedCalls.map((l) => l.tools)),
  );
  check(
    "三次调用均为流式（stream:true）",
    lines.every((l) => l.stream === true),
  );

  writeFileSync(
    STATE,
    JSON.stringify(
      { parentId, childId: childEnvelope?.id ?? null, source: SOURCE, countBefore },
      null,
      2,
    ),
  );
  writeFileSync(join(OUT, "flow-checks.json"), JSON.stringify(checks, null, 2));
  console.log("截图与报告目录:", OUT);
}

// ---------------------------------------------------------------------------
// phase=files（C 3.1：文件检查点视图的端到端 + 只读性 + 不可用附件）
// ---------------------------------------------------------------------------

/**
 * C 段的资产：源/父/子 run 的**每个检查点**的全部文件哈希。
 *
 * 判据是"三层对照"：
 *  - 源目录（SOURCE）——文件世界的导入来源；
 *  - 父 run 世界（初始 + 各轮）——隔离创建后的世界；
 *  - 子 run 世界（初始 + 各轮）——隔离续跑后的世界。
 * 逐份按 `sha256` 比对，而不是"看起来一样"。
 */
async function workspaceFingerprint(page, runId) {
  return page.evaluate(async (id) => {
    const inspect = await window.api.inspectWorkspace({ runId: id });
    if (!inspect.ok) return { ok: false, error: inspect.error, checkpoints: [] };
    const hashes = {};
    for (const file of inspect.data.files) {
      // 初始侧（不传 stepSpanId）
      const initial = await window.api.readWorkspaceFile({ runId: id, path: file.path });
      hashes[`initial:${file.path}`] =
        initial.ok && initial.data.sha256 !== undefined
          ? initial.data.sha256
          : `<${initial.ok ? initial.data.status : initial.error.code}>`;
    }
    return {
      ok: true,
      hashes,
      snapshotId: inspect.data.snapshotId,
      fileCount: inspect.data.fileCount,
    };
  }, runId);
}

/** 源目录的文件哈希（作为"世界之外"的对照：只读视图绝不允许改动它） */
function sourceHashes() {
  const acc = {};
  for (const name of readdirSync(SOURCE).sort()) {
    const full = join(SOURCE, name);
    if (statSync(full).isFile()) acc[name] = hash(full);
  }
  return acc;
}

async function phaseFiles() {
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  const { parentId, childId } = state;
  const { page } = await connect();

  // 清掉残留对话框（模态 overlay 会挡住一切点击）
  const stale = page.locator('dialog[aria-label="新建运行"]');
  if ((await stale.count()) > 0) {
    await stale.getByRole("button", { name: "取消" }).click();
    await page.waitForTimeout(400);
  }
  // 恢复常规窗口尺寸（上一阶段可能把窗口留窄了）
  await resizeWindow(page, { width: 1280, height: 860 });
  await page.reload();
  await page.waitForTimeout(2000);

  const fingerprintsBefore = fingerprintFiles([SOURCE, ...traceFiles()]);
  const srcBefore = sourceHashes();

  // ── A. 文件 tab 只在隔离 run 出现 ───────────────────────────────────────────
  await selectRunInList(page, parentId);
  const filesTabOnIsolated = await page.getByTitle(/查看隔离文件世界的检查点清单/).count();
  check("隔离 run 详情页出现「文件」tab", filesTabOnIsolated > 0);

  await selectRunInList(page, "r_01");
  const filesTabOnPlain = await page.getByTitle(/查看隔离文件世界的检查点清单/).count();
  check("非隔离 run 详情页**不**出现「文件」tab", filesTabOnPlain === 0);

  // ── B. 打开文件 tab：选择器 / 只读声明 / 无回写入口 ─────────────────────────
  await selectRunInList(page, parentId);
  await page
    .getByTitle(/查看隔离文件世界的检查点清单/)
    .first()
    .click();
  const tabOpened = await waitForText(page, "文件检查点", 10000);
  check("文件 tab 打开后渲染检查点选择器", tabOpened);
  const readonlyShown = await page.locator("text=只读视图").count();
  check("只读声明在场（不写文件 / 不补快照 / 不调用模型）", readonlyShown > 0);
  const writebackCount = await page.locator("text=应用到源目录").count();
  check("**没有任何回写 / 应用到源目录的入口**", writebackCount === 0);
  await shot(page, "11-files-tab.png");

  // ── C. 选择器轮号按「本 run 自己的 step.n」计 ────────────────────────────────
  // 父 run 冒烟剧本是 2 轮（read_file 工具轮 + 收尾轮）⇒ 选择器应含第 1、第 2 轮，
  // 且**不含**第 3 轮（3 是"沿合并轨迹累加"才会出现的数）。
  const rounds = await page.evaluate(() =>
    [...document.querySelectorAll("button")]
      .map((b) => b.textContent ?? "")
      .filter((t) => t.startsWith("本 run 第")),
  );
  check(
    "选择器含「本 run 初始状态」+ 按本 run 自有轮号命名的检查点",
    (await page.getByRole("button", { name: "本 run 初始状态", exact: true }).count()) > 0 &&
      rounds.includes("本 run 第 1 轮结束"),
    JSON.stringify(rounds),
  );
  check(
    "选择器**不**出现沿链累加才会有的第 3/4 轮",
    !rounds.includes("本 run 第 3 轮结束") && !rounds.includes("本 run 第 4 轮结束"),
    JSON.stringify(rounds),
  );

  // ── D. 逐检查点核对：初始快照 = 源目录内容（按哈希） ───────────────────────
  const initialFp = await workspaceFingerprint(page, parentId);
  check(
    "文件清单 IPC 往返（runId 取到隔离世界）",
    initialFp.ok === true,
    JSON.stringify(initialFp.error ?? ""),
  );
  const src = srcBefore;
  // a.txt 初始内容 = "alpha 内容"；keep.txt = "keep"
  check(
    "初始快照的 a.txt 哈希 = 源目录 a.txt（逐字节一致）",
    initialFp.hashes["initial:a.txt"] === src["a.txt"],
    `world=${initialFp.hashes["initial:a.txt"]} src=${src["a.txt"]}`,
  );
  check(
    "初始快照的 keep.txt 哈希 = 源目录 keep.txt",
    initialFp.hashes["initial:keep.txt"] === src["keep.txt"],
  );

  // ── E. 打开某个文件看差异（选中 a.txt） ────────────────────────────────────
  await page
    .getByRole("button", { name: /^a\.txt/ })
    .first()
    .click();
  await page.waitForTimeout(1200);
  const diffOrStatus = await page.locator("text=左：本 run 初始状态").count();
  const binaryPanel = await page.locator("text=二进制文件").count();
  check("选中文件后渲染差异视图或状态面板（不空白）", diffOrStatus > 0 || binaryPanel > 0);
  await shot(page, "12-files-diff.png");

  // ── F. 只读性：浏览一轮后源目录 + 全部 trace 逐字节不变 ─────────────────────
  //（多走几个检查点：逐轮切换）
  await page.getByRole("button", { name: "本 run 第 1 轮结束", exact: true }).first().click();
  await page.waitForTimeout(900);
  check(
    "浏览文件视图无写入：源目录与全部 trace 逐字节不变",
    fingerprintFiles([SOURCE, ...traceFiles()]) === fingerprintsBefore,
  );
  check(
    "浏览文件视图无写入：源目录文件哈希集合不变",
    JSON.stringify(sourceHashes()) === JSON.stringify(srcBefore),
  );

  // ── G. 子 run（隔离续跑）的文件世界：来源说明 + 编辑后的内容 ────────────────
  // **「轮号不沿链累加」的真证据在这里**：父 run 有 2 轮，子 run 从第 1 轮后分叉、
  // 自己只再跑 1 轮 ⇒ 子 run 的选择器只能是「本 run 第 1 轮结束」；若沿合并轨迹
  // 累加，这里会冒出第 3 轮（父 2 + 子 1）。
  if (childId !== null) {
    await selectRunInList(page, childId);
    await page
      .getByTitle(/查看隔离文件世界的检查点清单/)
      .first()
      .click();
    await page.waitForTimeout(1200);
    const childOrigin = await page.locator(`text=父运行 ${parentId}`).count();
    check("子 run 文件 tab 的来源说明指父 run（不写成自己的轮号）", childOrigin > 0);
    const childRounds = await page.evaluate(() =>
      [...document.querySelectorAll("button")]
        .map((b) => b.textContent ?? "")
        .filter((t) => t.startsWith("本 run 第")),
    );
    check(
      "子 run 选择器只出现它自己的第 1 轮（**不沿链累加**成第 3 轮）",
      childRounds.includes("本 run 第 1 轮结束") &&
        !childRounds.includes("本 run 第 2 轮结束") &&
        !childRounds.includes("本 run 第 3 轮结束"),
      JSON.stringify(childRounds),
    );
    const childFp = await workspaceFingerprint(page, childId);
    // 子 run 的初始快照 = 父 run 第 1 轮检查点（origin.kind=checkpoint + step s_01）。
    // ⚠️ 编辑的是 **tool_result**（模型看到的数据），不是文件 ⇒ 文件世界内容与父第 1 轮
    // 检查点**逐份相同**（拿父的 step n=1 清单做对照，而不是"看起来像"）。
    const parentRound1Hashes = await page.evaluate(async (id) => {
      const envelope = await window.api.getRun(id);
      if (!envelope.ok) return {};
      const step = envelope.data.spans.find((s) => s.kind === "agent.step" && s.n === 1);
      if (step === undefined) return {};
      const inspect = await window.api.inspectWorkspace({ runId: id, stepSpanId: step.id });
      if (!inspect.ok) return {};
      return Object.fromEntries(inspect.data.files.map((f) => [f.path, f.sha256]));
    }, parentId);
    check(
      "子 run 初始快照与父 run 第 1 轮检查点**逐份哈希相同**（编辑的是 tool_result 不是文件）",
      childFp.ok === true &&
        Object.keys(parentRound1Hashes).length > 0 &&
        Object.entries(parentRound1Hashes).every(
          ([path, sha]) => childFp.hashes[`initial:${path}`] === sha,
        ),
      `child=${JSON.stringify(childFp.hashes)} parentR1=${JSON.stringify(parentRound1Hashes)}`,
    );
    await shot(page, "13-files-child.png");
  }

  // ── H. 不可用附件必须用**文字**标签（不只靠颜色）且不得渲染成空文件 ────────
  // 做法：**临时把某个附件从 blob store 挪走**（模拟"附件缺失"），看界面是否
  // ① 出文字标签、② 不进编辑器；看完立刻还原（源目录与 trace 都不动）。
  const blobRoot = join(DATA_DIR, "workspace-blobs", "sha256");
  const movedBlobs = [];
  const fingerprintBeforeUnavailable = fingerprintFiles([SOURCE, ...traceFiles()]);
  for (const name of existsSync(blobRoot) ? readdirSync(blobRoot) : []) {
    const src = join(blobRoot, name);
    const dst = `${src}.smoke-hidden`;
    try {
      renameSync(src, dst);
      movedBlobs.push({ src, dst });
    } catch {
      /* 被占用就跳过 */
    }
  }
  try {
    await page.reload();
    await page.waitForTimeout(1800);
    await selectRunInList(page, parentId);
    await page
      .getByTitle(/查看隔离文件世界的检查点清单/)
      .first()
      .click();
    await page.waitForTimeout(1200);
    const missingLabel = await page.locator("text=附件缺失").count();
    check(
      "附件缺失时界面出**文字**标签「附件缺失」（不只靠颜色）",
      missingLabel > 0,
      `标签数=${missingLabel}（已临时挪走 ${movedBlobs.length} 个 blob）`,
    );
    // 汇总行也必须报不可用数
    const summaryWarn = await page.locator("text=个附件不可用").count();
    check("清单汇总行报出「N 个附件不可用」", summaryWarn > 0);
    await shot(page, "15-files-unavailable.png");
    // 点开一个缺失文件：必须出状态面板，**不得**渲染 DiffEditor 冒充空文件
    await page
      .getByRole("button", { name: /^a\.txt/ })
      .first()
      .click();
    await page.waitForTimeout(1200);
    const missingPanel = await page.locator("text=无法读取内容").count();
    check("缺失附件不进编辑器：出状态面板而非伪空文件", missingPanel > 0);
  } finally {
    for (const { src, dst } of movedBlobs) {
      try {
        renameSync(dst, src);
      } catch {
        /* 还原失败也要继续，最后一条 check 会暴露 */
      }
    }
  }
  check(
    "临时挪走/还原附件全程未改动源目录与 trace（只读）",
    fingerprintFiles([SOURCE, ...traceFiles()]) === fingerprintBeforeUnavailable,
  );

  writeFileSync(join(OUT, "files-checks.json"), JSON.stringify(checks, null, 2));
}

// ---------------------------------------------------------------------------
// phase=files-restart（C 3.1：重启后文件差异仍可查）
// ---------------------------------------------------------------------------

async function phaseFilesRestart() {
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  const { parentId } = state;
  const { page } = await connect();
  const fingerprintsBefore = fingerprintFiles([SOURCE, ...traceFiles()]);

  const stale = page.locator('dialog[aria-label="新建运行"]');
  if ((await stale.count()) > 0) {
    await stale.getByRole("button", { name: "取消" }).click();
    await page.waitForTimeout(400);
  }
  await resizeWindow(page, { width: 1280, height: 860 });
  await page.reload();
  await page.waitForTimeout(2000);

  // 重启后按 runId 直接取清单（不经 UI 状态）
  const afterRestart = await page.evaluate(async (id) => {
    const inspect = await window.api.inspectWorkspace({ runId: id });
    if (!inspect.ok) return { ok: false, error: inspect.error };
    const file = await window.api.readWorkspaceFile({ runId: id, path: "a.txt" });
    return {
      ok: true,
      fileCount: inspect.data.fileCount,
      snapshotId: inspect.data.snapshotId,
      aText: file.ok ? file.data.status : `<${file.error.code}>`,
      aHash: file.ok ? file.data.sha256 : null,
    };
  }, parentId);
  check(
    "重启后文件清单 IPC 仍可查（runId → 隔离世界）",
    afterRestart.ok === true && afterRestart.fileCount >= 2,
    JSON.stringify(afterRestart),
  );

  await selectRunInList(page, parentId);
  await page
    .getByTitle(/查看隔离文件世界的检查点清单/)
    .first()
    .click();
  const tabOpened = await waitForText(page, "文件检查点", 10000);
  check("重启后文件 tab 仍可打开", tabOpened);
  await page
    .getByRole("button", { name: /^a\.txt/ })
    .first()
    .click();
  await page.waitForTimeout(1200);
  const diffShown = await page.locator("text=左：本 run 初始状态").count();
  check("重启后仍能查看文件差异", diffShown > 0);
  await shot(page, "14-files-after-restart.png");

  check(
    "重启后源目录与全部 trace 逐字节不变",
    fingerprintFiles([SOURCE, ...traceFiles()]) === fingerprintsBefore,
  );

  writeFileSync(join(OUT, "files-restart-checks.json"), JSON.stringify(checks, null, 2));
}

// ---------------------------------------------------------------------------
// phase=files-migrate（C 3.1：整体迁移 dataDir 后文件仍可查）
// ---------------------------------------------------------------------------

/**
 * 真迁移：把**整个数据目录**复制到新位置，再用 A 包的 read API 按**新 dataDir**
 * 读同一份 trace，逐份核对文件哈希是否与迁移前相同。
 *
 * 迁移的是**数据目录**（traces + workspace-blobs），不是源目录——源目录不在 trace
 * 引用里（附件只按 `sha256` 寻址、物理路径由哈希生成），所以迁移不影响可查性。
 *
 * ⚠️ 这一段**不走浏览器**：迁移的语义是"换一个 dataDir 根还能不能读"，属于包层
 * 契约，直接用 Node 调 `@rebaseagent/replay` 的公开 API 才是最直接的判据
 * （浏览器里再套一层 Vite 模块解析只会引入噪声）。
 */
async function phaseFilesMigrate() {
  const migrated = join(OUT, "migrated-data");
  rmSync(migrated, { recursive: true, force: true });
  mkdirSync(migrated, { recursive: true });
  for (const name of ["traces", "workspace-blobs"]) {
    const from = join(DATA_DIR, name);
    if (existsSync(from)) copyDir(from, join(migrated, name));
  }
  const migratedTraces = readdirSync(join(migrated, "traces")).filter((n) => n.endsWith(".jsonl"));
  check(
    "迁移载体齐备：traces 与 workspace-blobs 一并复制到新根",
    migratedTraces.length > 0 && existsSync(join(migrated, "workspace-blobs", "sha256")),
    `traces=${migratedTraces.length}`,
  );

  const state = JSON.parse(readFileSync(STATE, "utf8"));
  const { parentId } = state;
  const { page } = await connect();
  const before = await workspaceFingerprint(page, parentId);

  // 用新根调 A 包（Node 侧）：readRun(新 trace 路径) + readWorkspaceFile(新 root)
  const after = await readViaNewRoot(migrated, parentId);
  check(
    "迁移后 A 包按新 dataDir 读到 trace 与附件（不依赖应用进程）",
    after.ok === true,
    after.ok ? `文件 ${Object.keys(after.hashes).length} 份` : JSON.stringify(after),
  );
  check(
    "迁移后逐份哈希与迁移前**完全相同**（内容身份与所在目录无关）",
    after.ok === true &&
      Object.keys(before.hashes).length > 0 &&
      Object.entries(before.hashes).every(([key, sha]) => after.hashes[key] === sha),
    `before=${JSON.stringify(before.hashes)} after=${JSON.stringify(after.hashes)}`,
  );

  const migratedBlobDir = join(migrated, "workspace-blobs", "sha256");
  const originalBlobDir = join(DATA_DIR, "workspace-blobs", "sha256");
  const migratedBlobs = existsSync(migratedBlobDir) ? readdirSync(migratedBlobDir).sort() : [];
  const originalBlobs = existsSync(originalBlobDir) ? readdirSync(originalBlobDir).sort() : [];
  check(
    "迁移根与原根的附件 blob **逐份同名**",
    migratedBlobs.length > 0 && JSON.stringify(migratedBlobs) === JSON.stringify(originalBlobs),
    `migrated=${migratedBlobs.length} original=${originalBlobs.length}`,
  );
  // 内容寻址自证：每个 blob 文件的内容哈希 = 它的文件名
  const blobIntact = migratedBlobs.every((name) => hash(join(migratedBlobDir, name)) === name);
  check("迁移根里每个 blob 的内容哈希 = 其文件名（内容寻址自证）", blobIntact);
  check(
    "迁移是只读复制：原 dataDir 的 blob 仍在原位可用",
    originalBlobs.length > 0,
    `original blobs=${originalBlobs.length}`,
  );
  writeFileSync(join(OUT, "files-migrate-checks.json"), JSON.stringify(checks, null, 2));
}

/**
 * Node 侧用**新 dataDir 根**读一遍：直接调已构建的 A 包 dist。
 * （独立于 dev 进程，证明迁移后的可读性不依赖任何内存状态。）
 *
 * 签名（`packages/replay/src/workspace/read-api.ts`）：`readWorkspaceFile({ dataDir, runId, path })`，
 * 返回 `{ status, path, file, text? }`，`file.sha256` 即附件哈希。
 */
async function readViaNewRoot(newRoot, runId) {
  const { pathToFileURL } = await import("node:url");
  const { readRun } = await import(
    pathToFileURL(join(REPO, "packages", "trace-sdk", "dist", "index.js")).href
  );
  const replay = await import(
    pathToFileURL(join(REPO, "packages", "replay", "dist", "index.js")).href
  );
  let record;
  try {
    record = readRun(join(newRoot, "traces", `${runId}.jsonl`));
  } catch (error) {
    return { ok: false, step: "readRun", error: String(error) };
  }
  const hashes = {};
  for (const entry of record.meta.workspace?.initial_snapshot?.files ?? []) {
    try {
      const result = await replay.readWorkspaceFile({
        dataDir: newRoot,
        runId,
        path: entry.path,
      });
      hashes[`initial:${entry.path}`] =
        result.status === "text" || result.status === "binary"
          ? result.file.sha256
          : `<${result.status}>`;
    } catch (error) {
      hashes[`initial:${entry.path}`] = `<${String(error).slice(0, 60)}>`;
    }
  }
  return { ok: true, hashes };
}

/** 递归复制目录（Node 无内建 cp -r 的稳定实现，自己走一遍） */
function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dst = join(to, name);
    if (statSync(src).isDirectory()) copyDir(src, dst);
    else copyFileSync(src, dst);
  }
}

// ---------------------------------------------------------------------------
// phase=files-narrow（C 3.2：长路径 + 长文本 diff 的宽/窄窗口截图与核对）
// ---------------------------------------------------------------------------

/** 3.2 用的长相对路径（在源根之下，模拟深目录结构 + 长文件名） */
const LONG_REL_DIR = join(
  "deeply-nested-directory-structure",
  "with-several-levels",
  "to-exercise-path-wrapping",
  "in-the-compact-file-list",
);
/** 长相对路径 + 长文本的文件（diff 内容源） */
const LONG_REL_FILE = join(LONG_REL_DIR, "quarterly-report-with-a-rather-long-file-name.txt");

/** 造一段"长文本"：足够多的行 + 若干超长行（考验换行与横向滚动） */
function longReportText() {
  const lines = [];
  lines.push("== 长文本样本（C 3.2）==");
  for (let i = 1; i <= 200; i += 1) {
    lines.push(
      `第 ${String(i).padStart(3, "0")} 行：这是一行用于验证长文本 diff 的中文内容，编号 ${i}。`,
    );
  }
  // 两条超长行（不做换行的编辑器里必须出现横向滚动条）
  lines.push(`超长行-单行: ${"X".repeat(400)}`);
  lines.push(`超长行-单行: ${"Y".repeat(400)}`);
  return `${lines.join("\n")}\n`;
}

/**
 * C 3.2：以**长源路径**创建隔离 run，然后在文件视图里打开"长路径 + 长文本"的文件，
 * 分别在桌面宽度与窄窗口下截图核对；并**用哈希**（不是截图）核对长文本内容。
 *
 * 前置（与 B 的 narrow 阶段相同）：dev 以 `REBASEAGENT_SMOKE_PICK_DIR=<LONG_SOURCE>` 启动。
 */
async function phaseFilesNarrow() {
  // ── 夹具：a.txt（供 mock 的 read_file）+ 长路径长文本文件 ────────────────────
  mkdirSync(join(LONG_SOURCE, LONG_REL_DIR), { recursive: true });
  writeFileSync(join(LONG_SOURCE, "a.txt"), "alpha 内容");
  const longFile = join(LONG_SOURCE, LONG_REL_FILE);
  writeFileSync(longFile, longReportText(), "utf8");
  const longFileHash = hash(longFile);

  const { page } = await connect();
  const stale = page.locator('dialog[aria-label="新建运行"]');
  if ((await stale.count()) > 0) {
    await stale.getByRole("button", { name: "取消" }).click();
    await page.waitForTimeout(400);
  }
  await resizeWindow(page, WIDE);
  await page.reload();
  await page.waitForTimeout(2200);

  const countBefore = traceFiles().length;
  const idsBefore = await page.evaluate(async () => {
    const envelope = await window.api.listRuns();
    return envelope.ok ? envelope.data.runs.map((r) => r.id) : [];
  });

  // ── A. 从长源路径创建隔离 run（复用 B narrow 的对话框驱动） ─────────────────
  await page
    .getByRole("button", { name: /新建运行/ })
    .first()
    .click();
  const dialog = page.locator('dialog[aria-label="新建运行"]');
  await dialog.waitFor({ state: "visible", timeout: 5000 });
  await dialog.getByRole("button", { name: "隔离文件运行" }).click();
  await page.waitForTimeout(200);
  await dialog.getByRole("button", { name: /选择目录/ }).click();
  await page.waitForTimeout(800);
  await dialog.locator("textarea").nth(1).fill("读取 a.txt 并复述内容");
  await dialog.getByLabel("允许本次执行的副本写入", { exact: false }).check();
  await dialog.getByRole("button", { name: "创建隔离运行" }).click();
  const created = await waitForTraceCount(countBefore + 1);
  check("长源路径下隔离创建落盘", created);
  await page.waitForTimeout(1800);

  const runs = await page.evaluate(async () => {
    const envelope = await window.api.listRuns();
    return envelope.ok ? envelope.data.runs.map((r) => r.id) : [];
  });
  const newId = runs.find((id) => !idsBefore.includes(id));
  check("长源路径 run 出现在列表", typeof newId === "string" && newId.length > 0, String(newId));

  // **只读基线在创建之后取**：创建本身会写 1 份 trace（这是隔离创建的合法写入），
  // 之后浏览文件视图必须一个字节都不再动。
  const fingerprintBaseline = fingerprintFiles([LONG_SOURCE, ...traceFiles()]);

  // 长路径文件确实进了清单（世界采集了整个源目录，不只是被读的那个文件）
  const inspect = await page.evaluate(async (id) => {
    const envelope = await window.api.inspectWorkspace({ runId: id });
    if (!envelope.ok) return { ok: false, error: envelope.error };
    return {
      ok: true,
      files: envelope.data.files.map((f) => f.path),
      fileCount: envelope.data.fileCount,
    };
  }, newId);
  check(
    "长路径文件被采集进隔离世界清单（清单不止被读的那个文件）",
    inspect.ok === true && inspect.files.some((p) => p.includes("quarterly-report")),
    JSON.stringify(inspect),
  );

  // ── B. 打开文件视图，选长路径长文本文件 ────────────────────────────────────
  await selectRunInList(page, newId);
  await page
    .getByTitle(/查看隔离文件世界的检查点清单/)
    .first()
    .click();
  const opened = await waitForText(page, "文件检查点", 10000);
  check("长源路径 run 的文件 tab 可打开", opened);
  // 文件表里长路径必须**换行显示**（break-all），不是被裁掉
  const pathCell = page.locator("li div.break-all").filter({ hasText: "quarterly-report" }).first();
  await pathCell.scrollIntoViewIfNeeded();
  const listOverflow = await overflowsHorizontally(pathCell);
  check(
    "长路径在紧凑文件表里换行显示（无横向溢出）",
    (await pathCell.count()) > 0 && listOverflow === false,
    `溢出=${listOverflow}`,
  );
  await shot(page, "16-files-longpath-list.png");

  await pathCell.click();
  await page.waitForTimeout(1500);
  const longDiffShown = await page.locator("text=左：本 run 初始状态").count();
  check("长文本文件进入 diff 视图（左右两侧标题在场）", longDiffShown > 0);

  // ── C. **哈希核对**（不靠截图）：IPC 读回的 sha256 = 磁盘上该文件的 sha256 ──
  const readBack = await page.evaluate(
    async ({ id, path }) => {
      const result = await window.api.readWorkspaceFile({ runId: id, path });
      if (!result.ok) return { ok: false, error: result.error };
      return {
        ok: true,
        status: result.data.status,
        sha256: result.data.sha256,
        bytes: result.data.bytes,
        textLength: result.data.text?.length ?? null,
        text: result.data.text ?? null,
      };
    },
    { id: newId, path: LONG_REL_FILE.replace(/\\/g, "/") },
  );
  check(
    "长文本文件按哈希核对：IPC 读回的 sha256 = 磁盘源文件 sha256（不靠截图）",
    readBack.ok === true && readBack.sha256 === longFileHash,
    `ipc=${String(readBack.sha256)} disk=${longFileHash} status=${String(readBack.status)}`,
  );
  const expectedText = longReportText();
  check(
    "长文本**完整**返回（字符数一致，未被截断）",
    readBack.ok === true && readBack.textLength === expectedText.length,
    `ipc=${String(readBack.textLength)} 期望=${expectedText.length}`,
  );
  check(
    "长文本内容逐字符一致（含两条 400 字符超长行）",
    readBack.ok === true &&
      readBack.text === expectedText &&
      readBack.text.includes("X".repeat(400)) &&
      readBack.text.includes("Y".repeat(400)),
  );

  // ── D. 桌面宽度截图（长文本 diff） ─────────────────────────────────────────
  const wideActual = await resizeWindow(page, WIDE);
  await page.waitForTimeout(1000);
  await shot(page, "17-files-longtext-wide.png");
  check(
    "桌面宽度下详情列可用（>300px）",
    (await detailColumnWidth(page)) > 300,
    `@${wideActual.width}px`,
  );

  // ── E. 窄窗口截图 + 列表/内容切换 ──────────────────────────────────────────
  // ⚠️ 文件视图的二选一切换挂在 Tailwind `lg`（1024px）断点下：`lg:hidden` 的切换条
  // 只在 <1024px 出现，两栏并排是 ≥1024px 的**正确**行为。所以窄窗核对取 900px
  // （三栏外壳固定 704px ⇒ 详情列 196px，正是切换机制设计的服务对象）。
  const narrowActual = await resizeWindow(page, FILES_NARROW);
  await page.waitForTimeout(1000);
  // 窄窗口下「文件列表 / 内容」切换按钮必须出现（lg 断点以下才渲染）
  const listTab = page.getByRole("button", { name: "文件列表", exact: true });
  const contentTab = page.getByRole("button", { name: "内容", exact: true });
  const toggleVisible = (await listTab.count()) > 0 && (await contentTab.count()) > 0;
  check(
    `窄窗口（${narrowActual.width}px < lg 1024px）下出现「文件列表 / 内容」切换（不互相遮挡）`,
    toggleVisible,
  );
  await listTab.click();
  await page.waitForTimeout(600);
  await shot(page, "18-files-longtext-narrow-list.png");
  const listPaneShown = await page
    .locator("li div.break-all")
    .filter({ hasText: "quarterly-report" })
    .first()
    .isVisible();
  check("窄窗口切到「文件列表」时列表可见", listPaneShown === true);
  await contentTab.click();
  await page.waitForTimeout(800);
  await shot(page, "19-files-longtext-narrow-content.png");
  check(
    "窄窗口切到「内容」时 diff 区可见、列表让位（不重叠）",
    (await page.locator("text=左：本 run 初始状态").count()) > 0,
  );
  // 内容区不得横向溢出（wordWrap 生效）
  const editorOverflow = await overflowsHorizontally(
    page.locator("div.mx-4.mb-4.overflow-hidden").first(),
  );
  check(
    "窄窗口下长文本按换行显示（内容区无横向溢出）",
    editorOverflow === false,
    `溢出=${editorOverflow}`,
  );

  // ── F. 只读性：浏览全程未改动源目录与 trace ────────────────────────────────
  check(
    "长路径/长文本浏览全程无写入：源目录与全部 trace 逐字节不变",
    fingerprintFiles([LONG_SOURCE, ...traceFiles()]) === fingerprintBaseline,
  );
  check("长文本源文件哈希未变（只读视图不回写源目录）", hash(longFile) === longFileHash);

  writeFileSync(join(OUT, "files-narrow-checks.json"), JSON.stringify(checks, null, 2));
}

// ---------------------------------------------------------------------------
// phase=narrow（B 3.3：窄窗口 + 长源路径下的创建与确认区）
// ---------------------------------------------------------------------------

async function phaseNarrow() {
  mkdirSync(LONG_SOURCE, { recursive: true });
  writeFileSync(join(LONG_SOURCE, "a.txt"), "alpha 内容");
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  const { parentId } = state;

  const { page } = await connect();
  const notes = [];
  // 清掉上一轮可能残留的对话框（它是模态 overlay，会挡住后续一切点击）
  const stale = page.locator('dialog[aria-label="新建运行"]');
  if ((await stale.count()) > 0) {
    await stale.getByRole("button", { name: "取消" }).click();
    await page.waitForTimeout(400);
  }
  const narrowActual = await resizeWindow(page, NARROW);
  check(
    "窗口真的被拉窄（渲染层 innerWidth 回读自证，非 viewport 模拟）",
    narrowActual.width < 700,
    JSON.stringify(narrowActual),
  );
  // 记录（不判定）三栏外壳在 460px 下的挤压程度：这是既有外壳的固有下限，不是本 change 的确认区问题
  notes.push({
    at: `${String(narrowActual.width)}px`,
    detailColumnWidth: await detailColumnWidth(page),
    note: "三栏固定列 704px（列表 320 + span 树 384）⇒ 详情列被压到接近 0；确认区读数改取 1040px",
  });

  // ── 1. 窄窗口 + 长源路径：创建对话框 ──────────────────────────────────────
  await page
    .getByRole("button", { name: /新建运行/ })
    .first()
    .click();
  const dialog = page.locator('dialog[aria-label="新建运行"]');
  await dialog.waitFor({ state: "visible", timeout: 5000 });
  await dialog.getByRole("button", { name: "隔离文件运行" }).click();
  await page.waitForTimeout(200);
  await dialog.getByRole("button", { name: /选择目录/ }).click();
  await page.waitForTimeout(800);
  await dialog.locator("textarea").nth(1).fill("在窄窗口里跑一次隔离运行");

  const pathRow = dialog.locator("div.break-all").first();
  // 先滚到可见（主体可滚动是刻意的设计），再判"横向无溢出 + 完整落在视口内"
  await pathRow.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  // 截图放在把长路径滚进视野之后，否则图里看不到"路径换行"这件事
  await shot(page, "09-narrow-create.png");
  const pathOverflow = await overflowsHorizontally(pathRow);
  const pathVisible = await inViewport(page, pathRow);
  check(
    "长源路径在窄窗口内换行显示（无横向溢出、滚动后完整可见）",
    pathOverflow === false &&
      pathVisible === true &&
      (await pathRow.textContent()).includes("long-path-fixture"),
    `溢出=${pathOverflow} 视口内=${pathVisible}`,
  );

  const dialogOverflow = await overflowsHorizontally(dialog);
  check("对话框本身不横向溢出", dialogOverflow === false);

  const authLabel = dialog.getByLabel("允许本次执行的副本写入", { exact: false });
  const createBtn = dialog.getByRole("button", { name: "创建隔离运行" });
  const reasonText = (await dialog.locator("div.text-amber-800").first().textContent()) ?? "";
  check(
    "授权复选框与提交按钮在窄窗口可见（授权可见 + 未授权时禁用 + 文字原因）",
    (await inViewport(page, authLabel)) === true &&
      (await inViewport(page, createBtn)) === true &&
      (await createBtn.isDisabled()) === true &&
      reasonText.includes("副本写入"),
    `原因文字=${JSON.stringify(reasonText.slice(0, 40))}`,
  );

  const scrollable = await dialog
    .locator("div.overflow-y-auto")
    .first()
    .evaluate((el) => el.scrollHeight >= el.clientHeight);
  check("对话框主体可滚动（内容不被裁掉）", scrollable === true);

  await authLabel.check();
  await page.waitForTimeout(200);
  check(
    "勾选后提交按钮由禁用转为可用（提交状态在窄窗口可辨认）",
    (await createBtn.isEnabled()) === true,
  );
  await shot(page, "10-narrow-create-ready.png");
  await dialog.getByRole("button", { name: "取消" }).click();
  await page.waitForTimeout(300);

  // ── 2. 窄窗口：隔离续跑确认区 ─────────────────────────────────────────────
  // 先刷新页面：把上一轮可能残留的、已经打开的编辑器清掉（否则入口按钮不存在）
  await page.reload();
  await page.waitForTimeout(2200);
  const appNarrowActual = await resizeWindow(page, NARROW_APP);
  const narrowDetailWidth = await detailColumnWidth(page);
  check(
    "窄窗口下确认区所在详情列仍有可用宽度（>250px）",
    narrowDetailWidth > 250,
    `详情列 ${String(narrowDetailWidth)}px @ ${String(appNarrowActual.width)}px`,
  );
  await selectRunInList(page, parentId);
  await clickSpanRow(page, /工具\s*read_file/);
  const entry = page.getByRole("button", { name: /在此重跑（隔离续跑）/ }).first();
  if ((await entry.count()) === 0) throw new Error("未找到「在此重跑（隔离续跑）」入口");
  await entry.scrollIntoViewIfNeeded();
  await entry.click();
  await page.waitForTimeout(500);
  await page.locator(".monaco-editor").first().click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(`${EDITED_RESULT}（窄窗口）`);
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: /校验续跑条件/ }).click();
  const confirmShown = await waitForText(page, `从运行 ${parentId} 的第 1 轮结束后继续`);
  await shot(page, "11-narrow-fork-confirm.png");

  const forkAuth = page.getByLabel("允许本次副本写入", { exact: false });
  const submitBtn = page.getByRole("button", { name: "确认重跑" });
  const parentRow = page.locator("text=父 run").first();
  await submitBtn.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const forkAuthVisible = await inViewport(page, forkAuth);
  const submitVisible = await inViewport(page, submitBtn);
  const submitDisabled = await submitBtn.isDisabled();
  const parentRowCount = await parentRow.count();
  const checkpointRowCount = await page.locator("text=轮末检查点").count();
  const confirmOverflow = await overflowsHorizontally(
    page.locator("div.border-violet-200.bg-white").first(),
  );
  check(
    "窄窗口确认区：父 run / 轮末检查点 / 授权 / 提交状态都可读且不遮挡",
    confirmShown &&
      appNarrowActual.width < 1100 &&
      forkAuthVisible &&
      submitVisible &&
      parentRowCount > 0 &&
      checkpointRowCount > 0 &&
      submitDisabled &&
      confirmOverflow === false,
    `宽度=${appNarrowActual.width} 授权可见=${forkAuthVisible} 提交可见=${submitVisible} 提交禁用=${submitDisabled} 父行=${parentRowCount} 检查点行=${checkpointRowCount} 溢出=${confirmOverflow} 续跑行=${confirmShown}`,
  );
  await forkAuth.check();
  await page.waitForTimeout(200);
  check(
    "窄窗口下勾选授权后「确认重跑」可用（未提交，不产生模型调用）",
    (await submitBtn.isEnabled()) === true,
  );

  // ── 3. 代表性桌面尺寸下同一确认区（对照：宽窗不出现换行挤压） ───────────────
  const wideActual = await resizeWindow(page, WIDE);
  notes.push({
    at: `${String(wideActual.width)}px`,
    detailColumnWidth: await detailColumnWidth(page),
  });
  await shot(page, "12-wide-fork-confirm.png");
  check(
    "代表性桌面尺寸下确认区同样完整可见",
    wideActual.width > 1000 &&
      (await inViewport(page, forkAuth)) === true &&
      (await inViewport(page, submitBtn)) === true,
    JSON.stringify(wideActual),
  );

  // 收起编辑器（不提交任何东西，零模型调用）；编辑器可能已不存在，故容错
  const closeEditor = page.getByRole("button", { name: "取消" }).first();
  if ((await closeEditor.count()) > 0) await closeEditor.click();
  writeFileSync(
    join(OUT, "narrow-checks.json"),
    JSON.stringify(
      { checks, notes, narrow: narrowActual, appNarrow: appNarrowActual, wide: wideActual },
      null,
      2,
    ),
  );
  console.log("截图与报告目录:", OUT);
}

// ---------------------------------------------------------------------------
// phase=restart
// ---------------------------------------------------------------------------

async function phaseRestart() {
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  const { parentId, childId } = state;
  if (childId === null) throw new Error("state.json 里没有 childId（flow 阶段是否失败？）");

  const fingerprintBefore = fingerprintFiles([SOURCE, ...traceFiles()]);
  const { page } = await connect();
  await shot(page, "07-after-restart.png");

  // 详情 IPC 快照往返：重启后仍能按 id 取到 v2 载荷（含边界与来源）
  const afterRestart = await page.evaluate(
    async (ids) => {
      const child = await window.api.getRun(ids.childId);
      const parent = await window.api.getRun(ids.parentId);
      return {
        child:
          child.ok === true
            ? {
                ok: true,
                parent: child.data.meta.parent,
                resumeAfterStep: child.data.meta.fork?.resume_after_step ?? null,
                originRunId: child.data.meta.workspace?.origin?.run_id ?? null,
                worldId: child.data.meta.workspace?.world_id ?? null,
              }
            : { ok: false, error: child.error },
        parent:
          parent.ok === true
            ? {
                ok: true,
                formatVersion: parent.data.meta.format_version,
                profile: parent.data.meta.workspace?.profile ?? null,
                snapshotFiles: parent.data.meta.workspace?.initial_snapshot?.files?.length ?? null,
              }
            : { ok: false, error: parent.error },
      };
    },
    { parentId, childId },
  );
  check(
    "重启后详情 IPC 快照往返：子 run 带 parent / 轮末边界 / 来源",
    afterRestart.child.ok === true &&
      afterRestart.child.parent === parentId &&
      typeof afterRestart.child.resumeAfterStep === "string" &&
      afterRestart.child.originRunId === parentId &&
      // 每个隔离 run 各有自己的世界（世界 id = 创建该世界的 run id）⇒ 子 run 的
      // world_id 是它自己；父 run 的身份体现在 origin.run_id 上
      afterRestart.child.worldId === childId,
    JSON.stringify(afterRestart.child),
  );
  check(
    "重启后详情 IPC 快照往返：父 run 仍是 v2 + 初始快照清单保留",
    afterRestart.parent.ok === true &&
      afterRestart.parent.formatVersion === 2 &&
      afterRestart.parent.profile === "file-tools-v1" &&
      afterRestart.parent.snapshotFiles === 2,
    JSON.stringify(afterRestart.parent),
  );

  // UI：选中子 run → 来源说明；选中父 run → 隔离标注
  await selectRunInList(page, childId);
  const childNotice = await page.locator(`text=从运行 ${parentId} 的第 1 轮结束后继续`).count();
  check("重启后子运行仍显示「从运行 <父> 的第 1 轮结束后继续」", childNotice > 0);
  await selectRunInList(page, parentId);
  const parentNotice = await page.locator("text=隔离文件运行 · profile file-tools-v1").count();
  check("重启后父运行仍显示文件隔离标注", parentNotice > 0);
  await shot(page, "08-after-restart-detail.png");

  const noErrorBanner = await page.locator("text=轨迹数据结构校验失败").count();
  check("重启后无结构校验失败横幅（详情 IPC 未丢字段）", noErrorBanner === 0);
  check(
    "重启后源目录与全部 trace 逐字节不变",
    fingerprintFiles([SOURCE, ...traceFiles()]) === fingerprintBefore,
  );

  writeFileSync(join(OUT, "restart-checks.json"), JSON.stringify(checks, null, 2));
}

(async () => {
  try {
    if (phase === "flow") {
      await phaseFlow();
    } else if (phase === "restart") {
      await phaseRestart();
    } else if (phase === "narrow") {
      await phaseNarrow();
    } else if (phase === "files") {
      await phaseFiles();
    } else if (phase === "files-restart") {
      await phaseFilesRestart();
    } else if (phase === "files-migrate") {
      await phaseFilesMigrate();
    } else if (phase === "files-narrow") {
      await phaseFilesNarrow();
    } else {
      throw new Error(`未知阶段：${phase}`);
    }
  } catch (error) {
    check(`阶段 ${phase} 未抛异常`, false, String(error));
  } finally {
    if (phase === "flow") restoreSettings();
    const failed = checks.filter((c) => !c.ok);
    console.log(
      `\n合计 ${checks.length} 项：${checks.length - failed.length} 通过 / ${failed.length} 失败`,
    );
    process.exit(failed.length === 0 ? 0 : 1);
  }
})();
