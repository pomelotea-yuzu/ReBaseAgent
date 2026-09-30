/**
 * U7 任务 6.2 回查：逐条核验比较标本「条件确实成立」。
 *
 * 判据（全部对着真实 trace-sdk 读取，不做纯文本假设）：
 *   V1  手工组 traces/*.jsonl 全部可解析；
 *   V2  broken/ 两条必须读取失败（未来版本 / v1 私带隔离字段）；
 *   V3  链关系：子 run 的 parent 指向存在的 trace 文件；u7c_orphan 的 parent 必须不存在；
 *   V4  三跳 result 链 G→P→C 能被 resolveBranch 真实解析（结构合法），合并视图含
 *       G+P+C 全部 span，leafSpanIds = C 自有 span；S 与 C 同父同编辑点；
 *   V5  兄弟臂 C/S 自有 span id 完全相同（重复 ID 标本）；prompt 两臂亦然（s_01/s_02）；
 *   V6  实验臂 u7c_ea/u7c_eb 的 experimentId 相同；模型符合 A/B 设计；
 *   V7  碰撞四条 task/model/created_at 逐字段相同且 id 互为后缀嵌套；
 *   V8  缓存形态：u7c_l1 部分记录、u7c_l2 零命中、u7c_err 未记录+失败占位；
 *   V9  长文本：u7c_l1/u7c_l2 最终输出 > 10KB 且标记词在场；
 *   V10 隔离组：v2 三跳可解析（format_version=2、workspace world_id=run id、
 *       fork1/fork2 的 parent 与 resume_after_step 就位）；
 *   V11 MANIFEST 与实际一致（文件数、关系键、轨迹边界 id）。
 *
 * --selftest：注入三类损坏（假关系 / 篡改 MANIFEST 计数 / 假 span 存在性）必须全部被抓。
 *
 * 用法：node scripts/verify-u7-compare-fixtures.cjs [--selftest] [目录]
 */
"use strict";

const { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { readRun, resolveBranch } = require("@rebaseagent/trace-sdk");

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const DEFAULT_DIR = join(REPO_ROOT, "apps", "desktop", "test", "fixtures", "u7-compare");

const selftest = process.argv.includes("--selftest");
const dirArg = process.argv.find(
  (a, i) =>
    (i >= 2 && !a.startsWith("-") && a !== process.argv[2]) || (i === 2 && !a.startsWith("-")),
);
const targetArg = process.argv.slice(2).filter((a) => !a.startsWith("-"))[0];
const outDir = targetArg === undefined ? DEFAULT_DIR : resolve(targetArg);
void dirArg;

const failures = [];
/** selftest 对临时副本跑判定时静默（不刷屏），失败仍入 failures */
let quiet = false;
function check(name, cond, detail) {
  if (cond) {
    if (!quiet) process.stdout.write(`  ✓ ${name}\n`);
  } else {
    failures.push({ name, detail });
    if (!quiet) process.stderr.write(`  ✗ ${name}${detail === undefined ? "" : ` —— ${detail}`}\n`);
  }
}

function readMetaSafe(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8").split(/\r?\n/)[0]);
  } catch {
    return null;
  }
}

function runChecks(targetDir) {
  failures.length = 0;
  const outDir = targetDir;
  if (!existsSync(outDir)) {
    failures.push({ name: "标本目录存在", detail: outDir });
    return failures.length;
  }
  const tracesDir = join(outDir, "traces");
  const traceFiles = readdirSync(tracesDir)
    .filter((n) => n.endsWith(".jsonl"))
    .sort();

  if (!quiet) process.stdout.write(`== V1 手工组可解析（${traceFiles.length} 份）==\n`);
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

  if (!quiet) process.stdout.write("== V2 broken 组必须读取失败 ==\n");
  const brokenDir = join(outDir, "broken");
  for (const name of readdirSync(brokenDir).filter((n) => n.endsWith(".jsonl"))) {
    let threw = false;
    try {
      readRun(join(brokenDir, name));
    } catch {
      threw = true;
    }
    check(`broken/${name} 读取失败`, threw);
  }

  if (!quiet) process.stdout.write("== V3 链关系指向 ==\n");
  const expectParents = {
    u7c_p: "u7c_g",
    u7c_c: "u7c_p",
    u7c_s: "u7c_p",
    u7c_pp: null,
    u7c_pc1: "u7c_pp",
    u7c_pc2: "u7c_pp",
    run_u7m1: null,
    run_u7m2: "run_u7m1",
    u7c_ep: null,
    u7c_ea: "u7c_ep",
    u7c_eb: "u7c_ep",
    u7c_orphan: "u7c_gone_missing",
  };
  for (const [id, parent] of Object.entries(expectParents)) {
    const rec = records.get(id);
    check(`${id} 存在`, rec !== undefined);
    if (rec === undefined) continue;
    check(`${id}.parent = ${parent}`, rec.meta.parent === parent, `实际 ${rec.meta.parent}`);
    if (parent !== null && parent !== "u7c_gone_missing") {
      check(`${id} 的父 trace 在场`, records.has(parent));
    }
  }
  check(
    "u7c_orphan 的父文件确实不存在（ownOnly 前提）",
    !existsSync(join(tracesDir, "u7c_gone_missing.jsonl")),
  );

  if (!quiet) process.stdout.write("== V4 三跳 result 链 resolveBranch 实解 ==\n");
  const byId = new Map(["u7c_g", "u7c_p", "u7c_c"].map((id) => [id, records.get(id)]));
  let resolved;
  try {
    resolved = resolveBranch("u7c_c", (id) => {
      const hit = byId.get(id);
      if (hit === undefined) throw new Error(`run ${id} 不在已读取记录中`);
      return hit;
    });
    check("resolveBranch(u7c_c) 成功", true);
  } catch (e) {
    check("resolveBranch(u7c_c) 成功", false, e.message);
  }
  if (resolved !== undefined) {
    const leafOwn = records.get("u7c_c").spans.map((s) => s.id);
    const mergedIds = resolved.spans.map((s) => s.id);
    // v1 语义：前缀 = 截至 fork 点（含该 span）+ 本 run 新增 span。
    // C 的合并视图应为 G[s_01..s_03] + P[s_06..s_08] + C[s_11,s_12]；
    // G 的 s_04/s_05、P 的 s_09/s_10 在分叉点之后 ⇒ 按设计被截断。
    check(
      "合并视图含 G 前缀段（s_01..s_03）",
      ["s_01", "s_02", "s_03"].every((id) => mergedIds.includes(id)),
    );
    check(
      "合并视图含 P 前缀段（s_06..s_08）",
      ["s_06", "s_07", "s_08"].every((id) => mergedIds.includes(id)),
    );
    check(
      "分叉点之后的祖先 span 按设计截断",
      !["s_04", "s_05", "s_09", "s_10"].some((id) => mergedIds.includes(id)),
    );
    check(
      "leafSpanIds = C 自有 span（s_11/s_12）",
      JSON.stringify(leafOwn) === JSON.stringify(["s_11", "s_12"]),
      JSON.stringify(leafOwn),
    );
    check(
      "两个编辑点（s_03/s_08）都在合并视图且为 tool.invoke",
      resolved.spans
        .filter((s) => s.id === "s_03" || s.id === "s_08")
        .every((s) => s.kind === "tool.invoke"),
    );
    const s08 = resolved.spans.find((s) => s.id === "s_08");
    check(
      "C 的编辑原值 = P.s_08 工具结果",
      s08 !== undefined && s08.result === "P 工具结果：summary 已写入 v1",
    );
  }

  if (!quiet) process.stdout.write("== V5 重复 span id 标本 ==\n");
  const ownIds = (id) => records.get(id).spans.map((s) => s.id);
  check(
    "兄弟臂 C/S 自有 span id 完全相同",
    JSON.stringify(ownIds("u7c_c")) === JSON.stringify(ownIds("u7c_s")),
    `${JSON.stringify(ownIds("u7c_c"))} vs ${JSON.stringify(ownIds("u7c_s"))}`,
  );
  check(
    "prompt 两臂自有 span id 完全相同（s_01/s_02）",
    JSON.stringify(ownIds("u7c_pc1")) === JSON.stringify(ownIds("u7c_pc2")),
  );
  check("prompt 臂从 s_01 重编（独立执行）", ownIds("u7c_pc1")[0] === "s_01");

  if (!quiet) process.stdout.write("== V6 实验臂 ==\n");
  const ea = records.get("u7c_ea");
  const eb = records.get("u7c_eb");
  const expOf = (r) => r.meta.fork?.edit?.value?.experimentId;
  check("A/B 臂 experimentId 相同", expOf(ea) === expOf(eb) && expOf(ea) === "exp_u7_ab");
  check("A 臂同模型", ea.meta.model === "deepseek-chat");
  check("B 臂换模型", eb.meta.model === "deepseek-reasoner");

  if (!quiet) process.stdout.write("== V7 短 ID 碰撞四条 ==\n");
  const ids = ["qqq7777aabbccdd", "ppp7777aabbccdd", "ooo7777aabbccdd", "7777aabbccdd"];
  const colRecs = ids.map((id) => records.get(id));
  check(
    "四条全部在场",
    colRecs.every((r) => r !== undefined),
  );
  if (colRecs.every((r) => r !== undefined)) {
    const task = new Set(colRecs.map((r) => r.meta.task));
    const model = new Set(colRecs.map((r) => r.meta.model));
    const created = new Set(colRecs.map((r) => r.meta.created_at));
    check("同任务", task.size === 1);
    check("同模型", model.size === 1);
    check("同 created_at", created.size === 1);
    const short = "aabbccdd";
    check(
      "后 8 位相同",
      ids.every((id) => id.endsWith(short)),
    );
    check(
      "7777aabbccdd 是其余三条的后缀",
      ids.slice(0, 3).every((id) => id.endsWith("7777aabbccdd")),
    );
  }

  if (!quiet) process.stdout.write("== V8 缓存形态 ==\n");
  const usageOf = (id) =>
    records
      .get(id)
      .spans.filter((s) => s.kind === "llm.call")
      .map((s) => s.response.usage);
  const l1 = usageOf("u7c_g");
  check(
    "u7c_g 部分记录（call1 有 cache_hit、call2 无字段）",
    l1.length === 2 && l1[0].cache_hit === 800 && l1[1].cache_hit === undefined,
  );
  const l1u = usageOf("u7c_l1");
  check(
    "u7c_l1 部分记录（call1 无字段、call2 cache_hit=512）",
    l1u.length === 2 && l1u[0].cache_hit === undefined && l1u[1].cache_hit === 512,
  );
  const l2u = usageOf("u7c_l2");
  check(
    "u7c_l2 零命中（两次 cache_hit=0）",
    l2u.length === 2 && l2u[0].cache_hit === 0 && l2u[1].cache_hit === 0,
  );
  const errCalls = records.get("u7c_err").spans.filter((s) => s.kind === "llm.call");
  const lastErr = errCalls[errCalls.length - 1];
  check(
    "u7c_err 失败占位（末次调用零用量 + error + 无 cache_hit）",
    lastErr !== undefined &&
      lastErr.response.usage.in === 0 &&
      lastErr.response.usage.out === 0 &&
      lastErr.response.usage.cache_hit === undefined &&
      lastErr.error !== undefined,
  );

  if (!quiet) process.stdout.write("== V9 长文本 ==\n");
  const outputsOf = (id) =>
    records
      .get(id)
      .spans.filter((s) => s.kind === "llm.call")
      .map((s) => s.response.content ?? "");
  for (const [id, firstMarker, lastMarker] of [
    ["u7c_l1", "金苹果", "银钥匙"],
    ["u7c_l2", "铜罗盘", "铁齿轮"],
  ]) {
    const outputs = outputsOf(id);
    const last = outputs[outputs.length - 1] ?? "";
    check(
      `${id} 末次输出 > 10KB（比较/diff 的实际正文）`,
      last.length > 10 * 1024,
      `${last.length} chars`,
    );
    check(`${id} 首次调用含标记词 ${firstMarker}`, (outputs[0] ?? "").includes(firstMarker));
    check(`${id} 末次调用含标记词 ${lastMarker}`, last.includes(lastMarker));
  }

  if (!quiet) process.stdout.write("== V10 隔离组（真实引擎 v2）==\n");
  const isoDir = join(outDir, "isolated-traces");
  const isoFiles = readdirSync(isoDir).filter((n) => n.endsWith(".jsonl"));
  const isoRecs = new Map();
  for (const name of isoFiles) {
    try {
      const rec = readRun(join(isoDir, name));
      isoRecs.set(rec.meta.id, rec);
    } catch (e) {
      check(`解析 isolated-traces/${name}`, false, e.message);
    }
  }
  check("隔离组恰好 3 条", isoRecs.size === 3, `实际 ${isoRecs.size}`);
  const [root, fork1, fork2] = [...isoRecs.values()].sort((a, b) =>
    a.meta.created_at < b.meta.created_at ? -1 : 1,
  );
  if (isoRecs.size === 3) {
    check(
      "root v2 + workspace world_id = run id",
      root.meta.format_version === 2 && root.meta.workspace?.world_id === root.meta.id,
    );
    check("fork1.parent = root", fork1.meta.parent === root.meta.id);
    check("fork2.parent = fork1", fork2.meta.parent === fork1.meta.id);
    check("fork1 带 resume_after_step", typeof fork1.meta.fork?.resume_after_step === "string");
    check("fork2 带 resume_after_step", typeof fork2.meta.fork?.resume_after_step === "string");
    check("fork1 编辑 result", fork1.meta.fork?.edit?.field === "result");
    // v2 编辑点定位：resume_after_step 所指 span 必须是父轨迹里的 agent.step
    const parentSpanIds = new Set(root.spans.map((s) => s.id));
    check(
      "fork1.resume_after_step 指向父轨迹中的 span",
      parentSpanIds.has(fork1.meta.fork.resume_after_step),
    );
  }

  if (!quiet) process.stdout.write("== V11 MANIFEST 一致性 ==\n");
  const manifest = JSON.parse(readFileSync(join(outDir, "MANIFEST.json"), "utf8"));
  check(
    "手工文件数一致",
    manifest.手工文件.length === traceFiles.length,
    `${manifest.手工文件.length} vs ${traceFiles.length}`,
  );
  check("坏版本文件数一致", manifest.坏版本文件.length === 2);
  const relKeys = Object.keys(manifest.关系).sort();
  check(
    "关系键齐备",
    JSON.stringify(relKeys) ===
      JSON.stringify(
        ["model_params", "ownOnly", "三跳result链", "不同根", "prompt", "碰撞组", "proxy"].sort(),
      ),
    relKeys.join(","),
  );
  const boundaryEntries = Object.entries(manifest.轨迹边界);
  check(
    "轨迹边界条数 = 手工 + 隔离",
    boundaryEntries.length === traceFiles.length + 3,
    `${boundaryEntries.length} vs ${traceFiles.length + 3}`,
  );
  for (const [label, entry] of boundaryEntries) {
    const id = typeof entry === "string" ? entry : entry.id;
    const actual = records.get(id)?.meta.id ?? isoRecs.get(id)?.meta.id;
    check(`轨迹边界 ${label} → ${id} 真实在场`, actual === id);
  }

  return failures.length;
}

// ---------------------------------------------------------------------------
// --selftest：对标本目录的**临时副本**做三类真实篡改，全量判定必须红。
// （不是验证判定函数的形状，而是「故意破坏 ⇒ 有效失败」的完整闭环。）
// ---------------------------------------------------------------------------

function copyDirRec(src, dst) {
  const { mkdirSync: mk, readdirSync: rd, statSync: st, copyFileSync } = require("node:fs");
  mk(dst, { recursive: true });
  for (const name of rd(src)) {
    const from = join(src, name);
    const to = join(dst, name);
    if (st(from).isDirectory()) copyDirRec(from, to);
    else copyFileSync(from, to);
  }
}

/** 把 src 目录拷到系统临时目录下的一个新子目录，返回副本路径 */
function makeTempCopy(src, tag) {
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const tmp = mkdtempSync(join(tmpdir(), `u7fix-${tag}-`));
  const dst = join(tmp, "fixture");
  copyDirRec(src, dst);
  return dst;
}

function rewriteFile(file, fn) {
  writeFileSync(file, fn(readFileSync(file, "utf8")), "utf8");
}

function runSelftest() {
  quiet = true;
  const scenarios = [
    {
      tag: "fake-rel",
      label: "① 假关系（prompt 臂 parent 改指 u7c_g）",
      tamper: (dir) =>
        rewriteFile(join(dir, "traces", "u7c_pc1.jsonl"), (text) =>
          text.replace('"parent":"u7c_pp"', '"parent":"u7c_g"'),
        ),
      expectName: "u7c_pc1.parent = u7c_pp",
    },
    {
      tag: "fake-count",
      label: "② 篡改 MANIFEST 手工文件数（多算一条）",
      tamper: (dir) =>
        rewriteFile(join(dir, "MANIFEST.json"), (text) => {
          const m = JSON.parse(text);
          m.手工文件.push("fake_not_exists.jsonl");
          return `${JSON.stringify(m, null, 2)}\n`;
        }),
      expectName: "手工文件数一致",
    },
    {
      tag: "fake-span",
      label: "③ 假 span 身份（C 的 s_11 改成 s_99）",
      tamper: (dir) =>
        rewriteFile(join(dir, "traces", "u7c_c.jsonl"), (text) =>
          text.replace('"id":"s_11"', '"id":"s_99"'),
        ),
      expectName: "leafSpanIds = C 自有 span（s_11/s_12）",
    },
  ];

  let allCaught = true;
  for (const scenario of scenarios) {
    const copy = makeTempCopy(outDir, scenario.tag);
    try {
      scenario.tamper(copy);
      runChecks(copy);
      const caught = failures.some((f) => f.name === scenario.expectName);
      if (caught) {
        process.stdout.write(`  ✓ ${scenario.label} —— 被咬（「${scenario.expectName}」失败）\n`);
      } else {
        allCaught = false;
        process.stdout.write(
          `  ✗ ${scenario.label} —— 未被抓到（期望失败项「${scenario.expectName}」未出现）\n`,
        );
      }
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }
  quiet = false;

  process.stdout.write(`\nselftest 结果：${allCaught ? "三类篡改全部有效失败" : "存在漏抓！"}\n`);
  if (!allCaught) {
    process.exitCode = 1;
  }
}

function main() {
  if (selftest) {
    runSelftest();
    return;
  }
  const failedCount = runChecks(outDir);
  process.stdout.write(`\n结果：${failedCount === 0 ? "全部通过" : `${failedCount} 条失败`}\n`);
  if (failedCount > 0) {
    process.exitCode = 1;
  }
}

main();
