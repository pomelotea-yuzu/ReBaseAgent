import { createHash } from "node:crypto";
import type { RunRepository } from "@rebaseagent/run-query";

/**
 * readVersion（design D4：「参与文件字节与参数的摘要」）。
 *
 * 摘要材料 = 数据根下**每个** `.jsonl` 的文件名/字节数/修改时刻（按文件名升序）
 * + 本次工具名 + 已通过校验的入参。三条刻意取舍：
 * - **不逐字节做内容哈希**：列表本身已经解析过全部文件，再读一遍字节会把只读诊断
 *   的代价翻倍；台账只 stat。代价是「同字节数且保留 mtime 的原地改写」判不出来——
 *   design D3 本来就声明不承诺抵御有权限的并发替换，续读要挡的是正常应用改动与追加。
 * - **不按参与链收窄**：整目录台账比「本次真正读到的那几个文件」更保守，别的 run
 *   变化也会让游标过期。宁可多判一次 STALE_CURSOR 从头重查，也不把已变来源拼进续读。
 * - **入参直接进摘要**：改参数（含 limit/query/status）必然换 readVersion，游标绑定
 *   参数由此而来（5.2 负责签发与核验游标本身）。
 * - **附件由调用方追加 `extra`**：检查点/文件类工具把所读快照的附件 stat 台账放进来，
 *   这样「trace 没变、附件被删/换/顶成目录」也会换 readVersion ⇒ 续读 STALE_CURSOR。
 *   摘要仍只 stat、不读附件字节（D6 的读取成本边界）。
 */

/** 摘要前缀：形状变了要让旧游标一律判过期，而不是被读成「同一份数据」 */
const READ_VERSION_TAG = "rv2";

export function computeReadVersion(
  tool: string,
  args: unknown,
  repository: RunRepository,
  extra: unknown = null,
): string {
  const material = JSON.stringify([
    READ_VERSION_TAG,
    tool,
    args,
    repository.traceFileLedger(),
    extra,
  ]);
  return `${READ_VERSION_TAG}:${createHash("sha256").update(Buffer.from(material, "utf8")).digest("hex")}`;
}
