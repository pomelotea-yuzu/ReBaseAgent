/**
 * U2 任务 5.3：文件/步骤/运行/分支/设置往返、长正文滚动及显式定位。
 *
 * 覆盖（spec 四场景）：
 *   ① 文件页签往返恢复阅读 —— 在第 N 轮选内容模式 + 滚到长正文中部 → 文件→步骤→文件 后
 *      恢复检查点/路径/模式/搜索筛选/布局偏好**与列表/正文位置**（组件卸载不回初始）。
 *   ② 跨运行和辅助视图返回恢复文件 —— A 文件页 → B → 回 A（含经**分支树/设置**返回），
 *      A/B 各有同名 step/path ⇒ 各自保持自己的检查点与阅读位置，普通返回不消费显式目标。
 *   ③ 显式文件定位覆盖历史 —— 从**当前运行的自有步骤**打开该轮文件：定位该轮末而**不是**
 *      历史检查点；带 path 的显式目标显示内容并**解除阻挡它的搜索筛选**；无 path 时显示未选列表。
 *   ④ 失效检查点和路径安全回退 —— 失效检查点提示并回清理、失效 path 提示并清空选择显示列表，
 *      且**不借用**祖先 / 另一运行 / 同名路径。
 *
 * ⚠️ 与 5.1/5.2 同纪律：
 *   - 禁用 `Emulation.setDeviceMetricsOverride`（破坏 Monaco automaticLayout）。
 *   - 脚本不 spawn、不改窗、不重启 dev；窗口尺寸由 PowerShell 工具设定。
 *   - 全部断言来自**真机真交互**（真点击 / 真滚轮 / 真键盘）+ 真 store 读取；
 *     不使用静态结构测试替代点击与内容核对。
 *
 * 两条读取通道（均不改产品代码）：
 *   - **DOM**：可见行号、滚动条比例、列表 scrollTop、页签/按钮/失效提示的真渲染结果；
 *   - **store**（仅 dev）：从 `performance` 资源表解析出应用**自己用过的模块 URL**
 *     （`…/src/renderer/src/store.ts?t=<ts>`）再 `import()` 同一 URL，直接读 `readingByRun`
 *     —— 这是"位置真的被记住了"的权威证据（DOM 只证明"看得见"）。
 *     ⚠️ **不可**写 `import('/src/store.ts')`：模块身份 = 完整 URL，那会拿到另一份空 store
 *     （`byRunKeys === []`）⇒ 全是默认值且不报错，属假阴性（2026-09-23 实测踩坑）。
 *
 * 用法（每次一个 tag）：
 *   node apps/desktop/scripts/u2-53-cdp.cjs --tag=probe
 *   node apps/desktop/scripts/u2-53-cdp.cjs --tag=roundtrip
 *   node apps/desktop/scripts/u2-53-cdp.cjs --tag=cross-run
 *   node apps/desktop/scripts/u2-53-cdp.cjs --tag=explicit
 *   node apps/desktop/scripts/u2-53-cdp.cjs --tag=fallback
 *   node apps/desktop/scripts/u2-53-cdp.cjs --tag=search-hidden
 */
"use strict";

const { mkdirSync, writeFileSync, readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { REPO, sleep, cdpConnect, makeSession, ev, shot } = require("./lib/u2-cdp-util.cjs");

const PORT = 9612;
const OUT_DIR = join(REPO, ".workbuddy", "u2-53");
const SHOT_DIR = join(REPO, "docs", "reviews", "2026-09-23-u2-53");
const OUT = join(OUT_DIR, "measurements.json");

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag", "roundtrip");

/** 夹具（U2 iso 数据，真实引擎产物；见 .rebaseagent/u2-file-fixtures/iso-data） */
const ROOT_RUN = "run_mudwrlbg_199xw1"; // 根 run：3 轮
const FORK_RUN = "run_mudwrlgl_93di"; // 一次分叉：2 轮（与根 run 同名 a.txt/keep.txt）
const ERRORED_RUN = "run_mudwrlhv_jvqf9c"; // errored：仍有 2 个自有完成步骤
const LONG_FILE = "long.txt"; // 200 行中文 + 两条 400 字符超长行
const SHORT_FILE = "a.txt";

const checks = [];
function check(name, ok, detail) {
  checks.push({ name: `[${TAG}] ${name}`, ok: !!ok, detail: detail ?? null });
}
function loadOut() {
  if (!existsSync(OUT)) return { tag: "u2-5.3", measurements: {}, checks: [] };
  return JSON.parse(readFileSync(OUT, "utf8"));
}
function saveOut(d) {
  d.capturedAt = new Date().toISOString();
  writeFileSync(OUT, JSON.stringify(d, null, 2));
}

// —— 表达式 ——

/** 异步求值（store 的动态 import 需要 awaitPromise） */
async function evAsync(call, expression) {
  const r = await call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r?.exceptionDetails) {
    throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
  }
  return r?.result?.value;
}

/**
 * 读该 run 的文件阅读状态（权威：位置是否真的被记住）。
 *
 * ⚠️ 2026-09-23 实机踩坑：**不能**写 `import('/src/store.ts')`。
 *   实测 `location.href = http://localhost:5173/`，而应用真正持有的模块 URL 是
 *   `http://localhost:5173/@fs/D:/ReBaseAgent/apps/desktop/src/renderer/src/store.ts?t=<ts>`
 *   （electron-vite 把 root 指到别处 ⇒ `/src/...` 是**另一份**模块图）。
 *   ES 模块身份 = **完整 URL（含查询串）**，所以按 `/src/...` 导进来的是**另一份空 store**
 *   （`readingByRun === {}`）⇒ 读出全是默认值，且**不报错**——典型假阴性。
 *   故本函数**先从 `performance` 资源表里解析出应用自己用过的 URL**（含 `?t=` 版本戳），
 *   再按同一 URL 导入，保证拿到同一实例。
 */
async function storeState(call, runId) {
  const raw = await evAsync(
    call,
    `(async () => {
      const pick = (file) => {
        const names = performance.getEntriesByType('resource').map(e => e.name)
          .filter(n => n.includes('/src/renderer/src/' + file));
        return names.find(n => n.includes('?t=')) ?? names[0] ?? null;
      };
      const storeUrl = pick('store.ts');
      const rsUrl = pick('lib/reading-state.ts');
      if (storeUrl === null || rsUrl === null) {
        return JSON.stringify({ error: 'module-url-not-found', storeUrl, rsUrl });
      }
      const m = await import(storeUrl);
      const rs = await import(rsUrl);
      const st = m.useAppStore.getState();
      const r = rs.readingStateOf(st.readingByRun, ${JSON.stringify(runId)});
      const f = rs.fileReadingOf(r);
      return JSON.stringify({
        moduleUrl: storeUrl,
        tab: r.tab, spanId: r.spanId,
        checkpoint: f.checkpoint, path: f.path, pane: f.pane,
        query: f.query, filter: f.filter,
        wordWrap: f.wordWrap, diffPreference: f.diffPreference,
        directoryWidth: f.directoryWidth, directoryCollapsed: f.directoryCollapsed,
        listScrollTop: f.listScrollTop, contentScroll: f.contentScroll,
        pendingFileTarget: st.pendingFileTarget, selectedRunId: st.selectedRunId,
        // 诊断：非空即证明拿到了应用同一实例（写入过的 run 一定在键里）
        byRunKeys: Object.keys(st.readingByRun),
      });
    })()`,
  );
  return JSON.parse(raw);
}

/** 调用真实 store 动作（与「打开该轮文件」同一 API 的另一形态） */
async function callStoreAction(call, body) {
  const raw = await evAsync(
    call,
    `(async () => {
      const names = performance.getEntriesByType('resource').map(e => e.name)
        .filter(n => n.includes('/src/renderer/src/store.ts'));
      const storeUrl = names.find(n => n.includes('?t=')) ?? names[0];
      if (storeUrl === undefined) return JSON.stringify({ error: 'module-url-not-found' });
      const m = await import(storeUrl);
      ${body}
      return JSON.stringify({ ok: true });
    })()`,
  );
  return JSON.parse(raw);
}

/** DOM 快照：只读**真渲染结果**（可见行、滚动条、列表 scrollTop、页签、提示文案） */
const domExpr = `(() => {
  const q = (s, r = document) => r.querySelector(s);
  const txt = (e) => ((e && e.textContent) || '').trim();
  const listEl = q('[data-list-scroll-top]');
  const mono = q('.monaco-diff-editor');
  let firstLine = null, sliderRatio = null, lineCount = null;
  if (mono) {
    const mod = Array.from(mono.querySelectorAll('.editor')).find(e => e.className.includes('modified'));
    if (mod) {
      const box = mod.getBoundingClientRect();
      const nums = Array.from(mod.querySelectorAll('.margin-view-overlays .line-numbers'))
        .map(e => ({ n: Number(txt(e)), top: e.getBoundingClientRect().top - box.top }))
        .filter(x => Number.isFinite(x.n));
      lineCount = nums.length;
      const below = nums.filter(x => x.top >= -1).sort((a, b) => a.top - b.top);
      firstLine = below.length ? below[0].n : (nums.length ? Math.min(...nums.map(x => x.n)) : null);
      const track = mod.querySelector('.scrollbar.vertical');
      const slider = track ? track.querySelector('.slider') : null;
      if (track && slider) {
        const t = track.getBoundingClientRect(), s = slider.getBoundingClientRect();
        const span = t.height - s.height;
        sliderRatio = span > 0 ? +((s.top - t.top) / span).toFixed(4) : 0;
      }
    }
  }
  const filterBtns = Array.from(document.querySelectorAll('button'))
    .filter(b => ['自动', '全部', '有变化'].includes(txt(b)))
    .map(b => ({ label: txt(b), active: b.className.includes('bg-violet-600') }));
  const ckpts = Array.from(document.querySelectorAll('button'))
    .filter(b => (b.title || '').includes('检查点所属 step') || (b.title || '').includes('文件世界起点'))
    .map(b => ({ label: txt(b), active: b.className.includes('bg-violet-600') }));
  const body = document.body.textContent || '';
  return JSON.stringify({
    cw: document.documentElement.clientWidth, ch: document.documentElement.clientHeight,
    iw: innerWidth, ih: innerHeight, dpr: +devicePixelRatio.toFixed(2),
    tabSelected: txt(Array.from(document.querySelectorAll('[role="tab"]'))
      .find(t => t.getAttribute('aria-selected') === 'true')),
    hasMonaco: !!mono, firstLine, lineCount, sliderRatio,
    listScrollActual: listEl ? Math.round(listEl.scrollTop) : null,
    listScrollHeight: listEl ? listEl.scrollHeight : null,
    listClientHeight: listEl ? listEl.clientHeight : null,
    listDataScrollTop: listEl ? Number(listEl.getAttribute('data-list-scroll-top')) : null,
    // 列表是否**真的可见**（display:none / visibility:hidden 下 getClientRects() 为空）
    // ⚠️ 不能只看 querySelector 有没有元素：隐藏元素照样能被选到（会假通过）
    listVisible: listEl ? listEl.getClientRects().length > 0 : false,
    fileOptions: Array.from(document.querySelectorAll('[role="option"][data-file-path]'))
      .map(e => e.getAttribute('data-file-path')),
    selectedFile: (() => { const e = q('[role="option"][aria-selected="true"]'); return e ? e.getAttribute('data-file-path') : null; })(),
    query: (() => { const i = q('input[aria-label="按完整路径搜索文件"]'); return i ? i.value : null; })(),
    filterBtns,
    ckpts,
    stepFilesBtn: !!Array.from(document.querySelectorAll('button')).find(b => txt(b) === '打开该轮文件'),
    ckptInvalidNote: body.includes('已不属于本'),
    pathInvalidNote: body.includes('不在所选清单里'),
    noSelectionHint: body.includes('从左侧选择一个文件查看内容'),
  });
})()`;

async function dom(call) {
  return JSON.parse(await ev(call, domExpr));
}

/** 读运行列表（含每个 run 的描述，用于确认干系） */
const RUNS_EXPR = `(() => JSON.stringify(Array.from(document.querySelectorAll('button'))
  .map(b => b.getAttribute('aria-label') || '')
  .filter(a => a.startsWith('复制完整运行 ID'))
  .map(a => a.replace('复制完整运行 ID ', ''))))()`;

async function runs(call) {
  return JSON.parse(await ev(call, RUNS_EXPR));
}

/**
 * 选中一个 run。
 *
 * ⚠️ 本机 1210 档（medium 960–1279）下，**文件页会暂时收起运行导航**（design D2：
 *    「文件页或编辑态抢占宽度 ⇒ 暂时收起导航」）⇒ 运行列表行根本不在 DOM 里。
 *    真实用户的可行路径是**先回「概览」**（概览档导航恢复）再选另一个 run。
 *    这是产品既有的布局纪律，不是缺陷；脚本按同一路径走，并如实记录是否绕行。
 */
async function selectRun(call, id) {
  const hitRow = `(() => {
      const copy = Array.from(document.querySelectorAll('button'))
        .find(b => (b.getAttribute('aria-label') || '').startsWith('复制完整运行 ID ${id}'));
      if (!copy) return false;
      const row = copy.parentElement;
      const sel = row ? row.querySelector('button') : null;
      if (!sel) return false;
      sel.click(); return true; })()`;

  let ok = await ev(call, hitRow);
  let detour = false;
  if (ok !== true) {
    detour = await clickTab(call, "概览");
    ok = await ev(call, hitRow);
  }
  if (ok === true) await sleep(1600);
  return { ok: ok === true, detour };
}

async function clickTab(call, label) {
  const ok = await ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('[role="tab"]'))
      .find(x => ((x.textContent||'').trim()) === '${label}');
      if (!b) return false; b.click(); return true; })()`,
  );
  if (ok === true) await sleep(1200);
  return ok === true;
}

async function clickByText(call, text, wait = 500) {
  const ok = await ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
      .find(x => ((x.textContent||'').trim()) === '${text}');
      if (!b) return false; b.click(); return true; })()`,
  );
  if (ok === true) await sleep(wait);
  return ok === true;
}

async function clickByAria(call, aria, wait = 400) {
  const ok = await ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
      .find(x => x.getAttribute('aria-label') === '${aria}');
      if (!b) return false; b.click(); return true; })()`,
  );
  if (ok === true) await sleep(wait);
  return ok === true;
}

/** 选中第 n 个检查点（0 = 初始；-1 = 最后一个） */
async function pickCheckpoint(call, index) {
  const ok = await ev(
    call,
    `(() => { const c = Array.from(document.querySelectorAll('button'))
        .filter(b => (b.title || '').includes('检查点所属 step') || (b.title || '').includes('文件世界起点'));
      const t = ${index} < 0 ? c[c.length + ${index}] : c[${index}];
      if (!t) return false; t.click(); return true; })()`,
  );
  if (ok === true) await sleep(1500);
  return ok === true;
}

/**
 * 点变化筛选（自动/全部/有变化）。
 *
 * ⚠️ 5.2 README 陷阱⑤的同一形态：检查点默认 `auto` 在**完成步骤**解析为 `changed`，
 *    未被该轮改动的文件（如长正文夹具 `long.txt`）不在清单里 ⇒ 必须先点「全部」，
 *    否则 `pickFile` 永远找不到目标（不是产品缺陷，是验收前置）。
 */
async function pickFilter(call, label) {
  const ok = await ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()) === '${label}');
      if (!b) return false; b.click(); return true; })()`,
  );
  if (ok === true) await sleep(900);
  return ok === true;
}

/** 选定文件（目录不常驻时先切到列表 pane；再切回内容） */
async function pickFile(call, path) {
  let hit = await ev(
    call,
    `(() => { const b = document.querySelector('[role="option"][data-file-path="${path}"]');
      if (!b) return false; b.click(); return true; })()`,
  );
  if (hit !== true) {
    await clickByAria(call, "显示文件列表");
    hit = await ev(
      call,
      `(() => { const b = document.querySelector('[role="option"][data-file-path="${path}"]');
        if (!b) return false; b.click(); return true; })()`,
    );
  }
  if (hit === true) {
    await sleep(1500);
    // 回到内容侧（目录常驻时该按钮不存在，pane 已是并排）
    await clickByAria(call, "显示文件内容", 900);
  }
  return hit === true;
}

/** 真滚轮：在编辑器中心滚 deltaY（真用户手势，不是改 scrollTop） */
async function wheelEditor(call, deltaY, steps = 3) {
  const box = await ev(
    call,
    `(() => { const m = document.querySelector('.monaco-diff-editor');
      if (!m) return null; const r = m.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + r.width * 0.6), y: Math.round(r.top + r.height * 0.5) }); })()`,
  );
  if (box === null) return false;
  const { x, y } = JSON.parse(box);
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  for (let i = 0; i < steps; i++) {
    await call("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: 0,
      deltaY: Math.round(deltaY / steps),
    });
    await sleep(220);
  }
  await sleep(500);
  return true;
}

/** 在文件列表里真滚轮 */
async function wheelList(call, deltaY) {
  const box = await ev(
    call,
    `(() => { const el = document.querySelector('[data-list-scroll-top]');
      if (!el) return null; const r = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * 0.7) }); })()`,
  );
  if (box === null) return false;
  const { x, y } = JSON.parse(box);
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  await call("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
  await sleep(600);
  return true;
}

/** 设置搜索词（真输入：聚焦 + 逐字 Input.insertText） */
async function typeQuery(call, text) {
  const ok = await ev(
    call,
    `(() => { const i = document.querySelector('input[aria-label="按完整路径搜索文件"]');
      if (!i) return false; i.focus(); return document.activeElement === i; })()`,
  );
  if (ok !== true) return false;
  await ev(
    call,
    `(() => { const i = document.querySelector('input[aria-label="按完整路径搜索文件"]');
    if (!i) return false; i.select(); return true; })()`,
  );
  await call("Input.insertText", { text });
  await sleep(700);
  return true;
}

async function key(call, k, code, vkCode, wait = 250) {
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: k,
    code,
    windowsVirtualKeyCode: vkCode,
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: k,
    code,
    windowsVirtualKeyCode: vkCode,
  });
  await sleep(wait);
}

/** 进入某 run 的文件页（可选指定检查点索引；filterLabel 非空则先点该筛选） */
async function enterFiles(call, runId, ckptIndex = -1, filterLabel = null) {
  const m = {};
  m.runAvailable = (await runs(call)).includes(runId);
  if (!m.runAvailable) return m;
  const picked = await selectRun(call, runId);
  m.selected = picked.ok;
  m.selectDetour = picked.detour;
  m.filesTab = await clickTab(call, "文件");
  if (ckptIndex !== null) m.ckpt = await pickCheckpoint(call, ckptIndex);
  if (filterLabel !== null) m.filter = await pickFilter(call, filterLabel);
  await assertStoreLive(call, runId);
  return m;
}

/**
 * **store 通道自检**：确认读到的就是应用的活实例、且确实记录了本轮进入。
 *
 * 为什么必须显式自检：模块实例拿错时**不会报错**，只会静默返回默认值
 * ⇒ 所有基于 store 的断言都会变成"看起来断言了其实读的是常量"的假阴性。
 */
async function assertStoreLive(call, runId) {
  const s = await storeState(call, runId);
  if (s.error !== undefined) {
    throw new Error(`store 探针失败：${JSON.stringify(s)}`);
  }
  if (!Array.isArray(s.byRunKeys) || !s.byRunKeys.includes(runId)) {
    throw new Error(
      `store 探针未拿到应用同一实例（byRunKeys=${JSON.stringify(s.byRunKeys)}，` +
        `moduleUrl=${s.moduleUrl}）——拒绝继续，避免假阴性`,
    );
  }
  if (s.selectedRunId !== runId || s.tab !== "files") {
    throw new Error(
      `store 自检不符：selectedRunId=${s.selectedRunId} tab=${s.tab}（期望 ${runId} / files）`,
    );
  }
  return s;
}

/** 顶部导航：切到分支树视图 */
async function gotoTrees(call) {
  const ok = await ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
      .find(x => (x.textContent||'').trim() === '分支树'); if (!b) return false; b.click(); return true; })()`,
  );
  await sleep(1200);
  return ok === true;
}
async function gotoTrace(call) {
  const ok = await ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
      .find(x => (x.textContent||'').trim() === '轨迹'); if (!b) return false; b.click(); return true; })()`,
  );
  await sleep(1500);
  return ok === true;
}
async function openSettingsAndClose(call) {
  const opened = await ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
      .find(x => (x.textContent||'').trim() === '设置'); if (!b) return false; b.click(); return true; })()`,
  );
  await sleep(900);
  const closed = await ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
      .find(x => x.getAttribute('aria-label') === '关闭'); if (!b) return false; b.click(); return true; })()`,
  );
  await sleep(900);
  return { opened: opened === true, closed: closed === true };
}

// —— 场景 ——

/**
 * ① 文件页签往返恢复阅读（含长正文滚动 + 列表滚动）。
 */
async function scenarioRoundtrip(call) {
  const m = {};
  // 必须点「全部」：默认 `auto` 在完成步骤解析为 `changed`，而长正文夹具在该轮未被改动
  // ⇒ 不切「全部」则清单里根本没有 long.txt（5.2 陷阱⑤的同一形态，属验收前置而非缺陷）
  Object.assign(m, await enterFiles(call, ROOT_RUN, -1, "全部"));
  m.open = await pickFile(call, LONG_FILE);
  m.afterOpen = await dom(call);
  m.storeAfterOpen = await storeState(call, ROOT_RUN);

  // 长正文滚动：真滚轮滚到中部
  m.wheelOk = await wheelEditor(call, 2400, 4);
  m.afterScroll = await dom(call);
  m.storeAfterScroll = await storeState(call, ROOT_RUN);

  // 列表也滚一下（长清单才滚得动；夹具清单短时 scrollHeight≈clientHeight ⇒ 位置恒 0）
  m.listWheelOk = await wheelList(call, 400);

  await shot(call, SHOT_DIR, `${TAG}-1-滚动后.png`);

  check(
    "长正文真的滚动过（首个可见行 > 1，不是停在顶部）",
    (m.afterScroll.firstLine ?? 1) > 1,
    `firstLine=${m.afterScroll.firstLine}`,
  );
  check(
    "正文位置写进会话状态（contentScroll 记的是行号 + 偏移，且属于当前 step/path）",
    m.storeAfterScroll.contentScroll !== null &&
      m.storeAfterScroll.contentScroll.path === LONG_FILE &&
      m.storeAfterScroll.contentScroll.stepSpanId === m.storeAfterScroll.checkpoint &&
      m.storeAfterScroll.contentScroll.line > 1,
    JSON.stringify(m.storeAfterScroll.contentScroll),
  );
  check(
    "滚动后 store 的可见行与 DOM 一致（不是各说各话）",
    Math.abs((m.storeAfterScroll.contentScroll?.line ?? 0) - (m.afterScroll.firstLine ?? -1)) <= 1,
    `store.line=${m.storeAfterScroll.contentScroll?.line} dom.firstLine=${m.afterScroll.firstLine}`,
  );

  // 往返：文件 → 步骤 → 文件
  m.toSteps = await clickTab(call, "步骤");
  m.inSteps = await dom(call);
  m.storeInSteps = await storeState(call, ROOT_RUN);
  await shot(call, SHOT_DIR, `${TAG}-2-步骤页.png`);
  m.toFiles = await clickTab(call, "文件");
  await sleep(1400);
  m.afterBack = await dom(call);
  m.storeAfterBack = await storeState(call, ROOT_RUN);
  await shot(call, SHOT_DIR, `${TAG}-3-返回文件页.png`);

  check(
    "往返后回到文件页（页签与内容都在）",
    m.afterBack.tabSelected === "文件",
    m.afterBack.tabSelected,
  );
  check(
    "往返后恢复检查点与路径（不是回到默认）",
    m.storeAfterBack.checkpoint === m.storeAfterScroll.checkpoint &&
      m.storeAfterBack.path === LONG_FILE,
    `ckpt ${m.storeAfterBack.checkpoint} vs ${m.storeAfterScroll.checkpoint}; path=${m.storeAfterBack.path}`,
  );
  check(
    "往返后恢复模式与布局偏好（pane / wordWrap / diffPreference / 目录宽）",
    m.storeAfterBack.pane === m.storeAfterScroll.pane &&
      m.storeAfterBack.wordWrap === m.storeAfterScroll.wordWrap &&
      m.storeAfterBack.diffPreference === m.storeAfterScroll.diffPreference &&
      m.storeAfterBack.directoryWidth === m.storeAfterScroll.directoryWidth,
    `pane=${m.storeAfterBack.pane} wordWrap=${m.storeAfterBack.wordWrap} diff=${m.storeAfterBack.diffPreference} dirW=${m.storeAfterBack.directoryWidth}`,
  );
  check(
    "往返后**正文位置真的恢复**（首可见行回到原处，容差 2 行）",
    Math.abs((m.afterBack.firstLine ?? -999) - (m.afterScroll.firstLine ?? 0)) <= 2,
    `before=${m.afterScroll.firstLine} after=${m.afterBack.firstLine}（容差 2 行）`,
  );
  check(
    "往返后**列表位置也恢复**（store 值与 DOM 实测一致；清单不足一屏时为 0 并如实标注）",
    m.afterBack.listDataScrollTop === m.storeAfterBack.listScrollTop &&
      (m.storeAfterBack.listScrollTop === 0
        ? m.afterBack.listScrollHeight <= m.afterBack.listClientHeight
        : Math.abs((m.afterBack.listScrollActual ?? -1) - m.storeAfterBack.listScrollTop) <= 1),
    `store=${m.storeAfterBack.listScrollTop} data=${m.afterBack.listDataScrollTop} actual=${m.afterBack.listScrollActual} sh=${m.afterBack.listScrollHeight} ch=${m.afterBack.listClientHeight}`,
  );
  return m;
}

/**
 * ② 跨运行和辅助视图返回恢复文件。
 */
async function scenarioCrossRun(call) {
  const m = {};
  // A = 根 run，第 1 轮结束 + **long.txt**（同名文件在两 run 都存在 ⇒ 真能考"同名不串"）
  // 为什么用 long.txt 而不是 a.txt：a.txt 只有 2 行，滚不动 ⇒ "位置恢复"会变成
  // 1 行 vs 1 行的恒真断言（假通过）。长正文才让位置可辨。
  Object.assign(m, await enterFiles(call, ROOT_RUN, 1, "全部"));
  m.aOpen = await pickFile(call, LONG_FILE);
  m.aScrolled = await wheelEditor(call, 2400, 4);
  m.aDom = await dom(call);
  m.aStore = await storeState(call, ROOT_RUN);
  await shot(call, SHOT_DIR, `${TAG}-1-A-文件页.png`);

  // 切到 B（**同名 long.txt、不同检查点与不同位置**）
  // ⚠️ B 的筛选是**它自己**的会话状态（新 run 缺省 `auto`）⇒ 同样要单独点「全部」
  const bPicked = await selectRun(call, FORK_RUN);
  m.bEntered = bPicked.ok;
  m.bDetour = bPicked.detour;
  m.bFiles = await clickTab(call, "文件");
  m.bCkpt = await pickCheckpoint(call, -1);
  m.bFilter = await pickFilter(call, "全部");
  m.bOpen = await pickFile(call, LONG_FILE);
  await assertStoreLive(call, FORK_RUN);
  m.bScrolled = await wheelEditor(call, 600, 2);
  m.bDom = await dom(call);
  m.bStore = await storeState(call, FORK_RUN);
  await shot(call, SHOT_DIR, `${TAG}-2-B-文件页.png`);

  check(
    "A 与 B 都能进入文件页且各自记在不同 run 键下",
    m.aStore.tab === "files" && m.bStore.tab === "files" && m.bStore.selectedRunId === FORK_RUN,
  );
  check(
    "同名文件在两 run 各自持有**不同的检查点**（夹具对照，用于检验不串）",
    m.aStore.checkpoint !== m.bStore.checkpoint,
    `A=${m.aStore.checkpoint} B=${m.bStore.checkpoint}`,
  );

  // **回 A**（跨运行返回）：A 离开时页签被写成概览（medium 档切 run 要先回概览取运行列表），
  // 故这里走真实用户路径：回 A → 点「文件」→ 阅读位置须恢复
  const aPicked = await selectRun(call, ROOT_RUN);
  m.aReturned = aPicked.ok;
  m.aReturnDetour = aPicked.detour;
  m.aReturnFiles = await clickTab(call, "文件");
  await sleep(1400);
  m.aReturnDom = await dom(call);
  m.aReturnStore = await storeState(call, ROOT_RUN);
  await shot(call, SHOT_DIR, `${TAG}-3-跨运行回A.png`);

  check(
    "跨运行返回 A 后恢复自己的检查点与路径（同名 long.txt 不串到 B）",
    m.aReturnStore.checkpoint === m.aStore.checkpoint && m.aReturnStore.path === LONG_FILE,
    `A ckpt ${m.aStore.checkpoint} → ${m.aReturnStore.checkpoint}; path=${m.aReturnStore.path}`,
  );
  check(
    "跨运行返回 A 后**正文位置恢复**（首可见行回到 A 的原处，容差 2 行；且不等于 B 的位置）",
    Math.abs((m.aReturnDom.firstLine ?? -999) - (m.aDom.firstLine ?? 0)) <= 2 &&
      Math.abs((m.aReturnDom.firstLine ?? -999) - (m.bDom.firstLine ?? 0)) > 2,
    `A 原=${m.aDom.firstLine} 回A=${m.aReturnDom.firstLine} B=${m.bDom.firstLine}`,
  );

  // 再经辅助视图（分支树 + 设置）往返
  m.toTrees = await gotoTrees(call);
  m.settings = await openSettingsAndClose(call);
  m.backToTrace = await gotoTrace(call);
  await sleep(1200);
  m.aBackDom = await dom(call);
  m.aBackStore = await storeState(call, ROOT_RUN);
  m.bStillStore = await storeState(call, FORK_RUN);
  await shot(call, SHOT_DIR, `${TAG}-4-辅助视图返回A.png`);

  check(
    "经分支树/设置返回后仍在 A 的文件页（辅助视图不把阅读页冲掉）",
    m.aBackDom.tabSelected === "文件" && m.aBackStore.selectedRunId === ROOT_RUN,
    `tab=${m.aBackDom.tabSelected} run=${m.aBackStore.selectedRunId}`,
  );
  check(
    "A 恢复自己的检查点与路径（同名 long.txt 不串到 B）",
    m.aBackStore.checkpoint === m.aStore.checkpoint && m.aBackStore.path === LONG_FILE,
    `A ckpt ${m.aStore.checkpoint} → ${m.aBackStore.checkpoint}; path=${m.aBackStore.path}`,
  );
  check(
    "A 的正文位置经辅助视图往返后仍恢复",
    Math.abs((m.aBackDom.firstLine ?? -999) - (m.aDom.firstLine ?? 0)) <= 2,
    `before=${m.aDom.firstLine} after=${m.aBackDom.firstLine}`,
  );
  check(
    "B 仍保持自己的检查点/路径（切 run 不互相覆盖）",
    m.bStillStore.checkpoint === m.bStore.checkpoint && m.bStillStore.path === m.bStore.path,
    `B ckpt ${m.bStore.checkpoint} → ${m.bStillStore.checkpoint}`,
  );
  check(
    "普通返回**不消费显式目标**（pendingFileTarget 全程为空）",
    m.aBackStore.pendingFileTarget === null && m.bStore.pendingFileTarget === null,
    JSON.stringify(m.aBackStore.pendingFileTarget),
  );
  return m;
}

/**
 * ③ 显式文件定位覆盖历史（自有步骤入口 + 搜索隐藏选择）。
 */
async function scenarioExplicit(call) {
  const m = {};
  Object.assign(m, await enterFiles(call, ROOT_RUN, 0));
  m.initialCkpt = (await storeState(call, ROOT_RUN)).checkpoint;

  // 先在文件页制造"历史检查点 + 被搜索隐藏的选择"
  m.pickLast = await pickCheckpoint(call, -1);
  // 点「全部」：完成步骤默认 `changed`，先保证 a.txt 确实可见可点（否则"被隐藏"就没有前态）
  m.pickAllFilter = await pickFilter(call, "全部");
  m.openShort = await pickFile(call, SHORT_FILE);
  m.typeQuery = await typeQuery(call, "not-exist");
  m.hiddenDom = await dom(call);
  m.hiddenStore = await storeState(call, ROOT_RUN);
  await shot(call, SHOT_DIR, `${TAG}-1-搜索隐藏选择.png`);

  // 走到步骤页，「打开该轮文件（第一个自有完成步骤）」
  m.toSteps = await clickTab(call, "步骤");
  m.stepEntryVisible = (await dom(call)).stepFilesBtn;
  // 选第一个 agent.step（自有步骤）
  m.selectStep = await ev(
    call,
    `(() => { const rows = Array.from(document.querySelectorAll('[role="treeitem"], button'))
        .filter(e => /第\\s*1\\s*轮|步骤\\s*1|agent\\.step/.test((e.textContent||'')));
      const t = rows[0]; if (!t) return false; t.click(); return true; })()`,
  );
  await sleep(1200);
  m.stepEntryVisible2 = (await dom(call)).stepFilesBtn;
  await shot(call, SHOT_DIR, `${TAG}-2-步骤页入口.png`);
  m.openStepFiles = await clickByText(call, "打开该轮文件", 1800);
  m.afterExplicitDom = await dom(call);
  m.afterExplicitStore = await storeState(call, ROOT_RUN);
  await shot(call, SHOT_DIR, `${TAG}-3-显式定位后.png`);

  check(
    "自有步骤上有「打开该轮文件」入口（spec 的 WHEN 在界面上可达）",
    m.stepEntryVisible2 === true,
    `步骤页入口出现=${m.stepEntryVisible2}`,
  );
  check(
    "显式定位把检查点切到**该自有步骤**（覆盖之前的历史检查点）",
    m.afterExplicitStore.checkpoint !== null &&
      m.afterExplicitStore.checkpoint !== m.hiddenStore.checkpoint,
    `历史=${m.hiddenStore.checkpoint} → 定位后=${m.afterExplicitStore.checkpoint}`,
  );
  check(
    "无 path 的显式目标 ⇒ 清空旧文件选择并显示列表",
    m.afterExplicitStore.path === null && m.afterExplicitStore.pane === "list",
    `path=${m.afterExplicitStore.path} pane=${m.afterExplicitStore.pane}`,
  );
  check(
    "定位后落到文件页且列表可见（要能继续选文件）",
    m.afterExplicitDom.tabSelected === "文件" && m.afterExplicitDom.fileOptions.length > 0,
    `tab=${m.afterExplicitDom.tabSelected} options=${m.afterExplicitDom.fileOptions.length}`,
  );
  check(
    "显式目标已被消费（pendingFileTarget 清空，不残留到下次导航）",
    m.afterExplicitStore.pendingFileTarget === null,
    JSON.stringify(m.afterExplicitStore.pendingFileTarget),
  );
  return m;
}

/**
 * ④ 失效检查点和路径安全回退（无效 path / 不属于本 run 的检查点）。
 */
async function scenarioFallback(call) {
  const m = {};
  Object.assign(m, await enterFiles(call, ROOT_RUN, -1, "全部"));

  /**
   * 无效 path：把 store 状态改成清单里不存在的路径（模拟"上次读的文件已被移出世界"）。
   *
   * ⚠️ 实机事实（2026-09-23）：失效是**在组件挂着的时候就被发现并处理的**（清单已加载 ⇒
   *    判据立刻成立）⇒ 提示与清理都发生在**当前这一次挂载**里。若脚本先切页签再回来看提示，
   *    那时状态早已被清干净、判据不再成立（提示确实消失了）——那不是缺陷，正是
   *    "一次性清理"的语义。故本场景**在注入后立刻断言提示**，再往返验证"清理已生效且不复发"。
   */
  m.injectBadPath = await callStoreAction(
    call,
    `m.useAppStore.getState().setFileReading(${JSON.stringify(ROOT_RUN)}, {
        path: 'no-such-dir/definitely-missing.txt', pane: 'content' });`,
  );
  await sleep(1600);
  m.badPathDom = await dom(call);
  m.badPathStore = await storeState(call, ROOT_RUN);
  await shot(call, SHOT_DIR, `${TAG}-1-失效路径.png`);

  check(
    "失效 path ⇒ 可见地提示（不静默回退）",
    m.badPathDom.pathInvalidNote === true,
    `pathInvalidNote=${m.badPathDom.pathInvalidNote}`,
  );
  check(
    "失效 path ⇒ **真的清掉了会话里的失效 path**（不是只在本帧算成 fallback）",
    m.badPathStore.path === null,
    `path=${JSON.stringify(m.badPathStore.path)}`,
  );
  check(
    "失效 path ⇒ 清空文件选择（selectedFile 为空，且不改选同名）",
    m.badPathDom.selectedFile === null,
    `selectedFile=${JSON.stringify(m.badPathDom.selectedFile)}`,
  );
  check(
    "失效 path ⇒ **列表真的可见**（用 getClientRects 判可见，不看元素在不在 DOM 里）",
    m.badPathDom.listVisible === true && m.badPathDom.fileOptions.length > 0,
    `listVisible=${m.badPathDom.listVisible} options=${m.badPathDom.fileOptions.length}`,
  );

  // 往返一次：清理应已生效 ⇒ 目标 run 的 step 仍是原检查点、path 已空、且**不再反复提示**
  m.toSteps = await clickTab(call, "步骤");
  m.toFiles = await clickTab(call, "文件");
  await sleep(1500);
  m.afterBadPathDom = await dom(call);
  m.afterBadPathStore = await storeState(call, ROOT_RUN);
  await shot(call, SHOT_DIR, `${TAG}-2-失效路径往返后.png`);
  check(
    "失效 path 清理**一次到位**：往返后仍为空且提示不再重复出现（清理语义，不是永久告警）",
    m.afterBadPathStore.path === null && m.afterBadPathDom.pathInvalidNote === false,
    `path=${JSON.stringify(m.afterBadPathStore.path)} note=${m.afterBadPathDom.pathInvalidNote}`,
  );

  // 失效检查点：把 checkpoint 换成一个"看似可读"的 id（不属于本 run）
  m.injectBadCkpt = await callStoreAction(
    call,
    `m.useAppStore.getState().setFileReading(${JSON.stringify(ROOT_RUN)}, {
        checkpoint: 'span_not_in_this_run', path: null, pane: 'list' });`,
  );
  await sleep(1600);
  m.badCkptDom = await dom(call);
  m.badCkptStore = await storeState(call, ROOT_RUN);
  await shot(call, SHOT_DIR, `${TAG}-3-失效检查点.png`);

  const activeCkpt = m.badCkptDom.ckpts.find((c) => c.active) ?? null;
  check(
    "失效检查点 ⇒ 可见地提示（不说静默换了检查点）",
    m.badCkptDom.ckptInvalidNote === true,
    `ckptInvalidNote=${m.badCkptDom.ckptInvalidNote}`,
  );
  check(
    "失效检查点 ⇒ **写回**最近的自有完成步骤（清理而非每帧重算）",
    m.badCkptStore.checkpoint !== null && m.badCkptStore.checkpoint !== "span_not_in_this_run",
    `checkpoint=${JSON.stringify(m.badCkptStore.checkpoint)}`,
  );
  check(
    "失效检查点 ⇒ 选择器高亮的是**最近自有完成步骤**（不是初始、不是乱选）",
    activeCkpt?.label.includes("第") === true && activeCkpt.label.includes("轮"),
    `active=${JSON.stringify(activeCkpt)}（全部：${JSON.stringify(m.badCkptDom.ckpts)}）`,
  );
  check(
    "回退后仍能读到清单（文件页可用，不因失效引用而空转）",
    m.badCkptDom.fileOptions.length > 0 && m.badCkptDom.listVisible === true,
    `options=${m.badCkptDom.fileOptions.length} listVisible=${m.badCkptDom.listVisible}`,
  );
  return m;
}

/**
 * ⑤ 搜索隐藏选择：显式目标带 path 时必须解除阻挡它的搜索筛选。
 */
async function scenarioSearchHidden(call) {
  const m = {};
  Object.assign(m, await enterFiles(call, ROOT_RUN, -1));
  // 先制造"搜索把目标藏起来"
  m.typeQuery = await typeQuery(call, "zzz-no-match");
  m.hiddenDom = await dom(call);
  m.hiddenStore = await storeState(call, ROOT_RUN);
  check(
    "搜索确实把清单筛空（夹具对照：这是要解除的阻挡态）",
    m.hiddenStore.query === "zzz-no-match" && m.hiddenDom.fileOptions.length === 0,
    `query=${m.hiddenStore.query} options=${m.hiddenDom.fileOptions.length}`,
  );

  // 显式定位（带 path）：从 store 走真实入口（与「打开该轮文件」同一 API 的另一形态）
  m.injectTarget = await callStoreAction(
    call,
    `m.useAppStore.getState().openFileAt(${JSON.stringify(ROOT_RUN)}, {
        stepSpanId: null, path: ${JSON.stringify(LONG_FILE)} });`,
  );
  await sleep(1800);
  m.after = await dom(call);
  m.afterStore = await storeState(call, ROOT_RUN);
  await shot(call, SHOT_DIR, `${TAG}-1-解阻后.png`);

  check(
    "显式目标带 path ⇒ 选中该文件并显示内容",
    m.afterStore.path === LONG_FILE && m.afterStore.pane === "content",
    `path=${m.afterStore.path} pane=${m.afterStore.pane}`,
  );
  check(
    "**清空阻挡它的搜索**（query 归空，不是留着把目标藏起来）",
    m.afterStore.query === "" && m.after.query === "",
    `store.query=${m.afterStore.query} dom.query=${m.after.query}`,
  );
  check(
    "**并切 all**（否则「有变化」筛选仍可能把目标藏掉）",
    m.afterStore.filter === "all",
    `filter=${m.afterStore.filter}`,
  );
  check(
    "解阻后目标在列表里可见（真渲染出该选项）",
    m.after.fileOptions.includes(LONG_FILE),
    `options=${JSON.stringify(m.after.fileOptions.slice(0, 6))}`,
  );
  return m;
}

/** 探路模式：只 dump 真机事实，不做断言 */
async function scenarioProbe(call, m) {
  m.runs = await runs(call);
  m.resources = JSON.parse(
    await ev(
      call,
      `(() => JSON.stringify(performance.getEntriesByType('resource').map(e => e.name)
        .filter(n => /store|reading-state|main\\.tsx/.test(n))))()`,
    ),
  );
  m.location = await ev(call, "location.href");
  m.initialDom = await dom(call);
  Object.assign(m.entry, await enterFiles(call, ROOT_RUN, -1, "全部"));
  m.filesDom = await dom(call);
  m.filesStore = await storeState(call, ROOT_RUN);
  m.openLong = await pickFile(call, LONG_FILE);
  m.afterOpenDom = await dom(call);
  m.afterOpenStore = await storeState(call, ROOT_RUN);
  m.wheelOk = await wheelEditor(call, 1800, 3);
  m.afterWheelDom = await dom(call);
  m.afterWheelStore = await storeState(call, ROOT_RUN);
  await shot(call, SHOT_DIR, `${TAG}-probe.png`);
  return m;
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const data = loadOut();
  const page = await cdpConnect(PORT);
  const call = await makeSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await call("Emulation.clearDeviceMetricsOverride").catch(() => {});

  /**
   * **先冷重载**。理由：
   *   1. 让"上一次 tag 留下的选中 run / 文件页状态"不串味，每次都从同一冷起点采数；
   *   2. 让模块图稳定（HMR 版本戳不再变化），`storeState` 解析出的 URL 在整轮里一致。
   *   （模块实例身份由 `storeState` 解析 URL 解决，不依赖重载——见该函数注释。）
   */
  await call("Page.reload", { ignoreCache: true });
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      if ((await runs(call)).length > 0) break;
    } catch {
      /* 重载瞬间 evaluate 可能失败，继续等 */
    }
  }
  await sleep(800);
  const ready = (await runs(call)).length;
  console.log(`冷重载完成：运行列表 ${ready} 项`);
  if (ready === 0) throw new Error("重载后运行列表为空——夹具未就绪");

  const m = { entry: {} };

  let out = m;
  if (TAG === "probe") out = await scenarioProbe(call, m);
  else if (TAG === "roundtrip") out = await scenarioRoundtrip(call);
  else if (TAG === "cross-run") out = await scenarioCrossRun(call);
  else if (TAG === "explicit") out = await scenarioExplicit(call);
  else if (TAG === "fallback") out = await scenarioFallback(call);
  else if (TAG === "search-hidden") out = await scenarioSearchHidden(call);
  else throw new Error(`unknown tag: ${TAG}`);
  data.measurements[TAG] = out;

  if (TAG !== "probe") {
    data.checks = data.checks.filter((c) => !c.name.startsWith(`[${TAG}] `)).concat(checks);
  }
  saveOut(data);

  const failed = checks.filter((c) => !c.ok);
  console.log(
    `\n完成：[${TAG}] ${checks.length - failed.length}/${checks.length} 通过；证据 ${SHOT_DIR}`,
  );
  if (failed.length) {
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
    process.exit(1);
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
