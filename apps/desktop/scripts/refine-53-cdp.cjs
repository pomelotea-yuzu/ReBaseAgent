/* eslint-disable */
/**
 * refine-ui-for-community-release 任务 5.3：**Electron 实机验收**。
 *
 * 流程（tasks 5.3 原文）：回归草稿放弃／关闭保护、执行中切页、后台结果及来源失效，
 * 覆盖「统一活动入口沿用既有三类事实」（N08）「活动入口跨页定位结果和失效草稿」（N11）
 * 与既有迟到响应；核对面板关闭时未读及 polite live 不重复播报、模态背景不可交互；
 * 顺带核对 N09（浏览编辑页不冒充修改）与 N10（改回基线与清空保留真实判据）。
 * 不伪造操作事实——操作/结果全部来自真实 IPC 提交与真实执行。
 *
 * 场景分段（单 dev、单 mock、单 tag）：
 * - P0 准备：受控上游 + settings，真实创建 run A（对话）。
 * - P1 N09：打开 prompt 编辑器不输入 ⇒ clean 编辑会话（修改计数 0），
 *   面板 clean 组「未修改的编辑会话」在场（data-draft-clean）且无警告。
 * - P2 N10：写入中文 ⇒ dirty 1；改回基线 ⇒ 恢复 clean（计数 0）；
 *   再写非空后**清空为空串 ⇒ 仍 dirty**（清空保护，基线非空）。
 * - P3 录制并入：录制草稿写 portText ⇒ 修改计数含录制（+「录制配置有未应用的
 *   修改」条目 + 「去录制」动作可达）。
 * - P4 N08 计数一致 + Esc/✕ 关闭：活动条三计数与面板内三节一致；Esc 关闭后
 *   焦点还原触发按钮；✕ 同一关闭动作。
 * - P5 真实执行链（迟到响应 + N11）：prompt fork 提交（确认凭据链）→ 提交瞬间
 *   切页签（编辑器卸载）⇒ 迟到响应不抢页（view/选中不变）；后台完成 ⇒ 操作 1 +
 *   结果未读 1 + polite live 播报一次（等待后文本不变 = 不重复播报）；活动入口
 *   「打开结果」跨页定位新 run；再提交一个失败 fork（受控 500）⇒ 删除其 trace 文件
 *   ⇒「查看失败调用」定位不中 ⇒ **面板保持展开、页面不动**；操作行「返回草稿」
 *   定位失败 fork 的草稿编辑器（来源失效不丢输入）。
 * - P6 草稿放弃 + 关闭保护：放弃确认模态出现 ⇒ **背景不可交互**（点全局栏
 *   新建运行无效）→ 取消 ⇒ 草稿保留；再放弃 ⇒ 确认 ⇒ 草稿删除、计数回退。
 * - P7 收尾：受控面还原（teardown + settings 逐字节还原）。
 *
 * 用法：node apps/desktop/scripts/refine-53-cdp.cjs
 * 前置：dev 已带 CDP 9612 启动；端口 18799 空闲。
 */
"use strict";

const { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");
const { listPageTarget } = require("./editor-collapse-probe.cjs");

const ROOT = join(H.REPO, ".workbuddy", "refine-ui", "5x");
const SHOTS = join(ROOT, "shots");
mkdirSync(SHOTS, { recursive: true });

const TAG = "r53";
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
function finish() {
  const failed = checks.filter((c) => !c.ok && !c.note);
  writeFileSync(
    join(ROOT, `${TAG}-measurements.json`),
    `${JSON.stringify({ tag: TAG, checks, dump }, null, 2)}\n`,
    "utf8",
  );
  console.log(`检查 ${checks.filter((c) => !c.note).length} 条，失败 ${failed.length} 条`);
  clearTimeout(watchdog);
  return failed.length;
}
const watchdog = setTimeout(() => {
  console.error(`看门狗：${TAG} 超过 14 分钟未收尾`);
  writeFileSync(join(ROOT, `${TAG}-error.txt`), "watchdog timeout");
  process.exit(3);
}, 840_000);

async function shot(call, name) {
  const file = await H.shot(call, SHOTS, `${TAG}-${name}.png`).catch((e) => String(e));
  console.log(`  [截图] ${file}`);
}

function freshId() {
  return `00000000-0000-4000-8000-${String(Date.now() % 1_000_000_000).padStart(12, "0")}`;
}

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
      return rec.runIds[0];
    }
    if (Date.now() > deadline) return null;
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

/** store 草稿（单字段） */
const draftOf = (call, runId, spanId, field) =>
  H.storeQ(
    call,
    `const c = s.drafts.calls || {};
     const e = (c[${JSON.stringify(runId)}] || {})[${JSON.stringify(spanId)}] || {};
     const d = e[${JSON.stringify(field)}];
     return JSON.stringify({ text: d === undefined || d === null ? null : d.text,
              revision: d === undefined || d === null ? null : d.revision });`,
  );

/** 页内点按钮（文本匹配），header 排除可选 */
const clickButtonByText = async (call, text, { exact = true, scopedHeader = false } = {}) =>
  H.ev(
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

/** Monaco 草稿编辑器按 data-monaco-target 精确寻址并整体替换（5.1 已验证路径） */
async function writePromptDraft(call, runId, spanId, field, text) {
  const selector = `[data-monaco-host="prompt-draft"][data-monaco-target="${runId}:${spanId}:${field}"]`;
  const deadline = Date.now() + 15000;
  let prep = null;
  for (;;) {
    prep = await H.appImport(
      call,
      H.MONACO_NEEDLE,
      `const monaco = await m.ensureMonaco();
       const host = document.querySelector(${JSON.stringify(selector)});
       if (host === null) return JSON.stringify({ ok: false, why: 'no-host' });
       const ed = monaco.editor.getEditors().find(e => e.getDomNode() !== null && host.contains(e.getDomNode()));
       if (ed === undefined) return JSON.stringify({ ok: false, why: 'no-editor-for-host' });
       if (ed.getOption(monaco.editor.EditorOption.readOnly) === true) return JSON.stringify({ ok: false, why: 'read-only' });
       ed.focus();
       ed.setSelection(ed.getModel().getFullModelRange());
       return JSON.stringify({ ok: true });`,
    );
    if (prep.ok === true) break;
    if (Date.now() > deadline) return prep;
    await H.sleep(600);
  }
  // 空串走 executeEdits 删除（CDP insertText 空串是 no-op，删不掉选区）
  if (text === "") {
    const cleared = await H.appImport(
      call,
      H.MONACO_NEEDLE,
      `const monaco = await m.ensureMonaco();
       const host = document.querySelector(${JSON.stringify(selector)});
       if (host === null) return JSON.stringify({ ok: false, why: 'no-host' });
       const ed = monaco.editor.getEditors().find(e => e.getDomNode() !== null && host.contains(e.getDomNode()));
       if (ed === undefined) return JSON.stringify({ ok: false, why: 'no-editor-for-host' });
       ed.focus();
       const ok = ed.executeEdits(${JSON.stringify(`${TAG}-probe`)}, [{
         range: ed.getModel().getFullModelRange(),
         text: "",
         forceMoveMarkers: true,
       }]);
       return JSON.stringify({ ok });`,
    );
    if (cleared.ok !== true) return { ...cleared, step: "clear" };
    await H.sleep(700);
    const gotCleared = await draftOf(call, runId, spanId, field);
    if (gotCleared === null || gotCleared.text !== "") {
      throw new Error(`清空未落 store：got=${JSON.stringify(gotCleared)}`);
    }
    return gotCleared;
  }
  await call("Input.insertText", { text });
  await H.sleep(700);
  const got = await draftOf(call, runId, spanId, field);
  if (got === null || got.text !== text) {
    throw new Error(`草稿未落 store（field=${field}）：got=${JSON.stringify(got)}`);
  }
  return got;
}

/** 活动条三计数 + 面板各节（对象直返） */
const activityState = (call) =>
  H.ev(
    call,
    `(() => {
       const trigger = document.querySelector('button[aria-controls="session-activity-panel"]');
       const panel = document.getElementById('session-activity-panel');
       const counts = trigger === null ? null :
         ((trigger.textContent || '').match(/修改\\s*(\\d+)|操作\\s*(\\d+)|结果\\s*(\\d+)/g) || []);
       const cleanItems = Array.from(document.querySelectorAll('[data-draft-clean="true"]')).length;
       const recEntry = panel !== null && (panel.textContent || '').includes('录制配置有未应用的修改');
       const goRecord = panel !== null &&
         Array.from(panel.querySelectorAll('button')).some(b => ((b.textContent || '').trim()) === '去录制');
       const dirtyTitles = panel === null ? [] :
         Array.from(panel.querySelectorAll('section[aria-label="未提交修改"] li, section[aria-label="未提交修改"] [data-draft-clean]')).map(x => ((x.textContent||'').trim()).slice(0, 40));
       return {
         triggerPresent: trigger !== null,
         triggerFocused: trigger !== null && document.activeElement === trigger,
         panelOpen: panel !== null,
         countsRaw: counts,
         cleanItems,
         recEntry,
         goRecord,
         dirtyTitles,
       };
     })()`,
  );

/** 按 operationId 前缀定位面板行，点行内指定动作按钮（面板第一行=最新） */
async function findRowButtonByOperationId(call, operationId, buttonText) {
  const prefix = String(operationId).slice(0, 8);
  return H.ev(
    call,
    `(() => {
       const panel = document.getElementById('session-activity-panel');
       if (panel === null) return 'no-panel';
       const want = ${JSON.stringify(prefix)};
       const btnText = ${JSON.stringify(buttonText)};
       const lis = Array.from(panel.querySelectorAll('ul > li'));
       const row = lis.find(li => (li.textContent || '').includes('操作 ' + want));
       if (row === undefined) return 'no-row:' + want;
       const b = Array.from(row.querySelectorAll('button'))
         .find(x => ((x.textContent || '').trim()) === btnText);
       if (b === undefined) return 'no-button:' + btnText;
       if (b.disabled) return 'disabled';
       b.click(); return 'clicked';
     })()`,
  );
}

/** 在激活侧 prompt 编辑器的容器内点按钮（system/user 两编辑器成对挂载，只读侧按钮 disabled） */
async function clickInActivePromptEditor(call, runId, spanId, field, text) {
  const selector = `[data-monaco-host="prompt-draft"][data-monaco-target="${runId}:${spanId}:${field}"]`;
  return H.ev(
    call,
    `(() => {
       const host = document.querySelector(${JSON.stringify(selector)});
       if (host === null) return 'no-host';
       let node = host;
       let container = null;
       for (let i = 0; i < 10 && node !== null; i++) {
         node = node.parentElement;
         if (node !== null && (node.className || '').includes('emerald-50')) container = node;
       }
       if (container === null) return 'no-container';
       const b = Array.from(container.querySelectorAll('button'))
         .find(x => ((x.textContent || '').trim()) === ${JSON.stringify(text)});
       if (b === undefined) return 'no-button';
       if (b.disabled) return 'disabled';
       b.click(); return 'clicked';
     })()`,
  );
}

/** 活动面板开合 */
async function toggleActivity(call) {
  const r = await H.ev(
    call,
    `(() => { const t = document.querySelector('button[aria-controls="session-activity-panel"]');
       if (t === null) return 'no-trigger';
       t.click(); return 'clicked'; })()`,
  );
  await H.sleep(700);
  return r;
}

/** 按需打开活动面板（已开则不动） */
async function ensureActivityOpen(call) {
  const st = await activityState(call);
  if (st.panelOpen === true) return "already-open";
  const r = await toggleActivity(call);
  if (r !== "clicked") throw new Error(`打开活动面板失败：${r}`);
  return "opened";
}

// ---------------------------------------------------------------------------

async function main() {
  const settingsBackup = existsSync(H.SETTINGS_FILE) ? readFileSync(H.SETTINGS_FILE, "utf8") : null;
  let mock = null;
  let failed = 1;
  try {
    failed = await runInner();
  } catch (e) {
    console.error(String(e?.stack ?? e));
    writeFileSync(join(ROOT, `${TAG}-error.txt`), String(e?.stack ?? e), "utf8");
  } finally {
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
  process.exit(failed === 0 ? 0 : 1);

  async function runInner() {
    const page = await listPageTarget(H.CDP_PORT);
    const call = await H.makeDialogSession(page.webSocketDebuggerUrl);
    await call("Page.enable");
    await call("Runtime.enable");
    await call("Page.bringToFront").catch(() => {});

    // 开局哨兵 reload（5.1/5.2 纪律）；先等应用活着（dev 冷启动 vite 首轮构建）
    {
      const waitAlive = async (timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          try {
            const alive = await H.ev(
              call,
              `(() => (document.getElementById('root')?.innerHTML.length ?? 0) > 1000)()`,
            );
            if (alive === true) {
              // ⚠️ storeQ 的 body 必须 return JSON.stringify(...)——appImport 会
              // JSON.parse 返回值，body 直接返回对象会抛 "[object Object]"（5.1 坑）
              const n = await H.storeQ(call, "return JSON.stringify({ ok: true });");
              if (n && n.ok === true) return true;
            }
          } catch {
            /* 模块图还在加载 */
          }
          if (Date.now() > deadline) return false;
          await H.sleep(600);
        }
      };
      if (!(await waitAlive(90000))) throw new Error("应用 90s 未就绪");
      const sentinel = `r53-${Date.now()}`;
      await H.ev(call, `window.__r53Doc = ${JSON.stringify(sentinel)}; "ok"`);
      let swapped = false;
      await call("Page.reload", { ignoreCache: false });
      const deadline = Date.now() + 60000;
      for (;;) {
        try {
          const doc = await H.ev(call, "window.__r53Doc ?? null");
          if (doc !== sentinel) {
            const n = await H.storeQ(call, "return JSON.stringify({ runs: s.runs.length });");
            if (n.runs > 0) {
              swapped = true;
              break;
            }
          }
        } catch {
          /* 重载瞬间 */
        }
        if (Date.now() > deadline) break;
        await H.sleep(400);
      }
      if (!swapped) throw new Error("开局 reload 未换文档或列表未就绪");
    }

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
      apiKey: "sk-r53-controlled",
      model: "mock-model",
    });
    await H.storeQ(call, "await s.loadSettings(); return JSON.stringify('ok');");
    const epochEnv = await H.apiCall(call, "operationsStatus");
    if (!epochEnv.ok) throw new Error("operationsStatus 失败");
    const epoch = epochEnv.data.epoch;
    dump.epoch = epoch;

    const runA = await createRunSettled(call, epoch, {
      systemPrompt: "你是受控助手，只回答一句话。",
      userMessage: "refine-53 活动入口冒烟：说「好」。",
    });
    if (runA === null) throw new Error("run A 创建未收口");
    dump.runA = runA;
    const runAF = readRunFile(runA);
    check(
      "P0 run A 落盘：正常终态 + 1 个 LLM 调用（后续编辑/提交标的）",
      runAF.terminal.reason === "completed" && runAF.llms.length === 1,
      { terminal: `${runAF.terminal.event}/${runAF.terminal.reason}` },
    );
    const spanA = runAF.llms[0].id;
    dump.spanA = spanA;
    // ⚠️ main registry 的操作登记跨探针运行累计（dev 实例共享）——全部计数判据用相对值
    const opsBaseline = (await H.apiCall(call, "operationsStatus")).data.operations.length;
    dump.opsBaseline = opsBaseline;
    await H.storeQ(call, `await s.loadRuns(); return JSON.stringify('ok');`);
    await H.sleep(800);
    await H.selectRun(call, runA);
    await H.storeQ(
      call,
      `s.setReadingTab(${JSON.stringify(runA)}, "steps");
       s.selectSpan(${JSON.stringify(spanA)});
       return JSON.stringify("ok");`,
    );
    await H.sleep(1400);

    // ── P1 N09 浏览编辑页不冒充修改 ────────────────────────────────────────
    const openPrompt = await clickButtonByText(call, "编辑 system prompt 重跑");
    if (openPrompt !== "clicked") throw new Error(`打开 prompt 编辑器失败：${openPrompt}`);
    await H.sleep(1500);
    await clickButtonByText(call, "概览"); // 离开（编辑器卸载，clean 会话留存）
    await H.sleep(1200);
    const cleanState = await activityState(call);
    check(
      "N09 浏览编辑页不冒充修改：clean 会话不进修改计数（修改 0）",
      cleanState.triggerPresent === true &&
        cleanState.countsRaw.length === 3 &&
        cleanState.countsRaw[0] === "修改 0",
      cleanState,
    );
    await toggleActivity(call);
    const cleanPanel = await activityState(call);
    check(
      "N09 clean 组在场：面板「未修改的编辑会话」条目（data-draft-clean）可找回",
      cleanPanel.panelOpen === true && cleanPanel.cleanItems >= 1,
      { cleanItems: cleanPanel.cleanItems },
    );
    await shot(call, "01-clean-session");
    await toggleActivity(call); // 关面板

    // ── P2 N10 改回基线与清空 ─────────────────────────────────────────────
    await H.storeQ(
      call,
      `s.setReadingTab(${JSON.stringify(runA)}, "steps");
       s.selectSpan(${JSON.stringify(spanA)});
       return JSON.stringify("ok");`,
    );
    await H.sleep(1200);
    await clickButtonByText(call, "编辑 system prompt 重跑");
    await H.sleep(1500);
    const baseline = await draftOf(call, runA, spanA, "system_prompt");
    const baselineText =
      baseline === null || baseline.text === null ? "你是受控助手，只回答一句话。" : baseline.text;
    const zh = "refine-53 中文校验：修订推进与清空保护。";
    await writePromptDraft(call, runA, spanA, "system_prompt", zh);
    const dirtyState = await activityState(call);
    check(
      "N10 写入新文本 ⇒ 修改计数 1",
      dirtyState.countsRaw[0] === "修改 1",
      dirtyState.countsRaw,
    );
    // 改回基线 ⇒ 恢复 clean
    await writePromptDraft(call, runA, spanA, "system_prompt", baselineText);
    const backToBaseline = await activityState(call);
    check(
      "N10 改回基线 ⇒ 恢复 clean（修改计数 0，修订不回退）",
      backToBaseline.countsRaw[0] === "修改 0",
      backToBaseline.countsRaw,
    );
    // 清空为空串 ⇒ 仍 dirty（基线非空）
    await writePromptDraft(call, runA, spanA, "system_prompt", "");
    const cleared = await activityState(call);
    check(
      "N10 清空原非空输入 ⇒ 仍 dirty（清空保护，修改计数 1）",
      cleared.countsRaw[0] === "修改 1",
      cleared.countsRaw,
    );
    // 恢复一个非空草稿（后续提交用）
    await writePromptDraft(call, runA, spanA, "system_prompt", `${zh}（提交稿）`);
    await shot(call, "02-dirty-counts");

    // ── P3 录制未应用修改并入 ─────────────────────────────────────────────
    await H.storeQ(
      call,
      `s.openRecordingWorkspace();
       await s.applyRecordingDraft();
       s.writeRecordingDraftFields({ portText: "18788" });
       return JSON.stringify("ok");`,
    );
    await H.sleep(1200);
    await ensureActivityOpen(call);
    const withRec = await activityState(call);
    check(
      "P3 录制未应用修改并入计数（修改 2）且录制条目+去录制动作在场",
      withRec.countsRaw[0] === "修改 2" && withRec.recEntry === true && withRec.goRecord === true,
      withRec,
    );
    await toggleActivity(call);
    await shot(call, "03-recording-merged");

    // ── P4 N08 计数一致 + Esc 关闭焦点还原 ────────────────────────────────
    await toggleActivity(call);
    const panel4 = await activityState(call);
    const wantOps = `操作 ${opsBaseline}`;
    check(
      "N08 活动条三计数与面板内三节一致（修改 2 · 操作=登记基线 · 结果 0）",
      panel4.panelOpen === true &&
        panel4.countsRaw[0] === "修改 2" &&
        panel4.countsRaw[1] === wantOps &&
        panel4.countsRaw[2] === "结果 0",
      panel4.countsRaw,
    );
    // Esc 关闭 ⇒ 焦点还原触发按钮
    await H.ev(
      call,
      `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return "ok"; })()`,
    );
    await H.sleep(700);
    const afterEsc = await activityState(call);
    check(
      "N08 Esc 关闭活动面板且焦点还原触发按钮",
      afterEsc.panelOpen === false && afterEsc.triggerFocused === true,
      { panelOpen: afterEsc.panelOpen, triggerFocused: afterEsc.triggerFocused },
    );
    // ✕ 同一关闭动作
    await toggleActivity(call);
    await H.ev(
      call,
      `(() => { const panel = document.getElementById('session-activity-panel');
         const x = Array.from(panel.querySelectorAll('button'))
           .find(b => (b.getAttribute('aria-label') || '') === '关闭会话活动面板');
         if (x === undefined) return 'no-x';
         x.click(); return 'clicked'; })()`,
    );
    await H.sleep(600);
    const afterX = await activityState(call);
    check("N08 ✕ 同一关闭动作", afterX.panelOpen === false && afterX.triggerFocused === true, {
      panelOpen: afterX.panelOpen,
      triggerFocused: afterX.triggerFocused,
    });
    await shot(call, "04-activity-counts");

    // ── P5 真实执行链：迟到响应 + 后台结果 + 跨页定位 + 失败定位 ────────────
    // 回到 prompt 编辑器（草稿在：zh + 提交稿）；先回运行记录视图（P4 末可能停在录制页）
    await H.storeQ(
      call,
      `s.setView("trace");
       s.setReadingTab(${JSON.stringify(runA)}, "steps");
       s.selectSpan(${JSON.stringify(spanA)});
       return JSON.stringify("ok");`,
    );
    await H.sleep(1200);
    const openPrompt2 = await clickButtonByText(call, "编辑 system prompt 重跑");
    if (openPrompt2 !== "clicked") throw new Error(`重新打开 prompt 编辑器失败：${openPrompt2}`);
    await H.sleep(1500);
    // 确认凭据链：确认块 → 提交
    const armConfirm = await clickInActivePromptEditor(
      call,
      runA,
      spanA,
      "system_prompt",
      "已核对，确认从头重跑",
    );
    await H.sleep(700);
    check("P5 确认凭据链：确认块「已核对，确认从头重跑」可 arm", armConfirm === "clicked", {
      armConfirm,
    });
    // 提交并**立即切页签**（迟到响应：编辑器卸载）。
    // ⚠️ 不能用 H.clickAndCaptureSub：其 includes 匹配会先撞上 arm 后 disabled 的
    // 确认块按钮（「已核对，确认从头重跑」含同名子串）——这里用精确匹配的本地版。
    const cap = await (async () => {
      const r = await call("Runtime.evaluate", {
        expression: `(async () => {
          const btn = Array.from(document.querySelectorAll('button'))
            .find(x => ((x.textContent||'').trim()) === '确认从头重跑');
          if (btn === undefined) return JSON.stringify({ error: 'button-not-found' });
          if (btn.disabled) return JSON.stringify({ error: 'button-disabled' });
          btn.click();
          const deadline = Date.now() + 6000;
          for (;;) {
            const all = performance.getEntriesByType('resource').map(e => e.name);
            const url = all.filter(n => n.includes('/src/renderer/src/store.ts') || n.includes('/src/store.ts'))[0];
            const m = await import(url);
            const st = m.useAppStore.getState();
            const x = st.draftSubmissions.byId[${JSON.stringify(`${runA}|${spanA}|system_prompt`)}];
            if (x !== undefined) {
              // 在飞窗口内切页签（编辑器卸载——既有迟到响应路径）
              const t = Array.from(document.querySelectorAll('[role="tab"]'))
                .find(y => ((y.textContent||'').trim()) === '概览');
              if (t) t.click();
              return JSON.stringify({ channel: x.channel, revision: x.submittedRevision, unmountDone: true });
            }
            if (Date.now() > deadline) return JSON.stringify({ none: true });
            await new Promise(res => setTimeout(res, 30));
          }
        })()`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r?.exceptionDetails)
        throw new Error(`captureSub: ${JSON.stringify(r.exceptionDetails).slice(0, 160)}`);
      return JSON.parse(r?.result?.value ?? "{}");
    })();
    check(
      "P5 提交 + 执行中切页：提交关联捕获成功且编辑器在飞期间被切走",
      cap && cap.channel === "prompt" && cap.unmountDone === true,
      cap,
    );
    await H.sleep(2500);
    const afterFlight = await H.storeQ(
      call,
      "return JSON.stringify({ view: s.view, sel: s.selectedRunId });",
    );
    check(
      "N11 后台完成不抢页：迟到响应落地时视图与选中不动",
      afterFlight.view === "trace" && afterFlight.sel === runA,
      afterFlight,
    );
    // 本轮 fork 的操作身份（数组末尾的 prompt 通道操作；DOM 行含 operationId 前缀可定位）
    const forkOp = await H.storeQ(
      call,
      `const prompts = s.operations.operations.filter(o => (o.channel ?? o.target?.kind) === 'prompt');
       const last = prompts[prompts.length - 1];
       return JSON.stringify(last === undefined ? null : { id: last.operationId, runId: last.runIds ? last.runIds[0] : null });`,
    );
    if (forkOp === null || forkOp.runId === null) throw new Error("未找到本轮 fork 操作登记");
    dump.forkOp = forkOp;

    // 结果未读 1 + polite live 播报一次（等待后不重复）
    const live1 = await H.ev(call, `document.getElementById('result-live').textContent`);
    await H.sleep(4000);
    const live2 = await H.ev(call, `document.getElementById('result-live').textContent`);
    const actAfterDone = await activityState(call);
    check(
      "N08 后台完成：结果未读计数 1（面板关闭时仍可感知）",
      actAfterDone.countsRaw[2] === "结果 1",
      actAfterDone.countsRaw,
    );
    check(
      "N08 polite live 播报一次且不重复（4s 后文本不变，重复快照不进 live）",
      typeof live1 === "string" && live1.length > 0 && live1 === live2,
      { liveLen: live1 === null ? null : live1.length, stable: live1 === live2 },
    );
    await shot(call, "05-background-result");
    // 活动入口「打开结果」跨页定位
    await toggleActivity(call);
    const openResult = await H.ev(
      call,
      `(() => {
         const panel = document.getElementById('session-activity-panel');
         // ⚠️ 旧操作登记跨探针运行残留（main registry 共享）——取最后一行的按钮
         const btns = Array.from(panel.querySelectorAll('button'))
           .filter(x => ((x.textContent || '').trim()) === '打开结果' && !x.disabled);
         const b = btns[btns.length - 1];
         if (b === undefined) return 'no-button';
         b.click(); return 'clicked';
       })()`,
    );
    await H.sleep(2200);
    const located = await H.storeQ(
      call,
      "return JSON.stringify({ view: s.view, sel: s.selectedRunId });",
    );
    check(
      "N11 跨页定位结果：「打开结果」真到新 run（视图与选中切换）",
      openResult === "clicked" &&
        located.view === "trace" &&
        located.sel !== runA &&
        located.sel !== null,
      { click: openResult, nav: located },
    );

    // 失败 fork：受控 500 ⇒ 操作 2 + 失败定位
    await mock.reset({
      turns: [
        { mode: "fail", status: 500, errorBody: { error: { message: "受控失败：refine-53" } } },
      ],
      fallback: { mode: "fail", status: 500 },
    });
    await H.selectRun(call, runA);
    await H.storeQ(
      call,
      `s.setView("trace");
       s.setReadingTab(${JSON.stringify(runA)}, "steps");
       s.selectSpan(${JSON.stringify(spanA)});
       return JSON.stringify("ok");`,
    );
    await H.sleep(1200);
    const openPrompt3 = await clickButtonByText(call, "编辑 system prompt 重跑");
    if (openPrompt3 !== "clicked") throw new Error(`失败 fork：打开编辑器失败 ${openPrompt3}`);
    await H.sleep(1500);
    // 重新 ensure 的草稿 == 基线 ⇒ 门禁 canSubmit=false（arm 按钮禁用）——先写非基线值
    await writePromptDraft(call, runA, spanA, "system_prompt", "refine-53 失败 fork 的编辑值。");
    await H.sleep(500);
    const arm3 = await clickInActivePromptEditor(
      call,
      runA,
      spanA,
      "system_prompt",
      "已核对，确认从头重跑",
    );
    if (arm3 !== "clicked") {
      // 同 key 的确认凭据可能仍在 ready（上次 arm 后未失效）⇒ 按钮为已确认禁用态，直接提交
      const confirmedNow = await H.ev(
        call,
        `(() => {
           const host = document.querySelector('[data-monaco-host="prompt-draft"][data-monaco-target=' + JSON.stringify(${JSON.stringify(`${runA}:${spanA}:system_prompt`)}) + ']');
           let node = host, container = null;
           for (let i = 0; i < 10 && node !== null; i++) {
             node = node.parentElement;
             if (node !== null && (node.className || '').includes('emerald-50')) container = node;
           }
           if (container === null) return 'no-container';
           const b = Array.from(container.querySelectorAll('button'))
             .find(x => ((x.textContent || '').trim()) === '已确认从头重跑');
           return b === undefined ? 'not-confirmed' : 'confirmed';
         })()`,
      );
      if (confirmedNow !== "confirmed")
        throw new Error(`失败 fork：arm 失败 ${arm3}/${confirmedNow}`);
      console.log("  [登记] 确认凭据仍 ready（已确认态），直接提交");
    }
    await H.sleep(700);
    const submit3 = await clickInActivePromptEditor(
      call,
      runA,
      spanA,
      "system_prompt",
      "确认从头重跑",
    );
    if (submit3 !== "clicked") throw new Error(`失败 fork：提交失败 ${submit3}`);
    await H.sleep(3500);
    const failState = await H.storeQ(
      call,
      `const ops = s.operations.operations;
       return JSON.stringify({
         n: ops.length,
         last: ops.length > 0 ? { phase: ops[ops.length - 1].phase ?? null } : null,
       });`,
    );
    check("P5 失败 fork 落操作登记（操作 = 基线 + 2）", failState.n === opsBaseline + 2, {
      n: failState.n,
      baseline: opsBaseline,
    });
    // 找失败 fork 的新 run（最后一个 prompt 通道操作）并删其 trace 文件（定位不中场景）
    const failOp = await H.storeQ(
      call,
      `const prompts = s.operations.operations.filter(o => (o.channel ?? o.target?.kind) === 'prompt');
       const last = prompts[prompts.length - 1];
       return JSON.stringify(last === undefined ? null : { id: last.operationId, runId: last.runIds ? last.runIds[0] : null });`,
    );
    const failRunId = failOp === null ? null : failOp.runId;
    dump.failOp = failOp;
    if (failRunId !== null) {
      // ⚠️ 登记事实（facts.failure.llmCallSpanId）在提交收口时固化于 resultReads，
      // 事后改写/删除 trace 都改变不了已登记的定位目标 ⇒ 「定位不中」形态实机不可
      // 自然达（view-failure 按钮本身只在可定位时渲染 = 防呆设计）；false 分支由
      // store 单测承载。这里核对实机可达的**定位成功**路径。
      dump.failRunId = failRunId;
    }
    // 活动面板：失败操作行「查看失败调用」⇒ 定位不中 ⇒ 面板保持展开、页面不动
    await toggleActivity(call);
    const beforeFailLoc = await H.storeQ(
      call,
      "return JSON.stringify({ view: s.view, sel: s.selectedRunId });",
    );
    const viewFailure = await findRowButtonByOperationId(call, failOp.id, "查看失败调用");
    await H.sleep(2500);
    const afterFailLoc = await H.storeQ(
      call,
      `const panel = document.getElementById('session-activity-panel');
       return JSON.stringify({
         view: s.view, sel: s.selectedRunId,
         panelStillOpen: panel !== null,
       });`,
    );
    check(
      "N11 失败定位（成功路径）：「查看失败调用」切到失败 run 的步骤页并收起面板",
      viewFailure === "clicked" &&
        afterFailLoc.view === "trace" &&
        afterFailLoc.sel === failRunId &&
        afterFailLoc.panelStillOpen === false,
      { click: viewFailure, want: failRunId, after: afterFailLoc },
    );
    await shot(call, "06-failure-locate");

    // 「返回草稿」定位失败 fork 的草稿（草稿保留 + 来源输入不丢）
    await ensureActivityOpen(call);
    const returnDraft = await findRowButtonByOperationId(call, failOp.id, "返回草稿");
    await H.sleep(2000);
    const backDraft = await H.storeQ(
      call,
      "return JSON.stringify({ view: s.view, sel: s.selectedRunId });",
    );
    check(
      "N11 定位失效草稿：「返回草稿」回到失败 fork 的编辑现场（run A + 草稿不丢）",
      returnDraft === "clicked" && backDraft.sel === runA,
      { click: returnDraft, nav: backDraft },
    );
    await toggleActivity(call);

    // ── P6 草稿放弃 + 关闭保护 ────────────────────────────────────────────
    await ensureActivityOpen(call);
    const abandon = await H.ev(
      call,
      `(() => {
         const panel = document.getElementById('session-activity-panel');
         if (panel === null) return 'no-panel';
         const b = Array.from(panel.querySelectorAll('button'))
           .find(x => (x.title || '').startsWith('放弃该草稿'));
         if (b === undefined) return 'no-button';
         b.click(); return 'clicked';
       })()`,
    );
    await H.sleep(900);
    const dialogUp = await H.ev(
      call,
      `(() => {
         const dlg = Array.from(document.querySelectorAll('dialog[open]')).pop();
         if (dlg === undefined || dlg === null) return null;
         return {
           title: (dlg.textContent || '').includes('放弃草稿'),
           confirmBtn: Array.from(dlg.querySelectorAll('button')).some(b => ((b.textContent||'').trim()) === '确认放弃'),
           cancelBtn: Array.from(dlg.querySelectorAll('button')).some(b => ((b.textContent||'').trim()) === '取消'),
         };
       })()`,
    );
    check(
      "P6 放弃需确认：真模态出现（放弃草稿 + 确认/取消两钮）",
      abandon === "clicked" &&
        dialogUp !== null &&
        dialogUp.title === true &&
        dialogUp.confirmBtn === true &&
        dialogUp.cancelBtn === true,
      { click: abandon, dialog: dialogUp },
    );
    // 模态背景不可交互：**真实坐标点击**全局栏「新建运行」——showModal 的 top layer
    // 会在命中测试层拦截背景（程序化 .click() 绕过 top layer，判据无效，5.3 实测踩坑）
    const btnCenter = await H.ev(
      call,
      `(() => {
         const b = Array.from(document.querySelectorAll('header button'))
           .find(x => ((x.textContent || '').trim()) === '新建运行');
         if (b === undefined) return null;
         const r = b.getBoundingClientRect();
         return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
       })()`,
    );
    if (btnCenter === null) throw new Error("新建运行按钮不在场（背景点击前置失败）");
    await call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: Math.round(btnCenter.x),
      y: Math.round(btnCenter.y),
      button: "left",
      clickCount: 1,
    });
    await call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: Math.round(btnCenter.x),
      y: Math.round(btnCenter.y),
      button: "left",
      clickCount: 1,
    });
    await H.sleep(800);
    const bgView = await H.storeQ(call, "return JSON.stringify({ view: s.view });");
    const dialogStill = await H.ev(call, `document.querySelector('dialog[open]') !== null`);
    check(
      "P6 模态背景不可交互：确认模态开着时真实点击「新建运行」不进创建页且模态仍在",
      bgView.view !== "create" && dialogStill === true,
      { view: bgView.view, dialogStill },
    );
    // 取消 ⇒ 草稿保留
    await H.clickInOpenDialog(call, "取消");
    await H.sleep(600);
    const afterCancel = await activityState(call);
    check(
      "P6 取消放弃 ⇒ 草稿保留（修改计数不变）",
      afterCancel.countsRaw[0] === "修改 2",
      afterCancel.countsRaw,
    );
    // 再放弃 ⇒ 确认 ⇒ 草稿删除、计数回退
    await H.ev(
      call,
      `(() => {
         const panel = document.getElementById('session-activity-panel');
         const b = Array.from(panel.querySelectorAll('button'))
           .find(x => (x.title || '').startsWith('放弃该草稿'));
         if (b === undefined) return 'no-button';
         b.click(); return 'clicked';
       })()`,
    );
    await H.sleep(800);
    await H.clickInOpenDialog(call, "确认放弃");
    await H.sleep(800);
    const afterAbandon = await activityState(call);
    check(
      "P6 确认放弃 ⇒ 草稿删除、计数回退（剩录制 1）",
      afterAbandon.countsRaw[0] === "修改 1",
      afterAbandon.countsRaw,
    );
    await shot(call, "07-abandon-flow");
    return finish();
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
