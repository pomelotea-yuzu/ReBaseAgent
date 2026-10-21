/* eslint-disable */
/**
 * R2.2 任务 7.3（失败与未知路径实机批）共用机制库：**只含通道与读数，不含判据**。
 *
 * 与 U4/U5 的 `u4-smoke-harness.cjs` 的分工：那层给真 CDP 会话 / 真 store / 真桥接面通道，
 * 本层只在其上加 7.3 需要的三件事：
 *  ① 数据目录逐文件指纹与「施加→还原→差集为空」的自证（真实故障注入的牙齿）；
 *  ② 隔离 prompt 实验的 GUI 现场读数（核对卡 / 费用确认 / 副本授权 / 提交态 / stale 条）；
 *  ③ 「在飞窗口内做事」的页内原语——迟到判据必须证明请求真的在飞，否则断言是空转。
 *
 * ⚠️ 页内求值口径（UI-VERIFY）：`storeQ`/`appImport` 的 body 必须 `return JSON.stringify(...)`；
 *    `ev` 取字段一律对象/原始值直返。本库的 `jev` 负责把 ev 的 JSON 串解析回对象。
 */
"use strict";
const { createHash } = require("node:crypto");
const { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } = require(
  "node:fs"
);
const { join } = require("node:path");
const H = require("./u4-smoke-harness.cjs");

const REPO = H.REPO;
const OUT = join(REPO, ".workbuddy", "r22-73");
const DATA = join(REPO, ".rebaseagent");
const TRACES = join(DATA, "traces");
const BLOBS = join(DATA, "workspace-blobs", "sha256");
const SHOTS = join(OUT, "shots");
const SEED_FILE = join(OUT, "seed.json");
const HIDDEN_SUFFIX = ".u73-hidden";

const seed = () => JSON.parse(readFileSync(SEED_FILE, "utf8"));

// ---------------------------------------------------------------------------
// 逐文件指纹（真实故障注入的还原自证 + 只读不变式）
// ---------------------------------------------------------------------------

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** traces + workspace-blobs 的逐文件 {name → sha256, bytes} */
function fingerprint() {
  const acc = {};
  for (const dir of [TRACES, BLOBS]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (!statSync(full).isFile()) continue;
      acc[`${dir === TRACES ? "traces" : "blobs"}/${name}`] = {
        sha256: sha256File(full),
        bytes: statSync(full).size,
      };
    }
  }
  return acc;
}

/**
 * 指纹差集。`allow` 是本 tag 允许出现的变化**子串**（相对名，如 run id 片段）。
 * 返回 {added, removed, changed, unexpected}，unexpected 非空即判红。
 */
function diffFingerprint(before, after, allow = []) {
  const changed = [];
  const added = [];
  const removed = [];
  for (const [k, v] of Object.entries(after)) {
    if (!(k in before)) added.push(k);
    else if (before[k].sha256 !== v.sha256) changed.push(k);
  }
  for (const k of Object.keys(before)) if (!(k in after)) removed.push(k);
  const unexpected = [...added, ...removed, ...changed].filter(
    (k) => !allow.some((needle) => k.includes(needle)),
  );
  return { added, removed, changed, unexpected };
}

/**
 * 「只允许本次新 run」的不变式写法：新增只能是这些 run 的 trace 与新 blob，
 * 任何既有文件被改或删都是红线（父/兄弟/源目录/共享附件都不许被碰）。
 * ⚠️ 不能只按 run id 放行：执行成功会写新附件，blob 文件名是内容哈希，事前无从得知。
 */
function onlyNewRunChanges(before, after, childIds = []) {
  const d = diffFingerprint(before, after, []);
  const allowedTrace = new Set(childIds.filter(Boolean).map((id) => `traces/${id}.jsonl`));
  const offenders = [
    ...d.added.filter((k) => !allowedTrace.has(k) && !k.startsWith("blobs/")),
    ...d.removed,
    ...d.changed,
  ];
  return {
    ok: offenders.length === 0,
    offenders,
    counts: { added: d.added.length, removed: d.removed.length, changed: d.changed.length },
    added: d.added,
  };
}

// ---------------------------------------------------------------------------
// 故障注入句柄（同卷 rename / 追加字节，收尾无条件还原并逐字节核对）
// ---------------------------------------------------------------------------

/** 活跃句柄注册表：探针崩溃也不把故障留在盘上（U6 的 ACTIVE 纪律） */
const ACTIVE = new Set();

function makeHandle(kind, target, extra = {}) {
  const handle = {
    kind,
    target,
    ...extra,
    applied: null,
    apply() {
      if (handle.applied !== null) throw new Error(`句柄已施加：${kind} ${target}`);
      if (kind === "hideBlob" || kind === "hideTrace") {
        const hidden = `${target}${HIDDEN_SUFFIX}`;
        if (!existsSync(target)) throw new Error(`施加前目标就不在盘上：${target}`);
        if (existsSync(hidden)) throw new Error(`遗留隐藏副本：${hidden}`);
        const before = sha256File(target);
        renameSync(target, hidden);
        handle.applied = { kind, before, hidden, existsNow: existsSync(target), hiddenNow: existsSync(hidden) };
        return handle.applied;
      }
      if (kind === "corruptBlob") {
        if (!existsSync(target)) throw new Error(`施加前目标就不在盘上：${target}`);
        const original = readFileSync(target);
        writeFileSync(target, Buffer.concat([original, Buffer.from("\nR2273-CORRUPTED\n", "utf8")]));
        handle.applied = {
          kind,
          before: createHash("sha256").update(original).digest("hex"),
          original,
          existsNow: existsSync(target),
          bytesNow: statSync(target).size,
        };
        return handle.applied;
      }
      throw new Error(`未知句柄类型：${kind}`);
    },
    end() {
      if (handle.applied === null) return { restored: true, why: "未施加" };
      let restoreError = null;
      try {
        if (handle.applied.hidden !== undefined) {
          if (existsSync(handle.target)) {
            // 应用侧「不覆盖既有附件」的纪律若被破坏，这里会看见目标名重新出现 ⇒ 保留现场人工核对
            throw new Error(`还原时目标名已重新出现（不应由补写产生）：${handle.target}`);
          }
          renameSync(handle.applied.hidden, handle.target);
        } else {
          writeFileSync(handle.target, handle.applied.original);
        }
      } catch (e) {
        restoreError = String(e?.message ?? e);
      }
      const after = existsSync(handle.target) ? sha256File(handle.target) : null;
      const clean = restoreError === null && after === handle.applied.before;
      const applied = handle.applied;
      handle.applied = null;
      ACTIVE.delete(handle);
      return {
        restored: clean,
        restoreError,
        sha256Before: applied.before,
        sha256After: after,
        hiddenResidue: hiddenResidue(),
      };
    },
  };
  ACTIVE.add(handle);
  return handle;
}

function drainActive() {
  return Array.from(ACTIVE).map((h) => ({ kind: h.kind, target: h.target, ...h.end() }));
}

/** 目录里是否残留隐藏副本（收尾自证） */
function hiddenResidue() {
  const out = [];
  for (const dir of [TRACES, BLOBS]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) if (name.endsWith(HIDDEN_SUFFIX)) out.push(`${dir}/${name}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 页内读数（全部走真 store / 真 DOM，不改行为）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 页内读数（全部走真 store / 真 DOM，不改行为）
// ---------------------------------------------------------------------------

/**
 * ⚠️ 页内求值一律带 awaitPromise：async IIFE 不加这个会被序列化成 `{}`（判据静默空转，
 * UI-VERIFY「页内是 async IIFE ⇒ 必须 awaitPromise」的同族坑）。
 * 同时给每个求值套 node 侧上限——失联后半开的 ws 会让 await 永不 settle（无界 await = 假绿通道）。
 */
const EV_TIMEOUT_MS = 120_000;
const jev = async (call, expression) => {
  const bounded = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`jev 超过 ${EV_TIMEOUT_MS}ms 未 settle（页内或 ws 卡住）`)), EV_TIMEOUT_MS).unref?.();
  });
  const sent = call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  const r = await Promise.race([sent, bounded]);
  if (r?.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`jev@${expression.slice(0, 80).replace(/\s+/g, " ")} → ${d.exception?.description ?? d.text}`);
  }
  const v = r?.result?.value;
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

const draftKeyExpr = (key) =>
  `const key = { runId: ${JSON.stringify(key.runId)}, spanId: ${JSON.stringify(key.spanId)}, field: ${JSON.stringify(key.field)}, mode: ${JSON.stringify(key.mode ?? "isolated")} };`;

/** 隔离实验草稿仓库读数（正文/假设/判据/修订/冻结） */
const draftState = (call, key) =>
  H.storeQ(
    call,
    `${draftKeyExpr(key)}
     const e = s.callDraftOf(key);
     return JSON.stringify({ present: e !== undefined, text: e?.text ?? null,
       baseline: e?.baseline ?? null, hypothesis: e?.hypothesis ?? null,
       acceptanceCriterion: e?.acceptanceCriterion ?? null, revision: e?.revision ?? null,
       frozen: e === undefined ? null : s.isDraftFrozen(key) });`,
  );

/** 隔离 prompt 编辑器现场（核对卡 / 确认 / 授权 / 提交 / stale / unavailable） */
const editorState = (call) =>
  jev(
    call,
    `(() => JSON.stringify({
       entry: { root: !!document.querySelector('[data-isolated-prompt-start]'),
                branch: !!document.querySelector('[data-isolated-prompt-goto-root]'),
                branchEntry: !!document.querySelector('[data-isolated-prompt-entry="branch"]'),
                rootError: (document.querySelector('[data-isolated-prompt-root-error]')?.textContent ?? '').replace(/\\s+/g,' ').trim().slice(0,220),
                unavailable: (document.querySelector('[data-isolated-prompt-unavailable]')?.textContent ?? '').replace(/\\s+/g,' ').trim().slice(0,220) },
       editorOpen: !!document.querySelector('[data-isolated-prompt-check]'),
       checkLabel: (document.querySelector('[data-isolated-prompt-check-button]')?.textContent ?? '').trim(),
       checkDisabled: document.querySelector('[data-isolated-prompt-check-button]')?.disabled ?? null,
       checkedLine: !!document.querySelector('[data-isolated-prompt-checked]'),
       stale: !!document.querySelector('[data-isolated-prompt-check-stale]'),
       checkError: (document.querySelector('[data-isolated-prompt-check-error]')?.textContent ?? '').replace(/\\s+/g,' ').trim().slice(0,220),
       unavailableCard: (document.querySelector('[data-isolated-prompt-check-unavailable]')?.textContent ?? '').replace(/\\s+/g,' ').trim().slice(0,300),
       confirm: (() => { const b = document.querySelector('[data-confirm-execution]');
         return b === null ? null : { pressed: b.getAttribute('aria-pressed'), disabled: b.disabled }; })(),
       authPresent: !!document.querySelector('[data-isolated-writes-authorization]'),
       authChecked: document.querySelector('[data-isolated-writes-authorization] input')?.checked ?? null,
       authDisabled: document.querySelector('[data-isolated-writes-authorization] input')?.disabled ?? null,
       submitPresent: !!document.querySelector('[data-isolated-prompt-submit-button]'),
       submitDisabled: document.querySelector('[data-isolated-prompt-submit-button]')?.disabled ?? null,
       submitState: (document.querySelector('[data-isolated-prompt-submit-state]')?.textContent ?? '').replace(/\\s+/g,' ').trim().slice(0,200),
       billing: (document.querySelector('[data-isolated-billing]')?.textContent ?? '').replace(/\\s+/g,' ').trim().slice(0,260),
       cardText: (document.querySelector('[data-isolated-prompt-check]')?.innerText ?? '').replace(/\\s+/g,' ').trim().slice(0,900),
     }))()`,
  );

/** 执行侧 store 读数（在飞 / 错误码 / 登记 / 选中态） */
const execState = (call) =>
  H.storeQ(
    call,
    `return JSON.stringify({ forking: s.forking, forkError: s.forkError, forkErrorCode: s.forkErrorCode,
       selectedRunId: s.selectedRunId, view: s.view, epoch: s.operations.epoch,
       pending: (s.operations.pending ?? []).length,
       records: (s.operations.operations ?? []).map(o => ({ id: String(o.operationId).slice(0,8),
         kind: o.target?.kind ?? null, parentRunId: o.target?.parentRunId ?? null,
         editField: o.target?.editField ?? null, state: o.state, runIds: o.runIds,
         errorCode: o.errorCode })) });`,
  );

/** main 侧登记快照（真 IPC，只读核对） */
const operationsStatus = (call) => H.apiCall(call, "operationsStatus");

/** 真 IPC 直调（不经 store，读未加工信封） */
const rawIpc = (call, method, payload) =>
  H.appImport(
    call,
    H.STORE_NEEDLE,
    `const env = await window.api.${method}(${JSON.stringify(payload ?? null)});
     return JSON.stringify(env);`,
  );

/** 页内取当前 main 会话 epoch（主动通道的外层身份） */
const currentEpoch = async (call) => {
  const env = await rawIpc(call, "operationsStatus");
  return env?.data?.epoch ?? null;
};

// ---------------------------------------------------------------------------
// GUI 流程原语
// ---------------------------------------------------------------------------

const selectRunAndOverview = async (call, id) => {
  await H.storeQ(call, `await s.selectRun(${JSON.stringify(id)}); return JSON.stringify({ ok: true });`);
  await H.storeQ(
    call,
    `s.setReadingTab(${JSON.stringify(id)}, "overview"); return JSON.stringify({ ok: true });`,
  );
  await H.sleep(1500);
};

const clickSelector = (call, selector, waitMs = 1200) =>
  jev(
    call,
    `(() => { const e = document.querySelector(${JSON.stringify(selector)});
       if (!e) return JSON.stringify({ ok: false, why: 'no-el' });
       if (e.disabled === true) return JSON.stringify({ ok: false, why: 'disabled' });
       e.click(); return JSON.stringify({ ok: true, text: (e.textContent||'').trim().slice(0,40) }); })()`,
  ).then(async (r) => {
    await H.sleep(waitMs);
    return r;
  });

const clickPathRow = (call, path, waitMs = 400) =>
  jev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('[data-compare-file-path-list] button'))
         .find(x => (x.textContent||'').includes(${JSON.stringify(path)}));
       if (!b) return JSON.stringify({ ok: false, why: 'no-row' });
       b.click(); return JSON.stringify({ ok: true }); })()`,
  ).then(async (r) => {
    await H.sleep(waitMs);
    return r;
  });

/** 用 store 动作写正文（与编辑器 onChange 同一实现；键盘面归 7.2） */
const writeDraftText = (call, key, text) =>
  H.storeQ(
    call,
    `${draftKeyExpr(key)}
     s.writeCallDraftText(key, ${JSON.stringify(text)});
     const e = s.callDraftOf(key);
     return JSON.stringify({ revision: e?.revision ?? null, len: e?.text?.length ?? null });`,
  );

const writeDraftNotes = (call, key, patch) =>
  H.storeQ(
    call,
    `${draftKeyExpr(key)}
     s.writeCallDraftNotes(key, ${JSON.stringify(patch)});
     const e = s.callDraftOf(key);
     return JSON.stringify({ revision: e?.revision ?? null,
       h: e?.hypothesis ?? null, a: e?.acceptanceCriterion ?? null });`,
  );

/**
 * 页内取 store 模块（dev specifier 两条形态都要试；reload 后 performance 时间线会被清空）。
 * 迟到类判据必须在**同一次页内求值**里既发请求又改状态，否则 node 侧往返就把窗口走完了。
 */
const STORE_GETTER = `(async () => {
  const all = performance.getEntriesByType('resource').map(e => e.name);
  const rank = (n) => (n.includes('?t=') ? 0 : n.includes('/@fs/') ? 2 : 1);
  const hit = all.filter(n => n.includes('/src/renderer/src/store.ts') || n.includes('/src/store.ts'))
    .sort((a, b) => rank(a) - rank(b))[0];
  if (hit !== undefined) return await import(hit);
  for (const u of ['/src/store.ts', '/src/renderer/src/store.ts']) {
    try { return await import(u); } catch (e) { /* 换下一条 */ }
  }
  throw new Error('store-module-not-found');
})()`;

const checkLabelExpr = `(() => { const b = document.querySelector('[data-isolated-prompt-check-button]');
  return b === null ? '' : (b.textContent || '').trim(); })()`;

/** 点核对并在页内确认「确实进入过在飞」，等它落定后返回耗时 */
const checkAndWait = (call) =>
  jev(
    call,
    `(async () => {
      const btn = document.querySelector('[data-isolated-prompt-check-button]');
      if (!btn) return JSON.stringify({ ok: false, why: 'no-check-button' });
      if (btn.disabled === true) return JSON.stringify({ ok: false, why: 'check-disabled', label: ${checkLabelExpr} });
      const t0 = performance.now();
      btn.click();
      let seenInFlight = false;
      for (;;) {
        if (!seenInFlight && ${checkLabelExpr}.includes('正在核对')) seenInFlight = true;
        const still = ${checkLabelExpr}.includes('正在核对');
        if (seenInFlight && !still) break;
        if (performance.now() - t0 > 30000) break;
        await new Promise((res) => setTimeout(res, 3));
      }
      return JSON.stringify({ ok: true, seenInFlight, elapsedMs: Math.round(performance.now() - t0) });
    })()`,
  );

/**
 * 「核对请求在飞时改草稿修订」——迟到核对的唯一有牙写法：
 * 同一个页内循环里点核对 → 下一个任务立刻 writeCallDraftText（真 store 动作，与 onChange 同源）
 * → 等核对落定。IPC 往返必然跨若干宏任务，因此改动作先于响应到达，属真实乱序而非脚本假设。
 */
const checkThenEdit = (call, key, text) =>
  jev(
    call,
    `(async () => {
      const btn = document.querySelector('[data-isolated-prompt-check-button]');
      if (!btn) return JSON.stringify({ ok: false, why: 'no-check-button' });
      const t0 = performance.now();
      btn.click();
      let seenInFlight = false;
      let editedAtMs = null;
      let revisionAfterEdit = null;
      for (;;) {
        if (!seenInFlight && ${checkLabelExpr}.includes('正在核对')) {
          seenInFlight = true;
          const m = await ${STORE_GETTER};
          const st = m.useAppStore.getState();
          const key = { runId: ${JSON.stringify(key.runId)}, spanId: ${JSON.stringify(key.spanId)},
            field: ${JSON.stringify(key.field)}, mode: ${JSON.stringify(key.mode ?? "isolated")} };
          st.writeCallDraftText(key, ${JSON.stringify(text)});
          revisionAfterEdit = st.callDraftOf(key).revision;
          editedAtMs = Math.round(performance.now() - t0);
        }
        if (seenInFlight && !${checkLabelExpr}.includes('正在核对')) break;
        if (performance.now() - t0 > 30000) break;
        await new Promise((res) => setTimeout(res, 3));
      }
      return JSON.stringify({ ok: true, seenInFlight, editedAtMs, revisionAfterEdit,
        elapsedMs: Math.round(performance.now() - t0) });
    })()`,
  );

/** 哨兵 reload：证明文档真的换了（UI-VERIFY：Page.reload 偶发不换文档 ⇒ 判据会凭空成立） */
const reloadWithProof = async (call, timeoutMs = 90000) => {
  await call("Runtime.evaluate", { expression: "window.__r2273Doc = (window.__r2273Doc ?? 0) + 1;" });
  await call("Page.addScriptToEvaluateOnNewDocument", {
    source: "window.__r2273Nav = Date.now();",
  });
  await call("Page.reload", { ignoreCache: false });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const alive = await jev(
      call,
      `(() => JSON.stringify({ nav: window.__r2273Nav ?? null, docs: window.__r2273Doc ?? null,
        runs: (document.body.innerText || '').length }))()`,
    ).catch(() => null);
    if (alive !== null && alive.nav != null && alive.docs === null) {
      const n = await H.storeQ(call, "return JSON.stringify({ runs: s.runs.length });").catch(() => null);
      if (n !== null && n.runs > 0) return { ...alive, runs: n.runs };
    }
    if (Date.now() > deadline) throw new Error(`reload 后 90s 未证明换文档：${JSON.stringify(alive)}`);
    await H.sleep(800);
  }
};

const compareState = (call) =>
  jev(
    call,
    `(() => JSON.stringify({
       fileView: !!document.querySelector('[data-compare-files-view]'),
       leftCp: document.querySelector('[data-compare-file-checkpoint="left"]')?.value ?? null,
       rightCp: document.querySelector('[data-compare-file-checkpoint="right"]')?.value ?? null,
       manifestLoading: (document.body.innerText || '').includes('正在读取两侧清单'),
       pairHead: Array.from(document.querySelectorAll('[data-compare-files-view] span'))
          .map(s => (s.textContent || '').trim()).find(t => t.startsWith('左侧')) ?? '',
       rows: Array.from(document.querySelectorAll('[data-compare-file-path-list] button'))
          .map(b => ({ pressed: b.getAttribute('aria-pressed') === 'true',
                       text: (b.textContent||'').replace(/\\s+/g,' ').trim().slice(0,80) })),
       bodyLoading: (document.querySelector('[data-compare-files-view]')?.innerText || '').includes('正在按路径核验两侧正文'),
       pathTitle: (document.querySelector('[data-compare-files-view] .font-code')?.textContent ?? '').trim(),
       conclusion: document.querySelector('[data-compare-file-conclusion]')?.getAttribute('data-compare-file-conclusion') ?? null,
       sideLabels: Array.from(document.querySelectorAll('[data-compare-files-view] [data-compare-file-side-body]'))
          .map(el => (el.innerText || '').replace(/\\s+/g,' ').trim().slice(0,120)),
       identityHead: (document.querySelector('[data-compare-file-conclusion]')?.closest('div')?.parentElement?.innerText ?? '')
          .replace(/\\s+/g,' ').trim().slice(0,320),
       error: (document.querySelector('[data-compare-file-error]')?.textContent ?? '').replace(/\\s+/g,' ').trim().slice(0,160),
     }))()`,
  );

const shot = (call, name) => {
  if (!existsSync(SHOTS)) {
    try {
      require("node:fs").mkdirSync(SHOTS, { recursive: true });
    } catch {
      /* 忽略 */
    }
  }
  return H.call0(call, "Page.captureScreenshot", { format: "png" })
    .then(({ data }) => {
      const f = join(SHOTS, `r2273-${name}.png`);
      writeFileSync(f, Buffer.from(data, "base64"));
      console.log(`  [截图] ${f}`);
      return f;
    })
    .catch(() => null);
};

/** 比较文件视图：打开双运行比较并进入文件视图（默认各取最近自有完成步骤） */
const openCompareFiles = async (call, leftRunId, rightRunId) => {
  const opened = await H.storeQ(
    call,
    `const r = await s.openComparePair(${JSON.stringify(leftRunId)}, ${JSON.stringify(rightRunId)});
     s.openCompareFileView();
     return JSON.stringify({ pairResult: r });`,
  );
  const deadline = Date.now() + 60000;
  for (;;) {
    const st = await compareState(call);
    if (st.fileView === true && st.rows.length > 0) return { ...opened, st };
    if (Date.now() > deadline) return { ...opened, st, timedOut: true };
    await H.sleep(900);
  }
};

/** 页内点路径行（不等 node 往返，保证切换落在同一个事件循环里） */
const clickRowInPage = `(() => { const rows = (p) => Array.from(document.querySelectorAll('[data-compare-file-path-list] button'))
    .find(x => (x.textContent || '').includes(p));
  return (p) => { const b = rows(p); if (!b) return false; b.click(); return true; }; })()`;

const bodyLoadingInPage = `(() => { const v = document.querySelector('[data-compare-files-view]');
  return v === null ? false : (v.innerText || '').includes('正在按路径核验两侧正文'); })()`;

/**
 * 单独读一条路径的**真实在飞时长**（迟到判据的量尺）：
 * 点行 → 页内轮询 loading 文案出现与消失。seenLoading=false 说明窗口采不到，判据不得写死。
 */
const measureRead = (call, path, timeoutMs = 60000) =>
  jev(
    call,
    `(async () => {
      const click = ${clickRowInPage};
      const loading = () => ${bodyLoadingInPage};
      const t0 = performance.now();
      if (!click(${JSON.stringify(path)})) return JSON.stringify({ ok: false, why: 'no-row' });
      let seenLoading = false;
      let seenAtMs = null;
      for (;;) {
        if (!seenLoading && loading()) { seenLoading = true; seenAtMs = Math.round(performance.now() - t0); }
        if (seenLoading && !loading()) break;
        if (!seenLoading && performance.now() - t0 > 1500) break;
        if (performance.now() - t0 > ${timeoutMs}) break;
        await new Promise((res) => setTimeout(res, 2));
      }
      return JSON.stringify({ ok: true, seenLoading, seenAtMs, totalMs: Math.round(performance.now() - t0) });
    })()`,
  );

/**
 * 真实的响应交错：点慢路径 → 页内确认进入 loading → 立刻切到快路径。
 * 只要 swapAtMs < 慢路径单独读取时长，慢响应**必然**在切换之后才落地；
 * 该时长由同 tag 的 measureRead 量出，不靠脚本假设。
 */
const raceSwitch = (call, slowPath, fastPath) =>
  jev(
    call,
    `(async () => {
      const click = ${clickRowInPage};
      const loading = () => ${bodyLoadingInPage};
      const t0 = performance.now();
      if (!click(${JSON.stringify(slowPath)})) return JSON.stringify({ ok: false, why: 'no-slow-row' });
      let seenLoading = false;
      let swapAtMs = null;
      for (;;) {
        if (loading()) { seenLoading = true; break; }
        if (performance.now() - t0 > 4000) break;
        await new Promise((res) => setTimeout(res, 2));
      }
      if (!seenLoading) return JSON.stringify({ ok: true, seenLoading: false, swapAtMs: null, totalMs: Math.round(performance.now() - t0) });
      const swapped = click(${JSON.stringify(fastPath)});
      swapAtMs = Math.round(performance.now() - t0);
      for (;;) {
        if (!loading()) break;
        if (performance.now() - t0 > 60000) break;
        await new Promise((res) => setTimeout(res, 5));
      }
      return JSON.stringify({ ok: true, seenLoading, swapped, swapAtMs, totalMs: Math.round(performance.now() - t0) });
    })()`,
  );

/** diff 编辑器的模型读数（DOM 视口行会被虚拟滚动裁掉，判 model 不判 DOM） */
const diffModelsOnce = (call) =>
  H.appImport(
    call,
    H.MONACO_NEEDLE,
    `const monaco = await m.ensureMonaco();
     const diffs = monaco.editor.getDiffEditors ? monaco.editor.getDiffEditors() : [];
     const d = diffs[0] ?? null;
     if (d === null) return JSON.stringify({ ok: false, why: 'no-diff-editor' });
     const txt = (e) => { const md = e.getModel(); return md === null ? null : md.getValue(); };
     return JSON.stringify({ ok: true, original: txt(d.getOriginalEditor()), modified: txt(d.getModifiedEditor()),
       target: document.querySelector('[data-monaco-target]')?.getAttribute('data-monaco-target') ?? null,
       lineChanges: (d.getLineChanges() ?? []).length });`,
  );

/**
 * 轮询到 diff 编辑器就绪（Monaco 懒挂载 + 大文件首帧未布局，单次读数会拿到 no-diff-editor）。
 * 面板确实不在场（不可用侧不生成伪 diff）时按预算如实返回 ok:false。
 */
const diffModels = async (call, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await diffModelsOnce(call);
    if (r.ok === true) return r;
    if (Date.now() > deadline) return r;
    await H.sleep(900);
  }
};

/** 改一侧检查点（React 受控 select：原生 setter + change 事件） */
const setCheckpoint = (call, side, value) =>
  jev(
    call,
    `(() => { const el = document.querySelector('[data-compare-file-checkpoint=${JSON.stringify(side)}]');
       if (!el) return JSON.stringify({ ok: false, why: 'no-select' });
       Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
       el.dispatchEvent(new Event('change', { bubbles: true }));
       return JSON.stringify({ ok: true, value: el.value }); })()`,
  );

/** 费用确认 → 本次副本授权 → 提交（三连，全部真按钮点击） */
const confirmAuthorizeSubmit = async (call, { authorize = true, submit = true } = {}) => {
  const fee = await clickSelector(call, "[data-confirm-execution]", 900);
  const pressed = await jev(call, `(() => document.querySelector('[data-confirm-execution]')?.getAttribute('aria-pressed') ?? null)()`);
  let auth = null;
  if (authorize) {
    auth = await jev(
      call,
      `(() => { const i = document.querySelector('[data-isolated-writes-authorization] input');
         if (!i) return JSON.stringify({ ok: false, why: 'no-auth' });
         if (i.disabled === true) return JSON.stringify({ ok: false, why: 'auth-disabled' });
         i.click(); return JSON.stringify({ ok: true, checked: i.checked }); })()`,
    );
    await H.sleep(900);
  }
  let sent = null;
  if (submit) {
    sent = await jev(
      call,
      `(() => { const btn = document.querySelector('[data-isolated-prompt-submit-button]');
         if (!btn) return JSON.stringify({ ok: false, why: 'no-submit' });
         if (btn.disabled === true) return JSON.stringify({ ok: false, why: 'submit-disabled',
           state: (document.querySelector('[data-isolated-prompt-submit-state]')?.textContent ?? '').trim().slice(0,180) });
         btn.click(); return JSON.stringify({ ok: true }); })()`,
    );
  }
  return { fee, pressed, auth, sent };
};

/** 等正文读取落定（在飞文案消失），返回最终现场 */
const waitBodySettled = async (call, timeoutMs = 45000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await compareState(call);
    if (st.bodyLoading === false && st.manifestLoading === false) return st;
    if (Date.now() > deadline) return st;
    await H.sleep(700);
  }
};

/** 等一条新 trace 落盘并封存（返回 id 与逐行事实） */
const waitChildSealed = async (call, traceBase, timeoutMs = 120000) => {
  const deadline = Date.now() + timeoutMs;
  let id = null;
  for (;;) {
    const added = [...H.traceIds()].filter((x) => !traceBase.has(x)).sort();
    if (added.length > 0) id = added[0];
    if (id !== null) {
      const file = join(TRACES, `${id}.jsonl`);
      if (existsSync(file)) {
        const lines = readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
        const terminal = lines.find((l) => l.type === "run.event" || l.event !== undefined);
        if (terminal !== undefined) return { id, lines, terminal, added };
      }
    }
    if (Date.now() > deadline) return { id, lines: null, terminal: null, added, timedOut: true };
    await H.sleep(800);
  }
};

module.exports = {
  H,
  REPO,
  OUT,
  DATA,
  TRACES,
  BLOBS,
  SHOTS,
  seed,
  sha256File,
  fingerprint,
  diffFingerprint,
  onlyNewRunChanges,
  makeHandle,
  drainActive,
  hiddenResidue,
  jev,
  draftState,
  editorState,
  execState,
  operationsStatus,
  rawIpc,
  currentEpoch,
  selectRunAndOverview,
  clickSelector,
  clickPathRow,
  writeDraftText,
  writeDraftNotes,
  checkAndWait,
  checkThenEdit,
  reloadWithProof,
  compareState,
  openCompareFiles,
  measureRead,
  raceSwitch,
  diffModels,
  waitBodySettled,
  setCheckpoint,
  confirmAuthorizeSubmit,
  waitChildSealed,
  shot,
};
