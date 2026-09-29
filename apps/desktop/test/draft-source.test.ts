import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import type { CallDraftSource } from "../src/renderer/src/lib/debugging-drafts";
import {
  captureCallDraftSource,
  revalidateCallDraftSource,
  revalidateModelAbDraftSource,
  toolResultText,
} from "../src/renderer/src/lib/draft-source";
import type { RunDetail } from "../src/shared/ipc";

/**
 * U3（preserve-debugging-drafts）任务 1.4：草稿源基线的捕获与恢复重验。
 *
 * 判据来源（desktop-ui delta「草稿可定位且来源失效不丢输入」）：
 *   - 源记录缺失损坏或发生改变：保留原身份和草稿供复制/放弃，禁止执行，
 *     不替换为另一调用或静默采用新基线
 *   - 阅读回退不删除草稿且重新校验才能执行：只有原来源和既有能力重新校验
 *     通过后才恢复执行资格（本文件测「重新校验」判定本身；「不删除草稿」
 *     在 debugging-drafts.test.ts 的 store 接线段锁定）
 *   - prompt 和实验恢复重验首次调用资格：重推首次 llm.call 身份，不仅凭
 *     span ID 相同放行；不新增算法版本签名或跨重载迁移
 *
 * ⚠️ 本文件测纯逻辑层（源基线捕获 + 重验判定）；编辑器恢复接线归任务 2.5/2.6。
 */

const FIXTURE = resolve(import.meta.dirname, "../../../packages/trace-sdk/fixtures/normal.jsonl");
const record: RunRecord = readRun(FIXTURE);

/** 由真实 fixture 构造能通过 RunDetailSchema 校验的 detail（main 侧同构） */
function detailFrom(rec: RunRecord): RunDetail {
  return {
    meta: rec.meta,
    spans: rec.spans,
    events: rec.events,
    status: rec.status,
    chain: [{ meta: rec.meta, fork: rec.meta.fork }],
    leafSpanIds: rec.spans.map((s) => s.id),
    completeness: "complete",
    spanScope: "own",
    lineage: { status: "complete" },
  };
}

const detail = detailFrom(record);
const RUN_ID = detail.meta.id; // "r_01"
const FIRST_LLM_ID = "s_02"; // fixture 首个 llm.call（含字符串 system/user 消息）
const TOOL_ID = "s_03"; // fixture 首个 tool.invoke

const firstLlmSpan = detail.spans.find((s) => s.id === FIRST_LLM_ID);
const toolSpan = detail.spans.find((s) => s.id === TOOL_ID);
if (firstLlmSpan === undefined || firstLlmSpan.kind !== "llm.call") {
  throw new Error("fixture 缺少首个 llm.call span（s_02）");
}
if (toolSpan === undefined || toolSpan.kind !== "tool.invoke") {
  throw new Error("fixture 缺少 tool.invoke span（s_03）");
}

const TOOL_BASELINE = toolResultText(toolSpan);

/** 源基线（从 fixture 详情捕获，供各用例派生改动） */
const llmSource = captureCallDraftSource(detail, firstLlmSpan);
const toolSource = captureCallDraftSource(detail, toolSpan);

/** 替换某 llm.call span 的请求消息（其余 span 原样） */
function withLlmMessages(
  spanId: string,
  messages: Array<{ role: string; content: string }>,
): RunDetail {
  return {
    ...detail,
    spans: detail.spans.map((s) =>
      s.id === spanId && s.kind === "llm.call" ? { ...s, request: { ...s.request, messages } } : s,
    ),
  };
}

describe("源基线捕获（captureCallDraftSource）", () => {
  it("llm.call 目标记录 run 资格事实与启动上下文/模型/参数/工具表签名", () => {
    expect(llmSource.runStatus).toBe(detail.status);
    expect(llmSource.leafSpanIds).toEqual(detail.leafSpanIds);
    expect(llmSource.configHash).toBe(detail.meta.config_hash);
    expect(llmSource.proxy).toBe(false);
    expect(llmSource.isolated).toBe(false);
    if (llmSource.target.kind !== "llm.call") throw new Error("应为 llm.call 事实");
    expect(llmSource.target.startupSystem).toBe("你是文件助手，按用户要求完成文件任务。");
    expect(llmSource.target.startupUser).toBe("请读取 README.md 并把要点写入 summary.md");
    expect(llmSource.target.model).toBe("deepseek-chat");
    // 签名是确定性序列化：同源数据重算必相同
    expect(llmSource.target.paramsSignature).toContain("temperature");
    expect(llmSource.target.toolsSignature).toContain("read_file");
    expect(llmSource.target.messagesSignature).toContain("README.md");
  });

  it("源基线只存事实：不携带版本/算法签名键（不新增算法版本签名）", () => {
    const plain = JSON.parse(JSON.stringify(llmSource)) as Record<string, unknown>;
    for (const key of Object.keys(plain)) {
      expect(["version", "algorithm", "signatureVersion", "v"]).not.toContain(key);
    }
    expect(plain.runStatus).toBeDefined();
  });

  it("tool.invoke 目标只记 run 事实，内容基准由条目 baseline 承担", () => {
    expect(toolSource.target).toEqual({ kind: "tool.invoke" });
    expect(toolSource.configHash).toBe(detail.meta.config_hash);
  });
});

describe("恢复重验通过（重新校验后恢复执行资格）", () => {
  it("prompt 字段：详情未变 ⇒ eligible", () => {
    expect(
      revalidateCallDraftSource({
        runId: RUN_ID,
        spanId: FIRST_LLM_ID,
        field: "system_prompt",
        baseline: "你是文件助手，按用户要求完成文件任务。",
        source: llmSource,
        detail,
      }),
    ).toEqual({ kind: "eligible" });
  });

  it("result 字段：工具结果未变 ⇒ eligible", () => {
    expect(
      revalidateCallDraftSource({
        runId: RUN_ID,
        spanId: TOOL_ID,
        field: "result",
        baseline: TOOL_BASELINE,
        source: toolSource,
        detail,
      }),
    ).toEqual({ kind: "eligible" });
  });

  it("A/B 批次：详情未变 ⇒ eligible", () => {
    expect(
      revalidateModelAbDraftSource({
        runId: RUN_ID,
        spanId: FIRST_LLM_ID,
        source: llmSource,
        detail,
      }),
    ).toEqual({ kind: "eligible" });
  });

  it("曾失效的来源恢复（detail 重新可读）⇒ 重新校验通过后资格恢复", () => {
    // 模拟「曾读取失败」：先用 detail=null 拦，再恢复同一详情放行——输入（source）不变
    const input = {
      runId: RUN_ID,
      spanId: FIRST_LLM_ID,
      field: "user_message" as const,
      baseline: "请读取 README.md 并把要点写入 summary.md",
      source: llmSource,
    };
    expect(revalidateCallDraftSource({ ...input, detail: null }).kind).toBe("blocked");
    expect(revalidateCallDraftSource({ ...input, detail })).toEqual({ kind: "eligible" });
  });
});

describe("源记录缺失（source_missing）", () => {
  it("详情缺失或读取失败（detail=null）⇒ 保留草稿、禁止执行", () => {
    const verdict = revalidateCallDraftSource({
      runId: RUN_ID,
      spanId: FIRST_LLM_ID,
      field: "messages",
      baseline: "[]",
      source: llmSource,
      detail: null,
    });
    expect(verdict.kind).toBe("blocked");
    if (verdict.kind === "blocked") expect(verdict.cause).toBe("source_missing");
  });

  it("目标 span 消失 ⇒ source_missing，不换用其他调用冒充恢复", () => {
    // leafSpanIds 保持原样：leaf 判定通过后到达 span 查找，确认消失是 source_missing
    // 而非 leaf 资格失效（两类拦截的原因必须可区分）
    const withoutSpan: RunDetail = {
      ...detail,
      spans: detail.spans.filter((s) => s.id !== FIRST_LLM_ID),
    };
    const verdict = revalidateModelAbDraftSource({
      runId: RUN_ID,
      spanId: FIRST_LLM_ID,
      source: llmSource,
      detail: withoutSpan,
    });
    expect(verdict.kind).toBe("blocked");
    if (verdict.kind === "blocked") {
      expect(verdict.cause).toBe("source_missing");
      expect(verdict.reason).toContain("不换用其他调用");
    }
  });

  it("详情是另一个 run ⇒ source_missing（不拿别运行的详情冒充核对）", () => {
    const other: RunDetail = { ...detail, meta: { ...detail.meta, id: "r_other" } };
    const verdict = revalidateCallDraftSource({
      runId: RUN_ID,
      spanId: FIRST_LLM_ID,
      field: "result",
      baseline: TOOL_BASELINE,
      source: toolSource,
      detail: other,
    });
    expect(verdict.kind).toBe("blocked");
    if (verdict.kind === "blocked") expect(verdict.cause).toBe("source_missing");
  });

  it("旧条目无源基线（source=undefined）⇒ 保守拒绝（不新增迁移逻辑）", () => {
    const verdict = revalidateCallDraftSource({
      runId: RUN_ID,
      spanId: FIRST_LLM_ID,
      field: "system_prompt",
      baseline: "任意",
      source: undefined,
      detail,
    });
    expect(verdict.kind).toBe("blocked");
    if (verdict.kind === "blocked") {
      expect(verdict.cause).toBe("source_missing");
      expect(verdict.reason).toContain("缺少源基线");
    }
  });
});

describe("源内容改变（source_changed：不静默采用新基线）", () => {
  it("prompt：启动上下文的 system 文本被改 ⇒ source_changed", () => {
    const changed = withLlmMessages(FIRST_LLM_ID, [
      { role: "system", content: "被改过的 system" },
      { role: "user", content: "请读取 README.md 并把要点写入 summary.md" },
    ]);
    const verdict = revalidateCallDraftSource({
      runId: RUN_ID,
      spanId: FIRST_LLM_ID,
      field: "system_prompt",
      baseline: "你是文件助手，按用户要求完成文件任务。",
      source: llmSource,
      detail: changed,
    });
    expect(verdict).toMatchObject({ kind: "blocked", cause: "source_changed" });
  });

  it("prompt：源模型/参数/工具表变化同样算源内容改变", () => {
    const changedModel: RunDetail = {
      ...detail,
      spans: detail.spans.map((s) =>
        s.id === FIRST_LLM_ID && s.kind === "llm.call"
          ? { ...s, request: { ...s.request, model: "other-model" } }
          : s,
      ),
    };
    expect(
      revalidateModelAbDraftSource({
        runId: RUN_ID,
        spanId: FIRST_LLM_ID,
        source: llmSource,
        detail: changedModel,
      }),
    ).toMatchObject({ kind: "blocked", cause: "source_changed" });
  });

  it("messages：尾部追加消息（启动文本未变）⇒ messagesSignature 拦截", () => {
    const changed = withLlmMessages(FIRST_LLM_ID, [
      { role: "system", content: "你是文件助手，按用户要求完成文件任务。" },
      { role: "user", content: "请读取 README.md 并把要点写入 summary.md" },
      { role: "user", content: "追加的一条消息" },
    ]);
    const verdict = revalidateCallDraftSource({
      runId: RUN_ID,
      spanId: FIRST_LLM_ID,
      field: "messages",
      baseline: "[]",
      source: llmSource,
      detail: changed,
    });
    expect(verdict).toMatchObject({ kind: "blocked", cause: "source_changed" });
  });

  it("result：当前工具结果与草稿基线不同 ⇒ source_changed", () => {
    const changed: RunDetail = {
      ...detail,
      spans: detail.spans.map((s) =>
        s.id === TOOL_ID && s.kind === "tool.invoke" ? { ...s, result: "被替换的工具结果" } : s,
      ),
    };
    const verdict = revalidateCallDraftSource({
      runId: RUN_ID,
      spanId: TOOL_ID,
      field: "result",
      baseline: TOOL_BASELINE,
      source: toolSource,
      detail: changed,
    });
    expect(verdict).toMatchObject({ kind: "blocked", cause: "source_changed" });
  });
});

describe("既有资格失效（capability_invalid：不仅凭 span ID 相同放行）", () => {
  it("运行状态改变（completed → crashed）⇒ 拦截，即使 span ID 仍存在", () => {
    const crashed: RunDetail = { ...detail, status: "crashed" };
    const verdict = revalidateCallDraftSource({
      runId: RUN_ID,
      spanId: FIRST_LLM_ID,
      field: "system_prompt",
      baseline: "任意",
      source: llmSource,
      detail: crashed,
    });
    expect(verdict).toMatchObject({ kind: "blocked", cause: "capability_invalid" });
  });

  it("目标 span 不再是自有叶子 ⇒ 拦截", () => {
    const notLeaf: RunDetail = {
      ...detail,
      leafSpanIds: detail.leafSpanIds.filter((id) => id !== FIRST_LLM_ID),
    };
    expect(
      revalidateModelAbDraftSource({
        runId: RUN_ID,
        spanId: FIRST_LLM_ID,
        source: llmSource,
        detail: notLeaf,
      }),
    ).toMatchObject({ kind: "blocked", cause: "capability_invalid" });
  });

  it("配置指纹（config_hash）改变 ⇒ 拦截", () => {
    const changedHash: RunDetail = {
      ...detail,
      meta: { ...detail.meta, config_hash: "sha256:changed" },
    };
    expect(
      revalidateCallDraftSource({
        runId: RUN_ID,
        spanId: FIRST_LLM_ID,
        field: "user_message",
        baseline: "任意",
        source: llmSource,
        detail: changedHash,
      }),
    ).toMatchObject({ kind: "blocked", cause: "capability_invalid" });
  });

  it("首次 llm.call 身份不再一致 ⇒ 拦截且明示不得改用后续调用（s_02 仍存在）", () => {
    // 把 s_05 挪到最前 ⇒ 重推的"首次 llm.call"变成 s_05；s_02 仍在详情里（span ID 未消失）
    const s05 = detail.spans.find((s) => s.id === "s_05");
    if (s05 === undefined || s05.kind !== "llm.call") throw new Error("fixture 缺少 s_05");
    const reordered: RunDetail = {
      ...detail,
      spans: [s05, ...detail.spans.filter((s) => s.id !== "s_05")],
    };
    const verdict = revalidateCallDraftSource({
      runId: RUN_ID,
      spanId: FIRST_LLM_ID,
      field: "system_prompt",
      baseline: "任意",
      source: llmSource,
      detail: reordered,
    });
    expect(verdict.kind).toBe("blocked");
    if (verdict.kind === "blocked") {
      expect(verdict.cause).toBe("capability_invalid");
      expect(verdict.reason).toContain("不得跳过首次调用");
    }
  });

  it("messages 字段：录制来源（代理/引擎）事实改变 ⇒ 拦截", () => {
    const nowProxy: RunDetail = {
      ...detail,
      meta: { ...detail.meta, source: { kind: "proxy", base_url: "http://127.0.0.1:8787" } },
    };
    expect(
      revalidateCallDraftSource({
        runId: RUN_ID,
        spanId: FIRST_LLM_ID,
        field: "messages",
        baseline: "[]",
        source: llmSource,
        detail: nowProxy,
      }),
    ).toMatchObject({ kind: "blocked", cause: "capability_invalid" });
  });

  it("prompt/A/B：隔离文件元数据出现 ⇒ 拦截（隔离父本不支持该入口）", () => {
    const isolated: RunDetail = {
      ...detail,
      // 仅重验需要「workspace !== undefined」这一事实；完整 schema 形状由读取层保证
      meta: { ...detail.meta, workspace: {} },
    } as unknown as RunDetail;
    const verdict = revalidateModelAbDraftSource({
      runId: RUN_ID,
      spanId: FIRST_LLM_ID,
      source: llmSource,
      detail: isolated,
    });
    expect(verdict.kind).toBe("blocked");
    if (verdict.kind === "blocked") expect(verdict.cause).toBe("capability_invalid");
  });

  it("字段与目标类型不匹配（result 草稿对到 llm.call）⇒ 拦截", () => {
    expect(
      revalidateCallDraftSource({
        runId: RUN_ID,
        spanId: FIRST_LLM_ID,
        field: "result",
        baseline: "任意",
        source: llmSource,
        detail,
      }),
    ).toMatchObject({ kind: "blocked", cause: "capability_invalid" });
  });
});

describe("源基线结构纪律", () => {
  it("源基线不含授权/凭据/计划字段（与草稿同一纪律）", () => {
    const plain = JSON.stringify(llmSource);
    for (const forbidden of [
      "apiKey",
      "baseURL",
      "writesAuthorized",
      "allowSideEffects",
      "dryRun",
    ]) {
      expect(plain).not.toContain(forbidden);
    }
  });

  it("CallDraftSource 类型形状冻结（防无意识加版本/迁移字段）", () => {
    // 用一个满足类型的样例做形状快照：新增必填字段会让这行编译失败/快照变红，
    // 强制实施者回到 design D2 想清楚（只加事实字段，不加版本签名）。
    const sample: CallDraftSource = {
      runStatus: "completed",
      leafSpanIds: ["s_02"],
      configHash: undefined,
      proxy: false,
      isolated: false,
      target: {
        kind: "llm.call",
        startupSystem: null,
        startupUser: null,
        model: "m",
        paramsSignature: "{}",
        toolsSignature: "null",
        messagesSignature: "[]",
      },
    };
    expect(Object.keys(sample).sort()).toEqual([
      "configHash",
      "isolated",
      "leafSpanIds",
      "proxy",
      "runStatus",
      "target",
    ]);
  });
});
