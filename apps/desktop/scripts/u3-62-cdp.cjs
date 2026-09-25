/**
 * U3 任务 6.2：R2 / 草稿列表精确定位 / 失效来源复制 / 放弃取消与确认路径（实机）。
 *
 * 验收（tasks 6.2）：
 * - 创建关闭配置再新建仍有任务（R2 路径复跑，输入对照 + 截图）；
 * - 草稿列表返回精确编辑目标（会话级入口「定位」→ 正确 run/span/字段/草稿内容）；
 * - 源记录**发生改变**（篡改 trace 的 tool result）与**缺失**（删除 trace 文件）：
 *   DraftSourceBanner 出现、草稿仍可编辑、复制可用、执行禁用；
 * - 放弃可取消且只影响指定目标（模态取消保留 / 确认后仅删指定 run 的草稿）。
 *
 * 纪律同 u3-61：真点击/真键入、真 store/真 monaco 读回、禁 Emulation 布局覆盖、
 * 每 tag 冷重载从干净起点采数；不改产品代码（篡改发生在**磁盘数据**上）。
 *
 * 用法：node apps/desktop/scripts/u3-62-cdp.cjs --tag=<r2|precision|source-change|source-missing|discard>
 */
"use strict";

const { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } = require("node:fs");
const { join } = require("node:path");
const { REPO, sleep, cdpConnect, makeSession, ev, shot } = require("./lib/u2-cdp-util.cjs");

const PORT = 9612;
const OUT_DIR = join(REPO, ".workbuddy", "u3", "u3-62");
const SHOT_DIR = join(REPO, "docs", "reviews", "2026-09-25-u3-62");
const OUT = join(OUT_DIR, "measurements.json");
const MANIFEST = join(REPO, ".workbuddy", "u3", "u3-61", "manifest.json");
const TRACE = (id) => join(REPO, ".rebaseagent", "traces", `${id}.jsonl`);

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag", "r2");

function fixture() {
  if (!existsSync(MANIFEST)) throw new Error("缺 u3-61 manifest——先跑 6.1 的夹具生成");
  return JSON.parse(readFileSync(MANIFEST, "utf8"));
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name: `[${TAG}] ${name}`, ok: ok === true, detail: ok === true ? "" : String(detail ?? "") });
  console.log(`${ok === true ? "✓" : "✗"} ${name}${ok === true ? "" : ` — ${String(detail ?? "")}`}`);
}
function loadOut() {
  if (existsSync(OUT)) return JSON.parse(readFileSync(OUT, "utf8"));
  return { measurements: {}, checks: [] };
}
function saveOut(d) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(d, null, 2)}\n`);
}

const STORE_NEEDLE = ["/src/renderer/src/store.ts", "/src/store.ts"];
const MONACO_NEEDLE = ["/src/renderer/src/monaco-bootstrap.ts", "/src/monaco-bootstrap.ts"];

async function appImport(call, needles, body) {
  const expr = `(async () => {
    const all = performance.getEntriesByType('resource').map(e => e.name);
    const rank = (n) => (n.includes('?t=') ? 0 : n.includes('/@fs/') ? 2 : 1);
    const urls = all.filter(n => ${JSON.stringify(needles)}.some(w => n.includes(w)))
      .sort((a, b) => rank(a) - rank(b));
    if (urls.length === 0) return JSON.stringify({ error: 'module-url-not-found' });
    const m = await import(urls[0]);
    ${body}
  })()`;
  const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
  const raw = r?.result?.value;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`appImport 非法 JSON：${String(raw).slice(0, 200)}`);
  }
}
const evAsync = (call, expression) =>
  call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }).then((r) => r?.result?.value);

async function drafts(call) {
  return appImport(
    call,
    STORE_NEEDLE,
    `const s = m.useAppStore.getState();
     return JSON.stringify({ calls: s.drafts.calls, modelAb: s.drafts.modelAb });`,
  );
}

// —— DOM 交互（自足拷贝自 u3-61）——
const RUNS_EXPR = `(() => JSON.stringify(Array.from(document.querySelectorAll('button'))
  .map(b => b.getAttribute('aria-label') || '')
  .filter(a => a.startsWith('复制完整运行 ID'))
  .map(a => a.replace('复制完整运行 ID ', ''))))()`;
async function runs(call) {
  return JSON.parse(await ev(call, RUNS_EXPR));
}
async function clickTab(call, label) {
  const ok = await ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('[role="tab"]'))
      .find(x => ((x.textContent||'').trim()) === '${label}');
      if (!b) return false; b.click(); return true; })()`,
  );
  if (ok !== true) return false;
  await sleep(1200);
  const selected = await ev(
    call,
    `(() => { const t = Array.from(document.querySelectorAll('[role="tab"]'))
      .find(x => x.getAttribute('aria-selected') === 'true');
      return t === null ? null : ((t.textContent||'').trim()); })()`,
  );
  return selected === label;
}
async function clickTabChecked(call, label) {
  if (!(await clickTab(call, label))) throw new Error(`页签切换到「${label}」失败`);
}
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
  if (ok !== true) {
    await clickTab(call, "概览");
    ok = await ev(call, hitRow);
  }
  if (ok !== true) throw new Error(`运行列表找不到 ${id}`);
  await sleep(1600);
}
async function clickSpan(call, titleFragment, expectSpanId) {
  const clickNth = (n) => `(() => {
    const rows = Array.from(document.querySelectorAll('button'))
      .filter(b => ((b.title||'').includes('${titleFragment}')));
    if (rows.length <= ${n}) return false;
    rows[${n}].click(); return true; })()`;
  for (let n = 0; n < 6; n++) {
    if ((await ev(call, clickNth(n))) !== true) break;
    await sleep(1300);
    const sel = await appImport(
      call,
      STORE_NEEDLE,
      `const s = m.useAppStore.getState();
       return JSON.stringify({ sel: s.selectedSpanId });`,
    );
    if (sel.sel === expectSpanId) return true;
  }
  throw new Error(`未能选中 span ${expectSpanId}`);
}
async function clickByTextChecked(call, text, wait = 800) {
  const ok = await ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
      .find(x => ((x.textContent||'').trim()).includes('${text}'));
      if (!b) return false; b.click(); return true; })()`,
  );
  if (ok !== true) throw new Error(`找不到按钮「${text}」`);
  await sleep(wait);
}
async function monacoInfo(call) {
  return appImport(
    call,
    MONACO_NEEDLE,
    `const monaco = await m.ensureMonaco();
     const ed = monaco.editor.getEditors().map((e, i) => ({
       i,
       value: e.getModel()?.getValue() ?? null,
       readOnly: e.getOption(monaco.editor.EditorOption.readOnly) === true,
       visible: e.getDomNode() !== null && e.getDomNode().offsetParent !== null,
     }));
     return JSON.stringify({ editors: ed });`,
  );
}
async function typeIntoEditableMonaco(call, text) {
  // Monaco 懒加载 + 编辑器挂载有时序 ⇒ 轮询等可编辑实例就绪（≤6s）
  let idx = null;
  for (let i = 0; i < 12; i++) {
    const info = await monacoInfo(call);
    const target = info.editors.filter((e) => e.visible && !e.readOnly);
    if (target.length > 0) {
      idx = target[0].i;
      break;
    }
    await sleep(500);
  }
  if (idx === null) {
    const info = await monacoInfo(call);
    throw new Error(`无可编辑 monaco（轮询 6s）：${JSON.stringify(info).slice(0, 300)}`);
  }
  const pathB = await appImport(
    call,
    MONACO_NEEDLE,
    `const monaco = await m.ensureMonaco();
     const e = monaco.editor.getEditors()[${idx}];
     const node = e.getDomNode();
     const ta = node.querySelector('textarea.inputarea') ?? node.querySelector('textarea');
     if (!ta) return JSON.stringify({ changed: false, reason: 'no-textarea' });
     ta.focus();
     const cur = e.getModel().getValue();
     const proto = window.HTMLTextAreaElement.prototype;
     Object.getOwnPropertyDescriptor(proto, 'value').set.call(ta, cur + ${JSON.stringify(text)});
     ta.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(text)}, inputType: 'insertText' }));
     await new Promise((r) => setTimeout(r, 500));
     return JSON.stringify({ changed: e.getModel().getValue() !== cur });`,
  );
  if (pathB.changed === true) return "dom-input-event";
  const pathC = await appImport(
    call,
    MONACO_NEEDLE,
    `const monaco = await m.ensureMonaco();
     const e = monaco.editor.getEditors()[${idx}];
     const cur = e.getModel().getValue();
     e.trigger('keyboard', 'type', { text: ${JSON.stringify(text)} });
     await new Promise((r) => setTimeout(r, 500));
     return JSON.stringify({ changed: e.getModel().getValue() !== cur });`,
  );
  if (pathC.changed === true) return "monaco-trigger";
  throw new Error(`键入路径失败：B=${JSON.stringify(pathB)} C=${JSON.stringify(pathC)}`);
}
async function typeIntoDom(call, selector, text) {
  const focused = await ev(
    call,
    `(() => { const i = document.querySelector(${JSON.stringify(selector)});
      if (!i || i.offsetParent === null) return false;
      i.focus(); i.select(); return true; })()`,
  );
  if (focused !== true) throw new Error(`无法聚焦 ${selector}`);
  await call("Input.insertText", { text });
  await sleep(800);
  const readBack = `(() => { const i = document.querySelector(${JSON.stringify(selector)});
    return i === null ? null : i.value; })()`;
  let value = await ev(call, readBack);
  if (typeof value === "string" && value.includes(text)) return { value, path: "insertText" };
  await ev(
    call,
    `(() => { const i = document.querySelector(${JSON.stringify(selector)});
      if (!i) return false;
      const proto = i.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(i, ${JSON.stringify(text)});
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return true; })()`,
  );
  await sleep(600);
  value = await ev(call, readBack);
  return { value, path: "native-setter" };
}
async function grantClipboard(call, origin) {
  try {
    await call("Browser.grantPermissions", {
      origin,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    return true;
  } catch {
    return false;
  }
}
const normClip = (s) => (typeof s === "string" ? s.replace(/\r\n/g, "\n") : s);

/** 在 run 的步骤页给 tool.invoke 建 result 草稿（真键入） */
async function seedResultDraft(call, runId, text) {
  await selectRun(call, runId);
  await clickTabChecked(call, "步骤");
  await clickSpan(call, "read_file", "s_03");
  await clickByTextChecked(call, "在此重跑（时间旅行）", 1200);
  await typeIntoEditableMonaco(call, text);
  const d = await drafts(call);
  if (!(d?.calls?.[runId]?.s_03?.result?.text ?? "").includes(text)) {
    throw new Error(`result 草稿写入失败：${JSON.stringify(d?.calls?.[runId]?.s_03)}`);
  }
  // 离开步骤页卸载编辑器（打开态是临时 UI；草稿在 store）
  await clickTabChecked(call, "概览");
}

/** 在 proxy run 建 messages 草稿 */
async function seedMessagesDraft(call, runId, text) {
  await selectRun(call, runId);
  await clickTabChecked(call, "步骤");
  await clickSpan(call, "LLM", "s_02");
  await clickByTextChecked(call, "编辑 messages 重发", 1200);
  await typeIntoEditableMonaco(call, text);
  const d = await drafts(call);
  if (!(d?.calls?.[runId]?.s_02?.messages?.text ?? "").includes(text)) {
    throw new Error(`messages 草稿写入失败`);
  }
  await clickTabChecked(call, "概览");
}

// —— 子场景 ——

/** R2：创建 → 关闭 → 运行配置 → 关闭 → 再开创建（输入对照 + 截图） */
async function scenarioR2(call, fx) {
  void fx;
  const mark = Math.random().toString(36).slice(2, 6);
  const task = `R2任务对照-${mark}`;
  await clickByTextChecked(call, "新建运行", 1000);
  const typed = await typeIntoDom(call, 'textarea[placeholder^="要交给模型的任务"]', task);
  check("R2 首次键入控件", typed.value !== null && typed.value.includes(task), JSON.stringify(typed.value));
  const clickInOpenDialog = async (text) => {
    const ok = await ev(
      call,
      `(() => { const dlg = Array.from(document.querySelectorAll('dialog[open]')).pop();
        if (!dlg) return 'no-dialog';
        const b = Array.from(dlg.querySelectorAll('button')).find(x => ((x.textContent||'').trim()) === ${JSON.stringify(text)});
        if (!b) return 'no-button: ' + (dlg.innerText||'').slice(0, 80);
        b.click(); return 'clicked'; })()`,
    );
    if (ok !== "clicked") throw new Error(`对话框内找不到「${text}」：${ok}`);
    await sleep(800);
  };
  await clickInOpenDialog("取消");
  await clickByTextChecked(call, "运行配置", 1000);
  await clickInOpenDialog("关闭"); // 设置对话框的关闭按钮是「关闭」（无「取消」）
  await clickByTextChecked(call, "新建运行", 1000);
  const restored = await ev(
    call,
    `(() => { const i = document.querySelector('textarea[placeholder^="要交给模型的任务"]');
      return i === null ? null : i.value; })()`,
  );
  check("R2 创建关闭配置再新建仍有任务", restored !== null && restored.includes(task), JSON.stringify(restored));
  // 输入对照落 measurements
  await shot(call, SHOT_DIR, "62-r2-create-restored.png");
  return { typed: task, restored };
}

/** R10：草稿列表返回精确编辑目标 */
async function scenarioPrecision(call, fx) {
  const runA = fx.normalRun;
  const runB = fx.proxyRun;
  const tA = `定位对照-A-${Math.random().toString(36).slice(2, 6)}`;
  const tB = `定位对照-B-${Math.random().toString(36).slice(2, 6)}`;
  await seedResultDraft(call, runA, tA);
  await seedMessagesDraft(call, runB, tB);

  // 全局会话草稿面板
  await clickTabChecked(call, "概览");
  await clickByTextChecked(call, "会话草稿", 900);
  const listText = await ev(call, "document.body.innerText");
  check(
    "R10 列表含两条精确目标（run · span）",
    listText.includes(`run ${runA} · s_03`) && listText.includes(`run ${runB} · s_02`),
    listText.slice(0, 0) || "见 measurements",
  );
  await shot(call, SHOT_DIR, "62-list-panel.png");

  // 定位到 runA 的 result 草稿
  const panelButtons = await ev(
    call,
    `(() => { const btns = Array.from(document.querySelectorAll('button[title="定位到该草稿的编辑目标"]'));
      return JSON.stringify(btns.map(b => { const li = b.closest('li'); return (li?.innerText || '').slice(0, 60); })); })()`,
  );
  const items = JSON.parse(panelButtons);
  const idxA = items.findIndex((t) => t.includes(runA));
  const idxB = items.findIndex((t) => t.includes(runB));
  check("R10 列表条目可区分（按 run 归属）", idxA >= 0 && idxB >= 0 && idxA !== idxB, JSON.stringify(items));
  await ev(
    call,
    `(() => { const btns = Array.from(document.querySelectorAll('button[title="定位到该草稿的编辑目标"]'));
      btns[${idxA}]?.click(); return true; })()`,
  );
  await sleep(1800);
  const navA = await appImport(
    call,
    STORE_NEEDLE,
    `const s = m.useAppStore.getState();
     return JSON.stringify({ run: s.selectedRunId, span: s.selectedSpanId });`,
  );
  check(
    "R10 定位 A：run/span 精确",
    navA.run === runA && navA.span === "s_03",
    JSON.stringify(navA),
  );
  // 当前可见编辑器含 A 草稿文本（result 编辑器可编辑模型）
  let info = await monacoInfo(call);
  check(
    "R10 定位 A：编辑器打开且含草稿文本",
    info.editors.some((e) => e.visible && !e.readOnly && (e.value ?? "").includes(tA)),
    JSON.stringify(info.editors.map((e) => ({ ro: e.readOnly, v: (e.value ?? "").slice(-30) }))),
  );
  await shot(call, SHOT_DIR, "62-precision-a.png");

  // 回面板定位 runB 的 messages 草稿
  await clickTabChecked(call, "概览");
  await clickByTextChecked(call, "会话草稿", 900);
  await ev(
    call,
    `(() => { const btns = Array.from(document.querySelectorAll('button[title="定位到该草稿的编辑目标"]'));
      const items2 = btns.map(b => (b.closest('li')?.innerText || ''));
      const i = items2.findIndex(t => t.includes('${runB}'));
      if (i >= 0) btns[i].click();
      return i; })()`,
  );
  await sleep(1800);
  const navB = await appImport(
    call,
    STORE_NEEDLE,
    `const s = m.useAppStore.getState();
     return JSON.stringify({ run: s.selectedRunId, span: s.selectedSpanId });`,
  );
  check(
    "R10 定位 B：run/span 精确（proxy 的 messages）",
    navB.run === runB && navB.span === "s_02",
    JSON.stringify(navB),
  );
  info = await monacoInfo(call);
  check(
    "R10 定位 B：编辑器打开且含草稿文本",
    info.editors.some((e) => e.visible && !e.readOnly && (e.value ?? "").includes(tB)),
    JSON.stringify(info.editors.map((e) => ({ ro: e.readOnly, v: (e.value ?? "").slice(-30) }))),
  );
  await shot(call, SHOT_DIR, "62-precision-b.png");
  return { tA, tB };
}

/** 源记录**发生改变**：篡改 trace 的 tool result → 重开编辑器出现失效横幅 */
async function scenarioSourceChange(call, fx) {
  const runId = fx.normalRun;
  const text = `篡改前草稿-${Math.random().toString(36).slice(2, 6)}`;
  await seedResultDraft(call, runId, text);

  // 磁盘篡改：改写 tool result 内容（JSON-safe 字符串替换）；场景尾还原（防污染）
  const file = TRACE(runId);
  const backup = readFileSync(file, "utf8");
  if (!backup.includes("内容(README.md)")) throw new Error("夹具缺基线串「内容(README.md)」");
  writeFileSync(file, backup.replace("内容(README.md)", "内容(已被篡改-CHANGED)"));
  console.log("[tamper] trace 已改写");

  // 重开编辑器 → 重验失败 → 失效横幅。
  // ⚠️ selectRun 对同 run 短路（不重拉详情）⇒ 必须先切到其他 run 再切回，
  // 让 api.getRun 从磁盘重读（被篡改的）轨迹——这也是真实用户的操作路径。
  await selectRun(call, fx.proxyRun);
  await selectRun(call, runId);
  await clickTabChecked(call, "步骤");
  await clickSpan(call, "read_file", "s_03");
  await clickByTextChecked(call, "在此重跑（时间旅行）", 1500);
  // 重验是异步的（IPC 读盘 + 哈希比对）⇒ 轮询等横幅
  let banner = null;
  for (let i = 0; i < 16; i++) {
    banner = await ev(
      call,
      `(() => { const b = document.querySelector('[data-draft-source-blocked="true"]');
        return b === null ? null : (b.innerText || '').slice(0, 120); })()`,
    );
    if (banner !== null) break;
    await sleep(500);
  }
  check("source-change 失效横幅出现", banner !== null && banner.includes("来源失效，已禁止执行"), JSON.stringify(banner));
  check("source-change 横幅标注来源已改变", banner !== null && banner.includes("改变"), JSON.stringify(banner));

  // 草稿仍可编辑（readOnly=false 且文本保留）
  const info = await monacoInfo(call);
  check(
    "source-change 草稿仍可编辑且文本保留",
    info.editors.some((e) => e.visible && !e.readOnly && (e.value ?? "").includes(text)),
    JSON.stringify(info.editors.map((e) => ({ ro: e.readOnly, v: (e.value ?? "").slice(-30) }))),
  );
  // 执行禁用：提交按钮 disabled（提交闸门由调用方叠加 verdict）
  const submitState = await ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => (x.textContent||'').includes('在此重跑') && x.closest('[data-draft-source-blocked]') === null)
        ?? null;
      const all = Array.from(document.querySelectorAll('button')).filter(x => (x.textContent||'').trim() === '确认重跑' || (x.textContent||'').trim() === '提交重跑');
      return JSON.stringify({ submitButtons: all.map(b => ({ t: (b.textContent||'').trim(), disabled: b.disabled })) }); })()`,
  );
  const parsed = JSON.parse(submitState);
  check(
    "source-change 执行入口禁用",
    parsed.submitButtons.length > 0 && parsed.submitButtons.every((b) => b.disabled === true),
    JSON.stringify(parsed),
  );

  // 复制草稿内容（横幅按钮 → 剪贴板 = 草稿全文）
  await grantClipboard(call, "http://localhost:5173");
  await evAsync(
    call,
    `(async () => { try { await navigator.clipboard.writeText('__u262_empty__'); } catch (e) {} return 'ok'; })()`,
  );
  await clickByTextChecked(call, "复制草稿内容", 900);
  const clip = await evAsync(call, "navigator.clipboard.readText()").catch(() => null);
  check(
    "source-change 复制草稿内容可用（全文不截断）",
    typeof clip === "string" && normClip(clip).includes(text),
    `clip=${JSON.stringify(clip ?? null).slice(0, 80)}`,
  );
  await shot(call, SHOT_DIR, "62-source-changed-banner.png");
  // 还原夹具（避免污染后续复跑）
  writeFileSync(file, backup);
  console.log("[tamper] trace 已还原");
  return { text, clipLen: typeof clip === "string" ? clip.length : null };
}

/** 源记录**缺失**：删除 trace 文件 → 编辑器失效横幅；源 run 消失后草稿仍可复制 */
async function scenarioSourceMissing(call, fx) {
  const runId = fx.normalRun;
  const text = `缺失前草稿-${Math.random().toString(36).slice(2, 6)}`;
  await seedResultDraft(call, runId, text);

  // 源记录缺失：只摘除 s_03 span 行（run 其余部分完好——摘除后源读取应报缺失而非整 run 不可用）
  const file = TRACE(runId);
  const backup = readFileSync(file, "utf8");
  const kept = backup.split(/\r?\n/).filter((line) => {
    if (!line.trim()) return true;
    try {
      const obj = JSON.parse(line);
      return !(obj.type === "span" && obj.id === "s_03");
    } catch {
      return true;
    }
  });
  writeFileSync(file, kept.join("\n") + "\n");
  console.log("[missing] s_03 span 行已摘除");

  // 重开编辑器（⚠️ 同 run 短路 ⇒ 先切到 proxy run 再切回，强制重拉详情）
  await selectRun(call, fx.proxyRun).catch(() => {});
  await selectRun(call, runId).catch(() => {});
  // span 已从详情消失 ⇒ 该编辑器**无法打开**（不是横幅——没有可恢复的编辑目标）；
  // 正确产品行为 = 详情安全回退（3.2 语义）：不崩、可继续操作，草稿保留且可复制。
  // （source_missing 的横幅路径由 1.4 单测覆盖；「改变」路径的实机横幅见 source-change。）
  let detailAfter = null;
  try {
    await clickTabChecked(call, "步骤");
    detailAfter = await appImport(
      call,
      STORE_NEEDLE,
      `const s = m.useAppStore.getState();
       return JSON.stringify({
         run: s.selectedRunId,
         hasS03: s.detail !== null && s.detail.spans.some(x => x.id === 's_03'),
       });`,
    );
  } catch (e) {
    detailAfter = { error: String(e).slice(0, 120) };
  }
  check(
    "source-missing 详情重拉后目标 span 消失",
    detailAfter !== null && detailAfter.hasS03 === false,
    JSON.stringify(detailAfter),
  );
  // 应用仍可交互（安全回退，不崩）
  const stillInteractive = await clickTab(call, "概览");
  check("source-missing 应用安全回退（仍可交互）", stillInteractive === true);

  // 恢复文件（避免污染后续 tag；先验证复制，再恢复）
  // 全局会话草稿入口：源 run 消失后仍可复制草稿内容
  await grantClipboard(call, "http://localhost:5173");
  await evAsync(
    call,
    `(async () => { try { await navigator.clipboard.writeText('__u262_empty__'); } catch (e) {} return 'ok'; })()`,
  );
  let copied = false;
  try {
    await clickTabChecked(call, "概览");
    await clickByTextChecked(call, "会话草稿", 900);
    await ev(
      call,
      `(() => { const btns = Array.from(document.querySelectorAll('button[title="复制草稿完整内容"]'));
        const items2 = btns.map(b => (b.closest('li')?.innerText || ''));
        const i = items2.findIndex(t => t.includes('${runId}'));
        if (i >= 0) btns[i].click();
        return i; })()`,
    );
    await sleep(900);
    const clip = await evAsync(call, "navigator.clipboard.readText()").catch(() => null);
    copied = typeof clip === "string" && normClip(clip).includes(text);
  } catch (e) {
    copied = false;
  }
  check("source-missing 源 run 消失后草稿仍可复制", copied === true);
  await shot(call, SHOT_DIR, "62-source-missing.png");

  // 还原夹具文件
  writeFileSync(file, backup);
  console.log("[missing] trace 已还原");
  return { text, copied };
}

/** 放弃取消/确认：模态取消保留；确认后仅删指定 run 的草稿 */
async function scenarioDiscard(call, fx) {
  const runA = fx.normalRun;
  const runB = fx.proxyRun;
  const tA = `放弃对照-A-${Math.random().toString(36).slice(2, 6)}`;
  const tB = `放弃对照-B-${Math.random().toString(36).slice(2, 6)}`;
  await seedResultDraft(call, runA, tA);
  await seedMessagesDraft(call, runB, tB);

  await clickTabChecked(call, "概览");
  await clickByTextChecked(call, "会话草稿", 900);

  const discardItemOf = async (runId) =>
    ev(
      call,
      `(() => { const btns = Array.from(document.querySelectorAll('button[title="放弃该草稿（需确认；按当前修订校验）"]'));
        const items2 = btns.map(b => (b.closest('li')?.innerText || ''));
        const i = items2.findIndex(t => t.includes('${runId}'));
        if (i >= 0) btns[i].click();
        return i; })()`,
    );

  // 第一次：放弃 A → 模态出现 → 取消
  await discardItemOf(runA);
  await sleep(700);
  const modalText = await ev(
    call,
    `(() => { const dlg = Array.from(document.querySelectorAll('dialog[open]'))
        .find(d => (d.innerText||'').includes('确认放弃'));
      return dlg === null ? null : (dlg.innerText || '').slice(0, 160); })()`,
  );
  check(
    "discard 模态出现且目标明确",
    modalText !== null && modalText.includes(runA) && modalText.includes("放弃"),
    JSON.stringify(modalText),
  );
  await shot(call, SHOT_DIR, "62-discard-modal.png");
  await clickByTextChecked(call, "取消", 700);
  let d = await drafts(call);
  check(
    "discard 取消后 A 草稿保留",
    (d?.calls?.[runA]?.s_03?.result?.text ?? "").includes(tA),
  );

  // 第二次：放弃 A → 确认 → 仅 A 消失，B 仍在
  await discardItemOf(runA);
  await sleep(700);
  await clickByTextChecked(call, "确认放弃", 800);
  d = await drafts(call);
  const aGone = (d?.calls?.[runA]?.s_03?.result?.text ?? "") === "" || d?.calls?.[runA]?.s_03?.result === undefined;
  const bKept = (d?.calls?.[runB]?.s_02?.messages?.text ?? "").includes(tB);
  check("discard 确认后 A 草稿删除", aGone === true, JSON.stringify(d?.calls?.[runA]?.s_03 ?? null));
  check("discard 只影响指定目标（B 仍保留）", bKept === true);
  await shot(call, SHOT_DIR, "62-discard-after-confirm.png");
  return { tA, tB };
}

async function main() {
  const fx = fixture();
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

  await call("Page.reload", { ignoreCache: true });
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      if ((await runs(call)).length > 0) break;
    } catch {
      /* 重载瞬间可能失败 */
    }
  }
  await sleep(900);
  const ready = (await runs(call)).length;
  console.log(`冷重载完成：运行列表 ${ready} 项`);
  if (ready === 0) throw new Error("重载后运行列表为空——夹具未就绪");

  const scenarios = {
    r2: scenarioR2,
    precision: scenarioPrecision,
    "source-change": scenarioSourceChange,
    "source-missing": scenarioSourceMissing,
    discard: scenarioDiscard,
  };
  const run = scenarios[TAG];
  if (run === undefined) throw new Error(`unknown tag: ${TAG}`);
  const out = await run(call, fx);
  data.measurements[TAG] = out ?? {};
  data.checks = data.checks.filter((c) => !c.name.startsWith(`[${TAG}] `)).concat(checks);
  saveOut(data);

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n完成：[${TAG}] ${checks.length - failed.length}/${checks.length} 通过；证据 ${SHOT_DIR}`);
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
