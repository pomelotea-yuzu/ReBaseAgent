import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseRunText, readRun } from "@rebaseagent/trace-sdk";
import { deriveCacheHitTotal, deriveMissingLlmErrorDetail, deriveRunSummary } from "@shared/derive";
import { describe, expect, it } from "vitest";

/**
 * U1（refactor-run-workspace）任务 1.1：结局 fixture 组的预期结局表验证。
 *
 * 数据来源：`apps/desktop/scripts/gen-u1-outcome-fixtures.cjs`
 * （可重复生成：固定时间常量，两次生成逐字节一致；生成物落 `.rebaseagent/u1-fixtures`，
 *  不入库，故无需 Git LFS/大文件考虑）。
 *
 * ⚠️ 本文件的定位是**数据契约校验**，不是 U1 的验收：
 *   - 它证明「这批 fixture 的结局形状与预期结局表一致」，即测试输入确实满足 1.1 的条件；
 *   - 它**不**证明概览/列表/树节点已按这些形状正确展示——那属于任务 2.x 与 5.x，
 *     本 change 的实现尚未开始。
 *   - 因此这里只调用**现有**派生（derive*），不预判 U1 尚未实现的结局分类函数签名。
 *
 * ⚠️ 已知覆盖缺口（诚实记录，勿当作已覆盖）：
 *   1.2 才补「长任务/长模型/短 ID 碰撞」「坏版本数据」「隔离多工具/二次分叉」等；
 *   缺父链（祖先 run 缺失）语料归 U6，不在此处伪造。
 */

const FIXTURE_DIR = resolve(import.meta.dirname, "../../../.rebaseagent/u1-fixtures");
const EXPECTED_FILE = resolve(FIXTURE_DIR, "EXPECTED-OUTCOMES.json");

/** 结局分类的预期形状（与生成器的 EXPECTED-OUTCOMES.json 同构） */
interface Expectation {
  status: "completed" | "crashed";
  lastReason: string | null;
  outcome: string;
  label: string;
  tone: string;
  ownsLlm: boolean;
  hasOwnLlmError: boolean;
  finalOutput: string | null;
  intermediateOutput: string | null;
  cacheCoverage: [number, number];
  cacheHitTotal?: number;
  missingErrorDetail: boolean;
}

const expectations = JSON.parse(readFileSync(EXPECTED_FILE, "utf8")) as Record<string, Expectation>;

function loadFixture(name: string) {
  const text = readFileSync(resolve(FIXTURE_DIR, `${name}.jsonl`), "utf8");
  return parseRunText(text.split("\n"));
}

/**
 * 自有 llm.call。
 *
 * ⚠️ 口径说明：`leafSpanIds` 只存在于 main 的 `RunDetail`（`getRun` 产出），
 * `readRun` 返回的 `RunRecord` **没有**该字段——直接读 `record.leafSpanIds` 会得到
 * undefined 并把全部 span 判为非自有（本文件初版就踩了这个坑）。
 * 这里按 `getRun` 的等价规则重建：**本 run 文件里的 span 就是自有 span**，
 * 祖先前缀由 `resolveBranch` 在合并时才拼进来，不落文件。
 */
function ownSpansOf(name: string) {
  const record = readRun(resolve(FIXTURE_DIR, `${name}.jsonl`));
  return record.spans;
}

function ownLlmCalls(name: string) {
  return ownSpansOf(name).filter((span) => span.kind === "llm.call");
}

/** 与 getRun 产出的 RunDetail 同构取用（供 deriveMissingLlmErrorDetail 消费） */
function asRunDetail(name: string) {
  const record = readRun(resolve(FIXTURE_DIR, `${name}.jsonl`));
  return {
    events: record.events,
    spans: record.spans,
    // 根 run 与只记录新增段的分支 run 同此规则：文件内 span 全为自有
    leafSpanIds: record.spans.map((span) => span.id),
  };
}

/**
 * 按 desktop-ui delta「运行概览呈现自有结果与消耗」的措辞，从**现有**字段复核结局形状。
 * 这里刻意复述规格条件（而不是调用尚不存在的派生），使断言依据可追溯到 spec 文本。
 */
function observedOutcome(name: string) {
  const record = readRun(resolve(FIXTURE_DIR, `${name}.jsonl`));
  const lastEvent = record.events[record.events.length - 1] ?? null;
  const llm = ownLlmCalls(name);
  const last = llm[llm.length - 1];

  // 最终输出条件：正常终止 + 最后自有调用非空正文 + 无 error + 无待执行 tool_calls
  const normalEnd = lastEvent?.reason === "completed";
  const finalOutput =
    normalEnd && last !== undefined && (last.response.content ?? "") !== ""
      ? last.response.content
      : null;

  // 中间输出：未能作为最终输出时，最近一条自有非空正文
  let intermediateOutput: string | null = null;
  if (finalOutput === null) {
    for (let i = llm.length - 1; i >= 0; i--) {
      const content = llm[i]?.response.content;
      if (content !== null && content !== undefined && content !== "") {
        intermediateOutput = content;
        break;
      }
    }
  }

  const withHit = llm.filter((span) => span.response.usage.cache_hit !== undefined);

  return {
    status: record.status,
    lastReason: lastEvent?.reason ?? null,
    ownsLlm: llm.length > 0,
    hasOwnLlmError: llm.some((span) => span.error !== undefined),
    finalOutput,
    intermediateOutput,
    cacheCoverage: [withHit.length, llm.length] as [number, number],
  };
}

const fixtureNames = Object.keys(expectations).sort();

describe("U1 结局 fixture：资产齐备且通过真实 reader 校验", () => {
  it("预期结局表与实际生成物成对存在", () => {
    for (const name of fixtureNames) {
      const file = resolve(FIXTURE_DIR, `${name}.jsonl`);
      expect(existsSync(file), `缺少 fixture：${name}.jsonl`).toBe(true);
    }
  });

  it("每份 fixture 都能被 readRun 读取（含版本守卫与跨行约束）", () => {
    for (const name of fixtureNames) {
      const record = readRun(resolve(FIXTURE_DIR, `${name}.jsonl`));
      expect(record.spans.length, name).toBeGreaterThan(0);
    }
  });

  it("文件中声明的 id 与预期表的键一一对应（不张冠李戴）", () => {
    for (const name of fixtureNames) {
      const record = readRun(resolve(FIXTURE_DIR, `${name}.jsonl`));
      expect(record.meta.id, name).toBe(name.replace(/-/g, "_"));
    }
  });
});

describe("断言① 正常结束直接看到最终输出", () => {
  it("u1-ok：终局调用有非空正文且无待执行工具调用，正文即最终输出", () => {
    const observed = observedOutcome("u1-ok");
    expect(observed.status).toBe("completed");
    expect(observed.lastReason).toBe("completed");
    expect(observed.hasOwnLlmError).toBe(false);

    const llm = ownLlmCalls("u1-ok");
    const last = llm[llm.length - 1];
    // 三个条件缺一不可——任一不满足就不该被当作最终输出
    expect(last?.response.content).not.toBeNull();
    expect(last?.response.content).not.toBe("");
    expect(last?.response.tool_calls).toHaveLength(0);
    expect(last?.error).toBeUndefined();

    expect(observed.finalOutput).toBe(expectations["u1-ok"]?.finalOutput);
    expect(observed.intermediateOutput).toBeNull();
  });

  it("u1-ok 摘要的 reason 与 status 均不暗示质量验证或测试通过", () => {
    const summary = deriveRunSummary(loadFixture("u1-ok"));
    expect(summary.status).toBe("completed");
    expect(summary.reason).toBe("completed");
    // 正常结束只表示已结束；工具错误计数独立于终止原因
    expect(summary.toolErrors).toBe(0);
  });
});

describe("断言② 旧失败记录没有错误详情", () => {
  it("u1-error-detail：error 终止且自有调用带 error ⇒ 不判缺失", () => {
    const observed = observedOutcome("u1-error-detail");
    expect(observed.lastReason).toBe("error");
    expect(observed.hasOwnLlmError).toBe(true);
    expect(observed.finalOutput).toBeNull();
    // 失败前的正文只能作中间输出，不冒充最终结果
    expect(observed.intermediateOutput).toBe(expectations["u1-error-detail"]?.intermediateOutput);
  });

  it("u1-error-legacy：error 终止但自有 LLM 无 error 详情 ⇒ 判缺失且不虚构调用", () => {
    const observed = observedOutcome("u1-error-legacy");

    expect(observed.lastReason).toBe("error");
    expect(observed.hasOwnLlmError).toBe(false);
    expect(deriveMissingLlmErrorDetail(asRunDetail("u1-error-legacy"))).toBe(true);
  });

  it("u1-error-legacy：工具错误真实存在但不被当作终止根因", () => {
    const record = readRun(resolve(FIXTURE_DIR, "u1-error-legacy.jsonl"));
    const toolErrors = record.spans.filter(
      (span) => span.kind === "tool.invoke" && span.error !== null,
    );
    expect(toolErrors).toHaveLength(1);

    // 工具错误存在并不能免除「LLM 错误详情未记录」的提示——两者是不同事实
    expect(deriveMissingLlmErrorDetail(asRunDetail("u1-error-legacy"))).toBe(true);
  });

  it("对照片：u1-error-detail 的缺失判定为 false（判据有牙，不是恒真）", () => {
    expect(deriveMissingLlmErrorDetail(asRunDetail("u1-error-detail"))).toBe(false);
  });
});

describe("断言③ 限制中止与中断如实展示", () => {
  it("u1-aborted：reason=aborted ⇒ 有终止原因，最近正文降级为中间输出", () => {
    const observed = observedOutcome("u1-aborted");
    expect(observed.status).toBe("completed");
    expect(observed.lastReason).toBe("aborted");
    expect(observed.finalOutput).toBeNull();
    expect(observed.intermediateOutput).toBe(expectations["u1-aborted"]?.intermediateOutput);
    expect(expectations["u1-aborted"]?.outcome).toBe("aborted");
  });

  it("u1-crashed：无终止事件 ⇒ status 为 crashed、reason 为 null，不推断仍在执行", () => {
    const record = readRun(resolve(FIXTURE_DIR, "u1-crashed.jsonl"));
    expect(record.status).toBe("crashed");
    expect(record.events).toHaveLength(0);

    const observed = observedOutcome("u1-crashed");
    expect(observed.lastReason).toBeNull();
    expect(observed.finalOutput).toBeNull();
    expect(observed.intermediateOutput).toBe(expectations["u1-crashed"]?.intermediateOutput);
    // 中断不是错误终止 ⇒ 不触发「错误详情未记录」提示
    expect(deriveMissingLlmErrorDetail(asRunDetail("u1-crashed"))).toBe(false);
  });

  it("上限样本复用既有 infinite-loop（max_iterations 已在 trace-sdk 基准内）", () => {
    const record = readRun(
      resolve(import.meta.dirname, "../../../packages/trace-sdk/fixtures/infinite-loop.jsonl"),
    );
    expect(record.events[0]?.reason).toBe("max_iterations");
    expect(deriveRunSummary(record).reason).toBe("max_iterations");
  });
});

describe("断言④ 无最终正文不借用祖先补全", () => {
  it("u1-reasoning-only：仅有思维链 ⇒ 未记录最终输出，但内容类型可辨", () => {
    const observed = observedOutcome("u1-reasoning-only");
    expect(observed.finalOutput).toBeNull();
    expect(observed.intermediateOutput).toBeNull();

    const llm = ownLlmCalls("u1-reasoning-only");
    const last = llm[llm.length - 1];
    expect(last?.response.reasoning_content).not.toBeNull();
    expect(last?.response.reasoning_content).not.toBe("");
  });

  it("u1-tool-only：仅有待执行 tool_calls ⇒ 空正文不得当作最终输出", () => {
    const observed = observedOutcome("u1-tool-only");
    expect(observed.status).toBe("completed");
    expect(observed.lastReason).toBe("completed");
    expect(observed.finalOutput).toBeNull();
    expect(observed.intermediateOutput).toBeNull();

    const llm = ownLlmCalls("u1-tool-only");
    expect(llm[llm.length - 1]?.response.tool_calls.length).toBeGreaterThan(0);
  });

  it("u1-fork-child：子运行无自有调用 ⇒ 不借用祖先正文填空", () => {
    const observed = observedOutcome("u1-fork-child");
    expect(observed.ownsLlm).toBe(false);
    expect(observed.finalOutput).toBeNull();
    expect(observed.intermediateOutput).toBeNull();
  });

  it("反例对照：父运行 u1-fork-parent 自身确有可展示正文", () => {
    // 若父运行也没有正文，上一条用例就失去意义——故显式钉住对照条件
    const observed = observedOutcome("u1-fork-parent");
    expect(observed.ownsLlm).toBe(true);
    expect(observed.finalOutput).toBe(expectations["u1-fork-parent"]?.finalOutput);
    expect(observed.finalOutput).not.toBeNull();
  });

  it("子运行的自有 span 不含祖先 id（镜像判定不依赖合并视图）", () => {
    const child = readRun(resolve(FIXTURE_DIR, "u1-fork-child.jsonl"));
    const parent = readRun(resolve(FIXTURE_DIR, "u1-fork-parent.jsonl"));
    const parentIds = new Set(parent.spans.map((span) => span.id));

    expect(child.meta.parent).toBe(parent.meta.id);
    expect(child.spans.length).toBeGreaterThan(0);
    for (const span of child.spans) {
      expect(parentIds.has(span.id), `子运行的 span 不应含祖先 id：${span.id}`).toBe(false);
    }
  });
});

describe("缓存部分覆盖：区分未知与零命中", () => {
  it("u1-cache-partial：3 次自有调用中 2 次带 cache_hit ⇒ 部分覆盖，不得称全量命中率", () => {
    const observed = observedOutcome("u1-cache-partial");
    expect(observed.cacheCoverage).toEqual(expectations["u1-cache-partial"]?.cacheCoverage);
    expect(observed.cacheCoverage).toEqual([2, 3]);
  });

  it("u1-cache-partial：命中合计只累加有值项（0 参与、缺失跳过）", () => {
    expect(deriveCacheHitTotal(ownSpansOf("u1-cache-partial"))).toBe(
      expectations["u1-cache-partial"]?.cacheHitTotal,
    );
  });

  it("无缓存字段的老记录 ⇒ null（未知 ≠ 0）", () => {
    const record = readRun(resolve(FIXTURE_DIR, "u1-error-legacy.jsonl"));
    expect(deriveRunSummary(record).cacheHit).toBeNull();
    expect(observedOutcome("u1-error-legacy").cacheCoverage).toEqual([0, 2]);
  });
});

describe("预期结局表与实测形状逐项一致", () => {
  for (const name of fixtureNames) {
    it(`${name} 的形状与 EXPECTED-OUTCOMES.json 相符`, () => {
      const expected = expectations[name];
      if (expected === undefined) throw new Error(`预期表缺少 ${name}`);

      const observed = observedOutcome(name);
      expect(observed.status, `${name}.status`).toBe(expected.status);
      expect(observed.lastReason, `${name}.lastReason`).toBe(expected.lastReason);
      expect(observed.ownsLlm, `${name}.ownsLlm`).toBe(expected.ownsLlm);
      expect(observed.hasOwnLlmError, `${name}.hasOwnLlmError`).toBe(expected.hasOwnLlmError);
      expect(observed.finalOutput, `${name}.finalOutput`).toBe(expected.finalOutput);
      expect(observed.intermediateOutput, `${name}.intermediateOutput`).toBe(
        expected.intermediateOutput,
      );
      expect(observed.cacheCoverage, `${name}.cacheCoverage`).toEqual(expected.cacheCoverage);
    });
  }
});
