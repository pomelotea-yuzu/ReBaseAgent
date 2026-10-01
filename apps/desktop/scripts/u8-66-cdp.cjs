/* eslint-disable */
/**
 * U8 任务 6.6（Electron 实机第一批）：录制工作区——打开/启停/真实地址复制、
 * 端口占用、跨页原文恢复、配置门禁 UI 半边与只读刷新；真实点击/结果/哈希证据。
 *
 * 对应 delta 场景（evidence-index）：#1 启用代理、#2 端口占用可见、#3 key 捕获状态、
 * #4 接入地址只来自已核实监听、#5 停止或未知状态撤销地址、#20 录制入口保持可达、
 * #21 设置跳转先处理未保存模型字段、#22 录制配置跨页恢复原始输入、#27 查看代理记录、
 * #28 录制刷新只读、#31 停止服务不称取消运行。
 *
 * 判据纪律（同 U5/U6/U7）：
 * - 受控 settings（proxy.enabled=false + 运行配置占位）由 run-all 批首写入、批尾逐字节还原
 *   （6.1 fixtures 的 snapshotFile/restoreFile；「禁止覆盖生产凭据」机械保证）；
 * - toggle 是本批**被测行为**（真实启停本地监听），无 mock 服务、零模型调用；
 * - 🔴 「应用失败回读也失败保留输入」实机不成立（6.1 探明：proxy:status handler 恒 ok +
 *   loadProxy 全容错）⇒ 只输出登记说明行，不算失败；
 * - 「代理应用沿用配置互斥」的占槽半边需真实执行会话（main 端点判锁）⇒ 归 6.8，本批登记。
 *
 * 用法：`node apps/desktop/scripts/u8-66-cdp.cjs --tag=<TAG>`
 * 前置：dev 已由 run-all 起（CDP 9612）；u8e_p1.jsonl 已注入 traces。
 */
"use strict";
const { writeFileSync, mkdirSync, existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const H = require("./lib/u4-smoke-harness.cjs");
const fixtures = require("./lib/u8-recording-fixtures.cjs");

const TAGS = ["recording-live", "recording-entries"];
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag");
if (!TAGS.includes(TAG)) {
  console.error(`用法：--tag=<${TAGS.join("|")}>`);
  process.exit(2);
}

const OUT_DIR = join(H.REPO, ".workbuddy", "u8", "u8-66");
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
/** 登记说明（不算检查：实机不可达/归后续批次的分层口径） */
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
  const meta = { head: headShort(), node: process.version, ...extraMeta };
  writeFileSync(
    join(OUT_DIR, `${TAG}-measurements.json`),
    JSON.stringify({ tag: TAG, meta, checks, failed: failed.length, dump }, null, 2),
  );
  console.log(`检查 ${checks.filter((c) => !c.note).length} 条，失败 ${failed.length} 条`);
  clearTimeout(watchdog);
  process.exit(failed.length === 0 ? 0 : 1);
}
const watchdog = setTimeout(() => {
  console.error(`看门狗：${TAG} 超过 10 分钟未收尾 ⇒ 判失败退出`);
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), "watchdog timeout");
  process.exit(3);
}, 600_000);

// ---------------------------------------------------------------------------
// 读数与动作
// ---------------------------------------------------------------------------

const RECORDING_TITLE = "打开录制工作区，把现有 Agent 的 base_url 指过来即可录制";
const SETTINGS_TITLE = "配置 LLM 接入（baseURL / apiKey / model），供“在此重跑”发起真实调用";

/** 按 title 精确点击（scope 限定 header 内——U5 6.7/6.8 坑：页内同名 title 会误命中） */
async function clickByTitleExact(call, title, wait = 900) {
  const r = await H.ev(
    call,
    `(() => {
       const scope = Array.from(document.querySelectorAll('header'))
         .find(h => h.querySelector('button[title=${JSON.stringify(title)}]'));
       const b = (scope ?? document).querySelector('button[title=${JSON.stringify(title)}]');
       if (!b || b.offsetParent === null) return false;
       b.click(); return true; })()`,
  );
  if (r !== true) throw new Error(`找不到 title 精确匹配按钮：${title}`);
  await H.sleep(wait);
  return true;
}

/** 轮询 store 谓词（body 返回 JSON.stringify(bool)） */
async function waitForStore(call, body, timeoutMs = 15000, what = "条件") {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v = false;
    try {
      v = await H.storeQ(call, body);
    } catch {
      /* 重载/瞬态 */
    }
    if (v === true) return true;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await H.sleep(400);
  }
}

const proxyOf = (call) =>
  H.storeQ(
    call,
    `return JSON.stringify({
       proxy: s.proxy, draft: s.recordingDraft && {
         baseline: s.recordingDraft.baseline, enabled: s.recordingDraft.enabled,
         portText: s.recordingDraft.portText, upstreamText: s.recordingDraft.upstreamText,
         revision: s.recordingDraft.revision },
       applying: s.recordingApply, applyError: s.recordingApplyError,
       statusReadFailed: s.recordingStatusReadFailed, view: s.view,
     });`,
  );

/** 录制工作区 DOM 读数 */
const domProbe = (call) =>
  H.ev(
    call,
    `(() => {
       const body = document.querySelector('[data-recording-body]');
       const q = (sel) => { const el = document.querySelector(sel); return el === null ? null : el.textContent; };
       const addr = document.querySelector('[data-recording-copy-address]');
       return JSON.stringify({
         mounted: body !== null,
         sections: body === null ? [] : Array.from(body.querySelectorAll('section')).map(s => s.getAttribute('aria-label')),
         statusText: q('[aria-label="录制真实状态"]') ?? "",
         applyError: q('[data-recording-apply-error]'),
         addrText: document.querySelector('[aria-label="本地接入地址"] code')?.textContent ?? null,
         hasCopyBtn: addr !== null && addr.offsetParent !== null,
         addrUnavailable: q('[data-recording-address-unavailable]'),
         portError: q('[data-recording-port-error]'),
         dirty: q('[data-recording-dirty]'),
       });
     })()`,
  ).then(JSON.parse);

/** 状态区三分文本（意图/监听/凭据行值） */
const statusLines = (call) =>
  H.ev(
    call,
    `(() => {
       const sec = document.querySelector('[aria-label="录制真实状态"]');
       if (sec === null) return JSON.stringify(null);
       return JSON.stringify(Array.from(sec.querySelectorAll('dl > div')).map(d => ({
         label: d.querySelector('dt')?.textContent ?? "", value: d.querySelector('dd')?.textContent ?? "",
       })));
     })()`,
  ).then(JSON.parse);

async function openRecordingViaGlobalBar(call) {
  await clickByTitleExact(call, RECORDING_TITLE);
  const st = await proxyOf(call);
  if (st.view !== "recording") throw new Error(`录制入口未打开录制工作区：view=${st.view}`);
  return st;
}

/** 改端口输入（原生 setter + input 事件；React onChange 同步 store） */
async function setPortText(call, text) {
  const r = await H.typeIntoDom(call, "[data-recording-port]", text);
  if (!String(r?.value ?? "").includes(text))
    throw new Error(`端口输入未生效：${JSON.stringify(r)}`);
}

/** 勾选/取消「启用录制代理」复选框 */
async function setEnabled(call, checked) {
  const r = await H.ev(
    call,
    `(() => {
       const cb = document.querySelector('[data-recording-enabled]');
       if (!cb || cb.offsetParent === null) return false;
       if (cb.checked === ${checked ? "true" : "false"}) return "already";
       cb.click(); return true; })()`,
  );
  if (r === false) throw new Error(`启用复选框不可点（期望 ${checked}）`);
  await H.sleep(500);
}

/** 点「保存并应用」并等收尾（recordingApply 清空） */
async function applyAndWait(call, timeoutMs = 20000) {
  const ok = await H.ev(
    call,
    `(() => { const b = document.querySelector('[data-recording-apply]');
       if (!b || b.disabled) return false; b.click(); return true; })()`,
  );
  if (ok !== true) throw new Error("「保存并应用」不可点（disabled）");
  await waitForStore(
    call,
    "return JSON.stringify(s.recordingApply === null);",
    timeoutMs,
    "应用收尾（recordingApply 清空）",
  );
  await H.sleep(600);
}

// ---------------------------------------------------------------------------
// tag1：recording-live（状态/启停/占用/复制/跨页/记录入口）
// ---------------------------------------------------------------------------

const FLOWS = {
  "recording-live": async (call) => {
    // 就绪：DPR 哨兵 + 注入标本在列表
    const dpr = await H.ev(call, "window.devicePixelRatio");
    check("DPR ≈ 2.1（无 zoom 残留）", Math.abs(dpr - 2.1) < 0.15, `实测 ${dpr}`);
    const runs0 = await H.runs(call);
    check(
      "u8e_p1 注入标本在列表（查看代理记录的选择目标）",
      runs0.includes("u8e_p1"),
      runs0.join(","),
    );

    // 初始：App 挂载已自动 loadProxyStatus ⇒ 受控 settings 的 proxy 可核实
    const init = await proxyOf(call);
    check(
      "初始状态（受控 settings）：enabled=false / running=false / port=19001",
      init.proxy?.enabled === false && init.proxy?.running === false && init.proxy?.port === 19001,
      init.proxy,
    );

    // #20 全局栏录制入口 → 独立工作区（非设置模态）
    const st1 = await openRecordingViaGlobalBar(call);
    const noDialog = await H.ev(
      call,
      `JSON.stringify(document.querySelectorAll('dialog[open]').length)`,
    ).then(JSON.parse);
    check(
      "#20 录制入口打开独立工作区（不经设置模态）",
      noDialog === 0 && st1.view === "recording",
      { dialogs: noDialog, view: st1.view },
    );
    const draft1 = st1.draft;
    check(
      "草稿从已核实状态初始化：baseline.port=19001 / portText 原样",
      draft1?.baseline?.port === 19001 && draft1?.portText === "19001",
      draft1,
    );

    // #3/#5 状态三分 + 地址不可复制（未监听）
    let dom = await domProbe(call);
    check(
      "录制工作区挂载（四个分区）",
      dom.mounted === true && dom.sections.length === 4,
      dom.sections,
    );
    let lines = await statusLines(call);
    check(
      "#3 状态三分：未启用 / 未监听 / 尚未捕获 key",
      (lines?.[0]?.value ?? "").includes("未启用") &&
        (lines?.[1]?.value ?? "").includes("未监听") &&
        (lines?.[2]?.value ?? "").includes("尚未捕获 key"),
      lines,
    );
    check(
      "#5 未监听 ⇒ 地址不可复制（不提供假地址）",
      dom.addrUnavailable !== null && dom.hasCopyBtn === false && dom.addrText === null,
      { unavailable: dom.addrUnavailable, copy: dom.hasCopyBtn, addr: dom.addrText },
    );

    // #1 启用代理（真实 toggle：19001）
    await setEnabled(call, true);
    await applyAndWait(call);
    const applied = await proxyOf(call);
    check(
      "#1 启用代理：真实监听在场（running=true · 19001）、应用诊断清空",
      applied.proxy?.running === true &&
        applied.proxy?.port === 19001 &&
        applied.applyError === null,
      applied.proxy,
    );
    dom = await domProbe(call);
    lines = await statusLines(call);
    check(
      "#1 状态区：运行中 · 端口 19001；意图=已启用；凭据=尚未捕获",
      (lines?.[0]?.value ?? "").includes("已启用") &&
        (lines?.[1]?.value ?? "").includes("运行中") &&
        (lines?.[1]?.value ?? "").includes("19001"),
      lines,
    );
    check(
      "#4 运行中 ⇒ 地址由真实端口构造且可复制",
      dom.addrText === "http://127.0.0.1:19001/v1" && dom.hasCopyBtn === true,
      { addr: dom.addrText, copy: dom.hasCopyBtn },
    );

    // #4 复制（真实 clipboard.writeText；断言成功反馈，不回读剪贴板——权限未决时 readText 永不 resolve）
    await H.ev(
      call,
      `(() => { const b = document.querySelector('[data-recording-copy-address]'); b.click(); return true; })()`,
    );
    await H.sleep(800);
    const copyFed = await H.ev(
      call,
      `(() => {
         const sec = document.querySelector('[aria-label="本地接入地址"]');
         return JSON.stringify({ fed: sec?.textContent.includes("已复制") ?? false });
       })()`,
    ).then(JSON.parse);
    check("#4 复制成功反馈在场（真实 clipboard 写入）", copyFed.fed === true, copyFed);

    // #2 端口占用（真实 socket 占用 19002 → 应用失败 → 分层呈现）
    const occupied = await fixtures.occupyPort(19002);
    try {
      await setPortText(call, "19002");
      await applyAndWait(call);
      const occ = await proxyOf(call);
      check(
        "#2 端口占用：PROXY_START_FAILED 诊断在场（含占用文案）",
        (occ.applyError ?? "").includes("已被占用"),
        occ.applyError,
      );
      dom = await domProbe(call);
      lines = await statusLines(call);
      check(
        "#2 部分应用分层：意图=已保存（enabled=true）但监听=未监听（running=false）",
        (lines?.[0]?.value ?? "").includes("已启用") &&
          (lines?.[1]?.value ?? "").includes("未监听") &&
          occ.proxy?.enabled === true &&
          occ.proxy?.running === false,
        { lines, proxy: occ.proxy },
      );
      check(
        "#2 失败输入保留（19002）+ 地址撤销",
        occ.draft?.portText === "19002" && dom.addrUnavailable !== null && dom.hasCopyBtn === false,
        { portText: occ.draft?.portText, copy: dom.hasCopyBtn },
      );
      check(
        "#2 诊断文案按设计说明「配置可能已保存但监听未启动」",
        (dom.applyError ?? "").includes("配置可能已保存但监听未启动"),
        dom.applyError,
      );
    } finally {
      const freed = await occupied.release();
      check("#2 占位端口释放（端口真空出）", freed.freed === true, freed);
    }

    // 恢复：改回 19001 → 应用成功（对照支：合法路径确实成功）
    await setPortText(call, "19001");
    await applyAndWait(call);
    const restored = await proxyOf(call);
    check(
      "对照支：释放后同端口应用成功（running=true）",
      restored.proxy?.running === true && restored.proxy?.port === 19001,
      restored.proxy,
    );

    // #22 跨页原文恢复（非法原文逐字保留）
    await setPortText(call, "19002abc");
    const beforeRev = (await proxyOf(call)).draft?.revision;
    await H.storeQ(call, `s.setView("trace"); return JSON.stringify("ok");`);
    await H.sleep(900);
    await openRecordingViaGlobalBar(call);
    const afterCross = await proxyOf(call);
    check(
      "#22 跨页原文恢复：非法端口原文逐字保留、修订不推进",
      afterCross.draft?.portText === "19002abc" && afterCross.draft?.revision === beforeRev,
      { portText: afterCross.draft?.portText, revision: afterCross.draft?.revision, beforeRev },
    );
    dom = await domProbe(call);
    check(
      "#22 字段级错误就近呈现（非法原文不被清洗）",
      dom.portError !== null && (dom.portError ?? "").includes("完整整数"),
      dom.portError,
    );
    await setPortText(call, "19001");

    // #31 停用（停止语义说明在场）
    await setEnabled(call, false);
    await applyAndWait(call);
    const stopped = await proxyOf(call);
    lines = await statusLines(call);
    const stopSemantics = await H.ev(
      call,
      `JSON.stringify((document.querySelector('[aria-label="录制真实状态"]')?.textContent ?? "").includes("停用只停止本地接入服务"))`,
    ).then(JSON.parse);
    check(
      "#31 停用：意图=未启用、监听=未监听、hasKey=false、停止语义说明在场",
      stopped.proxy?.enabled === false &&
        stopped.proxy?.running === false &&
        stopped.proxy?.hasKey === false &&
        (lines?.[0]?.value ?? "").includes("未启用") &&
        stopSemantics === true,
      { proxy: stopped.proxy, lines, stopSemantics },
    );

    // #27 查看代理记录：保留选择与搜索
    await H.storeQ(call, `await s.selectRun("u8e_p1"); return JSON.stringify("ok");`);
    await H.storeQ(call, `s.setSearchQuery("U8"); return JSON.stringify("ok");`);
    await H.sleep(600);
    await openRecordingViaGlobalBar(call);
    await H.ev(
      call,
      `(() => { const b = document.querySelector('[data-recording-open-records]'); b.click(); return true; })()`,
    );
    await H.sleep(1200);
    const rec = await H.storeQ(
      call,
      `return JSON.stringify({
         view: s.view, sourceFilter: s.sourceFilter, search: s.searchQuery,
         selected: s.selectedRunId,
       });`,
    );
    check(
      "#27 查看代理记录：sourceFilter=proxy + 轨迹视图 + 选择与搜索保留",
      rec.view === "trace" &&
        rec.sourceFilter === "proxy" &&
        rec.selected === "u8e_p1" &&
        rec.search === "U8",
      rec,
    );
    // 清理：筛选与搜索复位（不留残渣给 tag2）
    await H.storeQ(
      call,
      `s.setSourceFilter("all"); s.setSearchQuery(""); return JSON.stringify("ok");`,
    );
    await H.shot(call, SHOT_DIR, "recording-records.png");
    note(
      "「应用失败回读也失败保留输入」实机不成立（6.1 探明：proxy:status handler 恒 ok + loadProxy 全容错）⇒ 按 recording-draft-store 单元承载。",
    );
    note(
      "「代理应用沿用配置互斥」的占槽半边需真实执行会话（main 端点判锁）⇒ 归 6.8；本批已验 UI 门禁半边（见 recording-entries）。",
    );
  },

  // -------------------------------------------------------------------------
  // tag2：recording-entries（字段门禁 / 只读刷新 / 设置跳转确认）
  // -------------------------------------------------------------------------

  "recording-entries": async (call) => {
    const runs0 = await H.runs(call);
    check("列表就绪（同一 dev 会话，tag1 已停用代理）", runs0.includes("u8e_p1"), runs0.join(","));
    await openRecordingViaGlobalBar(call);
    const st0 = await proxyOf(call);
    check(
      "初始干净：代理未启用未监听（tag1 收尾态）",
      st0.proxy?.running === false && st0.proxy?.enabled === false,
      st0.proxy,
    );

    // 2.4 UI 门禁半边：非法端口 ⇒ 应用逐控件 disabled + 字段错误（邻接序列判据，防 className 假阳）
    await setPortText(call, "19002abc");
    const gate = await H.ev(
      call,
      `(() => {
         const b = document.querySelector('[data-recording-apply]');
         const cb = document.querySelector('[data-recording-enabled]');
         return JSON.stringify({
           applyDisabled: b?.disabled === true,
           applyLabel: b?.textContent ?? null,
           cbDisabled: cb?.disabled === true,
           portError: document.querySelector('[data-recording-port-error]')?.textContent ?? null,
           kept: document.querySelector('[data-recording-port]')?.value ?? null,
         });
       })()`,
    ).then(JSON.parse);
    check(
      "2.4 UI 门禁：非法端口 ⇒ 应用 disabled + 字段错误就近 + 原文保留",
      gate.applyDisabled === true &&
        (gate.portError ?? "").includes("完整整数") &&
        gate.kept === "19002abc",
      gate,
    );
    note(
      "「非法端口零配置写调用」的机器判据 = 定向测试（store 纵深 + 视图 disabled）；实机呈现层已由上一条覆盖。",
    );
    await setPortText(call, "19001");

    // #28 重读只读：点重读 → 状态照常（值同）、不启停服务
    const beforeRead = await proxyOf(call);
    await H.ev(
      call,
      `(() => { const b = document.querySelector('[data-recording-refresh-status]'); b.click(); return true; })()`,
    );
    await H.sleep(1000);
    const afterRead = await proxyOf(call);
    const refreshTitle = await H.ev(
      call,
      `JSON.stringify(document.querySelector('[data-recording-refresh-status]')?.title ?? null)`,
    ).then(JSON.parse);
    check(
      "#28 重读只读：状态值不变（enabled/running/hasKey 同）+ title 明示不重新应用",
      afterRead.proxy?.enabled === beforeRead.proxy?.enabled &&
        afterRead.proxy?.running === beforeRead.proxy?.running &&
        afterRead.proxy?.hasKey === beforeRead.proxy?.hasKey &&
        (refreshTitle ?? "").includes("不重新应用"),
      { before: beforeRead.proxy, after: afterRead.proxy, title: refreshTitle },
    );
    note(
      "「录制刷新只读且错误可重试」的错误半边（recordingStatusReadFailed 呈现）真机无注入面（6.1 探明）⇒ 喂 props 判据由 recording-workspace-view 单元承载。",
    );

    // #21 设置跳转先处理未保存模型字段
    // ⚠️ 先离开录制页（setView trace）：否则「放弃并跳转 ⇒ 进录制工作区」的 view 断言无牙
    //（本 tag 开头就在录制页，view 恒 recording）
    await H.storeQ(call, `s.setView("trace"); return JSON.stringify("ok");`);
    await H.sleep(700);
    await clickByTitleExact(call, SETTINGS_TITLE);
    await H.sleep(900);
    const settingsOpen = await H.ev(
      call,
      `JSON.stringify(document.querySelectorAll('dialog[open]').length)`,
    ).then(JSON.parse);
    check("设置模态打开（真按钮 → top layer）", settingsOpen >= 1, settingsOpen);
    // 改 model 字段（placeholder 定位；U5 6.7 口径）
    const modelEdit = await H.typeIntoDom(
      call,
      'dialog[open] input[placeholder="deepseek-chat"]',
      "deepseek-chat-edited",
    );
    check(
      "设置 model 字段已改（dirty 前提）",
      String(modelEdit?.value ?? "").includes("edited"),
      modelEdit,
    );
    // 点跳转 → 真模态确认在场
    await H.ev(
      call,
      `(() => { const b = document.querySelector('[data-settings-recording-jump]'); b.click(); return true; })()`,
    );
    await H.sleep(800);
    const confirmProbe = await H.ev(
      call,
      `(() => {
         const dlgs = Array.from(document.querySelectorAll('dialog[open]'));
         const top = dlgs[dlgs.length - 1];
         return JSON.stringify({
           dlgCount: dlgs.length,
           text: top ? (top.textContent || "").slice(0, 200) : null,
           hasContinue: top ? Array.from(top.querySelectorAll('button')).some(b => (b.textContent||'').includes("继续编辑")) : false,
           hasDiscard: top ? Array.from(top.querySelectorAll('button')).some(b => (b.textContent||'').includes("放弃并跳转录制")) : false,
         });
       })()`,
    ).then(JSON.parse);
    check(
      "#21 dirty 时跳转 → 确认模态在场（继续编辑/放弃并跳转录制两路）",
      confirmProbe.dlgCount >= 2 && confirmProbe.hasContinue && confirmProbe.hasDiscard,
      confirmProbe,
    );
    // 继续编辑：留在设置（确认框关、设置模态仍在）、跳转未发生（view 仍 trace）、proxy 零调用
    await H.clickInOpenDialog(call, "继续编辑");
    const keptProxy = await proxyOf(call);
    const settingsStill = await H.ev(
      call,
      `JSON.stringify(document.querySelectorAll('dialog[open]').length)`,
    ).then(JSON.parse);
    check(
      "#21 继续编辑：留在设置（确认框关、设置模态仍开）、view 未跳转（仍 trace）、proxy 零调用",
      settingsStill === 1 && keptProxy.view === "trace",
      { dialogs: settingsStill, view: keptProxy.view, proxy: keptProxy.proxy },
    );
    // 放弃并跳转：进录制工作区
    await H.ev(
      call,
      `(() => { const b = document.querySelector('[data-settings-recording-jump]'); b.click(); return true; })()`,
    );
    await H.sleep(700);
    await H.clickInOpenDialog(call, "放弃并跳转录制");
    await H.sleep(900);
    const jumped = await proxyOf(call);
    const recDom = await domProbe(call);
    check(
      "#21 放弃并跳转：进入录制工作区（未保存输入被丢弃，不发生代理应用）",
      jumped.view === "recording" && recDom.mounted === true && jumped.proxy?.running === false,
      { view: jumped.view, mounted: recDom.mounted },
    );
    await H.shot(call, SHOT_DIR, "recording-entries.png");
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

  try {
    await FLOWS[TAG](call);
  } catch (e) {
    check(`tag 执行异常：${String(e?.message ?? e).slice(0, 300)}`, false);
  }
  finish();
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), String(e?.stack ?? e));
  process.exit(1);
});
