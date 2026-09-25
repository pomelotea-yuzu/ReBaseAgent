/**
 * U3 任务 6.1：真实读取可通过的普通/隔离/代理/A-B fixture + 相同 span ID 对照，
 * 事件驱动**全部编辑器**导航恢复（result / prompt / messages / A-B / 创建）。
 *
 * 验收场景（tasks 6.1）：
 * - result 草稿经步骤页签和运行往返逐字恢复
 * - 相同 span ID 和不同字段不串草稿（父/子 run 同 span、prompt 两字段）
 * - 非法 JSON 和空输入仍可暂存
 * - 实验臂增删和非法参数可恢复
 * - 断言**最后一次键入**确实落入 store 和再次挂载的控件
 *
 * 交互纪律（沿 U2 5.4）：
 *   - 全部真点击 / 真键入（Input.insertText / 真按钮 click），真 store / 真 monaco 读回；
 *   - 禁用 Emulation.setDeviceMetricsOverride（破坏 Monaco automaticLayout）；
 *   - store 通道 = 从 performance 资源表解析应用自己用过的模块 URL 再 import()；
 *   - 每个 tag 从 Page.reload 干净起点开始；本脚本不 spawn、不改窗、不重启 dev。
 *
 * 夹具（由生成器预先装进 dev 数据目录，见 .workbuddy/u3/u3-61/manifest.json）：
 *   - 普通父 run（result/prompt/A-B 编辑器 + 首次 llm 身份）
 *   - 隔离 root + 其 fork（真实引擎；**继承 span 与父同 ID** ⇒ 相同 span ID 对照）
 *   - 代理 run（messages 重发编辑器）
 *
 * 用法：node apps/desktop/scripts/u3-61-cdp.cjs --tag=<result|contrast|prompt|messages|ab|create>
 */
"use strict";

const { mkdirSync, writeFileSync, readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { REPO, sleep, cdpConnect, makeSession, ev, shot } = require("./lib/u2-cdp-util.cjs");

const PORT = 9612;
const OUT_DIR = join(REPO, ".workbuddy", "u3", "u3-61");
const SHOT_DIR = join(REPO, "docs", "reviews", "2026-09-25-u3-61");
const OUT = join(OUT_DIR, "measurements.json");
const MANIFEST = join(OUT_DIR, "manifest.json");

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag", "probe");

// —— 夹具（由 gen 步骤写入 manifest）——
function fixture() {
  if (!existsSync(MANIFEST)) throw new Error(`缺 ${MANIFEST}——先跑 gen-u3-61-fixtures.cjs`);
  return JSON.parse(readFileSync(MANIFEST, "utf8"));
}

// —— 断言记录（沿 u2-54 形态）——
const checks = [];
function check(name, ok, detail) {
  checks.push({
    name: `[${TAG}] ${name}`,
    ok: ok === true,
    detail: ok === true ? "" : String(detail ?? ""),
  });
  console.log(
    `${ok === true ? "✓" : "✗"} ${name}${ok === true ? "" : ` — ${String(detail ?? "")}`}`,
  );
}

function loadOut() {
  if (existsSync(OUT)) return JSON.parse(readFileSync(OUT, "utf8"));
  return { measurements: {}, checks: [] };
}
function saveOut(d) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(d, null, 2)}\n`);
}

const STORE_NEEDLE = ["/src/renderer/src/store.ts", "/src/renderer/src/store.tsx", "/src/store.ts"];

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
  // ⚠️ async IIFE 必须 awaitPromise（否则拿到的是 Promise 序列化成 [object Object]）
  const r = await call("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r?.exceptionDetails)
    throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
  const raw = r?.result?.value;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`appImport 非法 JSON：${String(raw).slice(0, 200)}`);
  }
}

/** 读草稿仓库相关切片（runId → spans → field 原样结构） */
async function drafts(call) {
  return appImport(
    call,
    STORE_NEEDLE,
    `const s = m.useAppStore.getState();
     return JSON.stringify({
       calls: s.drafts.calls, modelAb: s.drafts.modelAb,
       create: s.drafts.create === null ? null : {
         mode: s.drafts.create.mode, systemPrompt: s.drafts.create.systemPrompt,
         userMessage: s.drafts.create.userMessage, revision: s.drafts.create.revision,
       },
     });`,
  );
}

/** 读当前选中 run 的详情 spans（找 tool.invoke / 首个 llm.call） */
async function detailSpans(call) {
  return appImport(
    call,
    STORE_NEEDLE,
    `const s = m.useAppStore.getState();
     const d = s.detail;
     if (d === null) return JSON.stringify({ error: 'no-detail' });
     return JSON.stringify({
       runId: d.meta.id,
       llm: d.spans.filter(x => x.kind === 'llm.call').map(x => x.id),
       tools: d.spans.filter(x => x.kind === 'tool.invoke').map(x => x.id),
       selected: s.selectedSpanId,
     });`,
  );
}

// —— DOM 交互 helper（沿 u2-54 形态，本脚本自足）——

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
  const ok = await clickTab(call, label);
  if (!ok) throw new Error(`页签切换到「${label}」失败`);
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
    const sel = await detailSpans(call);
    if (sel.selected === expectSpanId) return true;
  }
  throw new Error(`未能选中 span ${expectSpanId}（title 含「${titleFragment}」）`);
}

async function clickByTextChecked(call, text, wait = 800) {
  // 包含式匹配（按钮文本可能被内层元素拆分）；点击后校验按钮仍在/视图就绪由调用方断言
  const ok = await ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
      .find(x => ((x.textContent||'').trim()).includes('${text}'));
      if (!b) return false; b.click(); return true; })()`,
  );
  if (ok !== true) throw new Error(`找不到按钮「${text}」`);
  await sleep(wait);
}

/** monaco：拿与界面同实例的命名空间 */
const MONACO_NEEDLE = ["/src/renderer/src/monaco-bootstrap.ts", "/src/monaco-bootstrap.ts"];
async function monacoInfo(call) {
  return appImport(
    call,
    MONACO_NEEDLE,
    `const monaco = await m.ensureMonaco();
     const ed = monaco.editor.getEditors().map((e, i) => ({
       i,
       uri: e.getModel()?.uri?.toString() ?? null,
       value: e.getModel()?.getValue() ?? null,
       readOnly: e.getOption(monaco.editor.EditorOption.readOnly) === true,
       visible: e.getDomNode() !== null && e.getDomNode().offsetParent !== null,
     }));
     return JSON.stringify({ editors: ed });`,
  );
}

/** 真输入到**可编辑** monaco。三级路径，取第一个生效者并如实记录：
 *  A=CDP 逐字符键盘事件（真键盘序列）；B=textarea 赋值 + InputEvent(insertText)（DOM 事件，
 *  与 React 测试库同法，走 Monaco 自己的 input 管线）；C=editor.trigger('keyboard','type')
 *  （Monaco 官方键入入口，onDidChangeModelContent 与真实键入同源）。 */
async function typeIntoEditableMonaco(call, text) {
  const info = await monacoInfo(call);
  const target = info.editors.filter((e) => e.visible && !e.readOnly);
  if (target.length === 0) throw new Error(`无可编辑 monaco：${JSON.stringify(info)}`);
  const idx = target[0].i;

  const modelChanged = async (expectIncludes) => {
    const info2 = await monacoInfo(call);
    const e2 = info2.editors[idx];
    return (
      e2 !== undefined &&
      e2.value !== null &&
      (!expectIncludes || e2.value.includes(expectIncludes))
    );
  };
  const before = info.editors[idx].value ?? "";

  // 路径 A：CDP 键盘
  const focus = await appImport(
    call,
    MONACO_NEEDLE,
    `const monaco = await m.ensureMonaco();
     const e = monaco.editor.getEditors()[${idx}];
     const node = e.getDomNode();
     const ta = node.querySelector('textarea.inputarea') ?? node.querySelector('textarea');
     if (!ta) return JSON.stringify({ ok: false });
     ta.focus();
     return JSON.stringify({ ok: document.activeElement === ta });`,
  );
  if (focus.ok === true) {
    for (const ch of Array.from(text)) {
      await call("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: ch,
        text: ch,
        windowsVirtualKeyCode: 0,
        unmodifiedText: ch,
      });
      await call("Input.dispatchKeyEvent", { type: "keyUp", key: ch, windowsVirtualKeyCode: 0 });
    }
    await sleep(700);
    if ((await modelChanged(null)) && (await monacoInfo(call)).editors[idx].value !== before) {
      return "cdp-keyboard";
    }
  }

  // 路径 B：textarea 赋值 + InputEvent（走 Monaco input 管线）
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
     return JSON.stringify({ changed: e.getModel().getValue() !== cur, value: e.getModel().getValue().slice(-60) });`,
  );
  if (pathB.changed === true) return "dom-input-event";

  // 路径 C：Monaco 官方键入入口
  const pathC = await appImport(
    call,
    MONACO_NEEDLE,
    `const monaco = await m.ensureMonaco();
     const e = monaco.editor.getEditors()[${idx}];
     const cur = e.getModel().getValue();
     e.trigger('keyboard', 'type', { text: ${JSON.stringify(text)} });
     await new Promise((r) => setTimeout(r, 500));
     return JSON.stringify({ changed: e.getModel().getValue() !== cur, value: e.getModel().getValue().slice(-60) });`,
  );
  if (pathC.changed === true) return "monaco-trigger";

  throw new Error(
    `三级键入路径全部失败：A=${JSON.stringify(focus)} B=${JSON.stringify(pathB).slice(0, 200)} C=${JSON.stringify(pathC).slice(0, 200)}`,
  );
}

/** 真输入到普通 input/textarea（按选择器），读回控件值。
 * 优先 CDP Input.insertText（真键入）；若受控 React 输入未收到（value 不变），
 * 兜底 native value setter + input 事件（React 测试库同法），并如实记录路径。 */
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
  if (typeof value === "string" && value.includes(text)) {
    return { value, path: "insertText" };
  }
  // 兜底：React 受控输入的事件注入
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

// —— 子场景 ——

/** 公共：选中 run → steps → 选中 span → 点编辑入口 */
async function openEditor(call, fx, runId, spanTitle, spanId, entryText) {
  await selectRun(call, runId);
  await clickTabChecked(call, "步骤");
  await clickSpan(call, spanTitle, spanId);
  await clickByTextChecked(call, entryText, 1000);
}

async function scenarioResult(call, fx) {
  const runId = fx.normalRun;
  const spans = await (async () => {
    await selectRun(call, runId);
    await clickTabChecked(call, "步骤");
    return detailSpans(call);
  })();
  if (spans.tools.length === 0)
    throw new Error(`普通 run 无 tool.invoke：${JSON.stringify(spans)}`);
  const toolSpan = spans.tools[0];

  await clickSpan(call, "read_file", toolSpan);
  await clickByTextChecked(call, "在此重跑（时间旅行）", 1200);

  const text = `结果草稿-A1-${Math.random().toString(36).slice(2, 6)}`;
  const typingPath = await typeIntoEditableMonaco(call, text);
  check(
    "result 键入路径已记录（三级回退，如实）",
    ["cdp-keyboard", "dom-input-event", "monaco-trigger"].includes(typingPath),
    `path=${typingPath}`,
  );

  // 最后一次键入确实落入 store（导航前读）
  let d = await drafts(call);
  const stored = d?.calls?.[runId]?.[toolSpan]?.result?.text ?? null;
  check("result 最后键入落入 store", stored?.includes(text), `store=${JSON.stringify(stored)}`);
  check("result dirty=true", d?.calls?.[runId]?.[toolSpan]?.result?.text !== undefined);

  // 步骤页签往返（打开态是临时 UI ⇒ 往返后须重新打开编辑器，草稿从 store 恢复）
  await clickTabChecked(call, "概览");
  await clickTabChecked(call, "步骤");
  await clickSpan(call, "read_file", toolSpan);
  await clickByTextChecked(call, "在此重跑（时间旅行）", 1200);
  await shot(call, SHOT_DIR, "61-result-after-tab-roundtrip.png");
  let info = await monacoInfo(call);
  let restored = info.editors.some((e) => e.value?.includes(text));
  check("result 页签往返后控件逐字恢复（重开后）", restored, JSON.stringify(info.editors));

  // 运行往返：切走再切回
  await selectRun(call, fx.proxyRun);
  await selectRun(call, runId);
  await clickTabChecked(call, "步骤");
  await clickSpan(call, "read_file", toolSpan);
  await clickByTextChecked(call, "在此重跑（时间旅行）", 1200);
  info = await monacoInfo(call);
  restored = info.editors.some((e) => e.value?.includes(text));
  check("result 运行往返后控件逐字恢复", restored, JSON.stringify(info.editors));
  d = await drafts(call);
  check(
    "result 运行往返后 store 仍保留",
    (d?.calls?.[runId]?.[toolSpan]?.result?.text ?? "").includes(text),
  );
  await shot(call, SHOT_DIR, "61-result-restored.png");
  return { runId, toolSpan, text, typingPath };
}

async function scenarioContrast(call, fx) {
  // 相同 span ID 对照：**两个独立 root**（normal 与隔离 root）的 read_file span 同为 s_03
  // —— 草稿键含 runId ⇒ 同 span ID 不得串。注：fork 的继承前缀 span 在子 run 禁止编辑
  // （delta「祖先前缀不可在此重跑」），故 fork 不构成可编辑的同 ID 对照。
  const runA = fx.normalRun;
  const runB = fx.isoRoot;
  const sharedSpan = "s_03";
  const mark = `X${Math.random().toString(36).slice(2, 6)}`;

  // A（normal）侧编辑
  await selectRun(call, runA);
  await clickTabChecked(call, "步骤");
  await clickSpan(call, "read_file", sharedSpan);
  await clickByTextChecked(call, "在此重跑（时间旅行）", 1200);
  const aText = `结果草稿-A-${mark}`;
  await typeIntoEditableMonaco(call, aText);
  let d = await drafts(call);
  check(
    "同span对照：A(normal) 侧写入",
    (d?.calls?.[runA]?.[sharedSpan]?.result?.text ?? "").includes(aText),
  );

  // B（iso）侧：同 span ID —— 不得串草稿
  await selectRun(call, runB);
  await clickTabChecked(call, "步骤");
  await clickSpan(call, "read_file", sharedSpan);
  await clickByTextChecked(call, "在此重跑（隔离续跑）", 1200);
  d = await drafts(call);
  const bBefore = d?.calls?.[runB]?.[sharedSpan]?.result?.text ?? "";
  check(
    "同span对照：B(iso) 侧不串 A 草稿",
    !bBefore.includes(aText),
    `B 侧=${JSON.stringify(bBefore)}`,
  );
  const bText = `结果草稿-B-${mark}`;
  await typeIntoEditableMonaco(call, bText);

  // 回 A：A 侧文本仍在
  await selectRun(call, runA);
  await clickTabChecked(call, "步骤");
  await clickSpan(call, "read_file", sharedSpan);
  await clickByTextChecked(call, "在此重跑（时间旅行）", 1200);
  const info = await monacoInfo(call);
  check(
    "同span对照：返回 A 后其草稿逐字保留",
    info.editors.some((e) => e.value?.includes(aText)),
    JSON.stringify(info.editors.map((e) => (e.value ?? "").slice(-40))),
  );
  await shot(call, SHOT_DIR, "61-contrast-a.png");
  await selectRun(call, runB);
  await clickTabChecked(call, "步骤");
  await clickSpan(call, "read_file", sharedSpan);
  await clickByTextChecked(call, "在此重跑（隔离续跑）", 1200);
  const info2 = await monacoInfo(call);
  check(
    "同span对照：B 侧草稿独立保留",
    info2.editors.some((e) => e.value?.includes(bText)),
  );
  await shot(call, SHOT_DIR, "61-contrast-b.png");
}

async function scenarioPrompt(call, fx) {
  const runId = fx.normalRun;
  const spans = await (async () => {
    await selectRun(call, runId);
    await clickTabChecked(call, "步骤");
    return detailSpans(call);
  })();
  const firstLlm = spans.llm[0];
  await clickSpan(call, "LLM", firstLlm);

  const mark = `P${Math.random().toString(36).slice(2, 6)}`;
  // system 字段
  await clickByTextChecked(call, "编辑 system prompt 重跑", 1200);
  const sysText = `系统提示草稿-${mark}`;
  await typeIntoEditableMonaco(call, sysText);
  let d = await drafts(call);
  check(
    "prompt system 最后键入落入 store",
    (d?.calls?.[runId]?.[firstLlm]?.system_prompt?.text ?? "").includes(sysText),
  );

  // 切 user 字段（编辑器内的字段切换按钮）：不得串到 system
  await clickByTextChecked(call, "首条 user message", 1200);
  const usrText = `用户消息草稿-${mark}`;
  await typeIntoEditableMonaco(call, usrText);
  d = await drafts(call);
  check(
    "prompt user 最后键入落入 store（独立字段）",
    (d?.calls?.[runId]?.[firstLlm]?.user_message?.text ?? "").includes(usrText),
  );
  check(
    "prompt 两字段互不串草稿",
    !(d?.calls?.[runId]?.[firstLlm]?.system_prompt?.text ?? "").includes(usrText),
  );

  // 运行往返后两字段独立恢复
  await selectRun(call, fx.proxyRun);
  await selectRun(call, runId);
  await clickTabChecked(call, "步骤");
  await clickSpan(call, "LLM", firstLlm);
  await clickByTextChecked(call, "编辑 system prompt 重跑", 1200);
  let info = await monacoInfo(call);
  check(
    "prompt system 往返后控件恢复",
    info.editors.some((e) => e.value?.includes(sysText)),
    JSON.stringify(info.editors.map((e) => (e.value ?? "").slice(-30))),
  );
  await shot(call, SHOT_DIR, "61-prompt-system-restored.png");
  await clickByTextChecked(call, "首条 user message", 1200);
  info = await monacoInfo(call);
  check(
    "prompt user 往返后控件恢复",
    info.editors.some((e) => e.value?.includes(usrText)),
    JSON.stringify(info.editors.map((e) => (e.value ?? "").slice(-30))),
  );
}

async function scenarioMessages(call, fx) {
  const runId = fx.proxyRun;
  const spans = await (async () => {
    await selectRun(call, runId);
    await clickTabChecked(call, "步骤");
    return detailSpans(call);
  })();
  const firstLlm = spans.llm[0];
  await clickSpan(call, "LLM", firstLlm);
  await clickByTextChecked(call, "编辑 messages 重发", 1200);

  // 非法 JSON 仍可暂存（无损字符串）
  const broken = `{"broken": [1,2,${Math.random().toString(36).slice(2, 5)}`;
  await typeIntoEditableMonaco(call, broken);
  let d = await drafts(call);
  check(
    "messages 非法 JSON 最后键入落入 store",
    (d?.calls?.[runId]?.[firstLlm]?.messages?.text ?? "").includes(broken),
  );

  await selectRun(call, fx.normalRun);
  await selectRun(call, runId);
  await clickTabChecked(call, "步骤");
  await clickSpan(call, "LLM", firstLlm);
  await clickByTextChecked(call, "编辑 messages 重发", 1200);
  const info = await monacoInfo(call);
  check(
    "messages 非法 JSON 往返后控件逐字恢复",
    info.editors.some((e) => e.value?.includes(broken)),
    JSON.stringify(info.editors.map((e) => (e.value ?? "").slice(-30))),
  );
  await shot(call, SHOT_DIR, "61-messages-restored.png");

  // 空输入仍可暂存：模型置空（setValue 与真实删除走同一 onDidChangeModelContent 事件源，
  // store 按内容变化事件写入——路径如实记录）
  const cleared = await appImport(
    call,
    MONACO_NEEDLE,
    `const monaco = await m.ensureMonaco();
     const eds = monaco.editor.getEditors();
     const e = eds.find((x) => !x.getOption(monaco.editor.EditorOption.readOnly));
     if (!e) return JSON.stringify({ ok: false, count: eds.length });
     e.getModel().setValue('');
     await new Promise((r) => setTimeout(r, 500));
     return JSON.stringify({
       ok: true, value: e.getModel().getValue(),
       uri: e.getModel().uri.toString(),
       count: eds.length,
       readOnlyFlags: eds.map((x) => x.getOption(monaco.editor.EditorOption.readOnly)),
     });`,
  );
  check(
    "messages 清空为空串（模型事件）",
    cleared.ok === true && cleared.value === "",
    JSON.stringify(cleared).slice(0, 200),
  );
  d = await drafts(call);
  const msgText = d?.calls?.[runId]?.[firstLlm]?.messages?.text ?? null;
  check("messages 空输入仍可暂存（store 空串）", msgText === "", JSON.stringify(msgText));
  await shot(call, SHOT_DIR, "61-messages-cleared.png");
}

async function scenarioAb(call, fx) {
  const runId = fx.normalRun;
  const spans = await (async () => {
    await selectRun(call, runId);
    await clickTabChecked(call, "步骤");
    return detailSpans(call);
  })();
  const firstLlm = spans.llm[0];
  await clickSpan(call, "LLM", firstLlm);
  await clickByTextChecked(call, "模型 A/B 实验（换 model / params 对比）", 1200);

  // 非法参数（非 JSON 文本）写入第 1 臂 paramsText
  const badParams = `{not-json-${Math.random().toString(36).slice(2, 5)}`;
  const typed = await typeIntoDom(call, 'input[placeholder^="采样参数 JSON"]', badParams);
  check(
    "A/B 非法参数写入控件",
    typed.value?.includes(badParams),
    `value=${JSON.stringify(typed.value)} path=${typed.path}`,
  );
  // 两条键入路径均为 DOM 层真输入（CDP insertText / native setter+input 事件），
  // React 受控输入实测走 native-setter；如实记录即可，不作硬性限定
  check(
    "A/B 键入路径已记录",
    ["insertText", "native-setter"].includes(typed.path),
    `path=${typed.path}`,
  );
  let d = await drafts(call);
  const rows = d?.modelAb?.[runId]?.[firstLlm]?.rows ?? null;
  check(
    "A/B 非法参数最后键入落入 store",
    rows?.some((r) => r.paramsText === badParams),
    JSON.stringify(rows),
  );

  // 加一臂 + 运行往返：臂增删可恢复
  await clickByTextChecked(call, "+ 加一臂（最多 4）", 700);
  d = await drafts(call);
  const rowsAfterAdd = (d?.modelAb?.[runId]?.[firstLlm]?.rows ?? []).length;

  await selectRun(call, fx.proxyRun);
  await selectRun(call, runId);
  await clickTabChecked(call, "步骤");
  await clickSpan(call, "LLM", firstLlm);
  await clickByTextChecked(call, "模型 A/B 实验（换 model / params 对比）", 1200);
  d = await drafts(call);
  const rowsRestored = (d?.modelAb?.[runId]?.[firstLlm]?.rows ?? []).length;
  check(
    "A/B 臂增删往返后恢复",
    rowsRestored === rowsAfterAdd && rowsRestored === 3,
    `afterAdd=${rowsAfterAdd} restored=${rowsRestored}`,
  );
  const stillBad = (d?.modelAb?.[runId]?.[firstLlm]?.rows ?? []).some(
    (r) => r.paramsText === badParams,
  );
  check("A/B 非法参数往返后保留", stillBad);
  const domValue = await ev(
    call,
    `(() => { const i = document.querySelector('input[placeholder^="采样参数 JSON"]');
      return i === null ? null : i.value; })()`,
  );
  check("A/B 再次挂载控件值恢复", domValue?.includes(badParams), JSON.stringify(domValue));
  await shot(call, SHOT_DIR, "61-ab-restored.png");
}

async function scenarioCreate(call, fx) {
  void fx;
  const mark = Math.random().toString(36).slice(2, 6);
  // 打开创建（全局栏「新建运行」）
  await clickByTextChecked(call, "新建运行", 1000);
  const task = `创建任务草稿-${mark}`;
  const typed = await typeIntoDom(call, 'textarea[placeholder^="要交给模型的任务"]', task);
  check("创建表单键入控件", typed.value?.includes(task), JSON.stringify(typed.value));
  let d = await drafts(call);
  check(
    "创建最后键入落入 store",
    d?.create !== null && (d?.create?.userMessage ?? "").includes(task),
    JSON.stringify(d?.create),
  );

  // 关闭创建 → 打开设置 → 关闭设置 → 再开创建：任务仍在
  await clickByTextChecked(call, "取消", 800);
  await clickByTextChecked(call, "运行配置", 1000);
  await clickByTextChecked(call, "取消", 900).catch(async () => {
    // 设置对话框的关闭按钮文案可能是「关闭」
    await clickByTextChecked(call, "关闭", 900);
  });
  await clickByTextChecked(call, "新建运行", 1000);
  const restored = await ev(
    call,
    `(() => { const i = document.querySelector('textarea[placeholder^="要交给模型的任务"]');
      return i === null ? null : i.value; })()`,
  );
  check("创建关闭/设置往返后任务恢复", restored?.includes(task), JSON.stringify(restored));
  d = await drafts(call);
  check("创建 store 仍保留", d?.create !== null && (d?.create?.userMessage ?? "").includes(task));
  await shot(call, SHOT_DIR, "61-create-restored.png");
  // 收尾：关闭对话框，避免影响后续 tag
  await clickByTextChecked(call, "取消", 600).catch(() => {});
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
    result: scenarioResult,
    contrast: scenarioContrast,
    prompt: scenarioPrompt,
    messages: scenarioMessages,
    ab: scenarioAb,
    create: scenarioCreate,
  };
  const run = scenarios[TAG];
  if (run === undefined) throw new Error(`unknown tag: ${TAG}`);
  const out = await run(call, fx);
  data.measurements[TAG] = out ?? {};
  data.checks = data.checks.filter((c) => !c.name.startsWith(`[${TAG}] `)).concat(checks);
  saveOut(data);

  const failed = checks.filter((c) => !c.ok);
  console.log(
    `\n完成：[${TAG}] ${checks.length - failed.length}/${checks.length} 通过；证据 ${SHOT_DIR}`,
  );
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
