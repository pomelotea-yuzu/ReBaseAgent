import type { ModelArmPlan } from "@shared/ipc";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { COLLAPSE_THRESHOLD } from "../src/renderer/src/components/LongText";
import { ArmPlanRow } from "../src/renderer/src/components/ModelAbEditor";

// ModelAbEditor → store → lib/api.ts 模块级读 window.api：先打桩再求值（引擎室纪律）
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).window = { api: {} };
});

/**
 * U8 任务 3.4 的**能力断言**（delta「长模型上游和告警可完整核对」）：
 * 超长的 model / 参数值 / 丢弃值 / 告警经 LongText 呈现——默认折叠（带真实字符数）、
 * 可展开为完整原文、可复制原文；短值保持原内联形态（不引入无谓折叠噪音）。
 * 纯展示组件，喂 props 直接 renderToStaticMarkup。
 */

function plan(overrides: Partial<ModelArmPlan> = {}): ModelArmPlan {
  return {
    index: 0,
    model: "deepseek-chat",
    params: { temperature: 0.7 },
    overridden: ["temperature"],
    added: [],
    discarded: [],
    warnings: [],
    changed: ["temperature"],
    ...overrides,
  } as unknown as ModelArmPlan;
}

describe("U8 3.4：ArmPlanRow 长字段展开与复制", () => {
  it("短值 ⇒ 内联原形态（无折叠、无 details）", () => {
    const html = renderToStaticMarkup(<ArmPlanRow arm={plan()} />);
    expect(html).toContain("deepseek-chat");
    expect(html).not.toContain("<details");
    expect(html).toContain("（覆盖）");
  });

  it("超长 model ⇒ 折叠摘要（带字符数）+ details 可展开，完整原文仍在 DOM", () => {
    const longModel = "m".repeat(COLLAPSE_THRESHOLD + 1);
    const html = renderToStaticMarkup(<ArmPlanRow arm={plan({ model: longModel })} />);
    expect(html).toContain("<details");
    expect(html).toContain(`${longModel.length} 字符`);
    expect(html).toContain("点击展开完整内容");
    // 展开后才有复制工具条（LongText 既有契约：showTools = 展开态）；
    // 折叠态 DOM 仍持有完整原文（复制目标恒为原文的契约前提）
    expect(html).toContain(longModel);
  });

  it("超长告警 reason ⇒ 可展开可复制（绕行文案同样处理）", () => {
    const reason = "r".repeat(COLLAPSE_THRESHOLD + 1);
    const html = renderToStaticMarkup(
      <ArmPlanRow
        arm={plan({
          warnings: [{ key: "num_ctx", reason, workaround: "改用支持 num_ctx 的 upstream" }],
        })}
      />,
    );
    expect(html).toContain("<details");
    expect(html).toContain(reason);
    expect(html).toContain("改用支持 num_ctx 的 upstream");
  });

  it("超长丢弃父录值 ⇒ 同样可展开复制（整体替换语义文案保留）", () => {
    const longValue = "v".repeat(COLLAPSE_THRESHOLD + 1);
    const html = renderToStaticMarkup(
      <ArmPlanRow arm={plan({ discarded: [["num_predict", longValue]] })} />,
    );
    expect(html).toContain("<details");
    expect(html).toContain("整体替换不合并");
  });
});
