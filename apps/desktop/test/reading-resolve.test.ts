import type { SpanLine } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import { resolveReading } from "../src/renderer/src/lib/reading-resolve";

/**
 * U1（refactor-run-workspace）任务 3.2：阅读位置解析优先级与安全回退。
 *
 * 判据来源：desktop-ui delta「会话内按运行恢复阅读位置」三个场景：
 *   - 首次步骤选择与空轨迹
 *   - 显式错误定位优先于恢复
 *   - 失效阅读对象安全回退
 */

/** 造一个最小 span（kind 不同即可，字段只填解析需要的部分） */
function span(id: string, kind: SpanLine["kind"], parent: string | null = null): SpanLine {
  if (kind === "agent.step") {
    return { type: "span", kind: "agent.step", id, parent, n: 1 } as SpanLine;
  }
  if (kind === "llm.call") {
    return {
      type: "span",
      kind: "llm.call",
      id,
      parent,
      request: { model: "m", messages: [] },
      response: {
        content: "x",
        reasoning_content: null,
        tool_calls: [],
        usage: { in: 1, out: 1 },
        ttft_ms: 1,
      },
    } as SpanLine;
  }
  return {
    type: "span",
    kind: "tool.invoke",
    id,
    parent,
    tool: "t",
    args: {},
    result: null,
    dur_ms: 1,
    error: null,
  } as SpanLine;
}

describe("默认位置：首次进入选择首个自有调用", () => {
  it("含祖先前缀时，默认选首个**自有**调用（不停在祖先上）", () => {
    const detail = {
      // 前两个是祖先（不在 leafSpanIds），第三个起是自有
      spans: [
        span("s_anc_1", "llm.call"),
        span("s_anc_2", "tool.invoke"),
        span("s_own_step", "agent.step"),
        span("s_own_llm", "llm.call", "s_own_step"),
      ],
      leafSpanIds: ["s_own_step", "s_own_llm"],
      hasFiles: false,
    };
    const resolved = resolveReading({ detail, history: null, target: null });
    expect(resolved.spanId).toBe("s_own_llm");
    expect(resolved.source).toBe("default");
  });

  it("没有自有调用时回退首个可读 span", () => {
    const detail = {
      spans: [span("s_step", "agent.step")],
      leafSpanIds: ["s_step"],
      hasFiles: false,
    };
    const resolved = resolveReading({ detail, history: null, target: null });
    expect(resolved.spanId).toBe("s_step");
    expect(resolved.source).toBe("default");
  });

  it("空轨迹 ⇒ 空态，不伪造步骤", () => {
    const resolved = resolveReading({
      detail: { spans: [], leafSpanIds: [], hasFiles: false },
      history: null,
      target: null,
    });
    expect(resolved.spanId).toBeNull();
    expect(resolved.source).toBe("empty");
  });

  it("默认页签为概览（design D1）", () => {
    const detail = { spans: [span("s_1", "llm.call")], leafSpanIds: ["s_1"], hasFiles: false };
    expect(resolveReading({ detail, history: null, target: null }).tab).toBe("overview");
  });
});

describe("显式错误定位优先于恢复", () => {
  const detail = {
    spans: [
      span("s_step", "agent.step"),
      span("s_llm", "llm.call", "s_step"),
      span("s_tool", "tool.invoke", "s_step"),
    ],
    leafSpanIds: ["s_step", "s_llm", "s_tool"],
    hasFiles: false,
  };

  it("历史停在文件页 + 目标指向错误调用 ⇒ 进步骤页、选中目标、展开所属 step", () => {
    const resolved = resolveReading({
      detail,
      history: { tab: "files", spanId: "s_tool" },
      target: { spanId: "s_llm", expandStepId: "s_step", tab: "steps" },
    });
    expect(resolved.source).toBe("explicit");
    expect(resolved.tab).toBe("steps");
    expect(resolved.spanId).toBe("s_llm");
    expect(resolved.expandStepId).toBe("s_step");
  });

  it("显式目标未指定页签 ⇒ 默认落在步骤页", () => {
    const resolved = resolveReading({
      detail,
      history: { tab: "overview", spanId: null },
      target: { spanId: "s_llm" },
    });
    expect(resolved.tab).toBe("steps");
    expect(resolved.spanId).toBe("s_llm");
  });

  it("显式目标指向的 span 失效 ⇒ 降级到默认位置并标记失效（不静默改选别的）", () => {
    const resolved = resolveReading({
      detail,
      history: null,
      target: { spanId: "s_gone" },
    });
    expect(resolved.source).toBe("explicit");
    expect(resolved.invalidated).toBe(true);
    expect(resolved.spanId).toBe("s_llm"); // 默认：首个自有调用
  });
});

describe("有效历史选择：恢复上次读到哪", () => {
  const detail = {
    spans: [
      span("s_step", "agent.step"),
      span("s_llm", "llm.call", "s_step"),
      span("s_tool", "tool.invoke", "s_step"),
    ],
    leafSpanIds: ["s_step", "s_llm", "s_tool"],
    hasFiles: false,
  };

  it("历史有效 ⇒ 恢复到历史页签与 span", () => {
    const resolved = resolveReading({
      detail,
      history: { tab: "steps", spanId: "s_tool" },
      target: null,
    });
    expect(resolved.source).toBe("history");
    expect(resolved.tab).toBe("steps");
    expect(resolved.spanId).toBe("s_tool");
    expect(resolved.invalidated).toBe(false);
  });

  it("历史 span 失效 ⇒ 回默认位置并标记失效", () => {
    const resolved = resolveReading({
      detail,
      history: { tab: "steps", spanId: "s_gone" },
      target: null,
    });
    expect(resolved.source).toBe("history");
    expect(resolved.invalidated).toBe(true);
    expect(resolved.spanId).toBe("s_llm");
  });

  it("历史页签为文件但该 run 无文件 ⇒ 回退概览并标记失效", () => {
    const resolved = resolveReading({
      detail,
      history: { tab: "files", spanId: "s_llm" },
      target: null,
    });
    expect(resolved.tab).toBe("overview");
    expect(resolved.invalidated).toBe(true);
    expect(resolved.spanId).toBe("s_llm"); // span 本身仍有效，只回退页签
  });

  it("历史选中为 null 但轨迹非空 ⇒ 补默认位置（不是空态）", () => {
    const resolved = resolveReading({
      detail,
      history: { tab: "overview", spanId: null },
      target: null,
    });
    expect(resolved.spanId).toBe("s_llm");
  });
});

describe("失效回退不选别的 run 的同 ID span", () => {
  it("当前详情为空轨迹 ⇒ 历史里 saved 的 span id 不被「恢复」进来", () => {
    // 模拟：切到一条空 run，历史里存着另一条 run 的 span id（恰好同名）
    const resolved = resolveReading({
      detail: { spans: [], leafSpanIds: [], hasFiles: false },
      history: { tab: "steps", spanId: "s_shared" },
      target: null,
    });
    expect(resolved.spanId).toBeNull();
    expect(resolved.invalidated).toBe(true);
  });
});
