/* eslint-disable */
/**
 * U6 任务 6.8（第五批受控实机）：800/1024/1440 CSS px、独立 200% 与真键盘，
 * 保留长 ID/重试/禁用原因证据（evidence-index #37「部分详情提示和恢复动作可达」）。
 *
 * 判据口径：
 * - ownOnly 标本 = 隔离链（root + 隔离 fork 子）+ u6-lineage-faults ancestorMissing（u6-66 同款）；
 *   注入整 tag 保持、ACTIVE 注册表崩 安全（u6-67 纪律）。
 * - 提示块 DOM：`[data-lineage-incomplete="true"]`（步骤页 + 文件页共用 DetailNotices）、
 *   概览 `[data-source-incomplete="true"]`、缺失 ID 在 `.break-all .font-code`、
 *   复制按钮 `aria-label="复制缺失祖先 run ID（<id>）"`（4.11 的静态形状逐条实机化）。
 * - 「不断版」= 页面无横向溢出（documentElement.scrollWidth ≤ clientWidth+1）且提示块自身
 *   scrollWidth ≤ clientWidth+1（200% 与 800px 两条最窄档是主战场）。
 * - 改窗走 .workbuddy/ps-win.ps1（SW_RESTORE + MoveWindow；外框→CSS 近似映射，按实测比例反解收敛）；
 *   真键盘走 lib/u3-65-input.ps1（keybd_event 系统级；只发 TAB/SHIFT+TAB/ENTER，不涉 IME 组合）。
 * - 200% 组需要 dev 启动 env `REBASEAGENT_ZOOM_FACTOR=2` ⇒ 由 run-all 分组编排（组 2）。
 *
 * 用法：`node apps/desktop/scripts/u6-68-cdp.cjs --tag=<TAG>`（前置 dev 由 run-all 起）
 */
"use strict";
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawn } = require("node:child_process");
const H = require("./lib/u4-smoke-harness.cjs");
const faults = require("./lib/u6-lineage-faults.cjs");

const TAGS = ["widths-1440-1024-800", "zoom200", "real-keyboard"];
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag");
if (!TAGS.includes(TAG)) {
  console.error(`用法：--tag=<${TAGS.join("|")}>`);
  process.exit(2);
}

const OUT_DIR = join(H.REPO, ".workbuddy", "u6", "u6-68");
const SHOT_DIR = join(OUT_DIR, "shots");
const MARK = "U6-68";
const PS_WIN = join(H.REPO, ".workbuddy", "ps-win.ps1");
const INPUT_PS1 = join(H.REPO, "apps", "desktop", "scripts", "lib", "u3-65-input.ps1");
const MANIFEST = join(H.REPO, ".workbuddy", "u3", "u3-61", "manifest.json");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });
if (!existsSync(PS_WIN)) throw new Error(`缺改窗脚本 ${PS_WIN}`);
if (!existsSync(INPUT_PS1)) throw new Error(`缺真键盘脚本 ${INPUT_PS1}`);
if (!existsSync(MANIFEST)) throw new Error(`缺夹具 manifest（${MANIFEST}）`);
const FX = JSON.parse(readFileSync(MANIFEST, "utf8"));

const TOOL_TURN = {
  toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"a.txt"}' }],
};
const OK_TURN = { content: `${MARK} 受控成功：一步答完。`, usage: { in: 120, out: 40 } };
const TAG_SCRIPT = {
  // 普通 fork 子消费 1 个 turn（重放从 normalRun 的 s_03 出发的首次 llm.call）
  "widths-1440-1024-800": { turns: [OK_TURN] },
  zoom200: { turns: [OK_TURN] },
  "real-keyboard": { turns: [TOOL_TURN, OK_TURN, OK_TURN] },
};

const REASON_LINE = "源记录不可用：重新读取并校验通过前不能发起新执行";
const WIDTHS = [1440, 1024, 800];

// ---------------------------------------------------------------------------
// 检查与落盘
// ---------------------------------------------------------------------------

const checks = [];
const dump = {};
function check(name, ok, detail) {
  checks.push({ tag: TAG, name, ok: ok === true, detail: detail ?? null });
  const shown =
    detail === undefined || detail === null
      ? ""
      : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  console.log(`${ok === true ? "✓" : "✗"} ${name}${ok === true ? "" : shown}`);
}
function sha12(file) {
  try {
    return require("node:crypto")
      .createHash("sha256")
      .update(readFileSync(file))
      .digest("hex")
      .slice(0, 12);
  } catch {
    return "unknown";
  }
}
function headShort() {
  try {
    const head = readFileSync(join(H.REPO, ".git", "HEAD"), "utf8").trim();
    const m = head.match(/^ref: (.+)$/);
    if (m) {
      const refFile = join(H.REPO, ".git", ...m[1].split("/"));
      if (existsSync(refFile)) return readFileSync(refFile, "utf8").trim().slice(0, 7);
    }
    return head.slice(0, 7);
  } catch {
    return "unknown";
  }
}
function finish(extraMeta = {}) {
  const failed = checks.filter((c) => !c.ok);
  drainActive(TAG);
  const meta = {
    head: headShort(),
    node: process.version,
    scriptSha: {
      "u6-lineage-faults.cjs": sha12(
        join(H.REPO, "apps/desktop/scripts/lib/u6-lineage-faults.cjs"),
      ),
      "ps-win.ps1": sha12(PS_WIN),
      "u3-65-input.ps1": sha12(INPUT_PS1),
      "u4-smoke-harness.cjs": sha12(join(H.REPO, "apps/desktop/scripts/lib/u4-smoke-harness.cjs")),
    },
    tracesCount: H.traceIds().size,
    ...extraMeta,
  };
  writeFileSync(
    join(OUT_DIR, `${TAG}-measurements.json`),
    JSON.stringify({ tag: TAG, meta, checks, failed: failed.length, dump }, null, 2),
  );
  console.log(`检查 ${checks.length} 条，失败 ${failed.length} 条；meta=${JSON.stringify(meta)}`);
  clearTimeout(watchdog);
  process.exit(failed.length === 0 ? 0 : 1);
}
const watchdog = setTimeout(() => {
  console.error(`看门狗：${TAG} 超过 12 分钟未收尾 ⇒ 判失败退出`);
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), "watchdog timeout");
  drainActive(TAG);
  process.exit(3);
}, 720_000);

// ---------------------------------------------------------------------------
// 注入句柄崩 安全（u6-67 纪律）
// ---------------------------------------------------------------------------

const ACTIVE = [];
function safeBeginLineageFault(arg) {
  const handle = faults.beginLineageFault(arg, "ancestorMissing");
  ACTIVE.push(handle);
  return {
    end: () => {
      const i = ACTIVE.indexOf(handle);
      if (i >= 0) ACTIVE.splice(i, 1);
      return handle.end();
    },
  };
}
function drainActive(why) {
  while (ACTIVE.length > 0) {
    const h = ACTIVE.pop();
    try {
      const end = h.end();
      console.error(`[兜底还原:${why}] ${end.clean === true ? "干净" : "有残留"}`);
    } catch (e) {
      console.error(`[兜底还原:${why}] 失败：${String(e)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 读数与动作（u6-66/67 同款）
// ---------------------------------------------------------------------------

async function envOf(call, path, payload) {
  const raw = await H.apiCall(call, path, payload);
  if (raw?.ok !== true) {
    throw new Error(`${path} 信封非 ok：${JSON.stringify(raw?.error ?? raw).slice(0, 300)}`);
  }
  return raw.data;
}
async function execRaw(call, path, request) {
  const st = await H.apiCall(call, "operationsStatus", null);
  const epoch = st?.data?.epoch;
  if (typeof epoch !== "string") throw new Error("拿不到 main epoch");
  return H.appImport(
    call,
    H.STORE_NEEDLE,
    `const env = await window.api.${path}({ operation: { epoch: ${JSON.stringify(epoch)}, operationId: crypto.randomUUID() }, request: ${JSON.stringify(request)} });
     return JSON.stringify(env);`,
  );
}
function execOfEnvelope(env) {
  if (env?.ok !== true)
    throw new Error(`执行信封非 ok：${JSON.stringify(env?.error ?? env).slice(0, 300)}`);
  return env.data;
}
async function seedRun(call, { userMessage, workspace }) {
  const data = execOfEnvelope(
    await execRaw(call, "createRun", {
      systemPrompt: "你是简洁的受控助手。",
      userMessage,
      ...(workspace === undefined ? {} : { workspace }),
    }),
  );
  const id = data.id;
  const deadline = Date.now() + 60000;
  for (;;) {
    const env = await H.apiCall(call, "getRun", id);
    if (env?.ok === true && env.data?.status === "completed") break;
    if (Date.now() > deadline) throw new Error(`run ${id} 60s 未封存`);
    await H.sleep(500);
  }
  return id;
}
function traceLines(id) {
  return readFileSync(join(H.TRACES, `${id}.jsonl`), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
function toolSpanOf(id) {
  const span = traceLines(id).find((l) => l.type === "span" && l.kind === "tool.invoke");
  if (span === undefined) throw new Error(`run ${id} 没有 tool.invoke span`);
  return span.id;
}
function llmSpanOf(id) {
  const span = traceLines(id).find((l) => l.type === "span" && l.kind === "llm.call");
  if (span === undefined) throw new Error(`run ${id} 没有 llm.call span`);
  return span.id;
}
/** 造 ownOnly 标本（普通 fork）：normalRun 的普通 result fork 子 + 隐藏 normalRun。
 * ⚠️ 不用隔离链：隔离 run 的 llm span 上 prompt/A-B 入口被「隔离父本说明」整体替换
 *（DetailPanel isolatedParentExecutionNotice）⇒ 禁用原因行只在普通 fork 子上渲染（首跑坐实）。 */
async function seedOwnOnlySpecimen(call) {
  const child = execOfEnvelope(
    await execRaw(call, "forkRun", {
      parentRunId: FX.normalRun,
      atSpanId: "s_03",
      edit: { field: "result", value: `${MARK} 受控编辑` },
    }),
  ).id;
  const deadline = Date.now() + 60000;
  for (;;) {
    const env = await H.apiCall(call, "getRun", child);
    if (env?.ok === true && env.data?.status === "completed") break;
    if (Date.now() > deadline) throw new Error(`子 run ${child} 60s 未封存`);
    await H.sleep(500);
  }
  const injection = safeBeginLineageFault({
    tracesDir: H.TRACES,
    childRunId: child,
    ancestorRunId: FX.normalRun,
  });
  dump.specimen = { root: FX.normalRun, child };
  return { root: FX.normalRun, child, injection };
}
/** store 级选中（窄档/200% 下导航收起 ⇒ 不走 DOM 行） */
async function selectRunAnywhere(call, runId) {
  const cur = await H.storeQ(call, "return JSON.stringify({ sel: s.selectedRunId });");
  if (cur.sel === runId) return true;
  await H.storeQ(
    call,
    `await s.selectRun(${JSON.stringify(runId)});
     return JSON.stringify({ sel: s.selectedRunId });`,
  );
  await H.sleep(1200);
  const after = await H.storeQ(call, "return JSON.stringify({ sel: s.selectedRunId });");
  return after.sel === runId;
}
const bodyText = (call) => H.ev(call, "(() => document.body.innerText)()");
/** 防御：设置模态若被误开（title 筛选陷阱的遗留态）⇒ 点 ✕ 关闭；绝不碰「保存」 */
async function closeSettingsIfOpen(call) {
  const open = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => x.offsetParent !== null && ((x.textContent || '').trim()) === '✕');
      return b !== undefined; })()`,
  );
  if (open === true) {
    await H.ev(
      call,
      `(() => { Array.from(document.querySelectorAll('button'))
          .find(x => x.offsetParent !== null && ((x.textContent || '').trim()) === '✕').click(); return true; })()`,
    );
    await H.sleep(800);
  }
}

// ---------------------------------------------------------------------------
// 系统通道：改窗（ps-win.ps1）与真键盘（u3-65-input.ps1）—— node 直 spawn（u5-68 同款）
// ---------------------------------------------------------------------------

function runPs1(script, args) {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let out = "";
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.stderr.on("data", (d) => {
      out += String(d);
    });
    child.on("close", () => resolve(out.trim()));
    child.on("error", (e) => resolve(String(e)));
  });
}
let PS_SEQ = 0;
let MAIN_PID = 0;
function parseLines(text) {
  const out = {};
  for (const l of String(text ?? "").split(/\r?\n/)) {
    const i = l.indexOf("=");
    if (i < 0) continue;
    out[l.slice(0, i)] = l.slice(i + 1);
  }
  return out;
}
/** u3-65-input.ps1 的回执行写在 OutFile（stdout 只有 lines=N）⇒ 读文件并剥 BOM */
async function inputPs(action, extra = []) {
  PS_SEQ += 1;
  const outFile = join(OUT_DIR, `input-${process.pid}-${PS_SEQ}.txt`);
  await runPs1(INPUT_PS1, [
    "-Action",
    action,
    "-ProcId",
    String(MAIN_PID),
    "-OutFile",
    outFile,
    ...extra,
  ]);
  let txt = "";
  try {
    txt = readFileSync(outFile, "utf8");
    if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
  } catch {
    txt = "";
  }
  return parseLines(txt);
}
async function setWindowSize(outerW, outerH, forceRestore = false) {
  const args = ["-OuterWidth", String(outerW), "-OuterHeight", String(outerH)];
  if (forceRestore) args.push("-ForceRestore");
  return runPs1(PS_WIN, args);
}
/**
 * 改窗到目标 CSS 宽度：外框→CSS 近似映射，按实测比例反解收敛（u5-68 同款）。
 * 首轮带 -ForceRestore：Windows 11 Snap 吸附（非 IsZoomed）会让 MoveWindow 静默无效
 *（6.8 坐实：css 钉死 1210、外框反解发散到 4852）。
 */
async function resizeToCssWidth(call, cssTarget, outerHeight = 1050) {
  let outer = Math.round(cssTarget * 1.412);
  let last = "";
  let cssWidth = null;
  const attempts = [];
  for (let i = 0; i < 5; i++) {
    last = await setWindowSize(outer, outerHeight, i === 0);
    await H.sleep(700);
    cssWidth = await H.ev(call, "(() => document.documentElement.clientWidth)()");
    attempts.push({ outer, cssWidth, ps: last });
    if (typeof cssWidth === "number" && Math.abs(cssWidth - cssTarget) <= 2) {
      return { cssWidth, outerWidth: outer, settled: true, attempts };
    }
    if (typeof cssWidth !== "number" || cssWidth <= 0) break;
    outer = Math.max(400, Math.round(cssTarget / (cssWidth / outer)));
  }
  return { cssWidth, outerWidth: outer, settled: false, attempts };
}
async function resolveMainPid() {
  const info = await inputPs("resolve");
  const n = Number(info["main-pid"]);
  MAIN_PID = Number.isInteger(n) && n > 0 ? n : 0;
  return { pid: MAIN_PID, info };
}
async function realKeys(tokens, { raise = "1", gapMs = 90 } = {}) {
  const info = await inputPs("keys", ["-Send", tokens, "-Raise", raise, "-GapMs", String(gapMs)]);
  if (info.RESULT === undefined || !String(info.RESULT).includes("sent")) {
    throw new Error(`真键盘发送失败：${JSON.stringify(info).slice(0, 200)}`);
  }
  await H.sleep(500);
  return info;
}
async function raiseForeground() {
  return inputPs("fg");
}

// ---------------------------------------------------------------------------
// ownOnly 提示块的实机读数（宽度/缩放无关的同构判据）
// ---------------------------------------------------------------------------

/** 提示块与复制按钮的几何/可访问性读数 */
const noticeRead = (call) =>
  H.ev(
    call,
    `(() => {
      const block = document.querySelector('[data-lineage-incomplete="true"]');
      if (block === null) return JSON.stringify({ present: false });
      const idEl = block.querySelector('.font-code');
      const btn = block.querySelector('button[aria-label^="复制缺失祖先 run ID"]');
      const de = document.documentElement;
      return JSON.stringify({
        present: true,
        text: (block.textContent || '').slice(0, 200),
        missingId: idEl ? (idEl.textContent || '').trim() : null,
        breakAll: idEl !== null && (idEl.closest('.break-all') !== null),
        pageOverflowX: de.scrollWidth - de.clientWidth,
        blockOverflowX: block.scrollWidth - block.clientWidth,
        btn: btn === null ? null : {
          tag: btn.tagName, disabled: btn.disabled,
          aria: btn.getAttribute('aria-label') || '',
          visible: btn.offsetParent !== null,
        },
      });
    })()`,
  );
const noticeParse = (raw) => (typeof raw === "string" ? JSON.parse(raw) : raw);
/** span 点击（scope 限定版）：H.clickSpan 的 title 筛选会先命中 GlobalBar「运行配置」
 *（title 含「配置 LLM 接入…」）⇒ 设置模态被静默打开（UI-VERIFY 登记坑，zoom200 复发）⇒
 * 排除 header 内按钮 + 以 store 选中态落地为准。 */
async function clickSpanScoped(call, titleFragment, spanId) {
  const listExpr = `(() => JSON.stringify(Array.from(document.querySelectorAll('button'))
      .filter(b => (b.title || '').includes(${JSON.stringify(titleFragment)}))
      .filter(b => b.closest('header') === null)
      .map((b, i) => ({ i, visible: b.offsetParent !== null }))))()`;
  const rows = JSON.parse(await H.ev(call, listExpr));
  for (const { i, visible } of rows) {
    if (!visible) continue;
    await H.ev(
      call,
      `(() => { const rows = Array.from(document.querySelectorAll('button'))
          .filter(b => (b.title || '').includes(${JSON.stringify(titleFragment)}))
          .filter(b => b.closest('header') === null);
        rows[${i}].click(); return true; })()`,
    );
    await H.sleep(900);
    const sel = await H.storeQ(call, "return JSON.stringify({ span: s.selectedSpanId });");
    if (sel.span === spanId) return true;
  }
  throw new Error(
    `span 选中未落地（${titleFragment}, 期望 ${spanId}）：${JSON.stringify(rows).slice(0, 200)}`,
  );
}
/** 禁用原因行读数：选中子 run 的 llm span 后，就近资格原因须在场（5.12 的实机形状） */
async function reasonLineVisible(call, child, llmSpan) {
  // 窄档/200% 下步骤目录会自动折叠 ⇒ span 详情区（含执行入口与禁用原因）不渲染
  //（zoom200 首跑坐实：span 已选中但入口区整个缺席）⇒ 先重开目录再选 span
  await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => x.offsetParent !== null && ((x.textContent || '').includes('重新打开步骤目录')));
      if (b) b.click(); return true; })()`,
  );
  await H.sleep(900);
  await clickSpanScoped(call, "LLM", llmSpan);
  await H.sleep(1200);
  await closeSettingsIfOpen(call);
  const deadline = Date.now() + 8000;
  let body = await bodyText(call);
  if (!body.includes(REASON_LINE)) {
    // 兜底：点 prompt fork 入口（含「重跑」字样的可见按钮）打开编辑器
    await H.ev(
      call,
      `(() => { const b = Array.from(document.querySelectorAll('button'))
          .filter(x => x.offsetParent !== null && !x.disabled)
          .find(x => ((x.textContent || '').includes('重跑') && (x.textContent || '').includes('编辑')));
        if (b) b.click(); return true; })()`,
    );
    await H.sleep(1200);
  }
  if (!body.includes(REASON_LINE)) {
    // ⚠️ guard.reason 先于来源原因（6.5 坐实）：编辑器刚打开、草稿未改动 ⇒
    //    就近原因是「与父 run 完全相同」，轮不到「源记录不可用」⇒ 先键入 Monaco 再判
    try {
      await H.typeIntoEditableMonaco(call, `${MARK} 来源原因判据前键入`);
      await H.sleep(800);
    } catch {
      /* 无可编辑 monaco：保持 body 原样走轮询 */
    }
  }
  for (;;) {
    body = await bodyText(call);
    if (body.includes(REASON_LINE)) return { ok: true, via: "body" };
    if (Date.now() > deadline) {
      dump[`reason-diag-${llmSpan}`] = {
        sel: await H.storeQ(
          call,
          "return JSON.stringify({ sel: s.selectedRunId, span: s.selectedSpanId, c: s.detail?.completeness ?? null });",
        ).catch(() => null),
        treeCollapsed: await H.ev(
          call,
          `(() => { const b = Array.from(document.querySelectorAll('button'))
              .find(x => x.offsetParent !== null && ((x.textContent || '').includes('重新打开步骤目录')));
            return b !== undefined; })()`,
        ).catch(() => null),
        buttons: await H.ev(
          call,
          `(() => JSON.stringify(Array.from(document.querySelectorAll('button'))
            .filter(b => b.offsetParent !== null)
            .map(b => (b.textContent || '').trim()).filter(Boolean).slice(0, 40)))()`,
        ).catch(() => null),
        bodyTail: (await bodyText(call)).slice(-400),
      };
      return { ok: false };
    }
    await H.sleep(400);
  }
}
/** 单档宽度的完整判据组（ownOnly 在场前提下） */
async function checkNoticeAt(call, label, { child, root, llmSpan }) {
  // 步骤页提示块
  await H.clickTabChecked(call, "步骤");
  await H.sleep(600);
  const n = noticeParse(await noticeRead(call));
  check(`[${label}] ownOnly 提示块在场（步骤页）`, n.present === true, n);
  if (n.present !== true) return;
  check(
    `[${label}] 固定文案在场（未知/不补零口径）`,
    (n.text ?? "").includes("不补零") && (n.text ?? "").includes("未知"),
    n.text?.slice(0, 80),
  );
  check(`[${label}] 缺失 ID 文本 = 注入的祖先 run`, n.missingId === root, {
    got: n.missingId,
    want: root,
  });
  check(`[${label}] 缺失 ID 走 break-all`, n.breakAll === true, n.breakAll);
  check(`[${label}] 页面无横向溢出（不断版）`, (n.pageOverflowX ?? 99) <= 1, {
    page: n.pageOverflowX,
    block: n.blockOverflowX,
  });
  check(`[${label}] 提示块自身无横向溢出`, (n.blockOverflowX ?? 99) <= 1, n.blockOverflowX);
  check(
    `[${label}] 复制动作是真按钮（tag/aria/disabled/可见）`,
    n.btn !== null &&
      n.btn.tag === "BUTTON" &&
      n.btn.disabled === false &&
      n.btn.visible === true &&
      n.btn.aria.includes(root),
    n.btn,
  );
  await H.shot(call, SHOT_DIR, `${TAG}-${label}-steps.png`);

  // 文件页提示块同源——普通 fork 子代没有「文件」页签（工作区仅隔离 run 有，U1 分支）：
  // 该面由 6.4 的隔离链证据（isolated-ownonly-files）承载，这里如实记录跳过原因
  const hasFileTab = await H.ev(
    call,
    `(() => Array.from(document.querySelectorAll('[role="tab"]'))
       .some(t => t.offsetParent !== null && ((t.textContent || '').trim()) === '文件'))()`,
  );
  if (hasFileTab) {
    await H.clickTabChecked(call, "文件");
    await H.sleep(800);
    const nf = noticeParse(await noticeRead(call));
    check(`[${label}] ownOnly 提示块在场（文件页同源）`, nf.present === true, nf.present);
    await H.clickTabChecked(call, "步骤");
    await H.sleep(600);
  } else {
    dump[`files-tab-skip-${label}`] =
      "普通 fork 子代无文件页签（工作区仅隔离 run 有）⇒ 文件页提示块由 6.4 isolated-ownonly-files 证据承载";
  }

  // 禁用原因行（5.12 实机形状）
  await H.clickTabChecked(call, "步骤");
  await H.sleep(600);
  const reason = await reasonLineVisible(call, child, llmSpan);
  check(
    `[${label}] 禁用原因行可读（源记录不可用…）`,
    reason.ok === true,
    reason.ok ? null : dump[`reason-diag-${llmSpan}`],
  );

  // 重读在当前宽度可用：切走切回 ⇒ ownOnly 再落地（读取重试不改阅读位置）
  await selectRunAnywhere(call, child);
  await H.sleep(400);
  const posBefore = await H.storeQ(
    call,
    "return JSON.stringify({ sel: s.selectedRunId, span: s.selectedSpanId, tab: s.readingOf(s.selectedRunId)?.tab ?? null });",
  );
  const awayId =
    (await H.storeQ(
      call,
      `return JSON.stringify(s.runs.map(r => r.id).filter(id => id !== ${JSON.stringify(child)})[0] ?? null);`,
    )) ?? null;
  if (typeof awayId === "string") {
    await selectRunAnywhere(call, awayId);
    await H.sleep(900);
    await selectRunAnywhere(call, child);
    await H.sleep(1500);
  }
  const landed = await H.storeQ(
    call,
    "return JSON.stringify({ c: s.detail?.completeness ?? null });",
  );
  const posAfter = await H.storeQ(
    call,
    "return JSON.stringify({ sel: s.selectedRunId, span: s.selectedSpanId, tab: s.readingOf(s.selectedRunId)?.tab ?? null });",
  );
  check(`[${label}] 重读落地仍 ownOnly（恢复动作在此宽度可用）`, landed.c === "ownOnly", landed);
  check(
    `[${label}] 重读不改阅读位置（选中/页签）`,
    posAfter.sel === posBefore.sel && posAfter.tab === posBefore.tab,
    { before: posBefore, after: posAfter },
  );
}

// ---------------------------------------------------------------------------
// 各 tag
// ---------------------------------------------------------------------------

const FLOWS = {
  /** 1440 / 1024 / 800 三档：ownOnly 提示与恢复动作全程可达 */
  "widths-1440-1024-800": async (call) => {
    await H.storeQ(call, "await s.loadRuns(); return JSON.stringify({ n: s.runs.length });");
    const { root, child, injection } = await seedOwnOnlySpecimen(call);
    await selectRunAnywhere(call, child);
    await H.sleep(1500);
    for (const w of WIDTHS) {
      const r = await resizeToCssWidth(call, w);
      check(`[${w}] 改窗收敛到目标 CSS 宽度（±2px）`, r.settled === true, r);
      const dpr = await H.ev(call, "(() => window.devicePixelRatio)()");
      check(`[${w}] DPR 保持基线 2.1（无 zoom 泄漏）`, Math.abs(dpr - 2.1) < 0.3, dpr);
      await checkNoticeAt(call, String(w), { child, root, llmSpan: llmSpanOf(child) });
    }
    const end = injection.end();
    check("ancestorMissing 注入逐字节还原", end.clean === true, end.diff);
  },

  /** 独立 200%（REBASEAGENT_ZOOM_FACTOR=2 的 dev 组）：最窄实战档 */
  zoom200: async (call) => {
    const dpr = await H.ev(call, "(() => window.devicePixelRatio)()");
    check("200% 缩放生效（DPR > 3.5 金标准）", dpr > 3.5, dpr);
    const cssWidth = await H.ev(call, "(() => document.documentElement.clientWidth)()");
    dump.viewport = { dpr, cssWidth };
    await H.storeQ(call, "await s.loadRuns(); return JSON.stringify({ n: s.runs.length });");
    const { root, child, injection } = await seedOwnOnlySpecimen(call);
    await selectRunAnywhere(call, child);
    await H.sleep(1500);
    await checkNoticeAt(call, "zoom200", { child, root, llmSpan: llmSpanOf(child) });
    const end = injection.end();
    check("ancestorMissing 注入逐字节还原", end.clean === true, end.diff);
  },

  /** 真键盘（keybd_event 系统级）：Tab 可达复制按钮、Enter 激活、Shift+Tab 双向 */
  "real-keyboard": async (call) => {
    const resolved = await resolveMainPid();
    check("已唯一认定 dev 主进程 PID（真键盘通道前置）", resolved.pid > 0, resolved.info);
    const fg = await raiseForeground();
    check("前置：主窗口真实在前台", String(fg.foreground ?? "").includes("same=True"), fg);
    dump.ime = { hkl: fg.hkl ?? null, immOpen: fg["imm-open"] ?? null };

    // 诊断：fg 动作后的首个 storeQ 曾返回 undefined（appImport 非法 JSON）——捕获原始 CDP 回包
    try {
      await H.storeQ(call, "await s.loadRuns(); return JSON.stringify({ n: s.runs.length });");
    } catch (e) {
      const raw = await call("Runtime.evaluate", {
        expression: `(async () => {
          const all = performance.getEntriesByType('resource').map(x => x.name);
          const urls = all.filter(n => n.includes('/src/renderer/src/store.ts') || n.includes('/src/store.ts'));
          if (urls.length === 0) return JSON.stringify({ diag: 'no-module-url', resources: all.length });
          const m = await import(urls[0]);
          return JSON.stringify({ diag: 'ok', hasStore: m.useAppStore !== undefined,
            runsLen: m.useAppStore.getState().runs.length,
            url: urls[0].slice(-60) });
        })()`,
        returnByValue: true,
        awaitPromise: true,
      });
      dump.storeQDiag = { error: String(e?.message ?? e).slice(0, 200), raw: raw ?? null };
      throw e;
    }
    const { root, child, injection } = await seedOwnOnlySpecimen(call);
    await selectRunAnywhere(call, child);
    await H.sleep(1500);
    await H.clickTabChecked(call, "步骤");
    await H.sleep(800);
    const n = noticeParse(await noticeRead(call));
    check("前置：ownOnly 提示块在场", n.present === true, n);
    if (n.present !== true) throw new Error("提示块不在场，键盘判据无从谈起");

    // 焦点放到提示块之前的已知元素（页签栏），从那里真 Tab 走到复制按钮
    await H.ev(
      call,
      `(() => { const t = Array.from(document.querySelectorAll('[role="tab"]'))
          .find(x => x.offsetParent !== null); if (t) t.focus(); return true; })()`,
    );
    let arrived = null;
    for (let i = 0; i < 40; i++) {
      await realKeys("TAB", { raise: "0" });
      const a = await H.ev(
        call,
        `(() => { const e = document.activeElement; return e === null ? null
            : JSON.stringify({ tag: e.tagName, aria: e.getAttribute('aria-label') ?? '',
                               text: (e.textContent || '').trim().slice(0, 30) }); })()`,
      );
      const p = typeof a === "string" ? JSON.parse(a) : a;
      if (p !== null && String(p.aria).startsWith("复制缺失祖先 run ID")) {
        arrived = { steps: i + 1, ...p };
        break;
      }
    }
    check("真 Tab 可达复制按钮（有界步数内）", arrived !== null, arrived ?? "40 步未到达");
    if (arrived !== null) {
      check(
        "落点是真按钮且读屏可辨（aria 带缺失 ID）",
        arrived.tag === "BUTTON" && arrived.aria.includes(root),
        arrived,
      );
      const selBefore = await H.storeQ(call, "return JSON.stringify({ sel: s.selectedRunId });");
      await realKeys("ENTER", { raise: "0" });
      const selAfter = await H.storeQ(call, "return JSON.stringify({ sel: s.selectedRunId });");
      check("真 Enter 激活复制（选中不变、无异常跳转）", selAfter.sel === selBefore.sel, {
        before: selBefore,
        after: selAfter,
      });
      // 剪贴板回读（首跑坐实：Electron 渲染层 readText 在权限未决时**永不 resolve** ⇒
      // evAsync 挂死 600s 超时）⇒ 页内 Promise.race 限时 3s，读不到就如实降级
      try {
        const clipRaw = await H.evAsync(
          call,
          `(() => Promise.race([
             navigator.clipboard.readText().then(t => JSON.stringify({ ok: true, text: t })),
             new Promise(r => setTimeout(() => JSON.stringify({ ok: false, why: 'clipboard-timeout' }), 3000)),
           ]))()`,
        );
        const clip = typeof clipRaw === "string" ? JSON.parse(clipRaw) : clipRaw;
        if (clip?.ok === true) {
          check("剪贴板内容 = 完整缺失 ID", clip.text === root, {
            clip: String(clip.text).slice(0, 40),
          });
        } else {
          dump.clipboard =
            "回读 3s 未决（权限）——复制判据以 focus+activation 为准，不冒充已验证剪贴板内容";
          console.log(`ℹ ${dump.clipboard}`);
        }
      } catch (e) {
        dump.clipboard = `回读异常：${String(e).slice(0, 120)}——复制判据以 focus+activation 为准`;
        console.log(`ℹ ${dump.clipboard}`);
      }
      // 反向：Shift+Tab 离开再 Tab 回来仍可达（双向）
      await realKeys("SHIFT+TAB", { raise: "0" });
      await realKeys("TAB", { raise: "0" });
      const back = await H.ev(
        call,
        `(() => { const e = document.activeElement; return e === null ? null
            : JSON.stringify({ aria: e.getAttribute('aria-label') ?? '' }); })()`,
      );
      const bp = typeof back === "string" ? JSON.parse(back) : back;
      check(
        "Shift+Tab 离开再 Tab 仍回到复制按钮（双向可达）",
        String(bp?.aria ?? "").startsWith("复制缺失祖先 run ID"),
        bp,
      );
    }
    await H.shot(call, SHOT_DIR, `${TAG}-keyboard.png`);
    const end = injection.end();
    check("ancestorMissing 注入逐字节还原", end.clean === true, end.diff);
  },
};

// ---------------------------------------------------------------------------

async function main() {
  const page = await H.cdpConnect(H.CDP_PORT);
  const call = await H.makeDialogSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.clearDeviceMetricsOverride").catch(() => {});

  await call("Page.reload", { ignoreCache: true });
  let runsReady = false;
  for (let i = 0; i < 60; i++) {
    await H.sleep(500);
    try {
      const cnt = await H.storeQ(call, "return JSON.stringify(s.runs.length);");
      if (cnt > 0) {
        runsReady = true;
        break;
      }
    } catch {
      /* 重载瞬间 */
    }
  }
  if (!runsReady) throw new Error("重载后 30s 运行列表仍未就绪（store.runs 为空）");
  const dpr = await H.ev(call, "(() => window.devicePixelRatio)()");
  if (TAG !== "zoom200" && Math.abs(dpr - 2.1) > 0.3) {
    throw new Error(`DPR=${dpr} ≠ 2.1 基线——疑有 zoom 残留（per_host_zoom_levels），先复位再跑`);
  }
  await H.sleep(900);

  const mock = await H.prepare(call, TAG_SCRIPT[TAG]);
  try {
    await FLOWS[TAG](call, mock);
  } catch (e) {
    drainActive(TAG);
    check(`tag 执行异常：${String(e?.message ?? e).slice(0, 300)}`, false);
  } finally {
    await H.teardown(call, mock);
  }
  finish();
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), String(e?.stack ?? e));
  drainActive(TAG);
  process.exit(1);
});
