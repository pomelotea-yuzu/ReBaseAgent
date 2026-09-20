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
