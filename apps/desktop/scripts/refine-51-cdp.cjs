/* eslint-disable */
/**
 * refine-ui-for-community-release 任务 5.1：**Electron 实机验收**。
 *
 * 流程（tasks 5.1 原文）：运行定位 → 错误调用 → 编辑 → 设置／录制往返 → 返回来源；
 * 逐字核对中文／日文／非法 JSON、目标和修订；点名验证
 * 「旧创建设置及执行入口保持可达」（R07）与「对象完整 ID 可访问并复制」（N04）。
 * 证据落 evidence-index：R07 / N01–N04。
 *
 * 场景分段（单 dev、单 mock、单 tag 顺序执行）：
 * - P0 准备：受控 settings + 受控上游，直调 IPC 创建 run A（正常对话）与 run B（失败）。
 * - P1 R07＋4.1：全局栏新建／录制／设置入口可达；视图切换「运行记录／分支关系」在位；
 *   创建表单初始无红错 → 点确认（尝试核对）→ 就近字段错误出现、零 IPC。
 * - P2 N01/N04（单运行）：DOM 点行定位 run A；全局栏 header 不再渲染完整 ID；
 *   页头 ShortIdLabel 复制回读剪贴板 == 完整 ID + 反馈「已复制完整 ID」。
 * - P3 错误调用：run B 步骤页 DOM 点「LLM 调用」行 → 选中失败 span、错误详情可见。
 * - P4 编辑（中文/日文/修订/目标）：run A 首个 LLM 调用 prompt fork 编辑器，
 *   system_prompt 写中文、user_message 写日文（整体替换 + CDP Input.insertText），
 *   store 草稿逐字回读 + revision 推进 + 目标键（run|span|field）正确；
 *   4.3 附带：prompt 编辑器内重复说明只出现一份。
 * - P5 N02 设置／录制往返：设置模态开→关、录制工作区进→返回（restore 实际目的地），
 *   两轮往返后草稿文本与修订逐字不变。
 * - P6 实验工作区（N04 aux / 4.2 / 非法 JSON / N01 编辑器）：targetLine 父本完整 ID
 *   可复制；默认双臂与父相同 ⇒ 批次 blocked；臂 A params 写非法 JSON ⇒
 *   臂级就近错误（data-ab-arm-error）+ 输入逐字保留；侧栏改选 run B ⇒
 *   父本身份仍 run A（不冒充）；返回按钮显实际目的地并恢复 run A 阅读。
 * - P7 N03 来源失效：Page.reload 后录制工作区返回入口进入 fallback——
 *   真实失效原因 + 「回到运行记录」可用退路，点击真的回运行记录。
 *
 * 证据纪律：
 * - CDP 一律走 harness（node:http / makeDialogSession）；mock 由本进程起停。
 * - 草稿写入**不信任写本身**：一律回读 store 判定（proxy-51 纪律）。
 * - reload 带**文档哨兵**（U4 6.6：偶发不换文档会全程假绿）。
 * - settings.json 先备份后逐字节还原（dev 数据目录是用户真实数据）。
 *
 * 用法：node apps/desktop/scripts/refine-51-cdp.cjs
 * 前置：dev 已带 CDP 9612 启动（后台托管）；端口 18799 空闲。
 */
"use strict";

const { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");
const { listPageTarget } = require("./editor-collapse-probe.cjs");

// 本探针的 H.ev 表达式**全部**返回 JSON.stringify 字符串 ⇒ 包一层自动解析。
// ⚠️ 返回值两族别混用（U7 6.4 教训）：storeQ 已是解析对象（不能再 parse），
// H.ev 是字符串（必须 parse）。非 JSON 字符串（如 'clicked'）原样透传。
const _rawEv = H.ev;
H.ev = async (call, expression) => {
  const v = await _rawEv(call, expression);
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
};

const ROOT = join(H.REPO, ".workbuddy", "refine-ui", "5x");
const SHOTS = join(ROOT, "shots");
mkdirSync(SHOTS, { recursive: true });

const TAG = "r51";
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
function note(text) {
  console.log(`ℹ ${text}`);
  checks.push({ tag: TAG, name: `[登记] ${text}`, ok: true, note: true });
}
function finish(extra = {}) {
  const failed = checks.filter((c) => !c.ok && !c.note);
  writeFileSync(
    join(ROOT, `${TAG}-measurements.json`),
    `${JSON.stringify({ tag: TAG, ...extra, checks, failed: failed.length, dump }, null, 2)}\n`,
    "utf8",
  );
  console.log(`检查 ${checks.filter((c) => !c.note).length} 条，失败 ${failed.length} 条`);
  clearTimeout(watchdog);
  process.exit(failed.length === 0 ? 0 : 1);
}
const watchdog = setTimeout(() => {
  console.error(`看门狗：${TAG} 超过 14 分钟未收尾`);
  writeFileSync(join(ROOT, `${TAG}-error.txt`), "watchdog timeout");
  process.exit(3);
}, 840_000);

// ---------------------------------------------------------------------------
// 通道小件
// ---------------------------------------------------------------------------

/** awaitPromise 版页内求值（异步 IIFE 取值） */
const evAwait = async (call, expression) => {
  const r = await call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r?.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`evAwait: ${d.exception?.description ?? d.text}`);
  }
  return r?.result?.value;
};

async function shot(call, name) {
  const file = await H.shot(call, SHOTS, `${TAG}-${name}.png`).catch((e) => String(e));
  console.log(`  [截图] ${file}`);
  return file;
}

function freshId() {
  return `00000000-0000-4000-8000-${String(Date.now() % 1_000_000_000).padStart(12, "0")}`;
}

/** 直调 IPC 创建 run 并等登记收口（main registry 是身份真源） */
async function createRunSettled(call, epoch, request) {
  const operationId = freshId();
  const env = await H.apiCall(call, "createRun", {
    operation: { epoch, operationId },
    request,
  });
  const deadline = Date.now() + 60000;
  for (;;) {
    const st = await H.apiCall(call, "operationsStatus");
    const ops = st.ok && st.data && Array.isArray(st.data.operations) ? st.data.operations : [];
    const rec = ops.find((o) => o.operationId === operationId);
    if (rec && rec.state === "settled" && Array.isArray(rec.runIds) && rec.runIds.length >= 1) {
      return { operationId, runId: rec.runIds[0], env, rec };
    }
    if (Date.now() > deadline) return { operationId, runId: null, env, rec: rec ?? null };
    await H.sleep(500);
  }
}

function readRunFile(runId) {
  const lines = readFileSync(join(H.TRACES, `${runId}.jsonl`), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return {
    meta: lines[0],
    llms: lines.filter((o) => o.kind === "llm.call"),
    terminal: lines[lines.length - 1],
  };
}

/** store 草稿读取（单字段）：text / revision / baseline 长度 */
const draftOf = (call, runId, spanId, field) =>
  H.storeQ(
    call,
    `const c = s.drafts.calls || {};
     const e = (c[${JSON.stringify(runId)}] || {})[${JSON.stringify(spanId)}] || {};
     const d = e[${JSON.stringify(field)}];
     return JSON.stringify(d === undefined || d === null ? null :
       { text: d.text, revision: d.revision, baselineLen: (d.baseline ?? "").length });`,
  );

/** 页内点按钮（文本精确/包含均可），返回是否点到 */
const clickButtonByText = async (call, text, { exact = true, scopedHeader = true } = {}) => {
  const r = await H.ev(
    call,
    `(() => {
       const wanted = ${JSON.stringify(text)};
       const b = Array.from(document.querySelectorAll('button')).find(x => {
         const t = ((x.textContent || '').trim());
         if (${exact ? "t !== wanted" : "!t.includes(wanted)"}) return false;
         if (${scopedHeader} && x.closest('header') !== null) return false;
         return x.offsetParent !== null;
       });
       if (b === undefined || b === null) return 'no-button';
       if (b.disabled) return 'disabled';
       b.click(); return 'clicked';
     })()`,
  );
  return r;
};

/** 剪贴板回读（3s 限时：权限未决时 readText 永不 resolve —— U6 6.8 坑） */
async function readClipboard(call) {
  const raw = await evAwait(
    call,
    `(async () => {
       try {
         const t = await Promise.race([
           navigator.clipboard.readText(),
           new Promise((_, rej) => setTimeout(() => rej(new Error('clipboard-timeout')), 3000)),
         ]);
         return JSON.stringify({ ok: true, text: t });
       } catch (e) {
         return JSON.stringify({ ok: false, why: String((e && e.message) || e) });
       }
     })()`,
  );
  return JSON.parse(raw);
}

/** 点 ShortIdLabel 复制按钮（aria-label 精确），回读剪贴板并断言 */
async function copyAndVerify(call, ariaLabel, wantId, label) {
  const r = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find(x => (x.getAttribute('aria-label') || '') === ${JSON.stringify(ariaLabel)});
       if (b === null || b === undefined) return 'no-button';
       if (b.disabled) return 'disabled';
       b.click(); return 'clicked'; })()`,
  );
  if (r !== "clicked") return { ok: false, why: r };
  await H.sleep(500);
  const clip = await readClipboard(call);
  const feedback = await H.ev(
    call,
    `(() => {
       const b = Array.from(document.querySelectorAll('button'))
         .find(x => (x.getAttribute('aria-label') || '') === ${JSON.stringify(ariaLabel)});
       if (b === null) return 'no-button';
       const sib = b.parentElement ? b.parentElement.textContent : '';
       return JSON.stringify(sib.includes('已复制完整 ID'));
     })()`,
  );
  return {
    ok: clip.ok === true && clip.text === wantId && feedback === true,
    clip: clip.ok === true ? `len=${clip.text.length}` : clip.why,
    feedback,
  };
}

/** 全局栏 header（含 ReBaseAgent 品牌字的那个 header）读数 */
const globalBarState = (call) =>
  H.ev(
    call,
    `(() => {
       const bars = Array.from(document.querySelectorAll('header'))
         .filter(h => (h.textContent || '').includes('ReBaseAgent'));
       const bar = bars[0] ?? null;
       if (bar === null) return JSON.stringify({ present: false });
       const byText = (t) => {
         const b = Array.from(bar.querySelectorAll('button'))
           .find(x => ((x.textContent || '').trim()) === t);
         return b === undefined ? null : { present: true, disabled: b.disabled === true };
       };
       const toggle = (t) => {
         const b = Array.from(bar.querySelectorAll('button'))
           .find(x => ((x.textContent || '').trim()) === t);
         // ⚠️ 非激活按钮的 aria-pressed 是**缺席**（undefined ⇒ getAttribute 得 null），
         // 不是 "false"——判存在性按按钮本身，激活态单独读。
         return b === undefined ? null : { present: true, pressed: b.getAttribute('aria-pressed') === 'true' };
       };
       const body = (bar.textContent || '').replace(/\\s+/g, ' ');
       return JSON.stringify({
         present: true,
         create: byText('新建运行'),
         record: byText('录制接入'),
         runView: toggle('运行记录'),
         branchView: toggle('分支关系'),
         settingsTitle: Array.from(bar.querySelectorAll('button'))
           .some(x => (x.title || '').includes('配置 LLM 接入')),
         bodyHead: body.slice(0, 160),
       });
     })()`,
  );

/** 等应用活着：root 有内容且 store 可导入（dev 冷启动时 vite 首轮构建可能数十秒） */
async function waitAppAlive(call, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const alive = await H.ev(
        call,
        `(() => JSON.stringify({
           root: (document.getElementById('root')?.innerHTML.length ?? 0) > 1000,
         }))()`,
      );
      if (alive.root === true) {
        const n = await H.storeQ(call, "return JSON.stringify({ ok: true });");
        if (n && n.ok === true) return true;
      }
    } catch {
      /* 模块图还在加载 */
    }
    if (Date.now() > deadline) return false;
    await H.sleep(600);
  }
}

/** 带「文档哨兵」的 reload（U4 6.6：reload 偶发不换文档 ⇒ 全程假绿） */
async function reloadVerified(call) {
  if (!(await waitAppAlive(call))) {
    throw new Error("应用 90s 未就绪（root 空 / store 不可导入）");
  }
  const sentinel = `r51-${Date.now()}`;
  await H.ev(call, `window.__r51Doc = ${JSON.stringify(sentinel)}; "ok"`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await call("Page.reload", { ignoreCache: false });
    const deadline = Date.now() + 45000;
    for (;;) {
      let doc = sentinel;
      let ready = false;
      try {
        doc = await H.ev(call, "window.__r51Doc ?? null");
        if (doc !== sentinel) {
          // ⚠️ storeQ 返回的是**已解析对象**（再 JSON.parse 会抛 "[object Object]"）
          const n = await H.storeQ(call, "return JSON.stringify({ runs: s.runs.length });");
          ready = n.runs > 0;
        }
      } catch {
        /* 重载瞬间 */
      }
      if (doc !== sentinel && ready) return true;
      if (Date.now() > deadline) break;
      await H.sleep(400);
    }
    // 现场采样：失败瞬间到底卡在哪一环
    try {
      const probe = await H.ev(
        call,
        `(() => JSON.stringify({
           doc: window.__r51Doc ?? null,
           bodyLen: document.body.textContent.length,
           rootLen: document.getElementById('root')?.innerHTML.length ?? -1,
         }))()`,
      );
      let runs = "<storeQ-fail>";
      try {
        runs = JSON.stringify(
          await H.storeQ(call, "return JSON.stringify({ runs: s.runs.length });"),
        );
      } catch (e) {
        runs = `ERR:${String(e).slice(0, 120)}`;
      }
      console.log(`  [reload@${attempt}] probe=${JSON.stringify(probe)} store=${runs}`);
    } catch (e) {
      console.log(`  [reload@${attempt}] 采样失败：${String(e).slice(0, 120)}`);
    }
    console.log(`  [reload] 第 ${attempt} 次未换文档或未就绪，重试`);
    await waitAppAlive(call);
  }
  throw new Error("reload 三次均未换文档（U4 6.6 已知坑，重试仍失败）");
}

// ---------------------------------------------------------------------------
// Monaco 写入（整体替换 + CDP Input.insertText，写后回读 store 判定）
// ---------------------------------------------------------------------------

/**
 * 按 data-monaco-target 精确寻址草稿编辑器并整体替换。
 * ⚠️ 不能按「可见可编辑实例序号」猜：DetailPanel 同时挂 original/draft（各 system+user）
 * 多个编辑器，序号在两字段间会漂移；草稿编辑器自带
 * `data-monaco-host="prompt-draft"` + `data-monaco-target="runId:spanId:field"`。
 */
async function monacoReplaceByTarget(call, runId, spanId, field, text) {
  const selector = `[data-monaco-host="prompt-draft"][data-monaco-target="${runId}:${spanId}:${field}"]`;
  // 编辑器实例在 ensureMonaco 之后由 React 包装层异步创建 ⇒ 轮询至目标出现
  const deadline = Date.now() + 15000;
  let prep = null;
  for (;;) {
    prep = await H.appImport(
      call,
      H.MONACO_NEEDLE,
      `const monaco = await m.ensureMonaco();
       const host = document.querySelector(${JSON.stringify(selector)});
       if (host === null) return JSON.stringify({ ok: false, why: 'no-host', total: monaco.editor.getEditors().length });
       const ed = monaco.editor.getEditors().find(e => e.getDomNode() !== null && host.contains(e.getDomNode()));
       if (ed === undefined) return JSON.stringify({ ok: false, why: 'no-editor-for-host' });
       if (ed.getOption(monaco.editor.EditorOption.readOnly) === true) return JSON.stringify({ ok: false, why: 'read-only' });
       ed.focus();
       ed.setSelection(ed.getModel().getFullModelRange());
       return JSON.stringify({ ok: true, focused: document.activeElement !== null });`,
    );
    if (prep.ok === true) break;
    if (Date.now() > deadline) return prep;
    await H.sleep(600);
  }
  if (prep.focused !== true) {
    console.log(
      "  [warn] monaco 焦点回读未确认（activeElement 不在编辑器内），继续尝试 insertText",
    );
  }
  await call("Input.insertText", { text });
  await H.sleep(700);
  return prep;
}

/**
 * 写 prompt 草稿：整体替换 → 回读 store 逐字判定（不信任写本身，proxy-51 纪律）。
 * 返回写前/写后 revision（调用方判相对推进）；寻址唯一 ⇒ 无重试污染。
 */
async function writePromptDraft(call, runId, spanId, field, text) {
  const before = await draftOf(call, runId, spanId, field);
  const prep = await monacoReplaceByTarget(call, runId, spanId, field, text);
  if (prep.ok !== true) {
    throw new Error(`草稿编辑器寻址失败（field=${field}）：${JSON.stringify(prep)}`);
  }
  await H.sleep(400);
  const got = await draftOf(call, runId, spanId, field);
  if (got === null || got.text !== text) {
    throw new Error(
      `草稿未落 store（field=${field}）：before=${JSON.stringify(before)} after=${JSON.stringify(got)}`,
    );
  }
  return { ok: true, revBefore: before === null ? null : before.revision, revision: got.revision };
}

// ---------------------------------------------------------------------------

async function main() {
  // settings 备份（dev 数据目录是用户真实数据；收尾逐字节还原）
  const settingsBackup = existsSync(H.SETTINGS_FILE) ? readFileSync(H.SETTINGS_FILE, "utf8") : null;
  let mock = null;

  async function runInner() {
    const page = await listPageTarget(H.CDP_PORT);
    const call = await H.makeDialogSession(page.webSocketDebuggerUrl);
    await call("Page.enable");
    await call("Runtime.enable");
    await call("Page.bringToFront").catch(() => {});
    await call("Emulation.clearDeviceMetricsOverride").catch(() => {});

    // 开局哨兵 reload（U4 6.6 纪律）：上一轮探针/崩溃/HMR 残局一概不继承——
    // ⚠️ 尤其是 vite HMR 会让 appImport 摸到旧模块副本（DOM 与 store 分裂的假象源）
    await reloadVerified(call);

    // ── P0 准备 ────────────────────────────────────────────────────────────
    mock = await H.startMockLlmServer({
      port: H.MOCK_PORT,
      script: [{ content: "受控响应A：本轮结束。" }],
    });
    await H.apiCall(call, "proxyToggle", {
      enabled: false,
      port: H.PROXY_PORT,
      upstreamBaseUrl: H.MOCK_UPSTREAM,
    });
    await H.apiCall(call, "clearSettings");
    await H.apiCall(call, "saveSettings", {
      baseURL: H.MOCK_BASE,
      apiKey: "sk-r51-controlled",
      model: "mock-model",
    });
    await H.storeQ(call, "await s.loadSettings(); return JSON.stringify({ ok: true });");
    const epochEnv = await H.apiCall(call, "operationsStatus");
    if (!epochEnv.ok) throw new Error(`operationsStatus 失败：${JSON.stringify(epochEnv.error)}`);
    const epoch = epochEnv.data.epoch;
    dump.epoch = epoch;

    // run A：正常对话（有 system prompt ⇒ prompt fork 可用）
    const a = await createRunSettled(call, epoch, {
      systemPrompt: "你是受控助手，只回答一句话。",
      userMessage: "refine-51 定位冒烟：说「好」。",
    });
    if (a.runId === null)
      throw new Error(`run A 创建未收口：${JSON.stringify(a.env).slice(0, 200)}`);
    dump.runA = a.runId;
    const runA = readRunFile(a.runId);
    check(
      "P0 run A 落盘：正常终态 + 首个 LLM 调用在盘（后续定位/编辑的标的）",
      runA.terminal.event === "stopped" &&
        runA.terminal.reason === "completed" &&
        runA.llms.length === 1,
      {
        id: a.runId,
        terminal: `${runA.terminal.event}/${runA.terminal.reason}`,
        llms: runA.llms.length,
      },
    );
    const spanA = runA.llms[0].id;
    dump.spanA = spanA;

    // run B：失败（错误调用的标的）
    await mock.reset({
      turns: [
        {
          mode: "fail",
          status: 500,
          errorBody: { error: { message: "受控失败：目标模型暂不可用" } },
        },
      ],
      fallback: { mode: "fail", status: 500 },
    });
    const b = await createRunSettled(call, epoch, {
      systemPrompt: "你是受控助手。",
      userMessage: "refine-51 失败冒烟：随便说点什么都到不了。",
    });
    if (b.runId === null)
      throw new Error(`run B 创建未收口：${JSON.stringify(b.env).slice(0, 200)}`);
    dump.runB = b.runId;
    const runB = readRunFile(b.runId);
    check(
      "P0 run B 落盘：llm.call 带 error + 终态 errored（错误调用标的成立）",
      runB.llms.length === 1 && runB.llms[0].error != null && runB.terminal.reason === "error",
      {
        id: b.runId,
        errorStatus: runB.llms[0]?.error?.status,
        terminal: `${runB.terminal.event}/${runB.terminal.reason}`,
      },
    );
    const spanB = runB.llms[0].id;
    dump.spanB = spanB;

    // 列表就绪（读 store，不读 DOM——200%/窄档下行不在 DOM 的教训）
    await H.storeQ(call, "await s.loadRuns(); return JSON.stringify('ok');");
    const listed = await H.storeQ(
      call,
      `return JSON.stringify({ n: s.runs.length,
         hasA: s.runs.some(r => r.id === ${JSON.stringify(a.runId)}),
         hasB: s.runs.some(r => r.id === ${JSON.stringify(b.runId)}) });`,
    );
    check("P0 运行列表就绪：A/B 都在列表", listed.hasA === true && listed.hasB === true, listed);

    // ── P1 R07：全局入口可达 + 4.1 创建表单分层 ─────────────────────────────
    const bar = await globalBarState(call);
    check(
      "R07 全局入口：新建／录制／设置（配置 LLM 接入）三入口在位且可用",
      bar.present === true &&
        bar.create?.present === true &&
        bar.create.disabled === false &&
        bar.record?.present === true &&
        bar.record.disabled === false &&
        bar.settingsTitle === true,
      bar,
    );
    check(
      "R07 视图切换：「运行记录」「分支关系」两标签在位（aria-pressed 单选态）",
      bar.runView !== null &&
        bar.branchView !== null &&
        bar.runView.present === true &&
        bar.branchView.present === true &&
        [bar.runView.pressed, bar.branchView.pressed].filter((v) => v === true).length === 1,
      { runView: bar.runView, branchView: bar.branchView },
    );

    // 打开创建工作区（DOM 点真实入口）
    const openCreate = await clickButtonByText(call, "新建运行", { scopedHeader: false });
    if (openCreate !== "clicked") throw new Error(`点「新建运行」失败：${openCreate}`);
    await H.sleep(1200);
    const createView = await H.storeQ(call, "return JSON.stringify({ view: s.view });");
    check(
      "R07 创建入口可用：点「新建运行」进入创建工作区",
      createView.view === "create",
      createView,
    );

    // 4.1：初始空表单无红错
    const initialErrors = await H.ev(
      call,
      `(() => JSON.stringify({
         fieldErrors: Array.from(document.querySelectorAll('p.text-red-700')).map(p => (p.textContent||'').trim().slice(0,80)),
         confirmButtons: Array.from(document.querySelectorAll('button'))
           .filter(b => ((b.textContent||'').trim()) === '已核对，确认本次提交')
           .map(b => ({ disabled: b.disabled })),
       }))()`,
    );
    check(
      "N12(4.1) 初始空表单：无就近红色字段错误（不铺满必填红错）",
      initialErrors.fieldErrors.length === 0,
      initialErrors.fieldErrors,
    );
    check(
      "N12(4.1) 确认按钮输入缺项时不禁用（点击即「尝试核对」）",
      initialErrors.confirmButtons.length === 1 &&
        initialErrors.confirmButtons[0].disabled === false,
      initialErrors.confirmButtons,
    );

    // 点确认 = 尝试核对：就近错误出现 + 零 IPC（mock served 不增、无新登记、creating 不在飞）
    const servedBefore = mock.served();
    const opsBeforeCreate = await H.storeQ(
      call,
      `return JSON.stringify({ n: s.operations.operations.filter(o => o.target && o.target.kind === 'create').length,
         creating: s.creatingRun });`,
    );
    const clickConfirm = await H.ev(
      call,
      `(() => {
         const dlg = document.querySelector('dialog[open]');
         const scope = dlg ?? document;
         const b = Array.from(scope.querySelectorAll('button'))
           .find(x => ((x.textContent||'').trim()) === '已核对，确认本次提交');
         if (b === undefined) return 'no-button';
         if (b.disabled) return 'disabled';
         b.click(); return 'clicked';
       })()`,
    );
    await H.sleep(900);
    const afterErrors = await H.ev(
      call,
      `(() => JSON.stringify({
         fieldErrors: Array.from(document.querySelectorAll('p.text-red-700')).map(p => (p.textContent||'').trim().slice(0,80)),
       }))()`,
    );
    const opsAfterCreate = await H.storeQ(
      call,
      `return JSON.stringify({ n: s.operations.operations.filter(o => o.target && o.target.kind === 'create').length,
         creating: s.creatingRun });`,
    );
    check(
      "N12(4.1) 尝试核对后就近错误出现（必填项逐字可读，不只靠颜色）",
      clickConfirm === "clicked" && afterErrors.fieldErrors.length > 0,
      { click: clickConfirm, errors: afterErrors.fieldErrors },
    );
    check(
      "N12(4.1) 尝试核对零 IPC：无登记新增、无在飞、上游零调用",
      opsAfterCreate.n === opsBeforeCreate.n &&
        opsAfterCreate.creating !== "in_progress" &&
        mock.served() === servedBefore,
      { servedBefore, servedAfter: mock.served(), ops: opsAfterCreate },
    );
    await shot(call, "01-create-attempt");
    // 回运行记录视图（创建草稿保留，属会话事实；5.3 再处置）
    await H.storeQ(call, `s.setView("trace"); return JSON.stringify("ok");`);
    await H.sleep(800);

    // ── P2 N01/N04（单运行对象头）───────────────────────────────────────────
    await H.selectRun(call, a.runId);
    await H.sleep(600);
    const barAfterSelect = await globalBarState(call);
    const headerHasFullId = await H.ev(
      call,
      `(() => {
         const bars = Array.from(document.querySelectorAll('header'))
           .filter(h => (h.textContent || '').includes('ReBaseAgent'));
         const bar = bars[0] ?? null;
         if (bar === null) return 'no-bar';
         return (bar.textContent || '').includes(${JSON.stringify(a.runId)}) ||
                (bar.innerHTML || '').includes(${JSON.stringify(a.runId)});
       })()`,
    );
    check(
      "N01 全局栏不再冒充对象身份：选中 run A 后 header 不渲染其完整 ID",
      headerHasFullId === false,
      { headerHasFullId },
    );

    const headerCopy = await copyAndVerify(call, `复制完整 运行 ID ${a.runId}`, a.runId, "页头");
    check(
      "N04 页头完整 ID 可复制：剪贴板回读 == 完整原始 ID + 「已复制完整 ID」反馈",
      headerCopy.ok === true,
      headerCopy,
    );
    const headerMeta = await H.ev(
      call,
      `(() => {
         const t = document.body.textContent || '';
         const idLabel = Array.from(document.querySelectorAll('button'))
           .some(b => (b.getAttribute('aria-label') || '').startsWith('复制完整 运行 ID '));
         return JSON.stringify({
           task: t.includes('refine-51 定位冒烟'),
           // 「运行 ID」字样在 aria-label/title（ShortIdLabel 的可访问名），不在 textContent
           shortLabel: idLabel,
         });
       })()`,
    );
    check(
      "N01 对象头身份归位：任务名 + 运行 ID 复制入口在页头（身份由工作区自己呈现）",
      headerMeta.task === true && headerMeta.shortLabel === true,
      headerMeta,
    );
    await shot(call, "02-run-a-header");

    // ── P3 错误调用定位（run B）────────────────────────────────────────────
    await H.storeQ(
      call,
      `await s.selectRun(${JSON.stringify(b.runId)});
       s.setReadingTab(${JSON.stringify(b.runId)}, "steps");
       return JSON.stringify("ok");`,
    );
    await H.sleep(1500);
    // DOM 点行（真实用户路径）：title 恰为「LLM 调用」的行按钮
    const clickRow = await H.ev(
      call,
      `(() => {
         const rows = Array.from(document.querySelectorAll('button'))
           .filter(b => (b.title || '') === 'LLM 调用' && b.closest('header') === null && b.offsetParent !== null);
         if (rows.length === 0) return 'no-row';
         rows[0].click(); return 'clicked';
       })()`,
    );
    await H.sleep(1400);
    const selB = await H.storeQ(call, "return JSON.stringify({ sel: s.selectedSpanId });");
    check(
      "P3 错误调用定位：DOM 点「LLM 调用」行 ⇒ 失败 span 真被选中",
      clickRow === "clicked" && selB.sel === spanB,
      { click: clickRow, sel: selB.sel, want: spanB },
    );
    const errVisible = await H.ev(
      call,
      `(() => { const t = document.body.textContent || '';
         return JSON.stringify({ msg: t.includes('受控失败'), status: t.includes('500') }); })()`,
    );
    check(
      "P3 错误详情可读：受控失败摘要 + 真实状态码在调用详情",
      errVisible.msg === true && errVisible.status === true,
      errVisible,
    );
    await shot(call, "03-error-call");

    // ── P4 编辑：中文／日文／修订／目标 ─────────────────────────────────────
    await H.storeQ(
      call,
      `await s.selectRun(${JSON.stringify(a.runId)});
       s.setReadingTab(${JSON.stringify(a.runId)}, "steps");
       s.selectSpan(${JSON.stringify(spanA)});
       return JSON.stringify("ok");`,
    );
    await H.sleep(1600);
    const openPrompt = await clickButtonByText(call, "编辑 system prompt 重跑");
    if (openPrompt !== "clicked") throw new Error(`打开 prompt 编辑器失败：${openPrompt}`);
    await H.sleep(1500);

    const zh = "你是一丝不苟的受控助手。中文校验①：冒号、引号「」、省略号……都要逐字保留。";
    const wroteZh = await writePromptDraft(call, a.runId, spanA, "system_prompt", zh);
    check(
      "P4 中文逐字入草稿：store 回读与输入逐字一致（revision 自写前推进）",
      wroteZh.ok === true &&
        (wroteZh.revBefore === null ? wroteZh.revision >= 1 : wroteZh.revision > wroteZh.revBefore),
      { revBefore: wroteZh.revBefore, revision: wroteZh.revision },
    );

    const openUser = await clickButtonByText(call, "首条 user message");
    if (openUser !== "clicked") throw new Error(`切 user_message 失败：${openUser}`);
    await H.sleep(1200);
    const ja = "これは日本語検証②です。句読点（、。長音ー）もそのまま保持されます。";
    const wroteJa = await writePromptDraft(call, a.runId, spanA, "user_message", ja);
    check(
      "P4 日文逐字入草稿：user_message 回读逐字一致（revision 自写前推进）",
      wroteJa.ok === true &&
        (wroteJa.revBefore === null ? wroteJa.revision >= 1 : wroteJa.revision > wroteJa.revBefore),
      { revBefore: wroteJa.revBefore, revision: wroteJa.revision },
    );

    // 目标键核对：草稿只挂在 run A 的该 span 上，run B 无草稿
    const targetKeys = await H.storeQ(
      call,
      `const c = s.drafts.calls || {};
       return JSON.stringify({
         a: Object.keys(c[${JSON.stringify(a.runId)}] || {}),
         b: Object.keys(c[${JSON.stringify(b.runId)}] || {}),
       });`,
    );
    check(
      "P4 草稿目标正确：挂在 run A 的首个 LLM span 上；run B 无草稿",
      JSON.stringify(targetKeys.a) === JSON.stringify([spanA]) &&
        targetKeys.a.length === 1 &&
        targetKeys.b.length === 0,
      { want: [spanA], got: targetKeys },
    );

    // 修订推进：整篇替换第二稿 ⇒ revision 严格推进（增量是输入方式伪影——
    // EditContext 全选替换会拆成多个 change 事件；产品语义是「按实际变化推进」+ 逐字无损）
    const backZh = await clickButtonByText(call, "system prompt");
    if (backZh !== "clicked") throw new Error(`切回 system_prompt 失败：${backZh}`);
    await H.sleep(1000);
    const zh2 = `${zh}（第二稿：修订推进校验）`;
    const rewrote = await writePromptDraft(call, a.runId, spanA, "system_prompt", zh2);
    check(
      "P4 修订推进：第二稿后 revision 严格推进且文本逐字为第二稿",
      rewrote.revision > wroteZh.revision,
      { firstDraft: wroteZh.revision, secondDraft: rewrote.revision },
    );

    // 4.3：prompt 编辑器说明去重——「从头重跑计费」只出现一份
    const dedupe = await H.ev(
      call,
      `(() => {
         const t = document.body.textContent || '';
         const count = (s) => t.split(s).length - 1;
         return JSON.stringify({
           summaryCount: count('从头重跑计费'),
           replacedFieldCount: count('编辑值替换字段'),
         });
       })()`,
    );
    check(
      "4.3 说明去重：计费/替换类重复说明在 prompt 编辑器各只出现一份",
      dedupe.summaryCount <= 1 && dedupe.replacedFieldCount <= 1,
      dedupe,
    );
    await shot(call, "04-prompt-drafts");

    // ── P5 N02 设置／录制往返 ──────────────────────────────────────────────
    const draftsSnapshot = async () =>
      H.storeQ(
        call,
        `const c = s.drafts.calls || {};
         const e = (c[${JSON.stringify(a.runId)}] || {})[${JSON.stringify(spanA)}] || {};
         return JSON.stringify({
           zh: e.system_prompt ? e.system_prompt.text : null,
           zhRev: e.system_prompt ? e.system_prompt.revision : null,
           ja: e.user_message ? e.user_message.text : null,
           jaRev: e.user_message ? e.user_message.revision : null,
         });`,
      );
    const beforeSettings = await draftsSnapshot();

    // 打开设置模态（真实入口按钮）
    const openSettings = await H.ev(
      call,
      `(() => { const b = Array.from(document.querySelectorAll('button'))
          .find(x => (x.title || '').includes('配置 LLM 接入') && x.offsetParent !== null);
         if (b === undefined || b === null) return 'no-button';
         if (b.disabled) return 'disabled';
         b.click(); return 'clicked'; })()`,
    );
    await H.sleep(1200);
    const dialogOpen = await H.ev(
      call,
      `JSON.stringify(document.querySelector('dialog[open]') !== null)`,
    );
    check(
      "N02 设置模态真实打开（编辑器在场时）",
      openSettings === "clicked" && dialogOpen === true,
      {
        openSettings,
        dialogOpen,
      },
    );
    const duringSettings = await draftsSnapshot();
    check(
      "N02 设置往返·进：模态打开不碰草稿（中文/日文文本与修订逐字不变）",
      JSON.stringify(duringSettings) === JSON.stringify(beforeSettings),
      { during: duringSettings },
    );
    // 关闭：合成 Esc（ModalDialog 捕获段合成关闭——第任意次成立）
    await H.ev(
      call,
      `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return "ok"; })()`,
    );
    await H.sleep(700);
    const dialogGone = await H.ev(
      call,
      `JSON.stringify(document.querySelector('dialog[open]') === null)`,
    );
    const afterSettings = await draftsSnapshot();
    check(
      "N02 设置往返·出：模态关闭且草稿逐字不变",
      dialogGone === true && JSON.stringify(afterSettings) === JSON.stringify(beforeSettings),
      { dialogGone, after: afterSettings },
    );
    await shot(call, "05-settings-roundtrip");

    // 录制工作区往返（restore 路径：来源=run A 步骤页）
    await H.storeQ(call, `s.openRecordingWorkspace(); return JSON.stringify("ok");`);
    await H.sleep(1500);
    const recState = await H.ev(
      call,
      `(() => {
         const frame = document.querySelector('[data-aux-frame="true"]');
         const ret = Array.from(document.querySelectorAll('button'))
           .find(b => (b.getAttribute('aria-label') || '').startsWith('返回'));
         return JSON.stringify({
           frame: frame !== null,
           returnLabel: ret === null || ret === undefined ? null : (ret.getAttribute('aria-label') || ''),
           returnDisabled: ret == null ? null : ret.disabled,
         });
       })()`,
    );
    check(
      "N02 录制工作区返回入口显实际目的地（restore：返回运行记录…）",
      recState.frame === true &&
        typeof recState.returnLabel === "string" &&
        recState.returnLabel.startsWith("返回") &&
        recState.returnDisabled === false,
      recState,
    );
    const duringRec = await draftsSnapshot();
    check(
      "N02 录制往返·进：录制页不碰草稿",
      JSON.stringify(duringRec) === JSON.stringify(beforeSettings),
      {
        during: duringRec,
      },
    );
    const clickReturn = await H.ev(
      call,
      `(() => { const b = Array.from(document.querySelectorAll('button'))
          .find(x => (x.getAttribute('aria-label') || '').startsWith('返回') && !x.disabled && x.offsetParent !== null);
         if (b === undefined || b === null) return 'no-button';
         b.click(); return 'clicked'; })()`,
    );
    await H.sleep(1400);
    const afterReturn = await H.storeQ(
      call,
      `const reading = s.readingByRun && s.readingByRun[${JSON.stringify(a.runId)}];
       return JSON.stringify({ view: s.view, sel: s.selectedRunId, tab: reading ? reading.tab : null });`,
    );
    const afterRecReturn = await draftsSnapshot();
    check(
      "N02 录制往返·出：返回到 run A 的来源阅读位置（tab=steps），草稿逐字不变",
      clickReturn === "clicked" &&
        afterReturn.view === "trace" &&
        afterReturn.sel === a.runId &&
        afterReturn.tab === "steps" &&
        JSON.stringify(afterRecReturn) === JSON.stringify(beforeSettings),
      {
        click: clickReturn,
        nav: afterReturn,
        draftSame: JSON.stringify(afterRecReturn) === JSON.stringify(beforeSettings),
      },
    );
    await shot(call, "06-recording-roundtrip");

    // ── P6 实验工作区（N04 aux / 4.2 / 非法 JSON / N01 编辑器）──────────────
    const openExp = await clickButtonByText(call, "模型实验", { exact: false });
    if (openExp !== "clicked") throw new Error(`打开实验工作区失败：${openExp}`);
    await H.sleep(1800);
    const expState = await H.ev(
      call,
      `(() => {
         const frame = document.querySelector('[data-aux-frame="true"]');
         if (frame === null) return JSON.stringify({ frame: false });
         const t = (frame.textContent || '').replace(/\\s+/g, ' ');
         const targetCopy = Array.from(frame.querySelectorAll('button'))
           .find(b => (b.getAttribute('aria-label') || '') === '复制完整 父本运行 ID ' + ${JSON.stringify(a.runId)});
         const ret = Array.from(frame.querySelectorAll('button'))
           .find(b => (b.getAttribute('aria-label') || '').startsWith('返回'));
         return JSON.stringify({
           frame: true,
           hasParent: t.includes('父本'),
           hasSpan: t.includes(${JSON.stringify(spanA)}),
           targetCopyPresent: targetCopy != null,
           returnLabel: ret == null ? null : (ret.getAttribute('aria-label') || ''),
         });
       })()`,
    );
    check(
      "P6 实验对象头：targetLine 父本 + 首次模型调用 span 在场，返回入口在位",
      expState.frame === true &&
        expState.hasParent === true &&
        expState.hasSpan === true &&
        typeof expState.returnLabel === "string" &&
        expState.returnLabel.startsWith("返回"),
      expState,
    );
    const expCopy = await copyAndVerify(
      call,
      `复制完整 父本运行 ID ${a.runId}`,
      a.runId,
      "实验对象头",
    );
    check(
      "N04 实验对象头完整 ID 可复制：剪贴板回读 == 父本完整原始 ID",
      expCopy.ok === true,
      expCopy,
    );

    // 默认双臂（与父相同）⇒ 批次 blocked；臂级就近标记在场（4.2）
    await H.sleep(800);
    const guardDefault = await H.ev(
      call,
      `(() => {
         const frame = document.querySelector('[data-aux-frame="true"]');
         const t = (frame ? frame.textContent : document.body.textContent) || '';
         const armErr = Array.from(document.querySelectorAll('[data-ab-arm-error]'))
           .map(x => ({ idx: x.getAttribute('data-ab-arm-error'), text: ((x.textContent||'').trim()).slice(0,120) }));
         return JSON.stringify({
           sameAsParent: t.includes('与父 run 完全相同'),
           armErr,
         });
       })()`,
    );
    check(
      "4.2 默认双臂即与父相同：批次级 blocked 原因 + 臂级就近标记（红字跟臂走）",
      guardDefault.sameAsParent === true && guardDefault.armErr.length > 0,
      guardDefault,
    );

    // 非法 JSON：臂 A params 输入非法 JSON ⇒ 臂级「不是合法 JSON」就近错误 + 输入逐字保留
    const badJson = '{"temperature": 0.9,,';
    const paramsFilled = await H.typeIntoDom(call, 'input[placeholder^="采样参数 JSON"]', badJson);
    await H.sleep(900);
    const guardBad = await H.ev(
      call,
      `(() => {
         const items = Array.from(document.querySelectorAll('[data-ab-arm-error]'))
           .map(x => ({ idx: x.getAttribute('data-ab-arm-error'), text: ((x.textContent||'').trim()) }));
         const input = document.querySelector('input[placeholder^="采样参数 JSON"]');
         return JSON.stringify({ items, inputValue: input === null ? null : input.value });
       })()`,
    );
    check(
      "P6 非法 JSON 臂级就近错误：guard 标「不是合法 JSON」且输入逐字保留（不吞不改）",
      guardBad.items.some((x) => x.text.includes("不是合法 JSON")) &&
        guardBad.inputValue === badJson,
      { items: guardBad.items, value: guardBad.inputValue },
    );
    await shot(call, "07-experiment-guard");

    // N02 实验返回（先于侧栏改选——离开页面前核对 restore 路径）
    const expReturnLabel = await H.ev(
      call,
      `(() => { const frame = document.querySelector('[data-aux-frame="true"]');
         if (frame === null) return null;
         const b = Array.from(frame.querySelectorAll('button'))
           .find(x => (x.getAttribute('aria-label') || '').startsWith('返回') && !x.disabled);
         return b === undefined ? null : (b.getAttribute('aria-label') || ''); })()`,
    );
    const clickExpReturn = await H.ev(
      call,
      `(() => { const frame = document.querySelector('[data-aux-frame="true"]');
         if (frame === null) return 'no-frame';
         const b = Array.from(frame.querySelectorAll('button'))
           .find(x => (x.getAttribute('aria-label') || '').startsWith('返回') && !x.disabled && x.offsetParent !== null);
         if (b === undefined) return 'no-button';
         b.click(); return 'clicked'; })()`,
    );
    await H.sleep(1500);
    const backFromExp = await H.storeQ(
      call,
      `const reading = s.readingByRun && s.readingByRun[${JSON.stringify(a.runId)}];
       return JSON.stringify({ view: s.view, sel: s.selectedRunId, tab: reading ? reading.tab : null });`,
    );
    check(
      "N02 实验返回：入口显实际目的地且点击恢复 run A 的来源阅读位置（tab=steps）",
      typeof expReturnLabel === "string" &&
        expReturnLabel.startsWith("返回") &&
        clickExpReturn === "clicked" &&
        backFromExp.view === "trace" &&
        backFromExp.sel === a.runId &&
        backFromExp.tab === "steps",
      { label: expReturnLabel, click: clickExpReturn, nav: backFromExp },
    );
    await shot(call, "08-experiment-return");

    // N01（编辑器面，U8 1.3 既有口径）：侧栏选择离开辅助页（view 回 trace），
    // 但**显式目标不被侧栏替换**——experimentTarget 仍指向 run A
    await H.storeQ(
      call,
      `await s.selectRun(${JSON.stringify(b.runId)}); return JSON.stringify("ok");`,
    );
    await H.sleep(1200);
    const afterSidebar = await H.storeQ(
      call,
      `return JSON.stringify({
         view: s.view, sel: s.selectedRunId,
         expTarget: s.experimentTarget === null ? null : s.experimentTarget.runId,
       });`,
    );
    check(
      "N01 侧栏选择不更换实验父本：页面按既有口径回到运行记录，显式目标仍是 run A（不被顶成 run B）",
      afterSidebar.view === "trace" &&
        afterSidebar.sel === b.runId &&
        afterSidebar.expTarget === a.runId,
      afterSidebar,
    );

    // ── P7 N03 来源失效（来源 run 消失 ⇒ fallback 原因 + 退路）──────────────
    // 路径：trace 选中 run B → 打开录制（记录来源=run B 阅读）→ 删除 run B 的
    // trace 文件（本探针自产 run）→ loadRuns ⇒ 来源 run 不在列表 → 点返回
    // ⇒ 不冒充 restore：显真实失效原因 + 「回到运行记录」可用退路。
    await H.storeQ(call, `s.openRecordingWorkspace(); return JSON.stringify("ok");`);
    await H.sleep(1500);
    rmSync(join(H.TRACES, `${b.runId}.jsonl`));
    await H.storeQ(call, `await s.loadRuns(); return JSON.stringify("ok");`);
    await H.sleep(1200);
    const gone = await H.storeQ(
      call,
      `return JSON.stringify({ hasB: s.runs.some(r => r.id === ${JSON.stringify(b.runId)}),
         view: s.view });`,
    );
    check(
      "N03 前置：来源 run 已从列表消失且录制页在场",
      gone.hasB === false && gone.view === "recording",
      gone,
    );

    const fallbackState = await H.ev(
      call,
      `(() => {
         const frame = document.querySelector('[data-aux-frame="true"]');
         if (frame === null) return JSON.stringify({ frame: false });
         const backBtn = Array.from(frame.querySelectorAll('button'))
           .find(b => (b.getAttribute('aria-label') || '').startsWith('回到'));
         return JSON.stringify({
           frame: true,
           backBtn: backBtn === undefined ? null : (backBtn.getAttribute('aria-label') || ''),
           backTitle: backBtn === undefined ? null : (backBtn.title || ''),
           text: (frame.textContent || '').replace(/\\s+/g, ' ').slice(0, 260),
         });
       })()`,
    );
    check(
      "N03 来源失效可辨：返回入口不冒充——显真实失效原因与「回到运行记录」退路",
      fallbackState.frame === true &&
        fallbackState.backBtn === "回到运行记录" &&
        typeof fallbackState.backTitle === "string" &&
        fallbackState.backTitle.length > 0,
      fallbackState,
    );
    if (fallbackState.backBtn != null) {
      const clickBack = await H.ev(
        call,
        `(() => { const frame = document.querySelector('[data-aux-frame="true"]');
           const b = Array.from(frame.querySelectorAll('button'))
             .find(x => (x.getAttribute('aria-label') || '').startsWith('回到'));
           if (b === undefined) return 'no-button';
           b.click(); return 'clicked'; })()`,
      );
      await H.sleep(1400);
      const navBack = await H.storeQ(
        call,
        "return JSON.stringify({ view: s.view, sel: s.selectedRunId });",
      );
      check(
        "N03 退路真实可用：点「回到运行记录」真的回运行记录视图",
        clickBack === "clicked" && navBack.view === "trace",
        { click: clickBack, nav: navBack },
      );
    }
    await shot(call, "09-return-fallback");

    // ── 收尾 ───────────────────────────────────────────────────────────────
    dump.traces = { final: H.traceIds().size };
    finish();
  }

  try {
    await runInner();
  } finally {
    // 还原受控面（尽力而为）：代理关、settings 清、mock 关、settings 文件逐字节还原
    try {
      const page = await listPageTarget(H.CDP_PORT);
      const call = await H.makeDialogSession(page.webSocketDebuggerUrl);
      await H.apiCall(call, "proxyToggle", {
        enabled: false,
        port: H.PROXY_PORT,
        upstreamBaseUrl: H.MOCK_UPSTREAM,
      });
      await H.apiCall(call, "clearSettings");
    } catch {
      /* 应用可能已关 */
    }
    try {
      if (mock) await mock.close().catch?.(() => {});
    } catch {
      /* noop */
    }
    try {
      if (settingsBackup === null) {
        if (existsSync(H.SETTINGS_FILE)) rmSync(H.SETTINGS_FILE);
      } else {
        writeFileSync(H.SETTINGS_FILE, settingsBackup, "utf8");
      }
      console.log(
        `settings 还原：${settingsBackup === null ? "（原本不存在，已删除）" : `已还原 ${settingsBackup.length} 字节`}`,
      );
    } catch (e) {
      console.error(`settings 还原失败（需人工核对 ${H.SETTINGS_FILE}）：${String(e)}`);
    }
  }
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  try {
    writeFileSync(join(ROOT, `${TAG}-error.txt`), String(e?.stack ?? e), "utf8");
  } catch {
    /* noop */
  }
  process.exit(1);
});
