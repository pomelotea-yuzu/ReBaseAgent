/**
 * 生成 U2 验收阶段 D-1 的夹具：**长文件清单**（让「文件目录列表」真的能滚动）。
 *
 * 为什么需要它（2026-09-24 验收复核）：
 *   5.3 的 `roundtrip` 已经在测「往返后列表滚动位置恢复」，但**当轮夹具的清单只可滚 2px**
 *   ⇒ 那一项只有"契约级 + 变异 M4"证据，实机证据力弱（`acceptance.md` 的 D-1，tasks 5.3 已如实标注）。
 *   要把它升级成实机强证据，只需要一份**清单够长**的 run：本脚本造 60 个文件的源目录。
 *
 * 形态：一条**隔离根 run**（2 轮：读 f01.txt → 收尾），completed、含 1 个自有完成步骤
 *   ⇒ 初始 vs 完成步骤两档清单都有 60 项 ⇒ 列表可滚（每行约 28px，60 行 ≈ 1680px ≫ 列表高度）。
 *
 * 用法：node apps/desktop/scripts/gen-u2-acc-list-fixtures.cjs [--no-install]
 */
"use strict";

const { copyFileSync, mkdirSync, readdirSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const FIX_DIR = join(REPO_ROOT, ".rebaseagent", "u2-acc-list");
const SOURCE_DIR = join(FIX_DIR, "source"); // 与 data 目录互为兄弟（validateSourceRoot 拒绝嵌套）
const DATA_DIR = join(FIX_DIR, "data");
const LIVE_DIR = join(REPO_ROOT, ".rebaseagent");
const INSTALL = !process.argv.includes("--no-install");

const FILE_COUNT = 60;

/** Mock LLM（CommonJS 重写 LlmClient 契约，与 1.1 / 5.4 / 5.5 / 5.6 同法） */
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

function isoConfig() {
  return {
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    model: "deepseek-chat",
    tools: [...require("@rebaseagent/replay").FILE_TOOLS_V1_DEFINITIONS],
    params: undefined,
    exec: { cwd: "D:/nope-not-a-real-dir", signal: null },
    maxIterations: 10,
    budget: { maxTotalTokens: 100000 },
  };
}

function prepareSource() {
  mkdirSync(SOURCE_DIR, { recursive: true });
  for (let i = 1; i <= FILE_COUNT; i++) {
    const n = String(i).padStart(2, "0");
    writeFileSync(join(SOURCE_DIR, `f${n}.txt`), `清单样本 ${n}\n第二行（${n}）\n`, "utf8");
  }
  // 一条长内容文件，供"打开文件"路径用
  writeFileSync(
    join(SOURCE_DIR, "list.txt"),
    `${Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 行：长清单样本`).join("\n")}\n`,
    "utf8",
  );
}

async function buildRun() {
  const { createIsolatedRun } = require("@rebaseagent/replay");
  const root = await createIsolatedRun({
    dataDir: DATA_DIR,
    source: SOURCE_DIR,
    config: isoConfig(),
    userMessage: "读一个文件后收尾（U2 D-1 长清单夹具）",
    authority: { allowFileWrites: true },
    llm: new MockLlmClient([
      { toolCalls: [{ id: "c1", name: "read_file", args: JSON.stringify({ path: "f01.txt" }) }] },
      { content: "长清单夹具 run 完成。" },
    ]),
  });
  if (!root.ok)
    throw new Error(`createIsolatedRun 失败：${root.failure.code} ${root.failure.reason}`);
  return { rootId: root.id, fileCount: FILE_COUNT + 1 };
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
    const to = join(destBlobs, name);
    try {
      copyFileSync(join(blobsSrc, name), to);
      result.blobsAdded += 1;
    } catch {
      /* 同名已存在（内容寻址，内容相同即同一 blob） */
    }
  }
  return result;
}

(async () => {
  prepareSource();
  const built = await buildRun();
  const installed = INSTALL ? install([built.rootId]) : null;
  writeFileSync(
    join(FIX_DIR, "MANIFEST-D1.json"),
    JSON.stringify(
      {
        生成器: "apps/desktop/scripts/gen-u2-acc-list-fixtures.cjs",
        用途: "D-1：长文件清单（60+1 项）⇒ 文件目录列表可滚，供 5.3 --tag=list-scroll 实机断言",
        长清单run: built.rootId,
        清单项数: built.fileCount,
        source: SOURCE_DIR,
        data: DATA_DIR,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`已生成长清单夹具 run=${built.rootId}（清单 ${built.fileCount} 项）`);
  console.log(
    installed === null
      ? "  未安装进 live（--no-install）"
      : `  已安装：traces=${installed.traces.join(", ")}；blob ${installed.blobsAdded} 份`,
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
