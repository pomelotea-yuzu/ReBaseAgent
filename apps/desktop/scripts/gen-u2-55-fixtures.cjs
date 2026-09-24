/**
 * 生成 U2 任务 5.5 的夹具（IPC 安全 / 未录制与失败记录 / 只读不变性）。
 *
 * 5.5 要验的 spec 场景（见 `openspec/changes/improve-workspace-file-reading/specs/desktop-ui/spec.md`）：
 *   - 文件读取 IPC 拒绝越权（非法 runId / 清单外路径 / 祖先而非自有 step / 任意物理 blob 路径）
 *   - 二进制和不可用附件分别显示（非 UTF-8 / 清单外 / 缺失 / 损坏 / 没有检查点的旧 run）
 *   - 失败运行已记录文件可查看（LLM 失败封存，但此前已落盘的文件检查点仍可读）
 *   - 文件浏览过程无写入 · 阅读重试只读且重新校验（源/父/兄弟/trace/附件哈希不变，模型与工具零调用）
 *
 * ── 与 1.1 / 5.4 夹具的关系 ────────────────────────────────────────────
 *   1.1 的 `broken/{missing,corrupt}` 是**以真实 root run 为底、附件整体替换**的标本：
 *   它的"损坏"落在**与真实 run 共用**的附件哈希上 ⇒ **绝不能**安装进 live 数据目录
 *   （那样会把真实 run 的附件一起弄坏）。本脚本因此**不复用**它们，改为自造**独立哈希**的
 *   异常标本：对每条异常引用一个**只属于本标本**的哈希，附件缺失/损坏只影响该标本自己。
 *
 * ── 关键不变量（踩过才知道，写死在这里防复退）─────────────────────────
 *   ① 完成的 `agent.step` **必须**携带 `workspace_snapshot`——读取器硬拒绝缺失
 *      ⇒ 只能往快照里**增删条目**，不能删字段；改了条目必须 `computeWorkspaceSnapshotId` 重算 id。
 *   ② `run.meta.workspace.world_id` 必须等于 `meta.id` ⇒ 换 id 必须同步改 world_id。
 *   ③ 检查点归属按 `leafSpanIds`（run **自有** span）判定，**不看轮号 n** ⇒ "无自有完成步骤"
 *      只能靠**剔掉本 run 自己的 agent.step** 达成（并挂父 run 让合并轨迹仍能解析）。
 *   ④ 分支 run 的 `workspace.origin` 必须是 `{kind:"checkpoint"}` 且指向**直接**父 run，
 *      `origin.step_span` 必须与 `fork.resume_after_step` 同指一个 step（trace-sdk 交叉校验）。
 *
 * 用法：node scripts/gen-u2-55-fixtures.cjs [--no-install]
 *   默认把夹具的 trace 与附件**安装进 live 数据目录**（`.rebaseagent/{traces,workspace-blobs}`），
 *   否则实机（应用只读 live 数据目录）看不到它们。
 */
"use strict";

const { createHash } = require("node:crypto");
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { join, resolve } = require("node:path");
const { readRun } = require("@rebaseagent/trace-sdk");
const { computeWorkspaceSnapshotId } = require("@rebaseagent/trace-sdk/workspace-hash");

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const FIX_DIR = join(REPO_ROOT, ".rebaseagent", "u2-file-fixtures-55");
const SOURCE_DIR = join(FIX_DIR, "source"); // 与 data 目录**互为兄弟**（validateSourceRoot 拒绝嵌套）
const DATA_DIR = join(FIX_DIR, "data");
const LIVE_DIR = join(REPO_ROOT, ".rebaseagent");
const INSTALL = !process.argv.includes("--no-install");

const MODEL = "deepseek-chat";

/** 二进制字节：含非法 UTF-8 续字节（0xff/0xfe）⇒ 读取侧判 `binary` */
const BINARY_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0x00, 0x01]);

const A_TXT = "alpha 内容\n";
const EDIT_INITIAL = "初始版本\n";
const EDIT_R2 = "第二轮改写\n";
const NEW_TXT = "新建文件内容\n";
const EDIT_ERRONED = "失败前的写入\n";
const KEEP_TXT = "keep 内容\n";

/** 异常标本引用、且**永不落盘**的期望内容（哈希只属于本标本） */
const MISSING_EXPECTED = "U2-5.5 附件缺失标本的期望内容（永不落盘）\n";
/**
 * 损坏标本：blob 落在"期望内容的哈希"路径上，但内容是**同长度的另一串 ASCII**
 * ⇒ 长度相符、**只有哈希不符**，把 `corrupt` 的判据精确地钉在哈希校验上
 * （若长度也不符，就分不清是长度检查还是哈希检查拦下的）。
 */
const CORRUPT_EXPECTED = "U2-5.5-corrupt-expected-content-never-on-disk\n";
const CORRUPT_WRONG_BYTES = "!".repeat(CORRUPT_EXPECTED.length);
if (
  CORRUPT_WRONG_BYTES.length !== CORRUPT_EXPECTED.length ||
  CORRUPT_WRONG_BYTES === CORRUPT_EXPECTED
) {
  throw new Error("损坏标本的错字节必须与期望内容**等长且不同**");
}

function sha256Buf(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** 长文本样本：200 行 + 两条超长行（与 1.1 / 5.4 同构，供"长路径 / 长文本"对照） */
function longReportText() {
  const lines = ["== 长文本样本（U2 5.5）=="];
  for (let i = 1; i <= 200; i += 1) {
    lines.push(
      `第 ${String(i).padStart(3, "0")} 行：这是一行用于验证长文本只读读取的中文内容，编号 ${i}。`,
    );
  }
  lines.push(`超长行-单行: ${"X".repeat(400)}`);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Mock LLM（CommonJS 重写 LlmClient 契约，与 1.1 / 5.4 同法）
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

function prepareSource() {
  mkdirSync(SOURCE_DIR, { recursive: true });
  writeFileSync(join(SOURCE_DIR, "a.txt"), A_TXT, "utf8");
  writeFileSync(join(SOURCE_DIR, "keep.txt"), KEEP_TXT, "utf8");
  writeFileSync(join(SOURCE_DIR, "edit.txt"), EDIT_INITIAL, "utf8");
  writeFileSync(join(SOURCE_DIR, "long.txt"), longReportText(), "utf8");
  writeFileSync(join(SOURCE_DIR, "bin.dat"), BINARY_BYTES);
  // new.txt 刻意不建：由第 2 轮的 write_file 新建
}

function isoConfig() {
  return {
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    model: MODEL,
    systemPrompt: "你是文件助手。",
    tools: [...require("@rebaseagent/replay").FILE_TOOLS_V1_DEFINITIONS],
    params: undefined,
    exec: { cwd: "D:/nope-not-a-real-dir", signal: null },
    maxIterations: 10,
    budget: { maxTotalTokens: 100000 },
  };
}

const readCall = (id, path) => ({ id, name: "read_file", args: JSON.stringify({ path }) });
const writeCall = (id, path, content) => ({
  id,
  name: "write_file",
  args: JSON.stringify({ path, content }),
});

/**
 * 真实引擎谱系：
 *   R（3 轮：读 a.txt → 改 edit.txt + 新建 new.txt + 读 long/bin → 收尾）
 *   F = R 的真实分叉（从"改 edit.txt"处续跑）——"子/sibling"哈希对照用
 *   E = 真实 errored run（第 1 轮写入落盘 → 第 2 轮 LLM 失败封存）
 */
async function buildLineage() {
  const { createIsolatedRun, replayIsolatedRun } = require("@rebaseagent/replay");
  const config = isoConfig();
  const authority = { allowFileWrites: true };

  const root = await createIsolatedRun({
    dataDir: DATA_DIR,
    source: SOURCE_DIR,
    config,
    userMessage: "按剧本操作文件（U2 5.5 只读回归）",
    authority,
    llm: new MockLlmClient([
      { toolCalls: [readCall("c1", "a.txt")] },
      {
        toolCalls: [
          writeCall("c2", "edit.txt", EDIT_R2),
          writeCall("c3", "new.txt", NEW_TXT),
          readCall("c4", "long.txt"),
          readCall("c5", "bin.dat"),
        ],
      },
      { content: "根 run 完成。" },
    ]),
  });
  if (!root.ok)
    throw new Error(`createIsolatedRun 失败：${root.failure.code} ${root.failure.reason}`);

  const rootRecord = readRun(join(DATA_DIR, "traces", `${root.id}.jsonl`));
  const rootSteps = rootRecord.spans.filter((s) => s.kind === "agent.step");
  if (rootSteps.length < 2) throw new Error(`根 run 只有 ${rootSteps.length} 个 agent.step`);
  const writeEdit = rootRecord.spans.find(
    (s) => s.kind === "tool.invoke" && JSON.stringify(s.args).includes("edit.txt"),
  );
  if (writeEdit === undefined) throw new Error("根 run 缺少写 edit.txt 的 span");
  // ⚠️ 第 1 轮内的工具 span：`fork.at_span` **必须是该轮内的工具调用**，不能等于轮次容器
  //    （trace-sdk `branch.ts` 硬校验：`fork.at_span 不能等于 resume_after_step`）
  const r1Tool = rootRecord.spans.find(
    (s) => s.kind === "tool.invoke" && s.parent === rootSteps[0].id,
  );
  if (r1Tool === undefined) throw new Error("根 run 第 1 轮内没有 tool.invoke span");

  const fork = await replayIsolatedRun({
    dataDir: DATA_DIR,
    parentId: root.id,
    atSpanId: writeEdit.id,
    edit: { field: "result", value: "内容(edit.txt)【5.5 只读回归】" },
    config,
    authority,
    llm: new MockLlmClient([{ toolCalls: [readCall("c6", "a.txt")] }, { content: "分叉完成。" }]),
  });
  if (!fork.ok)
    throw new Error(`replayIsolatedRun 失败：${fork.failure.code} ${fork.failure.reason}`);

  const errored = await createIsolatedRun({
    dataDir: DATA_DIR,
    source: SOURCE_DIR,
    config,
    userMessage: "先写文件，然后失败（U2 5.5 失败记录回归）",
    authority,
    llm: new MockLlmClient([
      { toolCalls: [writeCall("c7", "edit.txt", EDIT_ERRONED)] },
      { fail: true, failMessage: "模拟上游模型不可用（U2 5.5）" },
    ]),
  });
  if (!errored.ok) throw new Error(`errored 样本创建失败：${errored.failure.code}`);

  const erroredRecord = readRun(join(DATA_DIR, "traces", `${errored.id}.jsonl`));
  const erroredEvent = erroredRecord.events.find((e) => e.type === "run.event");
  const erroredSteps = erroredRecord.spans.filter((s) => s.kind === "agent.step");

  return {
    rootId: root.id,
    rootSteps: rootSteps.map((s) => s.id),
    r1ToolId: r1Tool.id,
    forkId: fork.id,
    erroredId: errored.id,
    erroredSteps: erroredSteps.map((s) => s.id),
    erroredEvent: erroredEvent?.event ?? null,
    erroredReason: erroredEvent?.reason ?? null,
  };
}

// ---------------------------------------------------------------------------
// 异常标本：独立哈希，绝不碰真实附件
// ---------------------------------------------------------------------------

/**
 * 以真实 root 为底派生一条"根形态"的异常 run：换 id + 同步 world_id，
 * 并把 `extraFiles` 追加进指定 step 的检查点（追加后**必须**重算 snapshot id）。
 */
function deriveWithExtraFiles({ baseText, oldWorldId, newId, newTask, stepId, extraFiles }) {
  let patched = 0;
  const out = baseText
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
      if (obj.type === "span" && obj.id === stepId) {
        const files = obj.workspace_snapshot?.files;
        if (Array.isArray(files)) {
          files.push(...extraFiles);
          // ⚠️ 改了条目 ⇒ 规范清单指纹必须重算：读取器会重算并比对 `snapshot.id`
          obj.workspace_snapshot.id = computeWorkspaceSnapshotId(files);
          patched += 1;
        }
      }
      return JSON.stringify(obj);
    })
    .join("\n")
    .concat("\n");
  if (patched !== 1) {
    throw new Error(`异常标本没有恰好改到 1 个检查点（实际 ${patched}）——字段名可能已变`);
  }
  return out;
}

/**
 * "无自有完成步骤"标本：挂到真实 root 下、剔掉本 run 自己的全部 agent.step。
 *
 * ⚠️ 不能删 `workspace_snapshot`（v2 硬不变量，删了文件读不出来），也不能只抬轮号
 * （判"自有"看 `leafSpanIds`，不看 `n`）。可达形态只有"跨 run 续跑、本 run 一步未走完"。
 */
function deriveNoOwnSteps({ baseText, newId, newTask, parentId, resumeAfterStep, atSpan }) {
  const kept = [];
  let dropped = 0;
  for (const [index, line] of baseText
    .split("\n")
    .filter((l) => l !== "")
    .entries()) {
    const obj = JSON.parse(line);
    if (index === 0) {
      obj.id = newId;
      obj.task = newTask;
      obj.parent = parentId;
      // ⚠️ `at_span` 必须是**该轮内的工具调用**，且不得等于 `resume_after_step`
      //    （trace-sdk `branch.ts` 硬校验；只把两者设成同一个 step id 会被直接拒绝，
      //    而"经运行列表读取"这条真实路径一定会走该校验——1.1 的同形标本就栽在这里）
      obj.fork = {
        at_span: atSpan,
        resume_after_step: resumeAfterStep,
        edit: { field: "result", value: "（无自有完成步骤标本）" },
      };
      if (obj.workspace !== undefined) {
        obj.workspace.origin = { kind: "checkpoint", run_id: parentId, step_span: resumeAfterStep };
        obj.workspace.world_id = newId;
      }
      kept.push(JSON.stringify(obj));
      continue;
    }
    if (obj.type === "span" && obj.kind === "agent.step") {
      dropped += 1;
      continue;
    }
    kept.push(JSON.stringify(obj));
  }
  if (dropped === 0) {
    throw new Error("deriveNoOwnSteps 没有剔到任何 agent.step：字段名可能已变，标本会退化");
  }
  return `${kept.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// 安装 / 自检
// ---------------------------------------------------------------------------

function installBlob(dataDir, name) {
  const from = join(dataDir, "workspace-blobs", "sha256", name);
  const to = join(LIVE_DIR, "workspace-blobs", "sha256", name);
  if (existsSync(to)) return false;
  copyFileSync(from, to);
  return true;
}

function install(ids) {
  const destTraces = join(LIVE_DIR, "traces");
  const destBlobs = join(LIVE_DIR, "workspace-blobs", "sha256");
  mkdirSync(destTraces, { recursive: true });
  mkdirSync(destBlobs, { recursive: true });
  const blobsSrc = join(DATA_DIR, "workspace-blobs", "sha256");
  const result = { traces: [], blobsAdded: 0 };
  for (const id of ids) {
    copyFileSync(join(DATA_DIR, "traces", `${id}.jsonl`), join(destTraces, `${id}.jsonl`));
    result.traces.push(id);
  }
  for (const name of readdirSync(blobsSrc)) {
    if (installBlob(DATA_DIR, name)) result.blobsAdded += 1;
  }
  return result;
}

async function main() {
  // 目标目录必须干净（避免上一轮残留污染）
  rmSync(FIX_DIR, { recursive: true, force: true });
  mkdirSync(FIX_DIR, { recursive: true });
  prepareSource();
  mkdirSync(DATA_DIR, { recursive: true });

  const lineage = await buildLineage();
  const { locateWorkspaceSnapshot, readWorkspaceFile } = require("@rebaseagent/replay");

  const rootText = readFileSync(join(DATA_DIR, "traces", `${lineage.rootId}.jsonl`), "utf8");
  const r2Step = lineage.rootSteps[1]; // 第 2 轮末检查点（含 edit/new/long/bin）
  const r1Step = lineage.rootSteps[0];

  // ① 附件缺失：引用一个**只属于本标本**的哈希，且该 blob **不落盘**
  const missingId = "u2bad55_missing";
  const missingSha = sha256Buf(Buffer.from(MISSING_EXPECTED, "utf8"));
  writeFileSync(
    join(DATA_DIR, "traces", `${missingId}.jsonl`),
    deriveWithExtraFiles({
      baseText: rootText,
      oldWorldId: lineage.rootId,
      newId: missingId,
      newTask: "U2 5.5 附件缺失标本",
      stepId: r2Step,
      extraFiles: [
        {
          path: "u2bad-missing.txt",
          sha256: missingSha,
          bytes: Buffer.byteLength(MISSING_EXPECTED, "utf8"),
        },
      ],
    }),
    "utf8",
  );

  // ② 附件损坏：同法引用独立哈希，但该 blob 位置写入**等长的错字节**（只影响本标本）
  const corruptId = "u2bad55_corrupt";
  const corruptSha = sha256Buf(Buffer.from(CORRUPT_EXPECTED, "utf8"));
  writeFileSync(
    join(DATA_DIR, "traces", `${corruptId}.jsonl`),
    deriveWithExtraFiles({
      baseText: rootText,
      oldWorldId: lineage.rootId,
      newId: corruptId,
      newTask: "U2 5.5 附件损坏标本",
      stepId: r2Step,
      extraFiles: [
        {
          path: "u2bad-corrupt.txt",
          sha256: corruptSha,
          bytes: Buffer.byteLength(CORRUPT_EXPECTED, "utf8"),
        },
      ],
    }),
    "utf8",
  );

  // ③ 无自有完成步骤：挂到真实 root 下、剔掉自身 agent.step ⇒ 只剩初始快照
  const noOwnId = "u2bad55_noownsteps";
  writeFileSync(
    join(DATA_DIR, "traces", `${noOwnId}.jsonl`),
    deriveNoOwnSteps({
      baseText: rootText,
      newId: noOwnId,
      newTask: "U2 5.5 无自有完成步骤标本",
      parentId: lineage.rootId,
      resumeAfterStep: r1Step,
      atSpan: lineage.r1ToolId,
    }),
    "utf8",
  );

  // ── 自检：标本正确性靠**真实读取 API**钉住，不靠"看起来不同" ──────────
  const expect = (got, want, what) => {
    if (got !== want) throw new Error(`标本自检失败：${what} 期望 ${want}，实得 ${got}`);
  };
  if (existsSync(join(DATA_DIR, "workspace-blobs", "sha256", missingSha))) {
    throw new Error("缺失标本的哈希竟然有对应 blob —— 标本不成立");
  }
  if (existsSync(join(DATA_DIR, "workspace-blobs", "sha256", corruptSha))) {
    throw new Error("损坏标本的哈希竟然已存在 —— 会覆盖真实附件，必须换哈希");
  }
  // 损坏标本：写入错字节（blob 名 = 期望内容的哈希）
  mkdirSync(join(DATA_DIR, "workspace-blobs", "sha256"), { recursive: true });
  writeFileSync(
    join(DATA_DIR, "workspace-blobs", "sha256", corruptSha),
    CORRUPT_WRONG_BYTES,
    "utf8",
  );

  const readStatus = async (runId, stepSpanId, path) => {
    const r = await readWorkspaceFile({
      dataDir: DATA_DIR,
      runId,
      path,
      ...(stepSpanId === null ? {} : { stepSpanId }),
    });
    return r.status;
  };
  await (async () => {
    expect(await readStatus(lineage.rootId, r2Step, "edit.txt"), "text", "root 第2轮 edit.txt");
    expect(await readStatus(lineage.rootId, r2Step, "bin.dat"), "binary", "root 第2轮 bin.dat");
    expect(await readStatus(lineage.rootId, null, "bin.dat"), "binary", "root 初始 bin.dat");
    expect(await readStatus(lineage.rootId, null, "edit.txt"), "text", "root 初始 edit.txt");
    expect(
      await readStatus(lineage.rootId, r2Step, "u2bad-missing.txt"),
      "not_found",
      "root 不应有异常标本路径",
    );
    expect(await readStatus(missingId, r2Step, "u2bad-missing.txt"), "missing", "缺失标本");
    expect(await readStatus(corruptId, r2Step, "u2bad-corrupt.txt"), "corrupt", "损坏标本");
    // 无自有完成步骤 ⇒ 自有 agent.step 数为 0（这就是"未录制检查点"的判据）
    const noOwnRecord = readRun(join(DATA_DIR, "traces", `${noOwnId}.jsonl`));
    expect(
      noOwnRecord.spans.filter((s) => s.kind === "agent.step").length,
      0,
      "无自有完成步骤标本的自有 agent.step 数",
    );
    /**
     * ⚠️ **必须**走 `resolveBranch` 自检，不能只 `readRun` 本文件：
     * 桌面端"经运行列表读取"走的是分支解析（`loadRunRecord` → `resolveBranch`），
     * 它会对 `fork.at_span` / `resume_after_step` / `origin.step_span` 做交叉校验。
     * 只读本文件能过、经分支解析被拒，就是"标本看起来合法但实机读不出来"。
     */
    const { resolveBranch } = require("@rebaseagent/trace-sdk");
    const resolved = resolveBranch(noOwnId, (id) =>
      readRun(join(DATA_DIR, "traces", `${id}.jsonl`)),
    );
    expect(resolved.spans.length > 0, true, "分支解析应给出合并轨迹");
    expect(resolved.meta.id, noOwnId, "分支解析的叶子 id");
    const locatedInitial = locateWorkspaceSnapshot({ dataDir: DATA_DIR, runId: noOwnId });
    if (!locatedInitial.ok) throw new Error("无自有完成步骤标本的初始快照定位失败");
    expect(locatedInitial.value.snapshot.files.length > 0, true, "初始快照应有条目");
    // 祖先 step 不得用来定位本 run 的文件（越权判据的夹具侧对照）
    const ancestor = locateWorkspaceSnapshot({
      dataDir: DATA_DIR,
      runId: noOwnId,
      stepSpanId: r1Step,
    });
    expect(ancestor.ok, false, "祖先 step 定位本 run 应被拒绝");
  })();

  // ── 清单 ───────────────────────────────────────────────────────────
  const blobList = readdirSync(join(DATA_DIR, "workspace-blobs", "sha256")).map((name) => ({
    name,
    sha256: sha256Buf(readFileSync(join(DATA_DIR, "workspace-blobs", "sha256", name))),
  }));
  const manifest = {
    生成器: "apps/desktop/scripts/gen-u2-55-fixtures.cjs",
    说明:
      "5.5（IPC 安全 / 未录制与失败记录 / 只读不变性）专用夹具。R 与 E、F 为**真实引擎产物**；" +
      "u2bad55_* 为手工派生的**结构合法**异常标本，且各自的异常只引用**独立哈希**，" +
      "不触碰任何真实 run 的附件。",
    数据目录: { fixtureRoot: FIX_DIR, data: DATA_DIR, source: SOURCE_DIR },
    源目录: SOURCE_DIR,
    真实引擎: {
      root: { id: lineage.rootId, 步骤: lineage.rootSteps, 第2轮末: r2Step, 第1轮末: r1Step },
      fork: { id: lineage.forkId },
      errored: {
        id: lineage.erroredId,
        终止事件: lineage.erroredEvent,
        原因: lineage.erroredReason,
        自有步骤: lineage.erroredSteps,
      },
    },
    异常标本: {
      missing: {
        id: missingId,
        路径: "u2bad-missing.txt",
        检查点: r2Step,
        成因: "快照引用独立哈希，但对应 blob 未落盘 ⇒ 读取报 missing",
        期望哈希: missingSha,
      },
      corrupt: {
        id: corruptId,
        路径: "u2bad-corrupt.txt",
        检查点: r2Step,
        成因: "快照引用独立哈希，但该 blob 位置被写入错字节（长度也不符）⇒ 读取报 corrupt",
        期望哈希: corruptSha,
      },
      noCheckpoint: {
        id: noOwnId,
        父: lineage.rootId,
        成因: "挂到真实 root 下并剔掉自身全部 agent.step ⇒ 自有完成步骤数为 0（只剩初始快照）",
      },
    },
    文件世界: {
      a: A_TXT,
      edit初始: EDIT_INITIAL,
      edit第2轮: EDIT_R2,
      edit失败前写入: EDIT_ERRONED,
      new: NEW_TXT,
      keep: KEEP_TXT,
      二进制哈希: sha256Buf(BINARY_BYTES),
      二进制字节数: BINARY_BYTES.length,
    },
    附件清单: blobList,
  };
  writeFileSync(
    join(FIX_DIR, "MANIFEST-55.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  let installed = null;
  if (INSTALL) {
    // ⚠️ 损坏标本的"错字节" blob 也在 DATA_DIR 的 blob 目录里 ⇒ 由 install() 一并复制；
    //    它的**名字**是"期望内容的哈希"（本标本独有），且 installBlob 有 existsSync 守卫，
    //    因此绝不会覆盖任何真实 run 的附件。
    installed = install([
      lineage.rootId,
      lineage.forkId,
      lineage.erroredId,
      missingId,
      corruptId,
      noOwnId,
    ]);
    const corruptBlobDst = join(LIVE_DIR, "workspace-blobs", "sha256", corruptSha);
    if (readFileSync(corruptBlobDst, "utf8") !== CORRUPT_WRONG_BYTES) {
      throw new Error("损坏标本的错字节没有正确落进 live —— 实机会读到错误状态");
    }
    const missingBlobDst = join(LIVE_DIR, "workspace-blobs", "sha256", missingSha);
    if (existsSync(missingBlobDst)) {
      throw new Error("缺失标本的 blob 竟然存在于 live —— 实机会读到可读文件");
    }
  }

  process.stdout.write(
    [
      "已生成 U2 5.5 夹具：",
      `  真实引擎  root=${lineage.rootId}  fork=${lineage.forkId}  errored=${lineage.erroredId}`,
      `  异常标本  missing=${missingId}  corrupt=${corruptId}  no-own-steps=${noOwnId}`,
      `  源目录    ${SOURCE_DIR}`,
      installed === null
        ? "  未安装进 live 数据目录（--no-install）"
        : `  已安装：traces=${installed.traces.join(", ")}；新增附件 ${installed.blobsAdded} 份`,
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  process.stderr.write(`生成失败：${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
