import { describe, expect, it } from "vitest";
import { modelAbGuard, parseArmParams, riskyToolNames } from "../src/renderer/src/lib/model-ab";
import type { ArmDraft } from "../src/renderer/src/lib/model-ab";
import { createTestTranslator } from "./i18n/render-with-locale";

const zh = createTestTranslator("zh-CN");
const en = createTestTranslator("en-US");
const guardOf = (input: Parameters<typeof modelAbGuard>[0]) => modelAbGuard(input, zh);

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
      if (!result.ok) {
        expect(result.code).toBe("RESERVED_KEY");
        expect(result.key).toBe(key);
      }
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
    const result = guardOf({
      ...BASE,
      arms: arms({ model: "m1", paramsText: "" }, { model: "m2", paramsText: "" }),
    });
    expect(result.canSubmit).toBe(true);
    expect(result.arms).toEqual([{ model: "m1" }, { model: "m2" }]);
  });

  it("未配置运行参数 → 拦截", () => {
    const result = guardOf({
      ...BASE,
      settingsConfigured: false,
      arms: arms({ model: "m1", paramsText: "" }, { model: "m2", paramsText: "" }),
    });
    expect(result.canSubmit).toBe(false);
    expect(result.items[0]?.code).toBe("SETTINGS_NOT_CONFIGURED");
    expect(result.items[0]?.scope).toEqual({ kind: "batch" });
  });

  it("单臂 → 拦截（单臂请用 prompt fork）", () => {
    const result = guardOf({ ...BASE, arms: arms({ model: "m1", paramsText: "" }) });
    expect(result.canSubmit).toBe(false);
    expect(result.items[0]?.code).toBe("MIN_ARMS");
  });

  it("model 为空 / params 非法 → 逐臂给原因", () => {
    const result = guardOf({
      ...BASE,
      arms: arms({ model: "", paramsText: "" }, { model: "m2", paramsText: "{bad" }),
    });
    expect(result.canSubmit).toBe(false);
    const armItems = result.items.filter((item) => item.scope.kind === "arm");
    expect(armItems.map((item) => item.code)).toEqual(["ARM_MODEL_EMPTY", "ARM_PARAMS_INVALID"]);
    expect(armItems[0]?.detail).toBe("model 不能为空");
    expect(armItems[1]?.detail).toContain("params 不是合法 JSON");
    expect(armItems[0]?.reason).toContain("臂 1");
    expect(armItems[1]?.reason).toContain("臂 2");
  });

  it("逐臂空 fork：任一臂与父完全相同即拦（粒度与内核一致，不是「全部相同」才拦）", () => {
    // 两臂都与父相同 → 拦，且逐臂点名
    const allSame = guardOf({
      ...BASE,
      arms: arms(
        { model: "deepseek-chat", paramsText: '{"temperature": 0.7}' },
        { model: "deepseek-chat", paramsText: "" },
      ),
    });
    expect(allSame.canSubmit).toBe(false);
    expect(allSame.items.map((item) => item.code)).toEqual([
      "ARM_SAME_AS_PARENT",
      "ARM_SAME_AS_PARENT",
    ]);
    expect(allSame.items.map((item) => item.scope)).toEqual([
      { kind: "arm", index: 0 },
      { kind: "arm", index: 1 },
    ]);

    // 回归点（2026-09-17 K0 验收暴露）：臂 1 改了、臂 2 沿用父 —— 界面曾放行，
    // 提交后内核逐臂 derive 判出空 fork、整批 INVALID_ARM。此处必须拦在第 2 臂。
    const secondUnchanged = guardOf({
      ...BASE,
      arms: arms({ model: "m-1", paramsText: "" }, { model: "deepseek-chat", paramsText: "" }),
    });
    expect(secondUnchanged.canSubmit).toBe(false);
    expect(secondUnchanged.items.map((item) => item.scope)).toEqual([{ kind: "arm", index: 1 }]);
    expect(secondUnchanged.items[0]?.code).toBe("ARM_SAME_AS_PARENT");
    expect(secondUnchanged.arms).toEqual([]);

    // 每臂都与父不同 → 放行（臂与臂之间相同与否不受此判据约束）
    const differs = guardOf({
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
    const sameScalar = guardOf({
      ...BASE,
      parentParams: { reasoning_effort: "none", think: false },
      arms: arms(
        { model: "deepseek-chat", paramsText: '{"reasoning_effort": "none", "think": false}' },
        { model: "deepseek-chat", paramsText: "" },
      ),
    });
    expect(sameScalar.canSubmit).toBe(false);
    expect(sameScalar.items.every((item) => item.code === "ARM_SAME_AS_PARENT")).toBe(true);

    // 两个字符串臂都与父不同 → 放行
    const differsScalar = guardOf({
      ...BASE,
      parentParams: { reasoning_effort: "none" },
      arms: arms(
        { model: "deepseek-chat", paramsText: '{"reasoning_effort": "high"}' },
        { model: "deepseek-chat", paramsText: '{"reasoning_effort": "low"}' },
      ),
    });
    expect(differsScalar.canSubmit).toBe(true);

    // 布尔与字符串不相等（类型不同）⇒ "false" 相对父值 false 算改变
    const boolVsString = guardOf({
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
    const blockedInput = guardOf(input);
    expect(blockedInput.canSubmit).toBe(false);
    expect(blockedInput.items[0]?.code).toBe("SIDE_EFFECTS_UNCONFIRMED");
    // 工具名是原值，不随语言翻译
    expect(blockedInput.items[0]?.reason).toContain("write_file");

    const allowed = guardOf({ ...input, allowSideEffects: true });
    expect(allowed.canSubmit).toBe(true);
    // 批次级确认必须展开到每臂：内核判据是 arms.every(allowSideEffects === true)，
    // 只勾复选框而不下发声明 = 勾了也必被 TOOL_POLICY 整批拒绝。
    expect(allowed.arms).toEqual([
      { model: "m1", allowSideEffects: true },
      { model: "m2", allowSideEffects: true },
    ]);

    // 没有 risky 工具时不下发声明（无可声明之物，避免 fork.edit 留无意义的审计记录）
    const pure = guardOf({
      ...BASE,
      allowSideEffects: true,
      arms: arms({ model: "m1", paramsText: "" }, { model: "m2", paramsText: "" }),
    });
    expect(pure.canSubmit).toBe(true);
    expect(pure.arms).toEqual([{ model: "m1" }, { model: "m2" }]);
  });

  it("params 的空对象等价沿用父值：model 也相同则仍判空 fork", () => {
    const result = guardOf({
      ...BASE,
      arms: arms(
        { model: "deepseek-chat", paramsText: "{}" },
        { model: "deepseek-chat", paramsText: "" },
      ),
    });
    expect(result.canSubmit).toBe(false);
    expect(result.items[0]?.code).toBe("ARM_SAME_AS_PARENT");

    // 换成 model 后放行，且 `{}` 被规整成"沿用父值"（不下发空 params 覆盖父录值）
    const withModel = guardOf({
      ...BASE,
      arms: arms({ model: "m-1", paramsText: "{}" }, { model: "m-2", paramsText: "" }),
    });
    expect(withModel.canSubmit).toBe(true);
    expect(withModel.arms).toEqual([{ model: "m-1" }, { model: "m-2" }]);
  });

  // UI 整理 4.2（design D5）：逐项原因带就近归属——批次级 / 臂级（按臂下标）。
  // reason 拼接串与 items 逐字一致（组件就近呈现只认 items，不拆 reason）。
  it("items：批次级原因 scope.kind=batch，臂级原因 scope={kind:arm,index} 且逐字含于 reason", () => {
    const result = guardOf({
      ...BASE,
      settingsConfigured: false,
      arms: arms({ model: "", paramsText: "" }, { model: "m2", paramsText: "{bad" }),
    });
    expect(result.canSubmit).toBe(false);
    const batch = result.items.filter((item) => item.scope.kind === "batch");
    const byArm = result.items.filter((item) => item.scope.kind === "arm");
    expect(batch).toHaveLength(1);
    expect(batch[0]?.code).toBe("SETTINGS_NOT_CONFIGURED");
    expect(batch[0]?.detail).toBeNull();
    expect(byArm).toHaveLength(2);
    expect(byArm[0]?.scope).toEqual({ kind: "arm", index: 0 });
    expect(byArm[1]?.scope).toEqual({ kind: "arm", index: 1 });
    expect(byArm[0]?.detail).toBe("model 不能为空");
    expect(byArm[1]?.detail).toContain("params 不是合法 JSON");
    // 拼接串 = 全部 items 按顺序 join（展示分隔符随语言，判据仍是顺序与逐项文本）
    expect(result.reason).toBe(result.items.map((item) => item.reason).join("；"));
  });

  it("文案随 locale 派生：同一输入在 zh-CN / en-US 下只换语言，不改判据", () => {
    const input = {
      ...BASE,
      settingsConfigured: false,
      arms: arms({ model: "", paramsText: "" }, { model: "m2", paramsText: "{bad" }),
    };
    const zhResult = modelAbGuard(input, zh);
    const enResult = modelAbGuard(input, en);
    expect(enResult.items.map((item) => item.code)).toEqual(
      zhResult.items.map((item) => item.code),
    );
    const reasonOf = (items: typeof zhResult.items, code: string): string | undefined =>
      items.find((item) => item.code === code)?.reason;
    const detailOf = (items: typeof zhResult.items, code: string): string | null | undefined =>
      items.find((item) => item.code === code)?.detail;
    expect(reasonOf(zhResult.items, "SETTINGS_NOT_CONFIGURED")).toContain("运行配置");
    expect(reasonOf(enResult.items, "SETTINGS_NOT_CONFIGURED")).toContain("Run settings");
    expect(detailOf(zhResult.items, "ARM_MODEL_EMPTY")).toBe("model 不能为空");
    expect(detailOf(enResult.items, "ARM_MODEL_EMPTY")).toBe("model must not be empty");
    expect(detailOf(zhResult.items, "ARM_PARAMS_INVALID")).toContain("params 不是合法 JSON");
    expect(detailOf(enResult.items, "ARM_PARAMS_INVALID")).toContain("not valid JSON");
  });

  it("items：判据通过时为空数组（对照，不是 undefined）", () => {
    const result = guardOf({
      ...BASE,
      arms: arms({ model: "m1", paramsText: "" }, { model: "m2", paramsText: "" }),
    });
    expect(result.canSubmit).toBe(true);
    expect(result.items).toEqual([]);
  });
});
