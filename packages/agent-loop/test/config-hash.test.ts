import { describe, expect, it } from "vitest";
import { configHash } from "../src/index";
import { sampleTools } from "./helpers";

const prompt = "你是文件助手。";

describe("configHash", () => {
  it("同源同指纹（工具表顺序无关，按 name 排序）", () => {
    const a = sampleTools().map(({ handler: _h, ...def }) => def);
    const b = [...a].reverse();
    expect(configHash(prompt, a)).toBe(configHash(prompt, b));
  });

  it("仅 model / params 变化不影响指纹（不参与计算）", () => {
    const tools = sampleTools().map(({ handler: _h, ...def }) => def);
    // configHash 只接受 systemPrompt + tools，model/params 根本不在入参里——
    // 这里验证同 prompt 同 tools 两次计算稳定
    expect(configHash(prompt, tools)).toBe(configHash(prompt, tools));
  });

  it("增删工具变指纹", () => {
    const tools = sampleTools().map(({ handler: _h, ...def }) => def);
    const withOneRemoved = tools.slice(0, 1);
    expect(configHash(prompt, tools)).not.toBe(configHash(prompt, withOneRemoved));
  });

  it("system prompt 变化变指纹", () => {
    const tools = sampleTools().map(({ handler: _h, ...def }) => def);
    expect(configHash(prompt, tools)).not.toBe(configHash("你是另一个助手。", tools));
  });

  it("sideEffect 标注参与指纹（保真度分级是源代码的一部分）", () => {
    const tools = sampleTools().map(({ handler: _h, ...def }) => def);
    const flipped = tools.map((t) => ({ ...t, sideEffect: !(t.sideEffect ?? true) }));
    expect(configHash(prompt, tools)).not.toBe(configHash(prompt, flipped));
  });

  it("参数描述变化变指纹", () => {
    const tools = sampleTools().map(({ handler: _h, ...def }) => def);
    const edited = tools.map((t) =>
      t.name === "read_file" ? { ...t, description: "读取文件（改）" } : t,
    );
    expect(configHash(prompt, tools)).not.toBe(configHash(prompt, edited));
  });
});
