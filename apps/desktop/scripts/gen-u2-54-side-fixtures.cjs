/**
 * 生成 U2 任务 5.4 的「单侧不可用 + 另一侧可读文本」夹具（`side-data` / `side-broken`）。
 *
 * 5.4 要验的场景是 spec「不可用侧不伪装为空差异」：
 *   WHEN 任一侧处于加载/失败/拒绝/二进制/附件缺失或损坏，另一侧为可读文本
 *   THEN 两侧分别标出真实状态，**可读侧完整展示并可复制查找**，禁止把不可用侧置空进行 diff；
 *        左右互换同样成立。
 *
 * ── 为什么必须新造，而不是用既有夹具 ─────────────────────────────────
 *   既有 `iso-data` 里 `bin.dat` 在**每个检查点都是二进制**（初始侧也是二进制），
 *   只能覆盖「两侧都不可读」；`new.txt` 只能覆盖「初始侧 not_found + 所选侧文本」。
 *   「一侧二进制、另一侧可读文本」这一形态**在既有夹具里不存在**，而它恰好走
 *   另外两条渲染分支（`!comparability.ok` 与 `canEnterTextDiff` 失败）⇒ 不补就无法验收。
 *
 * ── 关键发现（决定了标本只能这样做）──────────────────────────────────
 *   **引擎的 `write_file` 永远写不出二进制**：它接受 JS 字符串并编码为 UTF-8，
 *   而读取侧用 `TextDecoder("utf-8", {fatal:true})` 判二进制（`packages/replay/src/workspace/utf8.ts`）
 *   —— 合法 UTF-8（含 NUL）仍判 `text`。所以「文本 → 后来变二进制」这种状态
 *   **引擎不会原生录制**。可达的只有两个方向：
 *     ① 【引擎原生】初始就二进制、之后被 `write_file` 覆盖成文本 ⇒ 初始侧不可用、所选侧可读；
 *     ② 【手工镜像标本】把某检查点快照里一条**文本**文件的哈希改指二进制附件
 *        ⇒ 所选侧不可用、初始侧可读（对应"左右互换"）。
 *   ② 与 1.1 的 `broken/*` 同一纪律：手工拼行的**结构合法**标本，`workspace.world_id`
 *   同步重写以通过读取器校验，且**只**让"同一路径在两轮之间换了字节"这一件事自相矛盾。
 *
 * 用法：node scripts/gen-u2-54-side-fixtures.cjs [--no-install]
 *   - 默认把两条 run 的 trace 与附件**安装进 live 数据目录**（`.rebaseagent/{traces,workspace-blobs}`），
 *     否则实机看不到它们（应用只读 live 数据目录）。
 */
"use strict";

const { createHash } = require("node:crypto");
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { readRun } = require("@rebaseagent/trace-sdk");
const { computeWorkspaceSnapshotId } = require("@rebaseagent/trace-sdk/workspace-hash");

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const FIX_DIR = join(REPO_ROOT, ".rebaseagent", "u2-file-fixtures");
const LIVE_DIR = join(REPO_ROOT, ".rebaseagent");
const INSTALL = !process.argv.includes("--no-install");

const MODEL = "deepseek-chat";

/** 二进制字节：含非法 UTF-8 续字节（0xff/0xfe）⇒ 读取侧判 `binary` */
const BINARY_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0x00, 0x01]);
const WAS_BINARY = "was-binary.dat"; // 初始=二进制 → 第 2 轮被写成文本
const STEADY = "steady.txt"; // 两侧都是文本（对照）
const NOW_TEXT = "现在是文本内容\n";
const STEADY_AFTER = "第二轮改写后的文本\n";

class MockLlmClient {
  constructor(script) {
    this.script = script;
    this.turn = 0;
  }

  async complete() {
    const turn = this.script[this.turn];
    this.turn += 1;
    if (turn === undefined) throw new Error(`剧本耗尽：第 ${this.turn} 轮无编排响应`);
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

function sha256Buf(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function prepareSource(source) {
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, WAS_BINARY), BINARY_BYTES);
  writeFileSync(join(source, STEADY), "初始文本内容\n", "utf8");
}

async function buildSideRun() {
  const { createIsolatedRun, FILE_TOOLS_V1_DEFINITIONS } = require("@rebaseagent/replay");
  const outer = mkdtempSync(join(tmpdir(), "u2side-"));
  const source = join(outer, "source");
  const dataDir = join(outer, "data");
  prepareSource(source);
  mkdirSync(dataDir, { recursive: true });

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
  const readCall = (id, path) => ({ id, name: "read_file", args: JSON.stringify({ path }) });
  const writeCall = (id, path, content) => ({
    id,
    name: "write_file",
    args: JSON.stringify({ path, content }),
  });

  const run = await createIsolatedRun({
    dataDir,
    source,
    config,
    userMessage: "先读二进制与文本，再把二进制那份改写成文本",
    authority: { allowFileWrites: true },
    llm: new MockLlmClient([
      // 第 1 轮：只读 ⇒ 建立"初始 = 二进制"的事实
      { toolCalls: [readCall("c1", WAS_BINARY), readCall("c2", STEADY)] },
      // 第 2 轮：把二进制那份写成文本 ⇒ 该检查点上"所选侧 = 文本、初始侧 = 二进制"
      { toolCalls: [writeCall("c3", WAS_BINARY, NOW_TEXT), writeCall("c4", STEADY, STEADY_AFTER)] },
      // 第 3 轮：收尾
      { content: "侧向夹具完成。" },
    ]),
  });
  if (!run.ok) throw new Error(`createIsolatedRun 失败：${run.failure.code} ${run.failure.reason}`);
  return { id: run.id, dataDir, source };
}

/**
 * 手工镜像标本：把某一轮的快照里 `path` 的哈希改指二进制附件
 * （得到"所选侧不可用（二进制）+ 初始侧可读文本"）。
 */
function deriveMirror({ baseText, oldWorldId, newId, newTask, stepId, path, sha256, bytes }) {
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
          for (const f of files) {
            if (f.path === path) {
              f.sha256 = sha256;
              f.bytes = bytes;
              patched += 1;
            }
          }
          // ⚠️ 改了条目 ⇒ 规范清单指纹必须重算：读取器会重算并比对 `snapshot.id`
          //    （`findSnapshotIdViolation`），只改条目不改 id 会在解析阶段就被拒。
          obj.workspace_snapshot.id = computeWorkspaceSnapshotId(files);
        }
      }
      if (
        obj.type === "span" &&
        obj.workspace !== undefined &&
        obj.workspace.world_id === oldWorldId
      ) {
        obj.workspace.world_id = newId;
      }
      return JSON.stringify(obj);
    })
    .join("\n")
    .concat("\n");
  if (patched !== 1) {
    throw new Error(`镜像标本没有恰好改到 1 条文件记录（实际 ${patched}）——字段名可能已变`);
  }
  return out;
}

function install(dataDir, ids) {
  const destTraces = join(LIVE_DIR, "traces");
  const destBlobs = join(LIVE_DIR, "workspace-blobs", "sha256");
  mkdirSync(destTraces, { recursive: true });
  mkdirSync(destBlobs, { recursive: true });
  const installed = { traces: [], blobs: 0 };
  for (const id of ids) {
    const from = join(dataDir, "traces", `${id}.jsonl`);
    const to = join(destTraces, `${id}.jsonl`);
    copyFileSync(from, to);
    installed.traces.push(id);
  }
  const blobDir = join(dataDir, "workspace-blobs", "sha256");
  for (const name of readdirSync(blobDir)) {
    const to = join(destBlobs, name);
    if (!existsSync(to)) {
      copyFileSync(join(blobDir, name), to);
      installed.blobs += 1;
    }
  }
  return installed;
}

function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, name.name);
    const to = join(dst, name.name);
    if (name.isDirectory()) copyDir(from, to);
    else copyFileSync(from, to);
  }
}

async function main() {
  const built = await buildSideRun();
  const record = readRun(join(built.dataDir, "traces", `${built.id}.jsonl`));
  const steps = record.spans.filter((s) => s.kind === "agent.step");
  if (steps.length < 2) throw new Error(`侧向夹具只有 ${steps.length} 个 agent.step，不足两轮`);
  const firstStep = steps[0].id;
  const secondStep = steps[1].id;

  // ① 引擎原生：初始=二进制 / 所选（第 2 轮末）=文本
  const sideDataDir = join(FIX_DIR, "side-data");
  rmSync(sideDataDir, { recursive: true, force: true });
  copyDir(built.dataDir, sideDataDir);

  // ② 手工镜像：把第 1 轮快照里的 steady.txt 改指二进制附件 ⇒ 所选=二进制 / 初始=文本
  const mirrorId = "u2side_mirror";
  const mirrorDir = join(FIX_DIR, "side-broken");
  rmSync(mirrorDir, { recursive: true, force: true });
  mkdirSync(join(mirrorDir, "traces"), { recursive: true });
  copyDir(join(sideDataDir, "workspace-blobs"), join(mirrorDir, "workspace-blobs"));
  const baseText = readFileSync(join(sideDataDir, "traces", `${built.id}.jsonl`), "utf8");
  writeFileSync(
    join(mirrorDir, "traces", `${mirrorId}.jsonl`),
    deriveMirror({
      baseText,
      oldWorldId: built.id,
      newId: mirrorId,
      newTask: "单侧二进制镜像标本（所选侧不可用）",
      stepId: firstStep,
      path: STEADY,
      sha256: sha256Buf(BINARY_BYTES),
      bytes: BINARY_BYTES.length,
    }),
    "utf8",
  );

  // 逐条自检：读出来的两侧状态必须与声明一致（标本正确性靠读数钉住，不靠"看起来不同"）
  const { locateWorkspaceSnapshot, readWorkspaceFile } = require("@rebaseagent/replay");
  const expect = (got, want, what) => {
    if (got !== want) throw new Error(`标本自检失败：${what} 期望 ${want}，实得 ${got}`);
  };
  const located = await locateWorkspaceSnapshot({
    dataDir: sideDataDir,
    runId: built.id,
    stepSpanId: secondStep,
  });
  if (!located.ok) throw new Error(`side-data 清单定位失败：${located.failure.code}`);
  const paths = located.value.snapshot.files.map((f) => f.path);
  if (!paths.includes(WAS_BINARY) || !paths.includes(STEADY)) {
    throw new Error(`side-data 清单缺条目：${JSON.stringify(paths)}`);
  }
  // ⚠️ 初始快照要**省略** stepSpanId（传 null 会被当成 step id 去查 ⇒ rejected）
  const check = async (dataDir, runId, stepSpanId, path, want) => {
    const r = await readWorkspaceFile({
      dataDir,
      runId,
      path,
      ...(stepSpanId === null ? {} : { stepSpanId }),
    });
    expect(r.status, want, `${runId}/${stepSpanId ?? "初始"}/${path}`);
  };
  await check(sideDataDir, built.id, secondStep, WAS_BINARY, "text");
  await check(sideDataDir, built.id, null, WAS_BINARY, "binary");
  await check(sideDataDir, built.id, secondStep, STEADY, "text");
  await check(sideDataDir, built.id, null, STEADY, "text");
  await check(mirrorDir, mirrorId, firstStep, STEADY, "binary");
  await check(mirrorDir, mirrorId, null, STEADY, "text");

  const manifest = {
    生成器: "apps/desktop/scripts/gen-u2-54-side-fixtures.cjs",
    说明:
      "5.4「不可用侧不伪装为空差异」专用夹具。side-data 为**真实引擎产物**；" +
      "side-broken 为手工镜像标本（引擎的 write_file 只能写合法 UTF-8，故" +
      "“所选侧二进制 + 初始侧文本”这一方向无法原生录制）。",
    引擎原生: {
      数据目录: "side-data",
      id: built.id,
      检查点: { 第1轮末: firstStep, 第2轮末: secondStep },
      两侧状态: {
        [WAS_BINARY]: { 初始侧: "binary", 所选侧_第2轮末: "text" },
        [STEADY]: { 初始侧: "text", 所选侧_第2轮末: "text" },
      },
    },
    手工镜像: {
      数据目录: "side-broken",
      id: mirrorId,
      检查点: { 第1轮末: firstStep },
      两侧状态: { [STEADY]: { 初始侧: "text", 所选侧_第1轮末: "binary" } },
      成因: "把第 1 轮快照里 steady.txt 的 sha256/bytes 改指二进制附件 ⇒ 所选侧不可用",
    },
    二进制字节: { sha256: sha256Buf(BINARY_BYTES), bytes: BINARY_BYTES.length },
  };
  writeFileSync(
    join(FIX_DIR, "SIDE-MANIFEST.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  let installed = null;
  if (INSTALL) installed = install(sideDataDir, [built.id]);
  if (INSTALL) {
    const extra = install(mirrorDir, [mirrorId]);
    installed.blobs += extra.blobs;
    installed.traces.push(...extra.traces);
  }

  process.stdout.write(
    [
      "已生成 5.4 侧向夹具：",
      `  side-data（引擎原生）${built.id}：初始侧 binary / 所选侧 text = ${WAS_BINARY}`,
      `  side-broken（手工镜像）${mirrorId}：初始侧 text / 所选侧 binary = ${STEADY}`,
      installed === null
        ? "  未安装进 live 数据目录（--no-install）"
        : `  已安装：traces=${installed.traces.join(", ")}；新增附件 ${installed.blobs} 份`,
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  process.stderr.write(`生成失败：${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
