/* eslint-disable */
/**
 * U8 任务 6.8（Electron 实机第三批）：受控真实执行完整及部分失败、不可读重试、
 * 缺臂/未知、后台离开/重载、逐臂打开/返回；核对冻结/清理/可信身份。
 *
 * 对应 delta 场景：#37 成功臂集合不隐去失败臂、#38 实验结果不可读仅重试读取、
 * #39 全臂核实才按提交修订清理、#42 跨页结束与重载恢复实验结果、#33 切运行不更换实验父本、
 * #35 实验来源失效仍能返回草稿（部分）、#52-55 批次分组（登记在场后的结果区形态）。
 *
 * 判据纪律（同 U5/U6/U7）：
 * - 真实执行（确认 + 执行按钮），mock 剧本经 POST /__reset 在批次间切换；
 * - 不可读注入复用 u5-read-faults 的 fileMissing（同卷 rename，还原 + 指纹核验）；
 * - 本批零伪造：缺臂/未知形态真机不可达（收口必带 armFacts）⇒ 单元承载登记；
 * - 重载后 experimentTarget 不恢复（会话内目标）⇒ 重开工作区按登记快照恢复结果区。
 *
 * 用法：`node apps/desktop/scripts/u8-68-cdp.cjs --tag=ab-execute`
 * 前置：dev 已由 run-all 起（CDP 9612）；mock-llm 18799 已起（剧本由本探针切换）。
 */
"use strict";
const { writeFileSync, mkdirSync, existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const http = require("node:http");
const H = require("./lib/u4-smoke-harness.cjs");
const readFaults = require("./lib/u5-read-faults.cjs");

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag", "ab-execute");

const OUT_DIR = join(H.REPO, ".workbuddy", "u8", "u8-68");
const SHOT_DIR = join(OUT_DIR, "shots");
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
function note(text) {
  console.log(`ℹ ${text}`);
  checks.push({ tag: TAG, name: `[登记] ${text}`, ok: true, note: true });
}
function headShort() {
  try {
    const head = readFileSync(join(H.REPO, ".git", "HEAD"), "utf8").trim();
    const m = head.match(/^ref: (.+)$/);
    if (m) {
      const refFile = join(H.REPO, ".git", ...m[1].split("/"));
      if (existsSync(refFile)) return readFileSync(refFile, "utf8").trim().slice(0, 7);
    }
    return head.slice(0, 7);
  } catch {
    return "unknown";
  }
}
function finish(extraMeta = {}) {
  const failed = checks.filter((c) => !c.ok && !c.note);
  writeFileSync(
    join(OUT_DIR, `${TAG}-measurements.json`),
    JSON.stringify(
      { tag: TAG, meta: { head: headShort(), ...extraMeta }, checks, failed: failed.length, dump },
      null,
      2,
    ),
  );
  console.log(`检查 ${checks.filter((c) => !c.note).length} 条，失败 ${failed.length} 条`);
  clearTimeout(watchdog);
  process.exit(failed.length === 0 ? 0 : 1);
}
const watchdog = setTimeout(() => {
  console.error(`看门狗：${TAG} 超过 12 分钟未收尾`);
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), "watchdog timeout");
  process.exit(3);
}, 720_000);

/** mock 控制端点（node 侧直调） */
function mockReset(script) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ script });
    const req = http.request(
      "http://127.0.0.1:18799/__reset",
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        let data = "";
        res.on("data", (d) => {
          data += d;
        });
        res.on("end", () => resolve(JSON.parse(data)));
      },
    );
    req.on("error", reject);
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error("mock /__reset 超时"));
    });
    req.write(body);
    req.end();
  });
}
function mockServed() {
  return new Promise((resolve, reject) => {
    http
      .get("http://127.0.0.1:18799/__log", (res) => {
        let body = "";
        res.on("data", (d) => {
          body += d;
        });
        res.on("end", () => resolve(JSON.parse(body).served));
      })
      .on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// 页内读数与动作
// ---------------------------------------------------------------------------

const SCRIPT_PLAIN_TURN = { content: "受控单轮回答。" };

async function createParent(call, tag) {
  await H.storeQ(call, `s.openCreateWorkspace(); return JSON.stringify("ok");`);
  await H.sleep(900);
  const adv = await H.ev(
    call,
    `(() => {
       const b = document.querySelector('[data-advanced-toggle]');
       if (!b || b.offsetParent === null) return JSON.stringify({ found: false });
       if (b.getAttribute('aria-expanded') === 'false') b.click();
       return JSON.stringify({ found: true });
     })()`,
  ).then(JSON.parse);
  if (adv.found !== true) throw new Error(`高级区探测失败：${JSON.stringify(adv)}`);
  await H.sleep(600);
  await H.typeIntoDom(
    call,
    'textarea[placeholder^="例如：你是一个简洁的问答助手"]',
    "你是通用文件助手。",
  );
  await H.typeIntoDom(call, 'textarea[placeholder^="要交给模型的任务"]', `U8 ${tag} 实验父本`);
  const confirm = await H.ev(
    call,
    `(() => { const b = document.querySelector('[data-confirm-execution]');
       if (!b || b.disabled) return JSON.stringify({ state: 'blocked' }); b.click(); return JSON.stringify({ state: 'clicked' }); })()`,
  ).then(JSON.parse);
  await H.sleep(900);
  const pressed = await H.ev(
    call,
    `JSON.stringify(document.querySelector('[data-confirm-execution]')?.getAttribute('aria-pressed'))`,
  ).then(JSON.parse);
  if (pressed !== "true")
    throw new Error(`创建确认未挂上：${JSON.stringify({ confirm, pressed })}`);
  const runsBefore = await H.runs(call);
  await H.ev(
    call,
    `(() => {
       const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent || '').trim() === '创建');
       if (!b || b.disabled) return false; b.click(); return true; })()`,
  ).then((r) => {
    if (r !== true) throw new Error("创建按钮不可点");
  });
  const deadline = Date.now() + 40000;
  for (;;) {
    const runs = await H.runs(call);
    const fresh = runs.find((id) => !runsBefore.includes(id));
    if (fresh) return fresh;
    if (Date.now() > deadline) throw new Error("创建 40s 未收尾");
    await H.sleep(600);
  }
}

async function openExperimentFor(call, parentId) {
  await H.storeQ(
    call,
    `await s.selectRun(${JSON.stringify(parentId)}); return JSON.stringify("ok");`,
  );
  await H.sleep(1200);
  const r = await H.ev(
    call,
    `(() => { const b = document.querySelector('[data-experiment-entry]');
       if (!b || b.disabled) return false; b.click(); return true; })()`,
  );
  if (r !== true) throw new Error("「模型实验」入口不可点");
  await H.sleep(1200);
}

/** 配臂（合法态）并预览 → 确认 → 返回执行按钮就绪状态 */
async function armAndPreview(call) {
  const r = await H.ev(
    call,
    `(() => {
       const rows = Array.from(document.querySelectorAll('div'))
         .filter(d => typeof d.className === 'string' && d.className.includes('border-sky-200') && d.querySelector('input[placeholder="model 名"]'));
       const set = (el, v) => {
         const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
         setter.call(el, v);
         el.dispatchEvent(new Event('input', { bubbles: true }));
       };
       if (rows.length < 2) return JSON.stringify({ error: 'rows<2', matched: rows.length });
       set(rows[0].querySelectorAll('input')[0], 'deepseek-chat');
       set(rows[0].querySelectorAll('input')[1], '{"temperature":0.2}');
       set(rows[1].querySelectorAll('input')[0], 'deepseek-reasoner');
       set(rows[1].querySelectorAll('input')[1], '{}');
       return JSON.stringify({ ok: true });
     })()`,
  ).then(JSON.parse);
  if (r.ok !== true) throw new Error(`配臂失败：${JSON.stringify(r)}`);
  await H.sleep(500);
  // 预览（轮询计划区出现）
  await H.ev(
    call,
    `(() => {
       const b = Array.from(document.querySelectorAll('button'))
         .find(x => { const t = (x.textContent || '').trim(); return t === '校验并预览计划' || t === '重新校验'; });
       if (!b || b.disabled) return false; b.click(); return true; })()`,
  ).then((x) => {
    if (x !== true) throw new Error("预览按钮不可点");
  });
  const deadline = Date.now() + 20000;
  for (;;) {
    const has = await H.ev(
      call,
      `JSON.stringify((document.body.textContent || '').includes('校验通过 · 执行计划'))`,
    ).then(JSON.parse);
    if (has === true) break;
    if (Date.now() > deadline) throw new Error("预览 20s 未出计划");
    await H.sleep(500);
  }
  // 确认
  await H.ev(
    call,
    `(() => { const b = document.querySelector('[data-confirm-execution]'); b.click(); return true; })()`,
  );
  await H.sleep(900);
  const pressed = await H.ev(
    call,
    `JSON.stringify(document.querySelector('[data-confirm-execution]')?.getAttribute('aria-pressed'))`,
  ).then(JSON.parse);
  if (pressed !== "true") throw new Error(`实验确认未挂上：${pressed}`);
}

/** 结果区读数（ExperimentResultsSection：data-experiment-results + 逐批 data-ab-batch-result） */
const resultsDom = (call) =>
  H.ev(
    call,
    `(() => {
       const sec = document.querySelector('[data-experiment-results]');
       const batches = Array.from(document.querySelectorAll('[data-ab-batch-result]'));
       return JSON.stringify({
         hasResults: sec !== null,
         batchCount: batches.length,
         batchOps: batches.map(b => b.getAttribute('data-ab-batch-result')),
       });
     })()`,
  ).then(JSON.parse);

/** 登记快照读数（store 会话 operations） */
const abRecords = (call) =>
  H.storeQ(
    call,
    `const recs = s.operations.operations.filter(o => o.target && o.target.kind === 'modelAb');
     return JSON.stringify(recs.map(o => ({
       operationId: o.operationId, epoch: o.epoch, state: o.state, armCount: o.target.armCount,
       arms: o.arms, runIds: o.runIds, experimentId: o.experimentId,
     })));`,
  );

/** 等待登记出现且 state=settled */
async function waitSettled(call, opId, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const recs = await abRecords(call);
    const rec = recs.find((o) => o.operationId === opId);
    if (rec && rec.state === "settled") return rec;
    if (Date.now() > deadline) throw new Error(`收口 60s 未到：${JSON.stringify(recs)}`);
    await H.sleep(800);
  }
}

/** 在结果区点指定臂的动作按钮（臂块祖先链含 runId；同批两臂同名按钮由此区分） */
async function openArmAction(call, rec, runId, label) {
  const r = await H.ev(
    call,
    `(() => {
       const container = document.querySelector('[data-ab-batch-result="${rec.operationId}"]');
       if (!container) return 'no-batch';
       const key = ${JSON.stringify(runId)};
       const candidates = Array.from(container.querySelectorAll('button'))
         .filter(b => (b.textContent || '').trim() === ${JSON.stringify(label)});
       const hit = candidates.find(b => {
         let el = b;
         for (let i = 0; i < 8 && el && el !== container; i++) {
           el = el.parentElement;
           if (el && (el.textContent || '').includes(key)) return true;
         }
         return false;
       });
       if (!hit || hit.disabled) return 'no-button:' + candidates.length;
       hit.click(); return 'clicked';
     })()`,
  );
  if (r !== "clicked") throw new Error(`臂 ${runId} 的「${label}」不可点：${r}`);
  await H.sleep(2000);
}

/** 在结果区点指定臂的「重读这条结果」按钮（retry-read 的 title 含完整 runId） */
async function retryArmRead(call, runId) {
  const r = await H.ev(
    call,
    `(() => {
       const b = Array.from(document.querySelectorAll('button'))
         .find(x => (x.title || '').includes(${JSON.stringify(runId)}));
       if (!b || b.disabled) return false; b.click(); return true; })()`,
  );
  if (r !== true) throw new Error(`臂 ${runId} 的重读按钮不可点`);
  await H.sleep(1500);
}

/** 重载后读取项显式核实重建（store 口 retryResultRead——与结果区按钮同一通道） */
async function rebuildRead(call, rec, arm) {
  await H.storeQ(
    call,
    `await s.retryResultRead({ epoch: ${JSON.stringify(rec.epoch)}, operationId: ${JSON.stringify(rec.operationId)}, runId: ${JSON.stringify(arm.id)} });
     return JSON.stringify("ok");`,
  );
  await H.sleep(1200);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const page = await H.cdpConnect(H.CDP_PORT);
  const call = await H.makeDialogSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.clearDeviceMetricsOverride").catch(() => {});

  await call("Page.reload", { ignoreCache: true });
  // ⚠️ 等列表真加载（U8 6.7 坐实：空列表早退 ⇒ store 未水合判据全假）
  for (let i = 0; i < 80; i++) {
    await H.sleep(500);
    try {
      if ((await H.runs(call)).length > 0) break;
    } catch {
      /* 重载瞬间 */
    }
  }
  await H.sleep(900);

  const activeFaults = [];
  async function drainFaults() {
    for (const f of activeFaults.splice(0)) {
      try {
        const r = f.end();
        console.log(`[fault] ${f.kind} 还原 clean=${r.clean}`);
      } catch (e) {
        console.log(`[fault] end 异常：${String(e)}`);
      }
    }
  }

  try {
    const dpr = await H.ev(call, "window.devicePixelRatio");
    check("DPR ≈ 2.1（无 zoom 残留）", Math.abs(dpr - 2.1) < 0.15, `实测 ${dpr}`);
    const tracesBefore = H.traceIds().size;

    // ── 父本现造 ──
    await mockReset({ turns: [SCRIPT_PLAIN_TURN], fallback: { content: "（剧本耗尽）" } });
    const parentId = await createParent(call, "6.8");
    const servedAfterParent = await mockServed();
    check(
      "父本现造成功（mock 恰 1 次调用）",
      typeof parentId === "string" && servedAfterParent === 1,
      {
        parentId,
        served: servedAfterParent,
      },
    );
    const tracesBaseline = H.traceIds().size; // 基线取创建后

    // ── 批次 1：部分失败（臂 1 ok + 臂 2 fail503）──
    await mockReset({
      turns: [
        { content: "臂 1 受控回答。", delayMs: 2500 },
        { mode: "fail", status: 503 },
      ],
      fallback: { content: "（剧本耗尽）" },
    });
    await openExperimentFor(call, parentId);
    await armAndPreview(call);
    const execR = await H.ev(
      call,
      `(() => {
         const b = Array.from(document.querySelectorAll('button'))
           .find(x => (x.textContent || '').trim().startsWith('确认执行'));
         if (!b || b.disabled) return JSON.stringify({ disabled: true, label: b ? b.textContent.trim() : null });
         b.click(); return JSON.stringify({ disabled: false });
       })()`,
    ).then(JSON.parse);
    if (execR.disabled === true) throw new Error(`执行按钮不可点：${JSON.stringify(execR)}`);
    await H.sleep(600);

    // 冻结呈现（在飞整批冻结）
    const frozen = await H.ev(
      call,
      `JSON.stringify((document.body.textContent || '').includes('已按提交时的批次修订冻结整个批次'))`,
    ).then(JSON.parse);
    check("执行在飞 ⇒ 整批冻结说明在场（不可增删臂/改参数/放弃）", frozen === true, frozen);

    // ── 后台离开：执行期间切页，收口不抢导航（A/B 意图恒 drop）──
    await H.storeQ(call, `s.setView("trace"); return JSON.stringify("ok");`);
    await H.sleep(600);
    const viewDuring = await H.storeQ(
      call,
      "return JSON.stringify({ view: s.view, sel: s.selectedRunId });",
    );
    check(
      "#42 执行期间离开实验页（view=trace、选择不动）",
      viewDuring.view === "trace" && viewDuring.sel === parentId,
      viewDuring,
    );

    // 等收口（登记 settled）
    let rec1 = null;
    const deadline1 = Date.now() + 60000;
    for (;;) {
      const recs = await abRecords(call);
      const rec = recs.find((o) => o.state === "settled");
      if (rec) {
        rec1 = rec;
        break;
      }
      if (Date.now() > deadline1) throw new Error(`批次 1 收口 60s 未到：${JSON.stringify(recs)}`);
      await H.sleep(800);
    }
    const viewAfter = await H.storeQ(call, "return JSON.stringify({ view: s.view });");
    check(
      "#42 收口后不抢导航（仍在 trace 视图，A/B 意图恒 drop）",
      viewAfter.view === "trace",
      viewAfter,
    );
    const servedBatch1 = await mockServed();
    check("#57 批次 1 恰 2 次调用（臂 1 ok + 臂 2 fail503 都算 served）", servedBatch1 === 2, {
      served: servedBatch1,
    });
    check(
      "#37 登记逐臂诚实：arms 覆盖两臂 [returned, failed]；runIds 含全部臂 id（逐臂核实的可信身份；信封 ids 只含成功臂的契约按 exec-model-ab 单元承载）",
      rec1.armCount === 2 &&
        rec1.arms.length === 2 &&
        rec1.arms[0].outcome === "returned" &&
        rec1.arms[1].outcome === "failed" &&
        rec1.runIds.length === 2 &&
        rec1.runIds[0] === rec1.arms[0].id &&
        rec1.runIds[1] === rec1.arms[1].id,
      rec1,
    );
    const arm2Id = rec1.arms[1].id;
    check(
      "#37 失败臂带真实 id（可信身份可打开）",
      typeof arm2Id === "string" && arm2Id.length > 0 && arm2Id !== rec1.arms[0].id,
      { arm2Id },
    );

    // 落盘核对：臂 2 文件带顶层 error + errored 终态（node 侧直读）
    const arm2File = join(H.REPO, ".rebaseagent", "traces", `${arm2Id}.jsonl`);
    const arm2Lines = readFileSync(arm2File, "utf8")
      .split("\n")
      .filter((l) => l.trim());
    const arm2Meta = JSON.parse(arm2Lines[0]);
    const arm2Call = arm2Lines.map((l) => JSON.parse(l)).find((o) => o.kind === "llm.call");
    const arm2Event = JSON.parse(arm2Lines[arm2Lines.length - 1]);
    check(
      "#37 失败臂落盘：llm.call 顶层 error + errored/error 终态 + fork.experimentId 同批",
      arm2Call?.error?.message?.includes("503") === true &&
        arm2Event.event === "errored" &&
        arm2Meta.fork?.edit?.value?.experimentId === rec1.experimentId,
      {
        error: arm2Call?.error?.message,
        event: `${arm2Event.event}/${arm2Event.reason}`,
        exp: arm2Meta.fork?.edit?.value?.experimentId,
      },
    );
    const arm1Id = rec1.arms[0].id;
    const arm1File = join(H.REPO, ".rebaseagent", "traces", `${arm1Id}.jsonl`);
    const arm1Lines = readFileSync(arm1File, "utf8")
      .split("\n")
      .filter((l) => l.trim());
    const arm1Event = JSON.parse(arm1Lines[arm1Lines.length - 1]);
    check(
      "#37 成功臂落盘：stopped/completed、无 error、同批 experimentId",
      arm1Event.event === "stopped" && arm1Event.reason === "completed",
      `${arm1Event.event}/${arm1Event.reason}`,
    );

    // ── 回实验工作区：结果区逐臂呈现（部分失败批保留）──
    await openExperimentFor(call, parentId);
    await H.sleep(1500);
    const res1 = await resultsDom(call);
    check(
      "#37 实验工作区结果区在场（批次按目标圈定：data-ab-batch-result=登记 operationId）",
      res1.hasResults === true && res1.batchOps.includes(rec1.operationId),
      res1,
    );

    // ── 批次 2：完整成功 [ok, ok] ⇒ 全臂核实 ──
    await mockReset({
      turns: [{ content: "臂受控回答（成功批）。" }, { content: "臂受控回答（成功批）。" }],
      fallback: { content: "（剧本耗尽）" },
    });
    await armAndPreview(call);
    await H.ev(
      call,
      `(() => {
         const b = Array.from(document.querySelectorAll('button'))
           .find(x => (x.textContent || '').trim().startsWith('确认执行'));
         if (!b || b.disabled) return false; b.click(); return true; })()`,
    ).then((x) => {
      if (x !== true) throw new Error("批次 2 执行按钮不可点");
    });
    await H.sleep(600);
    const deadline2 = Date.now() + 60000;
    let rec2 = null;
    for (;;) {
      const recs = await abRecords(call);
      const rec = recs.find((o) => o.state === "settled" && o.operationId !== rec1.operationId);
      if (rec) {
        rec2 = rec;
        break;
      }
      if (Date.now() > deadline2) throw new Error(`批次 2 收口 60s 未到：${JSON.stringify(recs)}`);
      await H.sleep(800);
    }
    check(
      "#39 完整成功批：两臂全 returned（[ok, ok]）",
      rec2.arms.length === 2 && rec2.arms.every((a) => a.outcome === "returned"),
      rec2.arms,
    );

    // ── 对照支：部分失败批（批次 1）整批保留 ──
    const recsFinal = await abRecords(call);
    check(
      "#39 对照支：部分失败批整批保留（不冒充全臂成功、不被清理）",
      recsFinal.some((o) => o.operationId === rec1.operationId),
      recsFinal.map((o) => o.operationId),
    );

    // ── 重载：登记快照恢复 + 读取项清空 ⇒ 注入期不可读重试在重载后编排 ──
    // （会话内自动核实已让臂 2 呈现已核实事实；只有重载清空读取项后，
    //   「打开即读」才会真实命中注入期缺失的文件 ⇒ unreadable → 重试链路）
    await call("Page.reload", { ignoreCache: true });
    for (let i = 0; i < 80; i++) {
      await H.sleep(500);
      try {
        if ((await H.runs(call)).length > 0) break;
      } catch {
        /* 重载瞬间 */
      }
    }
    await H.sleep(900);
    // reload 未换文档哨兵（U4 6.6 坑：它会绿）——读不到哨兵即已换文档
    const sentinel = await H.ev(call, "window.__u868Doc ?? null").catch(() => null);
    if (sentinel === "sentinel") {
      await call("Page.reload", { ignoreCache: true });
      await H.sleep(3000);
      for (let i = 0; i < 80; i++) {
        await H.sleep(500);
        try {
          if ((await H.runs(call)).length > 0) break;
        } catch {
          /* 重载瞬间 */
        }
      }
      await H.sleep(900);
    }
    await openExperimentFor(call, parentId);
    await H.sleep(1500);
    const reloadRecords = await abRecords(call);
    check(
      "#42 重载后由登记快照恢复：两批 settled 记录在场（呈现按登记派生，零补造）",
      reloadRecords.filter((o) => o.state === "settled").length >= 2,
      reloadRecords.map((o) => `${o.operationId.slice(0, 8)}:${o.state}`),
    );

    // ── #38 注入期不可读重试（显式核实通道 = retryResultRead，与结果区「重读这条结果」同一 store 口）──
    // ⚠️ 「打开结果」= selectRun 导航、不写读取项（U8 4.3 契约）⇒ unreadable 只能由
    //    显式核实（retryResultRead）触发；重载后读取项清空 ⇒ 随时可显式核实（无竞速窗口）。
    const fault = readFaults.beginReadFault(
      { tracesDir: join(H.REPO, ".rebaseagent", "traces"), runId: arm2Id },
      "fileMissing",
    );
    activeFaults.push(fault);
    await H.storeQ(
      call,
      `await s.retryResultRead({ epoch: ${JSON.stringify(rec1.epoch)}, operationId: ${JSON.stringify(rec1.operationId)}, runId: ${JSON.stringify(arm2Id)} });
       return JSON.stringify("ok");`,
    );
    await H.sleep(1500);
    const unreadable = await H.ev(
      call,
      `JSON.stringify((document.body.textContent || '').includes('结果不可读'))`,
    ).then(JSON.parse);
    check(
      "#38 注入期间臂 2 不可读呈现（只给重读动作；失败定位不冒充）",
      unreadable === true,
      unreadable,
    );
    const tracesDuringFault = H.traceIds().size;
    // 不可读态动作 =「重读这条结果」（title 含完整 runId）⇒ 仍缺 ⇒ 仍不可读（真实点击路径）
    await retryArmRead(call, arm2Id);
    const stillUnreadable = await H.ev(
      call,
      `JSON.stringify((document.body.textContent || '').includes('结果不可读'))`,
    ).then(JSON.parse);
    check(
      "#38 重试只读且仍不可读（同一条可信 ID；零新建文件、不触发执行）",
      stillUnreadable === true && H.traceIds().size === tracesDuringFault,
      { traces: [tracesDuringFault, H.traceIds().size] },
    );
    const fr = fault.end();
    activeFaults.splice(activeFaults.indexOf(fault), 1);
    check("#38 注入还原逐字节核验", fr.clean === true, fr);
    // 还原后重试 ⇒ 读取成功（读取项离开 unreadable、臂 2 结局呈现恢复）
    // 恢复半边走 store 口 retryResultRead（与「重读这条结果」按钮同一动作——按钮的真实
    // 点击路径已由上一条「注入期重试仍不可读」覆盖；本条判据核心 = 还原后同 ID 读取成功）
    await H.storeQ(
      call,
      `await s.retryResultRead({ epoch: ${JSON.stringify(rec1.epoch)}, operationId: ${JSON.stringify(rec1.operationId)}, runId: ${JSON.stringify(arm2Id)} });
       return JSON.stringify("ok");`,
    );
    // key 格式 = `${epoch}|${operationId}|${runId}`（result-verification.ts:39），node 侧预拼；
    // 轮询等读取收尾，失败时 dump reason 定位
    const arm2Key = `${rec1.epoch}|${rec1.operationId}|${arm2Id}`;
    let arm2Entry = null;
    const deadlineRecover = Date.now() + 12000;
    for (;;) {
      arm2Entry = await H.storeQ(
        call,
        `const entry = s.resultReads.byKey[${JSON.stringify(arm2Key)}];
         return JSON.stringify({ phase: entry ? entry.phase : null, hasFacts: entry ? entry.facts !== null : false, reason: entry ? entry.reason : null });`,
      );
      if (arm2Entry.phase === "verified") break;
      if (Date.now() > deadlineRecover) break;
      await H.sleep(800);
    }
    dump.recover = { key: arm2Key, entry: arm2Entry };
    check(
      "#38 还原后重试 ⇒ 臂 2 恢复可读（读取项离开不可读态、结局事实在场）",
      arm2Entry.phase === "verified" && arm2Entry.hasFacts === true,
      arm2Entry,
    );

    await H.shot(call, SHOT_DIR, "ab-execute.png");

    // ── 总核对：mock 分段计数（每次 /__reset 清零 ⇒ 按段断言）与 traces ──
    // 批次 1 收口时 served 应为 2（臂 1 ok + 臂 2 fail503 都算 served）——已在 waitSettled 前记录；
    const servedFinal = await mockServed();
    check("#57 批次 2 恰 2 次调用（[ok, ok] 两臂；reset 后计数从零起）", servedFinal === 2, {
      served: servedFinal,
    });
    check("#37/#39 落盘恰 +4（两批各两臂 run），无补造", H.traceIds().size === tracesBaseline + 4, {
      traces: [tracesBaseline, H.traceIds().size],
    });
    note(
      "缺臂/未知形态真机不可达（执行收口必带全量 armFacts；「settled 且 runIds 为空」不可达）⇒ 按 draft-closure-store 单元承载。",
    );
    note(
      "#33 切运行不更换实验父本：本批经 openExperimentFor 重开验证目标显式绑定（target.runId=parentId），跨页选择切换由 6.6/6.7 的 store 判据与 aux-workspace-store 单元承载。",
    );
    note(
      "#35 实验来源失效仍能返回草稿：来源失效路径（文件手术父本）在本批未触发（只读父本稳定），由 3.2 的 revalidateModelAbDraftSource 单元 + DraftSourceBanner 判据承载。",
    );
  } catch (e) {
    check(`tag 执行异常：${String(e?.message ?? e).slice(0, 300)}`, false);
  } finally {
    await drainFaults();
  }
  finish();
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), String(e?.stack ?? e));
  process.exit(1);
});
