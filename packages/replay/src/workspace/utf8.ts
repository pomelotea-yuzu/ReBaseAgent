/**
 * 隔离文件世界的文本编码口径：**严格 UTF-8**，不做有损转码。
 *
 * 规则（A design §4、spec「二进制字节保持」）：
 * - 能按 UTF-8 严格解码 ⇒ 文本，可交给读工具/查看器；
 * - 不能 ⇒ **是二进制**：保留原字节、大小与哈希，返回可辨认的状态，绝不用替换字符（U+FFFD）
 *   冒充原文——那会让"读到的内容"与"附件里的字节"悄悄不一致。
 *
 * `ignoreBOM: true` 是刻意的：这里要的是**字节的 1:1 解码**，不做任何编辑器式的改写
 * （BOM 是合法的 UTF-8 字节序列，属于文件内容，由展示层决定是否隐藏）。
 */

/**
 * 严格 UTF-8 解码；非法序列返回 `null`（调用方据此判定为二进制）。
 *
 * 每次新建 `TextDecoder` 实例：带状态的解码器会被 `fatal` 错误污染，复用容易把一次
 * 非法输入的影响带到下一次调用上。
 */
export function tryDecodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}
