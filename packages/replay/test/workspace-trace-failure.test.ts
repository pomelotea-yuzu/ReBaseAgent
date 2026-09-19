import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_BLOBS_DIR_NAME,
  WORKSPACE_TRACES_DIR_NAME,
  createIsolatedRun,
  preflightIsolatedReplay,
  readWorkspaceFile,
  workspaceTraceFile,
} from "../src/index";
import { ScriptedLlm, asLoopLlm, makeConfig, writeCall } from "./isolated-helpers";
import {
  createThreeRoundParent,
  sha256OfFile,
  sha256OfText,
  stepsOf,
  treeFingerprint,
} from "./package-fixture";
import { cleanupTempDirs, makeTempDir, writeTree } from "./workspace-helpers";

/**
 * 7.2（二）：**trace 写失败** 与 **blob 发布后中断**。
 *
 * 验证点（tasks.md 7.2）：`workspace-isolation/存储故障释放资源`、`中断与数据目录迁移`
 * 的前半句，以及"孤立 blob / 临时 trace 不得成为完整父本"。
 * spec 原文：*"执行在 blob 发布后但检查点落盘前中断 → 前者只承认已落盘的 trace 状态，
 * 孤立 blob 不成为检查点"*；*"trace 写入失败或导入失败导致本次编排提前退出 → 释放本次文件
 * 句柄及临时资源，保留未封存记录，不追加虚假终止事件、不删除父/兄弟或共享附件"*。
 *
 * ## 注入方式：mock `node:fs` 的 `writeSync`，默认透传
 *
 * 真实磁盘满 / 句柄失效无法稳定复现，而"写入失败时编排如何收尾"只有在**写的那一刻**才可观测
 * （2.2 的 I/O 故障注入同套路）。做法：`vi.hoisted` 存一个注入器，`vi.mock("node:fs")` 包住
 * `writeSync`——**默认仍调用真实实现**，只在用例显式排入一次故障时接管，且只拦 trace 行
 * （`"type":"span"` / `"type":"run.event"` 等），不误伤测试自身的文件操作。
 *
 * 为什么单独一个文件：mock 会替换整个模块图里的 `node:fs`，放在别的用例旁边会让"这些用例
 * 到底跑在真实 fs 上还是 mock 上"变得含混。
 *
 * ## 两个用例的差别：失败点在哪一行
 *
 * - **用例 1**：第 1 轮的 `agent.step` 行写失败 ⇒ 已完成 1 轮工具（附件已发布），但连第一份
 *   检查点都没落盘 ⇒ 检验"未封存 + 句柄释放 + 不追加虚假终止事件"。
 * - **用例 2**：第 2 轮的 `agent.step` 行写失败 ⇒ 第 2 轮的工具**已经改了文件并发布了附件**，
 *   而引用它的检查点没落盘 ⇒ 检验"孤立 blob 不成为检查点、已落盘的第 1 轮检查点仍可读、
 *   孤立 blob 不能拼出一个可用父本"。
 */

/** 待注入的写失败：匹配到就是"这一次写属于本次故障" */
const injector = vi.hoisted(() => ({
  /** 返回 true 表示这一行写失败（随后自动解除，只注入一次） */
  failOn: null as null | ((line: string) => boolean),
  /** 被拦到的 trace 行（探针与断言共用） */
  written: [] as string[],
  /**
   * 本次用例里 trace 文件句柄的开关配对。
   *
   * 这是"释放本次文件句柄"的**直接**证据：本机实测 Node 在 Windows 上以 `FILE_SHARE_DELETE`
   * 打开文件，未关闭也能 rename/rm ⇒ "能改名"根本判不出句柄有没有关（见 tasks.md 实现期发现）。
   * 只有拦 `openSync`/`closeSync` 数配对，才能在跨平台上真的测到这件事。
   */
  handles: { opened: new Set<number>(), closed: new Set<number>() },
}));

/** 隔离 run 的 trace 文件路径（`<dataDir>/traces/...`） */
function isTraceFile(value: unknown): value is string {
  return typeof value === "string" && /[\\/]traces[\\/]/.test(value);
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const writeSync = ((...args: unknown[]) => {
    const data = args[1];
    // 只拦 trace 的行（meta / span / event），不误伤测试自身与其他模块的文件写入
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
    if (isTraceFile(args[0])) {
      injector.handles.opened.add(fd);
    }
    return fd;
  }) as unknown as typeof actual.openSync;

  const closeSync = ((...args: unknown[]) => {
    const fd = args[0];
    if (typeof fd === "number") {
      injector.handles.closed.add(fd);
    }
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

/** 泄漏的 trace 句柄（空数组 = 本次编排打开的句柄都关了） */
function leakedTraceHandles(): number[] {
  return [...injector.handles.opened].filter((fd) => !injector.handles.closed.has(fd));
}

/** 让"第 n 轮的 agent.step 行"写失败 */
function failOnStep(n: number): void {
  injector.failOn = (line) =>
    line.includes('"kind":"agent.step"') && line.includes(`"n":${String(n)}`);
}

interface Setup {
  readonly source: string;
  readonly dataDir: string;
}

function makeSetup(): Setup {
  const source = makeTempDir("fail-src-");
  writeTree(source, { "seed.txt": "seed" });
  return { source, dataDir: join(makeTempDir("fail-data-"), "data") };
}

function tracesDirOf(dataDir: string): string {
  return join(dataDir, WORKSPACE_TRACES_DIR_NAME);
}

describe("7.2 trace 写失败", () => {
  it("第 1 轮检查点写失败：抛错收尾、未封存、句柄已释放、不追加虚假终止事件", async () => {
    const setup = makeSetup();
    injector.written.length = 0;
    failOnStep(1);

    const llm = new ScriptedLlm([
      { toolCalls: [writeCall("c1", "a.txt", "X")] },
      { content: "done" },
    ]);

    // 写失败是真实 I/O 故障 ⇒ 不是"可通过预检拒绝的返回值"，而是抛错
    await expect(
      createIsolatedRun({
        dataDir: setup.dataDir,
        source: setup.source,
        config: makeConfig(),
        userMessage: "写入会失败",
        authority: { allowFileWrites: true },
        llm: asLoopLlm(llm),
      }),
    ).rejects.toThrow();

    // 探针自检：注入确实命中了 trace 写入（否则本用例什么都没测到）
    expect(injector.written.length).toBeGreaterThan(0);
    expect(injector.written.some((line) => line.includes('"kind":"agent.step"'))).toBe(true);

    const files = readdirSync(tracesDirOf(setup.dataDir)).sort();
    expect(files.length).toBeGreaterThan(0);
    // 不追加虚假终止事件：落盘的每一行里都没有 run.event（这份记录是"未封存"的）
    for (const name of files) {
      const text = readFileSync(join(tracesDirOf(setup.dataDir), name), "utf8");
      expect(text).not.toContain('"run.event"');
      // append-only 的行原子性：写失败不会留下半行
      for (const line of text.split("\n").filter((l) => l.trim().length > 0)) {
        expect(() => JSON.parse(line) as unknown).not.toThrow();
      }
    }

    // 归位形态：编排层的 finally 会在 tmp 可被 readRun 解析时归位成 `<id>.jsonl`
    // —— 落盘的仍是**事故现场**，读取层判 crashed、预检拒绝分叉（见下）。
    const landedName = files.find((name) => name.endsWith(".jsonl"));
    expect(landedName).toBeDefined();
    const landed = readRun(join(tracesDirOf(setup.dataDir), landedName ?? ""));
    expect(landed.status).toBe("crashed");

    // 未封存运行不可分叉：孤立 blob / 半截 trace 都不能拼成一个可用父本
    const capability = await preflightIsolatedReplay({
      dataDir: setup.dataDir,
      parentId: landed.meta.id,
      atSpanId: landed.spans.find((span) => span.kind === "tool.invoke")?.id ?? "",
      edit: { field: "result", value: "想把半截 run 当父本" },
      config: makeConfig(),
    });
    expect(capability.ok).toBe(false);
    if (!capability.ok) {
      expect(capability.failure.code).toBe("parent_not_forkable");
    }

    // 已发布的附件不被删除（共享内容不因本次失败被清）
    expect(existsSync(join(setup.dataDir, WORKSPACE_BLOBS_DIR_NAME))).toBe(true);

    // **释放本次文件句柄**：本次编排打开的 trace 句柄全部关闭（见 `injector.handles` 的注释
    // ——"能改名"在本机判不出这件事，只有开关配对能）
    expect(injector.handles.opened.size).toBeGreaterThan(0);
    expect(leakedTraceHandles()).toEqual([]);
  });

  it("最早期的 meta 行写失败：留下未归位的临时 trace，读取层直接拒绝，不可能成为父本", async () => {
    const setup = makeSetup();
    injector.written.length = 0;
    injector.failOn = (line) => line.includes('"type":"run.meta"');

    const llm = new ScriptedLlm([{ content: "done" }]);
    await expect(
      createIsolatedRun({
        dataDir: setup.dataDir,
        source: setup.source,
        config: makeConfig(),
        userMessage: "开场就写不进去",
        authority: { allowFileWrites: true },
        llm: asLoopLlm(llm),
      }),
    ).rejects.toThrow();

    // 注入命中的是第一行 meta（不是别的行），且模型一次都没被调用
    expect(injector.written).toHaveLength(1);
    expect(injector.written[0]).toContain('"type":"run.meta"');
    expect(llm.requests).toHaveLength(0);

    // 未归位：目录里只有临时文件，没有伪造出来的正式 run 名
    const files = readdirSync(tracesDirOf(setup.dataDir));
    expect(files).toHaveLength(1);
    const only = files[0] ?? "";
    if (only === "") {
      return;
    }
    expect(only.endsWith(".jsonl")).toBe(false);
    // 临时 trace 不是合法 run：读取层直接拒绝 ⇒ 它不可能被当成父本使用
    expect(() => readRun(join(tracesDirOf(setup.dataDir), only))).toThrow();
    // 句柄已释放：能删掉临时文件就是证据（Windows 上 Node 允许删打开的文件，所以这条只作旁证）
    expect(() => rmSync(join(tracesDirOf(setup.dataDir), only))).not.toThrow();
    expect(readdirSync(tracesDirOf(setup.dataDir))).toHaveLength(0);
    // 直接证据：打开过、且已关闭
    expect(injector.handles.opened.size).toBeGreaterThan(0);
    expect(leakedTraceHandles()).toEqual([]);
  });
});

describe("7.2 blob 发布后中断", () => {
  it("第 2 轮检查点写失败：工具改的文件成为孤立 blob，不进入任何已落盘清单", async () => {
    const setup = makeSetup();
    injector.written.length = 0;
    failOnStep(2);

    const llm = new ScriptedLlm([
      { toolCalls: [writeCall("c1", "a.txt", "middle")] },
      { toolCalls: [writeCall("c2", "a.txt", "after")] },
      { content: "done" },
    ]);
    await expect(
      createIsolatedRun({
        dataDir: setup.dataDir,
        source: setup.source,
        config: makeConfig(),
        userMessage: "第 2 轮检查点写失败",
        authority: { allowFileWrites: true },
        llm: asLoopLlm(llm),
      }),
    ).rejects.toThrow();

    // 第 2 轮的工具真执行过：它的 tool.invoke 行在 trace 里，且结果是成功写入
    const landed = readdirSync(tracesDirOf(setup.dataDir)).find((name) => name.endsWith(".jsonl"));
    expect(landed).toBeDefined();
    if (landed === undefined) {
      return;
    }
    const record = readRun(join(tracesDirOf(setup.dataDir), landed));
    expect(record.status).toBe("crashed"); // 未封存 ⇒ 不可分叉
    const tools = record.spans.filter((span) => span.kind === "tool.invoke");
    expect(tools).toHaveLength(2);

    // 孤立 blob：第 2 轮写入的内容确实已发布到附件存储……
    expect(
      existsSync(join(setup.dataDir, WORKSPACE_BLOBS_DIR_NAME, "sha256", sha256OfText("after"))),
    ).toBe(true);
    // ……但它不在任何**已落盘**的清单里（第 2 轮的检查点没写成，进程就断了）
    const snapshots = stepsOf(record).map((step) => step.workspace_snapshot);
    expect(snapshots).toHaveLength(1);
    const pathsOf = (): string[] => (snapshots[0]?.files ?? []).map((file) => file.path);
    expect(pathsOf()).toEqual(["a.txt", "seed.txt"]);
    expect(snapshots[0]?.files.find((file) => file.path === "a.txt")?.sha256).toBe(
      sha256OfText("middle"),
    );

    // 只承认已落盘的 trace 状态：第 1 轮检查点仍可读（事故现场可读，读取不是分叉）
    const readA = await readWorkspaceFile({
      dataDir: setup.dataDir,
      runId: record.meta.id,
      stepSpanId: stepsOf(record)[0]?.id,
      path: "a.txt",
    });
    expect(readA.status).toBe("text");
    if (readA.status === "text") {
      expect(readA.text).toBe("middle");
    }
    // 初始快照也照旧（源目录那份）
    const readSeed = await readWorkspaceFile({
      dataDir: setup.dataDir,
      runId: record.meta.id,
      path: "seed.txt",
    });
    expect(readSeed.status).toBe("text");

    // 孤立 blob 不得成为完整父本：以这个 crashed run 为父本的预检被拒，且零副作用
    const traceHashBefore = sha256OfFile(workspaceTraceFile(setup.dataDir, record.meta.id));
    const treeBefore = treeFingerprint(setup.dataDir);
    const capability = await preflightIsolatedReplay({
      dataDir: setup.dataDir,
      parentId: record.meta.id,
      atSpanId: tools[0]?.id ?? "",
      edit: { field: "result", value: "想把孤立 blob 当父本" },
      config: makeConfig(),
    });
    expect(capability.ok).toBe(false);
    if (!capability.ok) {
      expect(capability.failure.code).toBe("parent_not_forkable");
    }
    expect(treeFingerprint(setup.dataDir)).toEqual(treeBefore);
    expect(sha256OfFile(workspaceTraceFile(setup.dataDir, record.meta.id))).toBe(traceHashBefore);

    // 句柄释放：这条中断路径同样是"打开过、必须关掉"
    expect(injector.handles.opened.size).toBeGreaterThan(0);
    expect(leakedTraceHandles()).toEqual([]);
  });
});

describe("7.2 导入失败释放资源", () => {
  it("导入失败：返回可辨认 failure、零 LLM、零 trace，且已有附件逐项保留", async () => {
    // 先在一个 dataDir 里种下一份真实数据（父/兄弟共享附件不该被后来的失败清掉）
    const parent = await createThreeRoundParent();
    const blobsBefore = treeFingerprint(join(parent.dataDir, WORKSPACE_BLOBS_DIR_NAME));
    const tracesBefore = readdirSync(tracesDirOf(parent.dataDir)).sort();

    const llm = new ScriptedLlm([{ content: "不该被调用" }]);
    const result = await createIsolatedRun({
      dataDir: parent.dataDir,
      source: join(parent.dataDir, "definitely-not-a-real-source-dir"),
      config: makeConfig(),
      userMessage: "源目录不存在",
      authority: { allowFileWrites: true },
      llm: asLoopLlm(llm),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("source_not_found");
    }
    expect(llm.requests).toHaveLength(0);
    // 已有 trace 与附件逐项不变
    expect(treeFingerprint(join(parent.dataDir, WORKSPACE_BLOBS_DIR_NAME))).toEqual(blobsBefore);
    expect(readdirSync(tracesDirOf(parent.dataDir)).sort()).toEqual(tracesBefore);
  });
});
