/**
 * 结构正文的规范 JSON 序列化（design D6：「结构正文先规范 JSON 后分文本段」）。
 *
 * 为什么必须规范：正文要被**分段读**（码点范围 + 续读），而 `JSON.stringify` 的键序取自
 * 插入序——同一份 span 记录在两次读取之间被别的实现重排过键，分段结果就会整体漂移，
 * 续读拼回来的就不再是原文。这里固定三条：
 * - 对象键按 **UTF-16 代码单元升序**（与列表排序同一口径，与语言环境无关）；
 * - 数组保持原序（顺序本身是事实：messages 的先后、tool_calls 的序号）；
 * - 不缩进、不插空格、中文与常见符号不转义（`JSON.stringify` 的默认转义集），
 *   这样「码点范围」量的就是客户端实际拿到的那几个字符。
 *
 * 入参恒为 `readRun` 经 zod 校验后的记录值（来自 `JSON.parse`）：无循环引用、
 * 无 `undefined` 成员、无 `NaN/Infinity` ⇒ 不为这些情形写分支。唯一保留的拒绝是
 * 「整段值是 undefined」：那等于客户端要正文而我们什么也没有，宁可笑问出错，
 * 也不要静默发出一个 `null` 被读成「录得就是 null」。
 */
export function canonicalJson(value: unknown): string {
  return render(value);
}

function render(value: unknown): string {
  if (value === null) return "null";
  const type = typeof value;
  if (type !== "object") {
    const literal = JSON.stringify(value);
    if (literal === undefined) throw new Error("规范 JSON：不接受 undefined");
    return literal;
  }
  if (Array.isArray(value)) return `[${value.map(render).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left === right ? 0 : left < right ? -1 : 1,
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${render(item)}`).join(",")}}`;
}
