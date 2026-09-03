import { describe, expect, it } from "vitest";
import { parseRunConfig } from "../src/index";
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
