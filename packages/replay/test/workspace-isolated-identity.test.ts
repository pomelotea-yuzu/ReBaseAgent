import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Message, RunConfig } from "@rebaseagent/agent-loop";
import { readRun } from "@rebaseagent/trace-sdk";
import type { AgentStepSpan, ToolInvokeSpan } from "@rebaseagent/trace-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { WORKSPACE_TRACES_DIR_NAME, createIsolatedRun, replayIsolatedRun } from "../src/index";
import { ScriptedLlm, asLoopLlm, makeConfig, writeCall } from "./isolated-helpers";
import type { ScriptedTurn } from "./isolated-helpers";
import { cleanupTempDirs, makeTempDir, writeTree } from "./workspace-helpers";

/**
 * U4 任务 2.2 + 2.3：隔离创建与隔离 result 续跑的身份观察（`onRunIdentified`）。
 *
 * 判据来源：tasks.md 2.2/2.3 + design D5「已核实的身份来源」；delta spec `replay`。
 * 验收场景（delta 逐字标题）：
 * - 「隔离编排报告最终世界身份」——回调 ID 等于**最终** meta.id 与 `workspace.world_id`
 *   （checkpoint tracer 替换后的那一次），不报告 loop 内被替换的临时 ID；
 *   临时文件归位失败也**不撤销**已报告的身份（源/父/兄弟世界由 4.x 既有不变量用例保证，
 *   这里额外核对父文件字节一字未动）；
 * - 「拒绝和写入前失败没有运行身份」——授权缺失、profile 不符、预检失败与 meta 未写出
 *   一律零回调，且零模型调用、零落盘；
 * - 「可选观察不改变执行结果」——省略与抛错两种观察者的落盘文件集合完全相同。
 *
 * 父本一律真跑（真导入 → 真世界 → 真受控工具 → 真 runLoop 落盘），只替换 LLM 网络调用。
 */

const PARENT_SCRIPT: ScriptedTurn[] = [
  { toolCalls: [writeCall("c1", "out/a.txt", "T1")] },
  { toolCalls: [writeCall("c2", "out/b.txt", "T2")] },
  { content: "done" },
];
const CHILD_SCRIPT: ScriptedTurn[] = [{ content: "分叉后一步作答" }];

afterEach(cleanupTempDirs);

function tracesOf(dataDir: string): string {
  return join(dataDir, WORKSPACE_TRACES_DIR_NAME);
}

function jsonlFiles(dataDir: string): string[] {
  const dir = tracesOf(dataDir);
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".jsonl")) : [];
}

/** 真跑一个隔离根 run 作父本，返回其 id 与第一个 tool.invoke span id（默认分叉点） */
async function makeIsolatedParent(): Promise<{
  dataDir: string;
  parentId: string;
  atSpanId: string;
  parentFile: string;
}> {
  const source = makeTempDir("iso-id-src-");
  writeTree(source, { "seed.txt": "seed" });
  const dataDir = join(makeTempDir("iso-id-data-"), "data");
  const created = await createIsolatedRun({
    dataDir,
    source,
    config: makeConfig(),
    userMessage: "跑两轮",
    authority: { allowFileWrites: true },
    llm: asLoopLlm(new ScriptedLlm([...PARENT_SCRIPT])),
  });
  if (!created.ok) {
    throw new Error(`父本创建失败：${created.failure.code} ${created.failure.reason}`);
  }
  const parentFile = join(tracesOf(dataDir), `${created.id}.jsonl`);
  const record = readRun(parentFile);
  const step1 = record.spans.find(
    (span): span is AgentStepSpan => span.kind === "agent.step" && span.n === 1,
  );
  const tool1 =
    step1 === undefined
      ? undefined
      : record.spans.find(
          (span): span is ToolInvokeSpan => span.kind === "tool.invoke" && span.parent === step1.id,
        );
  if (tool1 === undefined) throw new Error("unreachable：父本第 1 轮必有 tool.invoke");
  return { dataDir, parentId: created.id, atSpanId: tool1.id, parentFile };
}

/** meta 已写出后破坏临时文件 ⇒ 收尾的 `readRun`/归位必然抛错，用来验证"归位失败不撤销身份" */
function corruptAfterFirstTurn(inner: ScriptedLlm, dataDir: string): unknown {
  let first = true;
  return {
    async complete(messages: Message[]) {
      const result = await inner.complete(messages);
      if (first) {
        first = false;
        const tmp = readdirSync(tracesOf(dataDir)).find((name) => name.startsWith("tmp-isolated-"));
        if (tmp !== undefined) {
          appendFileSync(join(tracesOf(dataDir), tmp), "{ 这不是合法的一行\n");
        }
      }
      return result;
    },
  };
}

describe("U4 2.2 createIsolatedRun 的身份观察", () => {
  it("报告最终世界身份：恰一次、等于落盘 meta.id 与 world_id、先于首次 LLM 调用", async () => {
    const source = makeTempDir("iso-id-src-");
    writeTree(source, { "seed.txt": "seed" });
    const dataDir = join(makeTempDir("iso-id-data-"), "data");
    const llm = new ScriptedLlm([
      { toolCalls: [writeCall("c1", "out/a.txt", "T1")] },
      { content: "done" },
    ]);
    const seen: { id: string; callsAtCallback: number }[] = [];
    const result = await createIsolatedRun({
      dataDir,
      source,
      config: makeConfig(),
      userMessage: "写一个文件",
      authority: { allowFileWrites: true },
      llm: asLoopLlm(llm),
      onRunIdentified: (id) => {
        seen.push({ id, callsAtCallback: llm.requests.length });
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ id: result.id, callsAtCallback: 0 });
    const record = readRun(join(tracesOf(dataDir), `${result.id}.jsonl`));
    // 三条身份必须同为"最终世界身份"：落盘文件名 = meta.id = world_id = 回调值
    expect(record.meta.id).toBe(result.id);
    expect(record.meta.workspace?.world_id).toBe(result.id);
    expect(jsonlFiles(dataDir)).toEqual([`${result.id}.jsonl`]);
  });

  it("省略观察者与抛错观察者的执行结果完全相同（观察者不成为新失败原因）", async () => {
    const observed: { landed: number; event: string; spans: number }[] = [];
    for (const mode of ["absent", "throws"] as const) {
      const source = makeTempDir("iso-id-src-");
      writeTree(source, { "seed.txt": "seed" });
      const dataDir = join(makeTempDir("iso-id-data-"), "data");
      const result = await createIsolatedRun({
        dataDir,
        source,
        config: makeConfig(),
        userMessage: "写一个文件",
        authority: { allowFileWrites: true },
        llm: asLoopLlm(
          new ScriptedLlm([
            { toolCalls: [writeCall("c1", "out/a.txt", "T1")] },
            { content: "done" },
          ]),
        ),
        onRunIdentified:
          mode === "absent"
            ? undefined
            : () => {
                throw new Error("观察者炸了");
              },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const files = jsonlFiles(dataDir);
      const record = readRun(join(tracesOf(dataDir), `${result.id}.jsonl`));
      observed.push({
        landed: files.length,
        event: result.outcome.event.event,
        spans: record.spans.length,
      });
    }
    expect(observed).toHaveLength(2);
    expect(observed[1]).toEqual(observed[0]);
    // 两次都是"一个可读的落盘 run"（id 本身带随机后缀，因此不比名字只比结构）
    expect(observed[0]).toEqual({ landed: 1, event: "stopped", spans: 5 });
  });

  it("预检拒绝（授权缺失 / profile 不符）⇒ 零回调、零落盘", async () => {
    let seen = 0;
    const noAuthorityDir = join(makeTempDir("iso-id-data-"), "data");
    const noAuthority = await createIsolatedRun({
      dataDir: noAuthorityDir,
      source: (() => {
        const source = makeTempDir("iso-id-src-");
        writeTree(source, { "seed.txt": "seed" });
        return source;
      })(),
      config: makeConfig(),
      userMessage: "写一个文件",
      authority: { allowFileWrites: "true" },
      llm: asLoopLlm(new ScriptedLlm([{ content: "不该被调用" }])),
      onRunIdentified: () => {
        seen += 1;
      },
    });
    expect(noAuthority.ok).toBe(false);
    expect(noAuthority.ok ? "" : noAuthority.failure.code).toBe("missing_authority");
    expect(seen).toBe(0);
    // 预检全部先于任何落盘副作用：连 dataDir 都不该存在
    expect(existsSync(noAuthorityDir)).toBe(false);

    const profileDir = join(makeTempDir("iso-id-data-"), "data");
    const base = makeConfig();
    const tampered: RunConfig = {
      ...base,
      // 逐字段核对的固定 profile：改一处 description 就是"换了工具表"
      tools: base.tools.map((tool) => ({ ...tool, description: `${tool.description}（被改过）` })),
    };
    const badProfile = await createIsolatedRun({
      dataDir: profileDir,
      source: (() => {
        const source = makeTempDir("iso-id-src-");
        writeTree(source, { "seed.txt": "seed" });
        return source;
      })(),
      config: tampered,
      userMessage: "写一个文件",
      authority: { allowFileWrites: true },
      llm: asLoopLlm(new ScriptedLlm([{ content: "不该被调用" }])),
      onRunIdentified: () => {
        seen += 1;
      },
    });
    expect(badProfile.ok).toBe(false);
    expect(badProfile.ok ? "" : badProfile.failure.code).toBe("profile_mismatch");
    expect(seen).toBe(0);
    expect(existsSync(profileDir)).toBe(false);
  });

  it("归位失败不撤销已知身份：收尾抛错时调用方已持有最终 ID，且未产出可读记录", async () => {
    const source = makeTempDir("iso-id-src-");
    writeTree(source, { "seed.txt": "seed" });
    const dataDir = join(makeTempDir("iso-id-data-"), "data");
    const seen: string[] = [];
    const inner = new ScriptedLlm([
      { toolCalls: [writeCall("c1", "out/a.txt", "T1")] },
      { content: "done" },
    ]);
    await expect(
      createIsolatedRun({
        dataDir,
        source,
        config: makeConfig(),
        userMessage: "写一个文件",
        authority: { allowFileWrites: true },
        llm: asLoopLlm(corruptAfterFirstTurn(inner, dataDir)),
        onRunIdentified: (id) => {
          seen.push(id);
        },
      }),
    ).rejects.toThrow();
    // 身份在 meta 写出的那一刻就已成立——收尾失败既不回收它，也不假装记录可读
    expect(seen).toHaveLength(1);
    expect(jsonlFiles(dataDir)).toEqual([]);
    expect(readdirSync(tracesOf(dataDir)).some((name) => name.endsWith(".tmp"))).toBe(true);
  });
});

describe("U4 2.3 replayIsolatedRun 的身份观察", () => {
  it("隔离续跑报告子 run 的最终世界身份，恰一次且先于子首次 LLM 调用", async () => {
    const parent = await makeIsolatedParent();
    const parentBytes = readFileSync(parent.parentFile, "utf8");
    const childLlm = new ScriptedLlm([...CHILD_SCRIPT]);
    const seen: { id: string; callsAtCallback: number }[] = [];
    const result = await replayIsolatedRun({
      dataDir: parent.dataDir,
      parentId: parent.parentId,
      atSpanId: parent.atSpanId,
      edit: { field: "result", value: "编辑后的工具结果" },
      config: makeConfig(),
      authority: { allowFileWrites: true },
      llm: asLoopLlm(childLlm),
      onRunIdentified: (id) => {
        seen.push({ id, callsAtCallback: childLlm.requests.length });
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(seen).toEqual([{ id: result.id, callsAtCallback: 0 }]);
    const child = readRun(join(tracesOf(parent.dataDir), `${result.id}.jsonl`));
    expect(child.meta.id).toBe(result.id);
    expect(child.meta.workspace?.world_id).toBe(result.id);
    // 子世界是**新**世界：既不同于父，也不同于回调里可能混入的父 id
    expect(child.meta.workspace?.world_id).not.toBe(parent.parentId);
    // 父本一字未动（前缀零重放由 4.3 既有用例负责，这里只守住"观察不带来改写"）
    expect(readFileSync(parent.parentFile, "utf8")).toBe(parentBytes);
    expect(jsonlFiles(parent.dataDir).sort()).toEqual(
      [`${parent.parentId}.jsonl`, `${result.id}.jsonl`].sort(),
    );
  });

  it("拒绝路径与写入前失败零回调：缺授权 / 非法分叉点都不给身份，也不落子文件", async () => {
    const parent = await makeIsolatedParent();
    let seen = 0;
    const noAuthority = await replayIsolatedRun({
      dataDir: parent.dataDir,
      parentId: parent.parentId,
      atSpanId: parent.atSpanId,
      edit: { field: "result", value: "编辑后的工具结果" },
      config: makeConfig(),
      authority: {},
      llm: asLoopLlm(new ScriptedLlm([...CHILD_SCRIPT])),
      onRunIdentified: () => {
        seen += 1;
      },
    });
    expect(noAuthority.ok).toBe(false);
    expect(seen).toBe(0);
    expect(jsonlFiles(parent.dataDir)).toEqual([`${parent.parentId}.jsonl`]);

    const badSpan = await replayIsolatedRun({
      dataDir: parent.dataDir,
      parentId: parent.parentId,
      atSpanId: "s_99",
      edit: { field: "result", value: "编辑后的工具结果" },
      config: makeConfig(),
      authority: { allowFileWrites: true },
      llm: asLoopLlm(new ScriptedLlm([...CHILD_SCRIPT])),
      onRunIdentified: () => {
        seen += 1;
      },
    });
    expect(badSpan.ok).toBe(false);
    expect(seen).toBe(0);
    expect(jsonlFiles(parent.dataDir)).toEqual([`${parent.parentId}.jsonl`]);
  });
});
