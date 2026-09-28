import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCreate } from "../src/main/run-create";
import { RunRepository } from "../src/main/run-repository";
import type { RunSettings } from "../src/main/settings";
import { classifyOutcome } from "../src/shared/outcome";
import { withMockLlm } from "./helpers/mock-llm-harness";

/**
 * U5（unify-run-execution-workflow）任务 6.1：只读失败注入原语的**可用性自检**。
 *
 * 判据来源：tasks.md 6.1「…与调用计数、只读失败注入」；design §D4（核实不得改当前选择）+
 * delta「结果不可读只重试同一记录」「列表失败不阻断已知结果」「封存限制中止和未知不等于正常结束」。
 *
 * ⚠️ 这一支同时产出 6.6 的**分层依据**：桥接面 `window.api` 属性不可写（U4 6.5 实测）⇒
 * 页内篡改 `runs:get` 响应真机做不到，只能从数据侧诱发；而数据侧能诱发什么、诱发后列表与详情
 * 各自是什么形状，只能对着真 `RunRepository` 数出来。本轮数出两条与直觉相反的：
 * ① 损坏/版本非法的文件进 `failed` 而**不**拖垮整表；
 * ② 「列表刷新失败但详情可读」在 fs 层**没有**注入面（列表与详情同源于同一目录）
 *   ⇒ 该场景的实机入口不成立，evidence-index 按 §1 store 用例分层引用。
 */

const require = createRequire(import.meta.url);

interface FaultTarget {
  tracesDir: string;
  runId: string | null;
}
interface FaultEnd {
  clean: boolean;
  restoreError: string | null;
  diff: { added: string[]; removed: string[]; changed: string[] };
  marked: boolean;
}
interface ReadFaultsModule {
  READ_FAULT_KINDS: string[];
  RESTORE_MARKER: string;
  UNKNOWN_TERMINAL_REASON: string;
  UNSUPPORTED_FORMAT_VERSION: number;
  fingerprintDir: (dir: string) => Record<string, string>;
  diffFingerprints: (
    a: Record<string, string>,
    b: Record<string, string>,
  ) => { added: string[]; removed: string[]; changed: string[] };
  beginReadFault: (target: FaultTarget, kind: string) => { kind: string; end: () => FaultEnd };
  withReadFault: (
    target: FaultTarget,
    kind: string,
    fn: () => unknown | Promise<unknown>,
  ) => Promise<{ fnResult: unknown; restore: FaultEnd }>;
}
const readFaults = require("../scripts/lib/u5-read-faults.cjs") as ReadFaultsModule;
const sseCatalog = require("../scripts/lib/u5-sse-fixtures.cjs") as {
  fixtureOf: (id: string) => { script: unknown };
};

const SETTINGS: RunSettings = {
  baseURL: "https://api.invalid.example/v1",
  apiKey: "sk-controlled-only",
  model: "controlled-model",
  encrypted: true,
};

function tempTraces(): { traces: string; repo: RunRepository; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "u5-read-fault-"));
  const traces = join(root, "traces");
  mkdirSync(traces);
  return {
    traces,
    repo: new RunRepository(traces),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 每支用例一份独立靶子：受控服务上现造一条正常结束的真 run（不 mock 编排） */
async function withSeeded(
  fn: (ctx: { traces: string; repo: RunRepository; runId: string }) => Promise<void>,
): Promise<void> {
  const { traces, repo, cleanup } = tempTraces();
  try {
    const runId = await withMockLlm(
      sseCatalog.fixtureOf("successPlain").script as never,
      async (handle) => {
        const { id } = await runCreate(
          {
            repository: repo,
            settings: { ...SETTINGS, baseURL: handle.baseURL },
            execCwd: traces,
          },
          { systemPrompt: "你是简洁的问答助手。", userMessage: "只读失败注入靶子" },
        );
        expect(repo.getRun(id).status).toBe("completed");
        return id;
      },
    );
    await fn({ traces, repo, runId });
  } finally {
    cleanup();
  }
}

/** 详情读取成败与原因文本（"读得出来"与"读出来是什么结局"是两件事） */
function probeDetail(repo: RunRepository, id: string): { ok: boolean; message: string } {
  try {
    repo.getRun(id);
    return { ok: true, message: "" };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** 列表读取成败（列表-only 失败是否存在，两面都要数才结论） */
function probeList(repo: RunRepository): { ok: boolean; message: string } {
  try {
    repo.listRuns();
    return { ok: true, message: "" };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

describe("U5 6.1 只读失败注入：每种注入的实际失败形状（数出来，不猜）", () => {
  it("fileMissing：详情读取失败，列表其余项照常且该 run 既不在 runs 也不在 failed", async () => {
    await withSeeded(async ({ traces, repo, runId }) => {
      const { restore, fnResult } = await readFaults.withReadFault(
        { tracesDir: traces, runId },
        "fileMissing",
        async () => {
          const list = repo.listRuns();
          return {
            detail: probeDetail(repo, runId),
            listed: list.runs.map((r) => r.id),
            failedFiles: list.failed.map((f) => f.file),
          };
        },
      );
      const observed = fnResult as {
        detail: { ok: boolean };
        listed: string[];
        failedFiles: string[];
      };
      expect(observed.detail.ok).toBe(false);
      expect(observed.listed).not.toContain(runId);
      // 文件不在盘上 ⇒ 列表连"坏文件"都不报（与 corruptTail 的区别就在这条，6.6 的措辞靠它分档）
      expect(observed.failedFiles).toEqual([]);
      expect(restore.clean).toBe(true);
    });
  });

  it("corruptTail：坏文件进 failed 而不拖垮整表，详情判不可读", async () => {
    await withSeeded(async ({ traces, repo, runId }) => {
      const { restore, fnResult } = await readFaults.withReadFault(
        { tracesDir: traces, runId },
        "corruptTail",
        async () => {
          const list = repo.listRuns();
          return {
            detail: probeDetail(repo, runId),
            runs: list.runs.length,
            failed: list.failed.length,
            message: list.failed[0]?.error ?? "",
          };
        },
      );
      const observed = fnResult as {
        detail: { ok: boolean };
        runs: number;
        failed: number;
        message: string;
      };
      expect(observed.detail.ok).toBe(false);
      expect(observed.runs).toBe(0);
      expect(observed.failed).toBe(1);
      expect(observed.message).toContain("JSON 解析失败");
      expect(restore.clean).toBe(true);
    });
  });

  it("unsupportedVersion：版本守卫先于 schema，详情与列表条目一起判不可读", async () => {
    await withSeeded(async ({ traces, repo, runId }) => {
      const { restore, fnResult } = await readFaults.withReadFault(
        { tracesDir: traces, runId },
        "unsupportedVersion",
        async () => {
          const list = repo.listRuns();
          return {
            detail: probeDetail(repo, runId),
            failed: list.failed.length,
          };
        },
      );
      const observed = fnResult as { detail: { ok: boolean; message: string }; failed: number };
      expect(observed.detail.ok).toBe(false);
      expect(observed.detail.message).toContain(String(readFaults.UNSUPPORTED_FORMAT_VERSION));
      expect(observed.failed).toBe(1);
      expect(restore.clean).toBe(true);
    });
  });

  it("unknownTerminalReason：非法终止记录被 schema 拒 ⇒ 详情侧到不了「原因未知」显示", async () => {
    await withSeeded(async ({ traces, repo, runId }) => {
      const { restore, fnResult } = await readFaults.withReadFault(
        { tracesDir: traces, runId },
        "unknownTerminalReason",
        async () => ({
          detail: probeDetail(repo, runId),
          failed: repo.listRuns().failed.length,
        }),
      );
      const observed = fnResult as { detail: { ok: boolean }; failed: number };
      // 「不放宽 schema」的机器形状：注入非法 reason 之后详情就是**不可读**，
      // 而不是读出来再显示成未知（未知显示的承载面是 §1 直接构造的事件行，不是文件）
      expect(observed.detail.ok).toBe(false);
      expect(observed.failed).toBe(1);
      expect(restore.clean).toBe(true);
    });
  });

  it("noTerminalEvent：缺终止事件读得出来但 status=crashed ⇒ 中断（不是正常结束）", async () => {
    await withSeeded(async ({ traces, repo, runId }) => {
      const { restore, fnResult } = await readFaults.withReadFault(
        { tracesDir: traces, runId },
        "noTerminalEvent",
        async () => {
          const detail = repo.getRun(runId);
          const summary = repo.listRuns().runs.find((r) => r.id === runId);
          return {
            status: detail.status,
            events: detail.events.length,
            outcome: classifyOutcome({ status: detail.status, reason: null }).kind,
            summaryStatus: summary?.status ?? null,
          };
        },
      );
      const observed = fnResult as {
        status: string;
        events: number;
        outcome: string;
        summaryStatus: string | null;
      };
      expect(observed.status).toBe("crashed");
      expect(observed.events).toBe(0);
      expect(observed.outcome).toBe("interrupted");
      expect(observed.summaryStatus).toBe("crashed");
      expect(restore.clean).toBe(true);
    });
  });

  it("tracesDirGone：列表与详情同时失败 ⇒ 「列表-only 失败」在 fs 层没有注入面", async () => {
    await withSeeded(async ({ traces, repo, runId }) => {
      const { restore, fnResult } = await readFaults.withReadFault(
        { tracesDir: traces, runId: null },
        "tracesDirGone",
        async () => ({ list: probeList(repo), detail: probeDetail(repo, runId) }),
      );
      const observed = fnResult as { list: { ok: boolean }; detail: { ok: boolean } };
      expect(observed.list.ok).toBe(false);
      expect(observed.detail.ok).toBe(false);
      expect(restore.clean).toBe(true);
    });
  });

  it("六种注入逐字节还原：指纹差集为空且不留隐藏文件与残留标记", async () => {
    await withSeeded(async ({ traces, runId }) => {
      const before = readFaults.fingerprintDir(traces);
      for (const kind of readFaults.READ_FAULT_KINDS) {
        const target = { tracesDir: traces, runId: kind === "tracesDirGone" ? null : runId };
        const { restore } = await readFaults.withReadFault(target, kind, async () => undefined);
        expect(restore.clean, `${kind} 未回到施加前`).toBe(true);
        expect(restore.diff).toEqual({ added: [], removed: [], changed: [] });
      }
      expect(readFaults.diffFingerprints(before, readFaults.fingerprintDir(traces))).toEqual({
        added: [],
        removed: [],
        changed: [],
      });
      expect(readdirSync(traces).filter((n) => n.includes(".u5-hidden"))).toEqual([]);
      expect(readdirSync(traces)).not.toContain(readFaults.RESTORE_MARKER);
    });
  });

  it("selfcheck：注入没收口就留下差异 ⇒ 「逐字节还原」不是恒绿判据", async () => {
    await withSeeded(async ({ traces, runId }) => {
      const before = readFaults.fingerprintDir(traces);
      const handle = readFaults.beginReadFault({ tracesDir: traces, runId }, "corruptTail");
      // 故意不 end（模拟 tag 中途崩掉）⇒ 差集必须非空，否则这一判据永远不会报残留
      expect(
        readFaults.diffFingerprints(before, readFaults.fingerprintDir(traces)).changed,
      ).not.toEqual([]);
      expect(handle.end().clean).toBe(true);
    });
  });

  it("selfcheck：注入窗口里多出一个文件 ⇒ 落 RESTORE-NEEDED 标记并认残留", async () => {
    await withSeeded(async ({ traces, runId }) => {
      const { restore } = await readFaults.withReadFault(
        { tracesDir: traces, runId },
        "fileMissing",
        async () => {
          writeFileSync(join(traces, "u5-stray.jsonl"), "多出来的文件\n");
        },
      );
      expect(restore.clean).toBe(false);
      expect(restore.marked).toBe(true);
      expect(restore.diff.added).toContain("u5-stray.jsonl");
      // 标记落在 traces 里 ⇒ 收尾核验据此判红，不靠人记得
      expect(readdirSync(traces)).toContain(readFaults.RESTORE_MARKER);
      rmSync(join(traces, readFaults.RESTORE_MARKER), { force: true });
      rmSync(join(traces, "u5-stray.jsonl"), { force: true });
    });
  });

  it("重复 end 直接抛：注入句柄不能被「还原两次」掩盖状态", async () => {
    await withSeeded(async ({ traces, runId }) => {
      const handle = readFaults.beginReadFault({ tracesDir: traces, runId }, "corruptTail");
      expect(handle.end().clean).toBe(true);
      expect(() => handle.end()).toThrow(/已 end/);
    });
  });
});
