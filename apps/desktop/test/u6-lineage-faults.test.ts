import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RunRepository } from "../src/main/run-repository";

/**
 * U6（add-partial-run-reading）任务 6.1：来源链注入原语的**可用性自检**。
 *
 * 判据来源：tasks.md 6.1「自建临时数据的备份/注入/finally 还原/指纹核验工具，
 * 失败保留恢复指引」；design §Validation Strategy「受控临时数据目录内
 * 备份→注入→finally 还原→逐字节核验，含失败时保留恢复指引」。
 *
 * ⚠️ 与 U5 `controlled-read-faults.test.ts` 同一纪律：这一支同时产出后续批次
 * （6.3–6.6）的**分层依据**——每种注入诱发后 `RunRepository.getRun` 的真实形状
 * 是对着实现数出来的，不是猜的：
 * - `ancestorMissing` ⇒ 结构化 ownOnly（ancestors 确实缺失的唯一合法入口）；
 * - `ancestorCorrupt` / `ancestorFutureVersion` / `lineageCycle` / `forkInvalid` /
 *   `currentMissing` ⇒ 全部严格失败，**不**返回 ownOnly；
 * - 还原（=父文件恢复）后重读 ⇒ complete/resolved（「父文件恢复后重试全量重验」
 *   的工具级通道，每次 getRun 全新 walk，无缓存）。
 */

const require = createRequire(import.meta.url);

interface FaultTarget {
  tracesDir: string;
  childRunId: string;
  ancestorRunId?: string;
}
interface FaultEnd {
  clean: boolean;
  restoreError: string | null;
  diff: { added: string[]; removed: string[]; changed: string[] };
  marked: boolean;
}
interface LineageFaultsModule {
  LINEAGE_FAULT_KINDS: string[];
  HIDDEN_SUFFIX: string;
  UNSUPPORTED_FORMAT_VERSION: number;
  MISSING_SPAN_ID: string;
  beginLineageFault: (target: FaultTarget, kind: string) => { kind: string; end: () => FaultEnd };
  withLineageFault: (
    target: FaultTarget,
    kind: string,
    fn: (ctx: unknown) => unknown | Promise<unknown>,
  ) => Promise<{ fnResult: unknown; restore: FaultEnd }>;
}
const lineageFaults = require("../scripts/lib/u6-lineage-faults.cjs") as LineageFaultsModule;

const T0 = "2026-01-15T10:00:00.000Z";

function metaLine(id: string, parent: string | null, fork: unknown = null): string {
  return JSON.stringify({
    type: "run.meta",
    id,
    format_version: 1,
    task: "U6 来源链注入夹具",
    model: "controlled-model",
    created_at: T0,
    parent,
    fork,
  });
}

function stepLine(id: string): string {
  return JSON.stringify({ type: "span", id, parent: null, kind: "agent.step", n: 1 });
}

const STOP = JSON.stringify({ type: "run.event", event: "stopped", reason: "completed" });

const ROOT_ID = "r_root";
const CHILD_ID = "r_child";

/** 手写两跳普通 result 链：root（根）← child（fork result，at_span 指向父的 s1） */
function seedChain(traces: string): void {
  writeFileSync(
    join(traces, `${ROOT_ID}.jsonl`),
    `${[metaLine(ROOT_ID, null), stepLine("s1"), STOP].join("\n")}\n`,
  );
  writeFileSync(
    join(traces, `${CHILD_ID}.jsonl`),
    `${[
      metaLine(CHILD_ID, ROOT_ID, { at_span: "s1", edit: { field: "result", value: "x" } }),
      stepLine("c_s1"),
      STOP,
    ].join("\n")}\n`,
  );
}

const roots: string[] = [];

function tempTraces(): { traces: string; repo: RunRepository } {
  const root = mkdtempSync(join(tmpdir(), "u6-lineage-fault-"));
  roots.push(root);
  const traces = join(root, "traces");
  mkdirSync(traces);
  seedChain(traces);
  return { traces, repo: new RunRepository(traces) };
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** 详情读取成败与完整性形状（"读得出来"与"读出来是什么完整性"是两件事） */
function probeDetail(
  repo: RunRepository,
  id: string,
): { ok: boolean; message: string; completeness?: string; missingRunId?: string } {
  try {
    const detail = repo.getRun(id);
    return {
      ok: true,
      message: "",
      completeness: detail.completeness,
      missingRunId:
        detail.lineage.status === "incomplete" ? detail.lineage.missingRunId : undefined,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

const CHILD_TARGET = (): FaultTarget => ({
  tracesDir: "",
  childRunId: CHILD_ID,
  ancestorRunId: ROOT_ID,
});

describe("U6 6.1 来源链注入：每种注入的实际读取形状（对着真 getRun 数出来）", () => {
  it("ancestorMissing ⇒ 结构化 ownOnly；还原（父文件恢复）后重读 ⇒ complete/resolved", async () => {
    const { traces, repo } = tempTraces();
    const { fnResult, restore } = await lineageFaults.withLineageFault(
      { ...CHILD_TARGET(), tracesDir: traces },
      "ancestorMissing",
      async () => probeDetail(repo, CHILD_ID),
    );
    const observed = fnResult as { ok: boolean; completeness?: string; missingRunId?: string };
    // 祖先确实缺失 ⇒ 结构化降级，missingRunId 是真实缺失 ID
    expect(observed.ok).toBe(true);
    expect(observed.completeness).toBe("ownOnly");
    expect(observed.missingRunId).toBe(ROOT_ID);
    expect(restore.clean).toBe(true);
    // 还原 = 父文件恢复 ⇒ 全量重验后回到 complete（每次 getRun 全新 walk）
    const after = probeDetail(repo, CHILD_ID);
    expect(after.ok).toBe(true);
    expect(after.completeness).toBe("complete");
  });

  it("ancestorCorrupt ⇒ 严格失败不降级 ownOnly（受控中文，不透传路径）", async () => {
    const { traces, repo } = tempTraces();
    const { fnResult, restore } = await lineageFaults.withLineageFault(
      { ...CHILD_TARGET(), tracesDir: traces },
      "ancestorCorrupt",
      async () => probeDetail(repo, CHILD_ID),
    );
    const observed = fnResult as { ok: boolean; message: string; completeness?: string };
    expect(observed.ok).toBe(false);
    expect(observed.message).toContain("祖先");
    expect(observed.completeness).toBeUndefined();
    expect(restore.clean).toBe(true);
  });

  it("ancestorFutureVersion ⇒ 版本守卫拒绝，schema 转换前失败", async () => {
    const { traces, repo } = tempTraces();
    const { fnResult, restore } = await lineageFaults.withLineageFault(
      { ...CHILD_TARGET(), tracesDir: traces },
      "ancestorFutureVersion",
      async () => ({
        detail: probeDetail(repo, CHILD_ID),
        raw: (() => {
          try {
            repo.getRun(CHILD_ID);
            return "";
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
        })(),
      }),
    );
    const observed = fnResult as { detail: { ok: boolean; completeness?: string }; raw: string };
    expect(observed.detail.ok).toBe(false);
    expect(observed.detail.completeness).toBeUndefined();
    // 版本守卫的报错点名版本值，而不是"文件缺失"
    expect(observed.raw).toContain(String(lineageFaults.UNSUPPORTED_FORMAT_VERSION));
    expect(restore.clean).toBe(true);
  });

  it("lineageCycle ⇒ 成环严格失败，不截断成 ownOnly", async () => {
    const { traces, repo } = tempTraces();
    const { fnResult, restore } = await lineageFaults.withLineageFault(
      { ...CHILD_TARGET(), tracesDir: traces },
      "lineageCycle",
      async () => probeDetail(repo, CHILD_ID),
    );
    const observed = fnResult as { ok: boolean; message: string; completeness?: string };
    expect(observed.ok).toBe(false);
    expect(observed.message).toContain("成环");
    expect(observed.completeness).toBeUndefined();
    expect(restore.clean).toBe(true);
  });

  it("forkInvalid ⇒ at_span 不属于父轨迹 ⇒ 定位非法失败", async () => {
    const { traces, repo } = tempTraces();
    const { fnResult, restore } = await lineageFaults.withLineageFault(
      { ...CHILD_TARGET(), tracesDir: traces },
      "forkInvalid",
      async () => probeDetail(repo, CHILD_ID),
    );
    const observed = fnResult as { ok: boolean; message: string; completeness?: string };
    expect(observed.ok).toBe(false);
    expect(observed.message).toContain("分支轨迹解析失败");
    expect(observed.completeness).toBeUndefined();
    expect(restore.clean).toBe(true);
  });

  it("currentMissing ⇒ 读取直接失败（缺当前文件不返回 ownOnly）", async () => {
    const { traces, repo } = tempTraces();
    const { fnResult, restore } = await lineageFaults.withLineageFault(
      { tracesDir: traces, childRunId: CHILD_ID },
      "currentMissing",
      async () => probeDetail(repo, CHILD_ID),
    );
    const observed = fnResult as { ok: boolean; message: string };
    expect(observed.ok).toBe(false);
    expect(observed.message).toContain("不存在");
    expect(restore.clean).toBe(true);
  });

  it("六种注入逐字节还原：指纹差集为空且不留隐藏文件与残留标记", async () => {
    const { traces } = tempTraces();
    const before = (() => {
      // 复用 U5 的指纹原语：直接经注入模块外的同一实现（require 避免 TS 类型面扩张）
      const u5 = require("../scripts/lib/u5-read-faults.cjs") as {
        fingerprintDir: (dir: string) => Record<string, string>;
        diffFingerprints: (
          a: Record<string, string>,
          b: Record<string, string>,
        ) => { added: string[]; removed: string[]; changed: string[] };
      };
      return { u5, snap: u5.fingerprintDir(traces) };
    })();
    for (const kind of lineageFaults.LINEAGE_FAULT_KINDS) {
      const target: FaultTarget =
        kind === "currentMissing" || kind === "forkInvalid"
          ? { tracesDir: traces, childRunId: CHILD_ID }
          : { ...CHILD_TARGET(), tracesDir: traces };
      const { restore } = await lineageFaults.withLineageFault(target, kind, async () => undefined);
      expect(restore.clean, `${kind} 未回到施加前`).toBe(true);
      expect(restore.diff).toEqual({ added: [], removed: [], changed: [] });
    }
    expect(before.u5.diffFingerprints(before.snap, before.u5.fingerprintDir(traces))).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
    expect(readdirSync(traces).filter((n) => n.includes(lineageFaults.HIDDEN_SUFFIX))).toEqual([]);
    expect(readdirSync(traces)).not.toContain("RESTORE-NEEDED.txt");
  });

  it("selfcheck：注入没收口就留下差异 ⇒ 「逐字节还原」不是恒绿判据", async () => {
    const { traces } = tempTraces();
    const u5 = require("../scripts/lib/u5-read-faults.cjs") as {
      fingerprintDir: (dir: string) => Record<string, string>;
      diffFingerprints: (
        a: Record<string, string>,
        b: Record<string, string>,
      ) => { changed: string[] };
    };
    const before = u5.fingerprintDir(traces);
    const handle = lineageFaults.beginLineageFault(
      { ...CHILD_TARGET(), tracesDir: traces },
      "ancestorCorrupt",
    );
    // 故意不 end（模拟 tag 中途崩掉）⇒ 差集必须非空，否则这一判据永远不会报残留
    expect(u5.diffFingerprints(before, u5.fingerprintDir(traces)).changed).not.toEqual([]);
    expect(handle.end().clean).toBe(true);
  });

  it("selfcheck：注入窗口里多出一个文件 ⇒ 落 RESTORE-NEEDED 标记并认残留", async () => {
    const { traces } = tempTraces();
    const { restore } = await lineageFaults.withLineageFault(
      { ...CHILD_TARGET(), tracesDir: traces },
      "ancestorMissing",
      async () => {
        writeFileSync(join(traces, "u6-stray.jsonl"), "多出来的文件\n");
      },
    );
    expect(restore.clean).toBe(false);
    expect(restore.marked).toBe(true);
    expect(restore.diff.added).toContain("u6-stray.jsonl");
    expect(readdirSync(traces)).toContain("RESTORE-NEEDED.txt");
    rmSync(join(traces, "RESTORE-NEEDED.txt"), { force: true });
    rmSync(join(traces, "u6-stray.jsonl"), { force: true });
  });

  it("重复 end 直接抛：注入句柄不能被「还原两次」掩盖状态", async () => {
    const { traces } = tempTraces();
    const handle = lineageFaults.beginLineageFault(
      { ...CHILD_TARGET(), tracesDir: traces },
      "ancestorMissing",
    );
    expect(handle.end().clean).toBe(true);
    expect(() => handle.end()).toThrow(/已 end/);
  });

  it("ancestor 类注入缺 ancestorRunId ⇒ 施加前拒绝（不改任何字节）", () => {
    const { traces } = tempTraces();
    expect(() =>
      lineageFaults.beginLineageFault(
        { tracesDir: traces, childRunId: CHILD_ID },
        "ancestorMissing",
      ),
    ).toThrow(/ancestorRunId/);
  });
});
