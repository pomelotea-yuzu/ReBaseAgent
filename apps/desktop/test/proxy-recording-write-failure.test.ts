import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProxyRecording } from "@rebaseagent/llm-proxy";
import { afterEach, describe, expect, it } from "vitest";
import { ProxyForkError, ProxyManager } from "../src/main/proxy-manager";
import type { ProxyRecorderSink } from "../src/main/proxy-manager";
import { ProxyRunRecorder } from "../src/main/proxy-recorder";
import { RunRepository } from "../src/main/run-repository";
import { type SettingsCipher, SettingsStore } from "../src/main/settings";
import { deriveErrorTarget } from "../src/shared/overview";

/**
 * 写入失败不报告新记录（tasks 3.5b）。
 *
 * 契约来源：llm-proxy delta「写入失败不报告新记录」——
 * 「转发已成功但 recorder.write 失败 ⇒ 不推进成功记录 revision 或宣告 run 可用，
 * 客户端仍按既有转发规则得到响应；主动重发返回 PROXY_RECORDING_WRITE_FAILED，
 * 保留草稿、不返回其他请求 ID、不标本次录制成功」。
 *
 * 这条契约此前**只被间接测过**（U4 任务 2.10 的「主动录制写入失败 ⇒ 明确失败」）：
 * 那批用 `jsonlIn(tracesDir)` 前后对比钉住了「不落盘、不借用 id」，
 * 但**没有钉住通知与 revision 这一侧**——而 renderer 的记录列表正是靠
 * `recordsRevision` + `records` 通知刷新的。若写失败也推进 revision，
 * 列表会去做一次注定读不到新记录的读取，而 UI 上还会短暂闪过一次
 * 「列表已更新」的假象。本批补上这一侧，并把它与被动录制交错、
 * 新旧失败概览、占位指标放在同一批里核对。
 *
 * 交错用 recorder 注入面确定性制造（与 U4 2.10 同一手法）：本次 fork 的写入
 * 抛错前后各让一条被动录制落在同一轮里。代理走真实 127.0.0.1 回环 + stub
 * upstream，零真实 API。
 */

const cipher: SettingsCipher = {
  isAvailable: () => true,
  encrypt: (plain) => `enc:${plain}`,
  decrypt: (encoded) => encoded.slice(4),
};

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CHAT = "/v1/chat/completions";
const SECRET = "Bearer sk-writefail-8888888";
const SYSTEM_PROMPT = "你是文件助手。";

/** 一条成功的被动录制（交错用） */
function passiveRecording(content: string): ProxyRecording {
  return {
    meta: {
      task: "(llm-proxy)",
      model: "deepseek-chat",
      source: { kind: "proxy", base_url: "http://127.0.0.1:1/v1" },
    },
    started_at: new Date().toISOString(),
    request: {
      model: "deepseek-chat",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content },
      ],
      tools: undefined,
      params: { temperature: 0.7 },
    },
    response: {
      content: "被动回复",
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 3, out: 2 },
      ttft_ms: 0,
    },
    outcome: "completed",
  };
}

/** 一条失败父本（stopped/error + 自有请求 + 顶层 error） */
function failedRecording(): ProxyRecording {
  return {
    meta: {
      task: "(llm-proxy)",
      model: "deepseek-chat",
      source: { kind: "proxy", base_url: "http://127.0.0.1:1/v1" },
    },
    started_at: new Date().toISOString(),
    request: {
      model: "deepseek-chat",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: "原始消息" },
      ],
      tools: undefined,
      params: { temperature: 0.7 },
    },
    response: {
      content: null,
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 0, out: 0 },
      ttft_ms: 0,
    },
    outcome: "error",
    error: { message: "Invalid API key", status: 401 },
  };
}

interface Behavior {
  /** 本次 fork 的录制写入抛错（模拟磁盘/权限失败） */
  failForkWrite: boolean;
  /** fork 写入抛错后，仍让一条被动录制在同一轮里落盘 */
  interleaveAfterForkFailure: boolean;
  forkWriteCalls: number;
  /** 成功落盘的 fork id（写失败时必须为空——不得借用任何 id） */
  forkIds: string[];
  passiveIds: string[];
}

function jsonlIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
}

/** 起套真实监听的代理，recorder 走注入面（可注入写失败与交错） */
async function setup(options: {
  failForkWrite: boolean;
  interleaveAfterForkFailure: boolean;
  parentKind: "failed" | "ok";
}): Promise<{
  manager: ProxyManager;
  repository: RunRepository;
  tracesDir: string;
  behavior: Behavior;
  /** 已落盘的父本 run id（failed 形态：有自有失败调用 + 顶层 error） */
  parentId: string;
  recordNotices: { count: number };
  statusNotices: { count: number };
}> {
  const dataDir = tempDir("proxy-writefail-");
  const tracesDir = join(dataDir, "traces");
  mkdirSync(tracesDir, { recursive: true });
  const repository = new RunRepository(tracesDir);
  const settings = new SettingsStore({ dataDir, cipher });
  const real = new ProxyRunRecorder(tracesDir);
  const behavior: Behavior = {
    failForkWrite: options.failForkWrite,
    interleaveAfterForkFailure: options.interleaveAfterForkFailure,
    forkWriteCalls: 0,
    forkIds: [],
    passiveIds: [],
  };
  // 交错用的真实端口：sink 构造早于 manager.toggle，故用 holder 承接
  const portRef: { port: number } = { port: 0 };
  const sink: ProxyRecorderSink = {
    write: (recording, fork) => {
      if (fork === undefined) {
        const id = real.write(recording);
        behavior.passiveIds.push(id);
        return id;
      }
      behavior.forkWriteCalls += 1;
      if (behavior.failForkWrite) {
        if (behavior.interleaveAfterForkFailure) {
          // 写失败之后立刻让一条**真实被动请求**经代理落盘（不是直调 sink：
          // 直调会绕过 recorder.record 的 notifyRecord，测不到 revision 语义）。
          // 它会成功并推进 recordsRevision——这是被动录制本就该有的可见性，
          // 主动重发不得因此宣称自己的记录存在。
          queueMicrotask(() => {
            void fetch(`http://127.0.0.1:${portRef.port}${CHAT}`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: SECRET },
              body: JSON.stringify({
                model: "deepseek-chat",
                messages: [{ role: "user", content: "交错：别的请求" }],
              }),
            })
              .then((r) => r.text())
              .catch(() => undefined);
          });
        }
        throw new Error("主动录制写入失败：目标路径不可写");
      }
      const id = real.write(recording, fork);
      behavior.forkIds.push(id);
      return id;
    },
  };
  const manager = new ProxyManager({
    repository,
    settings,
    tracesDir,
    newRecorder: () => sink,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "stub 回复" } }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  const recordNotices = { count: 0 };
  const statusNotices = { count: 0 };
  manager.onChange((notice) => {
    if (notice.changes.includes("records")) recordNotices.count += 1;
    if (notice.changes.includes("status")) statusNotices.count += 1;
  });
  await manager.toggle({ enabled: true, port: 0, upstreamBaseUrl: "https://upstream.test" });
  portRef.port = manager.status().port;

  // 父本：failed 形态是 3.6 的产物（失败也可作父本）；ok 形态用于「重发成功」对照
  const parentRecording: ProxyRecording =
    options.parentKind === "failed"
      ? failedRecording()
      : {
          ...passiveRecording("原始消息"),
          meta: {
            task: "(llm-proxy)",
            model: "deepseek-chat",
            source: { kind: "proxy", base_url: "http://127.0.0.1:1/v1" },
          },
        };
  const parentId = real.write(parentRecording);

  // 采集凭据（fork 门禁要求 hasKey，且事实须取当刻）
  await captureCredential(manager);
  // 采集与建父本都发生在"取基线"之前：清零计数，断言只看 fork 阶段发生的事
  behavior.passiveIds.length = 0;
  behavior.forkWriteCalls = 0;
  behavior.forkIds.length = 0;
  // 通知计数同理：凭据捕获那次被动录制已发过 records 通知
  recordNotices.count = 0;
  statusNotices.count = 0;

  return { manager, repository, tracesDir, behavior, parentId, recordNotices, statusNotices };
}

/** 经真实代理发一次请求完成凭据捕获 */
async function captureCredential(manager: ProxyManager): Promise<void> {
  const port = manager.status().port;
  await fetch(`http://127.0.0.1:${port}${CHAT}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: SECRET },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: "x" }],
    }),
  }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 30));
}

function factsOf(manager: ProxyManager) {
  const f = manager.status();
  return {
    expectedKeyCaptureRevision: f.keyCaptureRevision,
    expectedUpstreamBaseUrl: f.upstreamBaseUrl,
    expectedPort: f.port,
  };
}

const EDITED: Record<string, unknown>[] = [
  { role: "system", content: SYSTEM_PROMPT },
  { role: "user", content: "编辑后的消息" },
];

// ---------------------------------------------------------------------------
// 3.5b：写失败不报告新记录
// ---------------------------------------------------------------------------

describe("3.5b 写入失败不报告新记录", () => {
  it("写失败 ⇒ 不推进 recordsRevision、不发 records 通知，主动方收到 PROXY_RECORDING_WRITE_FAILED", async () => {
    const fixture = await setup({
      failForkWrite: true,
      interleaveAfterForkFailure: false,
      parentKind: "failed",
    });
    const before = fixture.manager.status();
    const beforeRevision = before.recordsRevision;

    const error = await fixture.manager
      .fork({
        parentRunId: fixture.parentId,
        atSpanId: "s_02",
        messages: EDITED,
        ...factsOf(fixture.manager),
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProxyForkError);
    expect((error as ProxyForkError).code).toBe("PROXY_RECORDING_WRITE_FAILED");
    expect((error as ProxyForkError).message).toContain("目标路径不可写");

    // 🔴 核心判据：recordsRevision 未推进
    expect(fixture.manager.status().recordsRevision).toBe(beforeRevision);
    // records 通知也未发出（只有捕获凭据那次 status 通知）
    expect(fixture.recordNotices.count).toBe(0);
  });

  it("写失败时不新建 run 文件、不借用其他请求的 id（成功路径对照）", async () => {
    const failCase = await setup({
      failForkWrite: true,
      interleaveAfterForkFailure: false,
      parentKind: "failed",
    });
    const before = jsonlIn(failCase.tracesDir);
    const failure = (await failCase.manager
      .fork({
        parentRunId: failCase.parentId,
        atSpanId: "s_02",
        messages: EDITED,
        ...factsOf(failCase.manager),
      })
      .catch((e: unknown) => e)) as ProxyForkError;
    expect(failure.code).toBe("PROXY_RECORDING_WRITE_FAILED");
    // 目录里不多不少：只有父本与凭据捕获那两条
    expect(jsonlIn(failCase.tracesDir)).toEqual(before);
    expect(failCase.behavior.forkIds).toEqual([]);

    // 对照：写成功时确实推进、确实落盘、确实返回本次 id
    const okCase = await setup({
      failForkWrite: false,
      interleaveAfterForkFailure: false,
      parentKind: "failed",
    });
    const okBefore = jsonlIn(okCase.tracesDir);
    const okRevision = okCase.manager.status().recordsRevision;
    const { id } = await okCase.manager.fork({
      parentRunId: okCase.parentId,
      atSpanId: "s_02",
      messages: EDITED,
      ...factsOf(okCase.manager),
    });
    expect(okCase.manager.status().recordsRevision).toBe(okRevision + 1);
    expect(okCase.recordNotices.count).toBe(1);
    expect(jsonlIn(okCase.tracesDir)).toHaveLength(okBefore.length + 1);
    expect(okCase.behavior.forkIds).toEqual([id]);
    expect(okCase.repository.loadRunRecord(id).meta.parent).toBe(okCase.parentId);
  });

  it("交错：fork 写失败后同轮的被动录制成功落盘 ⇒ 主动方仍报写失败，且不把被动的 id 当自己的", async () => {
    const fixture = await setup({
      failForkWrite: true,
      interleaveAfterForkFailure: true,
      parentKind: "failed",
    });
    const revisionBefore = fixture.manager.status().recordsRevision;

    const error = await fixture.manager
      .fork({
        parentRunId: fixture.parentId,
        atSpanId: "s_02",
        messages: EDITED,
        ...factsOf(fixture.manager),
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProxyForkError);
    expect((error as ProxyForkError).code).toBe("PROXY_RECORDING_WRITE_FAILED");

    // 交错的被动那条确实落盘了（否则本用例退化成「没有交错」）
    await new Promise((r) => setTimeout(r, 50));
    expect(fixture.behavior.passiveIds.length).toBeGreaterThanOrEqual(1);
    const passiveId = fixture.behavior.passiveIds[fixture.behavior.passiveIds.length - 1] as string;

    // 被动那条成功 ⇒ revision 推进（这是它的正常可见性，不是主动的）
    expect(fixture.manager.status().recordsRevision).toBeGreaterThan(revisionBefore);
    // 但主动方仍没拿到任何 id，错误里也不含被动 id
    const serialized = JSON.stringify({
      code: (error as ProxyForkError).code,
      message: (error as ProxyForkError).message,
    });
    expect(serialized).not.toContain(passiveId);
    // fork 自己的写入既没落盘也没推进
    expect(fixture.behavior.forkWriteCalls).toBe(1);
    expect(fixture.behavior.forkIds).toEqual([]);
  });

  it("写失败后概览与占位指标照旧只反映已落盘的记录（不凭空出现新失败）", async () => {
    const fixture = await setup({
      failForkWrite: true,
      interleaveAfterForkFailure: false,
      parentKind: "failed",
    });
    const before = jsonlIn(fixture.tracesDir);
    await fixture.manager
      .fork({
        parentRunId: fixture.parentId,
        atSpanId: "s_02",
        messages: EDITED,
        ...factsOf(fixture.manager),
      })
      .catch(() => undefined);
    // 写失败没有多出文件来
    expect(jsonlIn(fixture.tracesDir)).toEqual(before);

    // 目录没有新文件 ⇒ 概览侧能读到的「自有失败」仍然只是父本那条
    const record = fixture.repository.loadRunRecord(fixture.parentId);
    const target = deriveErrorTarget({
      spans: record.spans,
      leafSpanIds: record.spans.map((s) => s.id),
      reason: "error",
    });
    // 父本是 401 失败：status 有值、message 有值、missingDetail 为 false
    expect(target.status).toBe(401);
    expect(target.message).toBe("Invalid API key");
    expect(target.missingDetail).toBe(false);
    // 占位指标：失败调用的 usage/ttft 是占位 0，UI 层由 call-detail-view 的措辞覆盖
    const call = record.spans.find((s) => s.kind === "llm.call");
    expect(call?.response?.usage).toEqual({ in: 0, out: 0 });
    expect(call?.response?.ttft_ms).toBe(0);
  });
});
