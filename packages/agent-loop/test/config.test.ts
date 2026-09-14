import { describe, expect, it } from "vitest";
import { RESERVED_BODY_KEYS, parseRunConfig } from "../src/index";
import { sampleConfig, sampleTools } from "./helpers";

describe("RunConfig 校验", () => {
  it("合法配置通过（signal 为 null 表示不支持中止）", () => {
    const config = parseRunConfig(sampleConfig());
    expect(config.model).toBe("deepseek-chat");
    expect(config.exec.cwd).toBe("D:/tmp/sandbox");
    expect(config.exec.signal).toBeNull();
  });

  it("合法配置（带 signal 与工具表）", () => {
    const controller = new AbortController();
    const config = parseRunConfig(
      sampleConfig({
        exec: { cwd: "D:/tmp", signal: controller.signal },
        tools: sampleTools().map(({ handler: _h, ...def }) => def),
      }),
    );
    expect(config.exec.signal).toBe(controller.signal);
    expect(config.tools).toHaveLength(2);
  });

  it("缺失 model → 拒绝", () => {
    const { model: _m, ...rest } = sampleConfig();
    expect(() => parseRunConfig(rest)).toThrow();
  });

  it("缺失 exec.cwd → 拒绝并指明字段", () => {
    const config = sampleConfig();
    const bad = { ...config, exec: { signal: null } };
    expect(() => parseRunConfig(bad)).toThrow(/cwd/);
  });

  it("预算上限缺两者 → 拒绝", () => {
    expect(() => parseRunConfig(sampleConfig({ budget: {} }))).toThrow(/maxTotalTokens 或 maxCost/);
  });

  it("maxIterations 非正整数 → 拒绝", () => {
    expect(() => parseRunConfig(sampleConfig({ maxIterations: 0 }))).toThrow();
  });
});

describe("采样参数标量化（params 值类型）", () => {
  it("字符串 / 布尔 / 数值标量均合法", () => {
    const config = parseRunConfig(
      sampleConfig({
        params: { reasoning_effort: "none", think: false, temperature: 0.2, top_p: 0.9 },
      }),
    );
    expect(config.params).toEqual({
      reasoning_effort: "none",
      think: false,
      temperature: 0.2,
      top_p: 0.9,
    });
  });

  it("既有纯数值配置原样合法（纯类型放宽，无迁移）", () => {
    const config = parseRunConfig(sampleConfig({ params: { temperature: 0.2 } }));
    expect(config.params).toEqual({ temperature: 0.2 });
  });

  it("params 缺省仍合法", () => {
    expect(parseRunConfig(sampleConfig({ params: undefined })).params).toBeUndefined();
  });

  it.each([
    ["对象", { nested: { a: 1 } }],
    ["数组", { stops: ["a", "b"] }],
    ["null", { value: null }],
  ])("非标量值（%s）→ 拒绝", (_label, params) => {
    expect(() => parseRunConfig(sampleConfig({ params: params as never }))).toThrow();
  });
});

describe("请求体保留键守卫", () => {
  it("保留键常量与 buildRequestBody 的固定键一致", () => {
    expect([...RESERVED_BODY_KEYS]).toEqual([
      "model",
      "messages",
      "tools",
      "stream",
      "stream_options",
    ]);
  });

  it.each([...RESERVED_BODY_KEYS])("params 含保留键 %s → 拒绝并指明键名", (key) => {
    expect(() => parseRunConfig(sampleConfig({ params: { [key]: "x" } }))).toThrow(new RegExp(key));
  });

  it("保留键拒绝发生在运行开始前（校验期，非运行时）", () => {
    // parseRunConfig 是唯一入口——抛错即零文件零调用
    expect(() => parseRunConfig(sampleConfig({ params: { messages: "注入" } }))).toThrow(/保留键/);
  });

  it("非保留键的普通参数不受影响", () => {
    const config = parseRunConfig(sampleConfig({ params: { num_ctx: 8192, think: false } }));
    expect(config.params).toEqual({ num_ctx: 8192, think: false });
  });
});
