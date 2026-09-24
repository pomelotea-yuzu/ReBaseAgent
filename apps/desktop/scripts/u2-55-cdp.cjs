/**
 * U2 任务 5.5：IPC 安全 / 未录制与失败记录 / 只读不变性的**实机**验收。
 *
 * 覆盖（spec 五场景，见 `openspec/changes/improve-workspace-file-reading/specs/desktop-ui/spec.md`）：
 *   ① 文件读取 IPC 拒绝越权 —— 非法 runId（路径穿越）/ 清单外路径 / 祖先而非自有 step /
 *      任意物理 blob 路径，全部返回明确错误，且**不读取目标宿主文件**、不以同名文件或其他快照替代。
 *   ② 二进制和不可用附件分别显示 —— 非 UTF-8 / 缺失 / 损坏 / 没有检查点的旧 run 分别提示，
 *      不尝试有损文本比较、不渲染伪空文件。
 *   ③ 失败运行已记录文件可查看 —— errored 封存后，此前落盘的检查点仍可读出完整文件事实。
 *   ④ 文件浏览过程无写入 —— 不创建 run/附件、不补写清单、不改源目录与既有数据、不请求 LLM。
 *   ⑤ 阅读重试只读且重新校验 —— 重试**真的重发只读 IPC**并显示当前校验结果；
 *      源/父/兄弟/既有 trace 与附件逐文件 SHA-256 前后一致，模型及工具调用为零。
 *
 * ⚠️ 与 5.1–5.4 同纪律：
 *   - 禁用 `Emulation.setDeviceMetricsOverride`（破坏 Monaco automaticLayout）。
 *   - 断言全部来自**真机真交互**（真点击 / 真键入）+ 真 IPC / 真 store / 真 monaco 读取，
 *     不以静态结构测试代替点击与内容核对。
 *   - 脚本不 spawn、不改窗、不重启 dev。
 *
 * 三条读取通道：
 *   - **IPC**（本任务新增，最贴近"越权"语义）：直接调 `window.api.inspectWorkspace/readWorkspaceFile`
 *     —— 这是 renderer 与 main 之间**真正的**跨进程通道，返回值是未加工的 Envelope。
 *   - **DOM**：列表徽标、状态卡文案、工具栏按钮可用性、编辑器 DOM。
 *   - **store / monaco**（仅 dev）：从 `performance` 资源表解析应用**自己用过的模块 URL** 再
 *     `import()`（⚠️ 写死 `/src/...` 会拿到另一份空 store 且不报错——5.4 踩过）。
 *
 * 用法（每次一个 tag）：
 *   node apps/desktop/scripts/u2-55-cdp.cjs --tag=probe
 *   node apps/desktop/scripts/u2-55-cdp.cjs --tag=ipc-guard
 *   node apps/desktop/scripts/u2-55-cdp.cjs --tag=unavailable
 *   node apps/desktop/scripts/u2-55-cdp.cjs --tag=errored
 *   node apps/desktop/scripts/u2-55-cdp.cjs --tag=readonly
 *   node apps/desktop/scripts/u2-55-cdp.cjs --tag=selfcheck   （只验"冻结面判据有牙"，不产生验收项）
 */
"use strict";

const { createHash } = require("node:crypto");
const {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  rmSync,
} = require("node:fs");
const { join } = require("node:path");
const { REPO, sleep, cdpConnect, makeSession, ev, shot } = require("./lib/u2-cdp-util.cjs");

const PORT = 9612;
const OUT_DIR = join(REPO, ".workbuddy", "u2-55");
const SHOT_DIR = join(REPO, "docs", "reviews", "2026-09-24-u2-55");
const OUT = join(OUT_DIR, "measurements.json");
const LIVE_DIR = join(REPO, ".rebaseagent");
const FIX_DIR = join(LIVE_DIR, "u2-file-fixtures-55");
const MANIFEST_PATH = join(FIX_DIR, "MANIFEST-55.json");

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag", "probe");

if (!existsSync(MANIFEST_PATH)) {
  throw new Error(
    `夹具清单不存在：${MANIFEST_PATH}\n请先跑 node apps/desktop/scripts/gen-u2-55-fixtures.cjs`,
  );
}
const MF = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const ROOT_RUN = MF.真实引擎.root.id;
const ROOT_R2 = MF.真实引擎.root.第2轮末;
const ROOT_R1 = MF.真实引擎.root.第1轮末;
const FORK_RUN = MF.真实引擎.fork.id;
const ERRORED_RUN = MF.真实引擎.errored.id;
const MISSING_RUN = MF.异常标本.missing.id;
const CORRUPT_RUN = MF.异常标本.corrupt.id;
const NOOWN_RUN = MF.异常标本.noCheckpoint.id;
const MISSING_FILE = MF.异常标本.missing.路径;
const CORRUPT_FILE = MF.异常标本.corrupt.路径;
const TEXT_EDIT_R2 = MF.文件世界.edit第2轮.trim();
const TEXT_EDIT_ERRONED = MF.文件世界.edit失败前写入.trim();
const BINARY_FILE = "bin.dat";

const checks = [];
function check(name, ok, detail) {
  checks.push({ name: `[${TAG}] ${name}`, ok: !!ok, detail: detail ?? null });
}
function loadOut() {
  if (!existsSync(OUT)) return { tag: "u2-5.5", measurements: {}, checks: [] };
  return JSON.parse(readFileSync(OUT, "utf8"));
}
function saveOut(d) {
  d.capturedAt = new Date().toISOString();
  writeFileSync(OUT, JSON.stringify(d, null, 2));
}

// ---------------------------------------------------------------------------
// 只读不变性：逐文件 SHA-256 快照
// ---------------------------------------------------------------------------

/**
 * 递归列出目录下所有文件（相对路径 → sha256）。
 * 缺失目录返回空对象（不抛错）——"目录不存在"与"目录为空"在判据里等价。
 */
function hashTree(root, rel = "") {
  const abs = join(root, rel);
  if (!existsSync(abs)) return {};
  const out = {};
  for (const name of readdirSync(abs)) {
    const childRel = rel === "" ? name : `${rel}/${name}`;
    const childAbs = join(root, childRel);
    if (statSync(childAbs).isDirectory()) Object.assign(out, hashTree(root, childRel));
    else out[childRel] = createHash("sha256").update(readFileSync(childAbs)).digest("hex");
  }
  return out;
}

/** 本任务要冻结的**全部**数据面：源目录 + 夹具目录 + live trace + live 附件 */
function freezeDataSurface() {
  return {
    source: hashTree(join(FIX_DIR, "source")),
    fixture: hashTree(FIX_DIR),
    traces: hashTree(join(LIVE_DIR, "traces")),
    blobs: hashTree(join(LIVE_DIR, "workspace-blobs")),
  };
}

/** 比对两份冻结快照，返回差异条目（人类可读） */
function diffSurface(before, after) {
  const diffs = [];
  for (const group of Object.keys(before)) {
    const a = before[group];
    const b = after[group] ?? {};
    for (const k of Object.keys(a)) {
      if (!(k in b)) diffs.push(`${group}/${k} 消失`);
      else if (a[k] !== b[k]) diffs.push(`${group}/${k} 哈希变化`);
    }
    for (const k of Object.keys(b)) if (!(k in a)) diffs.push(`${group}/${k} 新增`);
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// 表达式 / 通用求值
// ---------------------------------------------------------------------------

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
 * ⚠️ ES 模块身份 = **完整 URL**（含 `?t=` 版本戳与 `/@fs/` 前缀）：
 *   - 写死 `/src/...` 会拿到另一份空 store 且**不报错**（5.4 踩过）；
 *   - 但"应用自己用过的"形态**不是唯一**的：Vite root = `apps/desktop/src/renderer`
 *     ⇒ 应用侧真实 URL 是 `http://localhost:5173/src/store.ts`；而某些加载路径（如 HMR
 *     更新后）会呈现为 `/@fs/D:/ReBaseAgent/apps/desktop/src/renderer/src/store.ts?t=…`。
 *   故这里接受**候选子串数组**，并按"更可能是同一活实例"的顺序挑：
 *     ① 带 `?t=` 的（HMR 更新过的，必是当前活模块）→ ② 非 `/@fs/` 的（root 内常规服务）
 *     → ③ 第一个匹配。
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

// 候选子串：`/src/renderer/src/...`（@fs 形态）与 `/src/...`（Vite root 内常规服务形态）
const STORE_NEEDLE = ["/src/renderer/src/store.ts", "/src/store.ts"];
const MONACO_NEEDLE = ["/src/renderer/src/monaco-bootstrap.ts", "/src/monaco-bootstrap.ts"];
const READING_STATE_NEEDLE = [
  "/src/renderer/src/lib/reading-state.ts",
  "/src/lib/reading-state.ts",
];

/** 读某 run 的文件阅读会话状态（权威：位置/选择是否真的被记住） */
async function storeState(call, runId) {
  return appImport(
    call,
    STORE_NEEDLE,
    `const rsUrl = (() => {
        const all = performance.getEntriesByType('resource').map(e => e.name)
          .filter(n => ${JSON.stringify(READING_STATE_NEEDLE)}.some(w => n.includes(w)));
        return all.slice().sort((a, b) => ((a.includes('?t=') ? 0 : a.includes('/@fs/') ? 2 : 1) - (b.includes('?t=') ? 0 : b.includes('/@fs/') ? 2 : 1)))[0] ?? null;
      })();
      if (rsUrl === null) return JSON.stringify({ error: 'module-url-not-found', needle: 'reading-state' });
      const rs = await import(rsUrl);
      const st = m.useAppStore.getState();
      const r = rs.readingStateOf(st.readingByRun, ${JSON.stringify(runId)});
      const f = rs.fileReadingOf(r);
      return JSON.stringify({
        moduleUrl: url, tab: r.tab, spanId: r.spanId,
        checkpoint: f.checkpoint, path: f.path, pane: f.pane,
        byRunKeys: Object.keys(st.readingByRun),
      });`,
  );
}

/** store 通道自检：确认拿到的是应用活实例（拿错时不报错、只静默返回常量） */
async function assertStoreLive(call, runId) {
  const s = await storeState(call, runId);
  if (s.error !== undefined) throw new Error(`store 探针失败：${JSON.stringify(s)}`);
  if (!Array.isArray(s.byRunKeys) || !s.byRunKeys.includes(runId)) {
    throw new Error(`store 探针未拿到应用同一实例（byRunKeys=${JSON.stringify(s.byRunKeys)}）`);
  }
  return s;
}

/** 读运行名单里某 run 的摘要（判"失败运行"必须看 run 级 status，而不是猜） */
async function runSummary(call, runId) {
  return appImport(
    call,
    STORE_NEEDLE,
    `const st = m.useAppStore.getState();
      const r = (st.runs || []).find(x => x.id === ${JSON.stringify(runId)});
      return JSON.stringify({ found: r !== undefined, status: r ? r.status : null,
        reason: r ? r.reason : null, steps: r ? r.steps : null });`,
  );
}

/** 读**真 monaco**：模型文本、真实 diff、readOnly 选项 */
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
        })),
        diff: diff === null ? null : {
          originalText: getText(diff.getOriginalEditor()),
          modifiedText: getText(diff.getModifiedEditor()),
          lineChangeCount: (diff.getLineChanges() ?? []).length,
          modifiedReadOnly: diff.getModifiedEditor().getOption(monaco.editor.EditorOption.readOnly),
        },
      });`,
  );
}

async function monacoOrNull(call) {
  try {
    const s = await monacoState(call);
    return s.error !== undefined ? null : s;
  } catch {
    return null;
  }
}

/** 所有已加载模型的文本里是否出现过某片段 */
function anyModelContains(m, fragment) {
  if (m === null) return false;
  const inModels = (m.models ?? []).some((x) => (x.text ?? "").includes(fragment));
  const inDiff =
    (m.diff?.originalText ?? "").includes(fragment) ||
    (m.diff?.modifiedText ?? "").includes(fragment);
  const inSingle = (m.standalone ?? []).some((x) => (x.text ?? "").includes(fragment));
  return inModels || inDiff || inSingle;
}

/**
 * "一个编辑器都没渲染"（diff 与单侧视图都没有）。
 * ⚠️ 必须把 `monacoOrNull` 的 `null`（**monaco 根本没加载**）也算作"没有"：
 *    `null?.diff === null` 求值为 `undefined === null` ⇒ false，会把"一个编辑器都没渲染"
 *    误报成"有编辑器"（本任务首轮实测踩到，8 条里 3 条就是这么假失败的）。
 */
const noEditorAtAll = (m) => m === null || (m.diff === null && (m.standalone ?? []).length === 0);
/** 所有已渲染的编辑器都只读 */
const allReadOnly = (m) =>
  m === null ||
  ((m.standalone ?? []).every((s) => s.readOnly === true) &&
    (m.diff === null || m.diff.modifiedReadOnly === true));

// ---------------------------------------------------------------------------
// DOM 通道
// ---------------------------------------------------------------------------

const domExpr = `(() => {
  const q = (s, r = document) => r.querySelector(s);
  const txt = (e) => ((e && e.textContent) || '').trim();
  const btn = (label) => {
    const b = Array.from(document.querySelectorAll('button')).find(x => txt(x) === label);
    return b === undefined ? null : { disabled: b.disabled === true, title: b.title || '' };
  };
  const body = document.body.textContent || '';
  return JSON.stringify({
    cw: document.documentElement.clientWidth, ch: document.documentElement.clientHeight,
    dpr: +devicePixelRatio.toFixed(2),
    tabSelected: txt(Array.from(document.querySelectorAll('[role="tab"]')).find(t => t.getAttribute('aria-selected') === 'true')),
    pathHeader: txt(Array.from(document.querySelectorAll('.break-all.font-code')).find(x => x.closest('[role="option"]') === null)),
    hasDiffEditor: !!q('.monaco-diff-editor'),
    hasSingleSideEditor: !!q('[data-testid="single-side-editor"]'),
    hasCodeEditorClass: !!q('.monaco-editor'),
    cards: Array.from(document.querySelectorAll('div.m-4')).map(txt),
    statusBinary: body.includes('二进制文件'),
    statusNotComparable: body.includes('内容不可读'),
    availabilityMissing: body.includes('附件缺失'),
    availabilityCorrupt: body.includes('附件损坏'),
    sideLabelsBoth: body.includes('初始快照侧') && body.includes('所选检查点侧'),
    sideUnavailableRule: /内容不可比较（二进制/.test(body),
    sideHasText: /有文本/.test(body),
    sideReadFailed: /读取失败（不是不存在）/.test(body),
    // 判据要排除产品自己的**说明性文案**，否则说明句本身就把判据点着了（5.4 踩过的假阳性）
    fakeEmptyClaim: (() => {
      const stripped = body.replace(/绝不会用空编辑器冒充[\\s\\S]*?参与 diff。/g, '');
      return /无变化|文件为空|文件是空的/.test(stripped);
    })(),
    diffCountText: (() => { const m = body.match(/共\\s*(\\d+)\\s*处差异/); return m === null ? null : Number(m[1]); })(),
    retryInitialBtn: btn('重新读取初始快照') !== null,
    retryContentBtn: btn('重新读取所选侧') !== null,
    retryListBtn: btn('重新读取清单') !== null,
    retryFileBtn: btn('重新读取该文件') !== null,
    failureNotMissing: body.includes('并不表示该文件不存在') || body.includes('读取失败（不是不存在）'),
    bodyHasErrorOutcome: body.includes('出错终止'),
    toolbar: {
      复制路径: btn('复制路径'),
      复制左侧原文: btn('复制左侧原文'),
      复制右侧原文: btn('复制右侧原文'),
      复制元信息: btn('复制元信息'),
      查找: btn('查找'),
      上一差异: btn('上一差异'),
      下一差异: btn('下一差异'),
    },
    fileOptions: Array.from(document.querySelectorAll('[role="option"][data-file-path]')).map(e => e.getAttribute('data-file-path')),
    selectedFile: (() => { const e = q('[role="option"][aria-selected="true"]'); return e === null ? null : e.getAttribute('data-file-path'); })(),
    ckpts: Array.from(document.querySelectorAll('button'))
      .filter(b => (b.title || '').includes('检查点所属 step') || (b.title || '').includes('文件世界起点'))
      .map(b => ({ label: txt(b), active: b.className.includes('bg-violet-600') })),
    filterBtns: Array.from(document.querySelectorAll('button'))
      .filter(b => ['自动', '全部', '有变化'].includes(txt(b)))
      .map(b => ({ label: txt(b), active: b.className.includes('bg-violet-600') })),
    bodyHasLoading: /正在读取|正在加载编辑器/.test(body),
    bodySample: body.replace(/\s+/g, " ").slice(0, 600),
  });
})()`;

async function dom(call) {
  return JSON.parse(await ev(call, domExpr));
}

// ---------------------------------------------------------------------------
// 真交互助手
// ---------------------------------------------------------------------------

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

const CKPT_ACTIVE_EXPR = `(() => { const a = Array.from(document.querySelectorAll('button')).filter(${CKPT_FILTER})
  .find(b => b.className.includes('bg-violet-600')) ?? null; return a === null ? null : ((a.textContent||'').trim()); })()`;

/**
 * 按标签选检查点。⚠️ 必须**点击后校验活动项**：按钮存在不等于点击生效，
 * 静默返回 false 会让"没切检查点"被后续判据当成产品缺陷（污染证据）。
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
  throw new Error(`未能把检查点切到「${fragment}」（最后一次 ${JSON.stringify(last)}）`);
}

/** 点变化筛选（自动/全部/有变化） */
async function pickFilter(call, label) {
  const click = `(() => { const b = Array.from(document.querySelectorAll('button'))
      .find(x => ((x.textContent||'').trim()) === '${label}');
    if (!b) return false; b.click(); return true; })()`;
  const activeExpr = `(() => { const a = Array.from(document.querySelectorAll('button'))
    .filter(b => ['自动','全部','有变化'].includes(((b.textContent||'').trim())))
    .find(b => b.className.includes('bg-violet-600')) ?? null;
    return a === null ? null : ((a.textContent||'').trim()); })()`;
  let lastActive = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ok = await ev(call, click);
    if (ok !== true) {
      await sleep(900);
      continue;
    }
    await sleep(900);
    lastActive = await ev(call, activeExpr);
    if (lastActive === label) return true;
    await sleep(500);
  }
  throw new Error(
    `未能把变化筛选切到「${label}」（最后一次活动项 = ${JSON.stringify(lastActive)}；` +
      `筛选按钮存在性 = ${JSON.stringify(await ev(call, "(() => Array.from(document.querySelectorAll('button')).map(b => (b.textContent||'').trim()).filter(t => ['自动','全部','有变化'].includes(t)))()"))}）`,
  );
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
  const selected = await ev(
    call,
    `(() => { const e = document.querySelector('[role="option"][aria-selected="true"]');
      return e === null ? null : e.getAttribute('data-file-path'); })()`,
  );
  return selected === path;
}

/** 进入某 run 的文件页（ckptFragment 非空则按文案选检查点；filterLabel 非空则点筛选） */
async function enterFiles(call, runId, ckptFragment = null, filterLabel = null) {
  const m = {};
  // ⚠️ `runs()` 读的是运行名单的 DOM 按钮，而 medium 档在文件页会收起运行导航
  // ⇒ 先回概览读名单，读不到就抛错（静默早退会让后续判据拿上一次页面状态断言）
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

// ---------------------------------------------------------------------------
// 迟到/失败注入（同 5.4 法：包装 store 动作，规则放可变对象，只改规则不重装）
// ---------------------------------------------------------------------------

async function installHooks(call) {
  return appImport(
    call,
    STORE_NEEDLE,
    `const store = m.useAppStore;
      if (window.__u255orig === undefined) {
        const st0 = store.getState();
        window.__u255orig = { r: st0.readWorkspaceFile, i: st0.inspectWorkspace };
        window.__u255cfg = { rules: [] };
        window.__u255n = {};
        window.__u255log = [];
      }
      const match = (kind, key, occ, side) => {
        const rules = (window.__u255cfg && window.__u255cfg.rules) || [];
        return rules.find(r => r.kind === kind && (r.key === undefined || r.key === key)
          && (r.side === undefined || r.side === side)
          && (r.occurrence === undefined || r.occurrence === occ) && r.done !== true) || null;
      };
      const wrap = (kind, orig) => async (req) => {
        const key = kind === 'read' ? String(req.path) : String(req.stepSpanId === undefined || req.stepSpanId === null ? 'initial' : req.stepSpanId);
        const side = kind === 'read' ? (req.stepSpanId === undefined || req.stepSpanId === null ? 'initial' : 'selected') : 'n/a';
        // ⚠️ 代次计数必须**按 (kind, key, side) 分桶**：同一条路径的两侧读共用 key，
        //    若只按 key 计数，"第 1 次"会被先发出的那一侧消费掉 ⇒ 点名某一侧的规则静默失效
        //    （5.4 已按 side 匹配，但计数仍是共享的，本任务实测仍会漏）。
        const bucket = kind + '|' + key + '|' + side;
        window.__u255n[bucket] = (window.__u255n[bucket] || 0) + 1;
        const occ = window.__u255n[bucket];
        const o = match(kind, key, occ, side);
        if (o !== null) o.done = true;
        window.__u255log.push({ kind: kind, key: key, side: side, occurrence: occ,
          mode: o === null ? 'pass' : (o.fail ? 'fail' : 'delay') });
        if (o !== null && o.delayMs) await new Promise(r => setTimeout(r, o.delayMs));
        const out = await orig(req);
        if (o !== null && o.fail) return { ok: false, code: o.fail, message: '注入的只读通道失败' };
        return out;
      };
      store.setState({ readWorkspaceFile: wrap('read', window.__u255orig.r), inspectWorkspace: wrap('inspect', window.__u255orig.i) });
      return JSON.stringify({ ok: true });`,
  );
}

async function setRules(call, rules) {
  // ⚠️ 换规则即**重置代次计数**：`occurrence` 是"该 key 第几次读取"，跨子场景累加会让
  //    后续子场景的 `occurrence:1` 被前一子场景消费 ⇒ 注入静默失效（5.4 踩过）。
  return evAsync(
    call,
    `(() => { window.__u255cfg.rules = ${JSON.stringify(rules)}; window.__u255n = {}; return 'ok'; })()`,
  );
}

async function hookLog(call) {
  return JSON.parse(await evAsync(call, "(() => JSON.stringify(window.__u255log || []))()"));
}

// ---------------------------------------------------------------------------
// 原始 IPC 通道（本任务新增）
// ---------------------------------------------------------------------------

/**
 * 直接调 `window.api` 的**真 IPC**，返回未加工的 Envelope。
 * 这是"越权"最贴切的证据面：请求与响应都不经过 store / 组件，任何人从 renderer 都能这样发。
 */
async function rawIpc(call, method, request) {
  return evAsync(
    call,
    `(async () => {
      try {
        const r = await window.api[${JSON.stringify(method)}](${JSON.stringify(request)});
        return JSON.stringify({ threw: false, envelope: r });
      } catch (e) {
        return JSON.stringify({ threw: true, error: String(e && e.message ? e.message : e) });
      }
    })()`,
  ).then((s) => JSON.parse(s));
}

/** 越权判据的通用收口：要么 envelope 拒绝，要么结果状态是 rejected/not_found */
function isRefusal(probe) {
  if (probe.threw) return true;
  const e = probe.envelope;
  if (!e) return false;
  if (e.ok === false) return true;
  const d = e.data;
  return d?.status === "rejected" || d?.status === "not_found";
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

/** 探路：只 dump 真机事实 */
async function scenarioProbe(call) {
  const m = {};
  m.location = await ev(call, "location.href");
  m.viewport = await dom(call);
  m.apiShape = JSON.parse(
    await ev(
      call,
      `(() => { const a = window.api; if (!a) return JSON.stringify({ has: false });
        return JSON.stringify({ has: true, methods: Object.keys(a) }); })()`,
    ),
  );
  m.runListCount = (await runs(call)).length;
  m.runIds = await runs(call);
  m.moduleProbe = JSON.parse(
    await ev(
      call,
      `(() => {
        const all = performance.getEntriesByType('resource').map(e => e.name);
        return JSON.stringify({
          total: all.length,
          store: all.filter(n => n.includes('store.ts')).slice(0, 6),
          monaco: all.filter(n => n.includes('monaco-bootstrap')).slice(0, 4),
          sample: all.slice(0, 4),
        });
      })()`,
    ),
  );
  m.fixtureRunsPresent = {
    [ROOT_RUN]: (await runs(call)).includes(ROOT_RUN),
    [FORK_RUN]: (await runs(call)).includes(FORK_RUN),
    [ERRORED_RUN]: (await runs(call)).includes(ERRORED_RUN),
    [MISSING_RUN]: (await runs(call)).includes(MISSING_RUN),
    [CORRUPT_RUN]: (await runs(call)).includes(CORRUPT_RUN),
    [NOOWN_RUN]: (await runs(call)).includes(NOOWN_RUN),
  };
  m.erroredSummary = await runSummary(call, ERRORED_RUN);
  m.rootSummary = await runSummary(call, ROOT_RUN);
  m.rawInspect = await rawIpc(call, "inspectWorkspace", { runId: ROOT_RUN, stepSpanId: ROOT_R2 });
  m.rawRead = await rawIpc(call, "readWorkspaceFile", {
    runId: ROOT_RUN,
    stepSpanId: ROOT_R2,
    path: "edit.txt",
  });
  await shot(call, SHOT_DIR, `${TAG}-0-概览.png`);
  return m;
}

/**
 * ① 文件读取 IPC 拒绝越权。
 *
 * 全部走 **`window.api` 真 IPC**（不经 store/组件）。判据分三层：
 *   - 通道级：`runId` 带路径分隔符 ⇒ main 的 schema 之前就被 A 包拒。
 *   - 请求级：`path` 不是逻辑路径（绝对路径 / UNC / 穿越 / 冒号）⇒ `not_found`（永不拼进宿主路径）。
 *   - 归属级：祖先 step 拿来定位本 run 的文件 ⇒ `rejected`（`step_not_found`）。
 * 另设**哨兵文件**：把真实宿主文件的内容写成唯一串，若实现真去读了它，返回值里必然出现该串。
 */
async function scenarioIpcGuard(call) {
  const m = {};
  const SENTINEL = `U2-5.5-SENTINEL-${Date.now()}-绝不外泄`;
  const sentinelPath = join(FIX_DIR, "source", "secret-sentinel.txt");
  writeFileSync(sentinelPath, `${SENTINEL}\n`, "utf8");
  m.sentinelHostPath = sentinelPath;

  const sentinelForms = [
    sentinelPath, // 绝对宿主路径
    sentinelPath.replace(/\\/g, "/"),
    `file://${sentinelPath.replace(/\\/g, "/")}`,
    "../../../../secret-sentinel.txt",
    "secret-sentinel.txt", // 清单里没有这条路径
  ];
  const sentinelProbes = [];
  for (const form of sentinelForms) {
    const p = await rawIpc(call, "readWorkspaceFile", {
      runId: ROOT_RUN,
      stepSpanId: ROOT_R2,
      path: form,
    });
    sentinelProbes.push({ path: form, probe: p, leaked: JSON.stringify(p).includes(SENTINEL) });
  }
  m.sentinelProbes = sentinelProbes;
  check(
    "哨兵宿主文件从未被读入（5 种物理/穿越写法）",
    sentinelProbes.every((x) => !x.leaked),
    sentinelProbes
      .filter((x) => x.leaked)
      .map((x) => x.path)
      .join(" | ") || "均无泄漏",
  );
  check(
    "哨兵请求全部被拒（rejected 或 not_found）",
    sentinelProbes.every((x) => isRefusal(x.probe)),
    JSON.stringify(sentinelProbes.map((x) => ({ p: x.path, e: x.probe.envelope }))).slice(0, 600),
  );

  // —— runId 路径穿越（通道级）——
  m.runIdTraversal = {
    inspect: await rawIpc(call, "inspectWorkspace", { runId: "../../etc/passwd" }),
    readBackslash: await rawIpc(call, "readWorkspaceFile", {
      runId: "..\\..\\x",
      path: "a.txt",
    }),
    readDotDot: await rawIpc(call, "readWorkspaceFile", { runId: "..", path: "a.txt" }),
  };
  check(
    "非法 runId（穿越）被明确拒绝",
    isRefusal(m.runIdTraversal.inspect) &&
      isRefusal(m.runIdTraversal.readBackslash) &&
      isRefusal(m.runIdTraversal.readDotDot),
    JSON.stringify(m.runIdTraversal).slice(0, 500),
  );
  check(
    "非法 runId 的拒绝码是 INVALID_REQUEST（可展示、非静默）",
    m.runIdTraversal.inspect.envelope?.error?.code === "WORKSPACE_INVALID_REQUEST",
    JSON.stringify(m.runIdTraversal.inspect.envelope?.error ?? null),
  );

  // —— 清单外路径（请求级）——
  m.outsideManifest = {
    absent: await rawIpc(call, "readWorkspaceFile", {
      runId: ROOT_RUN,
      stepSpanId: ROOT_R2,
      path: "not-in-manifest.txt",
    }),
    // ⚠️ 这条路径**存在于另一个 run 的清单**里 ⇒ 判"不以同名文件/其他快照替代"
    otherRunPath: await rawIpc(call, "readWorkspaceFile", {
      runId: ROOT_RUN,
      stepSpanId: ROOT_R2,
      path: MISSING_FILE,
    }),
    physicalBlobPath: await rawIpc(call, "readWorkspaceFile", {
      runId: ROOT_RUN,
      stepSpanId: ROOT_R2,
      path: `workspace-blobs/sha256/${MF.二进制哈希}`,
    }),
    unnormalizedSep: await rawIpc(call, "readWorkspaceFile", {
      runId: ROOT_RUN,
      stepSpanId: ROOT_R2,
      path: "sub\\a.txt",
    }),
  };
  check(
    "清单外路径 / 物理 blob 路径 / 未规范化分隔符一律 not_found",
    Object.values(m.outsideManifest).every((p) => p.envelope?.data?.status === "not_found"),
    JSON.stringify(m.outsideManifest).slice(0, 700),
  );
  check(
    "同一路径在别的 run 的清单里也**不替代**本 run（跨 run 不串）",
    m.outsideManifest.otherRunPath.envelope?.data?.status === "not_found",
    JSON.stringify(m.outsideManifest.otherRunPath.envelope?.data ?? null),
  );

  // —— 同一 run 的**别的检查点**也不替代：new.txt 只在第 2 轮起存在 ——
  m.snapshotIsolation = {
    initial: await rawIpc(call, "readWorkspaceFile", { runId: ROOT_RUN, path: "new.txt" }),
    round2: await rawIpc(call, "readWorkspaceFile", {
      runId: ROOT_RUN,
      stepSpanId: ROOT_R2,
      path: "new.txt",
    }),
  };
  check(
    "初始快照里没有的路径不会被第 2 轮快照顶替（同一 run 的别的检查点也不替代）",
    m.snapshotIsolation.initial.envelope?.data?.status === "not_found" &&
      m.snapshotIsolation.round2.envelope?.data?.status === "text" &&
      m.snapshotIsolation.round2.envelope?.data?.text.trim() === MF.文件世界.new.trim(),
    JSON.stringify(m.snapshotIsolation).slice(0, 400),
  );

  // —— 祖先而非自有 step（归属级）——
  m.ancestorStep = {
    read: await rawIpc(call, "readWorkspaceFile", {
      runId: NOOWN_RUN,
      stepSpanId: ROOT_R1, // 这是**父 run** 的步骤，不是本 run 自有的
      path: "a.txt",
    }),
    inspect: await rawIpc(call, "inspectWorkspace", { runId: NOOWN_RUN, stepSpanId: ROOT_R1 }),
  };
  check(
    "祖先 step 不能用来定位本 run 的文件（read 返 rejected）",
    m.ancestorStep.read.envelope?.data?.status === "rejected" &&
      m.ancestorStep.read.envelope?.data?.code === "step_not_found",
    JSON.stringify(m.ancestorStep.read.envelope?.data ?? null),
  );
  check(
    "祖先 step 的清单请求同样被拒（inspect 返 STEP_NOT_FOUND）",
    m.ancestorStep.inspect.envelope?.error?.code === "WORKSPACE_STEP_NOT_FOUND",
    JSON.stringify(m.ancestorStep.inspect.envelope?.error ?? null),
  );

  // —— 请求形状非法 ——
  m.shapeInvalid = {
    noPath: await rawIpc(call, "readWorkspaceFile", { runId: ROOT_RUN }),
    emptyRun: await rawIpc(call, "inspectWorkspace", { runId: "" }),
  };
  check(
    "请求形状非法被 INVALID_ARGUMENT 拒绝",
    m.shapeInvalid.noPath.envelope?.error?.code === "INVALID_ARGUMENT" &&
      m.shapeInvalid.emptyRun.envelope?.error?.code === "INVALID_ARGUMENT",
    JSON.stringify(m.shapeInvalid).slice(0, 400),
  );

  // —— 对照：合法请求必须**成功**（否则上面全是"什么都拒绝"的空转真）——
  m.legit = {
    inspect: await rawIpc(call, "inspectWorkspace", { runId: ROOT_RUN, stepSpanId: ROOT_R2 }),
    read: await rawIpc(call, "readWorkspaceFile", {
      runId: ROOT_RUN,
      stepSpanId: ROOT_R2,
      path: "edit.txt",
    }),
  };
  check(
    "对照：合法请求确实成功（证明拒绝判据有牙，不是一律拒绝）",
    m.legit.inspect.envelope?.ok === true &&
      m.legit.read.envelope?.data?.status === "text" &&
      m.legit.read.envelope?.data?.text.trim() === TEXT_EDIT_R2,
    JSON.stringify(m.legit).slice(0, 400),
  );

  // ⚠️ 本 tag 是 **IPC 级**（直接调 `window.api`，不经界面）⇒ 不产界面截图：
  //    截图只会是一张无关的概览页，把它当"越权拒绝的证据"是误导。原始证据以
  //    `measurements.json` 里的 envelope 为准。
  return m;
}

/**
 * ② 二进制和不可用附件分别显示。
 *
 * 四条 fixture：真实 root（bin.dat 二进制）· 附件缺失标本 · 附件损坏标本 · 无自有完成步骤标本。
 * 判据：列表徽标 + 内容卡文案逐态可分，且**绝不渲染伪空文件**。
 */
async function scenarioUnavailable(call) {
  const m = {};

  // —— 二进制（真实引擎，bin.dat 两侧都是二进制）——
  Object.assign(m, await enterFiles(call, ROOT_RUN, "第 2 轮", "全部"));
  m.rootDom = await dom(call);
  m.rootPickBin = await pickFile(call, BINARY_FILE);
  m.binDom = await dom(call);
  m.binMonaco = await monacoOrNull(call);
  await shot(call, SHOT_DIR, `${TAG}-1-二进制.png`);
  check(
    "二进制文件：只给大小/哈希，判为「二进制文件」且不渲染文本编辑器",
    m.binDom.pathHeader === BINARY_FILE && m.binDom.statusBinary && noEditorAtAll(m.binMonaco),
    JSON.stringify({
      header: m.binDom.pathHeader,
      cards: m.binDom.cards,
      monaco: m.binMonaco,
    }).slice(0, 500),
  );
  check(
    "二进制文件：不假装「无变化 / 文件为空」",
    m.binDom.fakeEmptyClaim === false,
    JSON.stringify(m.binDom.cards).slice(0, 300),
  );

  // —— 附件缺失标本 ——
  Object.assign(m, await enterFiles(call, MISSING_RUN, "第 2 轮", "全部"), { missingEnter: true });
  m.missingListDom = await dom(call);
  m.missingPick = await pickFile(call, MISSING_FILE);
  m.missingDom = await dom(call);
  m.missingMonaco = await monacoOrNull(call);
  await shot(call, SHOT_DIR, `${TAG}-2-附件缺失.png`);
  check(
    "附件缺失：列表徽标标出「附件缺失」",
    m.missingListDom.availabilityMissing && m.missingListDom.fileOptions.includes(MISSING_FILE),
    JSON.stringify({
      opts: m.missingListDom.fileOptions,
      badge: m.missingListDom.availabilityMissing,
    }),
  );
  check(
    "附件缺失：内容区提示不可读，且不渲染伪空文件",
    m.missingDom.pathHeader === MISSING_FILE &&
      m.missingDom.fakeEmptyClaim === false &&
      noEditorAtAll(m.missingMonaco),
    JSON.stringify({ cards: m.missingDom.cards, monaco: m.missingMonaco }).slice(0, 500),
  );

  // —— 附件损坏标本 ——
  Object.assign(m, await enterFiles(call, CORRUPT_RUN, "第 2 轮", "全部"), { corruptEnter: true });
  m.corruptListDom = await dom(call);
  m.corruptPick = await pickFile(call, CORRUPT_FILE);
  m.corruptDom = await dom(call);
  m.corruptMonaco = await monacoOrNull(call);
  await shot(call, SHOT_DIR, `${TAG}-3-附件损坏.png`);
  check(
    "附件损坏：列表徽标标出「附件损坏」",
    m.corruptListDom.availabilityCorrupt && m.corruptListDom.fileOptions.includes(CORRUPT_FILE),
    JSON.stringify({
      opts: m.corruptListDom.fileOptions,
      badge: m.corruptListDom.availabilityCorrupt,
    }),
  );
  check(
    "附件损坏：内容区提示不可读，且不渲染伪空文件",
    m.corruptDom.pathHeader === CORRUPT_FILE &&
      m.corruptDom.fakeEmptyClaim === false &&
      noEditorAtAll(m.corruptMonaco),
    JSON.stringify({ cards: m.corruptDom.cards, monaco: m.corruptMonaco }).slice(0, 500),
  );

  // —— 没有检查点的旧 run（无自有完成步骤）——
  // 用**默认**变化偏好（自动）观测真实默认路径：该标本没有自有完成步骤 ⇒ 初始快照是唯一检查点，
  // 其条目 change 全为 `initial`，默认筛选下清单照常完整可见。
  Object.assign(m, await enterFiles(call, NOOWN_RUN, null, null), { noOwnEnter: true });
  m.noOwnDom = await dom(call);
  await shot(call, SHOT_DIR, `${TAG}-4-无自有检查点.png`);
  check(
    "无自有完成步骤：选择器只剩「本 run 初始状态」，不把祖先轮号冒充本 run 检查点",
    m.noOwnDom.ckpts.length === 1 && m.noOwnDom.ckpts[0].label.includes("初始"),
    JSON.stringify(m.noOwnDom.ckpts),
  );
  check(
    "无自有完成步骤：初始快照照常可读（合法轨迹仍可读）",
    m.noOwnDom.fileOptions.length > 0 && m.noOwnDom.fakeEmptyClaim === false,
    JSON.stringify({ opts: m.noOwnDom.fileOptions.slice(0, 8) }).slice(0, 300),
  );
  return m;
}

/**
 * ③ 失败运行已记录文件可查看。
 *
 * errored run 的 run 级事实是 `reason === "error"`（界面标「出错终止」，可核），
 * 但**已落盘**的检查点仍可读出完整文件事实——失败不撤销历史写入。
 */
async function scenarioErrored(call) {
  const m = {};
  m.summary = await runSummary(call, ERRORED_RUN);
  check(
    "失败 run 的 run 级事实是「出错终止」（reason=error，不是靠猜）",
    m.summary.found === true && m.summary.status === "completed" && m.summary.reason === "error",
    JSON.stringify(m.summary),
  );

  // 先在概览页坐实"界面自己也这么判"（同一份 reason 的展示），再进文件页
  const picked = await selectRun(call, ERRORED_RUN);
  m.overviewDom = await dom(call);
  m.pick = picked;
  check(
    "概览页把该 run 标为「出错终止」（界面与数据同源）",
    m.overviewDom.bodyHasErrorOutcome === true,
    `tab=${m.overviewDom.tabSelected}`,
  );

  Object.assign(m, await enterFiles(call, ERRORED_RUN, null, "全部"), { enter: true });
  m.ckptDom = await dom(call);
  m.pickR1 = await pickCheckpointLike(call, "第 1 轮");
  m.pickEdit = await pickFile(call, "edit.txt");
  m.editDom = await dom(call);
  m.editMonaco = await monacoOrNull(call);
  await shot(call, SHOT_DIR, `${TAG}-1-失败run第1轮已记录检查点.png`);

  m.pickR2 = await pickCheckpointLike(call, "第 2 轮");
  m.r2Dom = await dom(call);
  m.r2Monaco = await monacoOrNull(call);
  await shot(call, SHOT_DIR, `${TAG}-2-失败run第2轮.png`);

  check(
    "失败 run 把**已落盘**的检查点都列出（初始 + 各轮），且都已落盘可定位",
    m.ckptDom.ckpts.length === 3 &&
      m.ckptDom.ckpts
        .map((c) => c.label)
        .join("|")
        .includes("第 2 轮"),
    JSON.stringify(m.ckptDom.ckpts),
  );
  check(
    "失败 run：第 1 轮读出的正文是运行时真实写入的内容（以 monaco 真模型立证）",
    anyModelContains(m.editMonaco, TEXT_EDIT_ERRONED),
    JSON.stringify({
      standalone: (m.editMonaco?.standalone ?? []).map((s) => (s.text ?? "").trim().slice(0, 40)),
      diff: m.editMonaco?.diff?.modifiedText?.slice(0, 40) ?? null,
    }).slice(0, 400),
  );
  check(
    "失败 run：切换第 2 轮检查点不崩、内容仍可读（失败不撤销历史写入）",
    m.r2Dom.pathHeader === "edit.txt" &&
      anyModelContains(m.r2Monaco, TEXT_EDIT_ERRONED) &&
      m.r2Dom.fakeEmptyClaim === false,
    JSON.stringify({ header: m.r2Dom.pathHeader, cards: m.r2Dom.cards }).slice(0, 300),
  );
  check(
    "失败 run：编辑器只读，且不谎称「无变化 / 文件为空」",
    allReadOnly(m.editMonaco) && m.editDom.fakeEmptyClaim === false,
    JSON.stringify({ cards: m.editDom.cards, monaco: m.editMonaco }).slice(0, 400),
  );
  return m;
}

/**
 * ④ + ⑤ 文件浏览过程无写入 · 阅读重试只读且重新校验。
 *
 * 数据面冻结口径（逐文件 SHA-256）：源目录 · 夹具目录 · live traces · live 附件。
 * 浏览序列包含：切检查点、开多个文件、开 diff、切回列表、重试清单、重试内容——
 * 全部走真点击。其间注入两次**只读通道失败**，用于证明"重试真的重发 IPC"。
 */
async function scenarioReadonly(call) {
  const m = {};
  await installHooks(call);

  const before = freezeDataSurface();
  m.beforeCounts = {
    traces: Object.keys(before.traces).length,
    blobs: Object.keys(before.blobs).length,
    source: Object.keys(before.source).length,
  };
  m.beforeHashes = {
    traces: Object.keys(before.traces).length,
    blobs: Object.keys(before.blobs).length,
    sourceDigest: createHash("sha256").update(JSON.stringify(before.source)).digest("hex"),
  };

  // —— 浏览序列（纯只读操作，不得产生任何写入）——
  await setRules(call, []);
  Object.assign(m, await enterFiles(call, ROOT_RUN, "第 2 轮", "全部"), { enter: true });
  m.browse = {};
  m.browse.pickEdit = await pickFile(call, "edit.txt");
  m.browse.editDom = await dom(call);
  m.browse.editMonaco = await monacoOrNull(call);
  await shot(call, SHOT_DIR, `${TAG}-1-浏览diff.png`);

  m.browse.pickLong = await pickFile(call, "long.txt");
  m.browse.longDom = await dom(call);
  m.browse.longMonaco = await monacoOrNull(call);

  m.browse.pickBin = await pickFile(call, BINARY_FILE);
  m.browse.binDom = await dom(call);

  m.browse.pickInitial = await pickCheckpointLike(call, "初始");
  m.browse.initialDom = await dom(call);
  m.browse.pickR2 = await pickCheckpointLike(call, "第 2 轮");
  m.browse.backDom = await dom(call);
  await shot(call, SHOT_DIR, `${TAG}-2-浏览往返.png`);

  check(
    "浏览过程真的发生了（不是空转）：diff 有真实行变更、长文本 0 差异、二进制无编辑器",
    (m.browse.editMonaco?.diff?.lineChangeCount ?? 0) >= 1 &&
      m.browse.longMonaco?.diff?.lineChangeCount === 0 &&
      m.browse.binDom.statusBinary,
    JSON.stringify({
      editCount: m.browse.editMonaco?.diff?.lineChangeCount ?? null,
      longCount: m.browse.longMonaco?.diff?.lineChangeCount ?? null,
      bin: m.browse.binDom.statusBinary,
    }),
  );
  check(
    "浏览全程编辑器只读（无替换/写入通道）",
    allReadOnly(m.browse.editMonaco),
    JSON.stringify(m.browse.editMonaco?.diff?.modifiedReadOnly ?? null),
  );

  // —— 清单重试：注入一次清单失败，点「重新读取清单」后必须真重发 ——
  m.logOffsetList = (await hookLog(call)).length;
  await setRules(call, [{ kind: "inspect", occurrence: 1, fail: "INJECTED_LIST_FAIL" }]);
  await pickCheckpointLike(call, "初始"); // 切检查点 ⇒ 强制真的重发清单读取
  m.listRetryDom = await dom(call);
  await shot(call, SHOT_DIR, `${TAG}-3-清单失败.png`);
  const listRetryClicked = await clickByText(call, "重新读取清单", 1600);
  m.listRetryAfterDom = await dom(call);
  m.listRetryLog = (await hookLog(call)).slice(m.logOffsetList);
  const inspectCalls = m.listRetryLog.filter((l) => l.kind === "inspect");
  check(
    "清单失败不冒充空清单：给出可辨认失败 + 「重新读取清单」入口",
    m.listRetryDom.retryListBtn === true && m.listRetryDom.fakeEmptyClaim === false,
    JSON.stringify({ cards: m.listRetryDom.cards }).slice(0, 300),
  );
  check(
    "重试清单**真的重发**只读 IPC（同 key 先失败后成功），并显示当前校验结果",
    listRetryClicked === true &&
      inspectCalls.some((l) => l.mode === "fail") &&
      inspectCalls[inspectCalls.length - 1].mode === "pass" &&
      m.listRetryAfterDom.fileOptions.length > 0,
    JSON.stringify({ inspectCalls, opts: m.listRetryAfterDom.fileOptions.length }),
  );

  // —— 内容重试：注入一次**所选侧**读取失败，点「重新读取所选侧」后必须真重发 ——
  //
  // ⚠️ 必须**先制造一次真正的重新读取**：同 (检查点, 路径) 已在会话里结算过时，
  //    再点同一个文件不会重新发 IPC ⇒ 注入永不生效、重试按钮也不存在（首轮实测踩到）。
  //    做法：切到初始再切回第 2 轮，让所选侧对 edit.txt 重新读一次。
  m.logOffsetContent = (await hookLog(call)).length;
  await setRules(call, [
    { kind: "read", side: "selected", key: "edit.txt", occurrence: 1, fail: "INJECTED_READ_FAIL" },
  ]);
  await pickCheckpointLike(call, "初始");
  await pickCheckpointLike(call, "第 2 轮");
  m.contentRetryPick = await pickFile(call, "edit.txt");
  m.contentRetryDom = await dom(call);
  await shot(call, SHOT_DIR, `${TAG}-4-内容失败.png`);
  const contentRetryClicked = await clickByText(call, "重新读取所选侧", 1800);
  m.contentRetryAfterDom = await dom(call);
  m.contentRetryAfterMonaco = await monacoOrNull(call);
  m.contentRetryLog = (await hookLog(call)).slice(m.logOffsetContent);
  const editReads = m.contentRetryLog.filter(
    (l) => l.kind === "read" && l.key === "edit.txt" && l.side === "selected",
  );
  check(
    "内容失败不冒充「不存在」：给出失败说明与「重新读取所选侧」入口",
    m.contentRetryDom.failureNotMissing === true ||
      m.contentRetryDom.retryContentBtn === true ||
      m.contentRetryDom.retryFileBtn === true,
    JSON.stringify({ cards: m.contentRetryDom.cards }).slice(0, 400),
  );
  check(
    "重试内容**真的重发**只读 IPC（同路径所选侧先失败后成功），并显示当前校验结果",
    contentRetryClicked === true &&
      editReads.some((l) => l.mode === "fail") &&
      editReads[editReads.length - 1].mode === "pass" &&
      anyModelContains(m.contentRetryAfterMonaco, TEXT_EDIT_R2),
    JSON.stringify({
      editReads,
      texts: (m.contentRetryAfterMonaco?.standalone ?? []).map((s) =>
        (s.text ?? "").trim().slice(0, 30),
      ),
    }).slice(0, 500),
  );
  await shot(call, SHOT_DIR, `${TAG}-5-内容重试成功.png`);

  // —— 冻结面复核 ——
  const after = freezeDataSurface();
  m.diff = diffSurface(before, after);
  m.afterCounts = {
    traces: Object.keys(after.traces).length,
    blobs: Object.keys(after.blobs).length,
    source: Object.keys(after.source).length,
  };
  m.afterHashes = {
    sourceDigest: createHash("sha256").update(JSON.stringify(after.source)).digest("hex"),
  };

  check(
    "源目录逐文件 SHA-256 前后一致（source/）",
    m.diff.filter((d) => d.startsWith("source/")).length === 0,
    m.diff.filter((d) => d.startsWith("source/")).join(" | ") || "无差异",
  );
  check(
    "既有 trace 逐文件 SHA-256 前后一致（traces/，含父/兄弟 run）",
    m.diff.filter((d) => d.startsWith("traces/")).length === 0,
    m.diff.filter((d) => d.startsWith("traces/")).join(" | ") || "无差异",
  );
  check(
    "既有附件逐文件 SHA-256 前后一致（workspace-blobs/）",
    m.diff.filter((d) => d.startsWith("blobs/")).length === 0,
    m.diff.filter((d) => d.startsWith("blobs/")).join(" | ") || "无差异",
  );
  check(
    "夹具目录（含夹具源与清单）逐文件不变",
    m.diff.filter((d) => d.startsWith("fixture/")).length === 0,
    m.diff.filter((d) => d.startsWith("fixture/")).join(" | ") || "无差异",
  );
  check(
    "浏览全程零新增 run / 零新增附件（不创建运行或附件、不补写清单）",
    m.afterCounts.traces === m.beforeCounts.traces &&
      m.afterCounts.blobs === m.beforeCounts.blobs &&
      m.afterCounts.source === m.beforeCounts.source,
    JSON.stringify({ before: m.beforeCounts, after: m.afterCounts }),
  );
  check(
    "模型与工具零调用（无新 trace、无 trace 字节变化 ⇒ 未落任何 llm.call / tool.invoke）",
    m.diff.filter((d) => d.startsWith("traces/")).length === 0,
    "以 trace 逐字节不变立证",
  );
  return m;
}

/**
 * 判据有牙（canary）：证明"逐文件 SHA-256 冻结面"**真的能发现写入**，
 * 而不是一个永远返回"无差异"的空转断言。
 *
 * 做法：故意在最安全的两个位置制造改动 ——
 *   ① 在夹具目录**新增**一个文件（测"新增"分支）；
 *   ② 改写夹具清单（测"哈希变化"分支，改完**逐字节还原**）。
 * 然后断言两者都被检出；还原后再断言回到零差异。
 */
async function scenarioSelfcheck(call) {
  const m = {};
  const manifestPath = MANIFEST_PATH;
  const originalManifest = readFileSync(manifestPath);
  const canaryPath = join(FIX_DIR, "canary.tmp");

  const base = freezeDataSurface();
  m.baseDiff = diffSurface(base, base);

  // ① 新增文件
  writeFileSync(canaryPath, "canary\n", "utf8");
  const afterAdd = freezeDataSurface();
  m.addDiff = diffSurface(base, afterAdd);

  // ② 改写夹具清单（哈希变化）
  writeFileSync(manifestPath, `${originalManifest.toString("utf8")}\n`, "utf8");
  const afterModify = freezeDataSurface();
  m.modifyDiff = diffSurface(base, afterModify);

  // 还原
  writeFileSync(manifestPath, originalManifest);
  rmSync(canaryPath, { force: true });
  const afterRestore = freezeDataSurface();
  m.restoreDiff = diffSurface(base, afterRestore);

  check(
    "冻结面能检出**新增**文件（判据有牙，不是空转）",
    m.addDiff.some((d) => d.endsWith("canary.tmp 新增")),
    JSON.stringify(m.addDiff).slice(0, 300),
  );
  check(
    "冻结面能检出**哈希变化**（判据有牙，不是空转）",
    m.modifyDiff.some((d) => d.includes("MANIFEST-55.json 哈希变化")),
    JSON.stringify(m.modifyDiff).slice(0, 300),
  );
  check(
    "还原后回到零差异（说明上面的检测不是常量真）",
    m.restoreDiff.length === 0,
    JSON.stringify(m.restoreDiff).slice(0, 300),
  );
  return m;
}

// ---------------------------------------------------------------------------
// 驱动
// ---------------------------------------------------------------------------

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
  else if (TAG === "ipc-guard") out = await scenarioIpcGuard(call);
  else if (TAG === "unavailable") out = await scenarioUnavailable(call);
  else if (TAG === "errored") out = await scenarioErrored(call);
  else if (TAG === "readonly") out = await scenarioReadonly(call);
  else if (TAG === "selfcheck") out = await scenarioSelfcheck(call);
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
