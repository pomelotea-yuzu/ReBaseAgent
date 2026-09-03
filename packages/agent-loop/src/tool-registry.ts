import type { Tool, ToolContext, ToolDef } from "./config.js";

/** 工具注册表：name → Tool；重名注册抛错（配置错误属于 loop 自身 bug） */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: Tool[]) {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) {
        throw new Error(`工具重名注册：${tool.name}`);
      }
      this.tools.set(tool.name, tool);
    }
  }

  /** 工具表定义（进入请求体与 config_hash；顺序与注册顺序一致） */
  definitions(): ToolDef[] {
    return [...this.tools.values()].map(({ handler: _handler, ...def }) => def);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 执行工具：任何异常都捕获为 error 文本（错误是数据不是异常） */
  async execute(
    name: string,
    argsJson: string,
    ctx: ToolContext,
  ): Promise<{ result: string; error: string | null; durMs: number }> {
    const startedAt = Date.now();
    const tool = this.tools.get(name);
    if (tool === undefined) {
      return {
        result: "",
        error: `未知工具：${name}`,
        durMs: elapsedMs(startedAt),
      };
    }
    let args: unknown;
    try {
      args = argsJson.trim().length === 0 ? {} : JSON.parse(argsJson);
    } catch (e) {
      return {
        result: "",
        error: `工具参数 JSON 解析失败：${(e as Error).message}（原始输入：${argsJson.slice(0, 100)}）`,
        durMs: elapsedMs(startedAt),
      };
    }
    try {
      const result = await tool.handler(args, ctx);
      return { result, error: null, durMs: elapsedMs(startedAt) };
    } catch (e) {
      return {
        result: "",
        error: e instanceof Error ? e.message : String(e),
        durMs: elapsedMs(startedAt),
      };
    }
  }
}

function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}
