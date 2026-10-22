import { describe, expect, it } from "vitest";
import {
  BODY_CHARS_MAX,
  CURSOR_MAX,
  LOGICAL_PATH_MAX,
  PAGE_LIMIT_MAX,
  RUN_ID_MAX,
  SPAN_ID_MAX,
} from "../src/limits.js";
import { READ_ONLY_ANNOTATIONS, TOOL_CONTRACTS, TOOL_NAMES } from "../src/tool-contracts.js";

/**
 * MCP0 4.2（S03/S04）：七工具入参契约。
 *
 * 判据（design D5/D7）：
 * - 恰七个、顺序固定，参数**只有读取所需**——没有数据根、宿主路径、URL、handler、
 *   命令、模型或配置覆盖，因此"换个地方读/顺手做点写"在形状层面就不成立；
 * - 每个对象节点 `additionalProperties:false`：多一个键是拒绝，不是忽略（S04）；
 * - 发布给客户端的 JSON Schema 由 zod **派生**，不存在第二份声明可漂；
 * - 标识与容量上限逐项钉住（200/128/4096/20–100/8192）。
 */

const EXPECTED_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  list_runs: ["status", "query", "cursor", "limit"],
  get_run: ["runId", "cursor", "limit"],
  get_step: ["runId", "spanId", "ownerRunId", "section", "cursor", "maxChars"],
  compare_runs: ["left", "right"],
  inspect_checkpoint: ["runId", "stepSpanId", "cursor", "limit"],
  read_checkpoint_file: ["runId", "stepSpanId", "path", "cursor", "maxChars"],
  compare_checkpoint_files: ["left", "right", "path", "cursor", "limit", "maxChars"],
};

const EXPECTED_REQUIRED: Readonly<Record<string, readonly string[]>> = {
  list_runs: [],
  get_run: ["runId"],
  get_step: ["runId", "spanId"],
  compare_runs: ["left", "right"],
  inspect_checkpoint: ["runId"],
  read_checkpoint_file: ["runId", "path"],
  compare_checkpoint_files: ["left", "right"],
};

/** 任何工具都不得接受的字段（数据根只在启动期确定；执行类输入永不在形状里） */
const FORBIDDEN_KEYS = [
  "dataDir",
  "data_dir",
  "tracesDir",
  "root",
  "rootDir",
  "baseDir",
  "cwd",
  "dir",
  "path_prefix",
  "url",
  "endpoint",
  "baseURL",
  "handler",
  "command",
  "shell",
  "script",
  "apiKey",
  "api_key",
  "token",
  "headers",
  "model",
  "params",
  "config",
  "dryRun",
  "force",
];

interface SchemaNode {
  readonly type?: string;
  readonly properties?: Record<string, SchemaNode>;
  readonly required?: string[];
  readonly additionalProperties?: unknown;
  readonly enum?: unknown[];
  readonly maxLength?: number;
  readonly maximum?: number;
  readonly minimum?: number;
}

function nodeOf(declaration: Readonly<Record<string, unknown>>): SchemaNode {
  return declaration as SchemaNode;
}

/** 递归收集所有属性名（含嵌套的 left/right 对象） */
function collectKeys(node: SchemaNode): string[] {
  const out: string[] = [];
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    out.push(key);
    out.push(...collectKeys(child));
  }
  return out;
}

describe("TOOL_CONTRACTS：发布形状", () => {
  it("恰七个工具且顺序与 D5 表一致", () => {
    expect(TOOL_NAMES).toEqual([
      "list_runs",
      "get_run",
      "get_step",
      "compare_runs",
      "inspect_checkpoint",
      "read_checkpoint_file",
      "compare_checkpoint_files",
    ]);
  });

  it("每个工具的参数集与必填项逐个钉住（多一个少一个都算契约变动）", () => {
    for (const item of TOOL_CONTRACTS) {
      const root = nodeOf(item.inputSchema);
      // 逐个工具比对时把名字一起放进比较值：vitest 的 expect 不接受第二个「消息」参数
      expect({ tool: item.name, keys: Object.keys(root.properties ?? {}).sort() }).toEqual({
        tool: item.name,
        keys: [...(EXPECTED_PROPERTIES[item.name] ?? [])].sort(),
      });
      expect({ tool: item.name, required: [...(root.required ?? [])].sort() }).toEqual({
        tool: item.name,
        required: [...(EXPECTED_REQUIRED[item.name] ?? [])].sort(),
      });
    }
  });

  it("所有对象节点 additionalProperties 恒为 false（未知字段是拒绝不是忽略）", () => {
    const visit = (node: SchemaNode, where: string): void => {
      expect(node.additionalProperties, where).toBe(false);
      for (const [key, child] of Object.entries(node.properties ?? {})) {
        if (child.type === "object") {
          visit(child, `${where}.${key}`);
        }
      }
    };
    for (const item of TOOL_CONTRACTS) {
      expect(nodeOf(item.inputSchema).type).toBe("object");
      visit(nodeOf(item.inputSchema), item.name);
    }
  });

  it("不出现数据根/宿主路径/URL/handler/命令/配置覆盖一类字段（S04 的形状半边）", () => {
    for (const item of TOOL_CONTRACTS) {
      const keys = collectKeys(nodeOf(item.inputSchema));
      for (const forbidden of FORBIDDEN_KEYS) {
        expect(keys, `${item.name} 不得含 ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("标识与容量上限逐项钉住", () => {
    const bounds: Readonly<Record<string, number>> = {
      runId: RUN_ID_MAX,
      ownerRunId: RUN_ID_MAX,
      spanId: SPAN_ID_MAX,
      stepSpanId: SPAN_ID_MAX,
      cursor: CURSOR_MAX,
      path: LOGICAL_PATH_MAX,
    };
    for (const item of TOOL_CONTRACTS) {
      for (const [key, child] of Object.entries(nodeOf(item.inputSchema).properties ?? {})) {
        if (key in bounds) {
          expect(child.maxLength, `${item.name}.${key}`).toBe(bounds[key]);
        }
        if (key === "limit") {
          expect(child.type).toBe("integer");
          expect(child.minimum).toBe(1);
          expect(child.maximum).toBe(PAGE_LIMIT_MAX);
        }
        if (key === "maxChars") {
          expect(child.type).toBe("integer");
          expect(child.maximum).toBe(BODY_CHARS_MAX);
        }
      }
    }
  });

  it("发布的声明自包含：不含内部 $ref，客户端不必再解引用", () => {
    const serialized = JSON.stringify(TOOL_CONTRACTS.map((item) => item.inputSchema));
    expect(serialized).not.toContain("$ref");
    expect(serialized).not.toContain("definitions");
  });

  it("筛选枚举与 section 枚举封闭（不给自由文本当筛选器的机会）", () => {
    const list = nodeOf(TOOL_CONTRACTS[0]?.inputSchema ?? {});
    expect(list.properties?.status?.enum).toEqual([
      "all",
      "errored",
      "ended_without_error",
      "limited",
      "aborted",
      "termination_not_recorded",
    ]);
    const step = nodeOf(TOOL_CONTRACTS[2]?.inputSchema ?? {});
    expect(step.properties?.section?.enum).toEqual(["input", "output", "error"]);
  });

  it("每个工具的 annotations 都是只读四元组（D7）", () => {
    for (const item of TOOL_CONTRACTS) {
      expect(item.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(item.annotations).toEqual(READ_ONLY_ANNOTATIONS);
    }
  });
});

describe("TOOL_CONTRACTS：strict 校验实际生效", () => {
  const minimal: Readonly<Record<string, Record<string, unknown>>> = {
    list_runs: {},
    get_run: { runId: "run-1" },
    get_step: { runId: "run-1", spanId: "s_01" },
    compare_runs: { left: { runId: "run-1" }, right: { runId: "run-2" } },
    inspect_checkpoint: { runId: "run-1" },
    read_checkpoint_file: { runId: "run-1", path: "config.json" },
    compare_checkpoint_files: { left: { runId: "run-1" }, right: { runId: "run-2" } },
  };

  it("最小合法参数通过", () => {
    for (const item of TOOL_CONTRACTS) {
      const parsed = item.schema.safeParse(minimal[item.name]);
      expect(parsed.success, `${item.name}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it("任何未知键都拒绝，嵌套对象也一样", () => {
    for (const item of TOOL_CONTRACTS) {
      const base = minimal[item.name] ?? {};
      expect(item.schema.safeParse({ ...base, unexpected: 1 }).success, item.name).toBe(false);
    }
    const compare = TOOL_CONTRACTS.find((item) => item.name === "compare_runs");
    expect(
      compare?.schema.safeParse({
        left: { runId: "run-1", dataDir: "D:/elsewhere" },
        right: { runId: "run-2" },
      }).success,
    ).toBe(false);
  });

  it("越界与错型一律拒绝：超长 runId/spanId/path、超上限 limit/maxChars、非整数、未知筛选值", () => {
    const getRun = TOOL_CONTRACTS.find((item) => item.name === "get_run");
    expect(getRun?.schema.safeParse({ runId: "r".repeat(RUN_ID_MAX) }).success).toBe(true);
    expect(getRun?.schema.safeParse({ runId: "r".repeat(RUN_ID_MAX + 1) }).success).toBe(false);
    expect(getRun?.schema.safeParse({ runId: "" }).success).toBe(false);
    expect(getRun?.schema.safeParse({ runId: "run-1", limit: 101 }).success).toBe(false);
    expect(getRun?.schema.safeParse({ runId: "run-1", limit: 1.5 }).success).toBe(false);
    expect(getRun?.schema.safeParse({ runId: 1 }).success).toBe(false);

    const read = TOOL_CONTRACTS.find((item) => item.name === "read_checkpoint_file");
    expect(
      read?.schema.safeParse({ runId: "run-1", path: "p".repeat(LOGICAL_PATH_MAX) }).success,
    ).toBe(true);
    expect(
      read?.schema.safeParse({ runId: "run-1", path: "p".repeat(LOGICAL_PATH_MAX + 1) }).success,
    ).toBe(false);
    expect(read?.schema.safeParse({ runId: "run-1", path: "x", maxChars: 8193 }).success).toBe(
      false,
    );

    const list = TOOL_CONTRACTS.find((item) => item.name === "list_runs");
    expect(list?.schema.safeParse({ status: "success" }).success).toBe(false);
    expect(list?.schema.safeParse({ status: "termination_not_recorded" }).success).toBe(true);

    const step = TOOL_CONTRACTS.find((item) => item.name === "get_step");
    expect(step?.schema.safeParse({ runId: "run-1", spanId: "s".repeat(129) }).success).toBe(false);
    expect(
      step?.schema.safeParse({ runId: "run-1", spanId: "s_01", section: "body" }).success,
    ).toBe(false);
  });

  it("缺必填拒绝（runId/spanId/path/两侧对象），比较工具不给数组入口", () => {
    expect(TOOL_CONTRACTS.find((i) => i.name === "get_run")?.schema.safeParse({}).success).toBe(
      false,
    );
    expect(
      TOOL_CONTRACTS.find((i) => i.name === "get_step")?.schema.safeParse({ runId: "run-1" })
        .success,
    ).toBe(false);
    expect(
      TOOL_CONTRACTS.find((i) => i.name === "read_checkpoint_file")?.schema.safeParse({
        runId: "run-1",
      }).success,
    ).toBe(false);
    const compare = TOOL_CONTRACTS.find((i) => i.name === "compare_runs");
    expect(compare?.schema.safeParse([{ runId: "a" }, { runId: "b" }]).success).toBe(false);
    expect(
      compare?.schema.safeParse({
        left: { runId: "a" },
        right: { runId: "b" },
        third: { runId: "c" },
      }).success,
    ).toBe(false);
  });
});
