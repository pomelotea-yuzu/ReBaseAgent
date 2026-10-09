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

  it("标量扩展：字符串与布尔放行", () => {
    expect(parseArmParams('{"reasoning_effort": "none", "think": false}')).toEqual({
      ok: true,
      params: { reasoning_effort: "none", think: false },
    });
  });

  it("非 JSON / 非对象 / 嵌套对象 / 数组 / null → 拦截并给出具体原因", () => {
    expect(parseArmParams("{bad")).toMatchObject({ ok: false });
    expect(parseArmParams("[1,2]")).toMatchObject({ ok: false });
    expect(parseArmParams('{"t": {"nested": 1}}')).toMatchObject({ ok: false });
    expect(parseArmParams('{"t": [1,2]}')).toMatchObject({ ok: false });
    expect(parseArmParams('{"t": null}')).toMatchObject({ ok: false });
    expect(parseArmParams('{"t": 1}')).toMatchObject({ ok: true });
  });

  it("非有限数字（NaN / Infinity）→ 拦截", () => {
    // JSON 无 NaN/Infinity 字面量，用超范围数字触发 Infinity
    expect(parseArmParams('{"t": 1e999}')).toMatchObject({ ok: false });
  });

  it.each(["model", "messages", "tools", "stream", "stream_options"])(
    "保留键 %s → 拦截（与 agent-loop 同一键集）",
    (key) => {
      const result = parseArmParams(`{"${key}": "x"}`);
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.reason).toContain("保留键");
    },
  );
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

  it("逐臂空 fork：任一臂与父完全相同即拦（粒度与内核一致，不是「全部相同」才拦）", () => {
    // 两臂都与父相同 → 拦，且逐臂点名
    const allSame = modelAbGuard({
      ...BASE,
      arms: arms(
        { model: "deepseek-chat", paramsText: '{"temperature": 0.7}' },
        { model: "deepseek-chat", paramsText: "" },
      ),
    });
    expect(allSame.canSubmit).toBe(false);
    expect(allSame.reason).toContain("第 1 臂");
    expect(allSame.reason).toContain("第 2 臂");
    expect(allSame.reason).toContain("与父 run 完全相同");

    // 回归点（2026-09-17 K0 验收暴露）：臂 1 改了、臂 2 沿用父 —— 界面曾放行，
    // 提交后内核逐臂 derive 判出空 fork、整批 INVALID_ARM。此处必须拦在第 2 臂。
    const secondUnchanged = modelAbGuard({
      ...BASE,
      arms: arms({ model: "m-1", paramsText: "" }, { model: "deepseek-chat", paramsText: "" }),
    });
    expect(secondUnchanged.canSubmit).toBe(false);
    expect(secondUnchanged.reason).toContain("第 2 臂");
    expect(secondUnchanged.reason).not.toContain("第 1 臂");
    expect(secondUnchanged.arms).toEqual([]);

    // 每臂都与父不同 → 放行（臂与臂之间相同与否不受此判据约束）
    const differs = modelAbGuard({
      ...BASE,
      arms: arms(
        { model: "m-1", paramsText: '{"temperature": 0.7}' },
        { model: "m-2", paramsText: '{"temperature": 0.7}' },
      ),
    });
    expect(differs.canSubmit).toBe(true);
  });

  it("空 fork 判据对标量天然成立（字符串 / 布尔差异也算改变）", () => {
    // 字符串标量与父相同 → 该臂是空 fork
    const sameScalar = modelAbGuard({
      ...BASE,
      parentParams: { reasoning_effort: "none", think: false },
      arms: arms(
        { model: "deepseek-chat", paramsText: '{"reasoning_effort": "none", "think": false}' },
        { model: "deepseek-chat", paramsText: "" },
      ),
    });
    expect(sameScalar.canSubmit).toBe(false);
    expect(sameScalar.reason).toContain("与父 run 完全相同");

    // 两个字符串臂都与父不同 → 放行
    const differsScalar = modelAbGuard({
      ...BASE,
      parentParams: { reasoning_effort: "none" },
      arms: arms(
        { model: "deepseek-chat", paramsText: '{"reasoning_effort": "high"}' },
        { model: "deepseek-chat", paramsText: '{"reasoning_effort": "low"}' },
      ),
    });
    expect(differsScalar.canSubmit).toBe(true);

    // 布尔与字符串不相等（类型不同）⇒ "false" 相对父值 false 算改变
    const boolVsString = modelAbGuard({
      ...BASE,
      parentParams: { think: false },
      arms: arms(
        { model: "deepseek-chat", paramsText: '{"think": "false"}' },
        { model: "deepseek-chat", paramsText: '{"think": true}' },
      ),
    });
    expect(boolVsString.canSubmit).toBe(true);
  });

  it("带副作用工具且未确认 → 拦截；勾选后放行，且声明展开到每一臂", () => {
    const input = {
      ...BASE,
      riskyTools: ["write_file"],
      arms: arms({ model: "m1", paramsText: "" }, { model: "m2", paramsText: "" }),
    };
    expect(modelAbGuard(input).canSubmit).toBe(false);
    expect(modelAbGuard(input).reason).toContain("write_file");

    const allowed = modelAbGuard({ ...input, allowSideEffects: true });
    expect(allowed.canSubmit).toBe(true);
    // 批次级确认必须展开到每臂：内核判据是 arms.every(allowSideEffects === true)，
    // 只勾复选框而不下发声明 = 勾了也必被 TOOL_POLICY 整批拒绝。
    expect(allowed.arms).toEqual([
      { model: "m1", allowSideEffects: true },
      { model: "m2", allowSideEffects: true },
    ]);

    // 没有 risky 工具时不下发声明（无可声明之物，避免 fork.edit 留无意义的审计记录）
    const pure = modelAbGuard({
      ...BASE,
      allowSideEffects: true,
      arms: arms({ model: "m1", paramsText: "" }, { model: "m2", paramsText: "" }),
    });
    expect(pure.canSubmit).toBe(true);
    expect(pure.arms).toEqual([{ model: "m1" }, { model: "m2" }]);
  });

  it("params 的空对象等价沿用父值：model 也相同则仍判空 fork", () => {
    const result = modelAbGuard({
      ...BASE,
      arms: arms(
        { model: "deepseek-chat", paramsText: "{}" },
        { model: "deepseek-chat", paramsText: "" },
      ),
    });
    expect(result.canSubmit).toBe(false);
    expect(result.reason).toContain("与父 run 完全相同");

    // 换成 model 后放行，且 `{}` 被规整成"沿用父值"（不下发空 params 覆盖父录值）
    const withModel = modelAbGuard({
      ...BASE,
      arms: arms({ model: "m-1", paramsText: "{}" }, { model: "m-2", paramsText: "" }),
    });
    expect(withModel.canSubmit).toBe(true);
    expect(withModel.arms).toEqual([{ model: "m-1" }, { model: "m-2" }]);
  });
});
