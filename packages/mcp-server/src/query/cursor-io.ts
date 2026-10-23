import { ToolFailure } from "../tool-definition.js";
import { type CursorKind, cursorCodec } from "./cursor.js";

/**
 * 工具侧游标缝：只做「解出位置或抛稳定码」与「签发」，不复制 codec 的判据。
 *
 * 入参一律传**去掉 cursor 之后**的请求参数：参数指纹与 readVersion 都必须对
 * 首页/续读算出同一个值，否则续读永远自带一次「参数变化」。
 */

export function withoutCursor<T extends { cursor?: string }>(args: T): Omit<T, "cursor"> {
  const { cursor: _cursor, ...rest } = args;
  return rest;
}

export function requireCursorPosition(input: {
  readonly cursor: string | undefined;
  readonly tool: string;
  readonly params: unknown;
  readonly readVersion: string;
  readonly kind: CursorKind;
  readonly slots: number;
}): readonly number[] {
  if (input.cursor === undefined) {
    return Array.from({ length: input.slots }, () => 0);
  }
  const decoded = cursorCodec.decode(input.cursor, input);
  if (!decoded.ok) throw new ToolFailure(decoded.code, "cursor");
  return decoded.position;
}

export function issueCursor(input: {
  readonly tool: string;
  readonly params: unknown;
  readonly readVersion: string;
  readonly kind: CursorKind;
  readonly position: readonly number[];
}): string {
  return cursorCodec.encode(input);
}
