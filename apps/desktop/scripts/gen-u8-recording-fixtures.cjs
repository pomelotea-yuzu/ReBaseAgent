/**
 * 生成 U8（unify-recording-and-experiment-workspaces）任务 6.2 的「实验/messages 标本」组。
 *
 * 6.2 的要求（tasks.md）：
 *   准备自洽 JSONL 实验完整/部分失败/缺臂/ownOnly/非法标本与 messages 凭据/写入失败 mock，
 *   逐份读取确认不被前置校验意外拒绝（对应「成功臂集合不隐去失败臂」「主动重发结果不借被动记录」）。
 *
 * ── 与 U7 标本（u7-compare）的分工 ───────────────────────────────
 *   U7 6.2 的手工实验臂 u7c_ea/u7c_eb 是**不自洽**的（首请求 params 与
 *   fork.edit.value 不一致 ⇒ 真实 gate 判 REQUEST_PARAMS_MISMATCH，U7 6.7 实证
 *   并登记为「标本现实性缺口」）。本组交付**自洽**臂：首请求 model/params 与
 *   编辑值逐字一致（experiment-records.ts findModelParamsRecordViolation 的
 *   4 号判据），供 U8 6.9「合法结果进入 U7」直接呈现 eligible。
 *   U7 已有的形状不重复：异父同标签可复用 u7g_p1、缺 hash 可复用 u7g_n1。
 *
 * ── 标本清单 ────────────────────────────────────────────────────
 *   组 A 完整成功批：u8e_p1 父 + u8e_a1 / u8e_a2 两臂（exp_u8_full，自洽 eligible）
 *   组 B 部分失败批：u8e_p2 父 + u8e_b1 成功臂 + u8e_b2 失败臂（exp_u8_partial；
 *         失败臂 = llm.call 顶层 error + errored/error 终态 + 占位零用量——
 *         「成功臂集合不隐去失败臂」的数据侧形状）
 *   组 C ownOnly 臂：u8e_p3 父 + u8e_o1 臂（exp_u8_orphan）。⚠️ 实机注入方式 =
 *         **只拷 u8e_o1**（u8e_p3 留在 fixtures 不进 traces）⇒ parent 指向缺席文件
 *         ⇒ ownOnly/CHAIN_INCOMPLETE；u8e_p3 同时是组 D 的异父父本。
 *   组 D 异父同标签：u8e_x1 臂（parent=u8e_p3、experimentId=exp_u8_full 与组 A 同标签）
 *         ⇒ 与 u8e_a1 同选 ⇒ PARENT_DIFFERS（experimentId 不能豁免异父）。
 *   组 E 非法：broken/u8e_broken.jsonl（合法 meta + 损坏尾行 ⇒ 读取被拒对照）。
 *   messages 侧「凭据/写入失败 mock」不是文件标本而是受控编排手法（⇒ MANIFEST
 *   「mock 手法」节，6.9 批次按此引用）：凭据序列靠 keyStore 真实状态
 *   （批首新 dev = 未捕获；真实请求后 hasKey=true；toggle(false) 后
 *   hasKey=true/running=false =「停用代理仍有凭据」）；写入失败 = proxy:fork
 *   在飞（受控 upstream 带 delayMs）期间 rename traces 目录 ⇒ recorder.write
 *   抛 ⇒ PROXY_RECORDING_WRITE_FAILED（不借被动记录的实机面）。
 *
 * ── 诚实边界 ────────────────────────────────────────────────────
 *   ① 手工标本 config_hash 为占位值：满足「已记录且相等」的 gate 比较，
 *      不可作为 replay 分叉父本（U7 6.2 同款边界）；
 *   ② 手工标本**没有** main 的 operation 登记 ⇒ 结果区（deriveExperimentBatches
 *      按登记派生）不显示这些批次——「成功臂集合不隐去失败臂」的结果区实机
 *      主路径是 6.8 受控真实执行；本组供比较门禁/打开结果/读取呈现与失败形状对照；
 *   ③ 固定时间常量 ⇒ 逐字节可重复；本任务只保证「标本条件确实成立」。
 *
 * 用法：node scripts/gen-u8-recording-fixtures.cjs [目标目录]
 * 默认目标目录 = apps/desktop/test/fixtures/u8-recording（入库，批次按 MANIFEST 注入）
 */
"use strict";

const { mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const DEFAULT_DIR = join(REPO_ROOT, "apps", "desktop", "test", "fixtures", "u8-recording");

const MODEL = "deepseek-chat";
const REASONER = "deepseek-reasoner";
const SYSTEM_PROMPT = "你是通用文件助手。";
const U8_HASH = "sha256:u8rec0000000000000000000000000000000000000000000000000000000000";
/** 固定时间常量 ⇒ 手工组逐字节可重复 */
const T0 = Date.parse("2026-10-01T12:00:00.000Z");

function iso(ms) {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// 手工行写入器（与 gen-u7-compare-fixtures 同构）
// ---------------------------------------------------------------------------

function createWriter() {
  const lines = [];
  return {
    meta(meta) {
      lines.push({ type: "run.meta", ...meta });
    },
    step(id, n, startMs, endMs) {
      lines.push({
        type: "span",
        id,
        parent: null,
        timing: { started_at: iso(startMs), ended_at: iso(endMs) },
        kind: "agent.step",
        n,
      });
      return id;
    },
    llm(id, parent, startMs, endMs, request, response, error) {
      const line = {
        type: "span",
        id,
        parent,
        timing: { started_at: iso(startMs), ended_at: iso(endMs) },
        kind: "llm.call",
        request,
        response,
      };
      // error 是 span 顶层字段（U7 6.7 实测口径：不是 response.error）
      if (error !== undefined) line.error = error;
      lines.push(line);
      return id;
    },
    event(event, reason, at) {
      lines.push({ type: "run.event", event, reason, at });
    },
    text() {
      return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
    },
  };
}

function resp(content, usage) {
  return {
    content,
    reasoning_content: null,
    tool_calls: [],
    usage,
    ttft_ms: 100,
  };
}

/** 纯对话父本（满足 V3b 门禁形状：字符串 system + config_hash；无工具表） */
function fixtureParent(id, task, whenMs, params) {
  const w = createWriter();
  w.meta({
    id,
    format_version: 1,
    task,
    model: MODEL,
    created_at: iso(whenMs),
    parent: null,
    fork: null,
    config_hash: U8_HASH,
  });
  const s1 = w.step("s_01", 1, whenMs, whenMs + 1500);
  const request = {
    model: MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "解释这段代码的作用" },
    ],
  };
  if (params !== undefined) request.params = params;
  w.llm("s_02", s1, whenMs, whenMs + 1300, request, resp("父本基线回答。", { in: 800, out: 30 }));
  w.event("stopped", "completed", 1);
  return w.text();
}

/**
 * 自洽实验臂：fork.edit.value（model/params/experimentId）与首请求逐字一致
 * （findModelParamsRecordViolation 4 号判据：整体覆盖语义）。
 */
function fixtureArm({ id, parentId, model, params, experimentId, content, whenMs, outcome }) {
  const w = createWriter();
  w.meta({
    id,
    format_version: 1,
    task: "U8 实验父：解释这段代码的作用",
    model,
    created_at: iso(whenMs),
    parent: parentId,
    fork: {
      at_span: "s_01",
      edit: {
        field: "model_params",
        value: { model, params, experimentId },
      },
    },
    config_hash: U8_HASH,
  });
  const s1 = w.step("s_01", 1, whenMs, whenMs + 1300);
  const request = {
    model,
    params,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "解释这段代码的作用" },
    ],
  };
  if (outcome === "failed") {
    // 失败臂：占位零用量（不得解释为实际零消费）+ 顶层 error + errored 终态
    w.llm("s_02", s1, whenMs, whenMs + 900, request, resp(null, { in: 0, out: 0 }), {
      message: "LLM 端点返回 HTTP 503：upstream unavailable",
      status: 503,
    });
    w.event("errored", "error", 1);
  } else {
    w.llm("s_02", s1, whenMs, whenMs + 1100, request, resp(content, { in: 820, out: 35 }));
    w.event("stopped", "completed", 1);
  }
  return w.text();
}

/** 非法标本：合法 meta + 损坏尾行（读取被拒对照——不是「合法但奇怪」的 run） */
function fixtureBroken() {
  const w = createWriter();
  w.meta({
    id: "u8e_broken",
    format_version: 1,
    task: "U8 非法标本",
    model: MODEL,
    created_at: iso(T0 + 600_000),
    parent: null,
    fork: null,
    config_hash: U8_HASH,
  });
  const base = w.text().replace(/\n$/, "");
  return `${base}\n{ 这不是合法 JSON 行\n`;
}

function main() {
  const outDir = process.argv[2] === undefined ? DEFAULT_DIR : resolve(process.argv[2]);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "traces"), { recursive: true });
  mkdirSync(join(outDir, "broken"), { recursive: true });

  const files = {
    // 组 A 完整成功批（exp_u8_full）
    "u8e_p1.jsonl": fixtureParent("u8e_p1", "U8 实验父 A：解释这段代码的作用", T0, {
      temperature: 0.5,
    }),
    "u8e_a1.jsonl": fixtureArm({
      id: "u8e_a1",
      parentId: "u8e_p1",
      model: MODEL,
      params: { temperature: 0.2 },
      experimentId: "exp_u8_full",
      content: "A1 臂回答（chat，temperature 0.2）。",
      whenMs: T0 + 60_000,
    }),
    "u8e_a2.jsonl": fixtureArm({
      id: "u8e_a2",
      parentId: "u8e_p1",
      model: REASONER,
      params: { temperature: 0.8 },
      experimentId: "exp_u8_full",
      content: "A2 臂回答（reasoner，temperature 0.8）。",
      whenMs: T0 + 120_000,
    }),
    // 组 B 部分失败批（exp_u8_partial）：b2 失败 ⇒ 登记若在场时「ids 只含成功臂」的数据侧对照
    "u8e_p2.jsonl": fixtureParent("u8e_p2", "U8 实验父 B：解释这段代码的作用", T0 + 200_000, {
      temperature: 0.5,
    }),
    "u8e_b1.jsonl": fixtureArm({
      id: "u8e_b1",
      parentId: "u8e_p2",
      model: MODEL,
      params: { temperature: 0.3 },
      experimentId: "exp_u8_partial",
      content: "B1 臂回答（成功）。",
      whenMs: T0 + 260_000,
    }),
    "u8e_b2.jsonl": fixtureArm({
      id: "u8e_b2",
      parentId: "u8e_p2",
      model: REASONER,
      params: { temperature: 0.9 },
      experimentId: "exp_u8_partial",
      content: null,
      whenMs: T0 + 320_000,
      outcome: "failed",
    }),
    // 组 C ownOnly 臂（实机注入方式 = 只拷 o1 不拷 p3 ⇒ parent 缺席）
    "u8e_p3.jsonl": fixtureParent("u8e_p3", "U8 实验父 C：解释这段代码的作用", T0 + 400_000, {
      temperature: 0.5,
    }),
    "u8e_o1.jsonl": fixtureArm({
      id: "u8e_o1",
      parentId: "u8e_p3",
      model: MODEL,
      params: { temperature: 0.4 },
      experimentId: "exp_u8_orphan",
      content: "O1 臂回答（ownOnly 注入形态）。",
      whenMs: T0 + 460_000,
    }),
    // 组 D 异父同标签（parent=p3，experimentId 与组 A 同 ⇒ 与 a1 同选 PARENT_DIFFERS）
    "u8e_x1.jsonl": fixtureArm({
      id: "u8e_x1",
      parentId: "u8e_p3",
      model: REASONER,
      params: { temperature: 0.7 },
      experimentId: "exp_u8_full",
      content: "X1 臂回答（异父同标签）。",
      whenMs: T0 + 520_000,
    }),
    // 组 E 非法（读取被拒对照）
    "broken/u8e_broken.jsonl": fixtureBroken(),
  };
  for (const [name, text] of Object.entries(files)) {
    // broken/ 前缀落 broken 子目录（读取被拒对照不进 traces，避免被当成合法标本注入）
    const target = name.startsWith("broken/") ? join(outDir, name) : join(outDir, "traces", name);
    writeFileSync(target, text, "utf8");
  }

  const manifest = {
    生成器: "apps/desktop/scripts/gen-u8-recording-fixtures.cjs",
    说明: "U8 6.2 实验标本。实机批次注入：把 traces/ 内点名的 u8e_*.jsonl 拷入数据目录 traces/（组 C 只拷 u8e_o1，u8e_p3 留在 fixtures ⇒ ownOnly）；批次结束按本清单文件名清除，生产数据目录内既有文件不碰。手工标本无 main 操作登记 ⇒ 结果区不显示，比较门禁/打开结果/读取呈现按本组验证；结果区「成功臂集合不隐去失败臂」的主路径 = 6.8 受控真实执行。",
    手工文件: Object.keys(files).sort(),
    关系: {
      组A_完整成功批: { 父: "u8e_p1", 臂: ["u8e_a1", "u8e_a2"], experimentId: "exp_u8_full" },
      组B_部分失败批: {
        父: "u8e_p2",
        成功臂: "u8e_b1",
        失败臂: "u8e_b2（errored/error + 顶层 llm.call.error + 占位零用量）",
        experimentId: "exp_u8_partial",
      },
      组C_ownOnly: { 父: "u8e_p3（注入时缺席）", 臂: "u8e_o1", experimentId: "exp_u8_orphan" },
      组D_异父同标签: { 臂: "u8e_x1（parent=u8e_p3）", experimentId: "exp_u8_full" },
      组E_非法: "broken/u8e_broken.jsonl（读取被拒对照）",
    },
    自洽口径:
      "全部臂首请求 model/params 与 fork.edit.value 逐字一致（整体覆盖语义，experiment-records findModelParamsRecordViolation 4 号判据）；config_hash 臂父同值（占位 hash 只满足「已记录且相等」，不可作 replay 父本）；无工具表 ⇒ 副作用判据不触发。",
    messages_mock_手法: {
      凭据: "批首新 dev 会话 keyStore 空 =「未捕获 key」；受控 upstream 真实请求一场 ⇒ hasKey=true；toggle(false) ⇒ hasKey=true/running=false =「停用代理仍有凭据不能重发」（顺序即语义）。",
      写入失败:
        "proxy:fork 在飞（受控 upstream 带 delayMs 造窗口）期间把数据目录 traces/ rename 走 ⇒ recorder.write 抛 ⇒ PROXY_RECORDING_WRITE_FAILED（明确失败且不借用被动 run id）。",
      被动交错:
        "重发等待期间受控 upstream 另收一场被动请求 ⇒ 两 run 并存落盘 ⇒ 结果区只呈现登记可信 ID（deriveMessagesResults 按 target 圈定）。",
    },
  };
  writeFileSync(join(outDir, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  process.stdout.write(
    `已生成 ${Object.keys(files).length + 1} 份（${Object.keys(files).length} 标本 + MANIFEST）→ ${outDir}\n`,
  );
}

main();
