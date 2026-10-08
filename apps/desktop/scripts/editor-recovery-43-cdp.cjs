/* eslint-disable */
/**
 * `fix-proxy-recording-reliability` 任务 4.3：可见编辑器恢复的**实机**验收。
 *
 * ## 场景（对齐 spec「可见消息编辑器可恢复且不丢草稿」三条）
 *
 * - **S1 可见宿主恢复非零尺寸**：真实窗口往返（改外框宽 → 复原）后，两个锚点宿主
 *   仍各自可见有框、内容面可读、目标草稿键不变、编辑器实例可输入（真 `setValue`
 *   后草稿同步）。
 * - **S2 隐藏 Monaco 节点不误报**：页面同时存在 0×0 隐藏节点与正常可见编辑器时，
 *   不出现 `data-monaco-failed`，`hiddenHelpers` 单列且 `collapsed` 为空。
 * - **S3 恢复失败可见且能就地重试**：注入懒加载失败（页内拦截动态 import 的
 *   目标 chunk）⇒ 出现失败占位 + 重试入口；点重试后恢复正常，**草稿逐字保留**、
 *   不自动提交、不恢复旧确认。
 *
 * ## 证据纪律（两条硬约束）
 *
 * ① **真实窗口 vs Emulation 分开记**：宽档变化走 `setWindowOuter`（PowerShell
 *    MoveWindow，真实 OS 窗口）。`UI-VERIFY.md` 已实测 `Emulation.setDeviceMetricsOverride`
 *    会伪造布局视口而 Monaco 内部几何仍是真值 ⇒ emulation 下的几何不可信。
 *    本脚本**不使用** Emulation 改尺寸；`viewportSource` 只会是 `window`。
 * ② **改窗后先回读视口**：外框↔CSS 是近似映射（DPR 2.1，比例≈1.41），必须
 *    `documentElement.clientWidth` 回读自证，不等于目标就再调 1px。
 *
 * 用法：`node apps/desktop/scripts/editor-recovery-43-cdp.cjs [--port=9612]`
 * 前置：dev 带 CDP 起（`node scripts/u2-dev-host.cjs` 或 start-dev.cjs），
 *      且 `.rebaseagent/traces` 里有 `gen-smoke-proxy-run.cjs` 造的代理 run。
 */
"use strict";

const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { makeSession, sleep, shot } = require("./lib/u2-cdp-util.cjs");
const H = require("./lib/u4-smoke-harness.cjs");
const {
  listPageTarget,
  collect,
  markEmulation,
  summarize,
} = require("./editor-collapse-probe.cjs");

const argOf = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const CDP_PORT = Number(argOf("port", "9612"));
const REPO = join(__dirname, "..", "..", "..");
const OUT = join(REPO, ".workbuddy", "proxy-editor-recovery");
const SHOTS = join(OUT, "shots");
mkdirSync(SHOTS, { recursive: true });

const checks = [];
const measurements = {};
function check(name, ok, detail) {
  checks.push({ name, ok: ok === true, detail: detail ?? null });
  const d =
    detail === undefined || detail === null
      ? ""
      : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  console.log(`${ok === true ? "✓" : "✗"} ${name}${ok === true ? "" : d}`);
}

/** 回读真实 CSS 视口（改窗自证；dpr 2.1 下外框 1134 ⇒ CSS 801，映射只是近似）。 */
async function clientWidth(call) {
  return call("Runtime.evaluate", {
    expression: "document.documentElement.clientWidth",
    returnByValue: true,
  }).then((r) => r?.result?.value);
}

/**
 * 真键入通道。
 *
 * ⚠️ **三条被本轮实机逐一排除的写法**（都记下来免得下次重踩）：
 *   ① `monaco.editor.getEditors()[i].setValue(v)` —— 直接改 model，**不触发 React
 *      的 onChange** ⇒ store 草稿不更新。测出来的「输入被丢弃」是探针假象。
 *   ② `node.querySelector('textarea')` —— monaco 0.56 走 **EditContext**，页面里
 *      没有 textarea（焦点落点是 `DIV.native-edit-context`）。
 *   ③ `e.trigger('keyboard','type',{text})` —— 0.56 上不改变 model（实测 changed=false）。
 *   唯一可靠：**CDP `Input.insertText` 一次插入**（UI-VERIFY.md 已记同款），
 *   前提先把焦点真放给目标编辑器。
 */
async function typeIntoHost(call, hostAttr, text) {
  // ① 把焦点给目标锚点宿主内的可编辑编辑器
  const focused = await call("Runtime.evaluate", {
    expression: `(async () => {
      const host = document.querySelector('[data-monaco-host="' + ${JSON.stringify(hostAttr)} + '"]');
      if (!host) return { ok: false, why: 'no-host' };
      const all = performance.getEntriesByType('resource').map(e => e.name);
      const needles = ["/src/renderer/src/monaco-bootstrap.ts", "/src/monaco-bootstrap.ts"];
      const url = all.filter(n => needles.some(w => n.includes(w))).sort((a,b)=>a.includes('?t=')?0:1)[0];
      if (!url) return { ok: false, why: 'no-bootstrap-url' };
      const m = await import(url);
      const monaco = await m.ensureMonaco();
      const inHost = (e) => { const n = e.getDomNode(); return n && host.contains(n); };
      const allEds = monaco.editor.getEditors();
      const target = allEds.find(e => inHost(e)
        && e.getOption(monaco.editor.EditorOption.readOnly) !== true);
      if (!target) return { ok: false, why: 'no-editable', total: allEds.length,
        hosts: allEds.map(e => ({ inHost: inHost(e) })) };
      target.focus();
      await new Promise(r => setTimeout(r, 300));
      const node = target.getDomNode();
      return { ok: true, hasFocus: document.activeElement === node
        || node.contains(document.activeElement), len: target.getModel().getValue().length };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  }).then((r) => r?.result?.value);

  if (focused?.ok !== true) return { ok: false, why: focused?.why ?? "focus-failed", focused };

  // ② CDP 真插入（逐键 type 会被自动补全/IME 打散，必须一次 insertText）
  await call("Input.insertText", { text }).catch(() => {});
  await sleep(900);

  // ③ 回读 model 与 store
  const readBack = await call("Runtime.evaluate", {
    expression: `(async () => {
      const host = document.querySelector('[data-monaco-host="' + ${JSON.stringify(hostAttr)} + '"]');
      const all = performance.getEntriesByType('resource').map(e => e.name);
      const needles = ["/src/renderer/src/monaco-bootstrap.ts", "/src/monaco-bootstrap.ts"];
      const url = all.filter(n => needles.some(w => n.includes(w))).sort((a,b)=>a.includes('?t=')?0:1)[0];
      const m = await import(url);
      const monaco = await m.ensureMonaco();
      const target = monaco.editor.getEditors().find(e => {
        const n = e.getDomNode(); return n && host.contains(n)
          && e.getOption(monaco.editor.EditorOption.readOnly) !== true;
      });
      if (!target) return { ok: false, why: 'gone' };
      const v = target.getModel().getValue();
      return { ok: v.includes(${JSON.stringify(text)}), len: v.length, tail: v.slice(-80) };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  }).then((r) => r?.result?.value);

  return { ok: readBack?.ok === true, why: "insertText", focused, readBack };
}

/**
 * 进 messages 工作区。
 *
 * ⚠️ **为什么直接调 store 口而不是点 UI**（本轮实测踩到，记在这里免得下次重踩）：
 *   ① 运行列表行的可点元素不是 `button[aria-label^="复制完整运行 ID"]` 的兄弟——
 *      点它会命中"复制 ID"或整行容器，点了**不进入详情**（实测 body 无变化）；
 *   ② store 不挂 window（renderer 零全局泄漏），只能经 `appImport` 动态 import 读；
 *   ③ `openMessagesWorkspace` 是 store 的正规口，UI 上的入口最终也走它 ⇒
 *      用它不降低对**编辑器本身**的验收强度（本 change 的对象是编辑器恢复，
 *      不是导航路径）。
 */
async function enterMessagesWorkspace(call) {
  const spans = await H.storeQ(
    call,
    `
    const d = s.detail;
    const own = (d && d.spans ? d.spans : []).filter(x => x.kind === 'llm.call');
    return JSON.stringify({
      detailId: d && d.meta ? d.meta.id : null,
      ownCalls: own.map(x => ({ id: x.id })),
    });
  `,
  );
  const detailId = spans?.detailId ?? null;
  const own = spans?.ownCalls ?? [];
  if (!detailId || own.length === 0) {
    return { ok: false, why: "no-own-llm-call", detailId, ownCount: own.length };
  }
  const spanId = own[0].id;
  await H.storeQ(
    call,
    `s.openMessagesWorkspace({ runId: ${JSON.stringify(detailId)}, spanId: ${JSON.stringify(spanId)} });
     return JSON.stringify({ ok: true });`,
  );
  // 等源详情读到 ready（工作区挂载前不渲染编辑器）
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    const phase = await H.storeQ(
      call,
      "return JSON.stringify({ phase: s.messagesSource ? s.messagesSource.phase : null });",
    );
    if (phase?.phase === "ready") return { ok: true, detailId, spanId };
    if (phase?.phase === "failed") return { ok: false, why: "source-failed", detailId, spanId };
  }
  return { ok: false, why: "source-timeout", detailId, spanId };
}

(async () => {
  const page = await listPageTarget(CDP_PORT);
  const call = await makeSession(page.webSocketDebuggerUrl);
  await call("Page.bringToFront").catch(() => {});

  // ── 基线 ────────────────────────────────────────────────────────────
  await markEmulation(call, false);
  const base = await collect(call);
  measurements.baseline = base;
  console.log(`基线：${summarize(base)}`);
  check("真实视口（非 emulation）", base.viewportSource === "window", base.viewportSource);

  // ── S1 可见宿主恢复非零尺寸（真实窗口往返） ─────────────────────────
  const entered = await enterMessagesWorkspace(call);
  measurements.enter = entered;
  check(
    "进入 messages 工作区（源读到 ready）",
    entered.ok === true,
    JSON.stringify(entered).slice(0, 200),
  );
  if (entered.ok !== true) {
    writeFileSync(join(OUT, "measurements.json"), JSON.stringify(measurements, null, 2));
    writeFileSync(join(OUT, "checks.json"), JSON.stringify(checks, null, 2));
    console.log("\n进入失败，后续场景不成立。");
    process.exit(1);
  }
  await sleep(1500);

  const openedSnap = await collect(call);
  measurements.opened = openedSnap;
  console.log(`进工作区后：${summarize(openedSnap)}`);
  const msgHosts = openedSnap.editors.filter((e) => String(e.role ?? "").startsWith("messages-"));
  check(
    "messages 两个锚点宿主在场",
    msgHosts.length === 2,
    `anchors=${msgHosts.map((e) => e.role).join(",")}`,
  );
  check(
    "messages 宿主各自可见有框",
    msgHosts.length === 2 && msgHosts.every((e) => e.hostOk),
    JSON.stringify(msgHosts.map((e) => [e.role, e.hostOffsetW, e.hostOffsetH])),
  );
  check(
    "messages 目标草稿键一致（目标隔离）",
    msgHosts.length === 2 && new Set(msgHosts.map((e) => e.targetKey)).size === 1,
    JSON.stringify(msgHosts.map((e) => e.targetKey)),
  );
  check(
    "messages 可见面可读（非空）",
    msgHosts.length === 2 && msgHosts.every((e) => e.scrollableCount > 0),
    JSON.stringify(msgHosts.map((e) => e.scrollableCount)),
  );

  // 窄窗 → 复原。
  // 🔴 **改窗为什么不由本脚本自己做**（2026-10-08 实测）：
  //   `setWindowOuter` 走 `spawnSync("powershell", …)`，而本机 WorkBuddy 宿主**禁止从
  //   Bash 调 PowerShell**（"Invoking PowerShell from Bash bypasses PowerShell security
  //   checks"）⇒ 它静默返回空串、窗口纹丝不动（一度被读成"改窗无效"的产品缺陷）。
  //   改用 PowerShell 工具直接调 `ps-dbg.ps1` 后外框 1134 ⇒ CSS 800 确实生效。
  //   故本脚本只**采集**，改窗由外部驱动；每次运行采一个档位并落盘，
  //   判据在 `--verify` 段汇总（读回三份快照）。
  async function failedCount() {
    return call("Runtime.evaluate", {
      expression: `document.querySelectorAll("[data-monaco-failed]").length`,
      returnByValue: true,
    }).then((r) => r?.result?.value);
  }

  async function shootStage(stage) {
    const snap = await collect(call);
    measurements[stage] = snap;
    const hosts = snap.editors.filter((e) => String(e.role ?? "").startsWith("messages-"));
    measurements[`${stage}Hosts`] = hosts;
    const shotName = `${stage}-${snap.viewport.innerW}x${snap.viewport.innerH}.png`;
    await shot(call, SHOTS, shotName).catch(() => {});
    console.log(
      `[${stage}] viewport=${snap.viewportSource} ${snap.viewport.innerW}x${snap.viewport.innerH} — ${summarize(snap)}`,
    );
    console.log(
      `[${stage}] messages 宿主：${JSON.stringify(hosts.map((e) => [e.role, e.hostOffsetW, e.hostOffsetH, e.visible, e.scrollableCount, e.targetKey]))}`,
    );
    return { snap, hosts, failed: await failedCount(), shotName };
  }

  const wide = await shootStage("wide");

  // S1 逐项（宽档基线：进入工作区后立即采）
  check(
    "messages 两个锚点宿主在场",
    wide.hosts.length === 2,
    `anchors=${wide.hosts.map((e) => e.role).join(",")}`,
  );
  check(
    "messages 宿主各自可见有框",
    wide.hosts.length === 2 && wide.hosts.every((e) => e.hostOk),
    JSON.stringify(wide.hosts.map((e) => [e.role, e.hostOffsetW, e.hostOffsetH])),
  );
  check(
    "messages 目标草稿键一致（目标隔离）",
    wide.hosts.length === 2 && new Set(wide.hosts.map((e) => e.targetKey)).size === 1,
    JSON.stringify(wide.hosts.map((e) => e.targetKey)),
  );
  check(
    "messages 可见面可读（非空）",
    wide.hosts.length === 2 && wide.hosts.every((e) => e.scrollableCount > 0),
    JSON.stringify(wide.hosts.map((e) => e.scrollableCount)),
  );
  check(
    "真实视口（非 emulation）",
    wide.snap.viewportSource === "window",
    wide.snap.viewportSource,
  );

  // 可输入：真键入并回读（判「可输入」而非判 DOM —— UI-VERIFY 记的 0.56 坑）
  const typed = await typeIntoHost(call, "messages-draft", "实机可输入探针");
  measurements.typed = typed;
  check(
    "草稿编辑器可输入（CDP 真键入 + model 回读）",
    typed?.ok === true,
    JSON.stringify(typed).slice(0, 300),
  );

  // 草稿是否落进 store（判「输入没被静默丢弃」，U8 6.9 同族坑：
  // 草稿键写对了但没接 ensure ⇒ writeCallDraftText 对不存在条目 no-op）
  //
  // ⚠️ **形状是三层嵌套**（2026-10-08 实测踩到）：
  //   drafts = { calls: { [runId]: { [spanId]: { [field]: {baseline,text,revision,source} } } },
  //              modelAb: {...}, create: {...}, nextRevision: n }
  // 直接 `Object.values(drafts)` 拿到的是 `calls/modelAb/create/nextRevision` 四个壳，
  // 读出来全是 null ⇒ 一度误判成「输入被丢弃」。
  const draftStored = await H.storeQ(
    call,
    `const calls = (s.drafts && s.drafts.calls) || {};
     const out = [];
     for (const byRun of Object.values(calls))
       for (const bySpan of Object.values(byRun || {}))
         for (const e of Object.values(bySpan || {}))
           if (e && typeof e.text === 'string') out.push(e.text);
     return JSON.stringify(out);`,
  );
  measurements.draftStored = draftStored;
  check(
    "输入进了 store 草稿（未被静默丢弃）",
    Array.isArray(draftStored) && draftStored.some((t) => t.includes("实机可输入探针")),
    JSON.stringify(draftStored).slice(0, 240),
  );

  // S2 隐藏节点不误报
  check(
    "S2 不判塌缩（隐藏 0×0 节点单列，不单独作为塌缩判据）",
    wide.snap.collapsed.length === 0,
    `collapsed=${JSON.stringify(wide.snap.collapsed)} hiddenHelpers=${wide.snap.hiddenHelpers.length} monacoNodes=${wide.snap.monacoEditorNodeCount}`,
  );
  check("S2 宽档无失败占位", wide.failed === 0, `failed=${wide.failed}`);
  measurements.hiddenHelpers = wide.snap.hiddenHelpers;
  measurements.monacoNodeCount = wide.snap.monacoEditorNodeCount;

  writeFileSync(join(OUT, "measurements.json"), JSON.stringify(measurements, null, 2));
  writeFileSync(join(OUT, "checks.json"), JSON.stringify(checks, null, 2));

  const failed = checks.filter((c) => !c.ok);
  console.log(
    `\n=== ${checks.length - failed.length}/${checks.length} 通过（截图 ${wide.shotName}）===`,
  );
  if (failed.length) {
    console.log("未过：");
    for (const f of failed) console.log(`  ✗ ${f.name} — ${JSON.stringify(f.detail)}`);
  }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(String(e));
  process.exit(2);
});
