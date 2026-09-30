/* eslint-disable */
/**
 * U6 任务 6.7（第四批受控实机）：U5 操作结果提示、失败定位与手动重试，落在 ownOnly 来源上。
 *
 * 覆盖 evidence-index 待实机场景：
 * - #33 ownOnly 正常结果仍按原修订清理（ownonly-closure 前半）；
 * - #27 读取重试与执行严格分离（重试按钮 → 仅 runs:get + ownOnly ⇒ canExecuteFromSource false）；
 * - #36 后台重试不导航也不重发执行（36a 不可读→ownOnly 正常重试清理 + 36b 修订推进不删）；
 * - #34 ownOnly 失败定位只使用自有调用（ownonly-failure）；
 * - #35 部分实验结果保留完整批次判据（ab-ownonly：两臂 ownOnly 正常 ⇒ 清理；一臂错误 ⇒ 保留；
 *   缺臂/null ID/不可读真机不可达 ⇒ store 集成承载并注明）；
 * - #17 读取重试不改变阅读位置（retry-position：ownOnly→恢复→complete 三态切换中阅读位置保持；
 *   在飞交叠半边真机无延时注入面 ⇒ 单元承载并注明）。
 *
 * 判据口径：
 * - 竞速注入：终态落盘瞬间隐藏文件（U5 6.6 纪律：fs.watch + 1ms 忙轮询，基线集合在提交前采样）。
 *   本批两种用法：隐藏「新子 run」造不可读首读；隐藏「父本 run」让核实读到 ownOnly。
 * - 注入一律走 lib/u5-read-faults.cjs（施加 → 还原 → 逐字节指纹核验）；期望调用数从实际
 *   mock.served() 增量读出（每个子 run / 每臂恰一次调用）。
 * - ownOnly 判据 = 读取项 lineage.status=incomplete + missingRunId=父本 id + facts 来自自有事件。
 *
 * 用法：`node apps/desktop/scripts/u6-67-cdp.cjs --tag=<TAG>`（前置 dev 由 run-all 起）
 */
"use strict";
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");
const { beginReadFault, diffFingerprints } = require("./lib/u5-read-faults.cjs");

const TAGS = ["ownonly-closure", "ownonly-failure", "rev-preserves", "ab-ownonly", "retry-position"];
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag");
if (!TAGS.includes(TAG)) {
  console.error(`用法：--tag=<${TAGS.join("|")}>`);
  process.exit(2);
}

const OUT_DIR = join(H.REPO, ".workbuddy", "u6", "u6-67");
const SHOT_DIR = join(OUT_DIR, "shots");
const MARK = "U6-67";
const MANIFEST = join(H.REPO, ".workbuddy", "u3", "u3-61", "manifest.json");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });
if (!existsSync(MANIFEST)) throw new Error(`缺夹具 manifest（${MANIFEST}）`);
const FX = JSON.parse(readFileSync(MANIFEST, "utf8"));
/** 父本 = u3 夹具的文件助手 run（工具表非空 ⇒ 可作 fork 父本；首 LLM span = s_02，工具 span = s_03） */
const PARENT = FX.normalRun;
const PARENT_SPAN = "s_02";
const TOOL_SPAN = "s_03";
const AWAY = FX.isoRoot; // 切走用的对照 run（不新增 run，保证调用数口径干净）
const DKEY = `({ runId: ${JSON.stringify(PARENT)}, spanId: ${JSON.stringify(PARENT_SPAN)} })`;
const AB_SUB_KEY = `${PARENT}|${PARENT_SPAN}|model_ab`;
const forkKey = (field = "result") => `${PARENT}|${TOOL_SPAN}|${field}`;

const OK_TURN = { content: `${MARK} 受控成功：一步答完。`, usage: { in: 120, out: 40 }, delayMs: 2500 };
const OK_TURN_FAST = { content: `${MARK} 受控成功：一步答完。`, usage: { in: 120, out: 40 } };
const FAIL_TURN = { mode: "fail", status: 503, content: "上游超时（受控失败）", delayMs: 2500 };

/** 各 tag 的受控剧本（turns 按调用序消费）。
 * ⚠️ delayMs 纪律：藏「父本」的 tag 必须拉长子在飞期——mock 瞬回会把 meta→终态压进一个轮询 tick，
 * 自动核实能赶在隐藏生效前完成（首跑时序探针坐实：触发时文件已 4 行齐全、entry lineage=complete、
 * 而隐藏后直读 main 是 ownOnly）。藏「子 run 自身」的保持瞬回：终态行是最后一次写盘，
 * 触发即隐藏、其后无写入，窗口天然成立（3/3 实测）。 */
const TAG_SCRIPT = {
  "ownonly-closure": { turns: [OK_TURN, OK_TURN_FAST] },
  "ownonly-failure": { turns: [FAIL_TURN] },
  "rev-preserves": { turns: [OK_TURN_FAST] },
  "ab-ownonly": { turns: [OK_TURN, OK_TURN, OK_TURN, FAIL_TURN] },
  "retry-position": { turns: [OK_TURN] },
};
const EXPECTED_CALLS = {
  "ownonly-closure": 2,
  "ownonly-failure": 1,
  "rev-preserves": 1,
  "ab-ownonly": 4,
  "retry-position": 1,
};

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
    return require("node:crypto").createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);
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
  const meta = {
    head: headShort(),
    node: process.version,
    scriptSha: {
      "u5-read-faults.cjs": sha12(join(H.REPO, "apps/desktop/scripts/lib/u5-read-faults.cjs")),
      "mock-llm-server.cjs": sha12(join(H.REPO, "apps/desktop/scripts/mock-llm-server.cjs")),
      "u4-smoke-harness.cjs": sha12(join(H.REPO, "apps/desktop/scripts/lib/u4-smoke-harness.cjs")),
    },
    tracesCount: H.traceIds().size,
    ...extraMeta,
  };
  writeFileSync(
    join(OUT_DIR, `${TAG}-measurements.json`),
    JSON.stringify({ tag: TAG, meta, checks, failed: failed.length, dump }, null, 2),
  );
  drainActive(TAG);
  console.log(`检查 ${checks.length} 条，失败 ${failed.length} 条；meta=${JSON.stringify(meta)}`);
  clearTimeout(watchdog);
  process.exit(failed.length === 0 ? 0 : 1);
}
const watchdog = setTimeout(() => {
  console.error(`看门狗：${TAG} 超过 12 分钟未收尾 ⇒ 判失败退出`);
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), "watchdog timeout");
  process.exit(3);
}, 720_000);

// ---------------------------------------------------------------------------
// 读数（真 store / 真 IPC / 真落盘）
// ---------------------------------------------------------------------------

const opsStatus = (call) => H.apiCall(call, "operationsStatus");
const recordOf = async (call, operationId) => {
  const st = await opsStatus(call);
  const rec = (st?.data?.operations ?? []).find((o) => o.operationId === operationId) ?? null;
  return { rec, epoch: st?.data?.epoch ?? null };
};
async function waitRegistryRecordState(call, operationId, want, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const { rec } = await recordOf(call, operationId);
    last = rec;
    if (rec !== null && rec.state === want) return rec;
    if (Date.now() > deadline) return rec;
    await H.sleep(300);
  }
}
const resultReadFor = async (call, epoch, operationId, runId) => {
  const key = `${epoch}|${operationId}|${runId}`;
  const all = await H.storeQ(call, "return JSON.stringify(s.resultReads.byKey);");
  return all[key] ?? null;
};
async function waitForVerified(call, epoch, operationId, runId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entry = await resultReadFor(call, epoch, operationId, runId);
    if (entry !== null && entry.phase !== "reading") return entry;
    if (Date.now() > deadline) return entry;
    await H.sleep(400);
  }
}
/** 条目摘要：phase/attempt/lineage/normalEnd/failure 定位（ownOnly 判据的核心读数） */
const entrySummary = (entry) =>
  entry === null
    ? null
    : {
        phase: entry.phase,
        attempt: entry.attempt,
        reason: entry.reason ?? null,
        lineage: entry.lineage ?? null,
        normalEnd: entry.facts?.normalEnd ?? null,
        event: entry.facts?.event ?? null,
        failureSpan: entry.facts?.failure?.llmCallSpanId ?? null,
      };
const callDraftText = async (call, runId, spanId, field) => {
  const d = await H.drafts(call);
  return d?.calls?.[runId]?.[spanId]?.[field]?.text ?? null;
};
const callDraftRevision = async (call, runId, spanId, field) => {
  const d = await H.drafts(call);
  return d?.calls?.[runId]?.[spanId]?.[field]?.revision ?? null;
};
const closureOf = (call, epoch, operationId) =>
  H.storeQ(call, `return JSON.stringify(s.draftSubmissions.closures[${JSON.stringify(`${epoch}|${operationId}`)}] ?? null);`);
const abDraftOf = (call) => H.storeQ(call, `return JSON.stringify(s.modelAbDraftOf(${DKEY}) ?? null);`);
const readingState = (call) =>
  H.storeQ(
    call,
    `return JSON.stringify({ view: s.view, selectedRunId: s.selectedRunId,
       selectedSpanId: s.selectedSpanId, navGeneration: s.navGeneration });`,
  );
const readingOfRun = (call, runId) =>
  H.storeQ(call, `return JSON.stringify(s.readingOf(${JSON.stringify(runId)}) ?? null);`);
const canExec = (call) => H.storeQ(call, "return JSON.stringify(s.canExecuteFromSource() === true);");
const detailCompleteness = (call) =>
  H.storeQ(call, "return JSON.stringify({ sel: s.selectedRunId, c: s.detail?.completeness ?? null });");
const liveText = (call) =>
  H.ev(
    call,
    `(() => { const el = document.getElementById('result-live');
      return el === null ? null : (el.textContent || '').trim(); })()`,
  );
const bodyText = (call) => H.ev(call, "(() => document.body.innerText)()");

// ---------------------------------------------------------------------------
// 页内动作（fork 编辑器 / A/B 编辑器 / 操作面板）
// ---------------------------------------------------------------------------

async function openPlainResultEditor(call) {
  await H.selectRun(call, PARENT);
  await H.clickTabChecked(call, "步骤");
  await H.clickSpan(call, "read_file", TOOL_SPAN);
  const forkReadyExpr =
    "(() => { const b = Array.from(document.querySelectorAll('button'))" +
    ".find(x => ((x.textContent||'').trim()) === '在此重跑（时间旅行）');" +
    "return b == null ? 'no' : (b.disabled ? 'disabled' : 'ready'); })()";
  const deadline = Date.now() + 12000;
  for (;;) {
    // 保留草稿在场 ⇒ 编辑器随 span 选中自动打开（无入口按钮）；可见 Monaco 即视为就绪
    const editorOpen = await H.ev(
      call,
      "(() => { const m = document.querySelector('.monaco-editor'); return m !== null && m.offsetWidth > 50; })()",
    );
    if (editorOpen === true) return;
    const present = await H.ev(call, forkReadyExpr);
    if (present === "ready") break;
    if (Date.now() > deadline) {
      // 诊断转储：入口 12s 未就绪时的选中态/详情/候选按钮（rev-preserves 首跑的悬案）
      dump.forkEntryDiag = await H.storeQ(
        call,
        `return JSON.stringify({ sel: s.selectedRunId, span: s.selectedSpanId,
           detailNull: s.detail === null, c: s.detail?.completeness ?? null,
           frozen: s.isDraftFrozen({ runId: ${JSON.stringify(PARENT)}, spanId: ${JSON.stringify(TOOL_SPAN)}, field: "result" }) });`,
      ).catch(() => null);
      dump.forkEntryButtons = await H.ev(
        call,
        `(() => JSON.stringify(Array.from(document.querySelectorAll('button'))
          .filter(b => b.offsetParent !== null)
          .map(b => (b.textContent || '').trim())
          .filter(t => t.includes('重跑') || t.includes('草稿') || t.includes('时间旅行') || t.includes('编辑'))))()`,
      ).catch(() => null);
      throw new Error(`fork 入口 12s 未就绪：${present}`);
    }
    await H.sleep(500);
  }
  await H.clickByTextChecked(call, "在此重跑（时间旅行）", 800);
}
const visibleConfirmExpr = `(() => {
  const all = Array.from(document.querySelectorAll('[data-confirm-execution]'));
  return all.find(b => b.offsetParent !== null) ?? null;
})()`;
async function confirmEditor(call) {
  const before = await H.ev(
    call,
    `(() => { const b = ${visibleConfirmExpr};
      if (!b) return JSON.stringify({ error: 'no-visible-confirm' });
      return JSON.stringify({ disabled: b.disabled, pressed: b.getAttribute('aria-pressed') }); })()`,
  );
  const parsed = JSON.parse(before);
  if (parsed.error) throw new Error(`确认按钮缺失：${parsed.error}`);
  if (parsed.disabled !== false) throw new Error(`确认按钮不可点：${JSON.stringify(parsed)}`);
  await H.ev(call, `(() => { ${visibleConfirmExpr}.click(); return true; })()`);
  await H.sleep(500);
  const after = await H.ev(
    call,
    `(() => { const b = ${visibleConfirmExpr};
      return b === null ? null : { pressed: b.getAttribute('aria-pressed') }; })()`,
  );
  if (after?.pressed !== "true") throw new Error(`点确认后 aria-pressed=${after?.pressed}`);
}
/** 点提交并在页内同帧捕获本次关联（毫秒级响应会扑空） */
async function submitAndCapture(call, buttonText, key) {
  const r = await call("Runtime.evaluate", {
    expression: `(async () => {
      const btn = Array.from(document.querySelectorAll('button'))
        .filter(x => x.offsetParent !== null)
        .find(x => ((x.textContent||'').trim()).includes(${JSON.stringify(buttonText)}));
      if (!btn) {
        const anyVisible = Array.from(document.querySelectorAll('button'))
          .filter(x => x.offsetParent !== null)
          .find(x => ((x.textContent||'').trim()).includes(${JSON.stringify(buttonText)}));
        return JSON.stringify({ error: anyVisible ? 'button-disabled' : 'button-not-found' });
      }
      if (btn.disabled) return JSON.stringify({ error: 'button-disabled' });
      btn.click();
      const deadline = Date.now() + 9000;
      for (;;) {
        const all = performance.getEntriesByType('resource').map(e => e.name);
        const url = all.filter(n => n.includes('/src/renderer/src/store.ts') || n.includes('/src/store.ts'))[0];
        const m = await import(url);
        const s = m.useAppStore.getState();
        const x = s.draftSubmissions.byId[${JSON.stringify(key)}];
        if (x !== undefined) {
          return JSON.stringify({ operationId: x.operationId, epoch: x.epoch,
            revision: x.submittedRevision, text: x.submittedText });
        }
        if (Date.now() > deadline) return JSON.stringify({ none: true });
        await new Promise(res => setTimeout(res, 20));
      }
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r?.exceptionDetails)
    throw new Error(`submitAndCapture: ${JSON.stringify(r.exceptionDetails).slice(0, 240)}`);
  const parsed = JSON.parse(r?.result?.value ?? "{}");
  if (parsed.error) throw new Error(`提交按钮不可用：${parsed.error}`);
  return parsed;
}
/** 共用流程：打开普通 result 编辑器 → 键入 → 确认 → 提交并捕获（草稿文本自证含本轮标记） */
async function forkFlow(call, text) {
  await openPlainResultEditor(call);
  await H.typeIntoEditableMonaco(call, text);
  const draftText = await callDraftText(call, PARENT, TOOL_SPAN, "result");
  if (draftText === null || !draftText.includes(text.slice(-8)))
    throw new Error(`草稿未入 store：${String(draftText).slice(0, 60)}`);
  await confirmEditor(call);
  const sub = await submitAndCapture(call, "确认重跑", forkKey());
  if (typeof sub.operationId !== "string") throw new Error(`fork 未登记：${JSON.stringify(sub)}`);
  return sub;
}

async function openOperationsPanel(call) {
  const ok = await H.ev(
    call,
    `(() => { const b = document.querySelector('button[aria-controls="operations-panel"]');
      if (!b) return 'no-button';
      if (b.getAttribute('aria-expanded') === 'true') return 'already';
      b.click(); return 'clicked'; })()`,
  );
  if (ok !== "clicked" && ok !== "already") throw new Error(`操作入口不可用：${ok}`);
  await H.sleep(800);
  const open = await H.ev(call, `(() => document.getElementById('operations-panel') !== null)()`);
  if (open !== true) throw new Error("操作面板未打开");
}
async function closeOperationsPanel(call) {
  await H.ev(
    call,
    `(() => { document.querySelector('button[aria-label="关闭操作列表"]')?.click(); return true; })()`,
  );
  await H.sleep(600);
}
const ROW_EXPR = (opId) => `(() => {
  const panel = document.getElementById('operations-panel');
  if (panel === null) return JSON.stringify({ error: 'no-panel' });
  const lis = Array.from(panel.querySelectorAll('li')).filter(li => (li.className || '').includes('mt-1'));
  const row = lis.find(li => (li.textContent || '').includes(${JSON.stringify(opId)}));
  if (!row) return JSON.stringify({ error: 'no-row', rows: lis.length });
  return JSON.stringify({ text: (row.textContent || '').slice(0, 900),
    buttons: Array.from(row.querySelectorAll('button')).filter(b => b.offsetParent !== null)
      .map(b => ((b.textContent || '').trim())).filter(Boolean) });
})()`;
async function rowRead(call, opId) {
  const raw = await H.ev(call, ROW_EXPR(opId));
  const p = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (p.error) throw new Error(`行读数失败（${opId.slice(0, 8)}）：${JSON.stringify(p)}`);
  return p;
}
async function clickRowAction(call, opId, label, wait = 1200) {
  const r = await H.ev(
    call,
    `(() => {
      const panel = document.getElementById('operations-panel');
      if (panel === null) return 'no-panel';
      const lis = Array.from(panel.querySelectorAll('li')).filter(li => (li.className || '').includes('mt-1'));
      const row = lis.find(li => (li.textContent || '').includes(${JSON.stringify(opId)}));
      if (!row) return 'no-row';
      const btn = Array.from(row.querySelectorAll('button'))
        .find(b => ((b.textContent || '').trim()).includes(${JSON.stringify(label)}) && b.offsetParent !== null);
      if (!btn) return 'no-button';
      if (btn.disabled) return 'disabled';
      btn.click(); return 'clicked';
    })()`,
  );
  if (r !== "clicked") throw new Error(`行内点「${label}」失败（${opId.slice(0, 8)}）：${r}`);
  await H.sleep(wait);
}

// ---------------------------------------------------------------------------
// 竞速注入（触发点 = 新 run 文件出现首个已落盘 span）
// ---------------------------------------------------------------------------

/** 注入句柄注册表：任何路径退出（含异常/finish）都逐个 end，绝不把隐藏状态留给后续 tag */
const ACTIVE = [];
function safeBeginReadFault(target) {
  const handle = beginReadFault({ tracesDir: H.TRACES, runId: target }, "fileMissing");
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

/**
 * 盯 traces 目录里「新 run 文件」的**首个已落盘 span**（span 在 endSpan 时整行落盘：
 * 该行在场 ⇒ 执行已启动、父本已被读入内存 ⇒ 此时隐藏父本不影响执行，而核实读取必然更晚）。
 * 比「终态事件」触发窗口宽得多（从毫秒级放宽到整个在飞尾巴）；凑满 requiredNew 份后 onHide 一次并收尾。
 * hideTarget = "new"（隐藏新子 run 自己，造不可读首读）| "fixed"（隐藏 hideRunId，让核实读到 ownOnly）。
 */
function startSpanWatcher({ requiredNew = 1, hideTarget, hideRunId, triggerMode = "span", timeoutMs = 120000 }) {
  const before = new Set(H.fs.readdirSync(H.TRACES).filter((n) => n.endsWith(".jsonl")));
  const promise = new Promise((resolve) => {
    let settled = false;
    const watcher = { close: null, stop: null };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      watcher.close?.();
      watcher.stop?.();
      resolve(value);
    };
    const triggered = [];
    const tryName = (name) => {
      if (settled || !name || !name.endsWith(".jsonl") || before.has(name)) return;
      if (triggered.includes(name)) return;
      const full = H.join(H.TRACES, name);
      let hit = false;
      try {
        const lines = H.readFileSync(full, "utf8")
          .split(/\r?\n/)
          .filter((l) => l.trim().length > 0);
        hit =
          triggerMode === "exists"
            ? lines.length >= 1 // 子文件在场（meta 行）即触发：父本读取在子 run 启动前，delayMs 拉长在飞窗口
            : lines.some((l) => {
                try {
                  const j = JSON.parse(l);
                  return j.type === "span" && typeof j.kind === "string";
                } catch {
                  return false;
                }
              });
      } catch {
        hit = false;
      }
      if (hit) {
        triggered.push(name);
        if (triggered.length >= requiredNew) {
          const target = hideTarget === "new" ? triggered[0].slice(0, -6) : hideRunId;
          let handle;
          try {
            handle = safeBeginReadFault(target);
          } catch (e) {
            finish({ error: `注入失败：${String(e)}` });
            return;
          }
          // 时序探针：触发时刻 + 触发文件当时的行型（定位 seg1 确定性输给核实的根因）
          let trigLines = null;
          try {
            trigLines = H.readFileSync(full, "utf8")
              .split(/\r?\n/)
              .filter((l) => l.trim().length > 0)
              .map((l) => {
                try {
                  const j = JSON.parse(l);
                  return `${j.type}:${j.kind ?? j.event ?? ""}`;
                } catch {
                  return "parse-fail";
                }
              });
          } catch {
            trigLines = "read-fail";
          }
          finish({ runIds: triggered.map((n) => n.slice(0, -6)), hidden: target, handle, triggerAt: Date.now(), trigLines });
        }
      }
    };
    const w = H.fs.watch(H.TRACES, (event, filename) => tryName(String(filename ?? "")));
    watcher.close = () => {
      try {
        w.close();
      } catch {
        /* 已关 */
      }
    };
    const timer = setInterval(() => {
      const names = H.fs.readdirSync(H.TRACES).filter((n) => n.endsWith(".jsonl") && !before.has(n));
      for (const name of names) tryName(name);
    }, 1);
    watcher.stop = () => clearInterval(timer);
    setTimeout(() => finish(null), timeoutMs);
  });
  return { done: () => promise };
}
/** 竞速结束后的逐字节还原（RESTORE-NEEDED 由 faults 库自管） */
function endRace(race, label) {
  if (race === null || race?.handle === undefined) return { clean: false, skipped: true };
  const end = race.handle.end();
  // 藏父本窗口内被竞速盯上的子 run 会合法续写落盘（其哈希变化是预期，不是还原失败）；
  // 判据收窄为：无新增/无消失 + 变化者只能是竞速子文件，父本本身必须原样归来
  const d = end.diff ?? { added: [], removed: [], changed: [] };
  const strip = (x) => String(x).replace(/\.jsonl$/, "");
  const okRestore =
    end.clean === true ||
    (d.added.length === 0 &&
      d.removed.length === 0 &&
      Array.isArray(d.changed) &&
      d.changed.length > 0 &&
      d.changed.map(strip).every((id) => (race.runIds ?? []).includes(id)));
  check(`${label} 注入还原（父本原样归来、子文件变化可解释）`, okRestore === true, end.diff);
  return end;
}

// ---------------------------------------------------------------------------
// 各 tag
// ---------------------------------------------------------------------------

const FLOWS = {
  /**
   * #33 ownOnly 正常结果仍按原修订清理 + #27 重试与执行严格分离 + #36a 不可读→ownOnly 重试清理。
   * 两段提交：第一段竞速隐藏父本（核实即 ownOnly+正常 ⇒ 原修订清理）；
   * 第二段先竞速隐藏子 run（首读不可读 ⇒ 草稿保留），再隐藏父本、面板「重读」⇒ ownOnly 清理。
   */
  "ownonly-closure": async (call, mock) => {
    const servedBase = mock.served();
    // ── 第一段：竞速隐藏父本 ⇒ 自动核实读到 ownOnly + 正常终止 ⇒ 按原修订清理
    const race1 = startSpanWatcher({ requiredNew: 1, hideTarget: "fixed", hideRunId: PARENT, triggerMode: "exists" });
    const text1 = `${MARK} closure 正常子 run`;
    const sub1 = await forkFlow(call, text1);
    const r1 = await race1.done();
    check("竞速注入得手（父本在子终态瞬间隐藏）", r1 !== null && !r1.error, r1?.error ?? (r1 === null ? "超时" : r1.hidden));
    if (r1 === null || r1.error) throw new Error("竞速注入失败");
    const rec1 = await waitRegistryRecordState(call, sub1.operationId, "settled", 30000);
    check("登记收口且 runId 与竞速捕获一致", rec1?.runIds?.[0] === r1.runIds[0], { rec: rec1?.runIds ?? null, race: r1.runIds });
    const entry1 = await waitForVerified(call, rec1.epoch, sub1.operationId, r1.runIds[0]);
    dump.entry1 = entrySummary(entry1);
    dump.timing1 = {
      triggerAt: r1.triggerAt,
      entryObservedAt: Date.now(),
      trigLines: r1.trigLines,
      hideToEntryMs: Date.now() - r1.triggerAt,
      // 触发后直读 main：父本此刻到底可不可读（信封 lineage 直证）
      directGetRun: await (async () => {
        const env = await H.apiCall(call, "getRun", r1.runIds[0]);
        return env?.ok === true
          ? { completeness: env.data?.completeness ?? null, missing: env.data?.lineage?.missingRunId ?? null }
          : { ok: false, err: env?.error?.code ?? null };
      })(),
    };
    check(
      "自动核实 verified 且 ownOnly（missingRunId=父本）",
      entry1?.phase === "verified" && entry1?.lineage?.status === "incomplete" && entry1?.lineage?.missingRunId === PARENT,
      dump.entry1,
    );
    check("ownOnly 正常终止 normalEnd=true（自有 stopped/completed）", entry1?.facts?.normalEnd === true, dump.entry1);
    check("ownOnly 正常 ⇒ 按原修订清理（草稿删除）", (await callDraftText(call, PARENT, TOOL_SPAN, "result")) === null, null);
    check("ownOnly 正常 ⇒ 收尾关联一并释放", (await closureOf(call, rec1.epoch, sub1.operationId)) === null, null);
    // 面板同一行：自有结局 + 来源警告（正常结束不被读成可重跑）
    await openOperationsPanel(call);
    const row1 = await rowRead(call, sub1.operationId);
    check(
      "面板行同屏显示自有结局与来源警告（不等于可以重跑 + 仅显示本运行记录）",
      row1.text.includes("已结束") && row1.text.includes("不等于可以重跑") && row1.text.includes("仅显示本运行记录"),
      row1.text.slice(0, 300),
    );
    await closeOperationsPanel(call);
    endRace(r1, "父本隐藏(1)");
    check("第一段恰一次模型调用", mock.served() - servedBase === 1, mock.served());

    // ── 第二段：先不可读（隐藏子 run）⇒ 草稿保留；再隐藏父本 ⇒ 手动重读 ownOnly 清理
    await H.storeQ(call, "await s.loadRuns(); return JSON.stringify({ n: s.runs.length });");
    const race2 = startSpanWatcher({ requiredNew: 1, hideTarget: "new" });
    const text2 = `${MARK} retry 可读性子 run`;
    const sub2 = await forkFlow(call, text2);
    const r2 = await race2.done();
    check("竞速注入得手（子 run 终态瞬间隐藏自身）", r2 !== null && !r2.error, r2?.error ?? (r2 === null ? "超时" : r2.hidden));
    if (r2 === null || r2.error) throw new Error("竞速注入失败");
    const rec2 = await waitRegistryRecordState(call, sub2.operationId, "settled", 30000);
    const child2 = rec2?.runIds?.[0] ?? null;
    check("登记收口且 runId 与被隐藏文件一致", child2 === r2.runIds[0], { rec: rec2?.runIds ?? null, race: r2.runIds });
    const auto2 = await waitForVerified(call, rec2.epoch, sub2.operationId, child2);
    check("自动核实被注入挡下 ⇒ unreadable（草稿保留）", auto2?.phase === "unreadable", entrySummary(auto2));
    check("首读不可读 ⇒ 草稿保留全文", (await callDraftText(call, PARENT, TOOL_SPAN, "result"))?.includes(text2.slice(-8)) === true, null);
    check("首读不可读 ⇒ 收尾关联保留", (await closureOf(call, rec2.epoch, sub2.operationId)) !== null, null);
    endRace(r2, "子 run 隐藏(2)");

    // 父本隐藏 + 手动重读（面板「重读这条结果」按钮 → 仅 runs:get）
    // ⚠️ 还原后先刷新列表：隐藏窗口内的采纳刷新会把 child2/父本排除在列表外（首跑坐实）
    await H.storeQ(call, "await s.loadRuns(); return JSON.stringify({ n: s.runs.length });");
    const fpBefore = H.hashAllTraces();
    // 当前选中对照 run（complete）⇒ canExecuteFromSource true 作对照
    await H.selectRun(call, AWAY);
    await H.sleep(1000);
    const execAway = await canExec(call);
    const hideParent = safeBeginReadFault(PARENT);
    await H.selectRun(call, child2);
    await H.sleep(1500);
    const sel = await detailCompleteness(call);
    check("父本隐藏后子 run 详情 = ownOnly", sel.c === "ownOnly", sel);
    const execOwn = await canExec(call);
    check(
      "ownOnly 详情 ⇒ canExecuteFromSource false（对照 complete ⇒ true）",
      execOwn === false && execAway === true,
      { ownOnly: execOwn, complete: execAway },
    );
    await openOperationsPanel(call);
    const attemptBefore = (await resultReadFor(call, rec2.epoch, sub2.operationId, child2))?.attempt ?? 0;
    const navRightBefore = await readingState(call);
    await clickRowAction(call, sub2.operationId, "重读这条结果");
    const retried = await waitForVerified(call, rec2.epoch, sub2.operationId, child2);
    dump.retried = entrySummary(retried);
    const navAfter = await readingState(call);
    check(
      "重读 ⇒ 同一可信 runId 落成 verified ownOnly（attempt+1）",
      retried?.phase === "verified" && retried?.lineage?.missingRunId === PARENT && retried?.attempt === attemptBefore + 1,
      dump.retried,
    );
    check("重试读到 ownOnly 正常 ⇒ 按原关联清理（草稿删除）", (await callDraftText(call, PARENT, TOOL_SPAN, "result")) === null, null);
    check("重试后收尾关联释放", (await closureOf(call, rec2.epoch, sub2.operationId)) === null, null);
    check(
      "重试全程不导航不换选中项（选中停在子 run、代次不推进）",
      navAfter.selectedRunId === child2 && navAfter.navGeneration === navRightBefore.navGeneration,
      { before: navRightBefore, after: navAfter },
    );
    check("重试全程零执行（模型调用数不变）", mock.served() - servedBase === 2, mock.served());
    const fpDiff = diffFingerprints(fpBefore, H.hashAllTraces());
    check("重试全程零新 trace（重试不落盘）", fpDiff.added.length === 0 && fpDiff.changed.length === 0, fpDiff);
    await closeOperationsPanel(call);
    const endHide = hideParent.end();
    check("父本隐藏(3) 注入逐字节还原", endHide.clean === true, endHide.diff);
    await H.shot(call, SHOT_DIR, `${TAG}-after-cleanup.png`);
  },

  /** #34 ownOnly 失败定位只使用自有调用：错误子 run + 父本隐藏 ⇒ 保留草稿、定位给自有失败调用 */
  "ownonly-failure": async (call, mock) => {
    const servedBase = mock.served();
    const race = startSpanWatcher({ requiredNew: 1, hideTarget: "fixed", hideRunId: PARENT, triggerMode: "exists" });
    const text = `${MARK} failure 错误子 run`;
    const sub = await forkFlow(call, text);
    const r = await race.done();
    check("竞速注入得手（父本隐藏）", r !== null && !r.error, r?.error ?? (r === null ? "超时" : r.hidden));
    if (r === null || r.error) throw new Error("竞速注入失败");
    const rec = await waitRegistryRecordState(call, sub.operationId, "settled", 60000);
    const child = rec?.runIds?.[0] ?? null;
    check("登记收口（失败 run 也 settled 且带 runId）", rec?.state === "settled" && typeof child === "string", rec?.state ?? null);
    const entry = await waitForVerified(call, rec.epoch, sub.operationId, child);
    dump.entry = entrySummary(entry);
    check(
      "ownOnly 错误终态核实落地（lineage incomplete + normalEnd=false）",
      entry?.phase === "verified" && entry?.lineage?.missingRunId === PARENT && entry?.facts?.normalEnd === false,
      dump.entry,
    );
    // 失败定位只认自有调用：与子 run 落盘的 llm.call span 比对（不取祖先）
    const childLines = readFileSync(join(H.TRACES, `${child}.jsonl`), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const ownFailingLlm = childLines.filter((l) => l.type === "span" && l.kind === "llm.call" && l.error != null);
    check("子 run 自有失败调用恰一个（受控 503）", ownFailingLlm.length === 1, ownFailingLlm.length);
    check(
      "定位 = 自有失败调用 span（不取祖先）",
      entry?.facts?.failure?.llmCallSpanId === ownFailingLlm[0]?.id,
      { entry: entry?.facts?.failure?.llmCallSpanId ?? null, own: ownFailingLlm[0]?.id ?? null },
    );
    check("error 终止 ⇒ 草稿保留全文", (await callDraftText(call, PARENT, TOOL_SPAN, "result"))?.includes(text.slice(-8)) === true, null);
    check("error 终止 ⇒ 收尾关联保留", (await closureOf(call, rec.epoch, sub.operationId)) !== null, null);
    // 面板：定位入口给自有调用，点击跳自有失败 span
    await openOperationsPanel(call);
    const row = await rowRead(call, sub.operationId);
    check(
      "面板行给「查看失败调用」定位入口（有自有失败详情才给）",
      row.buttons.some((b) => b.includes("查看失败调用")),
      row.buttons,
    );
    await clickRowAction(call, sub.operationId, "查看失败调用");
    const nav = await readingState(call);
    check("点击定位 ⇒ 跳自有 run 的失败 span", nav.selectedRunId === child && nav.selectedSpanId === ownFailingLlm[0]?.id, nav);
    await closeOperationsPanel(call);
    endRace(r, "父本隐藏(failure)");
    check("恰一次模型调用", mock.served() - servedBase === 1, mock.served());
    dump.layerNote =
      "「error 终止但无自有失败详情 ⇒ 诚实说明」半边：受控失败必落自有 llm.call.error，真机造不出 error 终止且零自有失败详情（除非注入层）⇒ 由 u6-partial-result-closure 4.7 第二例（store 集成）承载";
    await H.shot(call, SHOT_DIR, `${TAG}-failure-own.png`);
  },

  /** #36b 重试前草稿已推进新修订 ⇒ 不被删除：不可读首读 → 修订推进 → ownOnly 正常重试不清 */
  "rev-preserves": async (call, mock) => {
    const servedBase = mock.served();
    const race = startSpanWatcher({ requiredNew: 1, hideTarget: "new" });
    const text1 = `${MARK} rev 原始文本 v1`;
    const sub = await forkFlow(call, text1);
    const r = await race.done();
    check("竞速注入得手（子 run 终态瞬间隐藏自身）", r !== null && !r.error, r?.error ?? (r === null ? "超时" : r.hidden));
    if (r === null || r.error) throw new Error("竞速注入失败");
    const rec = await waitRegistryRecordState(call, sub.operationId, "settled", 30000);
    const child = rec?.runIds?.[0] ?? null;
    const auto = await waitForVerified(call, rec.epoch, sub.operationId, child);
    check("自动核实 unreadable ⇒ 草稿保留（冻结解除）", auto?.phase === "unreadable", entrySummary(auto));
    endRace(r, "子 run 隐藏(rev)");
    // 解冻后推进修订（键入追加；草稿初始值=原值，键入合并进行尾）
    await openPlainResultEditor(call);
    const suffix = " v2 修订追加";
    await H.typeIntoEditableMonaco(call, suffix);
    const revNow = await callDraftRevision(call, PARENT, TOOL_SPAN, "result");
    check("解冻后修订推进（revision > 提交时修订）", typeof revNow === "number" && revNow > sub.revision, { rev: revNow, submitted: sub.revision });
    // 还原子 run + 隐藏父本 ⇒ 重读 ownOnly 正常，但修订不匹配 ⇒ 不删
    const fpBefore = H.hashAllTraces();
    const navBefore = await readingState(call);
    const hideParent = safeBeginReadFault(PARENT);
    await openOperationsPanel(call);
    await clickRowAction(call, sub.operationId, "重读这条结果");
    const retried = await waitForVerified(call, rec.epoch, sub.operationId, child);
    dump.retried = entrySummary(retried);
    check("重读落地 ownOnly 正常（verified + normalEnd=true）", retried?.phase === "verified" && retried?.facts?.normalEnd === true && retried?.lineage?.missingRunId === PARENT, dump.retried);
    const draftNow = await callDraftText(call, PARENT, TOOL_SPAN, "result");
    check("修订推进 ⇒ 迟到的正常结果不清新修订（v2 文本保留）", typeof draftNow === "string" && draftNow.includes(suffix), draftNow?.slice(-40) ?? null);
    check("修订推进 ⇒ 收尾关联保留（不释放）", (await closureOf(call, rec.epoch, sub.operationId)) !== null, null);
    const navAfter = await readingState(call);
    check("重试不导航（选中与代次不动）", navAfter.selectedRunId === navBefore.selectedRunId && navAfter.navGeneration === navBefore.navGeneration, { before: navBefore, after: navAfter });
    check("重试零执行（恰一次模型调用）", mock.served() - servedBase === 1, mock.served());
    const fpDiff = diffFingerprints(fpBefore, H.hashAllTraces());
    check("重试零新 trace", fpDiff.added.length === 0 && fpDiff.changed.length === 0, fpDiff);
    await closeOperationsPanel(call);
    const endHide = hideParent.end();
    check("父本隐藏注入逐字节还原", endHide.clean === true, endHide.diff);
    await H.shot(call, SHOT_DIR, `${TAG}-rev-preserved.png`);
  },

  /**
   * #35 部分实验结果保留完整批次判据（A/B UI 提交，父本竞速隐藏 ⇒ 两臂 ownOnly）：
   * 第一批 [ok, ok] ⇒ 整批照常清理；第二批 [ok, fail] ⇒ 错误臂在场 ⇒ 整批保留。
   * 缺臂/null ID/不可读臂真机不可达 ⇒ store 集成承载（4.8 第二例）并注明。
   */
  "ab-ownonly": async (call, mock) => {
    const servedBase = mock.served();
    const openAbEditor = async () => {
      // 已处于打开态（上一批的编辑器还挂着）⇒ 先「收起」（保留草稿语义，但上一批已被清理）
      const bodyNow = await bodyText(call);
      if (bodyNow.includes("模型 A/B 实验 · 同上下文多臂对比")) {
        await H.ev(
          call,
          `(() => { const b = Array.from(document.querySelectorAll('button'))
              .filter(x => x.offsetParent !== null)
              .find(x => ((x.textContent || '').trim()) === '收起');
            if (!b) return 'no-button'; b.click(); return 'clicked'; })()`,
        );
        await H.sleep(900);
      }
      await H.selectRun(call, PARENT);
      await H.clickTabChecked(call, "步骤");
      await H.clickSpan(call, "LLM", PARENT_SPAN);
      const sel = await H.storeQ(
        call,
        "return JSON.stringify({ run: s.selectedRunId, span: s.selectedSpanId });",
      );
      if (sel.run !== PARENT || sel.span !== PARENT_SPAN) throw new Error(`选中态串台：${JSON.stringify(sel)}`);
      await H.clickByTextChecked(call, "模型 A/B 实验（换 model / params 对比）", 3000);
      const deadline = Date.now() + 8000;
      for (;;) {
        const body = await bodyText(call);
        if (body.includes("模型 A/B 实验 · 同上下文多臂对比")) return;
        if (Date.now() > deadline) throw new Error("A/B 编辑器 8s 未打开");
        await H.sleep(400);
      }
    };
    const setArmInput = async (index, value) => {
      const r = await H.ev(
        call,
        `(() => {
          const inputs = Array.from(document.querySelectorAll('input'))
            .filter(x => x.offsetParent !== null)
            .filter(x => (x.placeholder || "") === "model 名");
          const el = inputs[${index}];
          if (!el) return JSON.stringify({ error: 'input-not-found', count: inputs.length });
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(el, ${JSON.stringify(value)});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return JSON.stringify({ ok: true });
        })()`,
      );
      const p = JSON.parse(r);
      if (p.error) throw new Error(`setArmInput(${index}) 失败：${JSON.stringify(p)}`);
      await H.sleep(450);
    };
    const acknowledgeSideEffectsIfPresent = async () => {
      const r = await H.ev(
        call,
        `(() => {
          const label = Array.from(document.querySelectorAll('label'))
            .find(x => x.offsetParent !== null && (x.textContent || '').includes('未标记 sideEffect'));
          if (!label) return JSON.stringify({ present: false });
          const box = label.querySelector('input[type="checkbox"]');
          if (!box) return JSON.stringify({ present: true, error: 'checkbox-missing' });
          if (!box.checked) box.click();
          return JSON.stringify({ present: true, checked: box.checked });
        })()`,
      );
      const p = JSON.parse(r);
      if (p.error) throw new Error(`副作用确认：${JSON.stringify(p)}`);
      if (p.present) await H.sleep(300);
      return p.present;
    };
    const previewAb = async () => {
      const raw = await H.ev(
        call,
        `(() => { const b = Array.from(document.querySelectorAll('button'))
            .filter(x => x.offsetParent !== null)
            .find(x => ((x.textContent || '').trim()).startsWith('校验并预览计划'));
          return b == null ? JSON.stringify({ found: false })
            : JSON.stringify({ found: true, disabled: b.disabled }); })()`,
      );
      const st = JSON.parse(raw);
      if (!(st.found && st.disabled === false)) throw new Error(`预览按钮不可点：${JSON.stringify(st)}`);
      await H.ev(
        call,
        `(() => { Array.from(document.querySelectorAll('button'))
            .filter(x => x.offsetParent !== null)
            .find(x => ((x.textContent || '').trim()).startsWith('校验并预览计划')).click(); return true; })()`,
      );
      const deadline = Date.now() + 10000;
      for (;;) {
        const body = await bodyText(call);
        if (body.includes("校验通过 · 执行计划")) return;
        if (Date.now() > deadline) throw new Error("dry-run 计划 10s 未在场");
        await H.sleep(300);
      }
    };
    const waitForAbSettled = async (operationId, armCount, timeoutMs = 90000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const { rec } = await recordOf(call, operationId);
        if (
          rec !== null &&
          rec.state === "settled" &&
          (rec.arms ?? []).length >= armCount &&
          (rec.arms ?? []).every((a) => a.id !== null)
        ) {
          return rec;
        }
        if (Date.now() > deadline) return rec;
        await H.sleep(500);
      }
    };

    // ── 第一批：[ok, ok] ⇒ 两臂 ownOnly 正常 ⇒ 整批照常清理
    await openAbEditor();
    let d0 = await abDraftOf(call);
    check("第一批：打开即有批次草稿（两臂）", d0 !== null && d0.rows.length === 2, d0?.rows?.length);
    await setArmInput(0, "U6-67-arm-a");
    await setArmInput(1, "U6-67-arm-b");
    await acknowledgeSideEffectsIfPresent();
    await previewAb();
    await confirmEditor(call);
    const race1 = startSpanWatcher({ requiredNew: 2, hideTarget: "fixed", hideRunId: PARENT, triggerMode: "exists" });
    const sub1 = await submitAndCapture(call, "确认执行（", AB_SUB_KEY);
    if (typeof sub1.operationId !== "string") throw new Error(`A/B 未登记：${JSON.stringify(sub1)}`);
    const r1 = await race1.done();
    check("第一批竞速注入得手（两臂终态后隐藏父本）", r1 !== null && !r1.error, r1?.error ?? (r1 === null ? "超时" : r1.hidden));
    if (r1 === null || r1.error) throw new Error("竞速注入失败");
    const rec1 = await waitForAbSettled(sub1.operationId, 2);
    check(
      "第一批登记收口：两臂 returned 且 id 非空",
      rec1?.state === "settled" && (rec1.arms ?? []).every((a) => a.outcome === "returned" && a.id !== null),
      rec1 ? { state: rec1.state, arms: rec1.arms } : null,
    );
    const entries1 = [];
    for (const arm of rec1.arms) {
      const e = await waitForVerified(call, rec1.epoch, sub1.operationId, arm.id);
      entries1.push({ arm: arm.id, ...entrySummary(e) });
    }
    dump.entries1 = entries1;
    check(
      "两臂核实均 verified ownOnly 正常（ownOnly 不另设门槛）",
      entries1.every((e) => e.phase === "verified" && e.lineage?.missingRunId === PARENT && e.normalEnd === true),
      entries1,
    );
    const deadline1 = Date.now() + 30000;
    let cleaned = false;
    for (;;) {
      const d = await abDraftOf(call);
      const cl = await closureOf(call, rec1.epoch, sub1.operationId);
      if (d === null && cl === null) {
        cleaned = true;
        break;
      }
      if (Date.now() > deadline1) break;
      await H.sleep(500);
    }
    check("两臂 ownOnly 正常 ⇒ 整批一次清干净（批次草稿 + 关联）", cleaned === true, { draft: await abDraftOf(call) !== null });
    check("第一批恰两次调用（每臂一次）", mock.served() - servedBase === 2, mock.served());
    endRace(r1, "父本隐藏(ab1)");

    // ── 第二批：[ok, fail] ⇒ 两臂 ownOnly、臂 2 错误 ⇒ 整批保留，不推断胜出臂
    await H.storeQ(call, "await s.loadRuns(); return JSON.stringify({ n: s.runs.length });");
    await openAbEditor();
    d0 = await abDraftOf(call);
    check("第二批：上一批已清 ⇒ 全新两臂批次", d0 !== null && d0.rows.length === 2, d0?.rows?.length);
    await setArmInput(0, "U6-67-arm-c");
    await setArmInput(1, "U6-67-arm-d");
    await acknowledgeSideEffectsIfPresent();
    await previewAb();
    await confirmEditor(call);
    const race2 = startSpanWatcher({ requiredNew: 2, hideTarget: "fixed", hideRunId: PARENT, triggerMode: "exists" });
    const sub2 = await submitAndCapture(call, "确认执行（", AB_SUB_KEY);
    if (typeof sub2.operationId !== "string") throw new Error(`A/B 未登记：${JSON.stringify(sub2)}`);
    const r2 = await race2.done();
    check("第二批竞速注入得手", r2 !== null && !r2.error, r2?.error ?? (r2 === null ? "超时" : r2.hidden));
    if (r2 === null || r2.error) throw new Error("竞速注入失败");
    const rec2 = await waitForAbSettled(sub2.operationId, 2);
    check(
      "第二批登记收口：臂 1 returned、臂 2 failed（逐臂诚实）",
      rec2?.state === "settled" && rec2.arms?.[0]?.outcome === "returned" && rec2.arms?.[1]?.outcome === "failed" && rec2.arms.every((a) => a.id !== null),
      rec2 ? { state: rec2.state, arms: rec2.arms } : null,
    );
    const entries2 = [];
    for (const arm of rec2.arms) {
      const e = await waitForVerified(call, rec2.epoch, sub2.operationId, arm.id);
      entries2.push({ arm: arm.id, outcome: arm.outcome, ...entrySummary(e) });
    }
    dump.entries2 = entries2;
    check(
      "两臂核实均 ownOnly（missingRunId=父本），臂 2 normalEnd=false",
      entries2.every((e) => e.phase === "verified" && e.lineage?.missingRunId === PARENT) && entries2[0].normalEnd === true && entries2[1].normalEnd === false,
      entries2,
    );
    await H.sleep(2000);
    const d2 = await abDraftOf(call);
    const cl2 = await closureOf(call, rec2.epoch, sub2.operationId);
    check("错误臂在场 ⇒ 整批保留（批次草稿仍在）", d2 !== null && d2.rows.length === 2, d2?.rows?.length);
    check("错误臂在场 ⇒ 收尾关联保留（不推断胜出臂）", cl2 !== null, cl2 === null ? null : { targetKey: cl2.targetKey });
    await openOperationsPanel(call);
    const row2 = await rowRead(call, sub2.operationId);
    check(
      "面板批次结果逐臂显示（含来源警告与失败结局，不冒充整批结论）",
      row2.text.includes("不等于可以重跑") || row2.text.includes("仅显示本运行记录"),
      row2.text.slice(0, 300),
    );
    await closeOperationsPanel(call);
    check("第二批恰两次调用", mock.served() - servedBase === 4, mock.served());
    endRace(r2, "父本隐藏(ab2)");
    dump.layerNote =
      "缺臂/null ID/不可读臂三支真机不可达（main 收尾每臂必带 id、逐臂独立读取）⇒ 由 u6-partial-result-closure 4.8 第二例（store 集成 fixture）承载；实机交付的是「错误臂保留」这支";
    await H.shot(call, SHOT_DIR, `${TAG}-ab-retained.png`);
  },

  /**
   * #17 读取重试不改变阅读位置：ownOnly → 恢复 → complete 三态切换中，阅读位置（页签/选中 span）保持。
   * 在飞交叠半边（重试在飞期间换页签/选别的调用）真机无延时注入面 ⇒ 单元承载（u6-detail-refresh-guard）。
   */
  "retry-position": async (call, mock) => {
    const servedBase = mock.served();
    const race = startSpanWatcher({ requiredNew: 1, hideTarget: "fixed", hideRunId: PARENT, triggerMode: "exists" });
    const text = `${MARK} position 阅读位置子 run`;
    const sub = await forkFlow(call, text);
    const r = await race.done();
    check("竞速注入得手（父本隐藏）", r !== null && !r.error, r?.error ?? (r === null ? "超时" : r.hidden));
    if (r === null || r.error) throw new Error("竞速注入失败");
    const rec = await waitRegistryRecordState(call, sub.operationId, "settled", 30000);
    const child = rec?.runIds?.[0] ?? null;
    const entry = await waitForVerified(call, rec.epoch, sub.operationId, child);
    check("ownOnly 正常核实落地", entry?.phase === "verified" && entry?.lineage?.missingRunId === PARENT, entrySummary(entry));
    check("ownOnly 正常 ⇒ 草稿按原修订清理", (await callDraftText(call, PARENT, TOOL_SPAN, "result")) === null, null);

    // 布置阅读位置：选中子 run → 选自有 span → 页签停在「步骤」
    // ⚠️ 此时父本仍在隐藏中（endRace 推迟到 ownOnly 重读之后）：还原过早会让重读拿到 complete（首跑坐实）
    await H.selectRun(call, child);
    await H.sleep(1500);
    const detail1 = await detailCompleteness(call);
    check("子 run 详情 = ownOnly", detail1.c === "ownOnly", detail1);
    await H.clickTabChecked(call, "步骤");
    const childLines = readFileSync(join(H.TRACES, `${child}.jsonl`), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const ownLlmSpan = childLines.find((l) => l.type === "span" && l.kind === "llm.call");
    if (ownLlmSpan === undefined) throw new Error(`子 run ${child} 没有 llm.call span`);
    await H.clickSpan(call, "LLM", ownLlmSpan.id);
    const beforeOwn = await readingOfRun(call, child);
    // 重读（切走切回）⇒ ownOnly 再落地，阅读位置保持（位置判据只看页签与 span，展开态是渲染噪声）
    await H.selectRun(call, AWAY);
    await H.sleep(900);
    await H.selectRun(call, child);
    await H.sleep(1500);
    const afterOwn = await readingOfRun(call, child);
    const posOf = (r) => (r === null ? null : { tab: r.tab, spanId: r.spanId });
    check(
      "ownOnly 重读落地 ⇒ 阅读位置保持（页签/span）",
      afterOwn !== null && JSON.stringify(posOf(beforeOwn)) === JSON.stringify(posOf(afterOwn)) && posOf(beforeOwn).tab !== null,
      { before: posOf(beforeOwn), after: posOf(afterOwn) },
    );
    const sel2 = await detailCompleteness(call);
    check("重读后仍 ownOnly（不缓存错误结论也不升级）", sel2.c === "ownOnly", sel2);

    // 恢复父本 ⇒ 重读 ⇒ complete（新读取胜出），阅读位置仍保持
    // （「恢复前 ownOnly 旧响应后到不覆盖 complete」的在飞交叠半边无延时注入面 ⇒ 单元承载；
    //   实机可验证的是「恢复后重读读到 complete 且位置不动」这一用户可见结果。）
    const endRaceResult = endRace(r, "父本隐藏(position)");
        const navBefore = await readingState(call);
    // 父本已还原 ⇒ 切走切回触发全新读取
    await H.selectRun(call, AWAY);
    await H.sleep(900);
    await H.selectRun(call, child);
    await H.sleep(1500);
    const sel3 = await detailCompleteness(call);
    check("父本恢复后重读 ⇒ 全量重验 complete（不缓存旧 ownOnly）", sel3.c === "complete", sel3);
    const afterComplete = await readingOfRun(call, child);
    check("complete 落地 ⇒ 阅读位置仍保持", JSON.stringify(posOf(afterComplete)) === JSON.stringify(posOf(afterOwn)), { expect: posOf(afterOwn), now: posOf(afterComplete) });
    const navAfter = await readingState(call);
    check("全程选中 run 不变（重试不换阅读对象）", navAfter.selectedRunId === child, { before: navBefore.selectedRunId, after: navAfter.selectedRunId });
    check("恰一次模型调用", mock.served() - servedBase === 1, mock.served());
    dump.layerNote =
      "「重试在飞期间选别的调用/换页签 ⇒ 落地不覆盖新位置」需详情读取可延时——真机无此注入面 ⇒ 由 u6-detail-refresh-guard 三例（store 集成）承载；实机交付 ownOnly→恢复→complete 三态切换的位置保持";
    await H.shot(call, SHOT_DIR, `${TAG}-position.png`);
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
  // 就绪判据读 store（U4 6.8 纪律：DOM 行会被窄档/折叠吞掉）+ DPR 哨兵（u5-68 zoom 残留会全批假红）
  let runsReady = false;
  for (let i = 0; i < 60; i++) {
    await H.sleep(500);
    try {
      const n = await H.storeQ(call, "return JSON.stringify(s.runs.length);");
      if (n > 0) {
        runsReady = true;
        break;
      }
    } catch {
      /* 重载瞬间 */
    }
  }
  if (!runsReady) throw new Error("重载后 30s 运行列表仍未就绪（store.runs 为空）");
  const dpr = await H.ev(call, "(() => window.devicePixelRatio)()");
  if (Math.abs(dpr - 2.1) > 0.3) {
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
  process.exit(1);
});
