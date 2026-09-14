import { configHash } from "@rebaseagent/agent-loop";
import type { ToolDef } from "@rebaseagent/agent-loop";
import { describe, expect, it } from "vitest";
import { ToolUnwrapError, deriveProxyConfigHash, toToolDefs, unwrapToolDef } from "../src/index";

/**
 * deriveProxyConfigHash 单测：代理请求快照 → 配置指纹。
 * 断言与 agent-loop configHash 逐字节相等（四种 fixture）+ 两条缺因分支的 reason 取值。
 * 全程纯函数、零 IO。
 */

const SYSTEM = "你是文件助手。";
const MESSAGES = [
  { role: "system", content: SYSTEM },
  { role: "user", content: "你好" },
];

/** OpenAI function 包装形状 */
function wrap(def: Omit<ToolDef, "sideEffect"> & { sideEffect?: boolean }) {
  return {
    type: "function",
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      ...(def.sideEffect === undefined ? {} : { sideEffect: def.sideEffect }),
    },
  };
}

const READ_TOOL: Omit<ToolDef, "sideEffect"> = {
  name: "read_file",
  description: "读取文件",
  parameters: { type: "object", properties: { path: { type: "string" } } },
};
const WRITE_TOOL: Omit<ToolDef, "sideEffect"> = {
  name: "write_file",
  description: "写入文件",
  parameters: { type: "object", properties: { path: { type: "string" } } },
};

describe("deriveProxyConfigHash：与 configHash 逐字节相等", () => {
  it("无 tools → 与 configHash(system, []) 相等", () => {
    const out = deriveProxyConfigHash({ messages: MESSAGES });
    expect(out.reason).toBeNull();
    expect(out.hash).toBe(configHash(SYSTEM, []));
  });

  it("tools 显式空数组 → 与 configHash(system, []) 相等", () => {
    const out = deriveProxyConfigHash({ messages: MESSAGES, tools: [] });
    expect(out.hash).toBe(configHash(SYSTEM, []));
  });

  it("单工具（OpenAI 包装）→ 与扁平 ToolDef 算出的 hash 相等", () => {
    const out = deriveProxyConfigHash({ messages: MESSAGES, tools: [wrap(READ_TOOL)] });
    const expected = configHash(SYSTEM, [{ ...READ_TOOL } as ToolDef]);
    expect(out.hash).toBe(expected);
  });

  it("name 乱序多工具 → 与 configHash 的 name 排序一致", () => {
    const out = deriveProxyConfigHash({
      messages: MESSAGES,
      tools: [wrap(WRITE_TOOL), wrap(READ_TOOL)], // 乱序
    });
    // configHash 内部按 name 排序，故乱序输入与正序输出相同
    const expected = configHash(SYSTEM, [
      { ...READ_TOOL } as ToolDef,
      { ...WRITE_TOOL } as ToolDef,
    ]);
    expect(out.hash).toBe(expected);
  });

  it("sideEffect 缺省 → 指纹按「字段缺失」语义（与显式 false 不同）", () => {
    const absent = deriveProxyConfigHash({ messages: MESSAGES, tools: [wrap(READ_TOOL)] });
    const explicitFalse = deriveProxyConfigHash({
      messages: MESSAGES,
      tools: [wrap({ ...READ_TOOL, sideEffect: false })],
    });
    expect(absent.hash).not.toBeNull();
    expect(explicitFalse.hash).not.toBeNull();
    expect(absent.hash).not.toBe(explicitFalse.hash);
    // 缺省即与不含 sideEffect 键的 ToolDef 一致
    expect(absent.hash).toBe(configHash(SYSTEM, [{ ...READ_TOOL } as ToolDef]));
  });
});

describe("deriveProxyConfigHash：缺因（结构化，不做部分哈希）", () => {
  it("无字符串 system 消息 → reason=no_system、hash=null", () => {
    const out = deriveProxyConfigHash({
      messages: [{ role: "user", content: "你好" }],
    });
    expect(out).toEqual({ hash: null, reason: "no_system" });
  });

  it("system content 非字符串（多模态）→ reason=no_system", () => {
    const out = deriveProxyConfigHash({
      messages: [{ role: "system", content: [{ type: "text", text: "x" }] }],
    });
    expect(out).toEqual({ hash: null, reason: "no_system" });
  });

  it("工具表含无法解包的项 → reason=invalid_tool、不产生部分哈希", () => {
    const out = deriveProxyConfigHash({
      messages: MESSAGES,
      tools: [wrap(READ_TOOL), { name: "broken" }], // 缺 description/parameters
    });
    expect(out).toEqual({ hash: null, reason: "invalid_tool" });
  });

  it("工具表全部非法（非对象项）→ reason=invalid_tool", () => {
    const out = deriveProxyConfigHash({ messages: MESSAGES, tools: [{}] });
    expect(out).toEqual({ hash: null, reason: "invalid_tool" });
  });

  it("无 system 优先于非法工具（顺序确定）", () => {
    const out = deriveProxyConfigHash({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "broken" }],
    });
    expect(out.reason).toBe("no_system");
  });
});

describe("toToolDefs / unwrapToolDef：共享解包", () => {
  it("扁平与 function 包装解出同一 ToolDef", () => {
    const flat = unwrapToolDef({ ...READ_TOOL });
    const wrapped = unwrapToolDef(wrap(READ_TOOL));
    expect(flat).toEqual(wrapped);
    expect(flat).toEqual({ ...READ_TOOL });
  });

  it("sideEffect 仅在有布尔值时带出", () => {
    expect(unwrapToolDef({ ...READ_TOOL })).not.toHaveProperty("sideEffect");
    expect(unwrapToolDef({ ...READ_TOOL, sideEffect: false })).toHaveProperty("sideEffect", false);
  });

  it("无法解包 → 抛 ToolUnwrapError（携带 index）", () => {
    let caught: unknown;
    try {
      toToolDefs([{ ...READ_TOOL }, { name: "bad" }]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ToolUnwrapError);
    expect((caught as ToolUnwrapError).kind).toBe("invalid_shape");
    expect((caught as ToolUnwrapError).index).toBe(1);
  });

  it("name 为空串 → ToolDefSchema 校验失败 → ToolUnwrapError", () => {
    let caught: unknown;
    try {
      toToolDefs([{ name: "", description: "x", parameters: {} }]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ToolUnwrapError);
    expect((caught as ToolUnwrapError).toolName).toBe("");
  });
});
