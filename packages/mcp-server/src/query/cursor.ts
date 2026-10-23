import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { CURSOR_MAX } from "../limits.js";
import { canonicalJson } from "./canonical-json.js";

/**
 * 不透明续读游标（design D6 / S08）。
 *
 * 形状：`mcpc1.<keyId>.<payloadB64url>.<macB64url>`
 * - `keyId` 由**进程随机密钥**派生：换进程/重启 ⇒ keyId 不同 ⇒ `STALE_CURSOR`；
 * - MAC 覆盖 tag/keyId/payload：同 keyId 但被改过 ⇒ `INVALID_ARGUMENT`；
 * - payload 只放版本/工具/参数指纹/readVersion 指纹/位置，**不放路径、正文或任何 run 内容**。
 *
 * 分类边界（刻意如此）：改了 keyId 的游标与「另一个进程发的游标」在密码学上不可区分，
 * 一律按重启处理（STALE_CURSOR）；同 keyId 的篡改必须 MAC 失败 ⇒ 参数问题。
 */

export type CursorKind = "items" | "chars";

export interface CursorInput {
  readonly tool: string;
  readonly params: unknown;
  readonly readVersion: string;
  readonly kind: CursorKind;
  readonly position: readonly number[];
}

export interface CursorDecodeInput {
  readonly tool: string;
  readonly params: unknown;
  readonly readVersion: string;
  readonly kind: CursorKind;
  /** 该工具期望的位置槽数（页 1；正文 1；两侧正文 2） */
  readonly slots: number;
}

export type CursorDecodeResult =
  | { readonly ok: true; readonly position: readonly number[] }
  | {
      readonly ok: false;
      readonly code: "INVALID_ARGUMENT" | "STALE_CURSOR";
      readonly reason: string;
    };

interface CursorPayload {
  readonly v: 1;
  readonly t: string;
  readonly p: string;
  readonly r: string;
  readonly k: CursorKind;
  readonly o: readonly number[];
}

const CURSOR_TAG = "mcpc1";

/** 去掉 undefined 键：zod optional 可能把显式 undefined 留在解析结果里，规范 JSON 不接受它 */
function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, stripUndefined(child)]),
    );
  }
  return value;
}

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function paramsFingerprint(tool: string, params: unknown): string {
  return sha256(canonicalJson(["params", tool, stripUndefined(params)]));
}

function readVersionFingerprint(readVersion: string): string {
  return sha256(readVersion);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export interface CursorCodec {
  encode(input: CursorInput): string;
  decode(cursor: string, input: CursorDecodeInput): CursorDecodeResult;
}

export function createCursorCodec(key: Buffer = randomBytes(32)): CursorCodec {
  const keyId = createHash("sha256").update(key).digest("base64url").slice(0, 11);

  function macOf(tag: string, id: string, payload: string): string {
    return createHmac("sha256", key).update(`${tag}.${id}.${payload}`).digest("base64url");
  }

  return {
    encode(input) {
      if (input.position.length === 0 || !input.position.every(isNonNegativeInteger)) {
        throw new Error("游标位置必须是非负整数数组");
      }
      const payload: CursorPayload = {
        v: 1,
        t: input.tool,
        p: paramsFingerprint(input.tool, input.params),
        r: readVersionFingerprint(input.readVersion),
        k: input.kind,
        o: [...input.position],
      };
      const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
      const cursor = `${CURSOR_TAG}.${keyId}.${payloadB64}.${macOf(CURSOR_TAG, keyId, payloadB64)}`;
      if (cursor.length > CURSOR_MAX) {
        throw new Error(`游标长度超过上限 ${CURSOR_MAX}`);
      }
      return cursor;
    },

    decode(cursor, input) {
      const parts = cursor.split(".");
      if (parts.length !== 4 || parts[0] !== CURSOR_TAG) {
        return { ok: false, code: "INVALID_ARGUMENT", reason: "游标格式不认识" };
      }
      const [, id, payloadB64, macB64] = parts;
      if (id !== keyId) {
        // 换进程（或改了 keyId）：与「另一个进程的游标」不可区分，按重启处理
        return { ok: false, code: "STALE_CURSOR", reason: "游标来自另一个进程" };
      }
      const expectedMac = Buffer.from(macOf(CURSOR_TAG, id, payloadB64), "utf8");
      const actualMac = Buffer.from(macB64, "utf8");
      if (actualMac.length !== expectedMac.length || !timingSafeEqual(actualMac, expectedMac)) {
        return { ok: false, code: "INVALID_ARGUMENT", reason: "游标签名不匹配" };
      }

      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
      } catch {
        return { ok: false, code: "INVALID_ARGUMENT", reason: "游标载荷无法解析" };
      }
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        return { ok: false, code: "INVALID_ARGUMENT", reason: "游标载荷形状不对" };
      }
      const record = payload as Record<string, unknown>;
      if (
        record.v !== 1 ||
        typeof record.t !== "string" ||
        typeof record.p !== "string" ||
        typeof record.r !== "string" ||
        (record.k !== "items" && record.k !== "chars") ||
        !Array.isArray(record.o) ||
        !record.o.every(isNonNegativeInteger)
      ) {
        return { ok: false, code: "INVALID_ARGUMENT", reason: "游标载荷字段不对" };
      }
      if (record.t !== input.tool || record.k !== input.kind) {
        return { ok: false, code: "INVALID_ARGUMENT", reason: "游标不属于该工具/模式" };
      }
      if (record.p !== paramsFingerprint(input.tool, input.params)) {
        return { ok: false, code: "INVALID_ARGUMENT", reason: "游标参数指纹不匹配" };
      }
      if (record.o.length !== input.slots) {
        return { ok: false, code: "INVALID_ARGUMENT", reason: "游标位置槽数不匹配" };
      }
      if (record.r !== readVersionFingerprint(input.readVersion)) {
        return { ok: false, code: "STALE_CURSOR", reason: "数据源已变化" };
      }
      return { ok: true, position: record.o };
    },
  };
}

/** 进程级默认 codec：密钥在模块加载时随机生成，进程重启即换 */
export const cursorCodec: CursorCodec = createCursorCodec();
