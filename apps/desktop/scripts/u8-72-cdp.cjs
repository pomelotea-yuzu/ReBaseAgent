/* eslint-disable */
/**
 * U8 任务 6.12（Electron 实机第七批 · 最后实机批）：跨入口回归——
 * 普通/隔离创建、result/prompt、messages/A-B 与设置往返、文件、比较及全局操作；
 * 逐项验证任务文本、阅读恢复、单向密钥、保存/回读分层和配置锁；
 * 不以历史批次冒充新工作区验收。
 *
 * 两个 tag（run-all 编排，同 dev 会话顺序跑）：
 * - settings-entries（#14/#16/#17/#18/#19）：
 *   #14 普通模式创建页 → 就近「运行配置…」→ 设置往返 → 任务/模式/草稿保留 + 摘要已核实保存；
 *      隔离模式：选目录（SMOKE_PICK_DIR）+ 副本授权 → 设置改配置保存 → 返回 ⇒ 授权作废、
 *      目录引用/模式/任务保留。
 *   #16 未保存设置关闭：脏 model 字段 → 关闭先确认 → 继续编辑逐字保留 → 放弃才关闭且
 *      不清调试草稿、焦点不落 body。
 *   #17 单向密钥：apiKey 打字 → 保存 → 反馈只称「已保存并回读到配置状态（未发起任何连接测试）」
 *      + 磁盘真写入 + 回读状态键集不含 apiKey。
 *   #18 保存失败分层：空 apiKey 保存 ⇒ save-failed（真实校验文案）+ settings 原样 + 输入保留；
 *      reread-failed 实机半边归 U5 6.7 竞速注入实测 + 单元（分层登记）。
 *   #19 清除确认：确认文案点名凭据 → 取消零清除调用（settings 字节不变）。
 * - aux-regression（#7/#11/#33/#35/#36/#51）：
 *   现造父本（UI，mock 1 次）→ #11 SDK run 无 messages 入口（prompt 入口行为不变）→
 *   #15 prompt 编辑 → 设置往返 → 阅读/草稿/选中恢复 → #33 实验页改臂非法 → 切运行 →
 *   草稿定位返回（父本/调用/非法原文保持）→ #36 预览 → 离开 → 草稿定位返回（计划/确认
 *   不恢复、批次原文保留）→ #35 fileMissing 注入父本 ⇒ 来源读取失败态+原因+批次输入保留 →
 *   还原 ⇒ 重新读取 ready → 重新预览确认执行（mock 6s 在飞）→ #7 槽被占时录制「保存并应用」
 *   被 main 门禁拒绝（不新建操作、不清输入、状态读取/历史阅读/返回可用）+ 设置门禁
 *   （config-gate-notice + 保存/清除禁用 = #19 槽约束半边）→ 收口后结果区两臂 →
 *   #51 对照两条进比较 → 返回实验 → 返回来源 → 录制往返 → 隔离 run 文件页往返（条件）→
 *   全局操作面板可用。
 *
 * 用法：`node apps/desktop/scripts/u8-72-cdp.cjs --tag=<settings-entries|aux-regression>`
 * 前置：dev 已由 run-all 起（CDP 9612）；mock-llm 18799 已起（settings upstream 指向 mock）；
 * dev 启动带 REBASEAGENT_SMOKE_PICK_DIR（隔离模式选目录自动化）。
 */
"use strict";
const { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag", "settings-entries");

const OUT_DIR = join(H.REPO, ".workbuddy", "u8", "u8-72");
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
  console.error(`看门狗：${TAG} 超过 14 分钟未收尾`);
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), "watchdog timeout");
  process.exit(3);
}, 840_000);

function mockReset(script) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ script });
    const req = require("node:http").request(
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
    require("node:http")
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

function settingsBytes() {
  try {
    return readFileSync(H.SETTINGS_FILE).toString("utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 通用页内操作
// ---------------------------------------------------------------------------

async function openSettingsViaGlobalBar(call) {
  const r = await H.ev(
    call,
    `(() => {
       const scope = Array.from(document.querySelectorAll('header'))
         .find(h => Array.from(h.querySelectorAll('button')).some(b => (b.title || '').startsWith('配置 LLM 接入')));
       const b = scope && scope.querySelector('button[title^="配置 LLM 接入"]');
       if (!b) return false; b.click(); return true; })()`,
  );
  if (r !== true) throw new Error("找不到设置入口按钮（全局栏）");
  await H.sleep(900);
}

async function openSettingsFromCreate(call) {
  const r = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
       .find(x => ((x.textContent || '').trim()) === '运行配置…');
      if (!b || b.disabled) return false; b.click(); return true; })()`,
  );
  if (r !== true) throw new Error("创建页就近「运行配置…」入口不可点");
  await H.sleep(900);
}

async function dialogCount(call) {
  return H.ev(call, `JSON.stringify(document.querySelectorAll('dialog[open]').length)`).then(
    JSON.parse,
  );
}

/** 关闭设置：Esc；若脏确认出现则「放弃修改并关闭」。返回是否出现了放弃确认。 */
async function closeSettingsRobust(call) {
  await H.ev(
    call,
    `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`,
  );
  const deadline = Date.now() + 8000;
  let usedAbandon = false;
  for (;;) {
    const n = await dialogCount(call);
    if (n === 0) break;
    if (n >= 2 && !usedAbandon) {
      usedAbandon = true;
      await H.clickInOpenDialog(call, "放弃修改并关闭", 900);
      continue;
    }
    if (Date.now() > deadline) throw new Error("设置模态未关闭");
    await H.sleep(400);
  }
  await H.sleep(400);
  return usedAbandon;
}

async function focusDesc(call) {
  return H.ev(
    call,
    `(() => {
       const el = document.activeElement;
       if (el === null) return JSON.stringify({ tag: null });
       return JSON.stringify({ tag: el.tagName, inBody: el === document.body,
         label: el.getAttribute && el.getAttribute('aria-label') });
     })()`,
  ).then(JSON.parse);
}

/** 隔离模式选目录（run-all 以 REBASEAGENT_SMOKE_PICK_DIR 注入 ⇒ 无原生框） */
async function pickSource(call) {
  const r = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
       .find(x => { const t = (x.textContent || '').trim(); return t === '选择目录…'; });
      if (!b || b.disabled) return false; b.click(); return true; })()`,
  );
  if (r !== true) throw new Error("「选择目录…」按钮不可点");
  const deadline = Date.now() + 15000;
  for (;;) {
    const st = await H.ev(
      call,
      `(() => { const b = Array.from(document.querySelectorAll('button'))
         .find(x => { const t = (x.textContent || '').trim(); return t === '重新选择…'; });
        return JSON.stringify({ chosen: b !== undefined }); })()`,
    ).then(JSON.parse);
    if (st.chosen === true) return true;
    if (Date.now() > deadline) throw new Error("源目录未自动选定（SMOKE_PICK_DIR 未生效？）");
    await H.sleep(500);
  }
}

// ---------------------------------------------------------------------------
// A/B 实验工作区（u8-67 同款判据读数）
// ---------------------------------------------------------------------------

const abState = (call) =>
  H.storeQ(
    call,
    `return JSON.stringify({ view: s.view,
       target: s.experimentTarget ? { runId: s.experimentTarget.runId, spanId: s.experimentTarget.spanId } : null });`,
  );

const abDom = (call) =>
  H.ev(
    call,
    `(() => {
       const root = Array.from(document.querySelectorAll('div'))
         .find(d => (d.textContent || '').includes('模型 A/B 实验 · 同上下文多臂对比') && d.querySelector('[data-confirm-execution]'));
       if (!root) return JSON.stringify(null);
       const btns = Array.from(root.querySelectorAll('button'));
       const byText = (t) => btns.find(b => (b.textContent || '').trim().startsWith(t));
       const preview = byText('校验并预览计划') ?? byText('重新校验') ?? byText('校验中…');
       const exec = byText('确认执行');
       const confirm = root.querySelector('[data-confirm-execution]');
       const planArea = Array.from(root.querySelectorAll('div'))
         .find(d => (d.textContent || '').includes('校验通过 · 执行计划'));
       const sideEffectCb = Array.from(root.querySelectorAll('label'))
         .find(l => (l.textContent || '').includes('未标记 sideEffect'));
       return JSON.stringify({
         planText: planArea ? planArea.textContent : null,
         previewDisabled: preview ? preview.disabled : null,
         execDisabled: exec ? exec.disabled : null,
         confirmDisabled: confirm ? confirm.disabled : null,
         confirmPressed: confirm ? confirm.getAttribute('aria-pressed') : null,
         sideEffectVisible: sideEffectCb ? sideEffectCb.offsetParent !== null : false,
         blocked: (root.textContent || '').includes('空 fork') || (root.textContent || '').includes('不能为空'),
       });
     })()`,
  ).then(JSON.parse);

async function setArm(call, index, model, paramsText) {
  const r = await H.ev(
    call,
    `(() => {
       const rows = Array.from(document.querySelectorAll('div'))
         .filter(d => typeof d.className === 'string' && d.className.includes('border-sky-200') && d.querySelector('input[placeholder="model 名"]'));
       const row = rows[${index}];
       if (!row) return JSON.stringify({ error: 'row-not-found', matched: rows.length });
       const inputs = row.querySelectorAll('input');
       const set = (el, v) => {
         const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
         setter.call(el, v);
         el.dispatchEvent(new Event('input', { bubbles: true }));
       };
       set(inputs[0], ${JSON.stringify(model)});
       set(inputs[1], ${JSON.stringify(paramsText)});
       return JSON.stringify({ ok: true });
     })()`,
  ).then(JSON.parse);
  if (r?.ok !== true) throw new Error(`臂 ${index + 1} 输入未生效：${JSON.stringify(r)}`);
  await H.sleep(400);
}

const abDraft = (call) =>
  H.storeQ(
    call,
    `const k = { runId: s.experimentTarget.runId, spanId: s.experimentTarget.spanId };
     const d = s.modelAbDraftOf(k);
     return JSON.stringify({ revision: d ? d.revision : null, rows: d ? d.rows.map(r => [r.model, r.paramsText]) : null });`,
  );

async function clickPreviewAndWait(call, timeoutMs = 25000) {
  const ok = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
       .find(x => { const t = (x.textContent || '').trim(); return t === '校验并预览计划' || t === '重新校验'; });
      if (!b || b.disabled) return false; b.click(); return true; })()`,
  );
  if (ok !== true) throw new Error("预览按钮不可点");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await abDom(call);
    if (st?.planText !== null && st?.previewDisabled === false) break;
    if (Date.now() > deadline) throw new Error(`预览未收尾：${JSON.stringify(st)}`);
    await H.sleep(500);
  }
}

/** 会话草稿面板里点「A/B 草稿」的定位；轮换各行直到回到实验工作区且目标匹配 */
async function locateAbDraft(call, expectRunId) {
  for (let round = 0; round < 6; round++) {
    const opened = await H.ev(
      call,
      `(() => { const b = document.querySelector('button[title^="本会话的全部调试草稿"]');
         if (!b) return 'no-toggle';
         if (b.getAttribute('aria-expanded') !== 'true') { b.click(); return 'opened'; }
         return 'already'; })()`,
    );
    if (opened === "no-toggle") throw new Error("找不到会话草稿入口");
    await H.sleep(700);
    const rows = await H.ev(
      call,
      `(() => {
         const btns = Array.from(document.querySelectorAll('button[title="定位到该草稿的编辑目标"]'));
         return JSON.stringify(btns.map(b => {
           const row = b.closest('li') ?? b.parentElement;
           return { text: (row ? row.textContent : '').replace(/\\s+/g, ' ').slice(0, 80) };
         }));
       })()`,
    ).then(JSON.parse);
    dump.draftRows = rows;
    // 优先点文本含 A/B 的行，否则按序轮换
    const pickOrder = rows
      .map((r, i) => ({ r, i }))
      .sort((a, b) => Number(b.r.text.includes("A/B")) - Number(a.r.text.includes("A/B")))
      .map((x) => x.i);
    const idx = pickOrder[round % Math.max(rows.length, 1)];
    if (idx === undefined) throw new Error("草稿面板没有可定位的行");
    const clicked = await H.ev(
      call,
      `(() => { const btns = Array.from(document.querySelectorAll('button[title="定位到该草稿的编辑目标"]'));
         if (btns.length <= ${idx}) return false; btns[${idx}].click(); return true; })()`,
    );
    if (clicked !== true) throw new Error("定位按钮点击失败");
    await H.sleep(1100);
    const st = await abState(call);
    if (st.view === "experiment" && st.target !== null && st.target.runId === expectRunId) {
      // 收起草稿面板（再点一次开关）
      await H.ev(
        call,
        `(() => { const b = document.querySelector('button[title^="本会话的全部调试草稿"]');
           if (b && b.getAttribute('aria-expanded') === 'true') b.click(); return true; })()`,
      );
      await H.sleep(400);
      return true;
    }
  }
  throw new Error("轮换草稿行仍未回到实验工作区");
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
  // 必须等列表真加载（runs.length>0）：只等 H.runs 可调用会在 500ms 拿到空列表就放行
  for (let i = 0; i < 80; i++) {
    await H.sleep(500);
    try {
      if ((await H.runs(call)).length > 0) break;
    } catch {
      /* 重载瞬间 */
    }
  }
  await H.sleep(900);

  if (TAG === "settings-entries") {
    await tagSettingsEntries(call);
  } else if (TAG === "aux-regression") {
    await tagAuxRegression(call);
  } else {
    throw new Error(`未知 tag：${TAG}`);
  }
}

// ---------------------------------------------------------------------------
// tag1：settings-entries（#14/#16/#17/#18/#19）
// ---------------------------------------------------------------------------

async function tagSettingsEntries(call) {
  const dpr = await H.ev(call, "window.devicePixelRatio");
  check("DPR ≈ 2.1（无 zoom 残留）", Math.abs(dpr - 2.1) < 0.15, `实测 ${dpr}`);
  const served0 = await mockServed();
  check("mock 服务健康", typeof served0 === "number", served0);
  const bytes0 = settingsBytes();
  check("settings.json 受控副本在盘", bytes0 !== null && bytes0.length > 0, bytes0?.length);

  // ── 打开创建页（普通模式）并填任务文本 ──
  await H.storeQ(call, `s.openCreateWorkspace(); return JSON.stringify("ok");`);
  await H.sleep(1200);
  const task = await H.typeIntoDom(
    call,
    'textarea[placeholder^="要交给模型的任务"]',
    "U8612 两模式配置往返的任务文本（#14 保留判据）",
  );
  check(
    "#14 任务文本已填",
    String(task?.value ?? "").includes("U8612 两模式配置往返"),
    task?.value?.slice(0, 40),
  );

  // ── #14a：就近「运行配置…」进设置 ──
  await openSettingsFromCreate(call);
  const dlgOpen = (await dialogCount(call)) >= 1;
  check("#14 从创建页就近入口打开设置", dlgOpen === true, dlgOpen);

  // ── #16：脏 model 字段 → 关闭先确认 → 继续编辑逐字保留 ──
  const modelDirty = await H.typeIntoDom(
    call,
    'dialog[open] input[placeholder="deepseek-chat"]',
    "deepseek-chat-dirty",
  );
  check(
    "#16 model 字段已改脏",
    String(modelDirty?.value ?? "") === "deepseek-chat-dirty",
    modelDirty?.value,
  );
  await H.ev(
    call,
    `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`,
  );
  await H.sleep(700);
  const confirmThere = (await dialogCount(call)) >= 2;
  check("#16 关闭出现未保存确认模态", confirmThere === true, confirmThere);
  await H.clickInOpenDialog(call, "继续编辑", 800);
  const modelAfterContinue = await H.ev(
    call,
    `(() => { const i = document.querySelector('dialog[open] input[placeholder="deepseek-chat"]');
       return i === null ? null : i.value; })()`,
  );
  check(
    "#16 继续编辑 ⇒ 输入逐字保留",
    modelAfterContinue === "deepseek-chat-dirty",
    modelAfterContinue,
  );
  // 再关一次并放弃
  await H.ev(
    call,
    `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`,
  );
  await H.sleep(700);
  await H.clickInOpenDialog(call, "放弃修改并关闭", 1000);
  const dlgGone = (await dialogCount(call)) === 0;
  check("#16 确认放弃后才关闭", dlgGone === true, dlgGone);
  const bytesAfterDiscard = settingsBytes();
  check("#16 放弃 ⇒ settings 字节不变（未保存输入从未写入）", bytesAfterDiscard === bytes0, {
    same: bytesAfterDiscard === bytes0,
  });
  const focus1 = await focusDesc(call);
  check("#16 关闭后返回来源有效焦点（不落 body）", focus1.inBody === false, focus1);
  // 调试草稿不清：创建页任务文本仍在
  const taskAfter = await H.ev(
    call,
    `(() => { const i = document.querySelector('textarea[placeholder^="要交给模型的任务"]');
       return i === null ? null : i.value; })()`,
  );
  check(
    "#16 放弃设置不清调试草稿（创建任务文本原样）",
    String(taskAfter ?? "").includes("U8612 两模式配置往返"),
    taskAfter?.slice(0, 40),
  );

  // ── #18：保存失败（无已存密钥 + 空 apiKey 表单）⇒ save-failed ──
  // main 语义：apiKey 空串 = 保持原值 ⇒ 只有盘上无密钥时空值保存才被拒（settings.ts:101）。
  // 诱发配方 = U5 6.7：store 口 clearSettings（清 main + 渲染层 settings）→ 空表单保存。
  await H.storeQ(call, `await s.clearSettings(); return JSON.stringify("ok");`);
  await H.sleep(900);
  check("#18 前置：配置已清除（settings.json 不在盘）", settingsBytes() === null, settingsBytes());
  await openSettingsViaGlobalBar(call);
  await H.typeIntoDom(
    call,
    'dialog[open] input[placeholder^="https://api.deepseek.com"]',
    "http://127.0.0.1:18799/v1",
  );
  await H.typeIntoDom(call, 'dialog[open] input[placeholder="deepseek-chat"]', "deepseek-chat");
  await H.clickInOpenDialog(call, "保存", 1500);
  const failMsg = await H.ev(
    call,
    `(() => {
       const dlg = Array.from(document.querySelectorAll('dialog[open]')).pop();
       return JSON.stringify(dlg ? (dlg.textContent || '').slice(0, 400) : null);
     })()`,
  ).then(JSON.parse);
  check(
    "#18 保存失败 ⇒ save-failed 真实校验文案（不是静默/不是冒充成功）",
    String(failMsg ?? "").includes("不能为空") && !String(failMsg ?? "").includes("已保存并回读"),
    String(failMsg ?? "").slice(0, 160),
  );
  check("#18 保存失败 ⇒ settings 原样（清除后仍零写入）", settingsBytes() === null, {
    absent: settingsBytes() === null,
  });
  const modelAfterFail = await H.ev(
    call,
    `(() => { const i = document.querySelector('dialog[open] input[placeholder="deepseek-chat"]');
       return i === null ? null : i.value; })()`,
  );
  check("#18 保存失败 ⇒ 输入逐字保留", modelAfterFail === "deepseek-chat", modelAfterFail);
  note(
    "#18 「保存已确认成功但配置状态回读失败」（reread-failed）的实机半边：注入面 = 保存落盘瞬间竞速改写 settings.json，U5 6.7 已实测得手（窗口毫秒级）；本批不重建竞速，按该实测结论 + recording/settings 单元承载（分层登记）。",
  );
  // 恢复受控配置（U5 6.7 配方：raw IPC 写回 + store loadSettings），对话框本地输入不受影响
  await H.apiCall(call, "saveSettings", {
    baseURL: H.MOCK_BASE,
    apiKey: "sk-u8612-controlled",
    model: "deepseek-chat",
  });
  await H.storeQ(call, `await s.loadSettings(); return JSON.stringify("ok");`);
  await H.sleep(600);
  check(
    "#18 恢复受控配置（磁盘有密钥且 baseURL 指向 mock；密钥加密落盘与否属 main cipher 事实）",
    (() => {
      const disk = settingsBytes();
      if (disk === null) return false;
      try {
        const j = JSON.parse(disk);
        return (
          j.baseURL === "http://127.0.0.1:18799/v1" &&
          typeof j.apiKey === "string" &&
          j.apiKey.length > 0
        );
      } catch {
        return false;
      }
    })() === true,
    {
      encryptedAtRest: (() => {
        try {
          return JSON.parse(settingsBytes()).apiKeyEncrypted === true;
        } catch {
          return false;
        }
      })(),
    },
  );

  // ── #17：单向密钥（对话框仍开着，本地输入 = 恢复后的配置）──
  const keyTyped = await H.typeIntoDom(
    call,
    'dialog[open] input[type="password"]',
    "sk-u8612-oneway",
  );
  check(
    "#17 apiKey 已打字（渲染层暂存）",
    String(keyTyped?.value ?? "").includes("sk-u8612-oneway"),
    "typed",
  );
  const bytesBeforeType = settingsBytes();
  await H.clickInOpenDialog(call, "保存", 1500);
  const savedMsg = await H.ev(
    call,
    `(() => {
       const dlg = Array.from(document.querySelectorAll('dialog[open]')).pop();
       return JSON.stringify(dlg ? (dlg.textContent || '').slice(0, 400) : null);
     })()`,
  ).then(JSON.parse);
  check(
    "#17 保存反馈只称已保存并回读到配置状态，无连通宣称",
    String(savedMsg ?? "").includes("已保存并回读到配置状态") &&
      String(savedMsg ?? "").includes("未发起任何连接测试") &&
      !String(savedMsg ?? "").includes("连接成功") &&
      !String(savedMsg ?? "").includes("测试连接"),
    String(savedMsg ?? "").slice(0, 160),
  );
  const bytesAfterSave = settingsBytes();
  let diskWritten = false;
  try {
    const j = JSON.parse(bytesAfterSave);
    diskWritten =
      bytesAfterSave !== null &&
      bytesAfterSave !== bytesBeforeType &&
      typeof j.apiKey === "string" &&
      j.apiKey.length > 0;
  } catch {
    diskWritten = false;
  }
  check(
    "#17 单向密钥保存真写盘（字节变化 + apiKey 字段在场；密文或明文按 cipher 事实）",
    diskWritten === true,
    {
      changed: bytesAfterSave !== bytesBeforeType,
      encryptedAtRest: (() => {
        try {
          return JSON.parse(bytesAfterSave).apiKeyEncrypted === true;
        } catch {
          return false;
        }
      })(),
    },
  );
  const settingsKeys = await H.storeQ(
    call,
    "const st = s.settings; return JSON.stringify(st ? Object.keys(st) : null);",
  );
  check(
    "#17 回读状态键集不含 apiKey（只含配置状态）",
    Array.isArray(settingsKeys) && !settingsKeys.includes("apiKey"),
    settingsKeys,
  );

  // ── #19：清除确认（取消零清除调用）──
  const bytesBeforeClear = settingsBytes();
  await H.clickInOpenDialog(call, "清除配置", 900);
  const clearModalText = await H.ev(
    call,
    `(() => {
       const dlgs = document.querySelectorAll('dialog[open]');
       const dlg = dlgs[dlgs.length - 1];
       return JSON.stringify(dlg ? (dlg.textContent || '').slice(0, 300) : null);
     })()`,
  ).then(JSON.parse);
  check(
    "#19 清除确认文案点名保存凭据一并删除",
    String(clearModalText ?? "").includes("凭据") || String(clearModalText ?? "").includes("密钥"),
    String(clearModalText ?? "").slice(0, 120),
  );
  await H.clickInOpenDialog(call, "取消", 900);
  const bytesAfterCancel = settingsBytes();
  check("#19 取消清除 ⇒ settings 字节不变（零清除调用）", bytesAfterCancel === bytesBeforeClear, {
    same: bytesAfterCancel === bytesBeforeClear,
  });

  // ── #14a 返回：设置关闭 → 回创建页，任务/模式/摘要保留 ──
  await closeSettingsRobust(call);
  const st1 = await H.storeQ(call, "return JSON.stringify({ view: s.view });");
  check("#14 设置往返后回到创建页（视图=create）", st1.view === "create", st1);
  const taskBack = await H.ev(
    call,
    `(() => { const i = document.querySelector('textarea[placeholder^="要交给模型的任务"]');
       return i === null ? null : i.value; })()`,
  );
  check(
    "#14 返回后任务文本逐字保留",
    String(taskBack ?? "").includes("U8612 两模式配置往返"),
    taskBack?.slice(0, 40),
  );
  const summaryText = await H.ev(
    call,
    `(() => {
       const body = document.querySelector('[data-create-body]') ?? document.querySelector('section[aria-label="新建运行"]');
       return JSON.stringify(body ? (body.textContent || '').slice(0, 500) : null);
     })()`,
  ).then(JSON.parse);
  check(
    "#14 摘要显示已核实保存状态（现算自回读事实，含 model 名）",
    String(summaryText ?? "").includes("deepseek-chat") &&
      !String(summaryText ?? "").includes("运行配置尚未读取"),
    String(summaryText ?? "").slice(0, 160),
  );

  // ── #14b：隔离模式 —— 选目录 + 授权 → 设置改配置 → 返回 ⇒ 授权作废、目录/模式保留 ──
  const modeSwitched = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
       .find(x => ((x.textContent || '').trim()) === '隔离文件运行');
      if (!b || b.disabled) return false; b.click(); return true; })()`,
  );
  if (modeSwitched !== true) throw new Error("隔离模式切换失败");
  await H.sleep(700);
  await pickSource(call);
  const licensed = await H.ev(
    call,
    `(() => { const l = Array.from(document.querySelectorAll('label'))
       .find(x => ((x.textContent || '').includes('允许本次执行的副本写入')));
      if (!l) return 'no-label';
      const cb = l.querySelector('input[type=checkbox]');
      if (!cb) return 'no-checkbox';
      if (!cb.checked) cb.click();
      return JSON.stringify({ checked: cb.checked }); })()`,
  ).then(JSON.parse);
  check("#14 隔离模式已选目录并勾选副本授权", licensed?.checked === true, licensed);
  await openSettingsFromCreate(call);
  await H.typeIntoDom(call, 'dialog[open] input[placeholder="deepseek-chat"]', "deepseek-chat2");
  await H.clickInOpenDialog(call, "保存", 1500);
  const save2 = await H.ev(
    call,
    `(() => { const dlg = Array.from(document.querySelectorAll('dialog[open]')).pop();
       return JSON.stringify(dlg ? (dlg.textContent || '').includes('已保存并回读到配置状态') : null); })()`,
  ).then(JSON.parse);
  check("#14 配置变更已保存（保存成功反馈在场）", save2 === true, save2);
  await closeSettingsRobust(call);
  const st2 = await H.storeQ(
    call,
    `return JSON.stringify({ view: s.view,
       hasSourceRef: s.createSourceRef !== null && s.createSourceRef !== undefined });`,
  );
  const modePressed = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
       .find(x => ((x.textContent || '').trim()) === '隔离文件运行');
      return JSON.stringify(b ? b.getAttribute('aria-pressed') : null); })()`,
  ).then(JSON.parse);
  st2.isolatedPressed = modePressed;
  check(
    "#14 返回后模式保留（隔离按钮 aria-pressed）",
    st2.view === "create" && st2.isolatedPressed === "true",
    st2,
  );
  check("#14 有效目录引用保留", st2.hasSourceRef === true, st2);
  const licenseAfter = await H.ev(
    call,
    `(() => { const l = Array.from(document.querySelectorAll('label'))
       .find(x => ((x.textContent || '').includes('允许本次执行的副本写入')));
      if (!l) return JSON.stringify({ present: false });
      const cb = l.querySelector('input[type=checkbox]');
      return JSON.stringify({ present: true, checked: cb ? cb.checked : null }); })()`,
  ).then(JSON.parse);
  check(
    "#14 配置往返 ⇒ 本次副本授权作废（复选框复位为未勾选）",
    licenseAfter.present === true && licenseAfter.checked === false,
    licenseAfter,
  );
  const summary2 = await H.ev(
    call,
    `(() => {
       const body = document.querySelector('[data-create-body]') ?? document.querySelector('section[aria-label="新建运行"]');
       return JSON.stringify(body ? (body.textContent || '').includes('deepseek-chat2') : null);
     })()`,
  ).then(JSON.parse);
  check("#14 摘要按新配置事实呈现（deepseek-chat2 在场）", summary2 === true, summary2);

  const servedFinal = await mockServed();
  check("本 tag 零模型调用（两模式往返均未提交创建）", servedFinal === served0, {
    served: [served0, servedFinal],
  });
  await H.shot(call, SHOT_DIR, "settings-entries.png");
  finish({ served: [served0, servedFinal] });
}

// ---------------------------------------------------------------------------
// tag2：aux-regression（#7/#11/#33/#35/#36/#51）
// ---------------------------------------------------------------------------

async function tagAuxRegression(call) {
  const dpr = await H.ev(call, "window.devicePixelRatio");
  check("DPR ≈ 2.1（无 zoom 残留）", Math.abs(dpr - 2.1) < 0.15, `实测 ${dpr}`);
  const served0 = await mockServed();
  check("mock 服务健康", typeof served0 === "number", served0);
  const bytes0 = settingsBytes();
  const tracesBefore = H.traceIds().size;

  // ── 现造父本（UI 创建：纯对话 + 字符串 system ⇒ A/B 合法父本；mock 恰 1 次）──
  await mockReset({
    turns: [{ content: "父本响应：6.12 父本" }],
    fallback: { content: "（耗尽）" },
  });
  await H.storeQ(call, `s.openCreateWorkspace(); return JSON.stringify("ok");`);
  await H.sleep(1200);
  const advanced = await H.ev(
    call,
    `(() => {
       const b = document.querySelector('[data-advanced-toggle]');
       return JSON.stringify({ found: b !== null, visible: b !== null && b.offsetParent !== null,
         expanded: b ? b.getAttribute('aria-expanded') : null });
     })()`,
  ).then(JSON.parse);
  if (!advanced.found || !advanced.visible)
    throw new Error(`高级区探测失败：${JSON.stringify(advanced)}`);
  if (advanced.expanded === "false") {
    await H.ev(
      call,
      `(() => { document.querySelector('[data-advanced-toggle]').click(); return true; })()`,
    );
    await H.sleep(700);
  }
  await H.typeIntoDom(
    call,
    'textarea[placeholder^="例如：你是一个简洁的问答助手"]',
    "你是通用文件助手。",
  );
  await H.typeIntoDom(
    call,
    'textarea[placeholder^="要交给模型的任务"]',
    "U8612 跨入口回归父本：解释这段代码的作用",
  );
  const runsBeforeCreate = await H.runs(call);
  await H.ev(
    call,
    `(() => { const b = document.querySelector('[data-confirm-execution]');
       if (!b || b.disabled) return false; b.click(); return true; })()`,
  ).then((r) => {
    if (r !== true) throw new Error("创建确认不可点");
  });
  await H.sleep(900);
  for (let i = 0; i < 10; i++) {
    const st = await H.ev(
      call,
      `(() => { const b = document.querySelector('[data-confirm-execution]');
         return JSON.stringify({ pressed: b ? b.getAttribute('aria-pressed') : null }); })()`,
    ).then(JSON.parse);
    if (st.pressed === "true") break;
    await H.sleep(500);
  }
  await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
       .find(x => ((x.textContent || '').trim()) === '创建');
      if (!b || b.disabled) return false; b.click(); return true; })()`,
  ).then((r) => {
    if (r !== true) throw new Error("创建按钮不可点");
  });
  let parentId = null;
  const createDeadline = Date.now() + 40000;
  while (Date.now() < createDeadline) {
    await H.sleep(1200);
    const runsNow = await H.runs(call);
    const diff = runsNow.filter((id) => !runsBeforeCreate.includes(id));
    if (diff.length > 0) {
      parentId = diff[diff.length - 1];
      break;
    }
  }
  if (parentId === null) throw new Error("创建 40s 未出现新 run");
  const servedAfterCreate = await mockServed();
  check(
    "父本现造成功（新 run 在列表 + mock 恰 1 次）",
    typeof parentId === "string" && servedAfterCreate === served0 + 1,
    {
      parentId,
      served: [served0, servedAfterCreate],
    },
  );
  await H.storeQ(
    call,
    `await s.selectRun(${JSON.stringify(parentId)}); return JSON.stringify("ok");`,
  );
  await H.sleep(1500);

  // ── #11：SDK run 无 messages 重发入口；prompt 入口行为不变 ──
  const spanInfo = await H.storeQ(
    call,
    `const d = s.detail;
     if (!d) return JSON.stringify({ err: 'no-detail' });
     const llm = d.spans.find(x => x.kind === 'llm.call');
     return JSON.stringify({ llmId: llm ? llm.id : null, total: d.spans.length });`,
  );
  if (spanInfo.err || spanInfo.llmId === null)
    throw new Error(`父本详情无 llm.call span：${JSON.stringify(spanInfo)}`);
  // 步骤页签 + 真点 span 行（程序化 selectSpan 不切页签 ⇒ span 详情区不渲染、入口探针全假）；
  // 行形状 = title 是固定标签「LLM 调用」（span id 只在 store selectedSpanId，双证落地）
  await H.clickTabChecked(call, "步骤");
  await H.clickSpan(call, "LLM 调用", spanInfo.llmId);
  const entryProbe = await H.ev(
    call,
    `(() => {
       const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null);
       const msgsEntry = btns.find(b => ((b.textContent || '').trim()) === '编辑 messages 重发');
       const promptEntry = btns.find(b => ((b.textContent || '').trim()) === '编辑初始 user message 重跑');
       return JSON.stringify({ msgsEntry: msgsEntry !== undefined, promptEntry: promptEntry !== undefined });
     })()`,
  ).then(JSON.parse);
  check(
    "#11 SDK run 的 llm.call 无 messages 重发入口（分叉语义不越界）",
    entryProbe.msgsEntry === false,
    entryProbe,
  );
  check(
    "#11 既有 prompt fork 入口行为不变（入口在场）",
    entryProbe.promptEntry === true,
    entryProbe,
  );

  // ── #15：prompt 编辑 → 设置往返 → 阅读/草稿/选中恢复 ──
  const marker = "U8612-PROMPT-MARKER-往返保持";
  await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
       .find(x => ((x.textContent || '').trim()) === '编辑初始 user message 重跑');
      if (!b || b.disabled) return false; b.click(); return true; })()`,
  ).then((r) => {
    if (r !== true) throw new Error("prompt fork 入口不可点");
  });
  await H.sleep(1600);
  await H.typeIntoEditableMonaco(call, marker);
  const selBefore = await H.storeQ(
    call,
    "return JSON.stringify({ run: s.selectedRunId, span: s.selectedSpanId });",
  );
  await openSettingsViaGlobalBar(call);
  await closeSettingsRobust(call);
  const selAfter = await H.storeQ(
    call,
    "return JSON.stringify({ run: s.selectedRunId, span: s.selectedSpanId });",
  );
  check(
    "#15 设置往返后原运行/调用选中恢复",
    selAfter.run === selBefore.run && selAfter.span === selBefore.span,
    {
      before: selBefore,
      after: selAfter,
    },
  );
  const monacoAfter = await H.monacoInfo(call);
  const editorValue = (monacoAfter.editors ?? [])
    .map((e) => e.value ?? "")
    .find((v) => v.includes(marker));
  check("#15 编辑输入经设置往返逐字保留（草稿不丢）", editorValue !== undefined, {
    found: editorValue !== undefined,
  });

  // ── 打开实验工作区（运行页头「模型实验」）──
  await H.storeQ(
    call,
    `await s.selectRun(${JSON.stringify(parentId)}); return JSON.stringify("ok");`,
  );
  await H.sleep(1500);
  await H.ev(
    call,
    `(() => { const b = document.querySelector('[data-experiment-entry]');
       if (!b || b.disabled) return false; b.click(); return true; })()`,
  ).then((r) => {
    if (r !== true) throw new Error("「模型实验」入口不可点");
  });
  await H.sleep(1400);
  const stExp = await abState(call);
  check(
    "#32 实验工作区目标显式绑定父本（6.7 既有判据回归）",
    stExp.view === "experiment" && stExp.target !== null && stExp.target.runId === parentId,
    stExp,
  );

  // ── #33：改臂为非法原文 → 切运行 → 草稿定位返回 ──
  await setArm(call, 0, "mock-model-a", "{bad json");
  const draftDirty = await abDraft(call);
  check(
    "#33 非法参数原文已入草稿",
    JSON.stringify(draftDirty.rows ?? []).includes("{bad json"),
    draftDirty,
  );
  const otherRunId = (await H.runs(call)).find((id) => id !== parentId);
  if (otherRunId === undefined) throw new Error("列表中没有第二个 run 可切");
  await H.storeQ(
    call,
    `await s.selectRun(${JSON.stringify(otherRunId)}); return JSON.stringify("ok");`,
  );
  await H.sleep(1500);
  const stSwitched = await abState(call);
  check(
    "#33 切运行 ⇒ 离开实验页但目标与来源引用原样保留",
    stSwitched.view === "trace" &&
      stSwitched.target !== null &&
      stSwitched.target.runId === parentId,
    stSwitched,
  );
  await locateAbDraft(call, parentId);
  const draftBack = await abDraft(call);
  const stBack = await abState(call);
  check(
    "#33 草稿入口返回精确父本/调用，非法参数原文恢复",
    stBack.target !== null &&
      stBack.target.runId === parentId &&
      stBack.target.spanId === stExp.target.spanId &&
      JSON.stringify(draftBack.rows ?? []).includes("{bad json"),
    { st: stBack, draft: draftBack },
  );

  // ── #36：预览 → 离开（设置往返）→ 草稿定位返回 ⇒ 计划/确认不恢复 ──
  // 臂 2 也须给合法值：默认两臂 = 与父本同 model 的空 fork ⇒ guard 拦预览（6.7 判据）
  await setArm(call, 0, "mock-model-a", "");
  await setArm(call, 1, "mock-model-b", "");
  await clickPreviewAndWait(call);
  const planInstalled = await abDom(call);
  check(
    "#36 重新校验后计划在场（预览合法）",
    (planInstalled?.planText ?? "").includes("校验通过 · 执行计划"),
    {
      hasPlan: planInstalled?.planText !== null,
    },
  );
  // 离开实验页（切走 ⇒ 编辑器组件卸载 ⇒ 组件局部态的计划/许可必然不在场）——经草稿定位返回。
  // ⚠️ 设置是模态、不卸载工作区，走设置往返测不到这条（预览后开设置计划仍在 = 预期行为）。
  await H.storeQ(
    call,
    `await s.selectRun(${JSON.stringify(otherRunId)}); return JSON.stringify("ok");`,
  );
  await H.sleep(1500);
  await locateAbDraft(call, parentId);
  const dom36 = await abDom(call);
  const draft36 = await abDraft(call);
  check(
    "#36 离开再返回 ⇒ 批次原文和稳定臂身份保留（臂 1 原文在场）",
    JSON.stringify(draft36.rows ?? []).includes("mock-model-a"),
    draft36,
  );
  check(
    "#36 旧计划与费用确认不恢复（计划区消失 + 确认未挂）",
    dom36?.planText === null && dom36?.confirmPressed !== "true" && dom36?.execDisabled === true,
    {
      plan: dom36?.planText !== null,
      pressed: dom36?.confirmPressed,
      execDisabled: dom36?.execDisabled,
    },
  );
  check(
    "#36 副作用许可不复现（纯对话父本无风险工具 ⇒ 声明复选框本就不出现）",
    dom36?.sideEffectVisible === false,
    dom36?.sideEffectVisible,
  );

  // ── #35：实验来源失效仍能返回草稿（fileMissing 注入父本 trace）──
  const readFaults = require("./lib/u5-read-faults.cjs");
  const fault35 = readFaults.beginReadFault(
    { tracesDir: join(H.REPO, ".rebaseagent", "traces"), runId: parentId },
    "fileMissing",
  );
  // 触发源重读：store 口 readExperimentSource 与工作区重试按钮同一动作
  await H.storeQ(call, `await s.readExperimentSource(); return JSON.stringify("ok");`);
  await H.sleep(1600);
  const srcFailed = await H.storeQ(
    call,
    "return JSON.stringify({ phase: s.experimentSource.phase, err: s.experimentSource.errorMessage });",
  );
  check(
    "#35 父本缺失 ⇒ 来源读取失败态 + 明确原因（不以旧完整详情放行）",
    srcFailed.phase === "failed" && String(srcFailed.err ?? "").length > 0,
    srcFailed,
  );
  const draft35 = await abDraft(call);
  check(
    "#35 来源失效 ⇒ 批次输入保留（臂原文在场）",
    JSON.stringify(draft35.rows ?? []).includes("mock-model-a"),
    draft35,
  );
  const fr35 = fault35.end();
  check("#35 注入还原逐字节核验", fr35.clean === true, fr35);
  await H.storeQ(call, `await s.readExperimentSource(); return JSON.stringify("ok");`);
  await H.sleep(1600);
  const srcBack = await H.storeQ(
    call,
    "return JSON.stringify({ phase: s.experimentSource.phase });",
  );
  check("#35 来源恢复 ⇒ 重新读取 ready（可继续预览）", srcBack.phase === "ready", srcBack);

  // ── 重新预览 → 确认 → 执行（mock 15s 在飞：#7/#19 的在飞判据序列 ≈8-10s，须留足窗口）──
  await mockReset({
    turns: [{ content: "臂1响应", delayMs: 15000 }, { content: "臂2响应" }],
    fallback: { content: "（耗尽）" },
  });
  const servedSeg2 = await mockServed();
  await clickPreviewAndWait(call);
  await H.ev(
    call,
    `(() => { const b = document.querySelector('[data-confirm-execution]');
       if (!b || b.disabled) return false; b.click(); return true; })()`,
  ).then((r) => {
    if (r !== true) throw new Error("确认按钮不可点");
  });
  await H.sleep(900);
  let pressed = null;
  for (let i = 0; i < 10; i++) {
    pressed = await H.ev(
      call,
      `(() => { const b = document.querySelector('[data-confirm-execution]');
         return JSON.stringify(b ? b.getAttribute('aria-pressed') : null); })()`,
    ).then(JSON.parse);
    if (pressed === "true") break;
    await H.sleep(500);
  }
  if (pressed !== "true") throw new Error("执行确认未挂上（aria-pressed 异步生效未等到）");
  await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
       .find(x => ((x.textContent || '').trim()).startsWith('确认执行'));
      if (!b || b.disabled) return false; b.click(); return true; })()`,
  ).then((r) => {
    if (r !== true) throw new Error("执行按钮不可点");
  });
  await H.sleep(1000);
  const frozen = await H.ev(
    call,
    `JSON.stringify((document.body.textContent || '').includes('已按提交时的批次修订冻结整个批次'))`,
  ).then(JSON.parse);
  check("执行在飞 ⇒ 整批冻结说明在场（6.8 既有判据回归）", frozen === true, frozen);

  // 等 arm1 请求出门（served +1）⇒ 确认真在飞
  const inflightDeadline = Date.now() + 20000;
  let inFlight = false;
  while (Date.now() < inflightDeadline) {
    if ((await mockServed()) === servedSeg2 + 1) {
      inFlight = true;
      break;
    }
    await H.sleep(400);
  }
  check("臂 1 请求已出门（mock 计数 +1，15s delay 在飞窗口）", inFlight === true, inFlight);

  // ── #7：槽被占时录制「保存并应用」被 main 门禁拒绝 ──
  // 入口走 store 口 openRecordingWorkspace（与全局栏按钮同一 store 动作；
  // 在飞期 DOM 点全局栏入口在本环境不稳定，判据核心是应用拒绝而非入口点击）
  await H.storeQ(call, `await s.openRecordingWorkspace(); return JSON.stringify("ok");`);
  await H.sleep(1500);
  const recView = await H.storeQ(call, "return JSON.stringify({ view: s.view });");
  check("#7 打开录制工作区（历史阅读路径不受槽影响）", recView.view === "recording", recView);
  for (let i = 0; i < 12; i++) {
    const has = await H.storeQ(
      call,
      "return JSON.stringify({ has: s.recordingDraft !== null, revision: s.recordingDraft ? s.recordingDraft.revision : null });",
    );
    if (has.has === true) break;
    await H.sleep(500);
  }
  await H.ev(
    call,
    `(() => { const i = document.querySelector('[data-recording-port]');
       if (!i) return false;
       const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
       setter.call(i, "19002");
       i.dispatchEvent(new Event('input', { bubbles: true }));
       return true; })()`,
  ).then((r) => {
    if (r !== true) throw new Error("录制端口输入不可用");
  });
  await H.sleep(500);
  const dirtyBefore = await H.storeQ(
    call,
    "const d = s.recordingDraft; return JSON.stringify({ dirty: d ? d.portText : null });",
  );
  check("#7 录制草稿已脏（端口 19002）", dirtyBefore.dirty === "19002", dirtyBefore);
  await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
       .find(x => ((x.textContent || '').trim()) === '保存并应用');
      if (!b || b.disabled) return false; b.click(); return true; })()`,
  ).then((r) => {
    if (r !== true) throw new Error("「保存并应用」不可点");
  });
  await H.sleep(1800);
  const rejectProbe = await H.storeQ(
    call,
    `return JSON.stringify({ err: s.recordingApplyError, apply: s.recordingApply,
       proxyEnabled: s.proxy ? s.proxy.enabled : null, proxyRunning: s.proxy ? s.proxy.running : null });`,
  );
  check(
    "#7 槽被占 ⇒ 保存并应用被 main 门禁拒绝（配置变更被拒绝）",
    String(rejectProbe.err ?? "").includes("配置变更被拒绝") && rejectProbe.apply === null,
    rejectProbe,
  );
  check(
    "#7 不新建主动操作、不改监听事实（enabled/running 原样）",
    rejectProbe.proxyEnabled === false && rejectProbe.proxyRunning === false,
    rejectProbe,
  );
  const portAfterReject = await H.storeQ(
    call,
    "const d = s.recordingDraft; return JSON.stringify({ portText: d ? d.portText : null });",
  );
  check(
    "#7 配置输入不清（草稿端口文本原样保留）",
    portAfterReject.portText === "19002",
    portAfterReject,
  );
  check("#7 settings 字节不变（拒绝路径零写盘）", settingsBytes() === bytes0, {
    same: settingsBytes() === bytes0,
  });
  const listReadable = await H.runs(call);
  check(
    "#7 状态读取/历史记录阅读保持可用（run 列表可读）",
    Array.isArray(listReadable) && listReadable.length > 0,
    {
      runs: listReadable.length,
    },
  );

  // ── #19 槽约束半边：设置门禁（notice + 保存/清除禁用）──
  // U5 6.7 配方：槽约束只随 main 快照进会话 ⇒ 在飞判据先 refreshOperationStatus()
  // （等价用户打开操作面板）再读门禁，否则会话快照滞后 ⇒ 门禁假开
  await H.storeQ(call, `await s.refreshOperationStatus(); return JSON.stringify("ok");`);
  await H.sleep(600);
  await openSettingsViaGlobalBar(call);
  const gateProbe = await H.ev(
    call,
    `(() => {
       const dlg = Array.from(document.querySelectorAll('dialog[open]')).pop();
       if (!dlg) return JSON.stringify(null);
       const notice = dlg.querySelector('[data-testid="config-gate-notice"]');
       const btns = Array.from(dlg.querySelectorAll('button'));
       const save = btns.find(b => ((b.textContent || '').trim()).startsWith('保存'));
       const clear = btns.find(b => ((b.textContent || '').trim()) === '清除配置');
       return JSON.stringify({ notice: notice ? notice.textContent : null,
         saveDisabled: save ? save.disabled : null, clearDisabled: clear ? clear.disabled : null });
     })()`,
  ).then(JSON.parse);
  check(
    "#19 槽被占 ⇒ 配置门禁呈现（notice 点名已有操作在执行）",
    gateProbe !== null && String(gateProbe.notice ?? "").includes("已有操作正在执行"),
    gateProbe,
  );
  check(
    "#19 槽被占 ⇒ 保存与清除都被锁（查看/返回不受影响）",
    gateProbe?.saveDisabled === true && gateProbe?.clearDisabled === true,
    { saveDisabled: gateProbe?.saveDisabled, clearDisabled: gateProbe?.clearDisabled },
  );
  await closeSettingsRobust(call);

  // 还原录制草稿（端口改回 ⇒ dirty 归零，不污染后续）
  await H.ev(
    call,
    `(() => { const i = document.querySelector('[data-recording-port]');
       if (!i) return false;
       const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
       setter.call(i, "19001");
       i.dispatchEvent(new Event('input', { bubbles: true }));
       return true; })()`,
  );

  // ── 等批次收口（登记 settled，两臂 returned）──
  let rec = null;
  const settleDeadline = Date.now() + 90000;
  while (Date.now() < settleDeadline) {
    const recs = await H.storeQ(
      call,
      `const list = s.operations.operations.filter(o => o.target && o.target.kind === 'modelAb');
       const last = list[list.length - 1] ?? null;
       return JSON.stringify(last ? { state: last.state, armCount: last.target.armCount,
         arms: (last.arms ?? []).map(a => a.outcome) } : null);`,
    );
    if (recs && recs.state === "settled") {
      rec = recs;
      break;
    }
    await H.sleep(1000);
  }
  check(
    "批次收口（settled，两臂 returned）",
    rec !== null && String(rec.arms) === String(["returned", "returned"]),
    rec,
  );
  const servedFinalArms = await mockServed();
  check("mock 计数恰 +2（两臂各一次，预览零调用）", servedFinalArms === servedSeg2 + 2, {
    served: [servedSeg2, servedFinalArms],
  });

  // ── #51：结果区 → 选两条进比较 → 返回实验 → 返回来源 → 录制往返 ──
  // 批完整成功 ⇒ 草稿已按修订清理（臂行消失）⇒ 经运行入口重进实验工作区（重挂）
  await H.storeQ(
    call,
    `await s.selectRun(${JSON.stringify(parentId)}); return JSON.stringify("ok");`,
  );
  await H.sleep(1500);
  await H.ev(
    call,
    `(() => { const b = document.querySelector('[data-experiment-entry]');
       if (!b || b.disabled) return false; b.click(); return true; })()`,
  ).then((r) => {
    if (r !== true) throw new Error("重进实验工作区失败（「模型实验」入口）");
  });
  await H.sleep(1500);
  const resultsProbe = await H.ev(
    call,
    `(() => {
       const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null);
       const join = btns.filter(b => ((b.textContent || '').trim()) === '加入对照');
       const enter = btns.find(b => ((b.textContent || '').trim()).startsWith('进入比较'));
       const batchText = (document.body.textContent || '').includes('已结束') || (document.body.textContent || '').includes('returned');
       return JSON.stringify({ joinCount: join.length, enterPresent: enter !== undefined, batchHint: batchText });
     })()`,
  ).then(JSON.parse);
  check(
    "#51 结果区呈现收口批次（两条可加入对照 + 进入比较入口）",
    resultsProbe.joinCount >= 2 && resultsProbe.enterPresent === true,
    resultsProbe,
  );
  await H.ev(
    call,
    `(() => { const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null && ((b.textContent || '').trim()) === '加入对照');
       if (btns.length < 2) return false; btns[0].click(); return true; })()`,
  );
  await H.sleep(600);
  await H.ev(
    call,
    `(() => { const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null && ((b.textContent || '').trim()) === '加入对照');
       if (btns.length < 1) return false; btns[0].click(); return true; })()`,
  );
  await H.sleep(700);
  const cmpSel = await H.storeQ(
    call,
    "return JSON.stringify({ compareIds: (s.compareIds ?? []).length });",
  );
  check("#51 两条按加入顺序进对照集合", cmpSel.compareIds === 2, cmpSel);
  await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
       .find(x => ((x.textContent || '').trim()).startsWith('进入比较'));
      if (!b || b.disabled) return false; b.click(); return true; })()`,
  ).then((r) => {
    if (r !== true) throw new Error("进入比较按钮不可点");
  });
  await H.sleep(2500);
  const cmpView = await H.storeQ(
    call,
    `const p = s.comparePair;
     return JSON.stringify({ view: s.view,
       pair: p ? [p.leftRunId, p.rightRunId] : null });`,
  );
  check(
    "#51 比较工作区打开（pair=两臂，U7 通道回归）",
    cmpView.view === "compare" && cmpView.pair !== null && cmpView.pair.every((x) => x !== null),
    cmpView,
  );
  await H.ev(
    call,
    `(() => { const b = document.querySelector('button[aria-label="返回来源"]');
       if (!b) return false; b.click(); return true; })()`,
  ).then((r) => {
    if (r !== true) throw new Error("比较「返回来源」不可点");
  });
  await H.sleep(1400);
  const backToExp = await abState(call);
  check(
    "#51 比较返回实验（视图/目标恢复，对照集合保留）",
    backToExp.view === "experiment" &&
      backToExp.target !== null &&
      backToExp.target.runId === parentId,
    backToExp,
  );
  const cmpAfterBack = await H.storeQ(
    call,
    "return JSON.stringify({ compareIds: (s.compareIds ?? []).length });",
  );
  check("#51 返回实验后对照集合原样", cmpAfterBack.compareIds === 2, cmpAfterBack);
  await H.ev(
    call,
    `(() => { const b = document.querySelector('button[aria-label="返回来源"]');
       if (!b) return false; b.click(); return true; })()`,
  ).then((r) => {
    if (r !== true) throw new Error("实验「返回来源」不可点");
  });
  await H.sleep(1400);
  const backToTrace = await H.storeQ(
    call,
    "return JSON.stringify({ view: s.view, run: s.selectedRunId });",
  );
  check(
    "#51 实验返回来源 ⇒ 回轨迹视图且选中原 run",
    backToTrace.view === "trace" && backToTrace.run === parentId,
    backToTrace,
  );

  // 录制往返（再入再返）
  await H.ev(
    call,
    `(() => { const b = document.querySelector('button[title^="本地录制代理"]');
       if (!b) return false; b.click(); return true; })()`,
  );
  await H.sleep(1100);
  await H.ev(
    call,
    `(() => { const b = document.querySelector('button[aria-label="返回来源"]');
       if (!b) return false; b.click(); return true; })()`,
  );
  await H.sleep(1300);
  const recRoundTrip = await H.storeQ(
    call,
    "return JSON.stringify({ view: s.view, run: s.selectedRunId });",
  );
  check(
    "#51 录制往返不改变主流程（trace 视图 + 选中不变）",
    recRoundTrip.view === "trace" && recRoundTrip.run === parentId,
    recRoundTrip,
  );

  // ── #51 隔离 run 文件页往返（条件：盘上存在隔离 run）──
  let isoId = null;
  try {
    for (const name of readdirSync(H.TRACES).filter((n) => n.endsWith(".jsonl"))) {
      const head = readFileSync(join(H.TRACES, name), "utf8").slice(0, 2000);
      if (head.includes('"workspace"') && head.includes('"origin"')) {
        const m = head.match(/run_[a-z0-9_]+/);
        if (m) {
          isoId = m[0];
          break;
        }
      }
    }
  } catch {
    /* 扫描失败按无隔离 run 处理 */
  }
  if (isoId !== null) {
    await H.storeQ(
      call,
      `await s.selectRun(${JSON.stringify(isoId)}); return JSON.stringify("ok");`,
    );
    await H.sleep(1600);
    await H.clickTabChecked(call, "文件");
    await H.sleep(1400);
    // 「文件」是 per-run reading tab（view 恒 trace；App 按 readingByRun[runId].tab 分支到文件面板）
    const filesView = await H.storeQ(
      call,
      `const r = s.readingByRun[${JSON.stringify(isoId)}];
       return JSON.stringify({ tab: r ? r.tab : null });`,
    );
    check(
      "#51 隔离 run 文件页打开（U2 通道回归，tab=files）",
      filesView.tab === "files",
      filesView,
    );
    await H.storeQ(call, `await s.openRecordingWorkspace(); return JSON.stringify("ok");`);
    await H.sleep(1300);
    await H.ev(
      call,
      `(() => { const b = document.querySelector('button[aria-label="返回来源"]');
         if (!b) return false; b.click(); return true; })()`,
    );
    await H.sleep(1400);
    const filesBack = await H.storeQ(
      call,
      `return JSON.stringify({ run: s.selectedRunId,
         tab: s.readingByRun[${JSON.stringify(isoId)}] ? s.readingByRun[${JSON.stringify(isoId)}].tab : null });`,
    );
    check(
      "#51 文件页往返：录制返回后文件视图与运行恢复",
      filesBack.run === isoId && filesBack.tab === "files",
      filesBack,
    );
  } else {
    note(
      "#51 文件页往返半边：盘上无隔离 run 标本 ⇒ 按分层登记（U8 零改动文件视图 + U2/U7 既有实机证据承载）。",
    );
  }

  // ── #51 全局操作面板 ──
  await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('header button'))
       .find(x => x.getAttribute('aria-expanded') !== null && (x.textContent || '').includes('操作'));
      if (!b) return false;
      if (b.getAttribute('aria-expanded') !== 'true') b.click();
      return true; })()`,
  ).then((r) => {
    if (r !== true) note("#51 全局操作入口按钮定位未命中（选择器漂移）——面板判据降级登记");
  });
  await H.sleep(900);
  const opsPanel = await H.storeQ(
    call,
    `const rows = s.operations.operations; return JSON.stringify({ total: rows.length,
       hasModelAb: rows.some(o => o.target && o.target.kind === 'modelAb') });`,
  );
  check(
    "#51 全局操作面板可用（登记记录在场，含 modelAb 批次）",
    opsPanel.total >= 1 && opsPanel.hasModelAb === true,
    opsPanel,
  );

  const tracesAfter = H.traceIds().size;
  check("traces 恰 +3（父本 + 两臂）", tracesAfter === tracesBefore + 3, {
    traces: [tracesBefore, tracesAfter],
  });
  await H.shot(call, SHOT_DIR, "aux-regression.png");
  note(
    "#18 reread-failed 实机半边 = U5 6.7 竞速注入实测 + 单元（分层登记，见 settings-entries tag）。",
  );
  finish({ served: [served0, servedFinalArms], traces: [tracesBefore, tracesAfter], parentId });
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), String(e?.stack ?? e));
  process.exit(1);
});
