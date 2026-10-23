import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CURSOR_MAX } from "../src/limits.js";
import { createCursorCodec, cursorCodec } from "../src/query/cursor.js";

/**
 * MCP0 5.2（S08）：不透明游标的认证、参数/版本绑定与重启语义。
 *
 * 关键分类：
 * - 同 keyId 的篡改 ⇒ INVALID_ARGUMENT；参数/工具/模式变化 ⇒ INVALID_ARGUMENT；
 * - 数据源 readVersion 变化 ⇒ STALE_CURSOR；
 * - 换进程（keyId 不同）⇒ STALE_CURSOR（与另一个进程的游标不可区分）。
 */

const PARAMS = { runId: "mcp0-cursor", limit: 2 };
const READ_VERSION = "rv2:0123456789abcdef";
const BASE = {
  tool: "list_runs",
  params: PARAMS,
  readVersion: READ_VERSION,
  kind: "items" as const,
};

function issued(codec = cursorCodec): string {
  return codec.encode({ ...BASE, position: [3] });
}

function decode(
  cursor: string,
  overrides: Partial<Parameters<typeof cursorCodec.decode>[1]> = {},
  codec = cursorCodec,
) {
  return codec.decode(cursor, {
    ...BASE,
    slots: 1,
    ...overrides,
  });
}

describe("游标：同一进程的认证与绑定", () => {
  it("同 key 同参同版本可解出位置，长度不超过契约上限", () => {
    const cursor = issued();
    expect(cursor.length).toBeLessThanOrEqual(CURSOR_MAX);
    expect(decode(cursor)).toEqual({ ok: true, position: [3] });
  });

  it("载荷只含版本/工具/哈希/位置，不含路径或正文", () => {
    const secretPath = "secret/dir/body.txt";
    const cursor = cursorCodec.encode({
      tool: "read_checkpoint_file",
      params: { runId: "r", path: secretPath, maxChars: 100 },
      readVersion: READ_VERSION,
      kind: "chars",
      position: [100],
    });
    const payloadB64 = cursor.split(".")[2] ?? "";
    const payload = Buffer.from(payloadB64, "base64url").toString("utf8");
    expect(payload).not.toContain(secretPath);
    expect(payload).not.toContain("body.txt");
    expect(JSON.parse(payload)).toMatchObject({
      v: 1,
      t: "read_checkpoint_file",
      k: "chars",
      o: [100],
    });
  });

  it("参数变化 ⇒ INVALID_ARGUMENT（不是 STALE）", () => {
    expect(decode(issued(), { params: { ...PARAMS, limit: 3 } })).toMatchObject({
      ok: false,
      code: "INVALID_ARGUMENT",
    });
  });

  it("工具/模式/位置槽数变化 ⇒ INVALID_ARGUMENT", () => {
    expect(decode(issued(), { tool: "get_run" })).toMatchObject({
      ok: false,
      code: "INVALID_ARGUMENT",
    });
    expect(decode(issued(), { kind: "chars" })).toMatchObject({
      ok: false,
      code: "INVALID_ARGUMENT",
    });
    expect(decode(issued(), { slots: 2 })).toMatchObject({
      ok: false,
      code: "INVALID_ARGUMENT",
    });
  });

  it("readVersion 变化 ⇒ STALE_CURSOR（数据源已变）", () => {
    expect(decode(issued(), { readVersion: "rv2:changed" })).toMatchObject({
      ok: false,
      code: "STALE_CURSOR",
    });
  });

  it("同 keyId 的载荷篡改（MAC 不符）⇒ INVALID_ARGUMENT", () => {
    const cursor = issued();
    const [tag, keyId, payload, mac] = cursor.split(".");
    if (tag === undefined || keyId === undefined || payload === undefined || mac === undefined) {
      throw new Error("游标结构异常");
    }
    // 改一个**仍然合法**的 JSON 字段（位置 3→4），确保拒绝来自 MAC 而不是解析失败
    const payloadJson = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    payloadJson.o = [4];
    const tamperedPayload = Buffer.from(JSON.stringify(payloadJson), "utf8").toString("base64url");
    const tampered = [tag, keyId, tamperedPayload, mac].join(".");
    expect(decode(tampered)).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
  });

  it("换 codec 密钥（重启/另一进程）⇒ STALE_CURSOR", () => {
    const cursor = issued();
    const other = createCursorCodec(Buffer.from("another-process-key"));
    expect(decode(cursor, {}, other)).toMatchObject({ ok: false, code: "STALE_CURSOR" });
  });

  it("畸形游标不会抛异常：格式错/同 keyId 的残骸按 INVALID_ARGUMENT 收口", () => {
    expect(decode("not-a-cursor")).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
    const keyId = issued().split(".")[1];
    if (keyId === undefined) throw new Error("游标结构异常");
    expect(decode(`mcpc1.${keyId}.y.z`)).toMatchObject({
      ok: false,
      code: "INVALID_ARGUMENT",
    });
  });
});

describe("游标：真实跨进程（重启语义）", () => {
  it("另一个 Node 进程签发的游标在本进程判 STALE_CURSOR", () => {
    const script = fileURLToPath(new URL("./cursor-child-encode.mjs", import.meta.url));
    const input = {
      tool: "list_runs",
      params: PARAMS,
      readVersion: READ_VERSION,
      kind: "items",
      position: [3],
    };
    const cursor = execFileSync(process.execPath, [script, JSON.stringify(input)], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(cursor.startsWith("mcpc1.")).toBe(true);
    expect(decode(cursor)).toMatchObject({ ok: false, code: "STALE_CURSOR" });
  });
});
