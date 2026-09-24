/**
 * 生成 U2（improve-workspace-file-reading）任务 1.1 的「文件阅读」专用夹具组。
 *
 * 1.1 的要求（tasks.md）：
 *   核对 C/U1 fixture 并准备**专用阅读测试副本**，覆盖
 *     「初始与各轮文件快照可选择」「文件选择器轮号不沿链累加」
 *     「失败运行已记录文件可查看」「新增文件与零字节文件不混同」
 *     「两侧都不可读时没有伪空编辑器」
 *   记录普通/隔离根/子/二次分叉关系、长文本和异常状态，**不改既有附件**。
 *
 * ── 与既有夹具的关系（不重复造轮子）────────────────────────────────────
 *   - C 的端到端冒烟（`isolated-flow-cdp-smoke.cjs`）在**运行时**现造源目录，只覆盖
 *     a.txt/keep.txt 两份「正常文本」⇒ 本脚本补的是**异常状态与多轮快照**这一层；
 *   - U1 的 `gen-u1-lineage-fixtures.cjs` 造的是**导航/谱系**语料（结局/关系/短 ID），
 *     不含隔离文件世界 ⇒ 两者的 isolated 会各自造一份，互不覆盖（目标目录不同）。
 *
 * ── 诚实边界（不得据此宣称已验收）────────────────────────────────────
 *   ① 隔离组（`u2iso_*`）由**真实引擎路径**产出（`createIsolatedRun` + `replayIsolatedRun`
 *      + Mock LLM），因此带真实 `workspace`/快照/附件哈希——这部分是引擎原生录制；
 *   ② 手工组（`u2bad_*`）是手工拼行的**结构合法标本**：用于表达"引擎不会产出的异常状态"
 *      （附件缺失 / 附件损坏 / 缺初始快照），它们的 `workspace` 字段是**经过计算后写坏/写缺**的；
 *   ③ 生成物含**绝对临时路径**（隔离组随数据目录变化）⇒ 不追求逐字节可重复；
 *      改为落一份 `MANIFEST.json` 记录关系/哈希/异常成因，供用例断言。
 *   ④ "无自有完成步骤"标本（`u2bad_noownsteps`）是**真实续跑形态的改写**：
 *      挂到真实 root 下并剔掉自身 agent.step；**不是**引擎原生录制，
 *      故放在 `broken/` 组而非 `iso-data/`。
 *
 * ── 判据有牙（变异验证，2026-09-23）──────────────────────────────────
 *   ① 「剔步骤」改成真剔但仍写回（等价于没剔）⇒ 【变异守卫】立刻失败
 *      （标本仍留 3 个 agent.step，`自有完成步骤数为 0` 不成立）；
 *   ② 生成器内部对"一个 agent.step 都没剔到"直接抛错（防字段名漂移后静默产出空转标本）。
 *      注：复现①时需**重跑生成器**，夹具才会回到"退化成有步骤"的形态。
 *
 * 用法：node scripts/gen-u2-file-fixtures.cjs [目标目录]
 * 默认目标目录 = 仓库根 .rebaseagent/u2-file-fixtures
 */
"use strict";

const { createHash } = require("node:crypto");
const {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { readRun } = require("@rebaseagent/trace-sdk");

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const DEFAULT_DIR = join(REPO_ROOT, ".rebaseagent", "u2-file-fixtures");

const MODEL = "deepseek-chat";
const FAKE_HASH = "sha256:u2file00000000000000000000000000000000000000000000000000000000";
const T0 = Date.parse("2026-09-23T09:00:00.000Z");

function iso(ms) {
  return new Date(ms).toISOString();
}

function sha256Buf(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function sha256File(path) {
  return sha256Buf(readFileSync(path));
}

// ---------------------------------------------------------------------------
// 源目录：4 个正常文件 + 1 个超长行文件（长文本证据）
// ---------------------------------------------------------------------------

/** 长文本样本：与 C 的 `longReportText()` 同构（200 行中文 + 两条 400 字符超长行） */
function longReportText() {
  const lines = [];
  lines.push("== 长文本样本（U2 1.1）==");
  for (let i = 1; i <= 200; i += 1) {
    lines.push(
      `第 ${String(i).padStart(3, "0")} 行：这是一行用于验证长文本 diff 的中文内容，编号 ${i}。`,
    );
  }
  lines.push(`超长行-单行: ${"X".repeat(400)}`);
  lines.push(`超长行-单行: ${"Y".repeat(400)}`);
  return `${lines.join("\n")}\n`;
}

/**
 * 备好源目录（导入前）。
 *
 * 文件清单与「引擎会怎样改它」：
 *   a.txt        正常文本，第 1 轮被读
 *   keep.txt     正常文本，全程不动（"未变化"样本）
 *   edit.txt     正常文本，第 2 轮被**改写**（"修改"样本）
 *   new.txt      第 2 轮被**新建**（"新增"样本 ⇒ 初始侧 not_found）
 *   empty.txt    0 字节（"零字节"样本 ⇒ 初始与各轮都是合法空文本）
 *   long.txt     200 行 + 两条超长行（长文本滚动/换行样本）
 *   bin.dat      含 0x00 的非 UTF-8 二进制（"二进制"样本）
 */
function prepareSource(source) {
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "a.txt"), "alpha 内容\n", "utf8");
  writeFileSync(join(source, "keep.txt"), "keep 内容\n", "utf8");
  writeFileSync(join(source, "edit.txt"), "初始版本\n", "utf8");
  writeFileSync(join(source, "empty.txt"), "", "utf8");
  writeFileSync(join(source, "long.txt"), longReportText(), "utf8");
  // 二进制：含 NUL 的字节序列（readFile 必须判 binary 而不是有损文本）
  writeFileSync(
    join(source, "bin.dat"),
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0x00, 0x01]),
  );
  // new.txt 刻意**不建**：它由第 2 轮的 write_file 新建
}

// ---------------------------------------------------------------------------
// Mock LLM（与 U1 lineage 脚本同法：CommonJS 重写 LlmClient 契约）
// ---------------------------------------------------------------------------

class MockLlmClient {
  constructor(script) {
    this.script = script;
    this.turn = 0;
  }

  async complete() {
    const turn = this.script[this.turn];
    this.turn += 1;
    if (turn === undefined) throw new Error(`剧本耗尽：第 ${this.turn} 轮无编排响应`);
    // "失败轮"：抛错让 runLoop 以 errored 终止（既有语义：失败即 error 终止，不重试）
    if (turn.fail === true) throw new Error(turn.failMessage ?? "模拟 LLM 失败");
    return {
      response: {
        content: turn.content ?? null,
        reasoningContent: turn.reasoning ?? null,
        toolCalls: (turn.toolCalls ?? []).map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.args },
        })),
        usage: turn.usage ?? { in: 100, out: 50 },
        ttftMs: 10,
      },
      requestBody: {},
    };
  }
}

// ---------------------------------------------------------------------------
// 隔离组：真实引擎谱系
// ---------------------------------------------------------------------------

/**
 * 产出真实 v2 隔离谱系：
 *
 *   u2iso_root（3 轮：读 a.txt → 改 edit.txt + 新建 new.txt + 读 empty/long/bin → 收尾）
 *     └── u2iso_fork1（一次分叉：从"改 edit.txt"处续跑，该轮含 2 个工具 ⇒ 多工具轮）
 *           └── u2iso_fork2（二次分叉：本地轮号必须回到第 1 轮）
 *
 * 这条链同时给出：真实 workspace/resume_after_step、真实附件哈希、
 * 多轮快照（初始 + 第 1/2/3 轮）、新增/修改/未变化/零字节/二进制/长文本六类文件状态。
 */
async function buildIsolatedLineage(dataDir) {
  const {
    createIsolatedRun,
    replayIsolatedRun,
    FILE_TOOLS_V1_DEFINITIONS,
  } = require("@rebaseagent/replay");

  // 源目录与数据目录必须互为兄弟（validateSourceRoot 拒绝嵌套）
  const outer = mkdtempSync(join(tmpdir(), "u2file-"));
  const source = join(outer, "source");
  const isoDataDir = join(outer, "data");
  prepareSource(source);
  mkdirSync(isoDataDir, { recursive: true });

  const config = {
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    model: MODEL,
    systemPrompt: "你是文件助手。",
    tools: [...FILE_TOOLS_V1_DEFINITIONS],
    params: undefined,
    exec: { cwd: "D:/nope-not-a-real-dir", signal: null },
    maxIterations: 10,
    budget: { maxTotalTokens: 100000 },
  };
  const authority = { allowFileWrites: true };

  const readCall = (id, path) => ({ id, name: "read_file", args: JSON.stringify({ path }) });
  const writeCall = (id, path, content) => ({
    id,
    name: "write_file",
    args: JSON.stringify({ path, content }),
  });

  // 根：3 轮
  const root = await createIsolatedRun({
    dataDir: isoDataDir,
    source,
    config,
    userMessage: "按剧本操作文件",
    authority,
    llm: new MockLlmClient([
      // 第 1 轮：只读一个文件（此轮结束 ⇒ 仅有 a.txt 被快照）
      { toolCalls: [readCall("c1", "a.txt")] },
      // 第 2 轮：改一个已有文件 + 新建一个文件 + 读零字节/长文本/二进制
      {
        toolCalls: [
          writeCall("c2", "edit.txt", "被改写的版本\n"),
          writeCall("c3", "new.txt", "新建文件内容\n"),
          readCall("c4", "empty.txt"),
          readCall("c5", "long.txt"),
          readCall("c6", "bin.dat"),
        ],
      },
      // 第 3 轮：收尾
      { content: "根 run 完成。" },
    ]),
  });
  if (!root.ok)
    throw new Error(`createIsolatedRun 失败：${root.failure.code} ${root.failure.reason}`);

  const rootRecord = readRun(join(isoDataDir, "traces", `${root.id}.jsonl`));
  const rootSteps = rootRecord.spans.filter((s) => s.kind === "agent.step").map((s) => s.id);
  const writeEdit = rootRecord.spans.find(
    (s) => s.kind === "tool.invoke" && JSON.stringify(s.args).includes("edit.txt"),
  );
  if (writeEdit === undefined) throw new Error("根 run 缺少写 edit.txt 的 span");

  // 一次分叉：从"改 edit.txt"处续跑；该轮放 2 个工具 ⇒ 覆盖多工具轮次
  const fork1 = await replayIsolatedRun({
    dataDir: isoDataDir,
    parentId: root.id,
    atSpanId: writeEdit.id,
    edit: { field: "result", value: "内容(edit.txt)【编辑后】" },
    config,
    authority,
    llm: new MockLlmClient([
      { toolCalls: [readCall("c7", "a.txt"), readCall("c8", "edit.txt")] },
      { content: "分叉 1 完成。" },
    ]),
  });
  if (!fork1.ok)
    throw new Error(`replayIsolatedRun 失败：${fork1.failure.code} ${fork1.failure.reason}`);

  const fork1Record = readRun(join(isoDataDir, "traces", `${fork1.id}.jsonl`));
  const fork1Tool = fork1Record.spans.find((s) => s.kind === "tool.invoke");
  if (fork1Tool === undefined) throw new Error("分叉 1 缺少自有 tool.invoke span");

  // 二次分叉：从分叉 1 的自有工具处再续跑 ⇒ 轮号应为本地第 1 轮
  const fork2 = await replayIsolatedRun({
    dataDir: isoDataDir,
    parentId: fork1.id,
    atSpanId: fork1Tool.id,
    edit: { field: "result", value: "内容(a.txt)【二次编辑】" },
    config,
    authority,
    llm: new MockLlmClient([
      { toolCalls: [readCall("c9", "keep.txt")] },
      { content: "分叉 2 完成。" },
    ]),
  });
  if (!fork2.ok) throw new Error(`二次分叉失败：${fork2.failure.code} ${fork2.failure.reason}`);

  // ④ 失败 run（真实 errored 终止）：第 1 轮成功写入检查点，第 2 轮 LLM 失败封存。
  //    ——这正是 1.1「失败运行已记录文件可查看」要的**引擎原生**样本：
  //    run 已封存为 errored，但第 1 轮的文件检查点**已经落盘**，必须仍可读。
  const errored = await createIsolatedRun({
    dataDir: isoDataDir,
    source,
    config,
    userMessage: "先写文件，然后失败",
    authority,
    llm: new MockLlmClient([
      // 第 1 轮：真实写入 ⇒ 检查点落盘
      { toolCalls: [writeCall("c10", "edit.txt", "失败前的写入\n")] },
      // 第 2 轮：抛错 ⇒ run 以 errored 封存
      { fail: true, failMessage: "模拟上游模型不可用" },
    ]),
  });
  if (!errored.ok) {
    throw new Error(`errored 样本创建失败：${errored.failure.code} ${errored.failure.reason}`);
  }
  const erroredRecord = readRun(join(isoDataDir, "traces", `${errored.id}.jsonl`));
  const erroredEvent = erroredRecord.events.find((e) => e.type === "run.event");
  const erroredSteps = erroredRecord.spans.filter((s) => s.kind === "agent.step").map((s) => s.id);
  // 检查点标注写在 `agent.step` 的 `workspace_snapshot` 字段上（每轮末一份）
  const erroredCheckpoints = erroredRecord.spans.filter(
    (s) => s.workspace_snapshot !== undefined,
  ).length;

  return {
    dataDir: isoDataDir,
    sourceDir: source,
    rootId: root.id,
    rootSteps,
    fork1Id: fork1.id,
    fork2Id: fork2.id,
    erroredId: errored.id,
    erroredSteps,
    erroredCheckpoints,
    erroredEvent: erroredEvent?.event ?? null,
    erroredOutcome: errored.outcome.event.event,
  };
}

// ---------------------------------------------------------------------------
// 异常状态手工组：引擎不会产出的「坏 / 缺」形态
// ---------------------------------------------------------------------------

function createWriter() {
  const lines = [];
  return {
    meta(meta) {
      lines.push({ type: "run.meta", ...meta });
    },
    step(id, n, startMs, endMs, parent = null) {
      lines.push({
        type: "span",
        id,
        parent,
        timing: { started_at: iso(startMs), ended_at: iso(endMs) },
        kind: "agent.step",
        n,
      });
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

/**
 * 把一份**真实的 v2 隔离 run** 改造成异常标本：
 *   - `mutate(meta)` 可直接改 meta 结构；
 *   - ⚠️ `workspace.world_id` **必须同步改成新的 run id** —— 读取器强制
 *     `world_id === meta.id`（"世界身份 = 本 run"），只改 id 不改 world_id 会连
 *     结构校验都过不去，异常就落不到"附件层"（那是另一种标本，属 1.2 的坏版本组）。
 *   - 检查点标注里的 `step_span` / `run_id` 也随之重写，保证自相矛盾**只**发生在附件层。
 */
function deriveBrokenRun({ baseText, oldWorldId, newId, newTask }) {
  return baseText
    .split("\n")
    .filter((l) => l !== "")
    .map((line, index) => {
      const obj = JSON.parse(line);
      if (index === 0) {
        obj.id = newId;
        obj.task = newTask;
        obj.parent = null;
        obj.fork = null;
        if (obj.workspace !== undefined) obj.workspace.world_id = newId;
        return JSON.stringify(obj);
      }
      // 检查点标注里的 world 归属同步重写（否则 world_id 与快照来源对不上）
      if (obj.type === "span" && obj.workspace !== undefined) {
        if (obj.workspace.world_id === oldWorldId) obj.workspace.world_id = newId;
      }
      return JSON.stringify(obj);
    })
    .join("\n")
    .concat("\n");
}

/**
 * "无自有完成步骤"标本：从真实 root run 派生出一个**本地一步都没走完**的续跑者。
 *
 * ⚠️⚠️ 为什么**不能**用"删掉 `workspace_snapshot`"来做这个标本（初版就这么错，已废弃）：
 *    v2 的不变量是「已完成并落盘的 `agent.step` **必须**携带 `workspace_snapshot`」，
 *    由两处强制：`packages/replay/src/workspace/checkpoint-tracer.ts`（wrapper 写入）
 *    与 `packages/trace-sdk/src/reader.ts`（读到缺失直接抛 `TraceReadError`）。
 *    所以"v2 run 有 step 但没有检查点"是**读取器一律拒绝的非法状态**，
 *    删字段只会得到一个读不出来的文件——既不是合法标本，也测不到任何真实分支。
 *
 * ⚠️⚠️ 也**不能**只抬高新有轮号：`deriveCheckpointOptions` 用 `leafSpanIds` 判"是否自有"
 *    （`leafSpanIds` = 本 run 记录里自己的 span id，由 `run-repository.getRun` 给出），
 *    **根本不看 `n`**。只改 `n` ⇒ 仍是自有步骤，标本等于没做（正是第二次翻车的形态）。
 *
 * 真实可达的形态只有一种：**跨 run 续跑**——每轮都是父 run 的一步，本 run 自己一步都没
 * 走完，却因父跑到底而正常 completed。此时：
 *   - `run.meta.workspace` 照常在（v2 契约，reader 会检查）⇒ 初始快照**可读**；
 *   - 自有 `agent.step` 一个都没有 ⇒ `deriveCheckpointOptions` 只剩"本 run 初始状态"，
 *     而合并轨迹里仍能看到**父 run 的**步骤（正是"祖先不得冒充本 run 检查点"的正面反例）。
 *
 * 做法：给 meta 挂 `parent`（指向真实 root）与 `fork.resume_after_step`，
 * 使读取器走 `resolveBranch` 合并路径；剔除本 run 自有的 `agent.step`，
 * 同时把 `world_id` 抬到新 id（读取器强制 `world_id === meta.id`）。
 */
function deriveNoOwnSteps(baseText, oldWorldId, newId, newTask, parentId, resumeAfterStep, atSpan) {
  const kept = [];
  let droppedSteps = 0;
  for (const [index, line] of baseText
    .split("\n")
    .filter((l) => l !== "")
    .entries()) {
    const obj = JSON.parse(line);
    if (index === 0) {
      obj.id = newId;
      obj.task = newTask;
      obj.parent = parentId; // 挂到真实 root ⇒ 详情走合并轨迹路径
      // ⚠️⚠️ `at_span` 必须是**该轮内的工具调用**，且**不得等于** `resume_after_step`
      //    （`packages/trace-sdk/src/branch.ts` 硬校验）。初版把两者都填成同一个 `agent.step` id
      //    ⇒ 该标本**经运行列表读取必被 `resolveBranch` 拒**（详情页打不开）；因为 1.1 的用例只
      //    `readRun` 本文件、不触发分支解析，所以当时没暴露（5.5 实测发现并另建了正确标本）。
      //    5.5/5.6 的生成器已按此形态构造；此处补齐，并让 `u2-file-fixtures.test.ts` 显式调 `resolveBranch` 自检。
      obj.fork = {
        at_span: atSpan,
        resume_after_step: resumeAfterStep,
        edit: { field: "result", value: "（无自有完成步骤标本）" },
      };
      // ⚠️ 分支 run 的 workspace.origin 必须是 checkpoint 且指向**直接**父 run，
      //    且 origin.step_span 必须与 resume_after_step 同指一个 step（trace-sdk 交叉校验）。
      //    只改 world_id 会被 "分支 run 的 workspace.origin.kind 必须是 checkpoint" 拒掉。
      if (obj.workspace !== undefined) {
        obj.workspace.origin = { kind: "checkpoint", run_id: parentId, step_span: resumeAfterStep };
      }
      if (obj.workspace !== undefined) obj.workspace.world_id = newId;
      kept.push(JSON.stringify(obj));
      continue;
    }
    // 本 run 自己一步都不落盘：剔掉全部 agent.step（工具 span 无害，留着反而更接近真实）
    if (obj.type === "span" && obj.kind === "agent.step") {
      droppedSteps += 1;
      continue;
    }
    if (obj.type === "span" && obj.workspace_snapshot !== undefined) {
      continue; // 检查点只挂在 agent.step 上，理论上不会走到这里；保险起见一并剔除
    }
    kept.push(JSON.stringify(obj));
  }
  if (droppedSteps === 0) {
    throw new Error(
      "deriveNoOwnSteps 没有剔到任何 agent.step：字段名可能已变，标本会退化成有自有步骤",
    );
  }
  return `${kept.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function listBlobs(dataDir) {
  const dir = join(dataDir, "workspace-blobs", "sha256");
  try {
    return readdirSync(dir)
      .sort()
      .map((name) => ({ name, sha256: sha256File(join(dir, name)) }));
  } catch {
    return [];
  }
}

function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dst, name);
    if (statSync(from).isDirectory()) copyDir(from, to);
    else copyFileSync(from, to);
  }
}

function main() {
  const targetArg = process.argv[2];
  const outDir = targetArg === undefined ? DEFAULT_DIR : resolve(targetArg);

  // 目标目录必须干净（避免上一轮残留污染清单）
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  return buildIsolatedLineage(outDir).then((isolated) => {
    // ── 隔离组：**必须是完整数据目录**（`traces/` 与 `workspace-blobs/` 同级）──
    //
    // ⚠️ 关键结构约束：读取层按 `dataDir` 定位，内部会自己拼 `traces/<id>.jsonl`
    //    与 `workspace-blobs/sha256/<hash>`。所以"能直接被读取 API 消费"的夹具
    //    必须是 `<dataDir>/{traces,workspace-blobs}` 这一种形状——
    //    把 trace 与附件拆到两个不同顶层目录（如 `isolated-traces/` + `isolated-blobs/`）
    //    在包层是**读不出来的**，那种拆法只适合"手工核对清单"。
    const isoDataDir = join(outDir, "iso-data");
    copyDir(isolated.dataDir, isoDataDir);
    const isoBlobsSrc = join(isoDataDir, "workspace-blobs");

    // 源目录快照（供"源目录未被改动"的对照；不是 dataDir，只是文件世界的外部来源）
    const sourceSnapshot = join(outDir, "source");
    prepareSource(sourceSnapshot);

    // ── 异常组：以真实 root run 为底改造 ──────────────────────────────────
    //
    // ⚠️ 每条异常标本也是**独立完整数据目录**（`broken/<name>/{traces,workspace-blobs}`）
    //    ——因为读取层按 `dataDir` 定位附件，两条标本若共用一个 dataDir，
    //    "缺失"的那条会读到"损坏"那条的附件，两种成因就无法分离。
    const badRoot = join(outDir, "broken");
    mkdirSync(badRoot, { recursive: true });

    const rootText = readFileSync(join(isoDataDir, "traces", `${isolated.rootId}.jsonl`), "utf8");

    // ① 附件缺失：trace 声明的附件**一份都不落盘**
    const missingId = "u2bad_missing";
    const missingDir = join(badRoot, "missing");
    mkdirSync(join(missingDir, "traces"), { recursive: true });
    mkdirSync(join(missingDir, "workspace-blobs", "sha256"), { recursive: true });
    writeFileSync(
      join(missingDir, "traces", `${missingId}.jsonl`),
      deriveBrokenRun({
        baseText: rootText,
        oldWorldId: isolated.rootId,
        newId: missingId,
        newTask: "附件缺失样本",
      }),
      "utf8",
    );

    // ② 附件损坏：**全部**附件复制过去，但内容整体替换 ⇒ 哈希对不上
    const corruptId = "u2bad_corrupt";
    const corruptDir = join(badRoot, "corrupt");
    mkdirSync(join(corruptDir, "traces"), { recursive: true });
    const corruptBlobsDir = join(corruptDir, "workspace-blobs", "sha256");
    mkdirSync(corruptBlobsDir, { recursive: true });
    for (const blob of readdirSync(join(isoBlobsSrc, "sha256"))) {
      writeFileSync(join(corruptBlobsDir, blob), "CORRUPTED-BYTES\n", "utf8");
    }
    writeFileSync(
      join(corruptDir, "traces", `${corruptId}.jsonl`),
      deriveBrokenRun({
        baseText: rootText,
        oldWorldId: isolated.rootId,
        newId: corruptId,
        newTask: "附件损坏样本",
      }),
      "utf8",
    );

    // ③ 无自有完成步骤：挂到真实 root 下、剔掉自身全部 agent.step ⇒ 只剩初始快照可读。
    //
    //    ⚠️ 这里**不能**改成"删掉 workspace_snapshot"（v2 硬不变量，删了文件读不出来），
    //    也**不能**只抬轮号（判"自有"看 leafSpanIds，不看 n）。详见函数注释。
    const noCheckpointId = "u2bad_noownsteps";
    const noCheckpointDir = join(badRoot, "no-own-steps");
    mkdirSync(join(noCheckpointDir, "traces"), { recursive: true });
    // 合并轨迹要求父 run 也在同一个 traces/ 目录里，否则 resolveBranch 取不到父记录
    writeFileSync(join(noCheckpointDir, "traces", `${isolated.rootId}.jsonl`), rootText, "utf8");
    // ⚠️ `fork.at_span` 必须是「该轮内的工具调用」，不能等于 `resume_after_step`（两者都是 id）
    //    ⇒ 从真实 root trace 里取第 1 轮内**真实存在**的 `tool.invoke`（trace-sdk `branch.ts` 硬校验）。
    const firstRoundToolSpanId = rootText
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l))
      .find(
        (o) => o.type === "span" && o.kind === "tool.invoke" && o.parent === isolated.rootSteps[0],
      )?.id;
    if (firstRoundToolSpanId === undefined) {
      throw new Error("1.1 夹具：root 第 1 轮内没有 tool.invoke span，无法构造合法的 fork.at_span");
    }
    writeFileSync(
      join(noCheckpointDir, "traces", `${noCheckpointId}.jsonl`),
      deriveNoOwnSteps(
        rootText,
        isolated.rootId,
        noCheckpointId,
        "无自有完成步骤样本",
        isolated.rootId,
        isolated.rootSteps[0], // 从 root 第 1 轮的 step 之后续跑
        firstRoundToolSpanId, // fork.at_span 必须是该轮内的 tool.invoke（≠ resume_after_step）
      ),
      "utf8",
    );
    // 初始快照所需的附件照常复制（该标本要能读出初始清单）
    copyDir(join(isoBlobsSrc, "sha256"), join(noCheckpointDir, "workspace-blobs", "sha256"));

    // ── 清单 ─────────────────────────────────────────────────────────────
    const manifest = {
      生成器: "apps/desktop/scripts/gen-u2-file-fixtures.cjs",
      说明:
        "1.1 文件阅读语料清单。每组的 <数据目录> 都是可直接被读取 API 消费的完整数据目录" +
        "（traces/ 与 workspace-blobs/ 同级）；iso-data 为真实引擎产物（含绝对临时路径，" +
        "不追求逐字节可重复）；broken/* 为故意自相矛盾的异常标本。",
      数据目录: {
        isolated: "iso-data",
        sourceSnapshot: "source",
        brokenMissing: "broken/missing",
        brokenCorrupt: "broken/corrupt",
        brokenNoOwnSteps: "broken/no-own-steps",
      },
      关系: {
        isolated: {
          root: isolated.rootId,
          fork1: isolated.fork1Id,
          fork2: isolated.fork2Id,
          语义: "一次分叉 + 二次分叉，真实 v2 隔离谱系",
        },
        errored: {
          id: isolated.erroredId,
          终止事件: isolated.erroredEvent,
          自有步骤: isolated.erroredSteps,
          检查点数: isolated.erroredCheckpoints,
          语义: "第 1 轮真实写入后第 2 轮 LLM 失败 ⇒ errored 封存，但已记录的文件检查点必须仍可读",
        },
      },
      源目录: isolated.sourceDir,
      隔离附件哈希: listBlobs(isoDataDir),
      异常标本: {
        missing: {
          id: "u2bad_missing",
          数据目录: "broken/missing",
          成因: "trace 声明的附件全部未落盘 ⇒ 读取报 missing",
        },
        corrupt: {
          id: "u2bad_corrupt",
          数据目录: "broken/corrupt",
          成因: "附件落盘但内容被替换 ⇒ 哈希校验失败，读取报 corrupt",
        },
        noCheckpoint: {
          id: "u2bad_noownsteps",
          数据目录: "broken/no-own-steps",
          成因:
            "把自有 agent.step.n 整体抬高 100 ⇒ 本 run 一个自有完成步骤都没有（只剩初始快照），" +
            "对应「无自有完成步骤时选择初始」。" +
            "⚠️ 不可用删快照的方式构造：v2 已完成 step 必带 workspace_snapshot 是读取器强制的硬不变量。",
        },
      },
    };

    // 逐 run 记录：检查点（初始 + 各轮）与文件状态，供用例直接断言
    manifest.检查点快照 = {};
    for (const [label, runId] of [
      ["root", isolated.rootId],
      ["fork1", isolated.fork1Id],
      ["fork2", isolated.fork2Id],
      ["errored", isolated.erroredId],
    ]) {
      const record = readRun(join(isoDataDir, "traces", `${runId}.jsonl`));
      manifest.检查点快照[label] = {
        id: runId,
        自有spanIds: record.spans.map((s) => s.id),
        parent: record.meta.parent,
        步骤轮号: record.spans.filter((s) => s.kind === "agent.step").map((s) => s.n),
        workspaceWorldId: record.meta.workspace?.world_id ?? null,
      };
    }

    writeFileSync(join(outDir, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    process.stdout.write(
      `已生成 U2 1.1 语料 → ${outDir}\n  隔离谱系 3 条（真实引擎）：${isolated.rootId} → ${isolated.fork1Id} → ${isolated.fork2Id}\n  数据目录：iso-data（完整可读）· broken/{missing,corrupt,no-own-steps}\n  隔离附件 ${manifest.隔离附件哈希.length} 份；异常标本 3 条\n`,
    );
  });
}

main().catch((error) => {
  process.stderr.write(`生成失败：${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
