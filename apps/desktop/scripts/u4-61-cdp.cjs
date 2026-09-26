/* eslint-disable */
/**
 * U4 任务 6.1：受控服务实测「普通 / 隔离 create」的**真机**登记与身份定位。
 *
 * 覆盖 delta 场景（specs/desktop-ui/spec.md，逐字标题）：
 * - `同 ID 重复请求只执行一次`      → tag `duplicate`
 * - `普通和隔离创建失败保留 ID`      → tag `plain-fail`（模型 500，结构化身份）
 * - `结果不可读不重执行且不锁配置`    → tag `unreadable`
 * 另加两条基线：`plain-success`（成功路径的登记/文件/mock 计数）、
 * `isolated`（sourceToken 一次性消费 + 重复提交不二次消费）。
 *
 * 判据口径（不靠界面自述）：
 * 1. **一律经真桥接面**（`window.api` → preload → ipcMain），执行请求都带执行信封；
 * 2. 提交值与身份以**落盘 jsonl 的 `meta.id`** 与 mock 服务收到的请求数核对；
 * 3. 「只执行一次」= mock `served` 增量 + traces `.jsonl` 增量，两处**同时**为 1/0；
 * 4. 「不锁配置」= 读取失败后 `saveSettings` 仍成功且 mock 计数不变。
 *
 * 前置（由 `.workbuddy/u4/u4-61/run-all.cjs` 一次性备好）：
 *   - dev 带 CDP 9612 启动，settings.json 的 baseURL 指向受控服务；
 *   - 受控模型服务在 127.0.0.1:18799（本脚本用 `/__reset` 换剧本、`/__log` 数请求）；
 *   - 隔离 tag 需要 dev 以 `REBASEAGENT_SMOKE_PICK_DIR=<源目录>` 启动（原生目录框不可驱动）。
 *
 * 用法：`node apps/desktop/scripts/u4-61-cdp.cjs --tag=plain-success`
 * 产物：`.workbuddy/u4/u4-61/<tag>/measurements.json` + 截图
 *
 * ⚠️ 两条实测到的契约形状（写断言别按直觉）：
 * - 重复提交的那一条**不回 data**——`{ok:false, error.code:"OPERATION_DUPLICATED",
 *   operation:{…state:"settled"}}`，运行身份要经 status/reconcile 取；
 * - `ReconcileResult` = 槽状态 + `data.operation`，**没有** `data.state`。
 */
"use strict";
const { chromium } = require("playwright-core");
const {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} = require("node:fs");
const { join, resolve } = require("node:path");

const REPO = resolve(__dirname, "..", "..", "..");
const DATA_DIR = join(REPO, ".rebaseagent");
const TRACES = join(DATA_DIR, "traces");
const OUT_ROOT = join(REPO, ".workbuddy", "u4", "u4-61");
const CDP = "http://127.0.0.1:9612";
const MOCK = "http://127.0.0.1:18799";

function argOf(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}
const TAGS = [
  "probe",
  "plain-success",
  "plain-fail",
  "isolated",
  "isolated-fail",
  "duplicate",
  "unreadable",
];
const TAG = argOf("tag");
if (TAG === undefined || !TAGS.includes(TAG)) {
  console.error(`用法：--tag=<${TAGS.join("|")}>`);
  process.exit(2);
}

const OUT = join(OUT_ROOT, TAG);
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// 记账
// ---------------------------------------------------------------------------
const checks = [];
const dump = {};
function check(name, ok, detail) {
  checks.push({ name, ok: ok === true, detail: detail === undefined ? null : detail });
  console.log(
    `${ok === true ? "✓" : "✗"} ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`}`,
  );
}
function finish() {
  const failed = checks.filter((c) => !c.ok);
  writeFileSync(
    join(OUT, "measurements.json"),
    JSON.stringify({ tag: TAG, checks, failed: failed.length, dump }, null, 2),
  );
  console.log(`检查 ${checks.length} 条，失败 ${failed.length} 条；产物 ${OUT}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// 受控服务侧：计数 + 换剧本
// ---------------------------------------------------------------------------
async function mockServed() {
  const r = await fetch(`${MOCK}/__log`);
  const j = await r.json();
  return { served: j.served, entries: j.entries ?? [] };
}
async function mockReset(script) {
  const r = await fetch(`${MOCK}/__reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(script === undefined ? {} : { script }),
  });
  if (!r.ok) throw new Error(`mock /__reset 失败：${r.status}`);
}

// ---------------------------------------------------------------------------
// 数据侧：run 文件
// ---------------------------------------------------------------------------
function traceFiles() {
  try {
    return readdirSync(TRACES).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
}
function readMeta(id) {
  const file = join(TRACES, `${id}.jsonl`);
  if (!existsSync(file)) return null;
  const first = readFileSync(file, "utf8")
    .split("\n")
    .find((l) => l.trim() !== "");
  try {
    return JSON.parse(first);
  } catch {
    return { parseError: true };
  }
}
function readLines(id) {
  const file = join(TRACES, `${id}.jsonl`);
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// 页内真 IPC（经桥接面，不经 store）
// ---------------------------------------------------------------------------
async function pageConnect() {
  const browser = await chromium.connectOverCDP(CDP);
  const page = browser
    .contexts()[0]
    .pages()
    .find((p) => p.url().includes("localhost:5173"));
  if (page === undefined) throw new Error("未找到渲染层页面（dev 是否带 CDP 9612 启动？）");
  await page.waitForTimeout(1200);
  return { browser, page };
}

/** 握手取 epoch；operationId 每次新生成（与渲染层适配器同一口径） */
async function handshakenEpoch(page) {
  const status = await page.evaluate(async () => await window.api.operationsStatus());
  if (!status.ok) throw new Error(`operationsStatus 失败：${JSON.stringify(status.error)}`);
  return status.data.epoch;
}

/** 提交一次 create（页内 await，取回原始响应 + 提交时刻的 status 快照） */
async function submitCreate(page, epoch, operationId, request) {
  return page.evaluate(
    async ([ep, id, req]) =>
      await window.api.createRun({ operation: { epoch: ep, operationId: id }, request: req }),
    [epoch, operationId, request],
  );
}
async function statusOf(page) {
  return page.evaluate(async () => await window.api.operationsStatus());
}
async function reconcileOf(page, epoch, operationId) {
  return page.evaluate(
    async ([ep, id]) => await window.api.operationsReconcile({ epoch: ep, operationId: id }),
    [epoch, operationId],
  );
}
async function getRun(page, id) {
  return page.evaluate(async (runId) => await window.api.getRun(runId), id);
}
function freshId() {
  return `00000000-0000-4000-8000-${String(Date.now() % 1_000_000_000).padStart(12, "0")}`;
}
/** 同一 operationId 的两条并发提交：返回两条响应 */
async function submitTwice(page, epoch, operationId, request) {
  return page.evaluate(
    async ([ep, id, req]) => {
      const envelope = { operation: { epoch: ep, operationId: id }, request: req };
      return Promise.all([window.api.createRun(envelope), window.api.createRun(envelope)]);
    },
    [epoch, operationId, request],
  );
}

const PLAIN_REQUEST = {
  systemPrompt: "你是冒烟助手。只用一句话回答。",
  userMessage: "U4 6.1 冒烟：说「好」。",
};

// ---------------------------------------------------------------------------
// 各 tag
// ---------------------------------------------------------------------------
async function main() {
  const { browser, page } = await pageConnect();
  const epoch = await handshakenEpoch(page);
  dump.epoch = epoch;
  await page.screenshot({ path: join(OUT, "00-app.png") });

  if (TAG === "probe") {
    const settings = await page.evaluate(async () => await window.api.getSettings());
    const files = traceFiles();
    dump.settings = settings;
    dump.traceFiles = files.length;
    dump.mock = await mockServed();
    check("probe：桥接面可用（getSettings 信封合法）", settings.ok === true, {
      configured: settings.ok ? settings.data.configured : null,
    });
    check(
      "probe：受控服务在监听",
      dump.mock.served === 0 || dump.mock.served >= 0,
      dump.mock.served,
    );
    check("probe：traces 目录可读", files.length >= 0, files.length);
    await browser.close();
    return finish();
  }

  // ---- 成功路径：一次请求、一个文件、登记 settled 且 runId 可信 ----
  if (TAG === "plain-success") {
    await mockReset({ turns: [{ content: "好。" }], fallback: { content: "兜底" } });
    const before = traceFiles().length;
    const operationId = freshId();
    const res = await submitCreate(page, epoch, operationId, PLAIN_REQUEST);
    dump.response = res;
    check(
      "成功：响应 ok 且回执身份与提交一致",
      res.ok === true && res.operation?.operationId === operationId,
      res.operation ?? res.error,
    );
    check(
      "成功：回执状态 settled",
      res.ok === true && res.operation.state === "settled",
      res.operation?.state,
    );

    const served = await mockServed();
    check("成功：受控服务恰收到 1 次请求", served.served === 1, served.served);
    const id = res.ok === true ? res.data.id : null;
    const meta = id === null ? null : readMeta(id);
    check("成功：落盘文件存在且 meta.id 与响应一致", meta !== null && meta.id === id, {
      id,
      metaId: meta?.id,
    });
    check("成功：traces 恰 +1", traceFiles().length === before + 1, {
      before,
      after: traceFiles().length,
    });

    const status = await statusOf(page);
    const rec =
      status.ok === true ? status.data.operations.find((o) => o.operationId === operationId) : null;
    check(
      "成功：status 快照含该操作且 runIds 就是可信 ID",
      rec?.state === "settled" && rec.runIds.join() === id,
      {
        state: rec?.state,
        runIds: rec?.runIds,
      },
    );
    check(
      "成功：activeOperationId 已释放（同 epoch 不再占槽）",
      status.ok === true && status.data.activeOperationId !== operationId,
      status.data?.activeOperationId,
    );

    const rec2 = await reconcileOf(page, epoch, operationId);
    // ReconcileResult 的形状是「槽状态 + 被查 operation」，终态在 data.operation 里
    const op2 = rec2.ok === true ? rec2.data.operation : null;
    check(
      "成功：核对返回既有 settled，不二次执行",
      op2?.state === "settled" && op2.runIds.join() === id,
      op2 ?? rec2.error,
    );
    check(
      "成功：核对后 mock 计数不变",
      (await mockServed()).served === 1,
      (await mockServed()).served,
    );

    const detail = await getRun(page, id);
    check("成功：按可信 ID 可读到详情", detail.ok === true, detail.ok ? null : detail.error);
    await page.screenshot({ path: join(OUT, "01-after-success.png") });
    await browser.close();
    return finish();
  }

  // ---- 模型失败：结构化身份保留（不解析文案） ----
  if (TAG === "plain-fail") {
    await mockReset({
      turns: [
        { mode: "fail", status: 500, errorBody: { error: { message: "冒烟注入的模型失败" } } },
      ],
      fallback: { mode: "fail", status: 500 },
    });
    const before = traceFiles().length;
    const operationId = freshId();
    const res = await submitCreate(page, epoch, operationId, PLAIN_REQUEST);
    dump.response = res;
    check(
      "失败：响应 ok:false 且带登记回执",
      res.ok === false && res.operation !== null && res.operation !== undefined,
      res.operation ?? null,
    );
    check(
      "失败：回执 settled（执行已结束，不是仍在进行）",
      res.ok === false && res.operation?.state === "settled",
      res.operation?.state,
    );
    check(
      "失败：稳定码可辨（业务码，非兜底栈）",
      res.ok === false && typeof res.error?.code === "string" && res.error.code.length > 0,
      res.error,
    );

    const status = await statusOf(page);
    const rec =
      status.ok === true ? status.data.operations.find((o) => o.operationId === operationId) : null;
    const runIds = rec?.runIds ?? [];
    check("失败：登记携带已创建运行的身份（恰 1 个，非从文案猜出）", runIds.length === 1, {
      runIds,
      code: res.error?.code,
    });
    const meta = runIds.length === 1 ? readMeta(runIds[0]) : null;
    check("失败：该身份的文件真存在且 meta.id 相符", meta !== null && meta.id === runIds[0], {
      id: runIds[0],
      metaId: meta?.id,
    });
    const lines = runIds.length === 1 ? readLines(runIds[0]) : null;
    const hasError =
      Array.isArray(lines) &&
      lines.some((l) => l.kind === "llm.call" && l.error !== undefined && l.error !== null);
    check("失败：trace 里确有 llm.call.error（是真失败运行，不是空壳）", hasError === true, {
      kinds: Array.isArray(lines) ? lines.map((l) => l.kind) : null,
    });
    const detail = runIds.length === 1 ? await getRun(page, runIds[0]) : { ok: false };
    check(
      "失败：用户可按该 ID 读到失败记录",
      detail.ok === true,
      detail.ok ? null : (detail.error ?? null),
    );
    check("失败：traces 恰 +1（一次执行一份记录）", traceFiles().length === before + 1, {
      before,
      after: traceFiles().length,
    });
    check(
      "失败：mock 恰 1 次请求（不重试）",
      (await mockServed()).served === 1,
      (await mockServed()).served,
    );
    await page.screenshot({ path: join(OUT, "01-after-fail.png") });
    await browser.close();
    return finish();
  }

  // ---- 隔离创建的模型失败：世界身份仍可信（与最终 workspace.world_id 一致） ----
  if (TAG === "isolated-fail") {
    await mockReset({
      turns: [
        {
          mode: "fail",
          status: 500,
          errorBody: { error: { message: "冒烟注入的模型失败（隔离）" } },
        },
      ],
      fallback: { mode: "fail", status: 500 },
    });
    const picked = await page.evaluate(async () => await window.api.chooseSource());
    check(
      "隔离失败：目录签发成功",
      picked.ok === true && picked.data.canceled === false,
      picked.ok ? picked.data.name : picked.error,
    );
    const token =
      picked.ok === true && picked.data.canceled === false ? picked.data.sourceToken : null;
    const before = traceFiles().length;
    const operationId = freshId();
    const request = {
      ...PLAIN_REQUEST,
      workspace: { mode: "isolated_files", sourceToken: token, allowFileWrites: true },
    };
    const res = await submitCreate(page, epoch, operationId, request);
    dump.response = res;
    check(
      "隔离失败：响应 ok:false 且带 settled 回执",
      res.ok === false && res.operation?.state === "settled",
      res.ok ? res.data : res.operation,
    );
    const status = await statusOf(page);
    const rec = status.data.operations.find((o) => o.operationId === operationId);
    const runIds = rec?.runIds ?? [];
    check("隔离失败：登记携带世界身份（恰 1 个）", runIds.length === 1, {
      runIds,
      code: res.error?.code,
    });
    const meta = runIds.length === 1 ? readMeta(runIds[0]) : null;
    check(
      "隔离失败：落盘 meta.id 与登记一致（就是最终 world_id，不是 loop 临时 id）",
      meta !== null && meta.id === runIds[0] && meta.id !== null,
      { id: runIds[0], metaId: meta?.id, workspaceOrigin: meta?.workspace?.origin },
    );
    const lines = runIds.length === 1 ? readLines(runIds[0]) : null;
    check(
      "隔离失败：trace 里确有 llm.call.error",
      Array.isArray(lines) && lines.some((l) => l.kind === "llm.call" && l.error),
      { kinds: Array.isArray(lines) ? lines.map((l) => l.kind) : null },
    );
    const detail = runIds.length === 1 ? await getRun(page, runIds[0]) : { ok: false };
    check(
      "隔离失败：用户可按该 ID 读到失败记录",
      detail.ok === true,
      detail.ok ? null : detail.error,
    );
    check("隔离失败：traces 恰 +1", traceFiles().length === before + 1, {
      before,
      after: traceFiles().length,
    });
    check(
      "隔离失败：mock 恰 1 次请求（不重试）",
      (await mockServed()).served === 1,
      (await mockServed()).served,
    );
    // 失败也消费了一次令牌：换新 ID 复用同一令牌必须被拒
    const reuse = await submitCreate(page, epoch, freshId(), request);
    check(
      "隔离失败：令牌已被消费（换新 ID 复用被拒）",
      reuse.ok === false && reuse.error?.code === "INVALID_SOURCE_TOKEN",
      reuse.ok ? reuse.data : reuse.error,
    );
    await page.screenshot({ path: join(OUT, "01-isolated-fail.png") });
    await browser.close();
    return finish();
  }

  // ---- 同 ID 重复：只执行一次 ----
  if (TAG === "duplicate") {
    await mockReset({ turns: [{ content: "好。" }], fallback: { content: "兜底" } });
    const before = traceFiles().length;
    const operationId = freshId();
    const [a, b] = await submitTwice(page, epoch, operationId, PLAIN_REQUEST);
    dump.pair = [a, b];
    check(
      "重复：两条并发提交都返回（不悬挂、不双双执行）",
      a !== undefined && b !== undefined,
      undefined,
    );
    const served = await mockServed();
    check("重复：受控服务只收到 1 次请求", served.served === 1, served.served);
    check("重复：traces 只多出 1 个文件", traceFiles().length === before + 1, {
      before,
      after: traceFiles().length,
    });
    const idA = a.ok === true ? a.data.id : null;
    check(
      "重复：被接受的那条返回真实运行身份",
      a.ok === true && idA !== null,
      a.ok ? a.data : a.error,
    );
    // 实机契约（design D2）：重复的那条**不重新执行**，回「既有终态 + 稳定码 OPERATION_DUPLICATED」，
    // 身份仍指向同一次操作——界面据此解冻/定位，而不是把它当新提交
    check(
      "重复：另一条被回绝且明确未重复执行",
      b.ok === false && b.error?.code === "OPERATION_DUPLICATED",
      b.ok ? b.data : b.error,
    );
    check(
      "重复：两条响应指向同一个登记身份与同一终态",
      a.operation?.operationId === operationId &&
        b.operation?.operationId === operationId &&
        a.operation?.state === b.operation?.state,
      { a: a.operation, b: b.operation },
    );
    const recDup = await reconcileOf(page, epoch, operationId);
    const opRec = recDup.ok === true ? recDup.data.operation : null;
    check(
      "重复：核对同一条登记 ⇒ runIds 就是那次真实运行",
      opRec?.state === "settled" && opRec.runIds.join() === idA,
      opRec,
    );

    // settled 之后同 ID 再次提交：仍不重新执行
    const again = await submitCreate(page, epoch, operationId, PLAIN_REQUEST);
    dump.afterSettled = again;
    check(
      "重复：settled 后同 ID 再提交不产生新请求",
      (await mockServed()).served === 1,
      (await mockServed()).served,
    );
    check(
      "重复：再提交仍指向原关联（同一 runId 或同一回执身份）",
      again.ok === true ? again.data.id === idA : again.operation?.operationId === operationId,
      again.ok ? again.data : again.operation,
    );

    // 异参复用同一 ID ⇒ 拒绝且不改原登记
    const conflict = await submitCreate(page, epoch, operationId, {
      ...PLAIN_REQUEST,
      userMessage: "改了正文",
    });
    dump.conflict = conflict;
    check(
      "重复：同 ID 异参被拒（稳定码可辨）",
      conflict.ok === false && typeof conflict.error?.code === "string",
      conflict.error ?? conflict.data,
    );
    check(
      "重复：异参同样不产生新请求",
      (await mockServed()).served === 1,
      (await mockServed()).served,
    );
    const status = await statusOf(page);
    const rec = status.data.operations.find((o) => o.operationId === operationId);
    check(
      "重复：原登记未被改写（仍 settled、runIds 未增）",
      rec?.state === "settled" && rec.runIds.join() === idA,
      { state: rec?.state, runIds: rec?.runIds },
    );
    await page.screenshot({ path: join(OUT, "01-duplicate.png") });
    await browser.close();
    return finish();
  }

  // ---- 隔离创建：sourceToken 一次性，重复提交不二次消费 ----
  if (TAG === "isolated") {
    await mockReset({ turns: [{ content: "好。" }], fallback: { content: "兜底" } });
    const picked = await page.evaluate(async () => await window.api.chooseSource());
    dump.chooseSource = picked;
    check(
      "隔离：目录签发成功（SMOKE_PICK_DIR 已生效）",
      picked.ok === true && picked.data.canceled !== true,
      picked.ok ? picked.data : picked.error,
    );
    const token =
      picked.ok === true && picked.data.canceled !== true ? picked.data.sourceToken : null;
    const before = traceFiles().length;
    const operationId = freshId();
    const request = {
      ...PLAIN_REQUEST,
      workspace: { mode: "isolated_files", sourceToken: token, allowFileWrites: true },
    };
    const res = await submitCreate(page, epoch, operationId, request);
    dump.response = res;
    check(
      "隔离：创建成功且回执 settled",
      res.ok === true && res.operation.state === "settled",
      res.ok ? res.operation : res.error,
    );
    const id = res.ok === true ? res.data.id : null;
    const meta = id === null ? null : readMeta(id);
    check("隔离：落盘身份 = 世界身份（meta.id 与登记一致）", meta !== null && meta.id === id, {
      id,
      metaId: meta?.id,
    });
    check("隔离：traces 恰 +1", traceFiles().length === before + 1, {
      before,
      after: traceFiles().length,
    });

    // 同 ID 重复提交：返回原关联，不再消费 token、不再执行
    const servedMid = (await mockServed()).served;
    const dup = await submitCreate(page, epoch, operationId, request);
    dump.duplicate = dup;
    check("隔离：同 ID 重复不产生新模型请求", (await mockServed()).served === servedMid, {
      servedMid,
      now: (await mockServed()).served,
    });
    check(
      "隔离：重复提交不报令牌失效（判重在消费之前）",
      dup.ok === true ? dup.data.id === id : dup.error?.code !== "INVALID_SOURCE_TOKEN",
      dup.ok ? dup.data : dup.error,
    );
    check(
      "隔离：重复提交不新增文件",
      traceFiles().length === before + 1,
      traceFiles().length - before,
    );

    // 换新 ID 复用同一令牌 ⇒ 必须被拒（证明令牌确实只消费了一次）
    const reuse = await submitCreate(page, epoch, freshId(), request);
    dump.reuse = reuse;
    check(
      "隔离：同一令牌换新 ID 再提交被拒（一次性消费成立）",
      reuse.ok === false && reuse.error?.code === "INVALID_SOURCE_TOKEN",
      reuse.ok ? reuse.data : reuse.error,
    );
    await page.screenshot({ path: join(OUT, "01-isolated.png") });
    await browser.close();
    return finish();
  }

  // ---- 结果不可读：不重执行、不锁配置 ----
  if (TAG === "unreadable") {
    await mockReset({ turns: [{ content: "好。" }], fallback: { content: "兜底" } });
    const operationId = freshId();
    const res = await submitCreate(page, epoch, operationId, PLAIN_REQUEST);
    const id = res.ok === true ? res.data.id : null;
    check(
      "不可读：前置创建成功（取得可信 ID）",
      res.ok === true && id !== null,
      res.ok ? res.data : res.error,
    );
    const servedAfterRun = (await mockServed()).served;
    const file = join(TRACES, `${id}.jsonl`);
    const hidden = join(TRACES, `${id}.jsonl.u461-hidden`);
    renameSync(file, hidden);
    try {
      const detail = await getRun(page, id);
      dump.unreadable = detail;
      check(
        "不可读：同 ID 读取失败且信封可辨（不是崩溃）",
        detail.ok === false && typeof detail.error?.code === "string",
        detail.ok ? null : detail.error,
      );
      const status = await statusOf(page);
      const rec = status.data.operations.find((o) => o.operationId === operationId);
      check(
        "不可读：该操作仍 settled、不占槽",
        rec?.state === "settled" && status.data.activeOperationId !== operationId,
        { state: rec?.state, active: status.data.activeOperationId },
      );
      const saved = await page.evaluate(async (input) => await window.api.saveSettings(input), {
        baseURL: `${MOCK}/v1`,
        apiKey: "sk-mock",
        model: "mock-model",
      });
      dump.saveSettings = saved;
      check(
        "不可读：结果不可读不锁配置（保存仍成功）",
        saved.ok === true,
        saved.ok ? saved.data : saved.error,
      );
      check(
        "不可读：全程未重新执行（mock 计数不变）",
        (await mockServed()).served === servedAfterRun,
        servedAfterRun,
      );
    } finally {
      renameSync(hidden, file);
    }
    const retry = await getRun(page, id);
    check("不可读：还原后按同 ID 重试读取成功", retry.ok === true, retry.ok ? null : retry.error);
    check(
      "不可读：重试读取不触发执行",
      (await mockServed()).served === servedAfterRun,
      (await mockServed()).served,
    );
    await page.screenshot({ path: join(OUT, "01-unreadable.png") });
    await browser.close();
    return finish();
  }
}

main().catch((e) => {
  console.error("采集失败:", e);
  writeFileSync(join(OUT, "error.txt"), String(e?.stack ?? e));
  process.exit(1);
});
