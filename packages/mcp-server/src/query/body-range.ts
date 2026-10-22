import { BODY_CHARS_DEFAULT, BODY_CHARS_MAX } from "../limits.js";

/**
 * 正文的码点范围切片（design D6）。
 *
 * 三条硬口径：
 * - **按 Unicode 码点计数**，不是 UTF-16 代码单元、不是字节：`Array.from` 按码点迭代，
 *   代理对（emoji、部分罕用汉字）永远不会被切成半个字符——半个字符发出去就是乱码或
 *   非法 JSON 字符串；
 * - `total` 是**过滤后外发文本**的总码点数，不是原文件字节数（文件那一路另有
 *   `bytes`/`hash` 描述完整历史文件，两者不互相冒充）；
 * - 上限只是防撑大载荷，**不承诺预算**：完整序列化结果不超过 64 KiB 由 5.1 按实际
 *   字节数再收一次（本层只给码点范围）。
 */

export interface BodyRange {
  readonly start: number;
  readonly end: number;
  readonly total: number;
  readonly unit: "unicode-code-point";
}

export interface SlicedBody {
  readonly text: string;
  readonly range: BodyRange;
  readonly truncated: boolean;
  readonly remaining: number;
}

export function sliceBody(text: string, maxChars: number | undefined, start = 0): SlicedBody {
  const size = Math.min(maxChars ?? BODY_CHARS_DEFAULT, BODY_CHARS_MAX);
  const characters = Array.from(text);
  const from = Math.max(0, Math.min(start, characters.length));
  const to = Math.min(characters.length, from + size);
  const taken = characters.slice(from, to);
  return {
    text: taken.join(""),
    range: { start: from, end: to, total: characters.length, unit: "unicode-code-point" },
    truncated: to < characters.length,
    remaining: characters.length - to,
  };
}
