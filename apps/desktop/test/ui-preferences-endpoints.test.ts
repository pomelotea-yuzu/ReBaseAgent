import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TrustedSender } from "../src/main/operation-endpoints";
import { UI_PREFERENCES_FILE_NAME, UiPreferencesStore } from "../src/main/ui-preferences";
import {
  type UiPreferencesEndpointDeps,
  readUiPreferences,
  setUiPreference,
} from "../src/main/ui-preferences-endpoints";
import { OPERATION_ERROR } from "../src/shared/operations";

const dirs: string[] = [];
const trusted: TrustedSender = { webContentsId: 1, frameRoutingId: 1 };
const untrusted: TrustedSender = { webContentsId: 99, frameRoutingId: 1 };

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "uiprefs-endpoint-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deps(dir: string, systemLocale = "zh-TW"): UiPreferencesEndpointDeps {
  return {
    store: new UiPreferencesStore({ dataDir: dir }),
    systemLocale: () => systemLocale,
    isTrustedSender: (sender) => sender.webContentsId === 1 && sender.frameRoutingId === 1,
  };
}

describe("uiPreferences 端点：system/显式/恢复", () => {
  it("缺失偏好按 system 解析：系统 zh 变体取 zh-CN，其余取 en-US", () => {
    const dir = makeDir();
    expect(readUiPreferences(deps(dir, "zh-TW"))).toMatchObject({
      ok: true,
      data: {
        preference: "system",
        effectiveLocale: "zh-CN",
        source: "default",
        issue: null,
        revision: 0,
      },
    });
    expect(readUiPreferences(deps(dir, "fr-FR"))).toMatchObject({
      ok: true,
      data: { effectiveLocale: "en-US" },
    });
  });

  it("显式偏好优先于系统语言，保存后 revision 推进", () => {
    const dir = makeDir();
    const d = deps(dir, "en-US");
    const saved = setUiPreference(d, trusted, { preference: "zh-CN" });
    expect(saved).toMatchObject({
      ok: true,
      data: {
        preference: "zh-CN",
        effectiveLocale: "zh-CN",
        source: "file",
        revision: 1,
      },
    });
    expect(readUiPreferences(d)).toMatchObject({
      ok: true,
      data: { preference: "zh-CN", effectiveLocale: "zh-CN", revision: 1 },
    });
  });

  it("损坏/未知版本按 system 启动并带恢复原因，不自动覆盖", () => {
    for (const [content, issue] of [
      ["{broken", "corrupt"],
      ['{"version":2,"language":"en-US"}', "unknown_version"],
    ] as const) {
      const dir = makeDir();
      writeFileSync(join(dir, UI_PREFERENCES_FILE_NAME), content, "utf8");
      expect(readUiPreferences(deps(dir, "zh-CN"))).toMatchObject({
        ok: true,
        data: {
          preference: "system",
          effectiveLocale: "zh-CN",
          source: "recovered",
          issue,
        },
      });
    }
  });

  it("非法载荷/额外字段拒绝，不写盘", () => {
    const dir = makeDir();
    const d = deps(dir);
    for (const payload of [
      { preference: "fr-FR" },
      { preference: "zh-CN", path: "/tmp/x" },
      {},
      null,
      "zh-CN",
    ]) {
      const result = setUiPreference(d, trusted, payload);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENT");
    }
    expect(readUiPreferences(d)).toMatchObject({ ok: true, data: { revision: 0 } });
  });

  it("不可信 sender 拒绝，且不落盘", () => {
    const dir = makeDir();
    const d = deps(dir);
    const result = setUiPreference(d, untrusted, { preference: "en-US" });
    expect(result).toEqual({
      ok: false,
      error: { code: OPERATION_ERROR.untrustedSender, message: expect.any(String) },
    });
    expect(readUiPreferences(d)).toMatchObject({ ok: true, data: { revision: 0 } });
  });

  it("保存失败保持原状态、不推进 revision", () => {
    const dir = makeDir();
    const d = deps(dir);
    setUiPreference(d, trusted, { preference: "zh-CN" });
    const missingDir = join(dir, "does-not-exist");
    const broken: UiPreferencesEndpointDeps = {
      ...d,
      store: new UiPreferencesStore({ dataDir: missingDir }),
    };
    const result = setUiPreference(broken, trusted, { preference: "en-US" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UI_PREFERENCES_SAVE_FAILED");
    expect(readUiPreferences(d)).toMatchObject({
      ok: true,
      data: { preference: "zh-CN", revision: 1 },
    });
  });
});
