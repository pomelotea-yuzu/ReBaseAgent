/* eslint-disable */
/**
 * B 任务 3.2 的 GUI 冒烟（沙箱自验；配合 `scripts/mock-llm-server.cjs` 做受控模型服务）。
 *
 * 两阶段（**重启必须是真重启**，故拆成两次调用，脚本自身不 spawn 任何进程）：
 *
 *   node scripts/isolated-flow-cdp-smoke.cjs --phase=flow       # 浏览 → 隔离创建 → 改 result → 隔离续跑
 *   <杀 dev 再重启 dev>
 *   node scripts/isolated-flow-cdp-smoke.cjs --phase=restart    # 重开后核对轨迹与来源说明
 *
 * 前置：
 *  1) 受控模型服务在 127.0.0.1:18799（剧本：read_file → 父完成 → 子完成）；
 *     应用 settings.json 的 baseURL 指向它（脚本自己写入并在结束时还原备份）。
 *  2) dev 已起且带 CDP：`NO_SANDBOX=1 REBASEAGENT_SMOKE_PICK_DIR=<源目录> node scripts/start-dev.cjs --remoteDebuggingPort=9222`
 *     —— REBASEAGENT_SMOKE_PICK_DIR 是 main 的冒烟钩子（原生目录框无法被 CDP 驱动）。
 *
 * 覆盖场景：`直接创建隔离文件父本`、`浏览过程无写入`、`分叉不触碰既有文件`、
 * `新建运行不触碰既有文件`、`详情 IPC 快照往返`。
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
  await page.screenshot({ path: join(OUT, "01-initial.png") });

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
  await page.screenshot({ path: join(OUT, "02-picker.png") });
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
  await page.screenshot({ path: join(OUT, "03-create-ready.png") });
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
  await page.screenshot({ path: join(OUT, "04-edited.png") });

  // 编辑进入界面状态的判据：空 fork 时「校验续跑条件」是禁用的，改过之后必须可用
  const verifyEnabled = await page.getByRole("button", { name: /校验续跑条件/ }).isEnabled();
  check("编辑内容已进入界面状态（「校验续跑条件」由禁用转为可用）", verifyEnabled === true);

  const confirmDisabledBeforeCheck = await page
    .getByRole("button", { name: "确认重跑" })
    .isDisabled();
  check("未校验 + 未授权时「确认重跑」禁用（重复提交保护）", confirmDisabledBeforeCheck === true);

  await page.getByRole("button", { name: /校验续跑条件/ }).click();
  const capabilityShown = await waitForText(page, `从运行 ${parentId} 的第 1 轮结束后继续`);
  await page.screenshot({ path: join(OUT, "05-capability.png") });
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
  await page.screenshot({ path: join(OUT, "06-forked.png") });

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
// phase=restart
// ---------------------------------------------------------------------------

async function phaseRestart() {
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  const { parentId, childId } = state;
  if (childId === null) throw new Error("state.json 里没有 childId（flow 阶段是否失败？）");

  const fingerprintBefore = fingerprintFiles([SOURCE, ...traceFiles()]);
  const { page } = await connect();
  await page.screenshot({ path: join(OUT, "07-after-restart.png") });

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
  await page.screenshot({ path: join(OUT, "08-after-restart-detail.png") });

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
