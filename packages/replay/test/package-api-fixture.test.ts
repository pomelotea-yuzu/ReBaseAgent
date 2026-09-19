import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentStepSpan, RunRecord } from "@rebaseagent/trace-sdk";
import { readRun } from "@rebaseagent/trace-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { WORKSPACE_TRACES_DIR_NAME, readWorkspaceFile, workspaceTraceFile } from "../src/index";
import { ScriptedLlm, readCall, writeCall } from "./isolated-helpers";
import {
  AFTER,
  BEFORE,
  CHILD,
  MIDDLE,
  SIBLING,
  blobFingerprint,
  blobPaths,
  createThreeRoundParent,
  fileOf,
  forkFromParent,
  hashMapOf,
  sha256OfFile,
  sha256OfText,
  stepsOf,
  toolsOf,
  treeFingerprint,
} from "./package-fixture";
import { cleanupTempDirs } from "./workspace-helpers";

/**
 * 7.1：包 API 三轮 fixture（before → middle → after）的哈希不变性。
 *
 * 验证点（tasks.md 7.1）：`replay/恢复历史中间文件而非最终文件`、`父文件不可变`、
 * `workspace-isolation/父子及并发兄弟隔离`。
 *
 * ## 与 4.3 / 4.4 的分工
 *
 * 4.3 断言的是"子从哪一轮恢复 + 前缀零调用"，4.4 断言的是三层链与并发映射隔离；**两者都只把
 * "父不可变"落到父 trace 文件的字节**。7.1 补的是另外两层：
 * 1. **父的附件存储**（`workspace-blobs/`）——子写 `child` 会往同一个 store 里发布新内容，
 *    "父的附件一份没被删、没被改"这件事必须逐项断言，而不是靠"store 里还有东西"；
 * 2. **兄弟哈希**——分叉点那一轮还有第二个工具（写 `b.txt`），它的效果必须原样留在子世界里。
 *
 * 另外这里的分叉**子 run 真的写文件**（4.3 的那条只读）。所以本文件同时覆盖了"隔离写入落进
 * 同一个附件存储但不污染父"这条路径。
 */

afterEach(cleanupTempDirs);

function lastStep(record: RunRecord): AgentStepSpan | undefined {
  return stepsOf(record).at(-1);
}

/** 从包只读接口读某 run 某个检查点里的文本（读不到就返回状态名，便于断言失败时一眼看出原因） */
async function readText(
  dataDir: string,
  runId: string,
  stepSpanId: string | undefined,
  path: string,
): Promise<string> {
  const result = await readWorkspaceFile({
    dataDir,
    runId,
    ...(stepSpanId === undefined ? {} : { stepSpanId }),
    path,
  });
  return result.status === "text" ? result.text : `<${result.status}>`;
}

describe("7.1 包 API 三轮 fixture：分叉恢复 middle 后写 child", () => {
  it("源目录、父 trace、父附件与兄弟哈希全不变", async () => {
    const parent = await createThreeRoundParent();
    const traceHashBefore = sha256OfFile(parent.traceFile);
    const blobsBefore = blobFingerprint(parent.dataDir);
    const sourceBefore = treeFingerprint(parent.source);

    // ── fixture 自检：中间态与最终态确实是**两份不同**的内容，且附件恰好是这 5 份 ─────────
    expect(hashMapOf(parent.step1)).toEqual({
      "a.txt": sha256OfText(MIDDLE),
      "b.txt": sha256OfText(SIBLING),
      "keep.txt": sha256OfText("keep"),
    });
    expect(hashMapOf(parent.steps[1])["a.txt"]).toBe(sha256OfText(AFTER));
    expect([...blobPaths(blobsBefore)].sort()).toEqual(
      [
        `sha256/${sha256OfText(BEFORE)}`,
        `sha256/${sha256OfText("keep")}`,
        `sha256/${sha256OfText(MIDDLE)}`,
        `sha256/${sha256OfText(SIBLING)}`,
        `sha256/${sha256OfText(AFTER)}`,
      ].sort(),
    );

    // ── 子：读 a（应得 middle）→ 写 a=child → 读回 child ────────────────────────────
    const childLlm = new ScriptedLlm([
      { toolCalls: [readCall("r1", "a.txt")] },
      { toolCalls: [writeCall("w1", "a.txt", CHILD)] },
      { toolCalls: [readCall("r2", "a.txt")] },
      { content: "done" },
    ]);
    const result = await forkFromParent(parent, { llm: childLlm });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const child = readRun(workspaceTraceFile(parent.dataDir, result.id));

    // 起点 = 轮 1 **轮末**检查点（a=middle、b=sibling），而不是父的最终态 after 或源现值 before
    const initial = child.meta.workspace?.initial_snapshot.files;
    expect(initial?.map((file) => file.path)).toEqual(["a.txt", "b.txt", "keep.txt"]);
    expect(fileOf(initial, "a.txt")?.sha256).toBe(sha256OfText(MIDDLE));
    expect(child.meta.workspace?.origin).toEqual({
      kind: "checkpoint",
      run_id: parent.runId,
      step_span: parent.step1.id,
    });

    const childTools = toolsOf(child);
    expect(childTools.map((tool) => tool.tool)).toEqual(["read_file", "write_file", "read_file"]);
    expect(String(childTools[0]?.result)).toBe(MIDDLE);
    expect(String(childTools[0]?.result)).not.toBe(AFTER);
    expect(childTools[1]?.error).toBeNull();
    // 隔离写入被后续读取观察到（写进的是子自己的世界）
    expect(String(childTools[2]?.result)).toBe(CHILD);

    // 子轮末检查点：a 变成 child，**兄弟 b 与旁观 keep 的哈希一个字都没动**
    expect(hashMapOf(lastStep(child))).toEqual({
      "a.txt": sha256OfText(CHILD),
      "b.txt": sha256OfText(SIBLING),
      "keep.txt": sha256OfText("keep"),
    });

    // ── 父的四个历史态经包只读接口原样可取（子 run 没动父的任何数据）────────────────────
    expect(await readText(parent.dataDir, parent.runId, undefined, "a.txt")).toBe(BEFORE);
    expect(await readText(parent.dataDir, parent.runId, parent.step1.id, "a.txt")).toBe(MIDDLE);
    expect(await readText(parent.dataDir, parent.runId, parent.step1.id, "b.txt")).toBe(SIBLING);
    expect(await readText(parent.dataDir, parent.runId, parent.steps[1]?.id, "a.txt")).toBe(AFTER);

    // ── 父附件：原有条目逐项原样保留，新增的恰好只有子新写的那一份内容 ──────────────────
    const blobsAfter = blobFingerprint(parent.dataDir);
    for (const entry of blobsBefore) {
      expect(blobsAfter, `父附件被改动或删除：${entry}`).toContain(entry);
    }
    expect([...blobPaths(blobsAfter)].sort()).toEqual(
      [...blobPaths(blobsBefore), `sha256/${sha256OfText(CHILD)}`].sort(),
    );

    // ── 父 trace 与源目录逐字节/指纹不变；源目录里从来没有 b.txt / child 内容 ────────────
    expect(sha256OfFile(parent.traceFile)).toBe(traceHashBefore);
    expect(treeFingerprint(parent.source)).toEqual(sourceBefore);
    expect(readFileSync(join(parent.source, "a.txt"), "utf8")).toBe(BEFORE);
    expect(existsSync(join(parent.source, "b.txt"))).toBe(false);
  });
});

describe("7.1 包 API 三轮 fixture：并发兄弟的附件层隔离", () => {
  it("两个分支各写自己的内容：附件各自独立，父已有附件逐项保留", async () => {
    const parent = await createThreeRoundParent();
    const traceHashBefore = sha256OfFile(parent.traceFile);
    const blobsBefore = blobPaths(blobFingerprint(parent.dataDir));

    const branchScript = (label: string, value: string) => [
      { toolCalls: [readCall(`r_${label}`, "a.txt")] },
      { toolCalls: [writeCall(`w_${label}`, "a.txt", value)] },
      { content: "done" },
    ];
    const [left, right] = await Promise.all([
      forkFromParent(parent, { llm: new ScriptedLlm(branchScript("l", "left")), editValue: "左" }),
      forkFromParent(parent, { llm: new ScriptedLlm(branchScript("r", "right")), editValue: "右" }),
    ]);
    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    if (!left.ok || !right.ok) {
      return;
    }

    const leftRecord = readRun(workspaceTraceFile(parent.dataDir, left.id));
    const rightRecord = readRun(workspaceTraceFile(parent.dataDir, right.id));

    // 两边都从**同一检查点**（a=middle）起步，随后各写各的
    expect(String(toolsOf(leftRecord)[0]?.result)).toBe(MIDDLE);
    expect(String(toolsOf(rightRecord)[0]?.result)).toBe(MIDDLE);
    expect(hashMapOf(lastStep(leftRecord))["a.txt"]).toBe(sha256OfText("left"));
    expect(hashMapOf(lastStep(rightRecord))["a.txt"]).toBe(sha256OfText("right"));
    // 兄弟 b.txt 与旁观 keep.txt 在两边都不变
    expect(hashMapOf(lastStep(leftRecord))["b.txt"]).toBe(sha256OfText(SIBLING));
    expect(hashMapOf(lastStep(rightRecord))["b.txt"]).toBe(sha256OfText(SIBLING));

    // 从包只读接口看：各自读到自己那份，**读不到对方的**
    expect(await readText(parent.dataDir, left.id, lastStep(leftRecord)?.id, "a.txt")).toBe("left");
    expect(await readText(parent.dataDir, right.id, lastStep(rightRecord)?.id, "a.txt")).toBe(
      "right",
    );
    expect(await readText(parent.dataDir, left.id, lastStep(leftRecord)?.id, "b.txt")).toBe(
      SIBLING,
    );

    // ── 附件层：父已有附件逐项保留；新增的恰好是两份新内容（不与父的任何一份重合）────────
    const blobsAfter = blobPaths(blobFingerprint(parent.dataDir));
    for (const entry of blobsBefore) {
      expect(blobsAfter, `父附件被改动或删除：${entry}`).toContain(entry);
    }
    expect(blobsAfter.filter((entry) => !blobsBefore.includes(entry)).sort()).toEqual(
      [`sha256/${sha256OfText("left")}`, `sha256/${sha256OfText("right")}`].sort(),
    );
    // 父 trace 不变；两个分支都归位成正式文件名（无临时残留）
    expect(sha256OfFile(parent.traceFile)).toBe(traceHashBefore);
    expect(readdirSync(join(parent.dataDir, WORKSPACE_TRACES_DIR_NAME)).sort()).toEqual(
      [left.id, parent.runId, right.id].map((id) => `${id}.jsonl`).sort(),
    );
  });

  it("两个分支写相同内容：附件存储只多一份（共享而不是各存一份）", async () => {
    const parent = await createThreeRoundParent();
    const blobsBefore = blobPaths(blobFingerprint(parent.dataDir));

    const sameScript = (label: string) => [
      { toolCalls: [writeCall(`w_${label}`, "a.txt", "same")] },
      { content: "done" },
    ];
    const [left, right] = await Promise.all([
      forkFromParent(parent, { llm: new ScriptedLlm(sameScript("l")), editValue: "左" }),
      forkFromParent(parent, { llm: new ScriptedLlm(sameScript("r")), editValue: "右" }),
    ]);
    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    if (!left.ok || !right.ok) {
      return;
    }

    const leftRecord = readRun(workspaceTraceFile(parent.dataDir, left.id));
    const rightRecord = readRun(workspaceTraceFile(parent.dataDir, right.id));
    // 两边检查点都指向**同一个哈希**，且那份附件能被两个 run 各自读出
    expect(hashMapOf(lastStep(leftRecord))["a.txt"]).toBe(sha256OfText("same"));
    expect(hashMapOf(lastStep(rightRecord))["a.txt"]).toBe(sha256OfText("same"));
    expect(await readText(parent.dataDir, left.id, lastStep(leftRecord)?.id, "a.txt")).toBe("same");
    expect(await readText(parent.dataDir, right.id, lastStep(rightRecord)?.id, "a.txt")).toBe(
      "same",
    );

    // 存储里只多了一份内容（并发去重在包 API 端到端路径上依然成立）
    expect([...blobPaths(blobFingerprint(parent.dataDir))].sort()).toEqual(
      [...blobsBefore, `sha256/${sha256OfText("same")}`].sort(),
    );
  });
});
