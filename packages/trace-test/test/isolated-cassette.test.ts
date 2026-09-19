import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@rebaseagent/agent-loop";
import { afterEach, describe, expect, it } from "vitest";
import { rerunWithCassette, runTraceTest } from "../src/index";
import { fakeConfig, fakeTools, writeIsolatedCassetteTrace } from "./helpers";

/**
 * 4.6：**隔离 trace 的卡带（Trace-as-Test）兼容**。
 *
 * 验证点（tasks.md 4.6）：`卡带路径保持录制结果语义` —— "仅消费录制 LLM/tool 结果，不访问文件世界
 * 或真实 handler，结构对齐不因快照元数据变化失败，报告不称其为隔离真实执行"。
 *
 * ## 基线是"隔离 v2 + 附件故意不存在"
 *
 * 文件世界在卡带路径里**根本不该被打开**，所以最直接的证据就是：基线里连 `workspace-blobs/` 都
 * 没有，重跑照样通过。第二个证据更强——**工具声明挂一个"一执行就抛"的 handler**：若卡带偷偷
 * 落到真实 handler，用例立刻炸。
 *
 * ## "忽略快照字段"用两条清单不同的基线证明
 *
 * 只跑一条对齐不过是在说"它没崩"。对照两条 `initial_snapshot` 内容不同的基线各自对齐通过，
 * 才说明结构对齐**确实忽略** `workspace_snapshot`（而不是碰巧两边一样）。
 *
 * ⚠️ 4.5 起，隔离父本不得进入普通执行路径（`replayRun` / `loadForkParent`）。**卡带不走那条门禁**：
 * 它消费录制结果与桩工具、不加载文件世界（design §6），隔离基线照样能当测试基线用。
 */

const tempDirs: string[] = [];

function makeTempDir(prefix = "isolated-cassette-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 工具声明：handler 一旦被执行就抛——用来证明卡带走的是桩工具 */
function explodingTools(): Tool[] {
  return fakeTools().map((tool) => ({
    ...tool,
    handler: () => {
      throw new Error("真实 handler 不得在卡带模式执行");
    },
  }));
}

describe("4.6：隔离 trace 可作卡带基线", () => {
  it("附件不可用 + handler 会抛：卡带重跑仍对齐通过，且产出普通 v1 轨迹", async () => {
    const dir = makeTempDir();
    const fixture = writeIsolatedCassetteTrace(dir);

    // 基线是隔离 v2，且**没有任何附件**（连目录都没有）
    expect(fixture.record.meta.workspace?.profile).toBe("file-tools-v1");
    expect(fixture.record.meta.format_version).toBe(2);
    expect(existsSync(join(dir, "workspace-blobs"))).toBe(false);

    const result = await rerunWithCassette({
      record: fixture.record,
      config: fakeConfig(),
      tools: explodingTools(),
    });

    // 只消费录制结果：结构对齐通过、零配置漂移
    expect(result.alignment.aligned).toBe(true);
    expect(result.configDrift).toBeNull();
    // 重跑产出的新轨迹是**普通 v1**（隔离元数据不会被复制过去——卡带不是隔离真实执行）
    expect(result.record.meta.format_version).toBe(1);
    expect(result.record.meta.workspace).toBeUndefined();
    // 零文件副作用：目录里只有那条基线（卡带模式全程 headless）
    expect(readdirSync(dir)).toEqual([`${fixture.runId}.jsonl`]);
  });

  it("结构对齐忽略 workspace_snapshot：两条清单不同的基线各自对齐通过", async () => {
    const a = writeIsolatedCassetteTrace(makeTempDir(), {
      runId: "run_isolated_a",
      snapshotPath: "a.txt",
    });
    const b = writeIsolatedCassetteTrace(makeTempDir(), {
      runId: "run_isolated_b",
      snapshotPath: "完全不同的路径.txt",
    });

    // 对照前提：两条基线的起点清单**确实不同**（否则"忽略"这条证明不了）
    expect(a.record.meta.workspace?.initial_snapshot.id).not.toBe(
      b.record.meta.workspace?.initial_snapshot.id,
    );
    expect(a.record.meta.workspace?.initial_snapshot.files.map((f) => f.path)).toEqual(["a.txt"]);
    expect(b.record.meta.workspace?.initial_snapshot.files.map((f) => f.path)).toEqual([
      "完全不同的路径.txt",
    ]);

    const ra = await rerunWithCassette({
      record: a.record,
      config: fakeConfig(),
      tools: fakeTools(),
    });
    const rb = await rerunWithCassette({
      record: b.record,
      config: fakeConfig(),
      tools: fakeTools(),
    });

    expect(ra.alignment.aligned).toBe(true);
    expect(rb.alignment.aligned).toBe(true);
  });

  it("runner 端到端：隔离基线跑 trace.shape 断言 → passed / mode=cassette", async () => {
    const dir = makeTempDir();
    const fixture = writeIsolatedCassetteTrace(dir);
    const definitionFile = join(dir, "case.json");
    writeFileSync(
      definitionFile,
      JSON.stringify(
        {
          format_version: 1,
          name: "isolated-cassette",
          trace: `${fixture.runId}.jsonl`,
          assertions: [
            { type: "run.outcome", equals: "completed" },
            { type: "span.count", selector: { kind: "tool.invoke" }, equals: 1 },
            { type: "span.exists", selector: { kind: "tool.invoke", tool: "read_file" } },
            { type: "trace.shape" },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await runTraceTest(definitionFile, {
      config: fakeConfig(),
      tools: explodingTools(),
    });

    expect(result.status).toBe("passed");
    // 报告声明的是**卡带模式**，不是"隔离真实执行"
    expect(result.mode).toBe("cassette");
    expect(result.alignment?.aligned).toBe(true);
    expect(result.configDrift).toBeNull();
    expect(result.assertions.every((assertion) => assertion.passed)).toBe(true);
  });
});
