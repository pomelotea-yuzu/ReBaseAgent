/**
 * 6.2 改判后的正文判据件：正文本体**只承载在 content 投影**里——
 * `structuredContent.data` 对应位是 `bodyIn:"content"` 指针，渲染器把正文位渲染成
 * `text: "<JSON 串>"` 单行（换行/引号全部转义，不破坏投影结构）。
 *
 * 三个正文位工具的 data schema 里**没有第二个 `text` 键**（此处与渲染器约定互为判据）：
 * 提取失败（格式漂移/正文缺席）会直接抛错 ⇒ 「正文进 content」与投影格式一起被钉住。
 */

export function contentText(result: object): string {
  const blocks = (result as { content?: unknown }).content;
  if (!Array.isArray(blocks)) throw new Error("content 不是文本块数组");
  const block = blocks[0] as { type?: string; text?: string } | undefined;
  if (block === undefined || block.type !== "text" || typeof block.text !== "string") {
    throw new Error("content[0] 不是文本块");
  }
  return block.text;
}

/**
 * 从 content 投影提取全部正文本体（按出现序）：
 * get_step / read_checkpoint_file 各一条，compare_checkpoint_files 内容模式左右各一
 * （非 text 的侧没有正文段）。
 */
export function contentBodyTexts(result: object): string[] {
  const texts: string[] = [];
  for (const line of contentText(result).split("\n")) {
    const match = /^\s*text: (.*)$/.exec(line);
    if (match === null) continue;
    const parsed = JSON.parse(match[1]) as unknown;
    if (typeof parsed !== "string") continue;
    texts.push(parsed);
  }
  return texts;
}
