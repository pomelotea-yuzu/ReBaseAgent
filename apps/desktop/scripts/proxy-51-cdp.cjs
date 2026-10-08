/* eslint-disable */
/**
 * `fix-proxy-recording-reliability` 任务 5.1：代理链路的 **Electron 实机验收**。
 *
 * ## 场景（对齐 evidence-index 里标 ⏳ 的实机缺口）
 *
 * - **S1 空闲 main 的被动录制自动可见**：外部应用经代理发一次请求 ⇒ 无需任何手动刷新，
 *   列表自动出现新 run id；当前选择/详情/筛选/搜索词原样；**零主动登记**（operations 无新增）。
 * - **S2 凭据捕获与更换可观测**：外部请求捕获 Authorization ⇒ `hasKey` 由通知路径自动翻真
 *   （不手动 `loadProxyStatus`）；换一把 key 再捕获 ⇒ `hasKey` 仍为 true 而
 *   `keyCaptureRevision` 推进。
 * - **S3 打开重发即核对当前状态**：停用代理（running=false / hasKey=true）后打开 messages
 *   工作区 ⇒ 门禁按**当前**事实说「代理未运行」，而不是沿用打开前的旧事实，也不是谎报
 *   「未捕获 key」；重新启用 ⇒ 已打开的编辑器就地恢复可确认。打开全程零 `proxy:fork`。
 * - **S4 捕获通知更新已打开编辑器 / 凭据轮换撤销旧确认**：编辑器已打开且已 arm 确认 ⇒
 *   外部换 key 捕获 ⇒ **就地**撤销旧确认；草稿逐字不变、模型计数不因通知增加。
 * - **S5 重发编辑（成功）**：编辑 messages → 核对 → 重发 ⇒ 真实上游**一次**，子 run
 *   parent/at_span/edit/messages 逐字正确，结果区只呈现登记的可信 id。
 * - **S6 失败重发（503）**：子 run 落**自有** `llm.call` + `error.status=503` + `stopped/error`；
 *   概览「本次失败原因」给出真实状态码 + 摘要 + 定位入口；点进去的调用详情把
 *   usage/ttft 标成**占位说明**（不出现 `0ms`、不出现「输入 tokens 0」）；父本逐字不变。
 * - **S7 网络失败不展示伪造状态码**：upstream 指向无人监听的端口 ⇒ `error` **不写** status，
 *   概览显示「未记录 HTTP 状态」而不是本地 502。
 * - **S8 旧代理失败仍提示详情未记录**：注入 meta+stopped/error 的旧形态 fixture（无
 *   `llm.call`）⇒ 概览给「未记录」诚实缺失提示且**不给**定位入口；fixture 字节不变。
 *
 * ## 证据纪律（三条硬约束）
 *
 * ① **CDP 走 `node:http`**（`listPageTarget`）：本机 `HTTP_PROXY` 会劫持 `fetch`。
 * ② **注入面边界**：`proxy:status` 的错误信封在真机**无注入面**（handler 是纯读函数），
 *    「应用失败且回读也失败」半边由单元承载，本脚本只验可注入的分层路径。
 * ③ **失败注入只用真实上游剧本**（`mock-llm` 的 `mode:"fail"`），不做页内 hook。
 *
 * ## 三个重启段（各自需要真的重启 main ⇒ 独立 tag，由 run-all 编排）
 *
 * - `restart-success`：保存 enabled=true 后重启 ⇒ autoStart 恢复监听、`hasKey=false`、
 *   历史仍可读、接入地址可复制。
 * - `restart-failure`：占端口 + 保存 enabled=true ⇒ 重启恢复失败（**已启用未监听** +
 *   受控原因 + 就近处置区）；只读重读**不**启动监听；释放端口后点「保存并应用」重试成功。
 * - `restart-off`：保存停用后重启 ⇒ 不尝试监听、零上游调用、历史可读。
 *
 * 用法：`node apps/desktop/scripts/proxy-51-cdp.cjs --tag=<chain|restart-success|restart-failure|restart-off>`
 * 前置：dev 已由 run-all 起（CDP 9612）；mock-llm 18799 已起（剧本由本探针分段切换）。
 */
"use strict";

const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const http = require("node:http");
const H = require("./lib/u4-smoke-harness.cjs");
const { listPageTarget } = require("./editor-collapse-probe.cjs");

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag", "chain");
const PROXY_PORT = Number(arg("proxy-port", "19051"));
const UPSTREAM = H.MOCK_UPSTREAM; // http://127.0.0.1:18799（不带 /v1，handler 自拼路径）
const DEAD_UPSTREAM = "http://127.0.0.1:1";

const ROOT = join(H.REPO, ".workbuddy", "proxy-51");
const SHOTS = join(ROOT, "shots");
const RELEASE_FLAG = join(ROOT, "release-port.request");
const RELEASED_FLAG = join(ROOT, "release-port.done");
mkdirSync(SHOTS, { recursive: true });

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
// mock 控制端点（node:http 直连；fetch 会被本机 HTTP_PROXY 劫持）
// ---------------------------------------------------------------------------

function mockPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = http.request(
      `http://127.0.0.1:${H.MOCK_PORT}${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (d) => {
          data += d;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`mock ${path} 非法 JSON：${data.slice(0, 120)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(4000, () => {
      req.destroy();
      reject(new Error(`mock ${path} 超时`));
    });
    req.write(payload);
    req.end();
  });
}
const mockReset = (script) => mockPost("/__reset", { script });
function mockServed() {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${H.MOCK_PORT}/__log`, (res) => {
        let body = "";
        res.on("data", (d) => {
          body += d;
        });
        res.on("end", () => resolve(JSON.parse(body).served));
      })
      .on("error", reject);
  });
}

/** 外部受控应用请求：真实过代理（真实转发 + 真实落盘 + 真实 key 捕获） */
function externalRequest(messages, { stream = false, key = "Bearer sk-proxy-51-a" } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: "deepseek-chat", messages, stream });
    const req = http.request(
      `http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: key,
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (d) => {
          data += d;
        });
        res.on("end", () => resolve({ status: res.statusCode, bytes: data.length }));
      },
    );
    req.on("error", reject);
    req.setTimeout(20000, () => {
      req.destroy();
      reject(new Error("外部请求 20s 超时"));
    });
    req.write(body);
    req.end();
  });
}

/** 端口是否真有人监听（`node:net` 直连；fetch 会被 HTTP_PROXY 穿透，判不出死活） */
function portAlive(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/__probe__", method: "GET", timeout: 600 },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 落盘 / 列表
// ---------------------------------------------------------------------------

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

async function waitNewRuns(beforeSet, expect, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const fresh = [...H.traceIds()].filter((id) => !beforeSet.has(id));
    if (fresh.length >= expect) return fresh;
    if (Date.now() > deadline) return fresh;
    await H.sleep(400);
  }
}

/**
 * 等 store 的 `runs` 出现某 id —— **不调 `loadRuns`**。
 * 这是 S1 的核心判据：列表自动可见必须由通知路径驱动，手动刷新会把它变成假门。
 */
async function waitListHas(call, runId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await H.storeQ(call, "return JSON.stringify(s.runs.map((r) => r.id));");
    if (Array.isArray(last) && last.includes(runId)) return { ok: true, ids: last };
    if (Date.now() > deadline) return { ok: false, ids: last };
    await H.sleep(300);
  }
}

/** 等代理状态某字段达到期望（自动路径 ⇒ 不主动读状态） */
async function waitProxyFact(call, expr, want, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await H.storeQ(call, `return JSON.stringify(${expr});`);
    if (last === want) return { ok: true, value: last };
    if (Date.now() > deadline) return { ok: false, value: last };
    await H.sleep(250);
  }
}

// ---------------------------------------------------------------------------
// 页内读数
// ---------------------------------------------------------------------------

const proxyState = (call) =>
  H.storeQ(
    call,
    `return JSON.stringify({
       proxy: s.proxy,
       cursor: s.proxyFactCursor,
       inFlight: s.proxyStatusRead.inFlight,
       readFailed: s.recordingStatusReadFailed,
     });`,
  );

const listSnapshot = (call) =>
  H.storeQ(
    call,
    `return JSON.stringify({
       ids: s.runs.map((r) => r.id),
       selectedRunId: s.selectedRunId,
       detailId: s.detail && s.detail.meta ? s.detail.meta.id : null,
       search: s.searchQuery,
       filter: s.sourceFilter,
       proxyOps: s.operations.operations.filter((o) => o.target && o.target.kind === 'proxy')
         .map((o) => [o.operationId, o.state]),
       abOps: s.operations.operations.filter((o) => o.target && o.target.kind === 'modelAb')
         .map((o) => [o.operationId, o.state]),
     });`,
  );

const draftText = (call, runId, spanId) =>
  H.storeQ(
    call,
    `const e = s.callDraftOf({ runId: ${JSON.stringify(runId)}, spanId: ${JSON.stringify(
      spanId,
    )}, field: "messages" });
     return JSON.stringify(e === undefined ? null : e.text);`,
  );

/** messages 门禁的可见读数（DOM 事实，不是 store 派生） */
const gateDom = (call) =>
  H.ev(
    call,
    `(() => {
       const confirm = document.querySelector('[data-confirm-execution]');
       const resend = Array.from(document.querySelectorAll('button'))
         .find((b) => ((b.textContent || '').trim()) === '确认重发');
       const amber = Array.from(document.querySelectorAll('div'))
         .find((d) => typeof d.className === 'string'
           && d.className.includes('text-amber-800')
           && d.textContent.includes('代理'));
       return JSON.stringify({
         confirmPresent: confirm !== null,
         confirmPressed: confirm === null ? null : confirm.getAttribute('aria-pressed'),
         confirmDisabled: confirm === null ? null : confirm.disabled,
         confirmText: confirm === null ? null : (confirm.textContent || '').trim(),
         // ⚠️ Array.prototype.find 返回 **undefined** 而非 null ⇒ 判存在性一律用 != null
         resendPresent: resend != null,
         resendDisabled: resend == null ? null : resend.disabled,
         checking: document.querySelector('[data-messages-proxy-checking]') !== null,
         reason: amber === undefined ? null : (amber.textContent || '').trim().slice(0, 200),
         recordingEntry: document.querySelector('[data-messages-recording-entry]') !== null,
       });
     })()`,
  ).then(JSON.parse);

const resultsDom = (call) =>
  H.ev(
    call,
    `(() => {
       const sec = document.querySelector('[data-messages-results]');
       const blocks = Array.from(document.querySelectorAll('[data-messages-result]'));
       return JSON.stringify({
         hasResults: sec !== null,
         blockCount: blocks.length,
         blockOps: blocks.map((b) => b.getAttribute('data-messages-result')),
         text: sec === null ? '' : (sec.textContent || '').slice(0, 4000),
       });
     })()`,
  ).then(JSON.parse);

/** 概览「本次失败原因」区（LLM 错误区）的读数 */
const overviewErrorDom = (call) =>
  H.ev(
    call,
    `(() => {
       const sec = document.querySelector('section[aria-label="LLM 错误"]');
       if (sec === null) return JSON.stringify({ present: false });
       const btn = Array.from(sec.querySelectorAll('button'))
         .find((b) => ((b.textContent || '').trim()) === '打开该调用并展开所属 step');
       return JSON.stringify({
         present: true,
         text: (sec.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 400),
         // ⚠️ find 返回 undefined；旧形态「无定位入口」这一支正是靠它为假
         locateEntry: btn != null && btn.disabled !== true,
         showsFakeStatus: /HTTP\\s*(502|500|503)/.test(sec.textContent || ''),
         saysUnrecorded: (sec.textContent || '').includes('未记录 HTTP 状态'),
       });
     })()`,
  ).then(JSON.parse);

const bodyHas = (call, text) =>
  H.ev(
    call,
    `JSON.stringify((document.body.textContent || '').includes(${JSON.stringify(text)}))`,
  ).then(JSON.parse);

/** 步骤页调用详情的占位措辞 */
const callDetailDom = (call) =>
  H.ev(
    call,
    `(() => {
       const t = document.body.textContent || '';
       return JSON.stringify({
         placeholderIn: t.includes('未获得（失败调用占位）'),
         placeholderTtft: t.includes('不适用（失败调用无正文抵达）'),
         zeroTtft: /首 token 延迟[^0-9]{0,12}0ms/.test(t),
         zeroTokens: /输入 tokens[^0-9]{0,12}0(?!\\d)/.test(t),
         errorBanner: t.includes('错误详情未记录'),
       });
     })()`,
  ).then(JSON.parse);

/** 顶栏恢复阶段 */
const barPhase = (call) =>
  H.ev(
    call,
    `(() => {
       const dot = document.querySelector('[data-proxy-phase-dot]');
       const label = document.querySelector('[data-proxy-phase-label]');
       const entry = document.querySelector('[data-proxy-open-recording]');
       return JSON.stringify({
         phase: dot === null ? null : dot.getAttribute('data-proxy-phase'),
         label: label === null ? null : (label.textContent || '').trim(),
         entry: entry !== null,
       });
     })()`,
  ).then(JSON.parse);

/** 录制页三层事实行 + 处置区 */
const recordingDom = (call) =>
  H.ev(
    call,
    `(() => {
       const body = document.querySelector('[data-recording-body]');
       if (body === null) return JSON.stringify({ present: false });
       const zone = document.querySelector('[data-recording-recovery]');
       const refresh = document.querySelector('[data-recording-recovery-refresh]');
       const apply = document.querySelector('[data-recording-recovery-apply]');
       const addr = document.querySelector('[data-recording-copy-address]');
       const grab = (sel) => {
         const el = document.querySelector(sel);
         return el === null ? null : { disabled: el.disabled === true, title: el.title || null };
       };
       return JSON.stringify({
         present: true,
         phase: zone === null ? null : zone.getAttribute('data-recovery-phase'),
         zoneText: zone === null ? null : (zone.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
         lines: (body.textContent || '').replace(/\\s+/g, ' ').slice(0, 1200),
         recoveryRefresh: grab('[data-recording-recovery-refresh]'),
         recoveryApply: grab('[data-recording-recovery-apply]'),
         statusRefresh: grab('[data-recording-refresh-status]'),
         address: addr === null ? null : (addr.getAttribute('aria-label') || ''),
         saysStopped: (body.textContent || '').includes('未启用'),
       });
     })()`,
  ).then(JSON.parse);

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

/**
 * 走真实 store `toggleProxy`（真 IPC → main 真监听）。
 *
 * 🔴 **2026-10-08 实测坑（第一次跑就踩）**：`storeQ` 在表达式里先做
 * `const s = m.useAppStore.getState()`，那是**快照对象**；`toggleProxy` 成功后
 * `set({proxy})` 换上的是**新对象** ⇒ 之后再读 `s.proxy` 拿到的仍是调用前的旧值。
 * 第一版因此把「代理已真监听」误判成 `enabled:false`。
 * 正解：await 之后**重新** `getState()`，不复用快照。
 * （与 UI-VERIFY 记的「store 在导入时即捕获引用」同族，但这里换的是状态对象本身。）
 */
const setProxy = (call, input) =>
  H.storeQ(
    call,
    `await s.toggleProxy(${JSON.stringify(input)});
     const now = m.useAppStore.getState();
     return JSON.stringify({ proxy: now.proxy, error: now.error });`,
  );

async function openLlmCallDetail(call, runId, spanId) {
  await H.storeQ(
    call,
    `await s.selectRun(${JSON.stringify(runId)});
     s.setReadingTab(${JSON.stringify(runId)}, "steps");
     s.selectSpan(${JSON.stringify(spanId)});
     return JSON.stringify("ok");`,
  );
  await H.sleep(1600);
}

async function clickSelector(call, selector, wait = 900) {
  const r = await H.ev(
    call,
    `(() => { const b = document.querySelector(${JSON.stringify(selector)});
       if (b === null) return 'no-node';
       if (b.disabled) return 'disabled';
       b.click(); return 'clicked'; })()`,
  );
  if (r !== "clicked") throw new Error(`点 ${selector} 失败：${r}`);
  await H.sleep(wait);
}

async function clickMessagesEntry(call) {
  await clickSelector(call, "[data-messages-workspace-entry]", 1500);
}

/** 进 messages 工作区并等源读到 ready */
async function enterMessagesWorkspace(call, runId, spanId) {
  await H.storeQ(
    call,
    `s.openMessagesWorkspace({ runId: ${JSON.stringify(runId)}, spanId: ${JSON.stringify(spanId)} });
     return JSON.stringify("ok");`,
  );
  const deadline = Date.now() + 12000;
  for (;;) {
    const phase = await H.storeQ(
      call,
      "return JSON.stringify({ phase: s.messagesSource ? s.messagesSource.phase : null });",
    );
    if (phase?.phase === "ready") return { ok: true };
    if (phase?.phase === "failed") return { ok: false, why: "source-failed" };
    if (Date.now() > deadline) return { ok: false, why: "source-timeout", phase };
    await H.sleep(400);
  }
}

async function waitMonaco(call, minEditors = 2) {
  const deadline = Date.now() + 20000;
  let last = null;
  for (;;) {
    last = await H.monacoInfo(call).catch((e) => ({ error: String(e).slice(0, 120) }));
    const list = Array.isArray(last?.editors) ? last.editors : [];
    if (list.length >= minEditors) return { editors: list };
    if (Date.now() > deadline)
      throw new Error(`Monaco 就绪超时（${JSON.stringify(last).slice(0, 200)}）`);
    await H.sleep(600);
  }
}

/**
 * 写草稿并**回读 store 确认**。
 *
 * 🔴 2026-10-08 实测教训：`setValue` 类写法是否触发 React onChange 在不同 Monaco 版本上
 * 结论不同（u8-69 实测生效；4.3 批实测 store 草稿不更新）。所以这里不信任写本身，
 * 一律回读 `drafts.calls[runId][spanId].messages` 判定，失败即当场报错而不是继续跑。
 */
async function writeDraft(call, runId, spanId, text) {
  const info = await waitMonaco(call, 2);
  const editable = info.editors.filter((e) => !e.readOnly);
  if (editable.length === 0) throw new Error("无可编辑编辑器（草稿面缺失）");
  await H.setEditableMonaco(call, text);
  await H.sleep(500);
  const got = await draftText(call, runId, spanId);
  if (got !== text) {
    throw new Error(
      `草稿未落 store：期望 ${text.length} 字，实际 ${String(got).length} 字（Monaco 写入未触发 onChange —— 不可继续，会把后续判据全变假）`,
    );
  }
  return { ok: true, len: text.length };
}

const armConfirm = (call) => clickSelector(call, "[data-confirm-execution]", 900);

async function clickResend(call) {
  const r = await H.ev(
    call,
    `(() => { const b = Array.from(document.querySelectorAll('button'))
        .find((x) => ((x.textContent || '').trim()) === '确认重发');
       if (b === undefined) return 'no-button';
       if (b.disabled) return 'disabled';
       b.click(); return 'clicked'; })()`,
  );
  if (r !== "clicked") throw new Error(`「确认重发」不可点：${r}`);
}

/** 等一条新的 proxy 登记收口（结果区与可信 id 都由它派生） */
async function waitProxySettled(call, exclude, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const recs = await H.storeQ(
      call,
      `const recs = s.operations.operations.filter((o) => o.target && o.target.kind === 'proxy');
       return JSON.stringify(recs.map((o) => ({ operationId: o.operationId, state: o.state,
         runIds: o.runIds })));`,
    );
    const fresh = recs.find((o) => o.state === "settled" && !exclude.includes(o.operationId));
    if (fresh) return fresh;
    if (Date.now() > deadline)
      throw new Error(`代理登记收口超时：${JSON.stringify(recs).slice(0, 300)}`);
    await H.sleep(700);
  }
}

async function waitAutoNav(call, expectRunId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await H.storeQ(
      call,
      "return JSON.stringify({ view: s.view, sel: s.selectedRunId });",
    );
    if (st.view === "trace" && st.sel === expectRunId) return st;
    if (Date.now() > deadline) return st;
    await H.sleep(400);
  }
}

async function shot(call, name) {
  const file = await H.shot(call, SHOTS, `${TAG}-${name}.png`).catch((e) => String(e));
  console.log(`  [截图] ${file}`);
  return file;
}

/** 请求 run-all 释放占端口（restart-failure 用；run-all 轮询这个 flag） */
async function requestPortRelease(timeoutMs = 15000) {
  writeFileSync(RELEASE_FLAG, `${new Date().toISOString()}\n`, "utf8");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (H.fs.existsSync(RELEASED_FLAG)) return true;
    if (Date.now() > deadline) return false;
    await H.sleep(300);
  }
}

// ---------------------------------------------------------------------------
// 会话准备
// ---------------------------------------------------------------------------

async function boot(reload = true) {
  const page = await listPageTarget(H.CDP_PORT);
  const call = await H.makeDialogSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.clearDeviceMetricsOverride").catch(() => {});
  if (reload) {
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
  }
  return call;
}

// ---------------------------------------------------------------------------
// tag: chain（S1–S8）
// ---------------------------------------------------------------------------

const EXTERNAL_MESSAGES = [
  { role: "system", content: "你是被录制的外部应用。" },
  { role: "user", content: "5.1 外部请求一。" },
];

async function tagChain() {
  const call = await boot(true);

  // ── 前置：代理关着（settings 受控副本由 run-all 写） ────────────────────
  const pre = await proxyState(call);
  check(
    "前置：代理未运行、未捕获凭据（恢复阶段为 stopped）",
    pre.proxy !== null && pre.proxy.running === false && pre.proxy.hasKey === false,
    pre,
  );
  dump.pre = pre;

  // ── S1/S2：启用代理 → 外部请求 → 列表自动可见 + 凭据自动翻真 ──────────
  await mockReset({ turns: [{ content: "外部受控响应。" }], fallback: { content: "（耗尽）" } });
  const enabled = await setProxy(call, {
    enabled: true,
    port: PROXY_PORT,
    upstreamBaseUrl: UPSTREAM,
  });
  check(
    "真实启用代理：main 真监听（running=true、port=受控端口）",
    enabled?.proxy?.running === true &&
      enabled?.proxy?.port === PROXY_PORT &&
      enabled.error === null,
    enabled,
  );
  const runningFresh = await proxyState(call);
  check(
    "S3 前置：启用后本会话仍未捕获凭据（如实 hasKey=false）",
    runningFresh.proxy.hasKey === false,
    runningFresh.proxy,
  );
  dump.keyCaptureBefore = runningFresh.proxy.keyCaptureRevision;

  const beforeList = await listSnapshot(call);
  const tracesBefore = new Set(H.traceIds());
  const resp = await externalRequest(EXTERNAL_MESSAGES, { stream: false });
  const [proxyRunId] = await waitNewRuns(tracesBefore, 1, 20000);
  check(
    "S1 前置：外部请求经代理真实转发（上游 200）并落盘为新 run",
    resp.status === 200 && typeof proxyRunId === "string",
    { resp, proxyRunId },
  );
  dump.proxyRunId = proxyRunId;

  const run1 = readRunFile(proxyRunId);
  check(
    "S1 前置：代理 run 落盘形态（source=proxy、messages 与外部请求逐字一致）",
    run1.meta.source?.kind === "proxy" &&
      JSON.stringify(run1.llms[0].request.messages) === JSON.stringify(EXTERNAL_MESSAGES),
    { source: run1.meta.source, messages: run1.llms[0].request.messages },
  );

  // 核心：**不调 loadRuns**，等 store.runs 自己出现新 id
  const listed = await waitListHas(call, proxyRunId, 20000);
  check("S1 被动录制自动可见：零手动刷新下列表自动出现新 run id", listed.ok === true, {
    ok: listed.ok,
    count: Array.isArray(listed.ids) ? listed.ids.length : null,
  });
  const afterList = await listSnapshot(call);
  check(
    "S1 阅读意图保留：选中/详情/筛选/搜索词逐字未变",
    afterList.selectedRunId === beforeList.selectedRunId &&
      afterList.detailId === beforeList.detailId &&
      afterList.filter === beforeList.filter &&
      afterList.search === beforeList.search,
    { before: beforeList, after: afterList },
  );
  check(
    "S1 零主动登记：被动录制不新增 proxy/modelAb 登记",
    JSON.stringify(afterList.proxyOps) === JSON.stringify(beforeList.proxyOps) &&
      JSON.stringify(afterList.abOps) === JSON.stringify(beforeList.abOps),
    { proxy: afterList.proxyOps, ab: afterList.abOps },
  );

  const keyFlip = await waitProxyFact(call, "s.proxy.hasKey", true, 15000);
  check(
    "S2 凭据捕获可观测：外部请求捕获 key ⇒ 通知路径自动把 hasKey 翻真（无手动重读）",
    keyFlip.ok === true,
    keyFlip,
  );
  const afterKey = await proxyState(call);
  check(
    "S2 捕获版本推进且游标前进（记录 + 状态两个维度都采纳新事实）",
    typeof afterKey.proxy.keyCaptureRevision === "number" &&
      afterKey.proxy.keyCaptureRevision > 0 &&
      afterKey.cursor.recordsRevision > 0 &&
      afterKey.cursor.epoch === afterKey.proxy.epoch,
    { capture: afterKey.proxy.keyCaptureRevision, cursor: afterKey.cursor },
  );
  dump.keyCaptureAfterFirst = afterKey.proxy.keyCaptureRevision;
  await shot(call, "01-passive-visible");

  // ── S3：停用代理后打开 messages ⇒ 门禁按当前事实说「未运行」 ────────────
  await openLlmCallDetail(call, proxyRunId, "s_02");
  await clickMessagesEntry(call);
  const entered = await waitProxyFact(
    call,
    "s.messagesSource ? s.messagesSource.phase : null",
    "ready",
    15000,
  );
  check("S3 前置：messages 工作区打开、源读到 ready", entered.ok === true, entered);
  const gateRunning = await gateDom(call);
  check(
    "S3 前置：代理在跑且已捕获 key ⇒ 确认可点（核对后才放行）",
    gateRunning.confirmPresent === true &&
      gateRunning.confirmDisabled === false &&
      gateRunning.confirmPressed === null,
    gateRunning,
  );

  const tracesBeforeStop = new Set(H.traceIds());
  await setProxy(call, { enabled: false, port: PROXY_PORT, upstreamBaseUrl: UPSTREAM });
  const gateStopped = await waitGate(
    call,
    (g) =>
      g.confirmDisabled === true && typeof g.reason === "string" && g.reason.includes("未运行"),
    15000,
  );
  check(
    "S3 打开重发即核对当前状态：停用后**已打开的编辑器**就地改为「代理未运行」",
    gateStopped.gate.confirmDisabled === true &&
      gateStopped.gate.reason.includes("本地录制代理未运行") &&
      gateStopped.gate.resendDisabled === true,
    gateStopped.gate,
  );
  check(
    "S3 措辞不撒谎：hasKey 仍为 true 时不说「未捕获 key」（顺序判据：先监听后凭据）",
    gateStopped.gate.reason !== null && !gateStopped.gate.reason.includes("未捕获"),
    gateStopped.gate.reason,
  );
  check(
    "S3 零自动重发：停用/门禁翻转全程无新 run、无新登记",
    H.traceIds().size === tracesBeforeStop.size,
    { before: tracesBeforeStop.size, after: H.traceIds().size },
  );
  await shot(call, "02-gate-not-running");

  // 重新启用 ⇒ 已打开的编辑器就地恢复（捕获通知路径的另一面：status 通知）
  await setProxy(call, { enabled: true, port: PROXY_PORT, upstreamBaseUrl: UPSTREAM });
  const gateBack = await waitGate(call, (g) => g.confirmDisabled === false, 15000);
  check(
    "S3 已打开编辑器随通知就地恢复：重新启用后确认口重新可点",
    gateBack.gate.confirmDisabled === false && gateBack.gate.resendDisabled === true,
    gateBack.gate,
  );
  note(
    "S3 的「核对中」瞬态在本机不可稳定采样（状态回读是毫秒级 IPC）：该中间态由 " +
      "`proxy-status-store.test.ts` / `messages-eligibility.test.ts` 承载，实机只验终态与就地翻转。",
  );

  // ── S4：arm 确认 → 外部换 key ⇒ 旧确认就地撤销 ─────────────────────────
  await writeDraft(
    call,
    proxyRunId,
    "s_02",
    JSON.stringify(editTail(EXTERNAL_MESSAGES, "已编辑"), null, 2),
  );
  await armConfirm(call);
  const armed = await gateDom(call);
  check("S4 前置：确认已 arm（aria-pressed=true）", armed.confirmPressed === "true", armed);

  const tracesBeforeRotate = new Set(H.traceIds());
  const opsBeforeRotate = (await listSnapshot(call)).proxyOps;
  await mockReset({ turns: [{ content: "轮换后响应。" }], fallback: { content: "（耗尽）" } });
  await externalRequest([{ role: "user", content: "5.1 换 key 的外部请求。" }], {
    stream: false,
    key: "Bearer sk-proxy-51-b",
  });
  const rotateRuns = await waitNewRuns(tracesBeforeRotate, 1, 20000);
  const revoked = await waitGate(call, (g) => g.confirmPressed !== "true", 15000);
  const afterRotate = await proxyState(call);
  const draftAfterRotate = await draftText(call, proxyRunId, "s_02");
  check(
    "S4 凭据轮换撤销旧确认：hasKey 仍 true 而捕获版本推进 ⇒ 已 arm 的确认就地失效",
    afterRotate.proxy.hasKey === true &&
      afterRotate.proxy.keyCaptureRevision > dump.keyCaptureAfterFirst &&
      revoked.gate.confirmPressed !== "true",
    { capture: afterRotate.proxy.keyCaptureRevision, gate: revoked.gate },
  );
  check(
    "S4 草稿逐字保留、零自动重发：撤销确认不碰草稿、不产生 fork run",
    draftAfterRotate === JSON.stringify(editTail(EXTERNAL_MESSAGES, "已编辑"), null, 2) &&
      rotateRuns.length === 1 &&
      JSON.stringify((await listSnapshot(call)).proxyOps) === JSON.stringify(opsBeforeRotate),
    { draftLen: String(draftAfterRotate).length, rotateRuns: rotateRuns.length },
  );
  await shot(call, "03-rotation-revokes");

  // ── S5：重发成功 ───────────────────────────────────────────────────────
  const edited1 = editTail(EXTERNAL_MESSAGES, "已编辑");
  await mockReset({ turns: [{ content: "重发受控响应。" }], fallback: { content: "（耗尽）" } });
  const tracesBeforeFork1 = new Set(H.traceIds());
  const servedBefore1 = await mockServed();
  await armConfirm(call);
  await clickResend(call);
  const rec1 = await waitProxySettled(call, [], 40000);
  const fork1Id = rec1.runIds[0];
  const fork1New = await waitNewRuns(tracesBeforeFork1, 1, 20000);
  const servedAfter1 = await mockServed();
  const fork1 = readRunFile(fork1Id);
  check(
    "S5 编辑重发成功：真实上游恰好一次 + 子 run parent/at_span/edit/messages 逐字正确",
    servedAfter1 - servedBefore1 === 1 &&
      fork1.meta.parent === proxyRunId &&
      fork1.meta.fork?.at_span === "s_02" &&
      fork1.meta.fork?.edit?.field === "messages" &&
      JSON.stringify(fork1.llms[0].request.messages) === JSON.stringify(edited1) &&
      fork1New.length === 1,
    {
      served: servedAfter1 - servedBefore1,
      parent: fork1.meta.parent,
      field: fork1.meta.fork?.edit?.field,
      newRuns: fork1New.length,
    },
  );
  check(
    "S5 登记只含本次 fork 的可信 id（单请求边界）",
    rec1.runIds.length === 1 && rec1.runIds[0] === fork1Id,
    rec1,
  );
  dump.fork1Id = fork1Id;
  const nav1 = await waitAutoNav(call, fork1Id);
  check("S5 收口自动导航到结果 run", nav1.view === "trace" && nav1.sel === fork1Id, nav1);
  await openLlmCallDetail(call, proxyRunId, "s_02");
  await clickMessagesEntry(call);
  const res1 = await waitMessagesBlocks(call, 1);
  check(
    "S5 结果区只呈现登记的可信 id（1 块，含 fork1，不含同轮被动 run）",
    res1.hasResults === true &&
      res1.blockCount === 1 &&
      res1.blockOps[0] === rec1.operationId &&
      res1.text.includes(fork1Id) &&
      !res1.text.includes(rotateRuns[0] ?? ""),
    { blocks: res1.blockOps, hasFork: res1.text.includes(fork1Id) },
  );
  await shot(call, "04-resend-success");

  // ── S6：失败重发 503 ⇒ 概览可诊断 + 详情占位 ───────────────────────────
  const parentHashBefore = readFileSync(join(H.TRACES, `${proxyRunId}.jsonl`), "utf8");
  await mockReset({
    turns: [
      { mode: "fail", status: 503, errorBody: { error: { message: "受控 503（上游不可用）" } } },
    ],
    fallback: { mode: "fail", status: 503 },
  });
  const edited2 = editTail(EXTERNAL_MESSAGES, "失败重发（503）");
  await writeDraft(call, proxyRunId, "s_02", JSON.stringify(edited2, null, 2));
  await armConfirm(call);
  await clickResend(call);
  const rec2 = await waitProxySettled(call, [rec1.operationId], 40000);
  const fork2Id = rec2.runIds[0];
  const fork2 = readRunFile(fork2Id);
  check(
    "S6 失败重发落自有诊断：llm.call 带 error.status=503 + 终态 stopped/error",
    fork2.llms.length === 1 &&
      fork2.llms[0].error?.status === 503 &&
      fork2.terminal.event === "stopped" &&
      fork2.terminal.reason === "error" &&
      JSON.stringify(fork2.llms[0].request.messages) === JSON.stringify(edited2),
    {
      llms: fork2.llms.length,
      status: fork2.llms[0]?.error?.status,
      message: fork2.llms[0]?.error?.message,
      terminal: `${fork2.terminal.event}/${fork2.terminal.reason}`,
    },
  );
  check(
    "S6 父本逐字不变、失败父本仍可再编辑重发（草稿保留）",
    readFileSync(join(H.TRACES, `${proxyRunId}.jsonl`), "utf8") === parentHashBefore,
    { bytes: parentHashBefore.length },
  );
  const draftKept = await draftText(call, proxyRunId, "s_02");
  check(
    "S6 草稿逐字保留：error 终态不是正常结束 ⇒ 不按提交修订清理",
    draftKept === JSON.stringify(edited2, null, 2),
    { len: String(draftKept).length },
  );
  dump.fork2Id = fork2Id;

  const nav2 = await waitAutoNav(call, fork2Id);
  check(
    "S6 失败也自动导航到失败 run（编辑输入不受影响）",
    nav2.view === "trace" && nav2.sel === fork2Id,
    nav2,
  );
  await H.sleep(800);
  const errSec = await overviewErrorDom(call);
  check(
    "S6 新代理失败在概览可诊断：真实状态码 + 受控摘要 + 定位入口",
    errSec.present === true &&
      errSec.text.includes("HTTP 503") &&
      errSec.text.includes("受控 503") &&
      errSec.locateEntry === true,
    errSec,
  );
  await shot(call, "05-failure-overview");

  // 点定位入口 ⇒ 步骤页该调用详情把 usage/ttft 标成占位
  await H.ev(
    call,
    `(() => { const sec = document.querySelector('section[aria-label="LLM 错误"]');
       const btn = Array.from(sec.querySelectorAll('button'))
         .find((b) => ((b.textContent || '').trim()) === '打开该调用并展开所属 step');
       if (!btn || btn.disabled) return false; btn.click(); return true; })()`,
  );
  await H.sleep(1800);
  const detail = await callDetailDom(call);
  const selSpan = await H.storeQ(call, "return JSON.stringify({ sel: s.selectedSpanId });");
  check("S6 定位入口真的定位：选中失败调用并切到步骤页", selSpan.sel === fork2.llms[0].id, selSpan);
  check(
    "S6 调用详情把 usage/ttft 标成占位说明（不出现 0ms / 输入 tokens 0）",
    detail.placeholderIn === true &&
      detail.placeholderTtft === true &&
      detail.zeroTtft === false &&
      detail.zeroTokens === false,
    detail,
  );
  await shot(call, "06-failure-call-detail");

  // ── S7：网络失败不伪造状态码 ───────────────────────────────────────────
  await setProxy(call, { enabled: true, port: PROXY_PORT, upstreamBaseUrl: DEAD_UPSTREAM });
  await mockReset({ turns: [{ content: "（不会被消费）" }], fallback: { content: "（耗尽）" } });
  const tracesBeforeDead = new Set(H.traceIds());
  const deadResp = await externalRequest([{ role: "user", content: "5.1 连接失败请求。" }], {
    stream: false,
    key: "Bearer sk-proxy-51-c",
  }).catch((e) => ({ error: String(e).slice(0, 120) }));
  const deadRuns = await waitNewRuns(tracesBeforeDead, 1, 20000);
  const deadRun = typeof deadRuns[0] === "string" ? readRunFile(deadRuns[0]) : null;
  check(
    "S7 连接失败落 error 且**不写** status（本地 502 不冒充上游码）",
    deadRun !== null &&
      deadRun.llms.length === 1 &&
      deadRun.terminal.reason === "error" &&
      (deadRun.llms[0].error?.status === undefined || deadRun.llms[0].error?.status === null),
    {
      clientStatus: deadResp?.status ?? deadResp,
      llms: deadRun?.llms.length,
      errorKeys: deadRun === null ? null : Object.keys(deadRun.llms[0].error ?? {}),
      terminal: deadRun === null ? null : `${deadRun.terminal.event}/${deadRun.terminal.reason}`,
    },
  );
  if (deadRun !== null) {
    await H.storeQ(
      call,
      `await s.selectRun(${JSON.stringify(deadRuns[0])}); return JSON.stringify("ok");`,
    );
    await H.sleep(1500);
    const deadSec = await overviewErrorDom(call);
    check(
      "S7 概览明说「未记录 HTTP 状态」而不是显示伪造上游码",
      deadSec.present === true &&
        deadSec.saysUnrecorded === true &&
        deadSec.showsFakeStatus === false,
      deadSec,
    );
    await shot(call, "07-network-failure");
  }
  dump.deadRunId = typeof deadRuns[0] === "string" ? deadRuns[0] : null;
  await setProxy(call, { enabled: true, port: PROXY_PORT, upstreamBaseUrl: UPSTREAM });

  // ── S8：旧形态失败 fixture ⇒ 诚实缺失提示，无定位入口 ───────────────────
  //
  // 🔴 **判据分两层，别合成一条**（2026-10-08 实测踩到）：
  // 「错误详情未记录」横幅（`ErrorDetailNotice`）只挂在**步骤页/文件页**
  // （`DetailPanel.tsx:2008` / `WorkspaceFilesPanel.tsx:102`），**概览页没有它**；
  // 概览页走的是 `presentLlmError` 的 `missing` 分支，措辞是
  // 「自有记录里没有 LLM 错误详情——不反推原因，也不借用祖先的错误」。
  // 第一版把两条合成一条（要求概览页同时出现横幅字面量）⇒ 假红。
  // 正确分层：概览查 missing 说明 + 无定位入口；步骤页查横幅。
  const legacyId = "run_proxy51_legacy_error";
  const legacyPath = join(H.TRACES, `${legacyId}.jsonl`);
  const legacyShaBefore = H.createHash("sha256")
    .update(readFileSync(legacyPath, "utf8"))
    .digest("hex");
  await H.storeQ(call, `await s.loadRuns(); return JSON.stringify("ok");`);
  await H.storeQ(
    call,
    `await s.selectRun(${JSON.stringify(legacyId)}); return JSON.stringify("ok");`,
  );
  await H.sleep(1600);
  const legacySec = await overviewErrorDom(call);
  check(
    "S8 概览层：旧代理失败给诚实缺失说明且**不给**定位入口（不指向不存在的东西）",
    legacySec.present === true &&
      legacySec.locateEntry === false &&
      legacySec.text.includes("没有 LLM 错误详情") &&
      legacySec.text.includes("不借用祖先"),
    legacySec,
  );
  // 步骤页：横幅在场
  await H.storeQ(
    call,
    `s.setReadingTab(${JSON.stringify(legacyId)}, "steps"); return JSON.stringify("ok");`,
  );
  await H.sleep(1200);
  const legacyBody = await bodyHas(call, "错误详情未记录");
  const legacyNoInfer = await bodyHas(call, "此处不推断失败原因");
  check(
    "S8 步骤页层：「错误详情未记录」横幅在场且明说不推断原因",
    legacyBody === true && legacyNoInfer === true,
    { banner: legacyBody, noInfer: legacyNoInfer },
  );
  check(
    "S8 缺失 fixture 字节不变（读取路径零副作用）",
    H.createHash("sha256").update(readFileSync(legacyPath, "utf8")).digest("hex") ===
      legacyShaBefore,
    { legacyId },
  );
  await shot(call, "08-legacy-missing-detail");

  dump.traces = { final: H.traceIds().size };
  finish();
}

function editTail(messages, tail) {
  const out = JSON.parse(JSON.stringify(messages));
  out[out.length - 1].content = `${out[out.length - 1].content}（${tail}）`;
  return out;
}

async function waitGate(call, pred, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let gate = await gateDom(call);
  for (;;) {
    if (pred(gate)) return { gate };
    if (Date.now() > deadline) return { gate };
    await H.sleep(300);
    gate = await gateDom(call);
  }
}

async function waitMessagesBlocks(call, minCount, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let dom = await resultsDom(call);
  for (;;) {
    if (dom.hasResults === true && dom.blockCount >= minCount) return dom;
    if (Date.now() > deadline) return dom;
    await H.sleep(500);
    dom = await resultsDom(call);
  }
}

// ---------------------------------------------------------------------------
// tag: restart-success
// ---------------------------------------------------------------------------

async function tagRestartSuccess() {
  const call = await boot(true);
  const st = await proxyState(call);
  check(
    "保存启用后重启恢复监听：autoStart 真监听、phase=listening",
    st.proxy !== null &&
      st.proxy.enabled === true &&
      st.proxy.running === true &&
      st.proxy.port === PROXY_PORT &&
      st.proxy.recovery === "stopped" &&
      st.proxy.recoveryFailure === null,
    st.proxy,
  );
  check(
    "重启后凭据不恢复：hasKey=false（本会话未捕获，如实呈现）",
    st.proxy.hasKey === false && st.proxy.keyCaptureRevision === 0,
    { hasKey: st.proxy.hasKey, capture: st.proxy.keyCaptureRevision },
  );
  const bar = await barPhase(call);
  check("顶栏呈现已监听（phase=listening）", bar.phase === "listening", bar);
  check("恢复成功不提供录制页入口（needsRecordingEntry=false）", bar.entry === false, bar);
  await shot(call, "10-restart-listening");

  // 历史仍可读
  const runs = await H.runs(call);
  check("重启后历史运行仍可读（列表非空）", runs.length > 0, { count: runs.length });
  const detailOk = await H.storeQ(
    call,
    `if (s.selectedRunId === null) await s.selectRun(s.runs[0].id);
     return JSON.stringify({ id: s.selectedRunId });`,
  );
  await H.sleep(1500);
  const phase = await H.storeQ(
    call,
    "return JSON.stringify({ detail: s.detail && s.detail.meta ? s.detail.meta.id : null });",
  );
  check(
    "重启后历史详情可读（恢复不影响阅读入口）",
    detailOk.id !== null && phase.detail === detailOk.id,
    { ...detailOk, ...phase },
  );

  // 录制页：已监听 + 地址可复制 + 无处置区
  await H.storeQ(call, `s.openRecordingWorkspace(); return JSON.stringify("ok");`);
  await H.sleep(1500);
  const rec = await recordingDom(call);
  check(
    "录制页三层事实：已启用 / 运行中 / 尚未捕获 key（凭据行不被省掉）",
    rec.present === true &&
      rec.lines.includes("已启用（配置已保存）") &&
      rec.lines.includes("运行中") &&
      rec.lines.includes("尚未捕获 key"),
    { lines: String(rec.lines).slice(0, 300) },
  );
  check(
    "恢复成功后接入地址可复制（只来自已核实监听）",
    typeof rec.address === "string" && rec.address.includes(String(PROXY_PORT)),
    { address: rec.address },
  );
  check("恢复成功不渲染失败处置区（phase 属性缺席）", rec.phase === null, { phase: rec.phase });
  await shot(call, "11-restart-recording-page");
  finish();
}

// ---------------------------------------------------------------------------
// tag: restart-failure
// ---------------------------------------------------------------------------

async function tagRestartFailure() {
  const call = await boot(true);
  const st = await proxyState(call);
  check(
    "重启恢复失败可见：enabled=true 但 running=false、recovery=failed、受控诊断在位",
    st.proxy !== null &&
      st.proxy.enabled === true &&
      st.proxy.running === false &&
      st.proxy.recovery === "failed" &&
      st.proxy.recoveryFailure !== null &&
      typeof st.proxy.recoveryFailure.message === "string" &&
      st.proxy.recoveryFailure.message.length > 0,
    st.proxy,
  );
  check("失败不回滚保存意图（enabled 仍为 true）", st.proxy.enabled === true, {
    enabled: st.proxy.enabled,
  });
  const bar = await barPhase(call);
  check(
    "顶栏红色失败态 + 就近录制页入口",
    bar.phase === "failed" && bar.entry === true && bar.label.includes("已启用未监听"),
    bar,
  );
  await shot(call, "12-restart-failed-bar");

  // 历史仍可读（恢复失败不阻断阅读）
  const runs = await H.runs(call);
  check("恢复失败时历史仍可读", runs.length > 0, { count: runs.length });

  await H.storeQ(call, `s.openRecordingWorkspace(); return JSON.stringify("ok");`);
  await H.sleep(1500);
  const rec = await recordingDom(call);
  check("录制页失败处置区在场（phase=failed）", rec.present === true && rec.phase === "failed", {
    phase: rec.phase,
  });
  check(
    "意图与监听两行分别说清，且不说成「已停用」",
    rec.lines.includes("已启用（配置已保存）") &&
      rec.lines.includes("未监听") &&
      rec.saysStopped === false,
    { lines: String(rec.lines).slice(0, 400) },
  );
  check(
    "受控原因原样透出（不编造、也不吞掉）",
    typeof rec.zoneText === "string" &&
      rec.zoneText.includes("启动恢复失败") &&
      rec.zoneText.length > 0,
    { zone: rec.zoneText },
  );
  check(
    "凭据行照旧呈现，不因「看起来已启用」就说凭据可用",
    String(rec.lines).includes("尚未捕获 key"),
    { has: String(rec.lines).includes("尚未捕获 key") },
  );
  check(
    "两个处置入口都在场且各带作用说明（重读=不启动监听；应用=再次尝试监听）",
    rec.recoveryRefresh !== null &&
      rec.recoveryApply !== null &&
      String(rec.recoveryRefresh.title).includes("不启动监听") &&
      String(rec.recoveryApply.title).includes("再次尝试监听"),
    { refresh: rec.recoveryRefresh, apply: rec.recoveryApply },
  );
  await shot(call, "13-restart-failed-recording");

  // 只读重读不启动监听：连点 5 次，端口仍被占、阶段仍 failed、上游零调用
  const servedBefore = await mockServed().catch(() => null);
  const revBefore = st.proxy.revision;
  for (let i = 0; i < 5; i++) {
    await clickSelector(call, "[data-recording-recovery-refresh]", 700);
  }
  const after5 = await proxyState(call);
  const servedAfter = await mockServed().catch(() => null);
  check(
    "状态重读是纯只读：连读 5 次不启动监听、不推进 revision、零上游调用",
    after5.proxy.running === false &&
      after5.proxy.recovery === "failed" &&
      after5.proxy.revision === revBefore &&
      servedAfter === servedBefore,
    { revBefore, revAfter: after5.proxy.revision, servedBefore, servedAfter },
  );

  // 释放端口 ⇒ 显式「保存并应用」重试成功
  const released = await requestPortRelease();
  check("占位端口已释放（run-all 核验真空出）", released === true, { released });
  const freed = await waitPortFree(PROXY_PORT, 15000);
  check("端口真空出（node:net 判据，非 fetch）", freed === true, { freed });
  await clickSelector(call, "[data-recording-recovery-apply]", 2500);
  const applied = await waitProxyFact(call, "s.proxy.running", true, 20000);
  check(
    "显式应用重试成功：真实监听恢复、阶段复位、诊断清空",
    applied.ok === true &&
      applied.value === true &&
      (await proxyState(call)).proxy.recovery === "stopped",
    applied,
  );
  const rec2 = await recordingDom(call);
  check(
    "重试成功后失败处置区消失（不再呈现过期诊断）",
    rec2.phase === null && typeof rec2.address === "string",
    { phase: rec2.phase, address: rec2.address },
  );
  await shot(call, "14-restart-retry-success");

  // 收尾：停用并保存（供 restart-off 段）
  await H.storeQ(call, `s.setView("trace"); return JSON.stringify("ok");`);
  await H.storeQ(call, `s.openRecordingWorkspace(); return JSON.stringify("ok");`);
  await H.sleep(900);
  await clickSelector(call, "[data-recording-enabled]", 700);
  await clickSelector(call, "[data-recording-apply]", 2500);
  const off = await proxyState(call);
  check(
    "收尾：停用并保存成功（enabled=false、running=false）",
    off.proxy.enabled === false && off.proxy.running === false,
    off.proxy,
  );
  finish();
}

function waitPortFree(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    for (;;) {
      if (!(await portAlive(port))) return true;
      if (Date.now() > deadline) return false;
      await H.sleep(400);
    }
  })();
}

// ---------------------------------------------------------------------------
// tag: restart-off
// ---------------------------------------------------------------------------

async function tagRestartOff() {
  const call = await boot(true);
  const servedBefore = await mockServed().catch(() => null);
  const st = await proxyState(call);
  check(
    "保存停用后重启不尝试监听：enabled=false、running=false、recovery=stopped、无诊断",
    st.proxy !== null &&
      st.proxy.enabled === false &&
      st.proxy.running === false &&
      st.proxy.recovery === "stopped" &&
      st.proxy.recoveryFailure === null,
    st.proxy,
  );
  const alive = await portAlive(PROXY_PORT);
  check("端口上真的没人监听（node:net 判据）", alive === false, { alive });
  const servedAfter = await mockServed().catch(() => null);
  check("零上游调用（恢复路径不验证连接）", servedAfter === servedBefore, {
    servedBefore,
    servedAfter,
  });
  const bar = await barPhase(call);
  check("顶栏呈现「代理已停」（不冒充恢复失败）", bar.phase === "stopped", bar);
  await shot(call, "15-restart-off");

  // 为下一段（若编排继续）恢复启用
  await H.storeQ(call, `s.openRecordingWorkspace(); return JSON.stringify("ok");`);
  await H.sleep(900);
  await clickSelector(call, "[data-recording-enabled]", 700);
  await clickSelector(call, "[data-recording-apply]", 2500);
  const on = await proxyState(call);
  check(
    "收尾：重新启用并保存成功",
    on.proxy.enabled === true && on.proxy.running === true,
    on.proxy,
  );
  finish();
}

// ---------------------------------------------------------------------------

async function main() {
  if (TAG === "chain") return tagChain();
  if (TAG === "restart-success") return tagRestartSuccess();
  if (TAG === "restart-failure") return tagRestartFailure();
  if (TAG === "restart-off") return tagRestartOff();
  throw new Error(`未知 tag：${TAG}`);
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  writeFileSync(join(ROOT, `${TAG}-error.txt`), String(e?.stack ?? e));
  process.exit(1);
});
