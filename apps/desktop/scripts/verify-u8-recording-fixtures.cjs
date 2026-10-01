/**
 * U8 任务 6.2 回查：逐份核验实验标本「条件确实成立」（不被前置校验意外拒绝）。
 *
 * 判据（全部对着真实 trace-sdk 读取，不做纯文本假设）：
 *   V1  traces/*.jsonl 全部可解析（readRun = 前置校验本体）；
 *   V2  broken/ 必须读取失败（损坏尾行）；
 *   V3  关系指向：臂的 parent 指向清单声明的父 id；组内父 trace 在场；
 *   V4  自洽性：每臂 fork.edit.value.model === 首自有 llm.call request.model；
 *       edit.value.params 与 request.params 稳定 JSON 相等（键序无关）；
 *   V5  同源：同组臂与父 config_hash 逐字相等（占位同值）；
 *   V6  批次标签：a1/a2/x1 = exp_u8_full、b1/b2 = exp_u8_partial、o1 = exp_u8_orphan；
 *   V7  失败臂形状：b2 首 llm.call 顶层 error 在场 + 末行 event=errored/error；
 *       成功臂末行 stopped/completed；
 *   V8  MANIFEST 与实际一致（文件清单、关系键）。
 *
 * --selftest：三类注入（篡改臂 params / 篡改 parent / 篡改 MANIFEST 计数）对
 * 临时副本必须全部被抓——否则 V4/V3/V8 是恒绿假判据。
 *
 * 用法：node scripts/verify-u8-recording-fixtures.cjs [--selftest] [目录]
 */
"use strict";

const { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } =
  require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { readRun } = require("@rebaseagent/trace-sdk");

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const DEFAULT_DIR = join(REPO_ROOT, "apps", "desktop", "test", "fixtures", "u8-recording");

const selftest = process.argv.includes("--selftest");
const targetArg = process.argv.slice(2).filter((a) => !a.startsWith("-"))[0];
const baseDir = targetArg === undefined ? DEFAULT_DIR : resolve(targetArg);

const failures = [];
let quiet = false;
function check(name, cond, detail) {
  if (cond) {
    if (!quiet) process.stdout.write(`  ✓ ${name}\n`);
  } else {
    failures.push({ name, detail });
    if (!quiet) process.stderr.write(`  ✗ ${name}${detail === undefined ? "" : ` —— ${detail}`}\n`);
  }
}

/** 键排序的稳定 JSON（与 experiment-records stableJson 同口径：字段有无即差异） */
function stableJson(value) {
  return JSON.stringify(
    (() => {
      const sort = (v) => {
        if (Array.isArray(v)) return v.map(sort);
        if (typeof v === "object" && v !== null) {
          const out = {};
          for (const k of Object.keys(v).sort()) out[k] = sort(v[k]);
          return out;
        }
        return v;
      };
      return sort(value);
    })(),
  );
}

function readMetaSafe(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8").split(/\r?\n/)[0]);
  } catch {
    return null;
  }
}

/** 首自有 llm.call（标本全为自有单步 ⇒ 即首个 llm.call 行） */
function firstLlmCall(record) {
  return record.spans.find((s) => s.kind === "llm.call") ?? null;
}

const EXPECT_PARENT = {
  u8e_a1: "u8e_p1",
  u8e_a2: "u8e_p1",
  u8e_b1: "u8e_p2",
  u8e_b2: "u8e_p2",
  u8e_o1: "u8e_p3",
  u8e_x1: "u8e_p3",
};
const EXPECT_EXPERIMENT = {
  u8e_a1: "exp_u8_full",
  u8e_a2: "exp_u8_full",
  u8e_x1: "exp_u8_full",
  u8e_b1: "exp_u8_partial",
  u8e_b2: "exp_u8_partial",
  u8e_o1: "exp_u8_orphan",
};
const ARMS = ["u8e_a1", "u8e_a2", "u8e_b1", "u8e_b2", "u8e_o1", "u8e_x1"];
const PARENTS = ["u8e_p1", "u8e_p2", "u8e_p3"];

function runChecks(dir) {
  failures.length = 0;
  const tracesDir = join(dir, "traces");
  if (!existsSync(tracesDir)) {
    failures.push({ name: "traces 目录存在", detail: tracesDir });
    return 1;
  }
  const traceFiles = readdirSync(tracesDir)
    .filter((n) => n.endsWith(".jsonl"))
    .sort();

  process.stdout.write(`== V1 手工组可解析（${traceFiles.length} 份）==\n`);
  const records = new Map();
  for (const name of traceFiles) {
    try {
      const record = readRun(join(tracesDir, name));
      records.set(record.meta.id, record);
      check(`解析 ${name}`, record.meta.id !== undefined && record.spans.length >= 2);
    } catch (e) {
      check(`解析 ${name}`, false, e.message);
    }
  }

  process.stdout.write("== V2 broken 组必须读取失败 ==\n");
  const brokenDir = join(dir, "broken");
  for (const name of readdirSync(brokenDir).filter((n) => n.endsWith(".jsonl"))) {
    let threw = false;
    try {
      readRun(join(brokenDir, name));
    } catch {
      threw = true;
    }
    check(`broken/${name} 读取失败`, threw);
  }

  process.stdout.write("== V3 关系指向 ==\n");
  for (const id of PARENTS) {
    check(`${id} 在场`, records.has(id));
  }
  for (const [id, parent] of Object.entries(EXPECT_PARENT)) {
    const rec = records.get(id);
    check(`${id} 存在`, rec !== undefined);
    if (rec === undefined) continue;
    check(`${id}.parent = ${parent}`, rec.meta.parent === parent, `实际 ${rec.meta.parent}`);
  }

  process.stdout.write("== V4 自洽性（臂首请求与编辑值逐字一致）==\n");
  for (const id of ARMS) {
    const rec = records.get(id);
    if (rec === undefined) continue;
    const fork = rec.meta.fork;
    check(`${id} 是 model_params 臂`, fork?.edit?.field === "model_params");
    if (fork?.edit?.field !== "model_params") continue;
    const value = fork.edit.value ?? {};
    const call = firstLlmCall(rec);
    check(`${id} 有自有 llm.call`, call !== null);
    if (call === null) continue;
    check(
      `${id} 首请求 model = 编辑值 model`,
      call.request.model === value.model,
      `请求 ${call.request.model} / 编辑 ${value.model}`,
    );
    // 整体覆盖语义：编辑给了 params ⇒ 与臂请求稳定 JSON 相等（键序无关）
    if (value.params !== undefined) {
      check(
        `${id} 首请求 params = 编辑值 params（整体覆盖）`,
        stableJson(call.request.params ?? null) === stableJson(value.params),
        `请求 ${stableJson(call.request.params ?? null)} / 编辑 ${stableJson(value.params)}`,
      );
    }
  }

  process.stdout.write("== V5 同源（组内 config_hash 相等）==\n");
  for (const [parentId, arms] of [
    ["u8e_p1", ["u8e_a1", "u8e_a2"]],
    ["u8e_p2", ["u8e_b1", "u8e_b2"]],
    ["u8e_p3", ["u8e_o1", "u8e_x1"]],
  ]) {
    const parentHash = records.get(parentId)?.meta.config_hash;
    check(`${parentId} 已记录 config_hash`, typeof parentHash === "string");
    for (const arm of arms) {
      const armHash = records.get(arm)?.meta.config_hash;
      check(
        `${arm} 与 ${parentId} config_hash 相等`,
        armHash === parentHash && armHash !== undefined,
      );
    }
  }

  process.stdout.write("== V6 批次标签 ==\n");
  for (const [id, exp] of Object.entries(EXPECT_EXPERIMENT)) {
    const value = records.get(id)?.meta.fork?.edit?.value ?? {};
    check(`${id}.experimentId = ${exp}`, value.experimentId === exp, `实际 ${value.experimentId}`);
  }

  process.stdout.write("== V7 终态与失败臂形状 ==\n");
  for (const id of [...ARMS, ...PARENTS]) {
    const rec = records.get(id);
    if (rec === undefined) continue;
    const lastEvent = rec.events[rec.events.length - 1];
    if (id === "u8e_b2") {
      const call = firstLlmCall(rec);
      check("u8e_b2 失败调用顶层 error 在场", call !== null && call.error !== undefined);
      check(
        "u8e_b2 终态 = errored/error",
        lastEvent?.event === "errored" && lastEvent?.reason === "error",
        `实际 ${lastEvent?.event}/${lastEvent?.reason}`,
      );
    } else {
      check(
        `${id} 终态 = stopped/completed`,
        lastEvent?.event === "stopped" && lastEvent?.reason === "completed",
        `实际 ${lastEvent?.event}/${lastEvent?.reason}`,
      );
    }
  }

  process.stdout.write("== V8 MANIFEST 一致 ==\n");
  const manifest = JSON.parse(readFileSync(join(dir, "MANIFEST.json"), "utf8"));
  // broken/ 前缀的清单项对 broken/ 目录核验，其余对 traces/ 核验
  const tracesActual = traceFiles.slice().sort();
  const brokenActual = readdirSync(brokenDir)
    .filter((n) => n.endsWith(".jsonl"))
    .sort();
  const listedTraces = manifest.手工文件.filter((n) => !n.startsWith("broken/")).sort();
  const listedBroken = manifest.手工文件
    .filter((n) => n.startsWith("broken/"))
    .map((n) => n.replace(/^broken\//, ""));
  check(
    "MANIFEST 手工文件清单与 traces 实际一致",
    JSON.stringify(tracesActual) === JSON.stringify(listedTraces),
    `实际 ${tracesActual.length} / 清单 ${listedTraces.length}`,
  );
  check(
    "MANIFEST broken 清单与 broken 实际一致",
    JSON.stringify(brokenActual) === JSON.stringify(listedBroken.sort()),
  );
  check(
    "MANIFEST 关系键（组 A/B/C/D/E）在场",
    manifest.关系.组A_完整成功批 !== undefined &&
      manifest.关系.组B_部分失败批 !== undefined &&
      manifest.关系.组C_ownOnly !== undefined &&
      manifest.关系.组D_异父同标签 !== undefined &&
      manifest.关系.组E_非法 !== undefined,
  );

  return failures.length;
}

function runSelftest(dir) {
  quiet = true;
  let caught = 0;
  const tamper = (name, mutate) => {
    const tmp = mkdtempSync(join(tmpdir(), "u8-rec-verify-"));
    try {
      cpSync(dir, tmp, { recursive: true });
      mutate(tmp);
      const n = runChecks(tmp);
      if (n > 0) caught += 1;
      else process.stderr.write(`  ✗ selftest 未抓到注入：${name}（判据恒绿，必须修判据）\n`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  };
  tamper("篡改臂首请求 params（破坏自洽）", (tmp) => {
    const file = join(tmp, "traces", "u8e_a1.jsonl");
    const lines = readFileSync(file, "utf8").split("\n");
    const i = lines.findIndex((l) => l.includes('"kind":"llm.call"'));
    const line = JSON.parse(lines[i]);
    line.request.params = { temperature: 0.99 };
    lines[i] = JSON.stringify(line);
    writeFileSync(file, `${lines.join("\n")}`);
  });
  tamper("篡改臂 parent（破坏关系指向）", (tmp) => {
    const file = join(tmp, "traces", "u8e_x1.jsonl");
    const lines = readFileSync(file, "utf8").split("\n");
    const meta = JSON.parse(lines[0]);
    meta.parent = "u8e_p1";
    lines[0] = JSON.stringify(meta);
    writeFileSync(file, `${lines.join("\n")}`);
  });
  tamper("篡改 MANIFEST 文件清单", (tmp) => {
    const file = join(tmp, "MANIFEST.json");
    const m = JSON.parse(readFileSync(file, "utf8"));
    m.手工文件 = m.手工文件.filter((n) => n !== "u8e_o1.jsonl");
    writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
  });
  quiet = false;
  process.stdout.write(`selftest：三类注入被抓 ${caught}/3\n`);
  // selftest 的成败只看「注入是否全被抓」；tamper 过程中 runChecks 留下的
  // failures 是故意注入的预期产物，不回灌退出码
  failures.length = 0;
  if (caught < 3) {
    failures.push({ name: "selftest 注入全被抓", detail: `${caught}/3` });
  }
  return failures.length;
}

const exitCode = (() => {
  const count = selftest ? runSelftest(baseDir) : runChecks(baseDir);
  process.stdout.write(count === 0 ? "回查通过：0 失败\n" : `回查失败：${count} 条\n`);
  return count === 0 ? 0 : 1;
})();
process.exit(exitCode);
