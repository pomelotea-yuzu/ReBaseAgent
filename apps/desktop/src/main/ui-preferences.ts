import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 桌面语言偏好：独立于 settings.json 的 ui-preferences.json。
 *
 * - 只保存 `system / zh-CN / en-US`，默认 system；不依赖模型 key，清运行配置不删本文件。
 * - 缺失按 system；损坏/未知版本不阻断启动、不自动覆盖，返回 recovered 供 UI 提示。
 * - 保存走同目录临时文件 + rename，失败不破坏原文件。
 * - 本模块零 Electron 依赖：系统语言由调用方解析，store 只负责数据根内的持久化。
 */

export const UI_PREFERENCES_FILE_NAME = "ui-preferences.json";
export const UI_PREFERENCES_VERSION = 1;

export const UI_LANGUAGE_PREFERENCES = ["system", "zh-CN", "en-US"] as const;
export type UiLanguagePreference = (typeof UI_LANGUAGE_PREFERENCES)[number];

export interface UiPreferences {
  readonly version: typeof UI_PREFERENCES_VERSION;
  readonly language: UiLanguagePreference;
}

export type UiPreferencesIssue = "corrupt" | "unknown_version";
export type UiPreferencesSource = "default" | "file" | "recovered";

export interface UiPreferencesSnapshot {
  readonly preferences: UiPreferences;
  readonly source: UiPreferencesSource;
  readonly issue: UiPreferencesIssue | null;
  /** 本 main 会话内的保存代次；get/set 响应据此丢弃旧回声。 */
  readonly revision: number;
}

const DEFAULT_PREFERENCES: UiPreferences = { version: 1, language: "system" };

type UiPreferencesFs = Pick<
  typeof import("node:fs"),
  "existsSync" | "readFileSync" | "writeFileSync" | "renameSync" | "rmSync"
>;

export interface UiPreferencesStoreOptions {
  readonly dataDir: string;
  readonly fs?: UiPreferencesFs;
}

function isLanguage(value: unknown): value is UiLanguagePreference {
  return (
    typeof value === "string" && (UI_LANGUAGE_PREFERENCES as readonly string[]).includes(value)
  );
}

function isExactShape(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === 2 && keys[0] === "language" && keys[1] === "version";
}

export class UiPreferencesStore {
  private readonly file: string;
  private readonly fs: UiPreferencesFs;
  private revision = 0;
  private tempSeq = 0;

  constructor(options: UiPreferencesStoreOptions) {
    this.file = join(options.dataDir, UI_PREFERENCES_FILE_NAME);
    this.fs = options.fs ?? { existsSync, readFileSync, writeFileSync, renameSync, rmSync };
  }

  get path(): string {
    return this.file;
  }

  load(): UiPreferencesSnapshot {
    if (!this.fs.existsSync(this.file)) {
      return {
        preferences: { ...DEFAULT_PREFERENCES },
        source: "default",
        issue: null,
        revision: this.revision,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(this.fs.readFileSync(this.file, "utf8"));
    } catch {
      return this.recovered("corrupt");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return this.recovered("corrupt");
    }
    const record = parsed as Record<string, unknown>;
    if (record.version !== UI_PREFERENCES_VERSION) {
      return this.recovered("unknown_version");
    }
    if (!isExactShape(record) || !isLanguage(record.language)) {
      return this.recovered("corrupt");
    }
    return {
      preferences: { version: 1, language: record.language },
      source: "file",
      issue: null,
      revision: this.revision,
    };
  }

  /** 原子保存；非法值/写入失败抛错，原文件与 revision 不变。 */
  save(language: UiLanguagePreference): UiPreferencesSnapshot {
    if (!isLanguage(language)) throw new Error("语言偏好只能是 system / zh-CN / en-US");
    const temp = `${this.file}.tmp-${this.tempSeq++}`;
    try {
      this.fs.writeFileSync(temp, `${JSON.stringify({ version: 1, language }, null, 2)}\n`, "utf8");
      this.fs.renameSync(temp, this.file);
    } catch (error) {
      try {
        this.fs.rmSync(temp, { force: true });
      } catch {
        // 临时文件清理失败不覆盖原始保存错误
      }
      throw error;
    }
    this.revision += 1;
    return {
      preferences: { version: 1, language },
      source: "file",
      issue: null,
      revision: this.revision,
    };
  }

  private recovered(issue: UiPreferencesIssue): UiPreferencesSnapshot {
    return {
      preferences: { ...DEFAULT_PREFERENCES },
      source: "recovered",
      issue,
      revision: this.revision,
    };
  }
}
