import { describe, expect, it } from "vitest";
import { modelAbGuard, parseArmParams, riskyToolNames } from "../src/renderer/src/lib/model-ab";
import type { ArmDraft } from "../src/renderer/src/lib/model-ab";

function arms(...drafts: ArmDraft[]): ArmDraft[] {
  return drafts;
}

const BASE = {
  settingsConfigured: true,
  parentModel: "deepseek-chat",
  parentParams: { temperature: 0.7 },
  riskyTools: [] as string[],
  allowSideEffects: false,
};

describe("parseArmParams", () => {
  it("空串 = 沿用父 run params（undefined）", () => {
    expect(parseArmParams("")).toEqual({ ok: true, params: undefined });
    expect(parseArmParams("   ")).toEqual({ ok: true, params: undefined });
  });

  it("数值对象放行；空对象等价沿用父值", () => {
    expect(parseArmParams('{"temperature": 0.9}')).toEqual({
      ok: true,
      params: { temperature: 0.9 },
    });
    expect(parseArmParams("{}")).toEqual({ ok: true, params: undefined });
  });

  it("非 JSON / 非对象 / 非有限数字 → 拦截并给出具体原因", () => {
    expect(parseArmParams("{bad")).toMatchObject({ ok: false });
    expect(parseArmParams("[1,2]")).toMatchObject({ ok: false });
    expect(parseArmParams('{"t": "hot"}')).toMatchObject({ ok: false });
    expect(parseArmParams('{"t": 1}')).toMatchObject({ ok: true });
  });
});

describe("riskyToolNames：与编排层判据同源（sideEffect !== false 即有副作用）", () => {
  it("缺标记、true、非布尔都算 risky；显式 false 豁免", () => {
    expect(
      riskyToolNames([
        { name: "write_file", sideEffect: true },
        { name: "legacy_tool" },
        { name: "read_file", sideEffect: false },
        { name: "odd", sideEffect: "yes" },
      ]),
    ).toEqual(["write_file", "legacy_tool", "odd"]);
  });

  it("无工具表（undefined）→ 空", () => {
    expect(riskyToolNames(undefined)).toEqual([]);
  });
});

describe("modelAbGuard：提交前本地拦截", () => {
  it("两臂不同 model → 放行", () => {
    const result = modelAbGuard({
      ...BASE,
      arms: arms({ model: "m1", paramsText: "" }, { model: "m2", paramsText: "" }),
    });
    expect(result.canSubmit).toBe(true);
    expect(result.arms).toEqual([{ model: "m1" }, { model: "m2" }]);
  });

  it("未配置运行参数 → 拦截", () => {
    const result = modelAbGuard({
      ...BASE,
      settingsConfigured: false,
      arms: arms({ model: "m1", paramsText: "" }, { model: "m2", paramsText: "" }),
    });
    expect(result.canSubmit).toBe(false);
    expect(result.reason).toContain("运行配置");
  });

  it("单臂 → 拦截（单臂请用 prompt fork）", () => {
    const result = modelAbGuard({ ...BASE, arms: arms({ model: "m1", paramsText: "" }) });
    expect(result.canSubmit).toBe(false);
    expect(result.reason).toContain("至少需要 2 个 arm");
  });

  it("model 为空 / params 非法 → 逐臂给原因", () => {
    const result = modelAbGuard({
      ...BASE,
      arms: arms({ model: "", paramsText: "" }, { model: "m2", paramsText: "{bad" }),
    });
    expect(result.canSubmit).toBe(false);
    expect(result.reason).toContain("第 1 臂：model 不能为空");
    expect(result.reason).toContain("第 2 臂");
  });

  it("全部臂与父完全相同（model + params）→ 空实验拒绝；只差一个键则放行", () => {
    const same = modelAbGuard({
      ...BASE,
      arms: arms(
        { model: "deepseek-chat", paramsText: '{"temperature": 0.7}' },
        { model: "deepseek-chat", paramsText: "" },
      ),
    });
    expect(same.canSubmit).toBe(false);
    expect(same.reason).toContain("空实验");

    const differs = modelAbGuard({
      ...BASE,
      arms: arms(
        { model: "deepseek-chat", paramsText: '{"temperature": 0.7}' },
        { model: "deepseek-chat", paramsText: '{"temperature": 0.9}' },
      ),
    });
    expect(differs.canSubmit).toBe(true);
  });

  it("带副作用工具且未确认 → 拦截；勾选后放行（逃生舱是批次级确认）", () => {
    const input = {
      ...BASE,
      riskyTools: ["write_file"],
      arms: arms({ model: "m1", paramsText: "" }, { model: "m2", paramsText: "" }),
    };
    expect(modelAbGuard(input).canSubmit).toBe(false);
    expect(modelAbGuard(input).reason).toContain("write_file");

    const allowed = modelAbGuard({ ...input, allowSideEffects: true });
    expect(allowed.canSubmit).toBe(true);
    // allowSideEffects 是批次级声明，不进单臂形状
    expect(allowed.arms).toEqual([{ model: "m1" }, { model: "m2" }]);
  });

  it("params 的空对象等价沿用父值：model 也相同则仍判空实验", () => {
    const result = modelAbGuard({
      ...BASE,
      arms: arms(
        { model: "deepseek-chat", paramsText: "{}" },
        { model: "deepseek-chat", paramsText: "" },
      ),
    });
    expect(result.canSubmit).toBe(false);
    expect(result.reason).toContain("空实验");
  });
});
