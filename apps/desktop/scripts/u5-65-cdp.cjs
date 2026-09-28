/* eslint-disable */
/**
 * U5 任务 6.5（第四批受控实机）：模型 A/B 批次——全臂正常整批清理、部分失败整批保留、
 * 确认绑定当前预览计划、dry-run 零隐式清理、批次行草稿往返恢复。
 *
 * 覆盖 evidence-index「实机入口 = 6.5」各计划 tag：
 * ab-all-normal（M2.2 全臂正常才清理整批）、ab-partial-fail（M2.3 部分失败保留 + 逐臂诚实）、
 * ab-plan-confirm（A1.4 确认绑定当前预览计划）、ab-no-implicit-clear（A4.2 预览/结果不隐式清理）、
 * ab-rows-restore（A6.3 臂增删与非法参数可恢复）。
 * ⚠️ 缺臂 / null ID 桌面自然诱发不了 ⇒ 按集成 fixture + 单元承载（evidence-index 行 6 注记），不冒充实机。
 *
 * 判据口径（与 6.2–6.4 同纪律）：
 * - 臂**顺序执行**（DetailPanel 1204 / abDisclosure 513），每臂一次完整 runLoop ⇒ mock turns
 *   顺序消费：partial-fail 用 turns [ok, fail503] 造"臂 1 成、臂 2 败"；
 * - 披露短语**运行时从 `lib/execution-confirmation.ts` 的 abDisclosure 源码抽取静态字面量**
 *   （排除"已放行"副作用分支——normalRun 无工具 ⇒ 走"未放行"分支）；
 * - 结局只按落盘 run.event 判；核实事实读 resultReads（epoch 取 main 当前值）；
 * - 批次草稿读 `s.modelAbDraftOf({runId, spanId})`（null = 不存在）；
 * - 批次草稿跨 tag 持久 ⇒ tag 顺序即状态机：all-normal（清干净）→ partial-fail（保留）→
 *   plan-confirm（继承两臂）→ no-implicit-clear → rows-restore（最后改行，不回传）。
 *
 * 用法：`node apps/desktop/scripts/u5-65-cdp.cjs --tag=<TAG>`；前置 dev 由 run-all 起。
 */
"use strict";
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");
const { fixtureOf } = require("./lib/u5-sse-fixtures.cjs");

const TAGS = [
  "ab-all-normal",
  "ab-partial-fail",
  "ab-plan-confirm",
  "ab-no-implicit-clear",
  "ab-rows-restore",
];
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag");
if (!TAGS.includes(TAG)) {
  console.error(`用法：--tag=<${TAGS.join("|")}>`);
  process.exit(2);
}

const OUT_DIR = join(H.REPO, ".workbuddy", "u5", "u5-65");
const SHOT_DIR = join(H.REPO, "docs", "reviews", "2026-09-28-u5-65");
const MARK = "U5-65";
const MANIFEST = join(H.REPO, ".workbuddy", "u3", "u3-61", "manifest.json");
const CONF_LIB = join(H.REPO, "apps/desktop/src/renderer/src/lib/execution-confirmation.ts");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });
if (!existsSync(MANIFEST)) throw new Error(`缺夹具 manifest（${MANIFEST}）`);
const FX = JSON.parse(readFileSync(MANIFEST, "utf8"));
/** A/B 只从首次 llm.call 出发；normalRun 首个 llm span = s_02（traceFacts 已验证） */
const PARENT_RUN = FX.normalRun;
const PARENT_SPAN = "s_02";
const SUB_KEY = `${PARENT_RUN}|${PARENT_SPAN}|model_ab`;
/** store 侧 draftKey 源码片段（modelAbDraftOf / isDraftFrozen / currentConfirmationBinding 共用） */
const DKEY = `({ runId: ${JSON.stringify(PARENT_RUN)}, spanId: ${JSON.stringify(PARENT_SPAN)} })`;

const OK_TURN = { content: `${MARK} 受控成功：一步答完。`, usage: { in: 120, out: 40 } };
const FAIL503_TURN = { mode: "fail", status: 503, content: "upstream unavailable", delayMs: 800 };
/** 组合剧本：臂顺序执行 ⇒ turns 顺序消费（臂 1 取 turns[0]、臂 2 取 turns[1]，耗尽走 fallback） */
const TAG_SCRIPT = {
  // 两臂各消费一次 fallback ok ⇒ served = 2
  "ab-all-normal": { turns: [], fallback: OK_TURN },
  // 臂 1 取 turns[0]（ok），臂 2 取 turns[1]（fail503）⇒ 部分失败
  "ab-partial-fail": { turns: [OK_TURN, FAIL503_TURN], fallback: OK_TURN },
  // 以下三个 tag 只做 dry-run（只读通道 modelAbPlan，不联网）⇒ notConsumed 语义：期望 0 次消费
  "ab-plan-confirm": {
    turns: [{ mode: "fail", status: 418, content: "dry-run 不该被消费" }],
    fallback: OK_TURN,
  },
  "ab-no-implicit-clear": {
    turns: [{ mode: "fail", status: 418, content: "dry-run 不该被消费" }],
    fallback: OK_TURN,
  },
  "ab-rows-restore": {
    turns: [{ mode: "fail", status: 418, content: "dry-run 不该被消费" }],
    fallback: OK_TURN,
  },
};
const EXPECTED_CALLS = {
  "ab-all-normal": 2,
  "ab-partial-fail": 2,
  "ab-plan-confirm": 0,
  "ab-no-implicit-clear": 0,
  "ab-rows-restore": 0,
};

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
function finish(extraMeta = {}) {
  const failed = checks.filter((c) => !c.ok);
  const meta = {
    head: headShort(),
    electron: electronVersion(),
    node: process.version,
    fixtures: { normalRun: FX.normalRun, isoRoot: FX.isoRoot, proxyRun: FX.proxyRun ?? null },
    tracesCount: H.traceIds().size,
    ...extraMeta,
  };
  writeFileSync(
    join(OUT_DIR, `${TAG}-measurements.json`),
    JSON.stringify({ tag: TAG, meta, checks, failed: failed.length, dump }, null, 2),
  );
  console.log(`检查 ${checks.length} 条，失败 ${failed.length} 条；meta=${JSON.stringify(meta)}`);
  clearTimeout(watchdog);
  process.exit(failed.length === 0 ? 0 : 1);
}
const watchdog = setTimeout(() => {
  console.error(`看门狗：${TAG} 超过 10 分钟未收尾 ⇒ 判失败退出`);
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), "watchdog timeout");
  process.exit(3);
}, 600_000);

function headShort() {
  try {
    const head = readFileSync(join(H.REPO, ".git", "HEAD"), "utf8").trim();
    const m = head.match(/^ref: (.+)$/);
    if (m) {
      const refFile = join(H.REPO, ".git", ...m[1].split("/"));
      if (existsSync(refFile)) return readFileSync(refFile, "utf8").trim().slice(0, 7);
      const packed = readFileSync(join(H.REPO, ".git", "packed-refs"), "utf8");
      const line = packed.split(/\r?\n/).find((l) => l.endsWith(` ${m[1]}`));
      if (line) return line.split(" ")[0].slice(0, 7);
    }
    return head.slice(0, 7);
  } catch {
    return "unknown";
  }
}
function electronVersion() {
  try {
    return require(join(H.REPO, "apps", "desktop", "node_modules", "electron", "package.json"))
      .version;
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// 披露短语自证：从 lib 源码抽指定函数体内的静态字面量（与组件同一来源）
// ---------------------------------------------------------------------------
function disclosurePhrases(fnName) {
  const src = readFileSync(CONF_LIB, "utf8");
  const at = src.indexOf(`export function ${fnName}`);
  if (at < 0) throw new Error(`lib 里找不到 ${fnName}`);
  const next = src.indexOf("\nexport ", at + 10);
  const body = src.slice(at, next > 0 ? next : undefined);
  const out = [];
  // 字符类排除换行：否则相邻字符串字面量之间的代码会被并成一个跨行"伪短语"
  for (const m of body.matchAll(/"([^"\\\n]{6,})"|'([^'\\\n]{6,})'/g)) {
    const lit = m[1] ?? m[2];
    if (!lit.includes("${") && !lit.includes("input.") && !lit.includes("`") && !lit.includes("\n"))
      out.push(lit);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 读数与页内动作
// ---------------------------------------------------------------------------
const opsStatus = (call) => H.apiCall(call, "operationsStatus");
const recordOf = async (call, operationId) => {
  const st = await opsStatus(call);
  const rec = (st?.data?.operations ?? []).find((o) => o.operationId === operationId) ?? null;
  return { rec, slot: st?.data?.activeOperationId ?? null, epoch: st?.data?.epoch ?? null };
};
const opsCount = async (call) => {
  const st = await opsStatus(call);
  return (st?.data?.operations ?? []).length;
};
const resultReadFor = async (call, epoch, operationId, runId) => {
  const all = await H.storeQ(call, "return JSON.stringify(s.resultReads.byKey);");
  return all[`${epoch}|${operationId}|${runId}`] ?? null;
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
const bodyText = (call) => H.ev(call, "(() => document.body.innerText)()");
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
/** 提交并捕获关联（6.4 同款：点击指定文案按钮，轮询 draftSubmissions.byId[key]） */
async function submitAndCapture(call, buttonText, key, { pollMs = 9000 } = {}) {
  const r = await call("Runtime.evaluate", {
    expression: `(async () => {
      const btn = Array.from(document.querySelectorAll('button'))
        .filter(x => x.offsetParent !== null && !x.disabled)
        .find(x => ((x.textContent||'').trim()).includes(${JSON.stringify(buttonText)}));
      if (!btn) {
        const anyV = Array.from(document.querySelectorAll('button'))
          .filter(x => x.offsetParent !== null)
          .find(x => ((x.textContent||'').trim()).includes(${JSON.stringify(buttonText)}));
        return JSON.stringify({ error: anyV ? 'button-disabled' : 'button-not-found' });
      }
      btn.click();
      const deadline = Date.now() + ${pollMs};
      for (;;) {
        const all = performance.getEntriesByType('resource').map(e => e.name);
        const url = all.filter(n => n.includes('/src/renderer/src/store.ts') || n.includes('/src/store.ts'))[0];
        const m = await import(url);
        const s = m.useAppStore.getState();
        const x = s.draftSubmissions.byId[${JSON.stringify(key)}];
        if (x !== undefined) {
          return JSON.stringify({ channel: x.channel, revision: x.submittedRevision,
            operationId: x.operationId ?? null, epoch: x.epoch ?? null });
        }
        if (Date.now() > deadline) return JSON.stringify({ none: true });
        await new Promise(res => setTimeout(res, 20));
      }
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r?.exceptionDetails)
    throw new Error(`submitAndCapture: ${JSON.stringify(r.exceptionDetails).slice(0, 200)}`);
  return JSON.parse(r?.result?.value ?? "{}");
}
function traceFacts(id) {
  const lines = readFileSync(join(H.TRACES, `${id}.jsonl`), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const llms = lines.filter((l) => l.type === "span" && l.kind === "llm.call");
  const last = lines[lines.length - 1];
  return {
    meta: lines[0],
    llmSpanId: llms.length > 0 ? llms[0].id : null,
    firstMessages: llms.length > 0 ? (llms[0].request?.messages ?? null) : null,
    firstLlmError: llms.length > 0 ? (llms[0].error ?? null) : null,
    event: last?.type === "run.event" ? last.event : null,
    reason: last?.type === "run.event" ? last.reason : null,
  };
}

// ---------------------------------------------------------------------------
// A/B 编辑器专用动作
// ---------------------------------------------------------------------------
/** 打开 A/B 编辑器（run + span 双证选中，防 6.4 坐实的同名 span 串台） */
async function openAbEditor(call) {
  await H.selectRun(call, PARENT_RUN);
  await H.clickTabChecked(call, "步骤");
  await H.clickSpan(call, "LLM", PARENT_SPAN);
  const sel = await H.storeQ(
    call,
    "return JSON.stringify({ run: s.selectedRunId, span: s.selectedSpanId });",
  );
  if (sel.run !== PARENT_RUN || sel.span !== PARENT_SPAN) {
    throw new Error(`选中态串台：${JSON.stringify(sel)}`);
  }
  await H.clickByTextChecked(call, "模型 A/B 实验（换 model / params 对比）", 3000);
  const deadline = Date.now() + 8000;
  for (;;) {
    const body = await bodyText(call);
    if (body.includes("模型 A/B 实验 · 同上下文多臂对比")) return;
    if (Date.now() > deadline) throw new Error("A/B 编辑器 8s 未打开");
    await H.sleep(400);
  }
}
/** 臂行输入是受控 <input>：原生 setter + input 事件（React onChange 才会触发） */
async function setArmInput(call, kind, index, value) {
  const match =
    kind === "model"
      ? '(x.placeholder || "") === "model 名"'
      : '(x.placeholder || "").startsWith("采样参数 JSON")';
  const r = await H.ev(
    call,
    `(() => {
      const inputs = Array.from(document.querySelectorAll('input'))
        .filter(x => x.offsetParent !== null)
        .filter(x => ${match});
      const el = inputs[${index}];
      if (!el) return JSON.stringify({ error: 'input-not-found', count: inputs.length });
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return JSON.stringify({ ok: true });
    })()`,
  );
  const p = JSON.parse(r);
  if (p.error) throw new Error(`setArmInput(${kind},${index}) 失败：${JSON.stringify(p)}`);
  await H.sleep(450);
}
const setArmModel = (call, index, value) => setArmInput(call, "model", index, value);
const setArmParams = (call, index, value) => setArmInput(call, "params", index, value);
/** 点击可见且可点的按钮（按文案前缀）；返回点击前的状态 */
async function clickAbButton(call, textPrefix) {
  const st = await findButton(call, textPrefix);
  if (!(st.found && st.disabled === false)) {
    throw new Error(`按钮「${textPrefix}」不可点：${JSON.stringify(st)}`);
  }
  await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
      .filter(x => x.offsetParent !== null)
      .find(x => ((x.textContent || '').trim()).startsWith(${JSON.stringify(textPrefix)}));
      b.click(); return true; })()`,
  );
  await H.sleep(450);
  return st;
}
async function findButton(call, textPrefix) {
  const r = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
      .filter(x => x.offsetParent !== null)
      .find(x => ((x.textContent || '').trim()).startsWith(${JSON.stringify(textPrefix)}));
      return b == null ? JSON.stringify({ found: false })
        : JSON.stringify({ found: true, disabled: b.disabled, text: (b.textContent || '').trim() }); })()`,
  );
  return JSON.parse(r);
}
const abDraftOf = (call) =>
  H.storeQ(call, `return JSON.stringify(s.modelAbDraftOf(${DKEY}) ?? null);`);
const abFrozenOf = (call) =>
  H.storeQ(call, `return JSON.stringify({ frozen: s.isDraftFrozen(${DKEY}) === true });`);
const abConfirmedOf = (call) =>
  H.storeQ(
    call,
    `return JSON.stringify({ confirmed: s.executionConfirmationReady(s.currentConfirmationBinding("model_ab", ${DKEY})) === true });`,
  );
/** 副作用确认复选框只在该出现时出现（normalRun 无工具 ⇒ 通常 absent）；在即勾上 */
async function acknowledgeSideEffectsIfPresent(call) {
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
}
/** dry-run 预览：点「校验并预览计划」并等计划区在场；不可点时一次性转储三闸门诊断 */
async function previewAb(call) {
  const st = await findButton(call, "校验并预览计划");
  if (!(st.found && st.disabled === false)) {
    const store = await H.storeQ(
      call,
      `return JSON.stringify({
        frozen: s.isDraftFrozen(${DKEY}) === true,
        inFlight: s.modelAbInFlight === true,
        srcExec: s.canExecuteFromSource() === true,
        draft: s.modelAbDraftOf(${DKEY}) ?? null,
        err: s.modelAbError,
        errCode: s.modelAbErrorCode,
      });`,
    );
    const body = await bodyText(call);
    const markers = {};
    for (const m of [
      "来源失效",
      "本次执行待处理",
      "处理中…",
      "尚未配置运行参数",
      "与父 run 完全相同",
      "params 不是合法 JSON",
      "源记录不可用",
      "运行状态已改变",
    ]) {
      markers[m] = body.includes(m);
    }
    const amberRaw = await H.ev(
      call,
      `(() => JSON.stringify(Array.from(document.querySelectorAll('.text-amber-700,.text-amber-800'))
        .filter(x => x.offsetParent !== null).map(x => (x.textContent || '').trim()).filter(Boolean)))()`,
    );
    // storeQ 恒 JSON.parse（6.2 教训）：到手已是对象，绝不能再 parse 一次
    dump.previewBlocked = { button: st, store, markers, amber: JSON.parse(amberRaw) };
    throw new Error(`预览按钮不可点：${JSON.stringify(st)} diag=${JSON.stringify(store)}`);
  }
  await clickAbButton(call, "校验并预览计划");
  const deadline = Date.now() + 10000;
  for (;;) {
    const body = await bodyText(call);
    if (body.includes("校验通过 · 执行计划")) return;
    if (Date.now() > deadline) throw new Error("dry-run 计划 10s 未在场");
    await H.sleep(300);
  }
}
/** 确认 + 执行整批（提交身份从 draftSubmissions 捕获） */
async function executeAbBatch(call) {
  await confirmEditor(call);
  return submitAndCapture(call, "确认执行（", SUB_KEY);
}
/** 等登记收口且全部臂的可信 ID 到齐 */
async function waitForAbSettled(call, operationId, armCount, timeoutMs = 90000) {
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
}
async function waitForAbDraftGone(call, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = await abDraftOf(call);
    if (d === null) return true;
    if (Date.now() > deadline) return false;
    await H.sleep(500);
  }
}
/** 臂 meta 里的实验组标签（tolerant：fork.edit.experimentId 或 fork.edit.value.experimentId） */
const armExperimentId = (meta) =>
  meta?.fork?.edit?.experimentId ?? meta?.fork?.edit?.value?.experimentId ?? null;
const armParent = (meta) => meta?.parent ?? meta?.parentId ?? null;

// ---------------------------------------------------------------------------
// 各 tag
// ---------------------------------------------------------------------------

const FLOWS = {
  /** 「全部预期实验臂正常才清理整批」（evidence-index §M2 行 5）——批首跑，批次全新 */
  "ab-all-normal": async (call, mock) => {
    await openAbEditor(call);
    const d0 = await abDraftOf(call);
    check("打开即有批次草稿（初始两臂）", d0 !== null && d0.rows.length === 2, d0?.rows?.length);
    await setArmModel(call, 0, "U5-65-arm-a");
    await setArmModel(call, 1, "U5-65-arm-b");
    await acknowledgeSideEffectsIfPresent(call);
    const before = H.traceIds();
    const servedBefore = mock.served();
    await previewAb(call);
    check("预览后计划区在场（校验通过 · 执行计划）", (await bodyText(call)).includes("校验通过 · 执行计划"), null);
    const sub = await executeAbBatch(call);
    check(
      "提交身份已登记（operationId 非空）",
      typeof sub.operationId === "string" && sub.operationId.length > 0,
      sub.operationId ?? sub,
    );
    const reg = await waitForAbSettled(call, sub.operationId, 2);
    check(
      "登记收口且两臂可信 ID 到齐（outcome 均 returned）",
      reg?.state === "settled" &&
        (reg.arms ?? []).length === 2 &&
        (reg.arms ?? []).every((a) => a.id !== null && a.outcome === "returned"),
      reg ? { state: reg.state, arms: reg.arms } : null,
    );
    const added = await H.newChildren(before, 30000, 2);
    check("落盘恰 2 份新 trace（两臂）", added.length === 2, added);
    const fx = fixtureOf("successPlain");
    for (const id of added) {
      const facts = traceFacts(id);
      check(
        `臂 run 自有终止 = ${fx.expectedEvent}/${fx.expectedReason}（${id}）`,
        facts.event === fx.expectedEvent && facts.reason === fx.expectedReason,
        { event: facts.event, reason: facts.reason },
      );
    }
    const exps = added.map((id) => {
      const facts = traceFacts(id);
      return { id, exp: armExperimentId(facts.meta), parent: armParent(facts.meta) };
    });
    check(
      "两臂同批共享一个实验组 ID（fork.edit 落盘）",
      exps[0]?.exp != null && exps[0].exp === exps[1]?.exp,
      exps.map((e) => e.exp),
    );
    check(
      "实验组 ID 与登记一致（main 生成 ⇒ 三方同源）",
      reg?.experimentId != null && reg.experimentId === exps[0]?.exp,
      { reg: reg?.experimentId, trace: exps[0]?.exp },
    );
    check("两臂父本都是夹具 run", exps.every((e) => e.parent === PARENT_RUN), exps.map((e) => e.parent));
    const regIds = (reg.arms ?? []).map((a) => a.id).sort();
    check(
      "登记臂 id = 落盘 meta.id（逐臂身份三方一致）",
      JSON.stringify(regIds) === JSON.stringify(added.slice().sort()),
      { regIds, traces: added.slice().sort() },
    );
    for (const id of added) {
      const entry = await waitForVerified(call, reg.epoch, sub.operationId, id);
      check(`核实落地（verified，${id}）`, entry?.phase === "verified", entry?.phase);
    }
    check(
      "全部臂正常 ⇒ 整批一次清干净（批次草稿不再存在）",
      (await waitForAbDraftGone(call, 30000)) === true,
      null,
    );
    check(
      `每臂恰一次调用（served 增量 2）`,
      mock.served() - servedBefore === 2,
      mock.served(),
    );
    await H.shot(call, SHOT_DIR, `${TAG}-all-normal.png`);
  },

  /** 「实验缺臂部分失败与未核实保留整批」的实机半边（缺臂/null ID 归集成 fixture，不冒充实机） */
  "ab-partial-fail": async (call, mock) => {
    await openAbEditor(call);
    const d0 = await abDraftOf(call);
    check("前置：上一批已清 ⇒ 全新两臂批次", d0 !== null && d0.rows.length === 2, d0?.rows?.length);
    await setArmModel(call, 0, "U5-65-arm-a");
    await setArmModel(call, 1, "U5-65-arm-b");
    await acknowledgeSideEffectsIfPresent(call);
    const before = H.traceIds();
    const servedBefore = mock.served();
    await previewAb(call);
    const sub = await executeAbBatch(call);
    const reg = await waitForAbSettled(call, sub.operationId, 2);
    check(
      "登记收口：臂 1 returned、臂 2 failed（逐臂诚实，不从信封凑）",
      reg?.state === "settled" &&
        (reg.arms ?? []).length === 2 &&
        reg.arms[0]?.outcome === "returned" &&
        reg.arms[1]?.outcome === "failed" &&
        reg.arms.every((a) => a.id !== null),
      reg ? { state: reg.state, arms: reg.arms } : null,
    );
    const added = await H.newChildren(before, 30000, 2);
    check("落盘恰 2 份新 trace（失败臂也是完整 run）", added.length === 2, added);
    for (const arm of reg?.arms ?? []) {
      const facts = traceFacts(arm.id);
      if (arm.outcome === "returned") {
        check(
          `returned 臂自有终止 = stopped/completed（${arm.id}）`,
          facts.event === "stopped" && facts.reason === "completed",
          { event: facts.event, reason: facts.reason },
        );
      } else {
        check(
          `failed 臂自有终止 = errored/error（${arm.id}）`,
          facts.event === "errored" && facts.reason === "error",
          { event: facts.event, reason: facts.reason },
        );
        check(
          `failed 臂 llm 错误状态 = 503（${arm.id}）`,
          facts.firstLlmError?.status === 503,
          facts.firstLlmError?.status,
        );
      }
    }
    for (const arm of reg?.arms ?? []) {
      const entry = await waitForVerified(call, reg.epoch, sub.operationId, arm.id);
      check(`核实落地（verified，${arm.id}）`, entry?.phase === "verified", entry?.phase);
    }
    const d1 = await abDraftOf(call);
    check("部分失败 ⇒ 整批保留（批次草稿仍在）", d1 !== null && d1.rows.length === 2, d1?.rows?.length);
    check(
      "草稿保留原文（两臂 model 原样）",
      d1?.rows?.[0]?.model === "U5-65-arm-a" && d1?.rows?.[1]?.model === "U5-65-arm-b",
      (d1?.rows ?? []).map((r) => r.model),
    );
    const fr = await abFrozenOf(call);
    check("收口后解冻（批次可继续编辑/放弃）", fr?.frozen === false, fr);
    const body = await bodyText(call);
    check("批次结果区已收口（statusLabel 在场）", body.includes("已收口"), null);
    check("收口语义逐臂诚实（缺臂与失败臂原样保留）", body.includes("收口不等于全部成功"), null);
    check("每臂恰一次调用（served 增量 2）", mock.served() - servedBefore === 2, mock.served());
    await H.shot(call, SHOT_DIR, `${TAG}-partial.png`);
  },

  /** 「实验确认使用当前预览计划」（A1.4）——确认绑定计划，改臂作废，重新预览重挂 */
  "ab-plan-confirm": async (call, mock) => {
    await openAbEditor(call);
    const d0 = await abDraftOf(call);
    check(
      "打开后批次为两臂（model_ab 批次草稿是会话内存态：reload 后回基线，见 rows-restore 印证）",
      d0 !== null && d0.rows.length === 2,
      d0?.rows?.length,
    );
    const servedBefore = mock.served();
    const tracesBefore = H.traceIds().size;
    await setArmModel(call, 0, "U5-65-arm-c1");
    await setArmModel(call, 1, "U5-65-arm-c2");
    // 父本首调带 write_file（sideEffect 未标 false）⇒ guard 要求副作用声明（6.4 的 acknowledge 同款）
    await acknowledgeSideEffectsIfPresent(call);
    await previewAb(call);
    const body = await bodyText(call);
    check("预览后计划区在场（校验通过 · 执行计划）", body.includes("校验通过 · 执行计划"), null);
    check("计划区带实验组 ID", body.includes("实验组 "), null);
    // 分支互斥字面量排除（与 6.4 的前缀过滤同纪律）：
    // - 已勾副作用 ⇒ 渲染"已放行"分支，"未放行"分支不在场；
    // - normalRun 首调自带 params（temperature 0.7）⇒ 计划行渲染生效参数，"沿用父参数"字面量不在场。
    const phrases = disclosurePhrases("abDisclosure").filter(
      (p) =>
        !p.startsWith("已放行") &&
        !p.startsWith("未放行") &&
        p !== "（沿用父 run 的采样参数）",
    );
    dump.abPhrases = phrases;
    const missing = phrases.filter((p) => !body.includes(p));
    check(
      "A/B 披露静态短语全部在场（lib 同源抽取）",
      missing.length === 0,
      { missing: missing.slice(0, 4), total: phrases.length },
    );
    check("无计划分支不在场（计划已取得）", !body.includes("尚未取得当前批次的计划"), null);
    const c1 = await abConfirmedOf(call);
    check("确认前未挂（基线）", c1?.confirmed === false, c1);
    await confirmEditor(call);
    const c2 = await abConfirmedOf(call);
    check("确认可挂上（绑定当前预览计划）", c2?.confirmed === true, c2);
    // 改臂 ⇒ 批次修订推进 ⇒ 旧计划与旧确认一并作废（commitRows 同时重置副作用许可 ⇒ 须重新勾选）
    await setArmModel(call, 0, "U5-65-arm-c1-x");
    await acknowledgeSideEffectsIfPresent(call);
    const c3 = await abConfirmedOf(call);
    check("改臂 ⇒ 旧确认作废（不再绑定旧修订的计划）", c3?.confirmed === false, c3);
    const conf = await findButton(call, "已核对，确认执行实验");
    const confAlt = await findButton(call, "已确认执行实验");
    const confNow = conf.found ? conf : confAlt;
    check(
      "改臂 ⇒ 确认按钮回到未挂态（aria-pressed 非 true）",
      confNow.found === false || confNow.disabled !== undefined,
      { conf, confAlt },
    );
    const exec = await findButton(call, "确认执行（");
    check("改臂 ⇒ 执行按钮禁用（activePlan 已失效）", exec?.found === true && exec.disabled === true, exec);
    // 重新预览 ⇒ 新计划 fresh ⇒ 确认可重新挂上
    await previewAb(call);
    check("重新预览 ⇒ 新计划在场", (await bodyText(call)).includes("校验通过 · 执行计划"), null);
    await confirmEditor(call);
    const c4 = await abConfirmedOf(call);
    check("重新预览 ⇒ 确认可重新挂上", c4?.confirmed === true, c4);
    check("全程零模型调用（dry-run 只读通道）", mock.served() - servedBefore === 0, mock.served());
    check("零新 trace（预览不落盘）", H.traceIds().size === tracesBefore, H.traceIds().size);
  },

  /** 「实验预览和结果不隐式清理批次」（A4.2）——dry-run 不写不清不登记不消费 */
  "ab-no-implicit-clear": async (call, mock) => {
    await openAbEditor(call);
    const d0 = await abDraftOf(call);
    check(
      "打开后批次为两臂（reload 后回基线 ⇒ 先改臂+勾副作用，否则双臂空 fork 必被 guard 拦）",
      d0 !== null && d0.rows.length === 2,
      d0?.rows?.length,
    );
    const servedBefore = mock.served();
    const tracesBefore = H.traceIds().size;
    const opsBefore = await opsCount(call);
    await setArmModel(call, 0, "U5-65-arm-d1");
    await setArmModel(call, 1, "U5-65-arm-d2");
    await acknowledgeSideEffectsIfPresent(call);
    const before = await abDraftOf(call);
    await previewAb(call);
    check("预览后计划在场", (await bodyText(call)).includes("校验通过 · 执行计划"), null);
    const after = await abDraftOf(call);
    check("预览不推进批次修订（revision 不变）", after?.revision === before?.revision, {
      before: before?.revision,
      after: after?.revision,
    });
    check(
      "预览不改批次内容（rows 逐字不变）",
      JSON.stringify(after?.rows) === JSON.stringify(before?.rows),
      null,
    );
    const opsAfter = await opsCount(call);
    check("dry-run 不登记新关联（operations 数不变）", opsAfter === opsBefore, {
      before: opsBefore,
      after: opsAfter,
    });
    check("预览零消费（served 不变）", mock.served() - servedBefore === 0, mock.served());
    check("预览零落盘（零新 trace）", H.traceIds().size === tracesBefore, H.traceIds().size);
  },

  /** 「实验臂增删和非法参数可恢复」（A6.3）——批次草稿往返逐字恢复 + 行 ID 稳定 */
  "ab-rows-restore": async (call, mock) => {
    await openAbEditor(call);
    const d0 = await abDraftOf(call);
    check(
      "打开后批次为两臂（model_ab 批次草稿是会话内存态：reload 后回基线）",
      d0 !== null && d0.rows.length === 2,
      d0?.rows?.length,
    );
    const servedBefore = mock.served();
    const tracesBefore = H.traceIds().size;
    const inheritedModels = (d0?.rows ?? []).map((r) => r.model);
    // 臂 2 params 改成非法 JSON 文本（逐字保留的对象）
    await setArmParams(call, 1, `{"temperature": `);
    // 加第三臂（默认 = 父 model；本 tag 不提交，guard 拦不拦无关）
    await clickAbButton(call, "+ 加一臂");
    const d1 = await abDraftOf(call);
    check("编辑后批次为 3 行", d1?.rows?.length === 3, d1?.rows?.length);
    const keysBefore = (d1?.rows ?? []).map((r) => r.key);
    check(
      "非法 params 原文落草稿",
      d1?.rows?.[1]?.paramsText === `{"temperature": `,
      JSON.stringify(d1?.rows?.[1]?.paramsText),
    );
    // 收起（保留批次草稿）→ 重开
    await H.clickByTextChecked(call, "收起", 2000);
    const entry = await findButton(call, "模型 A/B 实验（");
    check("收起后入口按钮回场", entry?.found === true, entry);
    await clickAbButton(call, "模型 A/B 实验（");
    const d2 = await abDraftOf(call);
    check("重开不覆盖已有批次（仍 3 行）", d2?.rows?.length === 3, d2?.rows?.length);
    check(
      "行 ID 稳定（重开前后 key 一致）",
      JSON.stringify((d2?.rows ?? []).map((r) => r.key)) === JSON.stringify(keysBefore),
      { before: keysBefore, after: (d2?.rows ?? []).map((r) => r.key) },
    );
    check(
      "非法 params 逐字恢复",
      d2?.rows?.[1]?.paramsText === `{"temperature": `,
      JSON.stringify(d2?.rows?.[1]?.paramsText),
    );
    check(
      "继承的 model 逐字保留（未被重开覆盖）",
      d2?.rows?.[0]?.model === inheritedModels[0] && d2?.rows?.[1]?.model === inheritedModels[1],
      { inherited: inheritedModels, after: (d2?.rows ?? []).map((r) => r.model) },
    );
    const rmRaw = await H.ev(
      call,
      `(() => JSON.stringify(Array.from(document.querySelectorAll('button'))
        .filter(x => x.offsetParent !== null && (x.title || '') === '移除该臂').length))()`,
    );
    check("超过两臂 ⇒ 逐行移除按钮在场（3 个）", JSON.parse(rmRaw) === 3, rmRaw);
    check(
      "全程零消费零落盘",
      mock.served() - servedBefore === 0 && H.traceIds().size === tracesBefore,
      { served: mock.served(), traces: H.traceIds().size },
    );
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
  for (let i = 0; i < 40; i++) {
    await H.sleep(500);
    try {
      if ((await H.runs(call)).length > 0) break;
    } catch {
      /* 重载瞬间 */
    }
  }
  await H.sleep(900);

  let mock = null;
  for (let attempt = 0; attempt < 2 && mock === null; attempt++) {
    try {
      mock = await H.prepare(call, TAG_SCRIPT[TAG]);
    } catch (e) {
      if (attempt > 0 || !String(e).includes("Failed to fetch")) throw e;
      console.log(`[prepare] 模块加载失败，reload 后重试一次`);
      await call("Page.reload", { ignoreCache: true });
      for (let i = 0; i < 40; i++) {
        await H.sleep(500);
        try {
          if ((await H.runs(call)).length > 0) break;
        } catch {
          /* 重载瞬间 */
        }
      }
      await H.sleep(900);
    }
  }
  try {
    await FLOWS[TAG](call, mock);
  } catch (e) {
    check(`tag 执行异常：${String(e?.message ?? e).slice(0, 300)}`, false);
  } finally {
    await H.teardown(call, mock);
  }
  finish({ expectedCalls: EXPECTED_CALLS[TAG] });
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), String(e?.stack ?? e));
  process.exit(1);
});
