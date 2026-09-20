import { randomBytes } from "node:crypto";
import { basename } from "node:path";

/**
 * 源目录选择的会话令牌（B 任务 1.3，design §1）。
 *
 * 为什么不让 renderer 直接传路径：路径是字符串输入，"上次选过的目录"与"本次确认的
 * 目录"必须分开——用户在文件选择器里选了 A，提交时请求却带着 B 的路径，等于绕过了
 * 用户确认。因此选择器只回签发一个**会话内一次性**的 sourceToken，真实路径留在 main；
 * 提交时消费 token 换出路径，用完即焚。
 *
 * - **15 分钟有效**：足够覆盖"选目录 → 填表单 → 确认"的间隔，过期必须重选。
 * - **一次性消费**：同一 token 不能创建两个隔离 run（每次新操作都要重新选择与确认）。
 * - **取消不签发**：选择器取消路径不产生任何 token。
 * - 零 fs：本类不碰磁盘，路径校验（与 dataDir 的关系、形态、真实性）由 A 包的
 *   `validateSourceRoot` 在提交时做——这里只管"路径是用户本次选的那个"。
 */

/** 签发结果（回传渲染层的只有 token 与显示名，不给物理路径以外的任何东西） */
export interface IssuedSource {
  /** 会话令牌（一次性；15 分钟内有效） */
  readonly token: string;
  /** 显示名（目录的 basename，供界面展示；不含完整物理路径） */
  readonly name: string;
  /** 有效期止（ISO 字符串，供界面提示"已过期请重选"） */
  readonly expiresAt: string;
}

export type ConsumeSourceResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: "invalid" | "expired" };

interface Entry {
  readonly path: string;
  readonly expiresAtMs: number;
}

export const SOURCE_TOKEN_TTL_MS = 15 * 60 * 1000;

export class SourceTokenStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly ttlMs: number = SOURCE_TOKEN_TTL_MS) {}

  /** 签发：绑定所选真实路径（取消选择时调用方不得调用本方法） */
  issue(path: string): IssuedSource {
    const token = randomBytes(16).toString("hex");
    const expiresAtMs = Date.now() + this.ttlMs;
    this.entries.set(token, { path, expiresAtMs });
    this.sweep();
    return {
      token,
      name: basename(path) || path,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  /**
   * 消费：成功提交时换出真实路径，**用后即焚**。无效（不存在/已消费）或过期分别报告，
   * 渲染层据此提示"重新选择目录"。
   */
  consume(token: unknown): ConsumeSourceResult {
    if (typeof token !== "string" || token.length === 0) {
      return { ok: false, reason: "invalid" };
    }
    const entry = this.entries.get(token);
    if (entry === undefined) {
      return { ok: false, reason: "invalid" };
    }
    this.entries.delete(token);
    if (Date.now() > entry.expiresAtMs) {
      return { ok: false, reason: "expired" };
    }
    return { ok: true, path: entry.path };
  }

  /** 清理过期条目（签发与消费时顺带做，不设定时器） */
  private sweep(): void {
    const now = Date.now();
    for (const [token, entry] of this.entries) {
      if (now > entry.expiresAtMs) this.entries.delete(token);
    }
  }
}
