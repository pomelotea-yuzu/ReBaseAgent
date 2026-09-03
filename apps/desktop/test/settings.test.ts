import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsStore } from "../src/main/settings";
import type { SettingsCipher } from "../src/main/settings";

/**
 * SettingsStore 单测：纯 Node 环境，cipher 用假实现（真 safeStorage 依赖 Electron，
 * 不可在 vitest 里跑）。重点：加密/降级两态、空 apiKey 保原值、清除与损坏容错。
 */

function fakeCipher(available: boolean): SettingsCipher {
  return {
    isAvailable: () => available,
    encrypt: (plain) => `enc:${plain}`,
    decrypt: (encoded) => {
      if (!encoded.startsWith("enc:")) {
        throw new Error("ciphertext 格式错误（模拟密钥环境变化）");
      }
      return encoded.slice(4);
    },
  };
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "settings-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("SettingsStore：未配置与保存", () => {
  it("无文件 → load 返回 null", () => {
    const store = new SettingsStore({ dataDir: tempDir(), cipher: fakeCipher(true) });
    expect(store.load()).toBeNull();
  });

  it("save → 文件内 apiKey 为密文并带 encrypted 标记；load 解密回读", () => {
    const dir = tempDir();
    const store = new SettingsStore({ dataDir: dir, cipher: fakeCipher(true) });
    const saved = store.save({
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "sk-123",
      model: "deepseek-chat",
    });
    expect(saved).toEqual({
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "sk-123",
      model: "deepseek-chat",
      encrypted: true,
    });

    const raw = readFileSync(join(dir, "settings.json"), "utf8");
    expect(raw).toContain("enc:sk-123");
    expect(raw).toContain('"apiKeyEncrypted": true');
    expect(raw).not.toContain('"apiKey": "sk-123"');

    expect(store.load()).toEqual({
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "sk-123",
      model: "deepseek-chat",
      encrypted: true,
    });
    expect(store.isEncryptionAvailable()).toBe(true);
  });

  it("save 时 apiKey 为空串 → 保持当前密钥（只改 baseURL/model）", () => {
    const store = new SettingsStore({ dataDir: tempDir(), cipher: fakeCipher(true) });
    store.save({ baseURL: "https://a.example/v1", apiKey: "sk-old", model: "m1" });
    store.save({ baseURL: "https://b.example/v1", apiKey: "", model: "m2" });
    expect(store.load()).toEqual({
      baseURL: "https://b.example/v1",
      apiKey: "sk-old",
      model: "m2",
      encrypted: true,
    });
  });

  it("从未配置且 apiKey 为空 → 抛错（清空必须走 clear）", () => {
    const store = new SettingsStore({ dataDir: tempDir(), cipher: fakeCipher(true) });
    expect(() => store.save({ baseURL: "https://a.example/v1", apiKey: "", model: "m1" })).toThrow(
      /apiKey 不能为空/,
    );
  });
});

describe("SettingsStore：加密不可用 → 明文降级", () => {
  it("明文落盘 + apiKeyEncrypted false + encrypted false（UI 据此明示风险）", () => {
    const dir = tempDir();
    const store = new SettingsStore({ dataDir: dir, cipher: fakeCipher(false) });
    const saved = store.save({ baseURL: "https://a.example/v1", apiKey: "sk-plain", model: "m1" });
    expect(saved.encrypted).toBe(false);
    expect(store.isEncryptionAvailable()).toBe(false);

    const raw = readFileSync(join(dir, "settings.json"), "utf8");
    expect(raw).toContain('"apiKey": "sk-plain"');
    expect(raw).toContain('"apiKeyEncrypted": false');

    expect(store.load()?.apiKey).toBe("sk-plain");
    expect(store.load()?.encrypted).toBe(false);
  });
});

describe("SettingsStore：清除与容错", () => {
  it("clear → 文件删除，load 回到 null", () => {
    const dir = tempDir();
    const store = new SettingsStore({ dataDir: dir, cipher: fakeCipher(true) });
    store.save({ baseURL: "https://a.example/v1", apiKey: "sk-x", model: "m1" });
    expect(existsSync(join(dir, "settings.json"))).toBe(true);
    store.clear();
    expect(existsSync(join(dir, "settings.json"))).toBe(false);
    expect(store.load()).toBeNull();
  });

  it("解密失败（模拟系统密钥环境变化）→ load 抛错，可被 UI 捕获引导重配", () => {
    const dir = tempDir();
    const store = new SettingsStore({ dataDir: dir, cipher: fakeCipher(true) });
    store.save({ baseURL: "https://a.example/v1", apiKey: "sk-x", model: "m1" });

    // 换一个解不开旧密文的 cipher（等效于换机器/密钥环丢失）
    const lostKeyring: SettingsCipher = {
      isAvailable: () => false,
      encrypt: (plain) => plain,
      decrypt: () => {
        throw new Error("系统密钥不可用（ciphertext 无法解密）");
      },
    };
    const broken = new SettingsStore({ dataDir: dir, cipher: lostKeyring });
    expect(() => broken.load()).toThrow(/无法解密/);
    // 文件仍在，用户可走 clear 重新配置
    expect(existsSync(join(dir, "settings.json"))).toBe(true);
  });
});
