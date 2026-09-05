import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 运行配置（LLM 接入）持久化：只落在数据目录内的 settings.json（便携策略，
 * 不写 AppData / 注册表）。
 *
 * - apiKey 优先经系统加密（safeStorage 包装为 SettingsCipher）；加密不可用时
 *   明文降级并落 `apiKeyEncrypted: false` 标记，UI 据此明示风险
 * - 本模块零 Electron 依赖：cipher 由调用方注入（main 组装 safeStorage 实现；
 *   测试注入假实现）——safeStorage 在纯 Node 测试里不可用
 */

export const SETTINGS_FILE_NAME = "settings.json";

/** 本地录制代理配置（与 LLM 运行配置解耦：代理用户可不填 key，只填这些） */
export interface ProxySettings {
  enabled: boolean;
  port: number;
  upstreamBaseUrl: string;
}

export const PROXY_DEFAULTS: ProxySettings = {
  enabled: false,
  port: 8787,
  upstreamBaseUrl: "https://api.deepseek.com",
};

export interface SettingsCipher {
  /** 系统加密是否可用（Electron safeStorage.isEncryptionAvailable） */
  isAvailable(): boolean;
  /** 加密为可落盘的 base64 */
  encrypt(plain: string): string;
  /** 解密；失败抛错（密钥环境变化时 UI 提示重新配置） */
  decrypt(encoded: string): string;
}

/** 落盘结构（明文/密文差异仅体现在 apiKey 字段） */
interface StoredSettings {
  baseURL: string;
  model: string;
  apiKey: string;
  /** false = 明文降级（加密不可用时的诚实标记） */
  apiKeyEncrypted: boolean;
}

/** 运行配置的内存形态（apiKey 仅在 main 内解密后使用，不跨 IPC） */
export interface RunSettings {
  baseURL: string;
  model: string;
  apiKey: string;
  /** apiKey 在磁盘上是否加密 */
  encrypted: boolean;
}

export interface SettingsStoreOptions {
  /** 数据目录 */
  dataDir: string;
  /** 系统加密实现（safeStorage 或测试假件） */
  cipher: SettingsCipher;
  /** 可选 fs 注入（测试用） */
  fs?: Pick<typeof import("node:fs"), "existsSync" | "readFileSync" | "rmSync" | "writeFileSync">;
}

export class SettingsStore {
  private readonly file: string;
  private readonly fs: NonNullable<SettingsStoreOptions["fs"]>;
  private readonly cipher: SettingsCipher;

  constructor(options: SettingsStoreOptions) {
    this.file = join(options.dataDir, SETTINGS_FILE_NAME);
    this.fs = options.fs ?? { existsSync, readFileSync, rmSync, writeFileSync };
    this.cipher = options.cipher;
  }

  /** 读取运行配置；从未配置返回 null */
  load(): RunSettings | null {
    if (!this.fs.existsSync(this.file)) {
      return null;
    }
    const parsed: unknown = JSON.parse(this.fs.readFileSync(this.file, "utf8"));
    const stored = parsed as Partial<StoredSettings>;
    if (
      typeof stored.baseURL !== "string" ||
      typeof stored.model !== "string" ||
      typeof stored.apiKey !== "string" ||
      stored.apiKey.length === 0
    ) {
      throw new Error("settings.json 内容不完整（缺 baseURL/model/apiKey）");
    }
    const encrypted = stored.apiKeyEncrypted !== false;
    const apiKey = encrypted ? this.cipher.decrypt(stored.apiKey) : stored.apiKey;
    return { baseURL: stored.baseURL, model: stored.model, apiKey, encrypted };
  }

  /** 保存运行配置；apiKey 为空串表示保持原值（改 baseURL/model 不动密钥） */
  save(input: { baseURL: string; apiKey: string; model: string }): RunSettings {
    const current = this.tryLoad();
    const apiKey = input.apiKey.length > 0 ? input.apiKey : (current?.apiKey ?? "");
    if (apiKey.length === 0) {
      throw new Error("apiKey 不能为空（清空请用“清除配置”）");
    }
    const encrypted = this.cipher.isAvailable();
    const stored: StoredSettings = {
      baseURL: input.baseURL,
      model: input.model,
      apiKey: encrypted ? this.cipher.encrypt(apiKey) : apiKey,
      apiKeyEncrypted: encrypted,
    };
    this.fs.writeFileSync(this.file, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    return { baseURL: input.baseURL, model: input.model, apiKey, encrypted };
  }

  /** 清除运行配置（删除文件） */
  clear(): void {
    if (this.fs.existsSync(this.file)) {
      this.fs.rmSync(this.file);
    }
  }

  /** 系统加密当前是否可用（未配置时 UI 据此预告"将以何种方式存储"） */
  isEncryptionAvailable(): boolean {
    return this.cipher.isAvailable();
  }

  /** load 的容错版：文件损坏按未配置处理（不阻断启动） */
  private tryLoad(): RunSettings | null {
    try {
      return this.load();
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // 代理配置：与运行配置解耦（文件缺失/损坏时返回默认值，不抛错）
  // -------------------------------------------------------------------------

  /** 读代理配置；文件缺失或字段缺失时逐字段回退默认值 */
  loadProxy(): ProxySettings {
    const defaults = { ...PROXY_DEFAULTS };
    if (!this.fs.existsSync(this.file)) return defaults;
    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.file, "utf8")) as {
        proxy?: Partial<ProxySettings>;
      };
      const p = parsed.proxy;
      if (p === undefined) return defaults;
      return {
        enabled: typeof p.enabled === "boolean" ? p.enabled : defaults.enabled,
        port:
          typeof p.port === "number" && Number.isInteger(p.port) && p.port >= 1 && p.port <= 65535
            ? p.port
            : defaults.port,
        upstreamBaseUrl:
          typeof p.upstreamBaseUrl === "string" && p.upstreamBaseUrl.length > 0
            ? p.upstreamBaseUrl
            : defaults.upstreamBaseUrl,
      };
    } catch {
      return defaults;
    }
  }

  /** 写代理配置：只合并 proxy 字段，不触碰既有运行配置（含密文 apiKey） */
  saveProxy(proxy: ProxySettings): void {
    let stored: Record<string, unknown> = {};
    if (this.fs.existsSync(this.file)) {
      try {
        stored = JSON.parse(this.fs.readFileSync(this.file, "utf8")) as Record<string, unknown>;
      } catch {
        stored = {}; // 运行配置损坏时代理配置照常可写（不因读失败阻塞）
      }
    }
    stored.proxy = proxy;
    this.fs.writeFileSync(this.file, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  }
}
