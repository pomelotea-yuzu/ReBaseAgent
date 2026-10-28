import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsStore } from "../src/main/settings";
import {
  UI_PREFERENCES_FILE_NAME,
  UiPreferencesStore,
  type UiPreferencesStoreOptions,
} from "../src/main/ui-preferences";

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rebaseagent-uiprefs-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function prefFile(dir: string): string {
  return join(dir, UI_PREFERENCES_FILE_NAME);
}

describe("UiPreferencesStore：缺失、保存与恢复", () => {
  it("文件缺失时默认 system，不写盘、不阻塞", () => {
    const dir = makeDir();
    const store = new UiPreferencesStore({ dataDir: dir });
    expect(store.load()).toEqual({
      preferences: { version: 1, language: "system" },
      source: "default",
      issue: null,
      revision: 0,
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("保存后读取一致，文件独立且 revision 只在实际成功后推进", () => {
    const dir = makeDir();
    const store = new UiPreferencesStore({ dataDir: dir });
    const first = store.save("en-US");
    expect(first.revision).toBe(1);
    expect(JSON.parse(readFileSync(prefFile(dir), "utf8"))).toEqual({
      version: 1,
      language: "en-US",
    });
    expect(store.load()).toMatchObject({
      preferences: { version: 1, language: "en-US" },
      source: "file",
      issue: null,
      revision: 1,
    });
    expect(store.save("system").revision).toBe(2);
    expect(readdirSync(dir)).toEqual([UI_PREFERENCES_FILE_NAME]);
  });

  it("损坏/未知版本/非法语言/多余字段都不自动覆盖，按 system 启动", () => {
    const cases = [
      ["{broken", "corrupt"],
      ['{"version":2,"language":"system"}', "unknown_version"],
      ['{"version":1,"language":"fr-FR"}', "corrupt"],
      ['{"version":1,"language":"system","extra":true}', "corrupt"],
    ] as const;
    for (const [content, issue] of cases) {
      const dir = makeDir();
      writeFileSync(prefFile(dir), content, "utf8");
      const store = new UiPreferencesStore({ dataDir: dir });
      expect(store.load()).toMatchObject({
        preferences: { version: 1, language: "system" },
        source: "recovered",
        issue,
      });
      expect(readFileSync(prefFile(dir), "utf8")).toBe(content);
    }
  });

  it("非法保存值抛错，不写文件也不推进 revision", () => {
    const dir = makeDir();
    const store = new UiPreferencesStore({ dataDir: dir });
    expect(() => store.save("fr-FR" as never)).toThrow();
    expect(readdirSync(dir)).toEqual([]);
    expect(store.load().revision).toBe(0);
  });

  it("写入临时文件后 rename；rename 失败清理临时文件并保留原文件", () => {
    const dir = makeDir();
    writeFileSync(prefFile(dir), '{"version":1,"language":"zh-CN"}\n', "utf8");
    const calls: string[] = [];
    const fs: NonNullable<UiPreferencesStoreOptions["fs"]> = {
      existsSync: () => true,
      readFileSync: () => '{"version":1,"language":"zh-CN"}\n',
      writeFileSync: (path: string) => {
        calls.push(`write:${path}`);
      },
      renameSync: () => {
        calls.push("rename");
        throw new Error("rename denied");
      },
      rmSync: (path: string) => {
        calls.push(`rm:${path}`);
      },
    } as unknown as NonNullable<UiPreferencesStoreOptions["fs"]>;
    const store = new UiPreferencesStore({ dataDir: dir, fs });
    expect(() => store.save("en-US")).toThrow("rename denied");
    expect(calls[0]).toContain("write:");
    expect(calls[0]).not.toBe(`write:${prefFile(dir)}`);
    expect(calls[0]).toContain(".tmp-");
    expect(calls[1]).toBe("rename");
    expect(calls[2]).toContain("rm:");
    expect(store.load().preferences.language).toBe("zh-CN");
    expect(store.load().revision).toBe(0);
  });

  it("不同数据根各自读取，不迁移偏好", () => {
    const a = makeDir();
    const b = makeDir();
    new UiPreferencesStore({ dataDir: a }).save("en-US");
    expect(new UiPreferencesStore({ dataDir: a }).load().preferences.language).toBe("en-US");
    expect(new UiPreferencesStore({ dataDir: b }).load().preferences.language).toBe("system");
  });

  it("清运行配置不删除语言偏好；保存语言不改 settings.json", () => {
    const dir = makeDir();
    const settingsFile = join(dir, "settings.json");
    const settingsBytes =
      '{"baseURL":"https://example.com","model":"m","apiKey":"k","apiKeyEncrypted":false}\n';
    writeFileSync(settingsFile, settingsBytes, "utf8");
    const prefs = new UiPreferencesStore({ dataDir: dir });
    prefs.save("zh-CN");
    expect(readFileSync(settingsFile, "utf8")).toBe(settingsBytes);

    const settings = new SettingsStore({
      dataDir: dir,
      cipher: {
        isAvailable: () => false,
        encrypt: () => "",
        decrypt: () => "",
      },
    });
    settings.clear();
    expect(() => readFileSync(settingsFile, "utf8")).toThrow();
    expect(prefs.load().preferences.language).toBe("zh-CN");
    expect(readFileSync(prefFile(dir), "utf8")).toContain('"language": "zh-CN"');
  });
});
