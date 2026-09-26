import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { OperationRegistry } from "../src/main/operation-registry";
import {
  RequestCanonicalError,
  RequestFingerprinter,
  canonicalizeRequest,
  parseBusinessRequest,
} from "../src/main/operation-request";
import type { ChannelName } from "../src/shared/channels";
import {
  CHANNELS,
  CreateRunRequestSchema,
  ForkRunRequestSchema,
  ModelAbRequestSchema,
  ProxyForkRequestSchema,
} from "../src/shared/ipc";

/**
 * U4 任务 1.3：规范化业务请求 + 会话 HMAC 指纹 + 同一次解析的不可变快照。
 *
 * 判据来源：tasks.md 1.3 + design D2。
 * 验收场景（delta 逐字标题）：
 * - 「同 ID 重复请求只执行一次」的判定面：同指纹 ⇒ `duplicate` 关联原操作/原终态；
 * - 「同 ID 异参和跨通道复用被拒绝」：通道、模式、目标、编辑内容、臂顺序、sourceToken、
 *   授权声明任一变化 ⇒ `conflict`，且原登记一字不改；属性顺序变化 ⇒ 同一请求；
 * - 「指纹与执行使用同一解析快照」：指纹与实际编排入参都取自**同一份深拷贝 + 深冻结**的
 *   解析产物；生成指纹后改写嵌套字段必须抛错，且原始 payload 的后续改动进不了快照。
 *
 * 断言方式刻意是「看实际收到的值 + 数调用次数」，不是比较对象引用（design D2/B2）。
 */

const SECRET = Buffer.alloc(32, 7);

function fingerprinter(): RequestFingerprinter {
  return new RequestFingerprinter(SECRET);
}

function fingerprintOf(channel: ChannelName, value: unknown): string {
  return fingerprinter().fingerprint(channel, value);
}

/** 走一遍入口解析，返回「编排视角看到的值 + 登记时算出的指纹」 */
function okRequest<T>(
  channel: ChannelName,
  schema: z.ZodType<T>,
  payload: unknown,
): { value: T; fingerprint: string } {
  const parsed = parseBusinessRequest(fingerprinter(), channel, schema, payload);
  if (!parsed.ok) throw new Error(`期望解析成功，实际被拒：${parsed.message}`);
  return { value: parsed.request.value, fingerprint: parsed.request.fingerprint };
}

describe("U4 1.3 规范化：什么算同一个业务请求", () => {
  it("对象键递归排序 ⇒ 属性顺序变化是同一请求", () => {
    const left = { parentRunId: "run_p", edit: { field: "result", value: "v" }, atSpanId: "s1" };
    const right = { edit: { value: "v", field: "result" }, atSpanId: "s1", parentRunId: "run_p" };
    expect(canonicalizeRequest(left)).toBe(canonicalizeRequest(right));
    expect(fingerprintOf(CHANNELS.forkRun, left)).toBe(fingerprintOf(CHANNELS.forkRun, right));
  });

  it("数组顺序与字符串字节原样保留 ⇒ 消息顺序、正文空白、臂顺序都是业务差异", () => {
    const fp = fingerprinter();
    expect(fp.fingerprint(CHANNELS.proxyFork, { messages: ["a", "b"] })).not.toBe(
      fp.fingerprint(CHANNELS.proxyFork, { messages: ["b", "a"] }),
    );
    expect(fp.fingerprint(CHANNELS.proxyFork, { messages: ["  "] })).not.toBe(
      fp.fingerprint(CHANNELS.proxyFork, { messages: [""] }),
    );
    // 不 trim：首尾空格进入规范化字节
    expect(canonicalizeRequest("  x ")).toContain("  x ");
    expect(fp.fingerprint(CHANNELS.proxyFork, { messages: ["x"] })).toBe(
      fp.fingerprint(CHANNELS.proxyFork, { messages: ["x"] }),
    );
  });

  it('标量带类型标记 ⇒ 1/"1"、true/"true"、0/""、null/缺键 都不同', () => {
    const fp = fingerprinter();
    const one = fp.fingerprint(CHANNELS.modelAb, { v: 1 });
    expect(one).not.toBe(fp.fingerprint(CHANNELS.modelAb, { v: "1" }));
    expect(fp.fingerprint(CHANNELS.modelAb, { v: true })).not.toBe(
      fp.fingerprint(CHANNELS.modelAb, { v: "true" }),
    );
    expect(fp.fingerprint(CHANNELS.modelAb, { v: 0 })).not.toBe(
      fp.fingerprint(CHANNELS.modelAb, { v: "" }),
    );
    expect(fp.fingerprint(CHANNELS.modelAb, { v: null })).not.toBe(
      fp.fingerprint(CHANNELS.modelAb, {}),
    );
    expect(fp.fingerprint(CHANNELS.modelAb, { v: 1 })).not.toBe(
      fp.fingerprint(CHANNELS.modelAb, { v: -0 }),
    );
  });

  it("缺键与显式 undefined 等价 ⇒ schema 补出的缺省值不会算出第二套指纹", () => {
    const fp = fingerprinter();
    expect(fp.fingerprint(CHANNELS.modelAb, { dryRun: undefined, arms: [1] })).toBe(
      fp.fingerprint(CHANNELS.modelAb, { arms: [1] }),
    );
    expect(canonicalizeRequest({ a: 1, b: undefined })).toBe(canonicalizeRequest({ a: 1 }));
  });

  it("通道参与规范化 ⇒ 同一业务值跨通道复用必然得到不同指纹", () => {
    const fp = fingerprinter();
    const shared = { parentRunId: "run_p", atSpanId: "s1", edit: { field: "result", value: "v" } };
    expect(fp.fingerprint(CHANNELS.forkRun, shared)).not.toBe(
      fp.fingerprint(CHANNELS.promptFork, shared),
    );
  });

  it("指纹是会话密钥的 HMAC：同密钥同摘要、换密钥换摘要，且不外泄原始值", () => {
    const value = { userMessage: "敏感任务正文" };
    const first = new RequestFingerprinter(SECRET).fingerprint(CHANNELS.createRun, value);
    const again = new RequestFingerprinter(SECRET).fingerprint(CHANNELS.createRun, value);
    const other = new RequestFingerprinter().fingerprint(CHANNELS.createRun, value);
    expect(first).toBe(again);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(other).not.toBe(first);
    expect(first).not.toContain("敏感任务正文");
  });

  it("规范化只读不改：调用方的对象键顺序保持原样", () => {
    const value = { z: 1, a: 2, m: { y: 1, b: 2 } };
    canonicalizeRequest(value);
    expect(Object.keys(value)).toEqual(["z", "a", "m"]);
    expect(Object.keys(value.m)).toEqual(["y", "b"]);
  });

  it("不可传输的值（NaN/Infinity/函数/符号/循环引用）⇒ 显式抛错，不静默产出错指纹", () => {
    expect(() => canonicalizeRequest({ v: Number.NaN })).toThrow(RequestCanonicalError);
    expect(() => canonicalizeRequest({ v: Number.POSITIVE_INFINITY })).toThrow(
      RequestCanonicalError,
    );
    expect(() => canonicalizeRequest({ v: () => 1 })).toThrow(RequestCanonicalError);
    expect(() => canonicalizeRequest({ v: Symbol("s") })).toThrow(RequestCanonicalError);
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => canonicalizeRequest(cyclic)).toThrow(RequestCanonicalError);
  });
});

describe("U4 1.3 一次 parse 的不可变业务快照", () => {
  it("成功路径：返回值即 schema 解析产物（含类型收窄），且整棵子树深冻结", () => {
    const parsed = parseBusinessRequest(fingerprinter(), CHANNELS.forkRun, ForkRunRequestSchema, {
      parentRunId: "run_p",
      atSpanId: "s1",
      edit: { field: "result", value: "改后的工具结果" },
    });
    if (!parsed.ok) throw new Error("unreachable");
    const value = parsed.request.value;
    expect(value).toEqual({
      parentRunId: "run_p",
      atSpanId: "s1",
      edit: { field: "result", value: "改后的工具结果" },
    });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.edit)).toBe(true);
    // 生成指纹后修改嵌套字段：strict 模式下直接抛，不会静默分叉
    expect(() => {
      (value as { edit: { value: string } }).edit.value = "事后改写";
    }).toThrow(TypeError);
    expect(value.edit.value).toBe("改后的工具结果");
  });

  it("原始 payload 事后被改写 ⇒ 快照与指纹都不受影响（指纹不读原始输入）", () => {
    const raw: Record<string, unknown> = {
      parentRunId: "run_p",
      atSpanId: "s1",
      messages: [{ role: "user", content: "原话" }],
    };
    const parsed = parseBusinessRequest(
      fingerprinter(),
      CHANNELS.proxyFork,
      ProxyForkRequestSchema,
      raw,
    );
    if (!parsed.ok) throw new Error("unreachable");
    const before = parsed.request.fingerprint;
    const snapshotValue = structuredClone(parsed.request.value);
    const messages = raw.messages as Record<string, unknown>[];
    const firstMessage = messages[0];
    if (firstMessage === undefined) throw new Error("unreachable：构造的 messages 必有首项");
    firstMessage.content = "事后篡改";
    raw.parentRunId = "run_other";
    expect(parsed.request.fingerprint).toBe(before);
    expect(parsed.request.value).toEqual(snapshotValue);
    // 同一份快照重算指纹 ⇒ 与登记时一致（指纹与执行同源）
    expect(fingerprintOf(CHANNELS.proxyFork, parsed.request.value)).toBe(before);
    // 篡改后的原始输入会得到**不同**指纹 ⇒ 关联判定只认快照
    expect(fingerprintOf(CHANNELS.proxyFork, raw)).not.toBe(before);
  });

  it("缺省值等价性：dryRun 未给 / 显式 undefined / 解析产物三种写法同一指纹", () => {
    const arms = [{ model: "a" }, { model: "b" }];
    const absent = okRequest(CHANNELS.modelAb, ModelAbRequestSchema, {
      parentRunId: "run_p",
      arms,
    });
    const explicitUndefined = okRequest(CHANNELS.modelAb, ModelAbRequestSchema, {
      parentRunId: "run_p",
      arms,
      dryRun: undefined,
    });
    expect(explicitUndefined.fingerprint).toBe(absent.fingerprint);
    expect(absent.value.dryRun).toBeUndefined();
    // 但 false 是有值——与"未给"不同（区分合法参数类型）
    const falseDryRun = okRequest(CHANNELS.modelAb, ModelAbRequestSchema, {
      parentRunId: "run_p",
      arms,
      dryRun: false,
    });
    expect(falseDryRun.fingerprint).not.toBe(absent.fingerprint);
  });

  it("未知字段：非 strict 业务 schema 会剥离它 ⇒ 与不携带时同一指纹；strict schema 直接拒绝", () => {
    const withExtra = okRequest(CHANNELS.modelAb, ModelAbRequestSchema, {
      parentRunId: "run_p",
      arms: [{ model: "a" }, { model: "b" }],
      rendererScrollTop: 999,
    });
    const without = okRequest(CHANNELS.modelAb, ModelAbRequestSchema, {
      parentRunId: "run_p",
      arms: [{ model: "a" }, { model: "b" }],
    });
    expect(withExtra.fingerprint).toBe(without.fingerprint);
    expect(withExtra.value).not.toHaveProperty("rendererScrollTop");
    // 隔离工作区选择是 strict 的：多一个字段就是非法请求，不进入执行分支
    const strict = parseBusinessRequest(
      fingerprinter(),
      CHANNELS.createRun,
      CreateRunRequestSchema,
      {
        systemPrompt: "",
        userMessage: "任务",
        workspace: {
          mode: "isolated_files",
          sourceToken: "tok",
          allowFileWrites: true,
          extraFromRenderer: true,
        },
      },
    );
    expect(strict.ok).toBe(false);
  });

  it("被拒时只给路径 + 稳定 code：不回显收到的值，也不产出可登记的请求", () => {
    const secretMessage = "含 apiKey=sk-secret-123 的任务正文";
    const parsed = parseBusinessRequest(
      fingerprinter(),
      CHANNELS.createRun,
      CreateRunRequestSchema,
      { systemPrompt: "", userMessage: 42, note: secretMessage },
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.code).toBe("INVALID_ARGUMENT");
    expect(parsed.message).toContain("userMessage");
    expect(parsed.message).toContain("invalid_type");
    expect(parsed.message).not.toContain("sk-secret-123");
    expect(parsed.message).not.toContain(secretMessage);
    expect(parsed.message).not.toContain("42");
    // 空串走 too_small：同样只有路径与 code，不回显输入
    const empty = parseBusinessRequest(
      fingerprinter(),
      CHANNELS.createRun,
      CreateRunRequestSchema,
      { systemPrompt: "含密钥的 system prompt", userMessage: "" },
    );
    expect(empty.ok).toBe(false);
    if (empty.ok) throw new Error("unreachable");
    expect(empty.message).toContain("userMessage：too_small");
    expect(empty.message).not.toContain("含密钥的");
  });

  it("快照不冻结到调用方：原始 payload 事后仍可写，但那份写不回快照", () => {
    const raw = { systemPrompt: "", userMessage: "任务" };
    const parsed = parseBusinessRequest(
      fingerprinter(),
      CHANNELS.createRun,
      CreateRunRequestSchema,
      raw,
    );
    if (!parsed.ok) throw new Error("unreachable");
    raw.userMessage = "改写原对象";
    expect(Object.isFrozen(raw)).toBe(false);
    expect(parsed.request.value.userMessage).toBe("任务");
  });
});

describe("U4 1.3 registry 判重：同参关联、异参拒绝、封禁不复活", () => {
  const FP_A = "a".repeat(64);
  const FP_B = "b".repeat(64);
  const OP = "99999999-9999-4999-8999-999999999999";
  const OP_OTHER = "88888888-8888-4888-8888-888888888888";
  const target = { kind: "create", mode: "plain" } as const;

  function seeded(): OperationRegistry {
    const registry = new OperationRegistry({ newEpoch: () => OP });
    registry.registerRunning({ operationId: OP_OTHER, target, fingerprint: FP_A });
    registry.settle({ operationId: OP_OTHER, requestOutcome: "returned" });
    return registry;
  }

  it("同 ID 同指纹 ⇒ duplicate：返回原记录，登记版本与槽都不动", () => {
    const registry = seeded();
    registry.registerRunning({ operationId: OP, target, fingerprint: FP_A });
    const version = registry.registryVersion;
    const lookup = registry.inspectForAcceptance({ operationId: OP, fingerprint: FP_A });
    expect(lookup.outcome).toBe("duplicate");
    if (lookup.outcome !== "duplicate") throw new Error("unreachable");
    expect(lookup.record.state).toBe("running");
    expect(registry.registryVersion).toBe(version);
    expect(registry.activeId).toBe(OP);
  });

  it("同 ID 异指纹 ⇒ conflict：原登记一字不改，也不占第二槽", () => {
    const registry = seeded();
    registry.registerRunning({ operationId: OP, target, fingerprint: FP_A });
    const before = registry.recordOf(OP);
    const version = registry.registryVersion;
    const lookup = registry.inspectForAcceptance({ operationId: OP, fingerprint: FP_B });
    expect(lookup.outcome).toBe("conflict");
    expect(registry.recordOf(OP)).toEqual(before);
    expect(registry.registryVersion).toBe(version);
    expect(registry.size).toBe(2);
  });

  it("settled 后再次收到同一请求 ⇒ duplicate 且带着原终态（不重试执行）", () => {
    const registry = seeded();
    registry.registerRunning({ operationId: OP, target, fingerprint: FP_A });
    registry.attachRunId(OP, "run_created");
    registry.settle({ operationId: OP, requestOutcome: "returned" });
    const lookup = registry.inspectForAcceptance({ operationId: OP, fingerprint: FP_A });
    expect(lookup.outcome).toBe("duplicate");
    if (lookup.outcome !== "duplicate") throw new Error("unreachable");
    expect(lookup.record).toMatchObject({
      state: "settled",
      requestOutcome: "returned",
      runIds: ["run_created"],
    });
    expect(registry.activeId).toBeNull();
  });

  it("notAccepted（含 reconcile 封禁）⇒ banned：连指纹都不比，永不复活", () => {
    const registry = seeded();
    registry.registerNotAccepted({
      operationId: OP,
      target,
      reason: "busy",
      fingerprint: FP_A,
    });
    for (const fingerprint of [FP_A, FP_B]) {
      const lookup = registry.inspectForAcceptance({ operationId: OP, fingerprint });
      expect(lookup.outcome).toBe("banned");
      if (lookup.outcome !== "banned") throw new Error("unreachable");
      expect(lookup.record).toMatchObject({ state: "notAccepted", rejection: "busy" });
    }
    // 封禁记录同样不可被改写为 running
    expect(() =>
      registry.registerRunning({ operationId: OP, target, fingerprint: FP_A }),
    ).toThrow();
  });

  it("新 ID ⇒ absent（随后才由接受序列决定占槽或被拒）", () => {
    const registry = seeded();
    expect(registry.inspectForAcceptance({ operationId: OP, fingerprint: FP_A })).toEqual({
      outcome: "absent",
    });
  });
});
