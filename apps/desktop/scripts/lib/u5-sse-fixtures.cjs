/* eslint-disable */
/**
 * U5 任务 6.1：受控 SSE 剧本目录（§6.1 自检与 §6.2–6.8 实机**共用同一份期望值**）。
 *
 * 为什么要有这个文件：6.2–6.8 每个 tag 都要回答同一个问题——"这次真的执行了几个请求、
 * 这条 run 自有的终止事实是什么"。此前各批各写各的剧本，期望调用数只写在注释里，
 * 判红时说不清是产品错了还是剧本错了。这里把**剧本 + 期望调用数 + 期望自有终止事件**
 * 绑成一条记录，实机侧只引用 id，不再口头约定。
 *
 * 三条硬约束：
 * - 全部经 `../mock-llm-server.cjs`（只监听 127.0.0.1）⇒ **零付费 provider**，
 *   `h.served()` / `h.entries()` 就是调用计数与请求留痕；
 * - 上限类结局靠 runLoop 的两处检查（`run-loop.ts:106-111` 轮首、`:198-206` 轮末）。
 *   ⚠️ 工具表为空也能造：未知工具的失败是**数据**（`tool-registry.ts:33-39` 回
 *   `未知工具：x` 的 error tool_result），循环照旧继续 ⇒ 不必为剧本去开隔离模式；
 * - 需要在飞捕获的剧本**失败回合也带 `delayMs`**（UI-VERIFY 的 6.x 纪律：只给成功回合
 *   延时会让探针扑空）。
 *
 * ⚠️ 额度常量（`MAX_ITERATIONS` / `MAX_TOTAL_TOKENS`）与 main 硬编码同值
 * （`run-create.ts:75-76`、`fork-runner.ts:152-153`）——写死是刻意的：剧本要按用量算出
 * 超限。漂移由 `test/controlled-sse-fixtures.test.ts` 的源码比对判红，不靠人记住。
 */
"use strict";

/** 与 main 编排一致的额度常量（见文件头注记） */
const MAX_ITERATIONS = 10;
const MAX_TOTAL_TOKENS = 100_000;

/**
 * 剧本目录。每条字段：
 * - `id` 引用键（实机 `--fixture=ID`）
 * - `用途` 一句话说明它替哪条 delta 场景立证
 * - `scenarios` 对应的 `specs/desktop-ui/spec.md` 场景标题（逐字，供 evidence-index 对账）
 * - `script` 直接交给 `mock-llm-server.cjs` / `prepare(call, script)` 的剧本
 * - `expectedCalls` 期望的模型调用次数（`served()` 增量）
 * - `expectedEvent` / `expectedReason` 期望的**自有终止事件**（不是文件 `status`——
 *   `status=completed` 只代表已封存）
 * - `expectedErrorStatus` 期望落盘的 `llm.call.error.status`（仅失败剧本）
 * - `notes` 剧本之外的口径（为什么是这个次数）
 */
const FIXTURES = {
  successPlain: {
    id: "successPlain",
    用途: "普通创建 / result / prompt 的正常路径：自有 stopped/completed ⇒ 才允许清理草稿",
    scenarios: ["新建 run 成功", "单运行正常结束清理匹配修订", "留在当前流程可进入成功或失败概览"],
    script: { turns: [{ content: "受控成功：一步答完。", usage: { in: 120, out: 40 } }] },
    expectedCalls: 1,
    expectedEvent: "stopped",
    expectedReason: "completed",
    notes: "单轮无 tool_calls ⇒ runLoop 轮末直接 completed（`run-loop.ts:198`）。",
  },

  fail503: {
    id: "fail503",
    用途: "模型侧 503：信封 ok 与否都不改「运行 error」这一自有事实，草稿保留",
    scenarios: ["成功信封但运行错误", "执行失败不产生半成品", "失败与读取恢复分别收尾"],
    script: {
      turns: [{ mode: "fail", status: 503, content: "upstream unavailable", delayMs: 1200 }],
    },
    expectedCalls: 1,
    expectedEvent: "errored",
    expectedReason: "error",
    expectedErrorStatus: 503,
    notes:
      "503 不是 429：剧本刻意用 503，与 tasks 6.1「受控 SSE 503」口径一致。" +
      "⚠️ runLoop 不把 LLM 失败抛出（`run-create.ts:140-151` 靠终止事件判成败）⇒ 无重试，恰一次调用。",
  },

  delayedInFlight: {
    id: "delayedInFlight",
    用途: "造出真实在飞窗口：离页/切运行/读取途中导航/未解冻门禁都在这个窗口里点",
    scenarios: ["执行中离页仍可查询等待", "读取途中离页仍不抢焦点", "提交快照独立于编辑器挂载"],
    script: { turns: [{ content: "受控慢响应：窗口足够长。", delayMs: 6000 }] },
    expectedCalls: 1,
    expectedEvent: "stopped",
    expectedReason: "completed",
    notes: "delayMs 在响应头之前生效（`mock-llm-server.cjs:321-327`）⇒ 窗口是真的，不是界面装的。",
  },

  budgetExceeded: {
    id: "budgetExceeded",
    用途: "限制类结局：已封存但**不是**正常结束 ⇒ 保留草稿、不称测试通过",
    scenarios: [
      "封存限制中止和未知不等于正常结束",
      "失败与读取恢复分别收尾",
      "解冻后修改不被旧结果删除",
    ],
    script: {
      turns: [
        {
          toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"README.md"}' }],
          usage: { in: 60_000, out: 60_000 },
        },
      ],
    },
    expectedCalls: 1,
    expectedEvent: "stopped",
    expectedReason: "budget_exceeded",
    notes:
      "单轮 usage 求和 120000 > 100000 ⇒ 轮末预算检查命中（`run-loop.ts:204-206`）。" +
      "带 tool_calls 是为了让轮末不走 completed 早退；read_file 在空工具表下失败为数据，循环继续。",
  },

  maxIterations: {
    id: "maxIterations",
    用途: "上限类结局之二：迭代上限 ⇒ 同样保留草稿",
    scenarios: ["封存限制中止和未知不等于正常结束", "失败定位和返回草稿明确可达"],
    script: {
      turns: [],
      fallback: { toolCalls: [{ id: "loop", name: "read_file", args: "{}" }] },
    },
    expectedCalls: MAX_ITERATIONS,
    expectedEvent: "stopped",
    expectedReason: "max_iterations",
    notes:
      "fallback 每轮都回 tool_calls ⇒ 永不走 completed；第 10 轮结束后轮首上限命中" +
      "（`run-loop.ts:106-108`）。用量默认值很小 ⇒ 不会先撞预算。",
  },

  notConsumed: {
    id: "notConsumed",
    用途: "「确实零执行」那一面：门禁拒绝的入口一旦真发了请求就会留下两处可区痕迹",
    scenarios: [
      "初始握手失败禁用主动入口",
      "settings 未配置时拒绝",
      "userMessage 为空时禁用提交",
      "实验预览和结果不隐式清理批次",
    ],
    script: { turns: [{ mode: "fail", status: 418, content: "这条剧本不该被消费" }] },
    expectedCalls: 0,
    expectedEvent: null,
    expectedReason: null,
    notes:
      "期望调用数为 0：任何一次消费都会同时留下 `served()` 增量与 HTTP 418 ⇒ " +
      "「零模型调用」是数出来的、不是没人提。",
  },
};

const FIXTURE_IDS = Object.keys(FIXTURES);

/** 按 id 取剧本；未知 id 直接抛（实机 tag 传错 id 不该静默跑默认剧本） */
function fixtureOf(id) {
  const f = FIXTURES[id];
  if (f === undefined) {
    throw new Error(`未知受控剧本：${id}（可选：${FIXTURE_IDS.join(", ")}）`);
  }
  return f;
}

module.exports = {
  FIXTURES,
  FIXTURE_IDS,
  fixtureOf,
  MAX_ITERATIONS,
  MAX_TOTAL_TOKENS,
};
