/**
 * U2 任务 5.4：双侧异常、延迟切换/重试及工具命令的**实机**验收。
 *
 * 覆盖（spec 五场景）：
 *   ① 不可用侧不伪装为空差异（含左右互换）—— 两侧分别标出真实状态、**可读侧完整展示并可复制查找**、
 *      不把不可用侧置空参与 diff。
 *   ② 两侧都不可读时没有伪空编辑器 —— 无假空文件、不宣称无变化、仍给元信息/重试。
 *   ③ 快速切换不串清单正文错误和加载 —— 旧（延迟的）响应不得改写新选择。
 *   ④ 同对象重试与往返有请求代次 —— A→B→A 中最旧的 A 迟到返回时只认最新代次。
 *   ⑤ 复制路径原文及元信息 + 查找换行和差异定位使用当前文件（含"不可比较或未就绪时工具诚实禁用"）。
 *
 * ⚠️ 与 5.1–5.3 同纪律：
 *   - 禁用 `Emulation.setDeviceMetricsOverride`（破坏 Monaco automaticLayout）。
 *   - 全部断言来自**真机真交互**（真点击 / 真键入 / 真滚轮）+ 真 store / 真 monaco 读取；
 *     不以静态结构测试代替点击与内容核对。
 *   - 脚本不 spawn、不改窗、不重启 dev。
 *
 * 两条读取通道（均不改产品代码）：
 *   - **DOM**：状态卡文案、工具栏按钮可用性、编辑器 DOM、find widget —— 用户真正看得见的。
 *   - **store**（仅 dev）：从 `performance` 资源表解析应用**自己用过的模块 URL** 再 `import()`，
 *     拿到与组件同一实例的 `useAppStore`。⚠️ **不可**写 `import('/src/store.ts')`：模块身份 =
 *     完整 URL，那会拿到另一份空 store 且不报错（假阴性，2026-09-23 已踩）。
 *   - **monaco**：同上，经 `monaco-bootstrap.ts` 的 `ensureMonaco()` 拿到与界面同一实例的
 *     `monaco` 命名空间，用来读**真实模型文本 / 真实 diff / readOnly 选项**。
 *
 * 迟到响应注入（③④）：把 store 的 `readWorkspaceFile` / `inspectWorkspace` 两个**动作**
 *   换成"读 `window.__u254cfg` 规则再调用原动作"的包装层。为什么能这么做且不引入杂音：
 *   包装层在**进入文件页之前**装好（避免 React 依赖变化额外触发读取），且包装函数引用
 *   **全程稳定**（规则放在可变对象里），子场景之间只改规则、不重装。
 *   ⚠️ 页面每次冷重载都会清空 `window`，故每个 tag 都从干净起点开始。
 *
 * 用法（每次一个 tag）：
 *   node apps/desktop/scripts/u2-54-cdp.cjs --tag=probe
 *   node apps/desktop/scripts/u2-54-cdp.cjs --tag=sides
 *   node apps/desktop/scripts/u2-54-cdp.cjs --tag=both-unreadable
 *   node apps/desktop/scripts/u2-54-cdp.cjs --tag=tools-copy
 *   node apps/desktop/scripts/u2-54-cdp.cjs --tag=tools-find
 *   node apps/desktop/scripts/u2-54-cdp.cjs --tag=race-retry
 */
"use strict";

const { mkdirSync, writeFileSync, readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { REPO, sleep, cdpConnect, makeSession, ev, shot } = require("./lib/u2-cdp-util.cjs");

const PORT = 9612;
const OUT_DIR = join(REPO, ".workbuddy", "u2-54");
const SHOT_DIR = join(REPO, "docs", "reviews", "2026-09-23-u2-54");
const OUT = join(OUT_DIR, "measurements.json");

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag", "probe");

// —— 夹具（见 .rebaseagent/u2-file-fixtures/SIDE-MANIFEST.json 与 MANIFEST.json）——
const SIDE_RUN = "run_mue9rvkh_i9oil7"; // 引擎原生：初始侧 binary / 所选侧 text
const BROKEN_RUN = "u2side_mirror"; // 手工镜像：初始侧 text / 所选侧 binary（左右互换）
const BINARY_FILE = "was-binary.dat"; // 第 2 轮末被写回文本
const STEADY_FILE = "steady.txt";
const SIDE_TEXT = "现在是文本内容"; // was-binary.dat 第 2 轮改写后的文本
const STEADY_INITIAL = "初始文本内容"; // steady.txt 初始（镜像标本的可读侧）
const STEADY_AFTER = "第二轮改写后的文本"; // steady.txt 第 2 轮改写后
const ROOT_RUN = "run_mudwrlbg_199xw1"; // iso：3 轮，含 a.txt/edit.txt/long.txt 等
const EDIT_FILE = "edit.txt"; // "初始版本" → "被改写的版本"（真实 1 处差异）
const LONG_FILE = "long.txt"; // 200 行 + 两条超长行（未改动 ⇒ 真实 0 处差异）

const checks = [];
function check(name, ok, detail) {
  checks.push({ name: `[${TAG}] ${name}`, ok: !!ok, detail: detail ?? null });
}
function loadOut() {
  if (!existsSync(OUT)) return { tag: "u2-5.4", measurements: {}, checks: [] };
  return JSON.parse(readFileSync(OUT, "utf8"));
}
function saveOut(d) {
  d.capturedAt = new Date().toISOString();
  writeFileSync(OUT, JSON.stringify(d, null, 2));
}

// —— 表达式 / 通用求值 ——

/** 异步求值（动态 import 需要 awaitPromise） */
async function evAsync(call, expression) {
  const r = await call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r?.exceptionDetails) {
    throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
  }
  return r?.result?.value;
}

/**
 * 按"应用自己用过的模块 URL"导入应用模块，并执行 body。
 *
 * ⚠️ 见文件头：ES 模块身份 = 完整 URL（含 `?t=` 版本戳）。写死 `/src/...` 会拿到另一份
 *    模块实例（空 store）且**不报错**。故一律先从 `performance` 资源表解析。
 */
async function appImport(call, needles, body) {
  const list = Array.isArray(needles) ? needles : [needles];
  const raw = await evAsync(
    call,
    `(async () => {
      const wanted = ${JSON.stringify(list)};
      const all = performance.getEntriesByType('resource').map(e => e.name)
        .filter(n => wanted.some(w => n.includes(w)));
      const rank = (n) => (n.includes('?t=') ? 0 : n.includes('/@fs/') ? 2 : 1);
      const url = all.slice().sort((a, b) => rank(a) - rank(b))[0] ?? null;
      if (url === null) return JSON.stringify({ error: 'module-url-not-found', needle: wanted.join(' | ') });
      const m = await import(url);
      ${body}
    })()`,
  );
  return JSON.parse(raw);
}

// 候选子串：`/src/renderer/src/...`（@fs 形态）与 `/src/...`（Vite root 内常规服务形态）。
// ⚠️ electron.vite.config.ts 的 renderer `root` = apps/desktop/src/renderer ⇒ 应用侧真实 URL
//    是 `http://localhost:5173/src/store.ts`；只写单形态会在换加载路径时匹配不到
//    （2026-09-24 验收复跑实测踩到，5.5/5.6 已用同款候选数组规避）。
const STORE_NEEDLE = ["/src/renderer/src/store.ts", "/src/store.ts"];

/** 读某 run 的文件阅读会话状态（权威：位置/选择是否真的被记住） */
async function storeState(call, runId) {
  return appImport(
    call,
    STORE_NEEDLE,
    `const rsNeedles = ['/src/renderer/src/lib/reading-state.ts', '/src/lib/reading-state.ts'];
      const rsAll = performance.getEntriesByType('resource').map(e => e.name)
        .filter(n => rsNeedles.some(w => n.includes(w)));
      const rsrank = (n) => (n.includes('?t=') ? 0 : n.includes('/@fs/') ? 2 : 1);
      const rsUrl = rsAll.slice().sort((a, b) => rsrank(a) - rsrank(b))[0] ?? null;
      if (rsUrl === null) return JSON.stringify({ error: 'module-url-not-found', needle: 'reading-state' });
      const rs = await import(rsUrl);
      const st = m.useAppStore.getState();
      const r = rs.readingStateOf(st.readingByRun, ${JSON.stringify(runId)});
      const f = rs.fileReadingOf(r);
      return JSON.stringify({
        moduleUrl: url, tab: r.tab, spanId: r.spanId,
        checkpoint: f.checkpoint, path: f.path, pane: f.pane,
        query: f.query, filter: f.filter, wordWrap: f.wordWrap, diffPreference: f.diffPreference,
        byRunKeys: Object.keys(st.readingByRun),
      });`,
  );
}

/**
 * **store 通道自检**：确认拿到的是应用活实例（模块实例拿错时不报错、只静默返回常量）。
 */
async function assertStoreLive(call, runId) {
  const s = await storeState(call, runId);
  if (s.error !== undefined) throw new Error(`store 探针失败：${JSON.stringify(s)}`);
  if (!Array.isArray(s.byRunKeys) || !s.byRunKeys.includes(runId)) {
    throw new Error(
      `store 探针未拿到应用同一实例（byRunKeys=${JSON.stringify(s.byRunKeys)}，moduleUrl=${s.moduleUrl}）`,
    );
  }
  return s;
}

/** 调用真实 store 动作（与界面同一 API 的另一形态） */
async function callStoreAction(call, body) {
  return appImport(call, STORE_NEEDLE, `${body}\n    return JSON.stringify({ ok: true });`);
}

// —— monaco 通道 ——

const MONACO_NEEDLE = ["/src/renderer/src/monaco-bootstrap.ts", "/src/monaco-bootstrap.ts"];

/**
 * 读**真 monaco**（与界面同一实例）的事实：模型文本、真实 diff、readOnly 选项、find 关联。
 *
 * 为什么要它：spec 要求"可读侧**完整展示**"、"差异导航使用**已完成的真实 diff**"、
 * "禁用替换和修改"——这三条都只能从真编辑器实例读，DOM 只能证明"看得见"。
 */
async function monacoState(call) {
  return appImport(
    call,
    MONACO_NEEDLE,
    `const bs = await import(url);
      const monaco = await bs.ensureMonaco();
      const getText = (e) => { const md = e.getModel(); return md === null ? null : md.getValue(); };
      const diff = monaco.editor.getDiffEditors()[0] ?? null;
      const edits = monaco.editor.getEditors();
      return JSON.stringify({
        loaded: true,
        models: monaco.editor.getModels().map(md => ({ lines: md.getLineCount(), text: md.getValue() })),
        standalone: edits.map(e => ({
          readOnly: e.getOption(monaco.editor.EditorOption.readOnly),
          text: getText(e),
          position: e.getPosition(),
        })),
        diff: diff === null ? null : {
          originalText: getText(diff.getOriginalEditor()),
          modifiedText: getText(diff.getModifiedEditor()),
          lineChangeCount: (diff.getLineChanges() ?? []).length,
          modifiedReadOnly: diff.getModifiedEditor().getOption(monaco.editor.EditorOption.readOnly),
          modifiedPosition: diff.getModifiedEditor().getPosition(),
        },
      });`,
  );
}

/** monaco 未加载时返回 null（而不是抛错）——"一个编辑器都没渲染"本身就是要记录的事实 */
async function monacoOrNull(call) {
  try {
    const s = await monacoState(call);
    return s.error !== undefined ? null : s;
  } catch {
    return null;
  }
}

/** 所有已加载模型的文本里是否出现过某片段（= 可读侧原文真的被渲染出来了） */
function anyModelContains(m, fragment) {
  if (m === null) return false;
  const inModels = (m.models ?? []).some((x) => (x.text ?? "").includes(fragment));
  const inDiff =
    (m.diff?.originalText ?? "").includes(fragment) ||
    (m.diff?.modifiedText ?? "").includes(fragment);
  const inSingle = (m.standalone ?? []).some((x) => (x.text ?? "").includes(fragment));
  return inModels || inDiff || inSingle;
}

// —— DOM 通道 ——

const domExpr = `(() => {
  const q = (s, r = document) => r.querySelector(s);
  const txt = (e) => ((e && e.textContent) || '').trim();
  const btn = (label) => {
    const b = Array.from(document.querySelectorAll('button')).find(x => txt(x) === label);
    return b === undefined ? null : { disabled: b.disabled === true, title: b.title || '' };
  };
  const body = document.body.textContent || '';
  const w = q('.find-widget');
  // monaco 的查找输入框不挂在 input[aria-label=...] 上：它是 .monaco-inputbox 内的 .input
  // （标签由 monaco 自己按 locale 设置，且可能是 textarea/input）⇒ 按类取，才能真读到值。
  const fwi = w === null ? null : (q('.monaco-inputbox .input', w) || q('input', w) || q('textarea', w));
  const fw = w === null ? null : {
    shown: w.classList.contains('visible') || w.getBoundingClientRect().height > 0,
    text: txt(w),
    input: fwi === null ? null : fwi.value,
    inputTag: fwi === null ? null : fwi.tagName.toLowerCase(),
    replaceShown: (() => { const rp = q('.replace-part', w); return rp === null ? false : getComputedStyle(rp).display !== 'none'; })(),
    // monaco 的 .matchesCount：有匹配是 "{位置} of {总数}"（含数字），无匹配是 NLS_NO_RESULTS
    // （英文 "No results"）。**按"有没有数字"判**才不绑 locale（5.4 踩过：硬断 /无结果/ 必假失败）。
    matchesCount: (() => { const mc = q('.matchesCount', w); return mc === null ? null : txt(mc); })(),
  };
  return JSON.stringify({
    cw: document.documentElement.clientWidth, ch: document.documentElement.clientHeight,
    dpr: +devicePixelRatio.toFixed(2),
    tabSelected: txt(Array.from(document.querySelectorAll('[role="tab"]')).find(t => t.getAttribute('aria-selected') === 'true')),
    // 文件列表项也是 .break-all.font-code ⇒ 取不在 [role=option] 里的那个（即内容区标题）
    pathHeader: txt(Array.from(document.querySelectorAll('.break-all.font-code')).find(x => x.closest('[role="option"]') === null)),
    // 编辑器锚点（**必须用真实挂载后的 DOM**）：
    // @monaco-editor/react 只通过 wrapperProps 透传 data-*，直接给 <Editor>/<DiffEditor> 的
    // data-testid 在编辑器**已加载**时根本不落到 DOM（仅懒加载占位 MonacoFallback 期间存在）
    // ⇒ 用它判"有没有编辑器"会得到假结果（5.4 踩过）。故：diff 用 monaco 原生容器类，
    // 单侧视图用产品挂在**真实包裹层**上的 data-testid。
    hasDiffEditor: !!q('.monaco-diff-editor'),
    hasSingleSideEditor: !!q('[data-testid="single-side-editor"]'),
    hasDiffPlaceholder: !!q('[data-testid="diff-editor"]'),
    hasDiffClass: !!q('.monaco-diff-editor'),
    hasCodeEditorClass: !!q('.monaco-editor'),
    // 状态卡（正文区 .m-4 卡片）
    cards: Array.from(document.querySelectorAll('div.m-4')).map(txt),
    statusBinary: body.includes('二进制文件'),
    statusNotComparable: body.includes('内容不可读'),
    cardNoDiff: body.includes('不进入文本差异'),
    sideLabelsBoth: body.includes('初始快照侧') && body.includes('所选检查点侧'),
    sideLabelLeftRight: body.includes('左：本 run 初始状态'),
    sideMissingLabel: body.includes('该侧不存在'),
    sideUnavailableRule: /内容不可比较（二进制/.test(body),
    sideHasText: /有文本/.test(body),
    sideReadFailed: /读取失败（不是不存在）/.test(body),
    // 判据要排除产品自己的**说明性文案**（"绝不会用空编辑器冒充\"文件是空的\""），
    // 否则说明句本身就把判据点着了（假阳性）。
    fakeEmptyClaim: (() => {
      const stripped = body.replace(/绝不会用空编辑器冒充[\\s\\S]*?参与 diff。/g, '');
      return /无变化|文件为空|文件是空的/.test(stripped);
    })(),
    diffCountText: (() => { const m = body.match(/共\\s*(\\d+)\\s*处差异/); return m === null ? null : Number(m[1]); })(),
    retryInitialBtn: btn('重新读取初始快照') !== null,
    retryContentBtn: btn('重新读取所选侧') !== null,
    // 独占错误卡（另一侧也不可读时）只给**该文件**的重试入口
    retryFileBtn: btn('重新读取该文件') !== null,
    // 失败**不冒充"不存在"**：两种写法的任一（两侧状态行 / 独占错误卡）
    failureNotMissing: body.includes('并不表示该文件不存在') || body.includes('读取失败（不是不存在）'),
    toolbar: {
      复制路径: btn('复制路径'),
      复制左侧原文: btn('复制左侧原文'),
      复制右侧原文: btn('复制右侧原文'),
      复制元信息: btn('复制元信息'),
      换行开: btn('换行：开'),
      换行关: btn('换行：关'),
      查找: btn('查找'),
      上一差异: btn('上一差异'),
      下一差异: btn('下一差异'),
      模式: (() => { const b = Array.from(document.querySelectorAll('button')).find(x => txt(x).startsWith('模式：')); return b === undefined ? null : { label: txt(b), title: b.title || '' }; })(),
    },
    feedback: Array.from(document.querySelectorAll('span')).map(txt).filter(t => /已复制|剪贴板|复制失败/.test(t)).join(' | '),
    fileOptions: Array.from(document.querySelectorAll('[role="option"][data-file-path]')).map(e => e.getAttribute('data-file-path')),
    selectedFile: (() => { const e = q('[role="option"][aria-selected="true"]'); return e === null ? null : e.getAttribute('data-file-path'); })(),
    query: (() => { const i = q('input[aria-label="按完整路径搜索文件"]'); return i === null ? null : i.value; })(),
    ckpts: Array.from(document.querySelectorAll('button'))
      .filter(b => (b.title || '').includes('检查点所属 step') || (b.title || '').includes('文件世界起点'))
      .map(b => ({ label: txt(b), active: b.className.includes('bg-violet-600') })),
    filterBtns: Array.from(document.querySelectorAll('button'))
      .filter(b => ['自动', '全部', '有变化'].includes(txt(b)))
      .map(b => ({ label: txt(b), active: b.className.includes('bg-violet-600') })),
    listVisible: (() => { const el = q('[data-list-scroll-top]'); return el === null ? false : el.getClientRects().length > 0; })(),
    bodyHasLoading: /正在读取|正在加载编辑器/.test(body),
    findWidget: fw,
  });
})()`;

async function dom(call) {
  return JSON.parse(await ev(call, domExpr));
}

/**
 * find widget 的**locale 无关**判据：`.matchesCount` 里有数字 ⇒ 有匹配（"{位置} of {总数}"），
 * 没有数字 ⇒ 0 匹配（NLS_NO_RESULTS，英文 "No results" / 中文 "无结果"）。
 *
 * `matchesCount === null`（探针没找到元素）判为**不成立**，避免探针失效时断言变成空转真。
 */
const findHasMatches = (d) =>
  d.findWidget !== null &&
  typeof d.findWidget.matchesCount === "string" &&
  /\d/.test(d.findWidget.matchesCount);
const findNoMatches = (d) =>
  d.findWidget !== null &&
  typeof d.findWidget.matchesCount === "string" &&
  !/\d/.test(d.findWidget.matchesCount);

// —— 真交互助手 ——

const RUNS_EXPR = `(() => JSON.stringify(Array.from(document.querySelectorAll('button'))
  .map(b => b.getAttribute('aria-label') || '')
  .filter(a => a.startsWith('复制完整运行 ID'))
  .map(a => a.replace('复制完整运行 ID ', ''))))()`;

async function runs(call) {
  return JSON.parse(await ev(call, RUNS_EXPR));
}

/** 选中一个 run（medium 档文件页会收起运行导航 ⇒ 真实用户路径是**先回概览**） */
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

const CKPT_FILTER = `(b => (b.title || '').includes('检查点所属 step') || (b.title || '').includes('文件世界起点'))`;

/** 当前活动的检查点文案（null = 一个活动项都没有） */
const CKPT_ACTIVE_EXPR = `(() => { const a = Array.from(document.querySelectorAll('button')).filter(${CKPT_FILTER})
  .find(b => b.className.includes('bg-violet-600')); return a === null ? null : ((a.textContent||'').trim()); })()`;

/**
 * 按标签选检查点（如 "第 2 轮" / "初始状态"）——夹具轮数不定，按文案定位比下标稳。
 *
 * ⚠️ 必须**点击后校验活动项**：按钮存在不等于点击生效（DOM 可能尚未就绪、点击被忽略）。
 * 静默返回 false 会让"没切检查点"被后续判据当成产品缺陷，属于**污染证据**。
 */
async function pickCheckpointLike(call, fragment) {
  const click = `(() => { const c = Array.from(document.querySelectorAll('button')).filter(${CKPT_FILTER});
    const t = c.find(b => ((b.textContent||'').trim()).includes(${JSON.stringify(fragment)}));
    if (!t) return null; const label = (t.textContent||'').trim(); t.click(); return label; })()`;
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const label = await ev(call, click);
    if (label === null) {
      await sleep(900);
      continue;
    }
    await sleep(1500);
    const active = await ev(call, CKPT_ACTIVE_EXPR);
    if (active === label) return true;
    last = { label, active };
    await sleep(600);
  }
  throw new Error(
    `未能把检查点切到「${fragment}」（最后一次 ${JSON.stringify(last)}）——DOM 未就绪或点击不生效`,
  );
}

/** 点变化筛选（自动/全部/有变化）。默认 `auto` 在完成步骤解析为 `changed`，未改动文件不在清单 */
async function pickFilter(call, label) {
  const click = `(() => { const b = Array.from(document.querySelectorAll('button'))
      .find(x => ((x.textContent||'').trim()) === '${label}');
    if (!b) return false; b.click(); return true; })()`;
  const activeExpr = `(() => { const a = Array.from(document.querySelectorAll('button'))
    .filter(b => ['自动','全部','有变化'].includes(((b.textContent||'').trim())))
    .find(b => b.className.includes('bg-violet-600')); return a === null ? null : ((a.textContent||'').trim()); })()`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ok = await ev(call, click);
    if (ok !== true) {
      await sleep(900);
      continue;
    }
    await sleep(900);
    if ((await ev(call, activeExpr)) === label) return true;
    await sleep(500);
  }
  throw new Error(`未能把变化筛选切到「${label}」`);
}

/** 选定文件（目录不常驻时先切到列表 pane；再切回内容） */
async function pickFile(call, path) {
  const click = `(() => { const b = document.querySelector('[role="option"][data-file-path="${path}"]');
      if (!b) return false; b.click(); return true; })()`;
  let hit = await ev(call, click);
  if (hit !== true) {
    await clickByAria(call, "显示文件列表");
    hit = await ev(call, click);
  }
  if (hit !== true) return false;
  await sleep(1400);
  await clickByAria(call, "显示文件内容", 900);
  // 校验真的切换了选中项（点击不生效时不能当"成功选中"继续走判据）
  const selected = await ev(
    call,
    `(() => { const e = document.querySelector('[role="option"][aria-selected="true"]');
      return e === null ? null : e.getAttribute('data-file-path'); })()`,
  );
  return selected === path;
}

/** 真输入（聚焦 + select + Input.insertText） */
async function typeInto(call, ariaLabel, text) {
  const ok = await ev(
    call,
    `(() => { const i = document.querySelector('input[aria-label="${ariaLabel}"]');
      if (!i) return false; i.focus(); i.select(); return true; })()`,
  );
  if (ok !== true) return false;
  await call("Input.insertText", { text });
  await sleep(700);
  return true;
}

/**
 * 真输入到 **monaco 查找框**。
 *
 * ⚠️ 不能用 `typeInto(call, "查找", …)`：查找框不是 `input[aria-label="查找"]`（monaco 自己按
 *    locale 设标签，英文是 "Find"，且内核可能是 textarea）⇒ 那个选择器恒为空、**一个字符都
 *    没输进去**。5.4 实测过它的后果：查找框被 monaco 用"编辑器里的选区"**自动预填**，
 *    于是"有匹配"断言在**没输入任何东西**的情况下假通过（`typeFind=false` 却 `1 of 1`）。
 *    这里按 DOM 类定位，并把预填文本 select 掉后用 `Input.insertText` 真替换。
 */
async function typeIntoFind(call, text) {
  const ok = await ev(
    call,
    `(() => { const w = document.querySelector('.find-widget');
      if (!w) return false;
      const i = w.querySelector('.monaco-inputbox .input') || w.querySelector('input') || w.querySelector('textarea');
      if (!i) return false; i.focus(); i.select(); return true; })()`,
  );
  if (ok !== true) return false;
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

/** 进入某 run 的文件页（ckptFragment 非空则按文案选检查点；filterLabel 非空则点筛选） */
async function enterFiles(call, runId, ckptFragment = null, filterLabel = null) {
  const m = {};
  /**
   * ⚠️ `runs()` 读的是**运行名单的 DOM 按钮**，而 medium 档在文件页会收起运行导航
   * ⇒ 此时一个 run 都量不到。若直接据此早退，`enterFiles` 会**静默什么都不做**，
   * 后续判据便拿上一次的页面状态去断言（曾被误判成"点击检查点不生效"的产品缺陷）。
   * 所以先回概览把名单读出来，读不到就**抛错**而不是静默返回。
   */
  let available = (await runs(call)).includes(runId);
  if (!available) {
    await clickTab(call, "概览");
    available = (await runs(call)).includes(runId);
  }
  m.runAvailable = available;
  if (!available) throw new Error(`运行 ${runId} 不在运行名单里（已回概览重读）`);
  const picked = await selectRun(call, runId);
  m.selected = picked.ok;
  m.selectDetour = picked.detour;
  m.filesTab = await clickTab(call, "文件");
  if (ckptFragment !== null) m.ckpt = await pickCheckpointLike(call, ckptFragment);
  if (filterLabel !== null) m.filter = await pickFilter(call, filterLabel);
  m.live = await assertStoreLive(call, runId);
  return m;
}

// —— 剪贴板 ——

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

const readClipboard = (call) => evAsync(call, "navigator.clipboard.readText()");

/**
 * 剪贴板文本归一：**Windows 会把 LF 规范化为 CRLF**。
 *
 * 官方 `navigator.clipboard.writeText` 在 Windows 上按平台换行规则落地，读回时每个 `\n`
 * 变成 `\r\n`（5.4 实测：模型 8529 字符 → 剪贴板 8732，差 203 = 行数）。这是**平台行为**
 * 而非产品缺陷（产品写入的是逻辑全文，逐字节正确）⇒ 断言前统一归一，仅用于比较。
 */
const normClip = (s) => (typeof s === "string" ? s.replace(/\r\n/g, "\n") : s);

/**
 * 复制按钮 → 读回剪贴板。步骤：清空剪贴板 → 点按钮 → 读回。
 * 返回 { clicked, clip, feedback }。
 */
async function copyVia(call, label, wait = 900) {
  await evAsync(
    call,
    `(async () => { try { await navigator.clipboard.writeText('__u254_empty__'); } catch (e) {} return 'ok'; })()`,
  );
  const clicked = await clickByText(call, label, wait);
  const clip = await readClipboard(call).catch(() => null);
  const d = await dom(call);
  return { clicked, clip, feedback: d.feedback };
}

// —— 迟到响应注入（③④）——

/**
 * 装"规则驱动的 IPC 包装层"。包装层引用**全程稳定**（规则放 `window.__u254cfg`），
 * 因此子场景之间只改规则、不重装，也不会因 React 依赖变化而多触发读取。
 * 必须在**进入文件页之前**调用。
 */
async function installHooks(call) {
  return appImport(
    call,
    STORE_NEEDLE,
    `const store = m.useAppStore;
      if (window.__u254orig === undefined) {
        const st0 = store.getState();
        window.__u254orig = { r: st0.readWorkspaceFile, i: st0.inspectWorkspace };
        window.__u254cfg = { rules: [] };
        window.__u254n = {};
        window.__u254log = [];
      }
      const match = (kind, key, occ, side) => {
        const rules = (window.__u254cfg && window.__u254cfg.rules) || [];
        return rules.find(r => r.kind === kind && (r.key === undefined || r.key === key)
          && (r.side === undefined || r.side === side)
          && (r.occurrence === undefined || r.occurrence === occ) && r.done !== true) || null;
      };
      const mark = (o, kind, key, occ, side) => {
        window.__u254log.push({ kind: kind, key: key, side: side, occurrence: occ, at: Date.now(), delayMs: o && o.delayMs ? o.delayMs : 0, mode: o === null ? 'pass' : (o.fail ? 'fail' : (o.sentinelText !== undefined ? 'sentinel' : 'delay')) });
      };
      const wrap = (kind, orig) => async (req) => {
        const key = kind === 'read' ? String(req.path) : String(req.stepSpanId === undefined || req.stepSpanId === null ? 'initial' : req.stepSpanId);
        // 读请求的"哪一侧"：省略 stepSpanId = 初始快照侧，带 span id = 所选检查点侧。
        // ⚠️ 注入必须能**点名某一侧**：同一条路径的两侧读共用 key，若只按 key 匹配，
        //    失败/哨兵会落在"先发出的那一次"，断言就不可控（5.4 实测到的歧义）。
        const side = kind === 'read' ? (req.stepSpanId === undefined || req.stepSpanId === null ? 'initial' : 'selected') : 'n/a';
        window.__u254n[key] = (window.__u254n[key] || 0) + 1;
        const occ = window.__u254n[key];
        const o = match(kind, key, occ, side);
        if (o !== null) o.done = true;
        mark(o, kind, key, occ, side);
        if (o !== null && o.delayMs) await new Promise(r => setTimeout(r, o.delayMs));
        const out = await orig(req);
        if (o === null) return out;
        if (o.fail) return { ok: false, code: o.fail, message: '注入的（迟到）业务失败' };
        if (o.sentinelText !== undefined && out.ok && out.data && out.data.status === 'text') {
          return { ok: true, data: { ...out.data, text: o.sentinelText } };
        }
        return out;
      };
      store.setState({ readWorkspaceFile: wrap('read', window.__u254orig.r), inspectWorkspace: wrap('inspect', window.__u254orig.i) });
      return JSON.stringify({ ok: true });`,
  );
}

async function setRules(call, rules) {
  // ⚠️ 同时**重置代次计数**：`occurrence` 是"该 key 第几次读取"，若计数跨子场景累加，
  //    后续子场景的 `occurrence:1` 规则会被上一个子场景消费掉 ⇒ 注入静默失效（5.4 踩过：
  //    日志显示 `mode=sentinel,pass,…`，失败注入从未生效）。每次换规则即视为新开局。
  return evAsync(
    call,
    `(() => { window.__u254cfg.rules = ${JSON.stringify(rules)}; window.__u254n = {}; return 'ok'; })()`,
  );
}

async function hookLog(call) {
  return JSON.parse(await evAsync(call, "(() => JSON.stringify(window.__u254log || []))()"));
}

// —— 场景 ——

/**
 * 探路：只 dump 真机事实（夹具可见性、检查点文案、API 可包装性、剪贴板授权）。
 */
async function scenarioProbe(call) {
  const m = {};
  m.location = await ev(call, "location.href");
  m.runs = await runs(call);
  m.resources = JSON.parse(
    await ev(
      call,
      `(() => JSON.stringify(performance.getEntriesByType('resource').map(e => e.name)
        .filter(n => /store\\.ts|monaco-bootstrap|editor\\.api|reading-state/.test(n)).slice(0, 12)))()`,
    ),
  );
  m.apiPatchable = JSON.parse(
    await ev(
      call,
      `(() => {
        const a = window.api;
        if (!a) return JSON.stringify({ has: false });
        const d = Object.getOwnPropertyDescriptor(a, 'readWorkspaceFile');
        let assignOk = null, err = null;
        try { const orig = a.readWorkspaceFile; a.readWorkspaceFile = orig; assignOk = a.readWorkspaceFile === orig; }
        catch (e) { err = String(e); }
        return JSON.stringify({ has: true, frozen: Object.isFrozen(a), desc: d ? { writable: d.writable, configurable: d.configurable, hasGet: !!d.get } : null, assignOk: assignOk, err: err });
      })()`,
    ),
  );
  m.grant = await grantClipboard(call, new URL(m.location).origin);
  m.clipBefore = await readClipboard(call).catch((e) => `ERR:${e.message}`);

  // 夹具 run 的检查点文案 + 文件清单（side-data 第 2 轮末）
  Object.assign(m, await enterFiles(call, SIDE_RUN, "第 2 轮", "全部"));
  m.sideDom = await dom(call);
  m.sideStore = await storeState(call, SIDE_RUN);
  m.sideOpen = await pickFile(call, BINARY_FILE);
  m.sideOpenedDom = await dom(call);
  m.sideMonaco = await monacoOrNull(call);
  await shot(call, SHOT_DIR, `${TAG}-1-side-第2轮-binary-file.png`);

  const r1 = await enterFiles(call, SIDE_RUN, "第 1 轮", "全部");
  Object.assign(m, r1);
  m.sideRound1Active = await ev(call, CKPT_ACTIVE_EXPR);
  m.sideRound1Store = r1.live;
  m.sideRound1Dom = await dom(call);

  const rb = await enterFiles(call, BROKEN_RUN, "第 1 轮", "全部");
  Object.assign(m, rb);
  m.brokenActive = await ev(call, CKPT_ACTIVE_EXPR);
  m.brokenStore = rb.live;
  m.brokenDom = await dom(call);
  m.brokenOpen = await pickFile(call, STEADY_FILE);
  m.brokenOpenedDom = await dom(call);
  m.brokenMonaco = await monacoOrNull(call);
  await shot(call, SHOT_DIR, `${TAG}-2-mirror-第1轮-steady.png`);
  return m;
}

/**
 * ① 不可用侧不伪装为空差异（含左右互换）。
 *
 * A：side-data 第 2 轮末 + was-binary.dat ⇒ 初始侧 binary / 所选侧 text
 * B：u2side_mirror 第 1 轮末 + steady.txt ⇒ 初始侧 text / 所选侧 binary（左右互换）
 */
async function scenarioSides(call) {
  const m = {};

  // —— A：所选侧可读、初始侧不可用 ——
  Object.assign(m, await enterFiles(call, SIDE_RUN, "第 2 轮", "全部"));
  m.aPick = await pickFile(call, BINARY_FILE);
  await sleep(1200);
  m.aDom = await dom(call);
  m.aMonaco = await monacoOrNull(call);
  m.aStore = await storeState(call, SIDE_RUN);
  await shot(call, SHOT_DIR, `${TAG}-A1-所选可读初始不可用.png`);

  check(
    "A：两侧分别标出真实状态（初始侧=不可比较、所选侧=有文本）",
    m.aDom.sideLabelsBoth && m.aDom.sideUnavailableRule && m.aDom.sideHasText,
    `sideLabelsBoth=${m.aDom.sideLabelsBoth} 不可比较规则=${m.aDom.sideUnavailableRule} 有文本=${m.aDom.sideHasText}；卡片=${JSON.stringify(m.aDom.cards)}`,
  );
  check(
    "A：**可读侧完整展示**（所选侧全文真的渲染进编辑器，不是空/占位）",
    anyModelContains(m.aMonaco, SIDE_TEXT),
    `含"${SIDE_TEXT}"=${anyModelContains(m.aMonaco, SIDE_TEXT)}；monaco=${m.aMonaco === null ? "未加载" : JSON.stringify({ models: (m.aMonaco.models ?? []).map((x) => x.lines), diff: m.aMonaco.diff === null ? null : { o: m.aMonaco.diff.originalText, m: m.aMonaco.diff.modifiedText }, single: (m.aMonaco.standalone ?? []).map((x) => x.text) })}`,
  );
  check(
    "A：不把不可用侧置空参与 diff（没有 diff 编辑器；可读侧走**单侧只读视图**，也没有「无变化」这类伪装）",
    m.aDom.hasDiffEditor === false &&
      m.aDom.hasSingleSideEditor === true &&
      m.aDom.fakeEmptyClaim === false,
    `hasDiffEditor=${m.aDom.hasDiffEditor} hasSingleSideEditor=${m.aDom.hasSingleSideEditor} fakeEmptyClaim=${m.aDom.fakeEmptyClaim}`,
  );
  check(
    "A：单侧可读时**该侧仍可复制查找**（复制所选侧原文 / 查找 / 换行可用）",
    m.aDom.toolbar.复制右侧原文 !== null &&
      m.aDom.toolbar.复制右侧原文.disabled === false &&
      m.aDom.toolbar.查找 !== null &&
      m.aDom.toolbar.查找.disabled === false &&
      (m.aDom.toolbar.换行开 ?? m.aDom.toolbar.换行关)?.disabled === false,
    `复制右侧=${JSON.stringify(m.aDom.toolbar.复制右侧原文)} 查找=${JSON.stringify(m.aDom.toolbar.查找)} 换行开=${JSON.stringify(m.aDom.toolbar.换行开)}`,
  );
  check(
    "A：不可用侧复制被诚实禁用（复制左侧原文 disabled，不会复制出空文件）",
    m.aDom.toolbar.复制左侧原文 !== null && m.aDom.toolbar.复制左侧原文.disabled === true,
    JSON.stringify(m.aDom.toolbar.复制左侧原文),
  );

  // —— B：左右互换（所选侧不可用、初始侧可读）——
  Object.assign(m, await enterFiles(call, BROKEN_RUN, "第 1 轮", "全部"));
  m.bPick = await pickFile(call, STEADY_FILE);
  await sleep(1200);
  m.bDom = await dom(call);
  m.bMonaco = await monacoOrNull(call);
  m.bStore = await storeState(call, BROKEN_RUN);
  await shot(call, SHOT_DIR, `${TAG}-B1-所选不可用初始可读.png`);

  check(
    "B（左右互换）：两侧分别标出真实状态（初始侧=有文本、所选侧=不可比较）",
    m.bDom.sideLabelsBoth || (m.bDom.statusBinary && m.bDom.sideHasText),
    `sideLabelsBoth=${m.bDom.sideLabelsBoth} 二进制=${m.bDom.statusBinary} 有文本=${m.bDom.sideHasText}；卡片=${JSON.stringify(m.bDom.cards)}`,
  );
  check(
    "B（左右互换）：**可读侧（初始侧）完整展示**",
    anyModelContains(m.bMonaco, STEADY_INITIAL),
    `含"${STEADY_INITIAL}"=${anyModelContains(m.bMonaco, STEADY_INITIAL)}；monaco=${m.bMonaco === null ? "未加载" : JSON.stringify({ single: (m.bMonaco.standalone ?? []).map((x) => x.text), diff: m.bMonaco.diff === null ? null : { o: m.bMonaco.diff.originalText, m: m.bMonaco.diff.modifiedText } })}`,
  );
  check(
    "B（左右互换）：不伪装空差异（无 diff 编辑器；可读的初始侧走**单侧只读视图**）",
    m.bDom.hasDiffEditor === false && m.bDom.hasSingleSideEditor === true,
    `hasDiffEditor=${m.bDom.hasDiffEditor} hasSingleSideEditor=${m.bDom.hasSingleSideEditor}`,
  );
  check(
    "B（左右互换）：单侧可读时该侧仍可复制查找（复制左侧原文 / 查找可用）",
    m.bDom.toolbar.复制左侧原文 !== null &&
      m.bDom.toolbar.复制左侧原文.disabled === false &&
      m.bDom.toolbar.查找 !== null &&
      m.bDom.toolbar.查找.disabled === false,
    `复制左侧=${JSON.stringify(m.bDom.toolbar.复制左侧原文)} 查找=${JSON.stringify(m.bDom.toolbar.查找)}`,
  );
  return m;
}

/** ② 两侧都不可读时没有伪空编辑器 */
async function scenarioBothUnreadable(call) {
  const m = {};
  // was-binary.dat 在第 1 轮末仍是二进制（第 2 轮才被写成文本）⇒ 两侧都不可读
  Object.assign(m, await enterFiles(call, SIDE_RUN, "第 1 轮", "全部"));
  m.pick = await pickFile(call, BINARY_FILE);
  await sleep(1200);
  m.dom = await dom(call);
  m.monaco = await monacoOrNull(call);
  m.store = await storeState(call, SIDE_RUN);
  await shot(call, SHOT_DIR, `${TAG}-1-两侧都二进制.png`);

  check(
    "没有伪空编辑器（不渲染 diff/单侧编辑器，也不用空文本冒充）",
    m.dom.hasDiffEditor === false && m.dom.hasSingleSideEditor === false,
    `diff=${m.dom.hasDiffEditor} single=${m.dom.hasSingleSideEditor} monaco=${m.monaco === null ? "未加载" : JSON.stringify(m.monaco.models)}`,
  );
  check(
    "不宣称「无变化」或「文件为空」",
    m.dom.fakeEmptyClaim === false && m.dom.cardNoDiff === false,
    `fakeEmpty=${m.dom.fakeEmptyClaim} cardNoDiff=${m.dom.cardNoDiff}；卡片=${JSON.stringify(m.dom.cards)}`,
  );
  check(
    "显示具体状态（二进制 + 真实大小/哈希）",
    m.dom.statusBinary === true && /sha256|原始大小/.test(m.dom.cards.join(" ") + m.dom.pathHeader),
    `卡片=${JSON.stringify(m.dom.cards)} header=${m.dom.pathHeader}`,
  );
  check(
    "给出适用的元信息操作（复制元信息可用）",
    m.dom.toolbar.复制元信息 !== null,
    JSON.stringify(m.dom.toolbar.复制元信息),
  );
  check(
    "无差异时不假跳转（上一/下一差异禁用）",
    m.dom.toolbar.上一差异 !== null &&
      m.dom.toolbar.上一差异.disabled === true &&
      m.dom.toolbar.下一差异.disabled === true,
    `上一=${JSON.stringify(m.dom.toolbar.上一差异)} 下一=${JSON.stringify(m.dom.toolbar.下一差异)}`,
  );
  return m;
}

/**
 * ⑤-a 复制路径原文及元信息。
 *
 * 覆盖：完整逻辑路径（含**搜索隐藏后**仍复制原文）、可读侧**完整原文**（200 行长文件，
 * 证明不是"截断的显示内容"）、二进制**真实大小/完整哈希**、不可用侧复制禁用、剪贴板失败就近提示。
 */
async function scenarioToolsCopy(call) {
  const m = {};
  m.origin = new URL(await ev(call, "location.href")).origin;
  m.grant = await grantClipboard(call, m.origin);
  m.clipBaseline = await readClipboard(call).catch((e) => `ERR:${e.message}`);

  // —— 二进制元信息（mirror：所选侧 = 二进制）——
  Object.assign(m, await enterFiles(call, BROKEN_RUN, "第 1 轮", "全部"));
  m.bPick = await pickFile(call, STEADY_FILE);
  await sleep(1200);
  m.bCopyMeta = await copyVia(call, "复制元信息");
  m.bCopyRight = await copyVia(call, "复制右侧原文"); // 所选侧不可读 ⇒ 应禁用 ⇒ 剪贴板保持哨兵
  m.bDom = await dom(call);
  await shot(call, SHOT_DIR, `${TAG}-1-二进制元信息.png`);

  const metaExpected = /^\d+ B\n[0-9a-f]{64}$/;
  check(
    "二进制元信息复制的是**真实大小 + 完整 64 位哈希**（不是 header 里截断的 12 位）",
    typeof m.bCopyMeta.clip === "string" && metaExpected.test(normClip(m.bCopyMeta.clip)),
    `clip=${JSON.stringify(m.bCopyMeta.clip)} feedback=${m.bCopyMeta.feedback}`,
  );
  check(
    "不可用侧「复制原文」禁用且点了也不会写入剪贴板（仍是哨兵值）",
    m.bDom.toolbar.复制右侧原文.disabled === true && m.bCopyRight.clip === "__u254_empty__",
    `disabled=${m.bDom.toolbar.复制右侧原文.disabled} clip=${JSON.stringify(m.bCopyRight.clip)}`,
  );

  // —— 完整原文（200 行长文件，两侧都是文本）——
  Object.assign(m, await enterFiles(call, ROOT_RUN, "第 2 轮", "全部"));
  m.pickLong = await pickFile(call, LONG_FILE);
  await sleep(1500);
  m.monaco = await monacoOrNull(call);
  m.copyLeft = await copyVia(call, "复制左侧原文");
  m.copyRight = await copyVia(call, "复制右侧原文");
  m.sideDom = await dom(call);
  m.store = await storeState(call, ROOT_RUN);
  await shot(call, SHOT_DIR, `${TAG}-2-长文件完整原文.png`);

  const orig = m.monaco?.diff?.originalText ?? null;
  const mod = m.monaco?.diff?.modifiedText ?? null;
  const origLines = orig === null ? -1 : orig.split("\n").length;
  check(
    "长文件（>100 行）用于证明「复制原文≠复制显示片段」（夹具对照）",
    origLines > 100,
    `原侧行数=${origLines}`,
  );
  check(
    "复制左侧原文 = 左侧**逻辑全文**（与编辑器模型逐字节一致）",
    orig !== null && normClip(m.copyLeft.clip) === orig,
    `模型字数=${orig === null ? "n/a" : orig.length} 剪贴板字数=${typeof m.copyLeft.clip === "string" ? m.copyLeft.clip.length : "n/a"}`,
  );
  check(
    "复制右侧原文 = 右侧**逻辑全文**",
    mod !== null && normClip(m.copyRight.clip) === mod,
    `模型字数=${mod === null ? "n/a" : mod.length} 剪贴板字数=${typeof m.copyRight.clip === "string" ? m.copyRight.clip.length : "n/a"}`,
  );

  // —— 搜索隐藏后复制路径仍是完整逻辑路径；折叠目录后亦然 ——
  m.hideSearch = await typeInto(call, "按完整路径搜索文件", "zzz-no-match");
  m.hiddenDom = await dom(call);
  m.copyPathHidden = await copyVia(call, "复制路径");
  m.collapseDir = await clickByAria(call, "收起目录", 700);
  m.copyPathCollapsed = await copyVia(call, "复制路径");
  await shot(call, SHOT_DIR, `${TAG}-3-搜索隐藏与折叠后复制路径.png`);

  check(
    "搜索把清单筛空（夹具对照：这是「长路径/搜索后仍要复制完整路径」的阻挡态）",
    m.hiddenDom.fileOptions.length === 0 && m.hiddenDom.query === "zzz-no-match",
    `options=${m.hiddenDom.fileOptions.length} query=${m.hiddenDom.query}`,
  );
  check(
    "搜索隐藏后复制路径 = 完整逻辑路径（不因不可见而复制空/片段）",
    m.copyPathHidden.clip === LONG_FILE,
    `clip=${JSON.stringify(m.copyPathHidden.clip)} feedback=${m.copyPathHidden.feedback}`,
  );
  check(
    "目录收起后复制路径仍 = 完整逻辑路径",
    m.copyPathCollapsed.clip === LONG_FILE,
    `clip=${JSON.stringify(m.copyPathCollapsed.clip)}`,
  );

  // —— 剪贴板失败就近提示（真点击 + 真注入失败）——
  m.breakClipboard = await ev(
    call,
    `(() => { try {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
          writeText: () => Promise.reject(new Error('注入的剪贴板故障')),
          readText: () => Promise.resolve('') } });
        return 'ok';
      } catch (e) { return 'ERR:' + String(e); } })()`,
  );
  m.copyFail = await copyVia(call, "复制路径");
  await shot(call, SHOT_DIR, `${TAG}-4-剪贴板失败提示.png`);
  check(
    "剪贴板失败**就近提示**（不假报成功）",
    typeof m.copyFail.feedback === "string" && /剪贴板故障/.test(m.copyFail.feedback),
    `feedback=${JSON.stringify(m.copyFail.feedback)}`,
  );
  m.restoreClipboard = await ev(
    call,
    `(() => { try { delete navigator.clipboard; return 'ok'; } catch (e) { return 'ERR:' + String(e); } })()`,
  );
  await grantClipboard(call, m.origin);
  return m;
}

/**
 * ⑤-b 查找换行和差异定位使用当前文件。
 *
 * 关键判据：
 *   - 有真实差异的文件 ⇒ 差异导航可用；**切到 0 差异的文件后必须禁用**（不沿用旧 diff）。
 *   - 查找作用于**当前文件的模型**（用只存在于别的文件的字符串查 ⇒ 0 匹配）。
 *   - 换行只改显示，不改原文；编辑器 readOnly；find widget 无可见替换区。
 */
async function scenarioToolsFind(call) {
  const m = {};
  Object.assign(m, await enterFiles(call, ROOT_RUN, "第 2 轮", "全部"));

  // —— 有真实差异的文件：edit.txt ——
  m.pickEdit = await pickFile(call, EDIT_FILE);
  await sleep(1500);
  m.editDom = await dom(call);
  m.editMonaco = await monacoOrNull(call);
  await shot(call, SHOT_DIR, `${TAG}-1-edit差异.png`);

  check(
    "有真实差异 ⇒ 上一/下一差异可用（且 diffCount 来自完成的真实 diff）",
    m.editDom.diffCountText !== null &&
      m.editDom.diffCountText > 0 &&
      m.editDom.toolbar.上一差异.disabled === false &&
      m.editDom.toolbar.下一差异.disabled === false,
    `diffCount=${m.editDom.diffCountText} 上一=${JSON.stringify(m.editDom.toolbar.上一差异)} lineChanges=${m.editMonaco?.diff?.lineChangeCount}`,
  );
  check(
    "编辑器只读（禁用修改；也没有可见的替换入口）",
    (m.editMonaco?.standalone ?? []).every((e) => e.readOnly === true) &&
      m.editMonaco?.diff?.modifiedReadOnly === true,
    `standalone=${JSON.stringify((m.editMonaco?.standalone ?? []).map((e) => e.readOnly))} diffModifiedReadOnly=${m.editMonaco?.diff?.modifiedReadOnly}`,
  );

  // 查找：真点击 → 真键入
  m.clickFind = await clickByText(call, "查找", 900);
  m.findOpen = await dom(call);
  m.typeFind = await typeIntoFind(call, "版本");
  m.findTyped = await dom(call);
  await shot(call, SHOT_DIR, `${TAG}-2-查找.png`);
  check(
    "点「查找」真的打开 find widget，**键入的**关键词在当前模型上有匹配",
    m.typeFind === true &&
      m.findTyped.findWidget !== null &&
      m.findTyped.findWidget.shown === true &&
      m.findTyped.findWidget.input === "版本" &&
      findHasMatches(m.findTyped),
    `typeFind=${m.typeFind} open=${JSON.stringify(m.findOpen.findWidget)} typed=${JSON.stringify(m.findTyped.findWidget)}`,
  );
  check(
    "find widget **没有可见的替换区**（只读工具，不给替换）",
    m.findTyped.findWidget !== null && m.findTyped.findWidget.replaceShown === false,
    `replaceShown=${m.findTyped.findWidget?.replaceShown}`,
  );
  m.escFind = await key(call, "Escape", "Escape", 27, 500);

  // 差异导航：真点击（有差异 ⇒ 应落到被改动的行，且不抛错）
  m.clickNextDiff = await clickByText(call, "下一差异", 900);
  m.afterNextDiff = await monacoOrNull(call);
  m.diffNavOk = m.afterNextDiff?.diff?.modifiedPosition != null;
  check(
    "点「下一差异」作用于**当前 diff 编辑器**（位置落在修改侧模型的合法行内）",
    m.diffNavOk &&
      (m.afterNextDiff?.diff?.lineChangeCount ?? 0) > 0 &&
      (m.afterNextDiff?.diff?.modifiedPosition?.lineNumber ?? 0) >= 1,
    `position=${JSON.stringify(m.afterNextDiff?.diff?.modifiedPosition)} lineChanges=${m.afterNextDiff?.diff?.lineChangeCount}`,
  );

  // 换行：改的是显示，不是原文
  const textBefore = m.afterNextDiff?.diff?.modifiedText ?? null;
  m.clickWrap = await clickByText(call, "换行：关", 800);
  m.wrapClicked = m.clickWrap === true || (await clickByText(call, "换行：开", 800));
  m.wrapDom = await dom(call);
  m.wrapStore = await storeState(call, ROOT_RUN);
  m.wrapMonaco = await monacoOrNull(call);
  await shot(call, SHOT_DIR, `${TAG}-3-换行.png`);
  check(
    "换行开关真的切换（store.wordWrap 变化）且**不改原文**",
    m.wrapStore.wordWrap !== null && m.wrapMonaco?.diff?.modifiedText === textBefore,
    `wordWrap=${m.wrapStore.wordWrap} 原文一致=${m.wrapMonaco?.diff?.modifiedText === textBefore}`,
  );

  // —— 切到 0 差异的文件：必须按当前文件重算，不沿用旧 diff ——
  m.pickLong = await pickFile(call, LONG_FILE);
  await sleep(1600);
  m.longDom = await dom(call);
  m.longMonaco = await monacoOrNull(call);
  await shot(call, SHOT_DIR, `${TAG}-4-切到长文件.png`);
  check(
    "切到**无差异**的文件后差异导航被禁用（按当前文件的真实 diff 重算，不沿用 edit.txt 的）",
    m.longMonaco?.diff?.lineChangeCount === 0 &&
      m.longDom.toolbar.上一差异.disabled === true &&
      m.longDom.toolbar.下一差异.disabled === true,
    `lineChanges=${m.longMonaco?.diff?.lineChangeCount} 上一=${JSON.stringify(m.longDom.toolbar.上一差异)} 下一=${JSON.stringify(m.longDom.toolbar.下一差异)}`,
  );

  // 查找必须作用在当前模型：'alpha' 只存在于 a.txt，长文件里没有
  m.findAlpha = await clickByText(call, "查找", 800);
  m.typeAlpha = await typeIntoFind(call, "alpha");
  m.alphaDom = await dom(call);
  m.typeLongMark = await typeIntoFind(call, "长文本样本");
  m.longMarkDom = await dom(call);
  await shot(call, SHOT_DIR, `${TAG}-5-查找作用当前文件.png`);
  check(
    "查找作用于**当前文件**：只存在于 a.txt 的 'alpha' 在长文件里 0 匹配",
    m.typeAlpha === true &&
      m.alphaDom.findWidget !== null &&
      m.alphaDom.findWidget.input === "alpha" &&
      findNoMatches(m.alphaDom),
    `typeAlpha=${m.typeAlpha} widget=${JSON.stringify(m.alphaDom.findWidget)}`,
  );
  check(
    "查找能命中当前文件的真实内容（'长文本样本'）",
    m.typeLongMark === true &&
      m.longMarkDom.findWidget !== null &&
      m.longMarkDom.findWidget.input === "长文本样本" &&
      findHasMatches(m.longMarkDom),
    `typeLongMark=${m.typeLongMark} widget=${JSON.stringify(m.longMarkDom.findWidget)}`,
  );
  return m;
}

/**
 * ③④ 快速切换不串清单正文错误和加载 + 同对象重试与往返有请求代次。
 *
 * ⚠️ 注入的是**真 IPC 的包装层**（原动作照常执行），只对指定"第 k 次调用"加延迟并
 *    把返回文本换成哨兵 —— 这样"迟到的旧响应"若被接受，就能在编辑器里看到哨兵。
 */
async function scenarioRaceRetry(call) {
  const m = {};
  m.hook = await installHooks(call);

  // —— ③ 快速切换：旧的（延迟的）响应不得改写新选择 ——
  await setRules(call, [
    {
      kind: "read",
      key: BINARY_FILE,
      occurrence: 1,
      delayMs: 3200,
      sentinelText: "【迟到旧响应】\n",
    },
  ]);
  Object.assign(m, await enterFiles(call, SIDE_RUN, "第 2 轮", "全部"));
  m.openSlow = await pickFile(call, BINARY_FILE); // 第 1 次读 ⇒ 延迟 3.2s + 哨兵
  m.duringSlowDom = await dom(call);
  await sleep(400);
  m.switchToFast = await pickFile(call, STEADY_FILE); // 第 1 次读 steady ⇒ 立即真实
  await sleep(600);
  m.fastDom = await dom(call);
  m.fastMonaco = await monacoOrNull(call);
  await sleep(3400); // 等迟到响应真的到达
  m.afterLateDom = await dom(call);
  m.afterLateMonaco = await monacoOrNull(call);
  m.afterLateStore = await storeState(call, SIDE_RUN);
  m.log1 = await hookLog(call);
  await shot(call, SHOT_DIR, `${TAG}-1-快速切换后迟到响应到达.png`);

  check(
    "注入生效（关键字路径的读请求确实被延迟过）——夹具对照",
    m.log1.some((x) => x.key === BINARY_FILE && x.delayMs === 3200),
    JSON.stringify(m.log1),
  );
  check(
    "切到新文件后，**迟到的旧响应没有把内容串过去**（编辑器仍是新文件文本，无哨兵）",
    m.afterLateStore.path === STEADY_FILE &&
      anyModelContains(m.afterLateMonaco, STEADY_AFTER) &&
      !anyModelContains(m.afterLateMonaco, "【迟到旧响应】"),
    `path=${m.afterLateStore.path} 含新文件文本=${anyModelContains(m.afterLateMonaco, STEADY_AFTER)} 含哨兵=${anyModelContains(m.afterLateMonaco, "【迟到旧响应】")}`,
  );
  check(
    "迟到的旧响应也没有把 loading/错误串过去（不残留「正在读取」）",
    m.afterLateDom.bodyHasLoading === false,
    `bodyHasLoading=${m.afterLateDom.bodyHasLoading}`,
  );

  // —— ④ 同对象往返 A→B→A，最旧的 A 迟到返回 ——
  await setRules(call, [
    {
      kind: "read",
      key: BINARY_FILE,
      occurrence: 1,
      delayMs: 3200,
      sentinelText: "【最旧的A-迟到】\n",
    },
  ]);
  m.againA1 = await pickFile(call, BINARY_FILE); // 最旧的 A（延迟+哨兵）
  await sleep(300);
  m.againB = await pickFile(call, STEADY_FILE); // B
  await sleep(500);
  m.againA2 = await pickFile(call, BINARY_FILE); // 最新的 A（立即真实）
  await sleep(700);
  m.a2Dom = await dom(call);
  m.a2Monaco = await monacoOrNull(call);
  await sleep(3400); // 最旧的 A 此时才回来
  m.a2LateDom = await dom(call);
  m.a2LateMonaco = await monacoOrNull(call);
  m.a2LateStore = await storeState(call, SIDE_RUN);
  m.log2 = await hookLog(call);
  await shot(call, SHOT_DIR, `${TAG}-2-往返后最旧A迟到.png`);

  check(
    "往返后**只认最新代次**：最旧的 A 迟到返回，内容仍是真实文本（不是哨兵）",
    m.a2LateStore.path === BINARY_FILE &&
      anyModelContains(m.a2LateMonaco, SIDE_TEXT) &&
      !anyModelContains(m.a2LateMonaco, "【最旧的A-迟到】"),
    `path=${m.a2LateStore.path} 含真实文本=${anyModelContains(m.a2LateMonaco, SIDE_TEXT)} 含哨兵=${anyModelContains(m.a2LateMonaco, "【最旧的A-迟到】")}`,
  );
  check(
    "同对象重试确实发生了多次读取（代次判据非空转）——夹具对照",
    m.log2.filter((x) => x.kind === "read" && x.key === BINARY_FILE).length >= 2,
    JSON.stringify(m.log2.filter((x) => x.key === BINARY_FILE)),
  );

  // —— 卸载后迟到的响应不得改写当前阅读状态 ——
  // ⚠️ 两处修正（5.4 实测坐实的 harness 假失败）：
  //   ① 基准必须取在**用户自己的合法选择之后** —— 原先取在 pickFile **之前**，等于把用户刚
  //      选中的新文件当成"迟到响应改写"，必然假失败（实测：离开时 path=was-binary.dat，
  //      "迟到最后" path=steady.txt，而那正是用户点的）；
  //   ② 延迟必须**大于 pickFile 自身耗时**（约 2.3s）—— 原先 3000ms 会在组件卸载前就返回，
  //      "卸载后迟到"这个前提根本不成立。这里取 6000ms，保证响应落在**切到步骤页之后**。
  await setRules(call, [{ kind: "read", key: STEADY_FILE, occurrence: 1, delayMs: 6000 }]);
  m.unmountOpen = await pickFile(call, STEADY_FILE); // 这轮读会延迟 6s
  await sleep(300);
  m.toSteps = await clickTab(call, "步骤"); // 组件卸载
  const beforeUnmount = await storeState(call, SIDE_RUN); // 基准 = 离开时（已卸载）的状态
  await sleep(6400); // 迟到响应到达
  m.unmountedStore = await storeState(call, SIDE_RUN);
  m.backFiles = await clickTab(call, "文件");
  await sleep(1400);
  m.backDom = await dom(call);
  m.backMonaco = await monacoOrNull(call);
  m.log3 = await hookLog(call);
  await shot(call, SHOT_DIR, `${TAG}-3-卸载后迟到响应.png`);

  check(
    "注入生效（卸载场景的读请求确实被延迟到 6s）——夹具对照",
    m.log3.some((x) => x.key === STEADY_FILE && x.delayMs === 6000),
    JSON.stringify(m.log3.filter((x) => x.key === STEADY_FILE)),
  );
  check(
    "卸载后迟到的响应**不改写当前阅读状态**（路径/检查点与离开时一致）",
    m.unmountedStore.path === beforeUnmount.path &&
      m.unmountedStore.checkpoint === beforeUnmount.checkpoint,
    `离开时 path=${beforeUnmount.path} ckpt=${beforeUnmount.checkpoint}；迟到最后 path=${m.unmountedStore.path} ckpt=${m.unmountedStore.checkpoint}`,
  );
  check(
    "返回文件页后读到的是**真实内容**（迟到响应没有污染模型）",
    m.backMonaco !== null && anyModelContains(m.backMonaco, STEADY_AFTER),
    `含"${STEADY_AFTER}"=${anyModelContains(m.backMonaco, STEADY_AFTER)}`,
  );

  // —— 失败保留定位意图 + 内容可独立重试 ——
  // ⚠️ 用 `side: "selected"` **点名所选侧**：同路径的两侧读共用 key，只按 key/occurrence
  //    匹配会让失败落到"先发出的那一次"（可能是初始侧），断言就不成立。
  await setRules(call, [
    { kind: "read", key: BINARY_FILE, side: "selected", fail: "U254_INJECTED" },
  ]);
  m.failPick = await pickFile(call, BINARY_FILE);
  await sleep(1500);
  m.failDom = await dom(call);
  m.failStore = await storeState(call, SIDE_RUN);
  const failLog = await hookLog(call);
  await shot(call, SHOT_DIR, `${TAG}-4-读取失败.png`);
  check(
    "读取失败**保留当前定位意图**（path 仍在会话状态里，不退化成「不存在」）",
    m.failStore.path === BINARY_FILE &&
      m.failDom.failureNotMissing === true &&
      m.failDom.sideMissingLabel === false,
    `path=${m.failStore.path} 不称不存在=${m.failDom.failureNotMissing} sideMissing=${m.failDom.sideMissingLabel}；卡片=${JSON.stringify(m.failDom.cards)}`,
  );
  check(
    "失败时给出**该侧独立重试**入口",
    m.failDom.retryContentBtn === true || m.failDom.retryFileBtn === true,
    `retryContentBtn=${m.failDom.retryContentBtn} retryFileBtn=${m.failDom.retryFileBtn} retryInitialBtn=${m.failDom.retryInitialBtn}`,
  );

  // 重试入口的**实际文案**取决于当时形态：另一侧也不可读 ⇒ 独占错误卡的「重新读取该文件」；
  // 另一侧可读 ⇒ 统一卡内的「重新读取所选侧」。按 DOM 实测挑，别写死（5.4 踩过）。
  const retryLabel = m.failDom.retryContentBtn ? "重新读取所选侧" : "重新读取该文件";
  await setRules(call, []); // 撤掉注入
  const readsBeforeRetry = (await hookLog(call)).length;
  m.retryClick = await clickByText(call, retryLabel, 2200);
  m.retryDom = await dom(call);
  m.retryMonaco = await monacoOrNull(call);
  const afterLog = await hookLog(call);
  await shot(call, SHOT_DIR, `${TAG}-5-独立重试成功.png`);
  check(
    "重试**真的重新调用只读 IPC**（包装层记录到新的读请求）",
    m.retryClick === true && afterLog.length > readsBeforeRetry,
    `label=${retryLabel} clicked=${m.retryClick} before=${readsBeforeRetry} after=${afterLog.length} 失败那次的 mode=${failLog
      .filter((x) => x.key === BINARY_FILE)
      .map((x) => `${x.side}:${x.mode}`)
      .join(",")}`,
  );
  check(
    "重试后显示**当前校验结果**（真实文本，不是旧内容/兜底）",
    m.retryMonaco !== null &&
      anyModelContains(m.retryMonaco, SIDE_TEXT) &&
      m.retryDom.failureNotMissing === false &&
      m.retryDom.sideReadFailed === false,
    `含真实文本=${anyModelContains(m.retryMonaco, SIDE_TEXT)} 仍称失败/不代表不存在=${m.retryDom.failureNotMissing}`,
  );

  m.logFinal = await hookLog(call);
  return m;
}

// —— 主流程 ——

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

  // 冷重载：清掉上一个 tag 留下的选中 run / 注入，保证每次从同一起点采数
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

  let out = {};
  if (TAG === "probe") out = await scenarioProbe(call);
  else if (TAG === "sides") out = await scenarioSides(call);
  else if (TAG === "both-unreadable") out = await scenarioBothUnreadable(call);
  else if (TAG === "tools-copy") out = await scenarioToolsCopy(call);
  else if (TAG === "tools-find") out = await scenarioToolsFind(call);
  else if (TAG === "race-retry") out = await scenarioRaceRetry(call);
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
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
