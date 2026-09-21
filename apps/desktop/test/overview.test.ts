import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseRunText, readRun } from "@rebaseagent/trace-sdk";
import { deriveErrorTarget, deriveOwnOutput, deriveOwnToolErrors } from "@shared/overview";
import { describe, expect, it } from "vitest";

/**
 * U1（refactor-run-workspace）任务 2.2：自有输出选择与错误目标派生。
 *
 * 判据来源：desktop-ui delta「运行概览呈现自有结果与消耗」四个场景：
 *   - 正常结束直接看到最终输出
 *   - 失败概览定位真实自有调用
 *   - 旧失败记录没有错误详情
 *   - 无最终正文不借用祖先补全
 *
 * ⚠️ 关键反例纪律：以下用例**刻意构造「祖先与自有错误/正文并存」**的输入，
 *    用于证明派生结果来自自有段而非祖先段——只测「有错误时能找到错误」无法发现误归因。
 */

const FIXTURE_DIR = resolve(import.meta.dirname, "../../../.rebaseagent/u1-fixtures");

/**
 * 读取 fixture 并构造与 `getRun` 的 RunDetail 同构的输入。
 *
 * ⚠️ `readRun` 的 RunRecord **没有** `leafSpanIds`（见 1.1 记下的数据源陷阱）；
 * 根 run 与只记录新增段的分支 run 同此规则：**文件内 span 全为自有**。
 * 需要模拟「分支 run 含祖先前缀」时，显式传入拼接后的 spans 与受限的 leafSpanIds。
 */
function runDetail(name: string) {
  const record = readRun(resolve(FIXTURE_DIR, `${name}.jsonl`));
  const lastEvent = record.events[record.events.length - 1] ?? null;
  return {
    spans: record.spans,
    leafSpanIds: record.spans.map((span) => span.id),
    reason: lastEvent?.reason ?? null,
  };
}

const has = (name: string): boolean => existsSync(resolve(FIXTURE_DIR, `${name}.jsonl`));

describe("deriveOwnOutput：正常结束直接看到最终输出", () => {
  it("u1-ok：四条件齐备 ⇒ 最终输出即最后自有调用正文，无中间输出", () => {
    if (!has("u1-ok")) return;
    const detail = runDetail("u1-ok");
    const out = deriveOwnOutput(detail);

    expect(out.missingReason).toBeNull();
    expect(out.finalOutput).not.toBeNull();
    expect(out.latestIntermediate).toBeNull();
    expect(out.lastOutputKind).toBe("content");

    const lastLlm = detail.spans.filter((s) => s.kind === "llm.call").at(-1);
    expect(out.finalOutput?.content).toBe(lastLlm?.response.content);
    // 供「打开该调用并展开所属 step」入口使用
    expect(out.finalOutput?.spanId).toBe(lastLlm?.id);
    expect(out.finalOutput?.stepSpanId).not.toBeNull();
  });

  it("u1-reasoning-only：末次调用仅思维链 ⇒ 不当作最终输出，如实分型", () => {
    if (!has("u1-reasoning-only")) return;
    const out = deriveOwnOutput(runDetail("u1-reasoning-only"));
    expect(out.finalOutput).toBeNull();
    expect(out.lastOutputKind).toBe("reasoning-only");
  });

  it("u1-tool-only：末次调用仅工具调用（待执行）⇒ 不当作最终输出", () => {
    if (!has("u1-tool-only")) return;
    const out = deriveOwnOutput(runDetail("u1-tool-only"));
    expect(out.finalOutput).toBeNull();
    expect(out.lastOutputKind).toBe("tool-calls-only");
    // 待执行工具调用是「循环本应继续」的信号，不能被当成结束
    expect(out.missingReason).toBe("pending-tool-calls");
  });
});

describe("deriveErrorTarget：失败概览定位真实自有调用", () => {
  it("u1-error-detail：error 终止且自有调用带 error ⇒ 给出可定位目标与真实正文", () => {
    if (!has("u1-error-detail")) return;
    const detail = runDetail("u1-error-detail");
    const target = deriveErrorTarget(detail);

    expect(target.missingDetail).toBe(false);
    expect(target.llmCallSpanId).not.toBeNull();
    expect(target.stepSpanId).not.toBeNull();
    expect(target.message).toBeTruthy();

    // 目标确实是自有 spans 里那个带 error 的调用
    const failed = detail.spans.filter((s) => s.kind === "llm.call" && s.error !== undefined);
    expect(target.llmCallSpanId).toBe(failed.at(-1)?.id);
  });

  it("u1-error-legacy：error 终止但自有 LLM 无 error ⇒ 判缺失且不虚构入口", () => {
    if (!has("u1-error-legacy")) return;
    const target = deriveErrorTarget(runDetail("u1-error-legacy"));
    expect(target.missingDetail).toBe(true);
    expect(target.llmCallSpanId).toBeNull();
    expect(target.stepSpanId).toBeNull();
    expect(target.message).toBeNull();
  });

  it("非 error 终止（completed / aborted / crashed）⇒ 不产生错误目标，也不报缺失", () => {
    for (const name of ["u1-ok", "u1-aborted", "u1-crashed"] as const) {
      if (!has(name)) continue;
      const target = deriveErrorTarget(runDetail(name));
      expect(target.missingDetail, name).toBe(false);
      expect(target.llmCallSpanId, name).toBeNull();
    }
  });
});

describe("反例：祖先与自有并存时不得误归因（判据有牙）", () => {
  it("祖先带 error、自有成功 ⇒ 不把祖先错误当本次原因（missingDetail 为 true）", () => {
    if (!has("u1-ok")) return;
    const record = readRun(resolve(FIXTURE_DIR, "u1-ok.jsonl"));
    // 伪造一个「祖先」失败调用，前置拼接进展开轨迹，但不列入 leafSpanIds
    const ancestorFail = {
      type: "span" as const,
      kind: "llm.call" as const,
      id: "s_ancestor_fail",
      parent: null,
      request: { model: "ancestor-model", messages: [] },
      response: {
        content: "祖先的正文",
        reasoning_content: null,
        tool_calls: [],
        usage: { in: 100, out: 10 },
        ttft_ms: 1,
      },
      error: { message: "祖先的错误正文", status: 500 },
    };
    const detail = {
      spans: [ancestorFail, ...record.spans],
      leafSpanIds: record.spans.map((s) => s.id), // 祖先不在自有段
      reason: "error", // 本次以 error 终止，但自有段无失败记录
    };

    const target = deriveErrorTarget(detail);
    // 祖先有 error 详情，但本 run 自有段没有 ⇒ 必须报缺失，而不是把祖先的端上来
    expect(target.missingDetail).toBe(true);
    expect(target.llmCallSpanId).toBeNull();
    expect(target.message).toBeNull();
  });

  it("祖先有正文、自有段无正文 ⇒ 不借用祖先当最终输出或中间输出", () => {
    if (!has("u1-fork-child")) return;
    const record = readRun(resolve(FIXTURE_DIR, "u1-fork-child.jsonl"));
    const ancestorLlm = {
      type: "span" as const,
      kind: "llm.call" as const,
      id: "s_parent_llm",
      parent: null,
      request: { model: "parent-model", messages: [] },
      response: {
        content: "父 run 的最终答复",
        reasoning_content: null,
        tool_calls: [],
        usage: { in: 500, out: 50 },
        ttft_ms: 1,
      },
    };
    const detail = {
      spans: [ancestorLlm, ...record.spans],
      leafSpanIds: record.spans.map((s) => s.id),
      reason: "completed",
    };

    const out = deriveOwnOutput(detail);
    // 子 run 零自有 llm.call ⇒ 明确未记录，绝不用父正文补全
    expect(out.finalOutput).toBeNull();
    expect(out.latestIntermediate).toBeNull();
    expect(out.missingReason).toBe("no-llm-call");
  });

  it("自有段有正文、祖先也有错误 ⇒ 正常结束仍取自有正文为最终输出", () => {
    if (!has("u1-ok")) return;
    const record = readRun(resolve(FIXTURE_DIR, "u1-ok.jsonl"));
    const ancestorFail = {
      type: "span" as const,
      kind: "llm.call" as const,
      id: "s_ancestor_fail2",
      parent: null,
      request: { model: "ancestor-model", messages: [] },
      response: {
        content: null,
        reasoning_content: null,
        tool_calls: [],
        usage: { in: 100, out: 10 },
        ttft_ms: 1,
      },
      error: { message: "祖先失败", status: 500 },
    };
    const detail = {
      spans: [ancestorFail, ...record.spans],
      leafSpanIds: record.spans.map((s) => s.id),
      reason: "completed",
    };

    const out = deriveOwnOutput(detail);
    expect(out.finalOutput).not.toBeNull();
    const ownLast = record.spans.filter((s) => s.kind === "llm.call").at(-1);
    expect(out.finalOutput?.content).toBe(ownLast?.response.content);
  });
});

describe("deriveOwnToolErrors：工具错误独立列出，不当作终止根因", () => {
  it("u1-error-legacy：工具错误真实存在且可定位，但与 LLM 错误详情缺失互不影响", () => {
    if (!has("u1-error-legacy")) return;
    const detail = runDetail("u1-error-legacy");
    const toolErrors = deriveOwnToolErrors(detail);

    expect(toolErrors.length).toBeGreaterThan(0);
    expect(toolErrors[0]?.tool).toBeTruthy();
    expect(toolErrors[0]?.message).toBeTruthy();
    // 工具错误存在并不改变「LLM 错误详情未记录」的判定
    expect(deriveErrorTarget(detail).missingDetail).toBe(true);
  });

  it("u1-ok：无工具错误 ⇒ 空列表（不伪造）", () => {
    if (!has("u1-ok")) return;
    expect(deriveOwnToolErrors(runDetail("u1-ok"))).toEqual([]);
  });

  it("祖先的工具错误不计入自有工具错误", () => {
    if (!has("u1-ok")) return;
    const record = readRun(resolve(FIXTURE_DIR, "u1-ok.jsonl"));
    const ancestorToolError = {
      type: "span" as const,
      kind: "tool.invoke" as const,
      id: "s_ancestor_tool",
      parent: null,
      tool: "ancestor_tool",
      args: {},
      result: null,
      dur_ms: 1,
      error: "祖先的工具错误",
    };
    const detail = {
      spans: [ancestorToolError, ...record.spans],
      leafSpanIds: record.spans.map((s) => s.id),
    };
    expect(deriveOwnToolErrors(detail)).toEqual([]);
  });
});

describe("最终输出四条件逐条有牙（合成的边界输入，不依赖 fixture 恰好覆盖）", () => {
  /**
   * 造一个「自有 llm.call 挂在自己的 step 下」的最小输入。
   * 四个条件里一条不满足，就不得判为最终输出——这里逐条造出「有正文但另一条不满足」，
   * 专门堵住「只看正文非空就认最终输出」这类漏判（变异测试曾在此漏网）。
   */
  function synthetic(input: {
    reason: string | null;
    content: string | null;
    error?: { message: string; status?: number };
    toolCalls?: unknown[];
  }) {
    const step = {
      type: "span" as const,
      kind: "agent.step" as const,
      id: "s_step",
      parent: null,
      n: 1,
    };
    const llm = {
      type: "span" as const,
      kind: "llm.call" as const,
      id: "s_llm",
      parent: "s_step",
      request: { model: "m", messages: [] },
      response: {
        content: input.content,
        reasoning_content: null,
        tool_calls: input.toolCalls ?? [],
        usage: { in: 1, out: 1 },
        ttft_ms: 1,
      },
      ...(input.error === undefined ? {} : { error: input.error }),
    };
    return { spans: [step, llm], leafSpanIds: ["s_step", "s_llm"], reason: input.reason };
  }

  it("正常终止 + 非空正文 + 无 error + 无待执行 tool_calls ⇒ 最终输出", () => {
    const out = deriveOwnOutput(synthetic({ reason: "completed", content: "答复" }));
    expect(out.finalOutput?.content).toBe("答复");
    expect(out.missingReason).toBeNull();
  });

  it("正常终止 + 非空正文 + **有 error** ⇒ 不是最终输出（error 条件有牙）", () => {
    const out = deriveOwnOutput(
      synthetic({ reason: "completed", content: "看起来像答复", error: { message: "失败" } }),
    );
    expect(out.finalOutput).toBeNull();
    expect(out.missingReason).toBe("has-error");
  });

  it("正常终止 + 非空正文 + **有待执行 tool_calls** ⇒ 不是最终输出（tool_calls 条件有牙）", () => {
    const out = deriveOwnOutput(
      synthetic({ reason: "completed", content: "中途话说一半", toolCalls: [{ id: "call_1" }] }),
    );
    expect(out.finalOutput).toBeNull();
    expect(out.missingReason).toBe("pending-tool-calls");
  });

  it("非正常终止（如 aborted）+ 非空正文 ⇒ 不是最终输出，正文降为中间输出", () => {
    const out = deriveOwnOutput(synthetic({ reason: "aborted", content: "被中止前的最后一句" }));
    expect(out.finalOutput).toBeNull();
    expect(out.latestIntermediate?.content).toBe("被中止前的最后一句");
  });
});

describe("与 parseRunText 直读交叉验证（派生不依赖 readRun 之外的隐式状态）", () => {
  it("u1-error-detail：直读解析出的失败调用与派生目标一致", () => {
    if (!has("u1-error-detail")) return;
    const text = readFileSync(resolve(FIXTURE_DIR, "u1-error-detail.jsonl"), "utf8");
    const record = parseRunText(text.split("\n"));
    const detail = {
      spans: record.spans,
      leafSpanIds: record.spans.map((s) => s.id),
      reason: "error",
    };
    const direct = record.spans
      .filter((s) => s.kind === "llm.call" && s.error !== undefined)
      .at(-1);
    expect(deriveErrorTarget(detail).llmCallSpanId).toBe(direct?.id);
  });
});
