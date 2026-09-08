import { describe, expect, it } from "vitest";
import { TraceTestConfigError } from "../src/errors.js";
import { rerunWithCassette } from "../src/rerun.js";
import { cannedResponse, fakeConfig, fakeTools, recordRun, toolCall } from "./helpers.js";

/** 基线剧本：读 a.json → 汇报完成（两轮） */
const normalScript = [
  cannedResponse({ toolCalls: [toolCall("c1", "read_file", { path: "a.json" })] }),
  cannedResponse({ content: "a.json 内容是：内容(a.json)" }),
];

/** 基线剧本：读 missing.json（工具报错）→ 带着错误继续并收尾 */
const toolErrorScript = [
  cannedResponse({ toolCalls: [toolCall("c1", "read_file", { path: "missing.json" })] }),
  cannedResponse({ content: "读取失败了，原因：ENOENT" }),
];

describe("rerunWithCassette（headless 卡带重跑端到端）", () => {
  it("当前代码未变 → 新轨迹结构对齐，零漂移，零网络", async () => {
    const record = await recordRun(normalScript);
    const result = await rerunWithCassette({ record, config: fakeConfig(), tools: fakeTools() });

    expect(result.alignment.aligned).toBe(true);
    expect(result.configDrift).toBeNull();
    expect(result.requestDrift).toHaveLength(0);
    expect(result.argsDrift).toHaveLength(0);
    expect(result.run.event).toEqual({ event: "stopped", reason: "completed", at: 2 });
    // 新 run 是独立的轨迹（不是旧 trace 本身）
    expect(result.record.meta.id).not.toBe(record.meta.id);
    expect(result.record.spans).toHaveLength(record.spans.length);
  });

  it("录制中的工具错误 → 桩复现 error tool_result，轨迹仍对齐", async () => {
    const record = await recordRun(toolErrorScript);
    const result = await rerunWithCassette({ record, config: fakeConfig(), tools: fakeTools() });
    expect(result.alignment.aligned).toBe(true);
    // 新轨迹里的 tool.invoke 同样带 error（错误即数据）
    const toolSpan = result.record.spans.find((s) => s.kind === "tool.invoke");
    expect(toolSpan && "error" in toolSpan && toolSpan.error).toContain("ENOENT");
  });

  it("改了 system prompt → config drift 标记但不阻断，测试照常执行", async () => {
    const record = await recordRun(normalScript);
    const result = await rerunWithCassette({
      record,
      config: fakeConfig({ systemPrompt: "你是改过的文件助手。" }),
      tools: fakeTools(),
    });
    expect(result.configDrift).not.toBeNull();
    expect(result.configDrift?.recorded).toBe(record.meta.config_hash);
    // drift 不改变通过判定：VCR 语义（旧输入 + 新 harness）下轨迹依旧对齐
    expect(result.alignment.aligned).toBe(true);
    expect(result.run.event.reason).toBe("completed");
  });

  it("改了工具描述（协议变化）→ 经由工具声明暴露为 config drift", async () => {
    const record = await recordRun(normalScript);
    const tools = fakeTools();
    tools[0] = { ...tools[0], description: "改动过的描述" };
    const result = await rerunWithCassette({
      record,
      config: fakeConfig({ tools: tools.map(({ handler: _h, ...def }) => def) }),
      tools,
    });
    expect(result.configDrift).not.toBeNull();
    expect(result.alignment.aligned).toBe(true);
  });

  it("当前工具表缺少录制中使用的工具 → 配置错误（提示重录基线）", async () => {
    const record = await recordRun(normalScript);
    await expect(
      rerunWithCassette({
        record,
        config: fakeConfig({ tools: [] }),
        tools: [],
      }),
    ).rejects.toThrow(/与录制不兼容/);
  });

  it("当前 maxIterations 收紧 → 重跑提前终止，卡带有剩余 → 配置错误", async () => {
    const record = await recordRun(normalScript);
    await expect(
      rerunWithCassette({
        record,
        config: fakeConfig({ maxIterations: 1 }),
        tools: fakeTools(),
      }),
    ).rejects.toThrow(/卡带有剩余/);
  });

  it("代理录制的 run → 拒绝卡带重跑（不把单次响应伪装成回归测试）", async () => {
    const record = await recordRun(normalScript);
    record.meta.source = { kind: "proxy", base_url: "http://127.0.0.1:18787" };
    await expect(
      rerunWithCassette({ record, config: fakeConfig(), tools: fakeTools() }),
    ).rejects.toThrow(/proxy|代理/);
  });

  it("未封存（crashed）的 trace → 配置错误", async () => {
    const record = await recordRun(normalScript);
    record.events = [];
    record.status = "crashed";
    await expect(
      rerunWithCassette({ record, config: fakeConfig(), tools: fakeTools() }),
    ).rejects.toThrow(/未封存/);
  });

  it("缺 config_hash 的 trace → 配置错误", async () => {
    const record = await recordRun(normalScript);
    record.meta.config_hash = undefined;
    await expect(
      rerunWithCassette({ record, config: fakeConfig(), tools: fakeTools() }),
    ).rejects.toThrow(/config_hash/);
  });

  it("没有任何 llm.call 的 trace → 配置错误", async () => {
    const record = await recordRun(normalScript);
    record.spans = record.spans.filter((s) => s.kind !== "llm.call");
    await expect(
      rerunWithCassette({ record, config: fakeConfig(), tools: fakeTools() }),
    ).rejects.toThrow(/llm\.call/);
  });
});
