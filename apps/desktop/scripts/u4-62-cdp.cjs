/* eslint-disable */
/**
 * U4 任务 6.2：受控服务实测**普通/隔离 result 与 prompt**——切页面后核对登记与草稿，
 * 并回归授权 / 父链 / 轮末门禁。
 *
 * 覆盖 delta 场景（`specs/desktop-ui/spec.md` 逐字标题）：
 * - `所有入口实际使用同一适配器`：真 UI 提交 ⇒ main 同一登记（全局入口可查）；
 *   在飞期间切页卸载编辑器 ⇒ 不重发、不解冻；列表刷新不删登记。
 * - `提交快照独立于编辑器挂载`：切页后草稿原样、重开编辑器=提交快照。
 * - `分叉在已知身份后异常仍可关联`：写 meta 后模型 503 ⇒ 登记仍带真实新 ID。
 * - `核对结果只由用户明确打开`：「核对状态」不导航 / 「打开记录」才切页面。
 * - 隔离面三条原门禁：未预检 / 未授权 / 空 fork，外加重开授权复位。
 *
 * 判据口径（与 6.1 同纪律）：真 UI（真点击 + 真 Monaco 键入 + 真 store + 真原生确认），
 * 提交值以落盘 `fork.edit.value` 与受控服务收到的请求核对，不看界面自述；
 * 「只执行一次」= 服务请求增量 1 **且** traces 文件增量 1；
 * 在飞窗口由受控服务 `delayMs` 造出来（毫秒级返回点不出「切页时仍在飞」）；
 * 登记事实一律读 main 的 `operations:status`（renderer 会话只作对照，不当真相源）。
 *
 * 用法：`node apps/desktop/scripts/u4-62-cdp.cjs --tag=<result-nav|prompt-nav|isolated-gates|error-identity>`
 */
"use strict";
const { mkdirSync, writeFileSync, readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");

const TAGS = ["result-nav", "prompt-nav", "isolated-gates", "error-identity"];
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag");
if (!TAGS.includes(TAG)) {
  console.error(`用法：--tag=<${TAGS.join("|")}>`);
  process.exit(2);
}

const OUT_DIR = join(H.REPO, ".workbuddy", "u4", "u4-62");
const SHOT_DIR = join(H.REPO, "docs", "reviews", "2026-09-26-u4-62");
const MANIFEST = join(H.REPO, ".workbuddy", "u3", "u3-61", "manifest.json");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });

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
  const failed = checks.filter((c) => !c.ok);
  writeFileSync(
    join(OUT_DIR, `${TAG}-measurements.json`),
    JSON.stringify({ tag: TAG, checks, failed: failed.length, dump }, null, 2),
  );
  console.log(`检查 ${checks.length} 条，失败 ${failed.length} 条；证据 ${SHOT_DIR}`);
  clearTimeout(watchdog);
  process.exit(failed.length === 0 ? 0 : 1);
}
/**
 * 看门狗（U3 6.6 同纪律）：CDP 半开时 `await` 永不 settle ⇒ 事件轮排空、
 * 进程以退出码 0 静默结束——判红信息全丢。超预算直接判 exit 3，不交给"看起来通过"。
 */
const watchdog = setTimeout(() => {
  console.error(`看门狗：${TAG} 超过 10 分钟未收尾 ⇒ 判失败退出`);
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), "watchdog timeout");
  process.exit(3);
}, 600_000);

// ---------------------------------------------------------------------------
// U4 专用读数
// ---------------------------------------------------------------------------
/** 在飞窗口：6s（受控服务 delayMs） */
const SLOW_TURN = { delayMs: 6000, content: "受控响应：本轮结束，不再调用工具。" };
// 失败注入也带短延迟：毫秒级返回会让「捕获本次关联身份」的轮询扑空（U3 6.3 同坑）
const FAIL_TURN = {
  mode: "fail",
  status: 503,
  delayMs: 1500,
  errorBody: { error: { message: "冒烟注入：模型不可用" } },
};

const opsStatus = (call) => H.apiCall(call, "operationsStatus");
const recordOf = async (call, operationId) => {
  const st = await opsStatus(call);
  const rec = (st?.data?.operations ?? []).find((o) => o.operationId === operationId) ?? null;
  return { rec, slot: st?.data?.activeOperationId ?? null, epoch: st?.data?.epoch ?? null };
};
/** renderer 会话（对照用：证明界面与 main 同源，不是第二条真相） */
const opsSession = (call) =>
  H.storeQ(
    call,
    `return JSON.stringify({
        epoch: s.operations.epoch, activeOperationId: s.operations.activeOperationId,
        unknown: s.operations.unknown,
        pending: s.operations.pending.map(p => p.operationId),
       });`,
  );
/** 关联身份（U4 4.2 起 DraftSubmission 带 epoch/operationId） */
const submissionsU4 = (call) =>
  H.storeQ(
    call,
    `const ids = Object.keys(s.draftSubmissions.byId).map((k) => {
         const x = s.draftSubmissions.byId[k];
         return { id: k, channel: x.channel, operationId: x.operationId, epoch: x.epoch };
       });
     return JSON.stringify({ ids });`,
  );
const navState = (call) =>
  H.storeQ(
    call,
    `return JSON.stringify({
        selectedRunId: s.selectedRunId,
        detailId: s.detail === null ? null : s.detail.meta.id,
        detailLines: s.detail === null ? 0 : s.detail.spans.length,
       });`,
  );
/** 界面门禁：导入真实现 `deriveEntryGate`，会话数据从 store 现取（不复制判据） */
async function entryGate(call) {
  const session = await H.storeQ(call, "return JSON.stringify(s.operations);");
  // Vite root = renderer ⇒ 同一模块有两种被请求到的 URL（/src/lib/… 与 /src/renderer/src/lib/…）
  return H.appImport(
    call,
    ["/src/renderer/src/lib/entry-gate.ts", "/src/lib/entry-gate.ts"],
    `return JSON.stringify(m.deriveEntryGate(${JSON.stringify(session)}));`,
  );
}
const buttonState = async (call, textExact) =>
  JSON.parse(
    (await H.ev(
      call,
      `(() => { const b = Array.from(document.querySelectorAll('button'))
          .find(x => (x.textContent||'').trim() === ${JSON.stringify(textExact)});
        return JSON.stringify(b === null ? null : { disabled: b.disabled, title: b.title }); })()`,
    )) ?? "null",
  );
async function waitForText(call, text, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const has = await H.ev(
      call,
      `(() => document.body.innerText.includes(${JSON.stringify(text)}))()`,
    );
    if (has === true) return true;
    if (Date.now() > deadline) return false;
    await H.sleep(400);
  }
}
/**
 * 打开全局栏操作入口（**幂等**：入口按钮是开关，已展开时再点会收起——
 * 上一版就是这么把「核对后再看一眼」测成了「登记消失」的假故障）。
 */
async function openOperationsPanel(call) {
  const expanded = await H.ev(
    call,
    `(() => { const b = document.querySelector('button[aria-controls="operations-panel"]');
       if (b === null) throw new Error('操作入口按钮不存在');
       return b.getAttribute('aria-expanded'); })()`,
  );
  if (expanded !== "true") {
    await H.ev(
      call,
      `(() => { document.querySelector('button[aria-controls="operations-panel"]').click(); return true; })()`,
    );
    await H.sleep(900);
  }
  const text = await H.ev(
    call,
    `(() => { const p = document.querySelector('#operations-panel');
      return p === null ? null : p.innerText.slice(0, 4000); })()`,
  );
  if (typeof text !== "string") throw new Error("操作面板未展开（读不到 #operations-panel）");
  return text;
}
async function clickRowAction(call, needle, actionText) {
  await openOperationsPanel(call);
  const out = await H.ev(
    call,
    `(() => { const li = Array.from(document.querySelectorAll('#operations-panel li'))
        .find(x => (x.textContent||'').includes(${JSON.stringify(needle)}));
      if (li === undefined) return JSON.stringify({ found: false });
      const b = Array.from(li.querySelectorAll('button'))
        .find(x => (x.textContent||'').trim() === ${JSON.stringify(actionText)});
      if (b === undefined) return JSON.stringify({ found: true, button: false });
      b.click(); return JSON.stringify({ found: true, button: true }); })()`,
  );
  await H.sleep(1200);
  return JSON.parse(out);
}

/**
 * 点击提交并**在页内同一次求值里捕获本次关联身份**（epoch/operationId）。
 * 受控服务毫秒级返回，harness 侧「点完再查」会扑空（U3 6.3 实测）；
 * `duringFlight` 非空 ⇒ 关联一出现就先做那次 DOM 动作（切页签 = 卸载编辑器），
 * 再从 store 二次读同一关联 ⇒ 「切页时仍在飞」与「卸载不换关联」都是实测。
 */
async function submitAndCapture(
  call,
  buttonText,
  key,
  { duringFlight = null, pollMs = 9000 } = {},
) {
  const r = await call("Runtime.evaluate", {
    expression: `(async () => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(x => ((x.textContent||'').trim()).includes(${JSON.stringify(buttonText)}));
      if (!btn) return JSON.stringify({ error: 'button-not-found' });
      if (btn.disabled) return JSON.stringify({ error: 'button-disabled' });
      btn.click();
      let flightDone = false;
      const deadline = Date.now() + ${pollMs};
      for (;;) {
        const all = performance.getEntriesByType('resource').map(e => e.name);
        const url = all.filter(n => n.includes('/src/renderer/src/store.ts') || n.includes('/src/store.ts'))[0];
        const m = await import(url);
        const s = m.useAppStore.getState();
        const x = s.draftSubmissions.byId[${JSON.stringify(key)}];
        if (x !== undefined) {
          const snap = { channel: x.channel, revision: x.submittedRevision, text: x.submittedText,
                         operationId: x.operationId ?? null, epoch: x.epoch ?? null };
          if (!flightDone && ${JSON.stringify(duringFlight ?? null)} !== null) {
            const [kind, name] = ${JSON.stringify(duringFlight ?? null)}.split(':');
            if (kind === 'tab') {
              const t = Array.from(document.querySelectorAll('[role="tab"]'))
                .find(y => ((y.textContent||'').trim()) === name);
              if (t) t.click();
            }
            flightDone = true;
            const x2 = m.useAppStore.getState().draftSubmissions.byId[${JSON.stringify(key)}];
            return JSON.stringify({ ...snap, afterNavOperationId: x2?.operationId ?? null, unmounted: true });
          }
          return JSON.stringify({ ...snap, afterNavOperationId: snap.operationId, unmounted: false });
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

/** 读那份 run 的结局事件行（`{type:"run.event", event, reason}`）——成败只在这里判定 */
function readRunEvent(id) {
  const lines = H.readFileSync(H.join(H.TRACES, `${id}.jsonl`), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return lines.find((l) => l.type === "run.event") ?? null;
}

// ---------------------------------------------------------------------------
// 公共一段：在飞期间切页 → 冻结/草稿/登记三处同时核对
// ---------------------------------------------------------------------------
async function inFlightChecks(call, { key, operationId, runId, expectTarget, label }) {
  const sub = await submissionsU4(call);
  check(
    `${label}：切页卸载编辑器后，本次关联仍冻结（未解冻、未重发）`,
    sub.ids.some((x) => x.id === key),
    sub.ids.map((x) => x.id),
  );
  const d = await H.drafts(call);
  const kept = d?.calls?.[runId]?.[expectTarget.span]?.[expectTarget.field]?.text ?? "";
  check(`${label}：切页后草稿原样保留`, kept.length > 0, kept.slice(0, 60));

  const { rec, slot, epoch } = await recordOf(call, operationId);
  check(
    `${label}：main 登记在场且 running（切页不影响登记）`,
    rec?.state === "running",
    rec?.state,
  );
  check(`${label}：running 期间 main 槽被本次占住`, slot === operationId, { slot, operationId });
  for (const [k, v] of Object.entries(expectTarget.summary)) {
    check(
      `${label}：登记目标摘要 ${k}=${v}（只放定位事实）`,
      rec?.target?.[k] === v,
      rec?.target?.[k],
    );
  }
  check(
    `${label}：登记不含正文/凭据字段（schema 无对应字段）`,
    rec !== null &&
      JSON.stringify(rec).length < 2000 &&
      !JSON.stringify(rec).includes(kept.slice(0, 20)),
    { size: rec === null ? 0 : JSON.stringify(rec).length },
  );
  const session = await opsSession(call);
  check(
    `${label}：界面会话与 main 同源（同 epoch、本地在飞身份含本次）`,
    session.epoch === epoch && session.pending.includes(operationId),
    { sessionEpoch: session.epoch, pending: session.pending },
  );
  const gate = await entryGate(call);
  check(
    `${label}：在飞期间界面门禁拒绝新提交并给出理由`,
    gate?.canSubmit === false && typeof gate?.notice === "string" && gate.notice.length > 0,
    gate,
  );
}

// ---------------------------------------------------------------------------
// 场景 A：普通 result —— 在飞切页 + 全局入口 + 刷新不删登记
// ---------------------------------------------------------------------------
async function scenarioResultNav(call, fx, mock) {
  const runId = fx.normalRun;
  const mark = Math.random().toString(36).slice(2, 6);
  const text = `U4-62-result-切页-${mark}`;
  const key = `${runId}|s_03|result`;
  const before = H.traceIds();

  await H.selectRun(call, runId);
  await H.clickTabChecked(call, "步骤");
  await H.clickSpan(call, "read_file", "s_03");
  await H.clickByTextChecked(call, "在此重跑（时间旅行）", 1200);

  const gate0 = await entryGate(call);
  check("A 提交前门禁可提交（已握手、槽空闲）", gate0?.canSubmit === true, gate0);

  await H.typeIntoEditableMonaco(call, text);
  const d1 = await H.drafts(call);
  const draftText = d1?.calls?.[runId]?.s_03?.result?.text ?? "";
  check("A 草稿已入 store（含标记）", draftText.includes(mark), draftText.slice(0, 60));

  const idsBefore = ((await opsStatus(call))?.data?.operations ?? []).length;
  // 页内「click → 轮询到关联出现 → 在飞期间切页签卸载编辑器」
  const sub = await submitAndCapture(call, "确认重跑", key, { duringFlight: "tab:概览" });
  check(
    "A 提交登记关联（通道=result、快照=草稿原文）",
    sub.channel === "result" && sub.text === draftText,
    sub,
  );
  const operationId = sub.operationId ?? null;
  check(
    "A 关联携带可信身份（epoch 就是 main 当前会话）",
    operationId !== null && sub.epoch === (await opsStatus(call))?.data?.epoch,
    { operationId, epoch: sub.epoch },
  );
  check(
    "A 切页发生在飞行中且关联身份不变（卸载不换关联）",
    sub.unmounted === true && sub.afterNavOperationId === operationId,
    sub,
  );

  // 再切到另一个 run：编辑器与所属运行都换掉（比只切页签更强）
  const others = (await H.runs(call)).filter((r) => r !== runId);
  if (others.length > 0) await H.selectRun(call, others[0]);
  await H.sleep(300);
  check(
    "A 本次提交新增了登记（不是复用旧记录）",
    ((await opsStatus(call))?.data?.operations ?? []).length === idsBefore + 1,
    { idsBefore },
  );

  await inFlightChecks(call, {
    key,
    operationId,
    runId,
    label: "A result",
    expectTarget: {
      span: "s_03",
      field: "result",
      summary: {
        kind: "result",
        mode: "plain",
        parentRunId: runId,
        atSpanId: "s_03",
        editField: "result",
      },
    },
  });

  const settled = await H.waitForSettle(call, [key], 120000);
  check(
    "A 响应后按身份解冻且执行成功",
    !settled.sub.ids.some((x) => x.id === key) &&
      settled.st.forking === "success" &&
      !settled.timedOut,
    { forking: settled.st.forking, code: settled.st.forkErrorCode },
  );
  check(
    "A 成功后草稿保留（任何响应都不删草稿）",
    (await H.drafts(call)).calls?.[runId]?.s_03?.result?.text === draftText,
  );

  const kids = await H.newChildren(before);
  check("A 执行恰产出 1 份新 run", kids.length === 1, kids);
  const child = kids.length > 0 ? H.readChild(kids[0]) : null;
  check(
    "A 落盘 fork.edit.value = 提交快照原文",
    (child?.meta?.fork?.edit?.value ?? null) === draftText,
    child?.meta?.fork?.edit?.value?.slice?.(0, 60),
  );
  const after = await recordOf(call, operationId);
  check(
    "A 登记终态 settled 且 runIds 就是那份新 run",
    after.rec?.state === "settled" && after.rec.runIds.join() === kids[0],
    { state: after.rec?.state, runIds: after.rec?.runIds, kid: kids[0] },
  );
  check("A 槽已释放", after.slot !== operationId, after.slot);
  check("A 服务恰收到 1 次请求（切页不重发）", mock.served() === 1, mock.served());

  // 全局栏操作入口：核对不导航，打开记录才导航
  const panel = await openOperationsPanel(call);
  check(
    "A 全局入口显示本次登记（已收口 + 完整 operationId + 可信 runId）",
    typeof panel === "string" &&
      panel.includes("已收口") &&
      panel.includes(operationId) &&
      panel.includes(kids[0]),
    panel?.slice?.(0, 200),
  );
  await H.selectRun(call, runId);
  const navBefore = await navState(call);
  const rec1 = await clickRowAction(call, operationId, "核对状态");
  check("A 「核对状态」点了就核对（按钮在位）", rec1.found === true && rec1.button === true, rec1);
  const navAfterReconcile = await navState(call);
  check(
    "A 核对不导航：当前页面不因核对改变（spec「结果只由用户明确打开」）",
    navAfterReconcile.selectedRunId === navBefore.selectedRunId,
    { before: navBefore.selectedRunId, after: navAfterReconcile.selectedRunId },
  );
  const panel2 = await openOperationsPanel(call);
  check(
    "A 核对后登记仍在面板（不消失）",
    typeof panel2 === "string" && panel2.includes(operationId),
    panel2?.slice?.(0, 120),
  );
  const openRes = await clickRowAction(call, kids[0], "打开记录");
  check("A 「打开记录」按钮在位", openRes.found === true && openRes.button === true, openRes);
  const navOpened = await navState(call);
  check(
    "A 打开记录 = 按既有详情通道读到那份 run",
    navOpened.selectedRunId === kids[0] &&
      navOpened.detailId === kids[0] &&
      navOpened.detailLines > 0,
    navOpened,
  );

  // 列表刷新不删登记（spec：展示复位/列表刷新不删除登记）
  await H.apiCall(call, "listRuns");
  await H.sleep(600);
  const afterRefresh = await recordOf(call, operationId);
  check(
    "A 列表刷新后登记仍在（未被裁剪）",
    afterRefresh.rec?.state === "settled",
    afterRefresh.rec?.state,
  );

  // 重开编辑器 = 提交快照原文（不覆盖输入）
  await H.selectRun(call, runId);
  await H.clickTabChecked(call, "步骤");
  await H.clickSpan(call, "read_file", "s_03");
  await H.clickByTextChecked(call, "在此重跑（时间旅行）", 1500);
  const reopened = await H.drafts(call);
  check(
    "A 重开编辑器草稿仍是原文",
    reopened?.calls?.[runId]?.s_03?.result?.text === draftText,
    reopened?.calls?.[runId]?.s_03?.result?.text?.slice(0, 60),
  );
  await H.shot(call, SHOT_DIR, "62-result-nav.png");
  return { runId, operationId, kid: kids[0] ?? null, served: mock.served(), draftText };
}

// ---------------------------------------------------------------------------
// 场景 B：prompt fork —— 同一适配器 + 模型真收到提交值
// ---------------------------------------------------------------------------
async function scenarioPromptNav(call, fx, mock, dialogs) {
  const runId = fx.normalRun;
  const mark = Math.random().toString(36).slice(2, 6);
  const text = `U4-62-prompt-切页-${mark}`;
  const key = `${runId}|s_02|system_prompt`;
  const before = H.traceIds();

  await H.selectRun(call, runId);
  await H.clickTabChecked(call, "步骤");
  await H.clickSpan(call, "LLM", "s_02");
  await H.clickByTextChecked(call, "编辑 system prompt 重跑", 1200);
  await H.typeIntoEditableMonaco(call, text);
  const draftText = (await H.drafts(call))?.calls?.[runId]?.s_02?.system_prompt?.text ?? "";
  check("B 草稿已入 store（含标记）", draftText.includes(mark), draftText.slice(0, 60));

  const dialogCountBefore = dialogs.log.length;
  const sub = await submitAndCapture(call, "确认从头重跑", key, { duringFlight: "tab:概览" });
  check(
    "B 提交登记关联（通道=prompt、快照=草稿原文）",
    sub.channel === "prompt" && sub.text === draftText,
    sub,
  );
  const operationId = sub.operationId ?? null;
  check(
    "B 关联携带可信身份且切页不换关联",
    operationId !== null && sub.unmounted === true && sub.afterNavOperationId === operationId,
    sub,
  );
  check(
    "B 提交经原生确认（未绕过用户许可）",
    dialogs.log.slice(dialogCountBefore).some((x) => x.message.includes("从头重跑")),
    dialogs.log.slice(dialogCountBefore),
  );

  await inFlightChecks(call, {
    key,
    operationId,
    runId,
    label: "B prompt",
    expectTarget: {
      span: "s_02",
      field: "system_prompt",
      summary: { kind: "prompt", parentRunId: runId, editField: "system_prompt" },
    },
  });

  const settled = await H.waitForSettle(call, [key], 120000);
  check(
    "B 响应后解冻且执行成功",
    !settled.sub.ids.some((x) => x.id === key) &&
      settled.st.forking === "success" &&
      !settled.timedOut,
    { forking: settled.st.forking, code: settled.st.forkErrorCode },
  );
  const kids = await H.newChildren(before);
  const child = kids.length > 0 ? H.readChild(kids[0]) : null;
  check(
    "B 落盘 fork.edit.value = 提交快照",
    (child?.meta?.fork?.edit?.value ?? null) === draftText,
    child?.meta?.fork?.edit?.value?.slice?.(0, 60),
  );
  const sysMsg = (child?.firstRequestMessages ?? []).find((m) => m.role === "system");
  check(
    "B 子 run 首次请求的 system 即提交快照（模型真收到）",
    sysMsg?.content === draftText,
    sysMsg?.content?.slice?.(0, 60),
  );
  const after = await recordOf(call, operationId);
  check(
    "B 登记 settled 且 runIds 指向子 run",
    after.rec?.state === "settled" && after.rec.runIds.join() === kids[0],
    { state: after.rec?.state, runIds: after.rec?.runIds },
  );
  check("B 服务恰 1 次请求", mock.served() === 1, mock.served());
  check(
    "B 成功后草稿保留",
    (await H.drafts(call)).calls?.[runId]?.s_02?.system_prompt?.text === draftText,
  );

  const panel = await openOperationsPanel(call);
  check(
    "B 全局入口同一次登记可查（prompt 与 result 共用同一适配器与登记）",
    typeof panel === "string" && panel.includes(operationId),
    panel?.slice?.(0, 160),
  );
  await H.shot(call, SHOT_DIR, "62-prompt-nav.png");
  return { runId, operationId, kid: kids[0] ?? null, served: mock.served() };
}

// ---------------------------------------------------------------------------
// 场景 C：隔离 result 续跑 —— 三段门禁 + 在飞切页 + 父链/轮末检查点
// ---------------------------------------------------------------------------
async function scenarioIsolatedGates(call, fx, mock) {
  const runId = fx.isoRoot;
  const mark = Math.random().toString(36).slice(2, 6);
  const text = `U4-62-隔离-切页-${mark}`;
  const key = `${runId}|s_03|result`;
  const before = H.traceIds();
  const idsBeforeOpen = ((await opsStatus(call))?.data?.operations ?? []).length;

  await H.selectRun(call, runId);
  await H.clickTabChecked(call, "步骤");
  await H.clickSpan(call, "read_file", "s_03");
  await H.clickByTextChecked(call, "在此重跑（隔离续跑）", 1500);
  await H.typeIntoEditableMonaco(call, text);

  const gateNoPreflight = await buttonState(call, "确认重跑");
  check(
    "C 门禁一：未预检时提交禁用",
    gateNoPreflight !== null && gateNoPreflight.disabled === true,
    gateNoPreflight,
  );
  const idsEmpty = ((await opsStatus(call))?.data?.operations ?? []).length;
  check(
    "C 未预检 ⇒ 零登记、零模型请求（禁用不是「登记后被拒」）",
    idsEmpty === idsBeforeOpen && mock.served() === 0,
    { idsBeforeOpen, idsEmpty, served: mock.served() },
  );

  await H.clickByTextChecked(call, "校验续跑条件", 2500);
  const shown = await waitForText(call, "轮末检查点", 15000);
  check("C 预检通过并显示轮末检查点（只读预检，不占槽）", shown === true);
  check(
    "C 预检不占执行槽（只读入口不登记）",
    (await opsStatus(call))?.data?.activeOperationId === null,
    (await opsStatus(call))?.data?.activeOperationId,
  );
  const gateNoAuth = await buttonState(call, "确认重跑");
  check(
    "C 门禁二：预检通过但未授权仍禁用",
    gateNoAuth !== null && gateNoAuth.disabled === true,
    gateNoAuth,
  );

  await H.clickLabelWith(call, "允许本次副本写入", 600);
  const sub = await submitAndCapture(call, "确认重跑", key, { duringFlight: "tab:概览" });
  const operationId = sub.operationId ?? null;
  check(
    "C 授权后才提交，关联登记带身份且切页不换关联",
    sub.channel === "result" &&
      operationId !== null &&
      sub.unmounted === true &&
      sub.afterNavOperationId === operationId,
    { sub },
  );

  await inFlightChecks(call, {
    key,
    operationId,
    runId,
    label: "C 隔离续跑",
    expectTarget: {
      span: "s_03",
      field: "result",
      summary: {
        kind: "result",
        mode: "isolated",
        parentRunId: runId,
        atSpanId: "s_03",
        editField: "result",
      },
    },
  });

  const settled = await H.waitForSettle(call, [key], 150000);
  check(
    "C 隔离续跑解冻并成功",
    settled.st.forking === "success" &&
      !settled.sub.ids.some((x) => x.id === key) &&
      !settled.timedOut,
    { forking: settled.st.forking, code: settled.st.forkErrorCode },
  );
  const kids = await H.newChildren(before);
  const child = kids.length > 0 ? H.readChild(kids[0]) : null;
  const after = await recordOf(call, operationId);
  check(
    "C 登记 runIds = 世界身份（与落盘 meta.id 一致）",
    after.rec?.state === "settled" && after.rec.runIds.join() === kids[0],
    { state: after.rec?.state, runIds: after.rec?.runIds, kid: kids[0] },
  );
  check(
    "C 父链门禁：子 run 的 workspace.origin 指向父检查点",
    child?.meta?.workspace?.origin?.kind === "checkpoint" &&
      child?.meta?.workspace?.origin?.run_id === runId,
    child?.meta?.workspace?.origin ?? null,
  );
  check("C 服务恰 1 次请求（切页不重发）", mock.served() === 1, mock.served());

  // 门禁三：重开编辑器 ⇒ 草稿保留、授权复位、未授权继续禁用
  await H.selectRun(call, runId);
  await H.clickTabChecked(call, "步骤");
  await H.clickSpan(call, "read_file", "s_03");
  await H.clickByTextChecked(call, "在此重跑（隔离续跑）", 1500);
  await H.clickByTextChecked(call, "校验续跑条件", 2500);
  const reopenProbe = `(() => { const l = Array.from(document.querySelectorAll('label'))
        .find(x => (x.textContent||'').includes('允许本次副本写入'));
      const cb = l ? l.querySelector('input[type=checkbox]') : null;
      const submit = Array.from(document.querySelectorAll('button'))
        .find(x => (x.textContent||'').trim() === '确认重跑');
      return JSON.stringify({ authChecked: cb ? cb.checked : null, submitDisabled: submit ? submit.disabled : null }); })()`;
  let reopen = null;
  for (let i = 0; i < 16; i++) {
    reopen = JSON.parse((await H.ev(call, reopenProbe)) ?? "null");
    if (reopen !== null && reopen.authChecked !== null) break;
    await H.sleep(500);
  }
  const keptText = (await H.drafts(call))?.calls?.[runId]?.s_03?.result?.text ?? "";
  check(
    "C 门禁三：重开后草稿保留、授权复位（不继承历史勾选）、未授权仍禁用",
    keptText.includes(mark) && reopen?.authChecked === false && reopen?.submitDisabled === true,
    { reopen, kept: keptText.slice(0, 40) },
  );
  await H.shot(call, SHOT_DIR, "62-isolated-gates.png");
  return { runId, operationId, kid: kids[0] ?? null, reopen, served: mock.served() };
}

// ---------------------------------------------------------------------------
// 场景 D：已知身份后异常仍可关联 + 空 fork 前置拒绝零登记
// ---------------------------------------------------------------------------
async function scenarioErrorIdentity(call, fx, mock) {
  const runId = fx.normalRun;
  const mark = Math.random().toString(36).slice(2, 6);
  const text = `U4-62-失败身份-${mark}`;
  const key = `${runId}|s_03|result`;
  const before = H.traceIds();

  await H.selectRun(call, runId);
  await H.clickTabChecked(call, "步骤");
  await H.clickSpan(call, "read_file", "s_03");
  await H.clickByTextChecked(call, "在此重跑（时间旅行）", 1200);

  const idsBefore = ((await opsStatus(call))?.data?.operations ?? []).length;
  const unsubmitted = await buttonState(call, "确认重跑");
  const emptyForkBlocked = unsubmitted !== null && unsubmitted.disabled === true;
  check("D 门禁：内容未修改（空 fork）时提交禁用", emptyForkBlocked === true, unsubmitted);
  const idsAfterEmpty = ((await opsStatus(call))?.data?.operations ?? []).length;
  check(
    "D 空 fork ⇒ 零登记、零请求（前置拒绝不是「登记后被拒」）",
    idsAfterEmpty === idsBefore && mock.served() === 0,
    { idsBefore, idsAfterEmpty, served: mock.served() },
  );

  await H.typeIntoEditableMonaco(call, text);
  const draftText = (await H.drafts(call))?.calls?.[runId]?.s_03?.result?.text ?? "";
  const sub = await submitAndCapture(call, "确认重跑", key);
  const operationId = sub.operationId ?? null;
  check(
    "D 提交登记关联（通道=result、快照=草稿原文、身份可信）",
    sub.channel === "result" && sub.text === draftText && operationId !== null,
    sub,
  );

  const settled = await H.waitForSettle(call, [key], 120000);
  check(
    "D 模型失败仍按身份收尾（解冻，不是悬挂）",
    !settled.sub.ids.some((x) => x.id === key) && !settled.timedOut,
    { ids: settled.sub.ids.map((x) => x.id), forking: settled.st.forking },
  );
  // ⚠️ 口径（本轮实测坐实）：`runLoop` 不把 LLM 失败抛出 ⇒ 编排**正常返回**一个 errored run，
  // 所以登记的 requestOutcome=returned、errorCode=null，界面 forking 也是 success。
  // 「失败」只存在于 trace 侧（llm.call.error + run.event=errored）。
  // 因此这里钉的是「settled/returned 不冒充运行成功」，而不是"登记必须报错"——后者违反契约。
  check("D 编排返回不等于运行成功：登记按 returned 收口", settled.st.forking === "success", {
    forking: settled.st.forking,
    code: settled.st.forkErrorCode,
  });
  check("D 失败不清草稿", (await H.drafts(call)).calls?.[runId]?.s_03?.result?.text === draftText);

  const after = await recordOf(call, operationId);
  const runIds = after.rec?.runIds ?? [];
  check(
    "D 已写 meta 后失败 ⇒ 登记仍带真实新 ID（恰 1 个）",
    after.rec?.state === "settled" && runIds.length === 1,
    { state: after.rec?.state, runIds, outcome: after.rec?.requestOutcome },
  );
  check(
    "D 登记不谎称业务错误（errorCode 为空，事实交给 trace）",
    after.rec?.requestOutcome === "returned" && (after.rec?.errorCode ?? null) === null,
    { requestOutcome: after.rec?.requestOutcome, errorCode: after.rec?.errorCode },
  );
  const fileExists = runIds.length === 1 && H.existsSync(H.join(H.TRACES, `${runIds[0]}.jsonl`));
  check("D 该身份的文件真存在（身份 ≠ 可读，但至少不是凭空）", fileExists === true, runIds);
  const child = runIds.length === 1 ? H.readChild(runIds[0]) : null;
  check(
    "D 失败运行确有 llm.call.error（trace 侧同源事实）",
    (child?.firstError ?? null) !== null,
    child?.firstError,
  );
  const runEvent = runIds.length === 1 ? readRunEvent(runIds[0]) : null;
  check(
    "D 那份 run 的真结局是 errored（所以「已收口」≠「跑成功了」）",
    runEvent?.event === "errored",
    runEvent,
  );

  // 用户仍可按这个 ID 打开失败记录（核对与执行都结束了，读取不重执行）
  await H.selectRun(call, runId);
  const navBefore = await navState(call);
  const panel = await openOperationsPanel(call);
  check(
    "D 全局入口显示该次为已收口并给出可信 ID",
    typeof panel === "string" && panel.includes(operationId) && panel.includes(runIds[0] ?? "∅"),
    panel?.slice?.(0, 200),
  );
  const opened = await clickRowAction(call, runIds[0] ?? "∅", "打开记录");
  check("D 「打开记录」按钮在位", opened.button === true, opened);
  const navAfter = await navState(call);
  check(
    "D 可按失败记录的同一 ID 读到详情（不自动导航、不重执行）",
    navAfter.detailId === runIds[0] &&
      navAfter.detailLines > 0 &&
      navBefore.selectedRunId !== navAfter.selectedRunId,
    navAfter,
  );
  check("D 服务恰 1 次请求（失败不重试）", mock.served() === 1, mock.served());
  const kids = await H.newChildren(before);
  check("D traces 恰 +1（一次失败一份记录）", kids.length === 1, kids);
  await H.shot(call, SHOT_DIR, "62-error-identity.png");
  return { operationId, runIds, served: mock.served(), kids };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
async function main() {
  if (!existsSync(MANIFEST))
    throw new Error(`缺夹具 manifest（${MANIFEST}）——6.2 复用 U3 6.1 的真实 run`);
  const fx = JSON.parse(readFileSync(MANIFEST, "utf8"));
  for (const id of [fx.normalRun, fx.isoRoot]) {
    if (!H.existsSync(H.join(H.TRACES, `${id}.jsonl`))) throw new Error(`夹具 run 文件缺失：${id}`);
  }
  const page = await H.cdpConnect(H.CDP_PORT);
  const call = await H.makeDialogSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.clearDeviceMetricsOverride").catch(() => {});
  const dialogs = H.attachDialogHandler(call, []);

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
  const ready = (await H.runs(call)).length;
  console.log(`冷重载完成：运行列表 ${ready} 项`);
  if (ready === 0) throw new Error("重载后运行列表为空——夹具未就绪");

  const scripts = {
    "result-nav": { turns: [SLOW_TURN], fallback: { content: "兜底" } },
    "prompt-nav": { turns: [SLOW_TURN], fallback: { content: "兜底" } },
    "isolated-gates": { turns: [SLOW_TURN], fallback: { content: "兜底" } },
    "error-identity": { turns: [FAIL_TURN], fallback: FAIL_TURN },
  };
  const mock = await H.prepare(call, scripts[TAG]);
  dump.scripts = TAG;

  const scenarios = {
    "result-nav": () => scenarioResultNav(call, fx, mock),
    "prompt-nav": () => scenarioPromptNav(call, fx, mock, dialogs),
    "isolated-gates": () => scenarioIsolatedGates(call, fx, mock),
    "error-identity": () => scenarioErrorIdentity(call, fx, mock),
  };
  let out = null;
  let failure = null;
  try {
    out = await scenarios[TAG]();
  } catch (e) {
    failure = String(e?.stack ?? e);
    check("场景未抛异常", false, failure);
  } finally {
    await H.teardown(call, mock);
  }
  dump.result = out ?? null;
  dump.failure = failure;
  if (failure !== null) {
    writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), failure);
  }
  finish();
}

main().catch((e) => {
  console.error("采集失败:", e);
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), String(e?.stack ?? e));
  process.exit(1);
});
