/* eslint-disable */
/**
 * refactor-desktop-renderer-modules 任务 1.4：**重构前 Electron 行为基线**。
 *
 * 目的：在拆分动手前，用真实 UI/IPC 记录两条基线（不直接改 store——交互全走真实
 * 点击/键入，store 只读断言），供拆分后（6.1/6.3.x）同脚本复跑对比：
 * - B1 编辑恢复：prompt 草稿跨页签往返（步骤 → 概览 → 步骤）正文与 revision 逐字保持。
 * - B2 文件路径：文件页选中文件跨页签往返，选中路径与容器几何保持。
 *
 * fixture（dev dataDir 既有，不注入不改动）：
 * - run_mtmgz1v1：llm/step/tool 俱备（编辑标的）。
 * - export_e2e_root：workspace 带文件（文件页标的）。
 *
 * 用法：dev 已带 CDP 9612 启动后 `node apps/desktop/scripts/rrm-14-baseline-cdp.cjs`
 */
"use strict";

const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");
const { makeSession } = require("./lib/u2-cdp-util.cjs");
const { listPageTarget } = require("./editor-collapse-probe.cjs");

const TAG = "rrm14";
const OUT = join(H.REPO, ".workbuddy", "rrm-14-baseline");
const SHOTS = join(OUT, "shots");
mkdirSync(SHOTS, { recursive: true });

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: ok === true, detail: detail ?? null });
  console.log(
    `${ok === true ? "✓" : "✗"} ${name}${ok === true ? "" : ` — ${JSON.stringify(detail)}`}`,
  );
};

/** monaco 模块内求值：resource 条目寻址 → 直连 specifier，整体轮询（chunk 懒加载有延迟） */
async function monacoImport(call, body, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const primary = await H.appImport(call, H.MONACO_NEEDLE, body).catch((e) => ({
      error: String(e.message).slice(0, 120),
    }));
    if (primary && primary.error === undefined) return primary;
    last = primary;
    const r = await call("Runtime.evaluate", {
      expression: `(async () => {
         const m = await import("/src/monaco-bootstrap.ts");
         ${body}
       })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (!r?.exceptionDetails) {
      return JSON.parse(r?.result?.value);
    }
    last = {
      error: String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(
        0,
        160,
      ),
    };
    if (Date.now() > deadline) throw new Error(`monacoImport 超时：${JSON.stringify(last)}`);
    await H.sleep(1500);
  }
}

/** store 只读：选中 run + detail spans */
const spansOf = (call) =>
  H.storeQ(
    call,
    `const d = s.detail;
     return JSON.stringify({ selectedRunId: s.selectedRunId,
       spans: d === null ? [] : d.spans.map(x => ({ id: x.id, kind: x.kind })) });`,
  );

/** 点击含「LLM 调用」title 的行直到 selectedSpanId 命中（refine-54 同款轮换点击） */
async function clickLlmRow(call, spanId) {
  for (let i = 0; i < 4; i++) {
    const clicked = await H.ev(
      call,
      `(() => { const rows = Array.from(document.querySelectorAll('button'))
          .filter(x => (x.title||'').includes('LLM 调用') && x.offsetParent !== null);
        if (rows.length <= ${i}) return 'no-row-' + rows.length;
        rows[${i}].click(); return 'clicked'; })()`,
    );
    await H.sleep(1500);
    const sel = await H.storeQ(call, "return JSON.stringify({ span: s.selectedSpanId });");
    if (sel.span === spanId) return true;
  }
  return false;
}

/** Monaco 草稿宿主当前值（只读） */
const monacoValueOf = (call, runId, spanId, field) =>
  monacoImport(
    call,
    `const monaco = await m.ensureMonaco();
     const host = document.querySelector('[data-monaco-host="prompt-draft"][data-monaco-target="${runId}:${spanId}:${field}"]');
     if (host === null) return JSON.stringify({ ok: false, why: 'no-host' });
     const ed = monaco.editor.getEditors().find(e => e.getDomNode() !== null && host.contains(e.getDomNode()));
     if (ed === undefined) return JSON.stringify({ ok: false, why: 'no-editor-for-host' });
     return JSON.stringify({ ok: true, value: ed.getModel().getValue() });`,
  );

/** 打开 prompt 编辑器（按钮文案匹配「编辑 …prompt」），返回点到的按钮文案 */
async function openPromptEditor(call) {
  const clickedText = await H.ev(
    call,
    `(() => {
       const b = Array.from(document.querySelectorAll('button')).find(x => {
         const t = ((x.textContent || '').trim());
         return /编辑/.test(t) && /prompt/i.test(t) && x.offsetParent !== null && !x.disabled;
       });
       if (b === undefined || b === null) return 'no-button';
       b.click(); return (b.textContent || '').trim();
     })()`,
  );
  if (clickedText === "no-button") throw new Error("prompt 编辑器入口不可达：no-button");
  console.log(`  [B1] 编辑入口按钮：${clickedText}`);
  // 轮询等待宿主出现（编辑器懒加载有延迟）
  for (let i = 0; i < 12; i++) {
    const host = await H.ev(
      call,
      `(() => document.querySelectorAll('[data-monaco-host="prompt-draft"]').length)()`,
    );
    if (host > 0) return clickedText;
    await H.sleep(1000);
  }
  throw new Error(`prompt 编辑器宿主 12s 未出现（按钮：${clickedText}）`);
}

async function fileTabState(call) {
  const state = await H.ev(
    call,
    `(() => {
       const opts = Array.from(document.querySelectorAll('[role="option"][data-file-path]'));
       const sel = opts.find(e => e.getAttribute('aria-selected') === 'true');
       const cont = document.querySelector('[data-file-container-width]');
       return {
         options: opts.map(e => e.getAttribute('data-file-path')),
         selected: sel === undefined ? null : sel.getAttribute('data-file-path'),
         containerWidth: cont === null ? null : Number(cont.getAttribute('data-file-container-width')),
         hasMonaco: !!document.querySelector('.monaco-editor, .monaco-diff-editor'),
       };
     })()`,
  );
  return state;
}

async function main() {
  const page = await listPageTarget(H.CDP_PORT);
  const call = await makeSession(page.webSocketDebuggerUrl);
  try {
    // 初始 loadRuns 就绪等待（runs 列表非空或超时）
    let runs0 = [];
    for (let i = 0; i < 30; i++) {
      runs0 = await H.runs(call);
      if (Array.isArray(runs0) && runs0.length > 0) break;
      await H.sleep(1000);
    }
    check("P0 连接成功且 runs 可枚举", Array.isArray(runs0) && runs0.length > 0, {
      runs: runs0.length,
    });
    await H.shot(call, SHOTS, `${TAG}-p0.png`).catch(() => {});

    // ── B1 编辑恢复：run_mtmgz1v1 prompt 草稿跨页签往返 ──────────────────────
    const RUN_A = "run_mtmgz1v1";
    await H.selectRun(call, RUN_A);
    await H.clickTabChecked(call, "步骤");
    await H.sleep(1500);
    const spans = await spansOf(call);
    check("B1 详情已按 run 定位", spans.selectedRunId === RUN_A && spans.spans.length > 0, {
      selectedRunId: spans.selectedRunId,
      spans: spans.spans.length,
    });
    const llm = spans.spans.find((x) => x.kind === "llm.call");
    if (llm === undefined) throw new Error("run_mtmgz1v1 无 llm.call span，基线场景不成立");
    const rowHit = await clickLlmRow(call, llm.id);
    check("B1 选中 llm.call span", rowHit === true, { spanId: llm.id });
    await openPromptEditor(call);

    const MARK = `RRM14基线-${Date.now()}`;
    const FIELD = "system_prompt";
    // 写入（真实键入路径：focus + insertText；判据=store 草稿逐字一致；编辑器懒加载 ⇒ 轮询等挂载）
    const write = await (async () => {
      const selector = `[data-monaco-host="prompt-draft"][data-monaco-target="${RUN_A}:${llm.id}:${FIELD}"]`;
      const deadline = Date.now() + 30000;
      let prep = null;
      for (;;) {
        prep = await monacoImport(
          call,
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
        if (Date.now() > deadline) throw new Error(`system 编辑器不可写：${JSON.stringify(prep)}`);
        await H.sleep(1200);
      }
      await call("Input.insertText", { text: MARK });
      await H.sleep(700);
      return H.storeQ(
        call,
        `const c = s.drafts.calls || {};
         const d = ((c[${JSON.stringify(RUN_A)}] || {})[${JSON.stringify(llm.id)}] || {})[${JSON.stringify(FIELD)}];
         return JSON.stringify({ text: d === undefined || d === null ? null : d.text,
           revision: d === undefined || d === null ? null : d.revision });`,
      );
    })();
    check("B1 草稿写入落 store（逐字）", write.text === MARK, {
      revision: write.revision,
    });
    await H.shot(call, SHOTS, `${TAG}-b1-written.png`).catch(() => {});

    // 往返：概览 → 步骤（span 选中持久，编辑器随会话草稿恢复）
    await H.clickTabChecked(call, "概览");
    await H.clickTabChecked(call, "步骤");
    await H.sleep(1500);
    const back = await spansOf(call);
    check("B1 往返后 run/选中保持", back.selectedRunId === RUN_A && back.spans.length > 0, {
      selectedRunId: back.selectedRunId,
    });
    let after = null;
    try {
      await openPromptEditor(call);
      // 编辑器懒加载 ⇒ 轮询回读（monacoImport 只在异常时重试，{ok:false} 需自己轮）
      const deadline = Date.now() + 30000;
      for (;;) {
        after = await monacoValueOf(call, RUN_A, llm.id, FIELD);
        if (after.ok === true || Date.now() > deadline) break;
        await H.sleep(1200);
      }
    } catch (e) {
      after = { ok: false, why: String(e.message) };
    }
    const draftNow = await H.storeQ(
      call,
      `const c = s.drafts.calls || {};
       const d = ((c[${JSON.stringify(RUN_A)}] || {})[${JSON.stringify(llm.id)}] || {})[${JSON.stringify(FIELD)}];
       return JSON.stringify({ text: d === undefined || d === null ? null : d.text,
         revision: d === undefined || d === null ? null : d.revision });`,
    );
    check(
      "B1 往返后草稿正文与 revision 保持",
      after.ok === true &&
        after.value === MARK &&
        draftNow.text === MARK &&
        draftNow.revision === write.revision,
      { monaco: after.ok === true ? "match" : after.why, revision: draftNow.revision },
    );
    await H.shot(call, SHOTS, `${TAG}-b1-restored.png`).catch(() => {});

    // ── B2 文件路径：export_e2e_root 文件选中跨页签往返 ─────────────────────
    const RUN_B = "export_e2e_root";
    await H.selectRun(call, RUN_B);
    await H.clickTabChecked(call, "文件");
    await H.sleep(2500);
    const st0 = await fileTabState(call);
    check("B2 文件页有可选文件", st0.options.length > 0, {
      options: st0.options.length,
    });
    const target = st0.selected ?? st0.options[0];
    if (st0.selected === null) {
      await H.ev(
        call,
        `(() => { const b = document.querySelector('[role="option"][data-file-path=${JSON.stringify(target)}]');
           if (b === null) return false; b.click(); return true; })()`,
      );
      await H.sleep(1500);
    }
    const st1 = await fileTabState(call);
    check("B2 文件选中生效（容器/查看器在场）", st1.selected === target && st1.hasMonaco, {
      selected: st1.selected,
      width: st1.containerWidth,
    });
    await H.shot(call, SHOTS, `${TAG}-b2-selected.png`).catch(() => {});

    await H.clickTabChecked(call, "概览");
    await H.clickTabChecked(call, "文件");
    await H.sleep(2500);
    const st2 = await fileTabState(call);
    check(
      "B2 往返后文件选中与容器几何保持",
      st2.selected === st1.selected &&
        st2.containerWidth === st1.containerWidth &&
        st2.hasMonaco === st1.hasMonaco,
      { before: st1.containerWidth, after: st2.containerWidth },
    );
    await H.shot(call, SHOTS, `${TAG}-b2-restored.png`).catch(() => {});

    // 收尾：证据落盘
    const evidence = {
      tag: TAG,
      at: new Date().toISOString(),
      baselineCommit: "379b388",
      checks,
      summary: {
        total: checks.length,
        passed: checks.filter((c) => c.ok).length,
      },
    };
    const file = join(OUT, `evidence-${Date.now()}.json`);
    writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`\n证据：${file}`);
    console.log(`结论：${evidence.summary.passed}/${evidence.summary.total} 通过`);
    if (evidence.summary.passed !== evidence.summary.total) process.exitCode = 1;
  } catch (e) {
    console.error("探针失败：", e);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("探针失败：", e);
  process.exit(1);
});
