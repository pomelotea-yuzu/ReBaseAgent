import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/index";
import { sampleTools } from "./helpers";

describe("ToolRegistry", () => {
  it("定义表保留注册顺序（进入请求体与 config_hash）", () => {
    const registry = new ToolRegistry(sampleTools());
    expect(registry.definitions().map((t) => t.name)).toEqual(["read_file", "write_file"]);
    expect(registry.definitions()[0]?.sideEffect).toBe(false);
  });

  it("重名注册抛错（配置错误属于 loop 自身 bug）", () => {
    const tools = sampleTools();
    expect(() => new ToolRegistry([...tools, tools[0]])).toThrow(/重名注册/);
  });

  it("成功执行：handler 接收 { cwd, signal }", async () => {
    const registry = new ToolRegistry(sampleTools());
    const ctx = { cwd: "D:/tmp", signal: null };
    const result = await registry.execute("read_file", '{"path":"README.md"}', ctx);
    expect(result.result).toBe("内容(README.md)");
    expect(result.error).toBeNull();
    expect(result.durMs).toBeGreaterThanOrEqual(0);
  });

  it("handler 抛异常 → 捕获为 error 文本（错误是数据不是异常）", async () => {
    const registry = new ToolRegistry(sampleTools());
    const result = await registry.execute("read_file", '{"path":"missing.json"}', {
      cwd: "D:/tmp",
      signal: null,
    });
    expect(result.error).toContain("ENOENT");
    expect(result.result).toBe("");
  });

  it("args JSON 解析失败 → error tool_result", async () => {
    const registry = new ToolRegistry(sampleTools());
    const result = await registry.execute("read_file", "{broken", { cwd: "D:/tmp", signal: null });
    expect(result.error).toContain("JSON 解析失败");
  });

  it("未知工具 → error", async () => {
    const registry = new ToolRegistry(sampleTools());
    const result = await registry.execute("no_such_tool", "{}", { cwd: "D:/tmp", signal: null });
    expect(result.error).toContain("未知工具");
  });

  it("空 arguments 字符串视为 {}", async () => {
    const registry = new ToolRegistry(sampleTools());
    const result = await registry.execute("write_file", "", { cwd: "D:/tmp", signal: null });
    // write_file 的 handler 读取 args.path（undefined）→ "已写入 undefined"，不报错
    expect(result.error).toBeNull();
  });
});
