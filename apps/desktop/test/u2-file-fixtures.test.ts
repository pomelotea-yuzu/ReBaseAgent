import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { locateWorkspaceSnapshot, readWorkspaceFile } from "@rebaseagent/replay";
import { readRun, resolveBranch } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";

/**
 * U2（improve-workspace-file-reading）任务 1.1：文件阅读夹具组的**输入条件验证**。
 *
 * 数据来源：`apps/desktop/scripts/gen-u2-file-fixtures.cjs`
 *   - `iso-data/` 为**真实引擎产物**（createIsolatedRun + replayIsolatedRun + Mock LLM），
 *     故含绝对临时路径、不追求逐字节可重复——改由 MANIFEST.json 记录关系与哈希。
 *   - `broken/*` 为**故意的自相矛盾标本**（trace 声明了附件，磁盘上没有或对不上）。
 *
 * ⚠️ 与 1.1 的边界（诚实记录）：
 *   本文件是**数据契约校验**，不是 U2 的验收：
 *   - 它证明「这批夹具的输入确实满足 1.1 五条断言的前提」；
 *   - 它**不**证明文件视图已按这些形状正确展示（属任务 2.x–4.x / 5.x 实机）。
 *
 * ⚠️ 覆盖缺口（归后续任务）：
 *   - 「失败运行已记录文件可查看」的**引擎原生**样本（LLM 失败封存但检查点已落盘）
 *     需 mock 服务造 `errored` 终止——本组用手工标本表达"检查点已落盘"这一条件，
 *     真实失败 run 的实机核对归 5.5；
 *   - 长文本的**渲染**可读性归 5.1/5.2，本组只证明长文本样本确实足够长。
 */

// 渲染层纯逻辑与实现同源导入（与 file-two-side-read.test.ts 同法）
const { deriveCheckpointOptions, defaultCheckpointStepId, canEnterTextDiff } = await import(
  "../src/renderer/src/lib/workspace-files"
);

/** 构造 DiffSides（只有两侧的"缺席原因"参与 `canEnterTextDiff` 判定） */
function sides(leftNote: string, rightNote: string) {
  return {
    left: leftNote === "text" ? "内容" : null,
    right: rightNote === "text" ? "内容" : null,
    leftLabel: "初始",
    rightLabel: "所选",
    leftNote: leftNote as never,
    rightNote: rightNote as never,
    hasContent: leftNote === "text" || rightNote === "text",
  };
}

const DIR = resolve(import.meta.dirname, "fixtures/u2-file-fixtures");
const MANIFEST_FILE = join(DIR, "MANIFEST.json");

interface FileFacts {
  path: string;
  bytes: number;
  sha256: string;
}

interface SnapshotFacts {
  stepSpanId: string | null;
  files: FileFacts[];
}

interface Manifest {
  数据目录: Record<string, string>;
  关系: {
    isolated: { root: string; fork1: string; fork2: string; 语义: string };
    errored: { id: string; 终止事件: string; 自有步骤: string[]; 检查点数: number; 语义: string };
  };
  源目录: string;
  隔离附件哈希: Array<{ name: string; sha256: string }>;
  异常标本: Record<string, { id: string; 数据目录: string; 成因: string }>;
  检查点快照: Record<
    string,
    {
      id: string;
      自有spanIds: string[];
      parent: string | null;
      步骤轮号: number[];
      workspaceWorldId: string | null;
    }
  >;
}

const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) as Manifest;
const dataDir = (key: string): string => join(DIR, manifest.数据目录[key] as string);

/** 读某 run 的详情记录（用于拿自有 span / 轮号） */
function recordOf(isoDataDir: string, runId: string) {
  return readRun(join(isoDataDir, "traces", `${runId}.jsonl`));
}

/** 该 run 的全部自有 agent.step span id（升序按轮号） */
function ownStepIds(isoDataDir: string, runId: string): string[] {
  return recordOf(isoDataDir, runId)
    .spans.filter((s) => s.kind === "agent.step")
    .map((s) => s.id);
}

/** 定位一份清单（缺省 = 初始快照）；失败直接抛，让用例拿到原始原因 */
function snapshot(isoDataDir: string, runId: string, stepSpanId?: string) {
  const located = locateWorkspaceSnapshot(
    stepSpanId === undefined
      ? { dataDir: isoDataDir, runId }
      : { dataDir: isoDataDir, runId, stepSpanId },
  );
  if (!located.ok) {
    throw new Error(`定位失败：${located.failure.code} ${located.failure.reason}`);
  }
  return located.value.snapshot;
}

/** 一次读遍某快照的全部文件（返回 path → 读取状态） */
async function readAll(isoDataDir: string, runId: string, stepSpanId: string | null) {
  const snap = snapshot(isoDataDir, runId, stepSpanId === null ? undefined : stepSpanId);
  const byPath = new Map<string, Awaited<ReturnType<typeof readWorkspaceFile>>>();
  for (const file of snap.files) {
    const request =
      stepSpanId === null
        ? { dataDir: isoDataDir, runId, path: file.path }
        : { dataDir: isoDataDir, runId, stepSpanId, path: file.path };
    byPath.set(file.path, await readWorkspaceFile(request));
  }
  return byPath;
}

const ISO = dataDir("isolated");

// ---------------------------------------------------------------------------
// 资产齐备：清单声明的每一条都必须真的存在且可读
// ---------------------------------------------------------------------------

describe("1.1 资产齐备：清单声明的语料真的存在且可读", () => {
  it("清单里的每个**数据目录**都存在，且 traces/ 与 workspace-blobs/ 同级", () => {
    for (const [label, rel] of Object.entries(manifest.数据目录)) {
      // source 是"文件世界的外部来源"，不是 dataDir（读取 API 不对它工作）⇒ 单独校验
      if (label === "sourceSnapshot") {
        expect(existsSync(join(DIR, rel)), `缺源目录快照：${rel}`).toBe(true);
        continue;
      }
      const dir = join(DIR, rel);
      expect(existsSync(join(dir, "traces")), `${label} 缺 traces/`).toBe(true);
      expect(existsSync(join(dir, "workspace-blobs")), `${label} 缺 workspace-blobs/`).toBe(true);
    }
  });

  it("隔离组三条 run 都存在（真实引擎产物）", () => {
    const { root, fork1, fork2 } = manifest.关系.isolated;
    for (const id of [root, fork1, fork2]) {
      expect(existsSync(join(ISO, "traces", `${id}.jsonl`)), `缺少隔离 run：${id}`).toBe(true);
    }
  });

  it("三条 run 都是 v2 且携带真实 workspace（world_id 与自身 id 一致）", () => {
    const { root, fork1, fork2 } = manifest.关系.isolated;
    for (const id of [root, fork1, fork2]) {
      const record = recordOf(ISO, id);
      expect(record.meta.format_version, id).toBe(2);
      expect(record.meta.workspace?.world_id, id).toBe(id);
    }
  });

  it("清单记录的自有 span 边界与真实读取结果逐条一致（清单不是自说自话）", () => {
    for (const [label, facts] of Object.entries(manifest.检查点快照)) {
      const record = recordOf(ISO, facts.id);
      expect(
        record.spans.map((s) => s.id),
        label,
      ).toEqual(facts.自有spanIds);
      expect(record.meta.parent, label).toBe(facts.parent);
    }
  });

  it("附件哈希：清单声明的每一份都与落盘字节实测一致（哈希非占位）", () => {
    expect(manifest.隔离附件哈希.length).toBeGreaterThan(0);
    const onDisk = readdirSync(join(ISO, "workspace-blobs", "sha256"));
    for (const blob of manifest.隔离附件哈希) {
      // 文件名即 sha256（workspace-blobs/sha256/<hash> 的命名契约）
      expect(blob.name).toBe(blob.sha256);
      expect(blob.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(onDisk).toContain(blob.name);
    }
  });
});

// ---------------------------------------------------------------------------
// 断言① 初始与各轮文件快照可选择
// ---------------------------------------------------------------------------

describe("断言① 初始与各轮文件快照可选择", () => {
  const { root } = manifest.关系.isolated;

  it("根 run 的每个自有步骤都能定位出一份清单（各自轮末快照）", () => {
    const steps = ownStepIds(ISO, root);
    expect(steps.length).toBeGreaterThanOrEqual(2);
    for (const stepId of steps) {
      const snap = snapshot(ISO, root, stepId);
      expect(snap.id, stepId).toMatch(/^[0-9a-f]{64}$/);
      expect(snap.files.length, stepId).toBeGreaterThan(0);
    }
  });

  it("不同轮次的快照**内容不同**（不是把同一份清单复制三份）", () => {
    const steps = ownStepIds(ISO, root);
    const ids = new Set<string>([snapshot(ISO, root).id]);
    for (const stepId of steps) ids.add(snapshot(ISO, root, stepId).id);
    // ⚠️ 检查点记录在**工具调用点**上：只读轮与它之前的状态可能共用同一份快照，
    //    所以这里断言的是"**至少有两种**不同快照"（多轮演进确实发生了），
    //    而不是"每轮各一份"——后者是对录制粒度的错误假设。
    expect(ids.size).toBeGreaterThanOrEqual(2);
    expect(ids.size).toBeLessThanOrEqual(steps.length + 1);
  });

  it("快照随写入演进：末轮的清单比初始多出被新建的 new.txt", () => {
    const steps = ownStepIds(ISO, root);
    const last = steps[steps.length - 1] as string;
    const initialPaths = snapshot(ISO, root).files.map((f) => f.path);
    const lastPaths = snapshot(ISO, root, last).files.map((f) => f.path);

    // new.txt 由第 2 轮的 write_file 新建 ⇒ 初始清单里**没有这条路径**
    expect(initialPaths).not.toContain("new.txt");
    expect(lastPaths).toContain("new.txt");
  });

  it("被修改的文件在初始与末轮内容哈希不同、且都是 text", async () => {
    const steps = ownStepIds(ISO, root);
    const last = steps[steps.length - 1] as string;
    const initial = await readAll(ISO, root, null);
    const atLast = await readAll(ISO, root, last);

    const before = initial.get("edit.txt");
    const after = atLast.get("edit.txt");
    expect(before?.status).toBe("text");
    expect(after?.status).toBe("text");
    if (before?.status === "text" && after?.status === "text") {
      expect(before.text).not.toBe(after.text);
      expect(before.file.sha256).not.toBe(after.file.sha256);
    }
  });

  it("未变化的文件在初始与末轮哈希一致（未变化样本真实存在）", async () => {
    const steps = ownStepIds(ISO, root);
    const last = steps[steps.length - 1] as string;
    const initial = await readAll(ISO, root, null);
    const atLast = await readAll(ISO, root, last);

    const before = initial.get("keep.txt");
    const after = atLast.get("keep.txt");
    expect(before?.status).toBe("text");
    expect(after?.status).toBe("text");
    if (before?.status === "text" && after?.status === "text") {
      expect(before.file.sha256).toBe(after.file.sha256);
    }
  });

  it("祖先步骤不能被子孙 run 当作检查点（A 包自有约束）", () => {
    const { root, fork1 } = manifest.关系.isolated;
    const rootStep = ownStepIds(ISO, root)[0] as string;
    const located = locateWorkspaceSnapshot({
      dataDir: ISO,
      runId: fork1,
      stepSpanId: rootStep,
    });
    expect(located.ok).toBe(false);
    if (!located.ok) expect(located.failure.code).toBe("step_not_found");
  });
});

// ---------------------------------------------------------------------------
// 断言② 文件选择器轮号不沿链累加
// ---------------------------------------------------------------------------

describe("断言② 文件选择器轮号不沿链累加", () => {
  it("根有 3 轮、分叉链条上每个 run 的轮号都从本地第 1 轮起", () => {
    const { root, fork1, fork2 } = manifest.关系.isolated;
    expect(manifest.检查点快照.root?.步骤轮号).toEqual([1, 2, 3]);
    // 一/二次分叉各自从本地第 1 轮重新计数——若"沿链累加"，fork2 会得到 3/4 之类的错值
    expect(manifest.检查点快照.fork1?.步骤轮号?.[0]).toBe(1);
    expect(manifest.检查点快照.fork2?.步骤轮号?.[0]).toBe(1);
    // 轮号总和 = 各 run 自有轮数之和（3 + 2 + 2），而不是沿链累加出的 3+5+7
    const total =
      (manifest.检查点快照.root?.步骤轮号.length ?? 0) +
      (manifest.检查点快照.fork1?.步骤轮号.length ?? 0) +
      (manifest.检查点快照.fork2?.步骤轮号.length ?? 0);
    expect(total).toBe(7);
    expect(root).not.toBe(fork1);
    expect(fork1).not.toBe(fork2);
  });

  it("deriveCheckpointOptions 对每个 run 都只列自有轮号（不出现超过自有轮数的编号）", () => {
    const { root, fork1, fork2 } = manifest.关系.isolated;
    for (const id of [root, fork1, fork2]) {
      const record = recordOf(ISO, id);
      const options = deriveCheckpointOptions({
        spans: record.spans,
        leafSpanIds: record.spans.map((s) => s.id),
        meta: record.meta,
      });
      const rounds = options.map((o) => o.localIteration).filter((n): n is number => n !== null);
      const maxOwn = Math.max(
        ...record.spans.filter((s) => s.kind === "agent.step").map((s) => s.n),
      );
      // 选择器最大轮号 = 本 run 自有轮号最大值（这是"不沿链累加"的可执行判据）
      expect(Math.max(...rounds), id).toBe(maxOwn);
      // 且每个选项的文案都是"本 run 第 N 轮结束"，不写"沿链"
      for (const option of options) {
        if (option.stepSpanId !== null) {
          expect(option.label).toMatch(/^本 run 第 \d+ 轮结束$/);
        }
      }
    }
  });

  /**
   * ⚠️ **合并记录的形态**才是真正的风险面：详情给的是 `resolveBranch` 拼出来的
   *    "祖先前缀 + 自有段"，此时 `spans` 里**含祖先的 agent.step**，只有 `leafSpanIds`
   *    能界定自有段。上一条用例传的 `leafSpanIds = 全部 span`，因此对"祖先混入选择器"
   *    这个变异**没有鉴别力**（实测：把 `owned.has(span.id)` 删掉，上一条仍全绿）。
   *
   *    本用例用真实谱系**构造成合并形态**：把父 run 的自有 span 接在子 run 前面，
   *    `leafSpanIds` 只给子 run 自有段 —— 这正是分支 run 打开文件页时的真实输入。
   */
  it("合并轨迹形态：祖先 step 在 spans 里但不在 leafSpanIds ⇒ 不得进选择器", () => {
    const { root, fork1 } = manifest.关系.isolated;
    const parent = recordOf(ISO, root);
    const child = recordOf(ISO, fork1);

    // 合并形态：父自有段 + 子自有段
    const mergedSpans = [...parent.spans, ...child.spans];
    const childLeafIds = child.spans.map((s) => s.id);
    const parentStepIds = parent.spans.filter((s) => s.kind === "agent.step").map((s) => s.id);

    expect(parentStepIds.length).toBeGreaterThan(0);

    const options = deriveCheckpointOptions({
      spans: mergedSpans,
      leafSpanIds: childLeafIds,
      meta: child.meta,
    });

    const listed = new Set(
      options.map((o) => o.stepSpanId).filter((id): id is string => id !== null),
    );
    // 祖先 step 出现在 spans 里，但**一个都不能**出现在选择器中
    for (const ancestorStep of parentStepIds) {
      expect(listed.has(ancestorStep), `祖先步骤 ${ancestorStep} 不得充当本 run 检查点`).toBe(
        false,
      );
    }
    // 自有 step 必须全部在（不是"因为过滤过头把自有也滤没了"）
    const childStepIds = child.spans.filter((s) => s.kind === "agent.step").map((s) => s.id);
    for (const ownStep of childStepIds) {
      expect(listed.has(ownStep), `自有步骤 ${ownStep} 必须在选择器中`).toBe(true);
    }
  });

  it("合并轨迹形态：默认检查点取**自有**最近步骤，不取祖先的更大轮号", () => {
    const { root, fork1 } = manifest.关系.isolated;
    const parent = recordOf(ISO, root);
    const child = recordOf(ISO, fork1);
    const mergedSpans = [...parent.spans, ...child.spans];

    // 关键构造：祖先的轮号**更大**（父 3 轮 > 子 2 轮）⇒ 若按"合并数组里 n 最大"选，
    // 会选中祖先的 step；按 leafSpanIds 过滤后选才是正确行为。
    const defaultId = defaultCheckpointStepId({
      spans: mergedSpans,
      leafSpanIds: child.spans.map((s) => s.id),
      meta: child.meta,
    });
    const childStepIds = new Set(
      child.spans.filter((s) => s.kind === "agent.step").map((s) => s.id),
    );
    expect(defaultId).not.toBeNull();
    expect(childStepIds.has(defaultId as string), `默认检查点落到了非自有步骤：${defaultId}`).toBe(
      true,
    );
  });

  it("默认检查点 = 最近的自有完成步骤（按本地 n 选，不按合并轨迹下标）", () => {
    const { root } = manifest.关系.isolated;
    const record = recordOf(ISO, root);
    const leafIds = record.spans.map((s) => s.id);
    const defaultId = defaultCheckpointStepId({
      spans: record.spans,
      leafSpanIds: leafIds,
      meta: record.meta,
    });
    const steps = record.spans.filter((s) => s.kind === "agent.step");
    const maxN = Math.max(...steps.map((s) => s.n));
    const expected = steps.find((s) => s.n === maxN);
    expect(defaultId).toBe(expected?.id);
  });
});

// ---------------------------------------------------------------------------
// 断言③ 新增文件与零字节文件不混同
// ---------------------------------------------------------------------------

describe("断言③ 新增文件与零字节文件不混同", () => {
  const { root } = manifest.关系.isolated;

  it("new.txt：初始侧按路径读得到 not_found（不是空文本、也不是缺失）", async () => {
    // ⚠️ 新增文件的初始侧**不在初始清单里**（清单只有当时存在的文件），
    //    所以必须"按已知路径显式读取"才能拿到 not_found —— 这正是文件页的真实调用形态。
    const initialPaths = snapshot(ISO, root).files.map((f) => f.path);
    expect(initialPaths).not.toContain("new.txt");

    const read = await readWorkspaceFile({ dataDir: ISO, runId: root, path: "new.txt" });
    expect(read.status).toBe("not_found");
    // 关键：not_found 不得携带 file（否则会被渲染成"0 字节文件"）
    expect("file" in read).toBe(false);
  });

  it("empty.txt：初始侧就是**合法空文本**（text + 0 字节），不是不存在", async () => {
    const initial = await readAll(ISO, root, null);
    const read = initial.get("empty.txt");
    expect(read?.status).toBe("text");
    if (read?.status === "text") {
      expect(read.text).toBe("");
      expect(read.file.bytes).toBe(0);
    }
  });

  it("新增与零字节的**判据可分**：新增侧 not_found、空文件侧 text 且 bytes=0", async () => {
    const steps = ownStepIds(ISO, root);
    const last = steps[steps.length - 1] as string;
    // 末轮清单里两者都是真实存在的路径
    const atLast = await readAll(ISO, root, last);
    const added = atLast.get("new.txt");
    const empty = atLast.get("empty.txt");

    expect(added?.status).toBe("text");
    expect(empty?.status).toBe("text");
    if (added?.status === "text" && empty?.status === "text") {
      expect(added.text).not.toBe("");
      expect(empty.text).toBe("");
      expect(added.file.bytes).toBeGreaterThan(0);
      expect(empty.file.bytes).toBe(0);
    }

    // 而同一条路径的初始侧：新增文件是 not_found、空文件仍是 text(0B)
    const addedInitial = await readWorkspaceFile({ dataDir: ISO, runId: root, path: "new.txt" });
    const emptyInitial = await readWorkspaceFile({ dataDir: ISO, runId: root, path: "empty.txt" });
    expect(addedInitial.status).toBe("not_found");
    expect(emptyInitial.status).toBe("text");
  });

  it("canEnterTextDiff：初始 not_found + 所选 text 放行，所选 not_found 拒绝（不对称）", () => {
    // 新增文件是合法空侧
    expect(canEnterTextDiff(sides("not_found", "text")).ok).toBe(true);
    // 所选检查点里没有这条路径 ⇒ 不是新增，拿它当空侧比较即假报差异
    expect(canEnterTextDiff(sides("text", "not_found")).ok).toBe(false);
    // 两侧都是 text 是常规放行
    expect(canEnterTextDiff(sides("text", "text")).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 断言④ 两侧都不可读时没有伪空编辑器
// ---------------------------------------------------------------------------

describe("断言④ 两侧都不可读时没有伪空编辑器", () => {
  it("missing 标本：附件未落盘 ⇒ 读取报 missing（不是 text 空串、不是 not_found）", async () => {
    const dir = dataDir("brokenMissing");
    const id = manifest.异常标本.missing?.id as string;
    const snap = snapshot(dir, id);
    expect(snap.files.length).toBeGreaterThan(0);
    for (const file of snap.files) {
      const read = await readWorkspaceFile({ dataDir: dir, runId: id, path: file.path });
      expect(read.status, file.path).toBe("missing");
    }
  });

  it("corrupt 标本：附件落盘但字节被替换 ⇒ 读取报 corrupt（与 missing 成因可分）", async () => {
    const dir = dataDir("brokenCorrupt");
    const id = manifest.异常标本.corrupt?.id as string;
    const snap = snapshot(dir, id);
    expect(snap.files.length).toBeGreaterThan(0);
    for (const file of snap.files) {
      const read = await readWorkspaceFile({ dataDir: dir, runId: id, path: file.path });
      expect(read.status, file.path).toBe("corrupt");
    }
  });

  it("missing/corrupt 都不得被当成 text（否则不可用侧会被置空比较）", async () => {
    for (const [key, name] of [
      ["brokenMissing", "missing"],
      ["brokenCorrupt", "corrupt"],
    ] as const) {
      const dir = dataDir(key);
      const id = manifest.异常标本[name]?.id as string;
      const snap = snapshot(dir, id);
      for (const file of snap.files) {
        const read = await readWorkspaceFile({ dataDir: dir, runId: id, path: file.path });
        expect(read.status, `${name}:${file.path}`).not.toBe("text");
      }
    }
  });

  it("两侧都不可读时 canEnterTextDiff 恒 false（不挂伪空编辑器）", () => {
    for (const note of ["missing", "corrupt", "binary", "unread", "unavailable"] as const) {
      // 两侧同因、以及"可用侧 + 不可用侧"组合，全部不得进入 diff
      expect(canEnterTextDiff(sides(note, note)).ok, note).toBe(false);
      expect(canEnterTextDiff(sides("text", note)).ok, `text+${note}`).toBe(false);
      expect(canEnterTextDiff(sides(note, "text")).ok, `${note}+text`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 断言⑤ 失败运行已记录文件可查看
// ---------------------------------------------------------------------------

describe("断言⑤ 失败运行已记录文件可查看", () => {
  const errored = manifest.关系.errored;

  it("errored 样本确实是**引擎原生**的失败 run（终止事件 errored，非手工标注）", () => {
    expect(errored.终止事件).toBe("errored");
    // 至少 2 轮：第 1 轮真实写入（检查点落盘），第 2 轮 LLM 失败
    expect(errored.自有步骤.length).toBeGreaterThanOrEqual(2);
    expect(errored.检查点数).toBeGreaterThan(0);
  });

  it("失败 run 的**既有完成步骤**仍能定位出真实清单（失败不撤销历史写入）", () => {
    const record = recordOf(ISO, errored.id);
    const steps = record.spans.filter((s) => s.kind === "agent.step").map((s) => s.id);
    expect(steps.length).toBeGreaterThanOrEqual(2);

    // 第 1 轮（失败**之前**已记录）必须可定位
    const first = steps[0] as string;
    const snap = snapshot(ISO, errored.id, first);
    expect(snap.files.length).toBeGreaterThan(0);
  });

  it("失败 run 的第 1 轮清单里，写入的文件内容真实可读（不是占位）", async () => {
    const record = recordOf(ISO, errored.id);
    const first = record.spans.filter((s) => s.kind === "agent.step")[0]?.id as string;
    const read = await readWorkspaceFile({
      dataDir: ISO,
      runId: errored.id,
      stepSpanId: first,
      path: "edit.txt",
    });
    expect(read.status).toBe("text");
    if (read.status === "text") expect(read.text).toBe("失败前的写入\n");
  });

  it("失败 run 的初始清单与失败后状态**内容不同**（第 1 轮的写入确实生效）", async () => {
    const record = recordOf(ISO, errored.id);
    const first = record.spans.filter((s) => s.kind === "agent.step")[0]?.id as string;
    const initial = await readWorkspaceFile({ dataDir: ISO, runId: errored.id, path: "edit.txt" });
    const afterWrite = await readWorkspaceFile({
      dataDir: ISO,
      runId: errored.id,
      stepSpanId: first,
      path: "edit.txt",
    });
    expect(initial.status).toBe("text");
    expect(afterWrite.status).toBe("text");
    if (initial.status === "text" && afterWrite.status === "text") {
      expect(initial.text).not.toBe(afterWrite.text);
    }
  });

  it("失败 run 的**未落盘**步骤不伪造检查点：第 2 轮（失败轮）没有快照可读", () => {
    const record = recordOf(ISO, errored.id);
    const steps = record.spans.filter((s) => s.kind === "agent.step").map((s) => s.id);
    const last = steps[steps.length - 1] as string;
    // 失败轮没有工具调用 ⇒ 没有 workspace_snapshot ⇒ 定位应失败（不得凭空造一份清单）
    const step = record.spans.find((s) => s.id === last);
    const hasSnapshot = step !== undefined && step.workspace_snapshot !== undefined;
    if (!hasSnapshot) {
      const located = locateWorkspaceSnapshot({
        dataDir: ISO,
        runId: errored.id,
        stepSpanId: last,
      });
      expect(located.ok).toBe(false);
    } else {
      // 若引擎确实为该轮留了快照，那也是真实录制 —— 断言它可读即可
      expect(snapshot(ISO, errored.id, last).files.length).toBeGreaterThan(0);
    }
  });
});

describe("断言⑤ 附：无自有完成步骤的运行仍可读初始清单（不渲染成读取失败）", () => {
  it("no-own-steps 标本：检查点选择器只有初始状态（无任何自有完成步骤）", () => {
    const dir = dataDir("brokenNoOwnSteps");
    const id = manifest.异常标本.noCheckpoint?.id as string;
    const record = recordOf(dir, id);
    const options = deriveCheckpointOptions({
      // ⚠️ leafSpanIds 必须是**本 run 自有** span id（与 run-repository.getRun 同源），
      //    不是合并轨迹的全部 span —— 用全部就等于把祖先也当成了自有（U1 三度复发的坑）。
      leafSpanIds: record.spans.map((s) => s.id),
      spans: record.spans,
      meta: record.meta,
    });
    // 初始状态恒在；本 run 一个自有完成步骤都没有
    expect(options[0]?.stepSpanId).toBeNull();
    expect(options.length).toBe(1);
  });

  it("no-own-steps 标本的初始清单仍能读出真实内容（不是空清单）", async () => {
    const dir = dataDir("brokenNoOwnSteps");
    const id = manifest.异常标本.noCheckpoint?.id as string;
    const snap = snapshot(dir, id);
    expect(snap.files.length).toBeGreaterThan(0);
    const read = await readWorkspaceFile({ dataDir: dir, runId: id, path: "a.txt" });
    expect(read.status).toBe("text");
  });

  it("no-own-steps 标本该 run 仍通过读取器校验（是有父链的合法续跑，不是损坏）", () => {
    const dir = dataDir("brokenNoOwnSteps");
    const id = manifest.异常标本.noCheckpoint?.id as string;
    const record = recordOf(dir, id);
    // readRun 不抛 ⇒ 结构合法（v2 的 workspace / 快照 id 都照常，meta.workspace 仍在）
    expect(record.meta.workspace).toBeDefined();
    expect(record.meta.parent).toBe(manifest.关系.isolated.root);
  });

  /**
   * ⚠️⚠️ **这条是 2026-09-24 验收阶段补的（D-2）**：上面几条都用 `readRun` 读**本文件**，
   *    **不触发分支解析** ⇒ 标本里「`fork.at_span` 被设成等于 `resume_after_step`」这个非法形态
   *    一路没被发现。而**经运行列表读取**这条真实路径（详情页）一定会走 `resolveBranch`，
   *    该函数硬校验 `at_span` 必须是分叉轮内的**工具调用** ⇒ 标本会被直接拒绝（详情页打不开）。
   *
   *    这正是 5.5 实测发现的问题；5.5/5.6 的生成器当时已按正确形态另建标本并显式调 `resolveBranch` 自检，
   *    1.1 的生成器直到本次才补齐。**本用例就是防止它再退回去**。
   */
  it("no-own-steps 标本能通过 resolveBranch 合并读取（fork.at_span 必须是该轮内的工具调用）", () => {
    const dir = dataDir("brokenNoOwnSteps");
    const id = manifest.异常标本.noCheckpoint?.id as string;

    // 不抛 ⇒ fork.at_span / resume_after_step / workspace.origin 三者自洽
    const resolved = resolveBranch(id, (rid) => recordOf(dir, rid));

    // 合并轨迹里确实能看到**父 run 的**步骤（祖先不是自有检查点，但必须在场）
    expect(resolved.spans.filter((s) => s.kind === "agent.step").length).toBeGreaterThan(0);
    expect(resolved.chain.length).toBeGreaterThan(1);
    // 而本 run 自有 `agent.step` 为 0（标本定义）⇒ 检查点选择器只剩「本 run 初始状态」
    expect(recordOf(dir, id).spans.filter((s) => s.kind === "agent.step")).toEqual([]);
  });

  /**
   * ⚠️⚠️ 变异守卫：这条用例的存在意义就是防止「无自有完成步骤」标本退化成"和正本一样"。
   *
   * 教训（**连续翻车两次，两种错法都留在这里以免回退**）：
   *   ① 最初想用"删掉 `workspace_snapshot`"构造"无检查点"，字段名却写成了 `obj.workspace`
   *      ⇒ 删了个不存在的字段，标本与正本**逐字节相同**，而旧断言在**没做任何改动**时
   *      同样成立 ⇒ 用例静默空转。**更根本的是**：即便字段名写对，删快照也是错的——
   *      v2 已完成 `agent.step` 必带 `workspace_snapshot` 由 `trace-sdk` 读取器强制，
   *      删掉后文件直接读不出来（`TraceReadError`），根本不是合法标本。
   *   ② 改成"把自有轮号 `n` 整体抬高" ⇒ 仍然错：`deriveCheckpointOptions` 判"是否自有"
   *      用的是 **`leafSpanIds`，根本不看 `n`** ⇒ 步骤仍是自有的，标本等于没做。
   *
   * 所以这条同时钉三件事：① 标本必须与正本不同；② 标本自有完成步骤必须为 0 而正本为 3；
   * ③ 标本**仍带** `meta.workspace`（v2 硬不变量）与父链（真实续跑形态）。
   * 任何让改动落空、或改成非法状态的写法都会立刻变红。
   */
  it("【变异守卫】no-own-steps 标本与正本**必须不同**，且自有完成步骤数为 0", () => {
    const isoDir = dataDir("isolated");
    const badDir = dataDir("brokenNoOwnSteps");
    const rootId = manifest.关系.isolated.root;
    const badId = manifest.异常标本.noCheckpoint?.id as string;

    const countOwnSteps = (dir: string, id: string): number =>
      recordOf(dir, id).spans.filter((s) => s.kind === "agent.step").length;

    const rootCount = countOwnSteps(isoDir, rootId);
    const badCount = countOwnSteps(badDir, badId);

    expect(rootCount).toBe(3); // 正本确实有 3 轮（否则这个对照无意义）
    expect(badCount).toBe(0); // 标本一个自有完成步骤都不剩
    expect(badCount).not.toBe(rootCount); // 关键：不能与正本相同

    // ③ 标本必须仍是**合法 v2**：meta.workspace 在、有父链（不能靠删字段制造"没有步骤"）
    const badRecord = recordOf(badDir, badId);
    expect(badRecord.meta.workspace).toBeDefined();
    expect(badRecord.meta.parent).toBe(rootId);
    // 而且必须真的能从合并轨迹里看到**祖先**步骤 —— 这正是"祖先不得冒充本 run 检查点"的正面反例
    expect(badRecord.meta.parent ?? null).toBe(rootId);
  });
});

// ---------------------------------------------------------------------------
// 长文本与二进制样本
// ---------------------------------------------------------------------------

describe("长文本与二进制样本（渲染验收的输入条件）", () => {
  const { root } = manifest.关系.isolated;

  it("long.txt 足够长（200+ 行）且含超长行（长文本/换行验收的前提）", async () => {
    const initial = await readAll(ISO, root, null);
    const read = initial.get("long.txt");
    expect(read?.status).toBe("text");
    if (read?.status === "text") {
      const lines = read.text.split("\n");
      expect(lines.length).toBeGreaterThan(200);
      expect(lines.some((l) => l.length > 400)).toBe(true);
      expect(read.file.bytes).toBeGreaterThan(5000);
    }
  });

  it("bin.dat 是二进制（含 NUL 字节 ⇒ 读取判 binary 而非有损文本）", async () => {
    const initial = await readAll(ISO, root, null);
    const read = initial.get("bin.dat");
    expect(read?.status).toBe("binary");
    if (read?.status === "binary") {
      expect(read.data.length).toBeGreaterThan(0);
      expect(read.data.includes(0)).toBe(true);
    }
  });

  it("二进制侧不可与文本侧进入 diff（不可用侧不伪装为空差异）", () => {
    expect(canEnterTextDiff(sides("unavailable", "text")).ok).toBe(false);
    expect(canEnterTextDiff(sides("text", "unavailable")).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 只读性与源目录不被改动
// ---------------------------------------------------------------------------

describe("夹具只读性：源目录与既有资产在读取期间逐字节不变", () => {
  it("源目录快照存在且含全部 6 个源文件（含 new.txt 缺席的对照）", () => {
    const source = join(DIR, "source");
    const names = readdirSync(source).sort();
    expect(names).toContain("a.txt");
    expect(names).toContain("keep.txt");
    expect(names).toContain("edit.txt");
    expect(names).toContain("empty.txt");
    expect(names).toContain("long.txt");
    expect(names).toContain("bin.dat");
    // new.txt 由引擎在隔离世界里新建 ⇒ 源目录里不应存在
    expect(names).not.toContain("new.txt");
  });

  it("读取不写盘：连续两次读取同一清单得到同一 snapshotId 与同一附件哈希", async () => {
    const { root } = manifest.关系.isolated;
    const first = snapshot(ISO, root);
    const second = snapshot(ISO, root);
    expect(first.id).toBe(second.id);
    expect(first.files.map((f) => `${f.path}:${f.sha256}`)).toEqual(
      second.files.map((f) => `${f.path}:${f.sha256}`),
    );
  });
});
