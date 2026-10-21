import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { promptReplayIsolatedRun } from "../src/workspace/isolated-prompt-run";
import { ScriptedLlm, asLoopLlm, makeConfig } from "./isolated-helpers";
import {
  NEW_SYSTEM_PROMPT,
  buildIsolatedPromptBaselineCase,
} from "./isolated-prompt-baseline-fixture";
import { cleanupTempDirs, makeDataDir } from "./workspace-helpers";

/**
 * R2.2 任务 3.5：**trace 存储故障**下的收尾事实。
 *
 * 注入方式与 `workspace-trace-failure.test.ts` 同源：mock `node:fs` 的 `writeSync`，
 * 默认透传，只拦 trace 行；`openSync`/`closeSync` 配对计数作为"释放本次文件句柄"的直接证据
 * （本机 Windows 上未关闭也能改名，所以"能 rename"判不出句柄是否释放）。
 *
 * 判据：
 * - meta 行写失败 ⇒ 零 LLM、零身份、临时文件未归位、句柄已释放；
 * - 首轮 step 行写失败 ⇒ 身份已通知且可关联，落盘记录为 crashed（无虚假终止事件），
 *   v3 实验记录保留，句柄已释放；已发布附件不被删除。
 */

const injector = vi.hoisted(() => ({
  failOn: null as null | ((line: string) => boolean),
  written: [] as string[],
  handles: { opened: new Set<number>(), closed: new Set<number>() },
}));

function isTraceFile(value: unknown): value is string {
  return typeof value === "string" && /[\\/]traces[\\/]/.test(value);
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const writeSync = ((...args: unknown[]) => {
    const data = args[1];
    if (typeof data === "string" && /"type":"(run\.meta|span|run\.event)"/.test(data)) {
      injector.written.push(data);
      if (injector.failOn?.(data) === true) {
        injector.failOn = null;
        throw Object.assign(new Error("注入的 trace 写失败（ENOSPC）"), { code: "ENOSPC" });
      }
    }
    return (actual.writeSync as unknown as (...a: unknown[]) => number)(...args);
  }) as unknown as typeof actual.writeSync;

  const openSync = ((...args: unknown[]) => {
    const fd = (actual.openSync as unknown as (...a: unknown[]) => number)(...args);
    if (isTraceFile(args[0])) injector.handles.opened.add(fd);
    return fd;
  }) as unknown as typeof actual.openSync;

  const closeSync = ((...args: unknown[]) => {
    if (typeof args[0] === "number") injector.handles.closed.add(args[0]);
    return (actual.closeSync as unknown as (...a: unknown[]) => void)(...args);
  }) as unknown as typeof actual.closeSync;

  return { ...actual, writeSync, openSync, closeSync };
});

afterEach(() => {
  injector.failOn = null;
  injector.written.length = 0;
  injector.handles.opened.clear();
  injector.handles.closed.clear();
  cleanupTempDirs();
});

function leakedHandles(): number[] {
  return [...injector.handles.opened].filter((fd) => !injector.handles.closed.has(fd));
}

async function prepare() {
  const tmp = makeDataDir();
  const fixture = await buildIsolatedPromptBaselineCase({ dataDir: tmp.dataDir });
  injector.failOn = null;
  injector.written.length = 0;
  injector.handles.opened.clear();
  injector.handles.closed.clear();
  return { tmp, fixture };
}

describe("promptReplayIsolatedRun：trace 存储故障", () => {
  it("meta 行写失败：零模型调用、零身份、临时文件不归位、句柄释放", async () => {
    const { tmp, fixture } = await prepare();
    const traces = join(tmp.dataDir, "traces");
    const before = new Set(readdirSync(traces));
    injector.failOn = (line) => line.includes('"type":"run.meta"');

    const llm = new ScriptedLlm([{ content: "不该被调用" }]);
    const identities: string[] = [];
    await expect(
      promptReplayIsolatedRun({
        dataDir: tmp.dataDir,
        rootId: fixture.root.runId,
        edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
        config: makeConfig(),
        authority: { allowFileWrites: true },
        llm: asLoopLlm(llm),
        onRunIdentified: (id) => identities.push(id),
      }),
    ).rejects.toThrow();

    expect(injector.written).toHaveLength(1);
    expect(injector.written[0]).toContain('"type":"run.meta"');
    expect(llm.requests).toHaveLength(0);
    expect(identities).toEqual([]);

    const after = readdirSync(traces);
    const newFiles = after.filter((name) => !before.has(name));
    expect(newFiles).toHaveLength(1);
    expect(newFiles[0]?.endsWith(".jsonl")).toBe(false); // 没有伪造出正式 run 名
    // 未归位的空临时文件读取层直接拒绝，不可能被当成父本
    expect(() => readRun(join(traces, newFiles[0] ?? ""))).toThrow();
    expect(leakedHandles()).toEqual([]);
  });

  it("首轮 step 行写失败：身份可关联、落盘 crashed 无假终止、v3 记录保留、句柄释放", async () => {
    const { tmp, fixture } = await prepare();
    const traces = join(tmp.dataDir, "traces");
    injector.failOn = (line) => line.includes('"kind":"agent.step"') && line.includes('"n":1');

    const llm = new ScriptedLlm([{ content: "完成" }]);
    const identities: string[] = [];
    await expect(
      promptReplayIsolatedRun({
        dataDir: tmp.dataDir,
        rootId: fixture.root.runId,
        edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
        config: makeConfig(),
        authority: { allowFileWrites: true },
        llm: asLoopLlm(llm),
        onRunIdentified: (id) => identities.push(id),
      }),
    ).rejects.toThrow();

    expect(llm.requests).toHaveLength(1);
    expect(injector.written.some((line) => line.includes('"kind":"agent.step"'))).toBe(true);

    const landed = readdirSync(traces).find(
      (name) => name.endsWith(".jsonl") && !name.startsWith("rpex-"),
    );
    expect(landed).toBeDefined();
    if (landed === undefined) return;
    const text = readFileSync(join(traces, landed), "utf8");
    expect(text).not.toContain('"type":"run.event"');
    for (const line of text.split("\n").filter((l) => l.trim().length > 0)) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }

    const record = readRun(join(traces, landed));
    expect(record.status).toBe("crashed");
    expect(record.meta.id).toBe(identities[0]);
    expect(record.meta.format_version).toBe(3);
    expect(record.meta.prompt_experiment).toBeDefined();
    expect(record.meta.workspace?.origin.kind).toBe("initial");

    // 已发布的共享附件不因本次失败被清理
    const blobs = readdirSync(join(tmp.dataDir, "workspace-blobs", "sha256"));
    expect(blobs).toContain(fixture.root.initialFiles[0]!.sha256);
    expect(leakedHandles()).toEqual([]);
  });

  it("临时文件清理：未归位文件可由测试删除（句柄确已释放）", async () => {
    const { tmp, fixture } = await prepare();
    const traces = join(tmp.dataDir, "traces");
    const before = new Set(readdirSync(traces));
    injector.failOn = (line) => line.includes('"type":"run.meta"');
    await expect(
      promptReplayIsolatedRun({
        dataDir: tmp.dataDir,
        rootId: fixture.root.runId,
        edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
        config: makeConfig(),
        authority: { allowFileWrites: true },
        llm: asLoopLlm(new ScriptedLlm([{ content: "x" }])),
      }),
    ).rejects.toThrow();
    const newFile = readdirSync(traces).find((name) => !before.has(name));
    expect(newFile).toBeDefined();
    expect(() => rmSync(join(traces, newFile ?? ""))).not.toThrow();
    expect(readdirSync(traces).filter((name) => !before.has(name))).toEqual([]);
  });
});
