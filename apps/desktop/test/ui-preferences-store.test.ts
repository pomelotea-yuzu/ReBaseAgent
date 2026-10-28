import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { UiPreferencesSlice } from "../src/renderer/src/store/slices/ui-preferences";
import type { Envelope, UiPreferencesState, WindowApi } from "../src/shared/ipc";
import { ok } from "../src/shared/ipc";

/**
 * 语言偏好 store 分片：独立保存、首次读取、旧响应回退与 revision 守卫。
 * 直接用假 window.api 驱动分片，避免整棵 store 的无关字段复位噪声。
 */
interface Controller {
  getDeferred: Array<(value: Envelope<UiPreferencesState>) => void>;
  getCalls: number;
  setCalls: Array<{ preference: string }>;
  setEnvelope: Envelope<UiPreferencesState> | undefined;
  settingsCalls: number;
  clears: number;
}

const controller: Controller = {
  getDeferred: [],
  getCalls: 0,
  setCalls: [],
  setEnvelope: undefined,
  settingsCalls: 0,
  clears: 0,
};

const fakeApi = {
  getUiPreferences: () => {
    controller.getCalls += 1;
    return new Promise<Envelope<UiPreferencesState>>((resolve) => {
      controller.getDeferred.push(resolve);
    });
  },
  setUiPreferences: async (input: { preference: string }) => {
    controller.setCalls.push(input);
    return (
      controller.setEnvelope ??
      ok({
        preference: input.preference as UiPreferencesState["preference"],
        effectiveLocale: input.preference === "zh-CN" ? "zh-CN" : "en-US",
        source: "file",
        issue: null,
        revision: 1,
      })
    );
  },
  getSettings: async () => {
    controller.settingsCalls += 1;
    throw new Error("语言保存不得触碰运行配置");
  },
  saveSettings: async () => {
    controller.settingsCalls += 1;
    throw new Error("语言保存不得触碰运行配置");
  },
  clearSettings: async () => {
    controller.settingsCalls += 1;
    throw new Error("语言保存不得触碰运行配置");
  },
} as unknown as WindowApi;

(globalThis as Record<string, unknown>).window = { api: fakeApi };
// 分片模块在 import 时读 window.api；stub 必须先就位
const { createUiPreferencesSlice } = await import(
  "../src/renderer/src/store/slices/ui-preferences"
);

function makeSlice(): UiPreferencesSlice {
  let state: UiPreferencesSlice;
  const set = (patch: Partial<UiPreferencesSlice>): void => {
    state = { ...state, ...patch };
  };
  const get = (): UiPreferencesSlice => state;
  state = {
    ...createUiPreferencesSlice({
      set: set as never,
      get: get as never,
    }),
    effectiveLocale: "en-US",
    clearExecutionConfirmations: () => {
      controller.clears += 1;
    },
  } as UiPreferencesSlice;
  return new Proxy({} as UiPreferencesSlice, {
    get: (_target, key) => {
      const value = (state as unknown as Record<PropertyKey, unknown>)[key];
      return typeof value === "function" ? value.bind(state) : value;
    },
    set: (_target, key, value) => {
      (state as unknown as Record<PropertyKey, unknown>)[key] = value;
      return true;
    },
  });
}

const systemState: UiPreferencesState = {
  preference: "system",
  effectiveLocale: "zh-CN",
  source: "default",
  issue: null,
  revision: 0,
};

beforeEach(() => {
  controller.getDeferred = [];
  controller.getCalls = 0;
  controller.setCalls = [];
  controller.setEnvelope = undefined;
  controller.settingsCalls = 0;
  controller.clears = 0;
});

describe("uiPreferences store 分片", () => {
  it("main.tsx 在 createRoot 之前读取偏好，避免首次挂载闪烁", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../src/renderer/src/main.tsx"),
      "utf8",
    );
    const load = source.indexOf("loadUiPreferences");
    const mount = source.indexOf("createRoot(");
    expect(load).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(-1);
    expect(load).toBeLessThan(mount);
    // Provider 不允许用 locale 作 key：切语言不能重建编辑器/工作区/焦点
    expect(source).toContain("<I18nProvider locale={locale}>");
    expect(source).not.toContain("key={locale}");
  });

  it("切换语言不触碰草稿/编辑器/未保存设置等其他状态", async () => {
    let state: UiPreferencesSlice & {
      draftText: string;
      editorValue: string;
      unsavedSettings: string;
    };
    const set = (patch: Partial<typeof state>): void => {
      state = { ...state, ...patch };
    };
    const get = (): typeof state => state;
    const slice = createUiPreferencesSlice({ set: set as never, get: get as never });
    state = {
      ...slice,
      effectiveLocale: "en-US",
      clearExecutionConfirmations: () => {
        controller.clears += 1;
      },
      draftText: "保留的草稿",
      editorValue: "editor value",
      unsavedSettings: "unsaved",
    };
    await slice.saveUiLanguage("en-US");
    expect(state.draftText).toBe("保留的草稿");
    expect(state.editorValue).toBe("editor value");
    expect(state.unsavedSettings).toBe("unsaved");
    expect(state.effectiveLocale).toBe("en-US");
  });

  it("首次读取在业务挂载前拿到有效语言并采纳", async () => {
    const slice = makeSlice();
    const pending = slice.loadUiPreferences();
    expect(slice.uiPreferencesLoaded).toBe(false);
    controller.getDeferred.shift()?.(ok(systemState));
    await expect(pending).resolves.toBe(true);
    expect(slice.effectiveLocale).toBe("zh-CN");
    expect(slice.uiPreferences).toEqual(systemState);
    expect(slice.uiPreferencesLoaded).toBe(true);
    // fallback en-US → zh-CN 是一次有效语言变化：清空未提交确认并推进 epoch
    expect(controller.clears).toBe(1);
    expect(slice.languageEpoch).toBe(1);
  });

  it("仅偏好变化而有效语言相同：不清确认、不推进 epoch", async () => {
    const slice = makeSlice();
    const first = slice.loadUiPreferences();
    controller.getDeferred.shift()?.(ok(systemState));
    await first;
    expect(controller.clears).toBe(1);
    expect(slice.languageEpoch).toBe(1);

    controller.setEnvelope = ok({
      preference: "system",
      effectiveLocale: "zh-CN",
      source: "file",
      issue: null,
      revision: 2,
    });
    await expect(slice.saveUiLanguage("system")).resolves.toBe("saved");
    expect(controller.clears).toBe(1);
    expect(slice.languageEpoch).toBe(1);
  });

  it("有效语言变化：清空执行确认并推进 epoch", async () => {
    const slice = makeSlice();
    const first = slice.loadUiPreferences();
    controller.getDeferred.shift()?.(ok(systemState));
    await first;
    expect(slice.effectiveLocale).toBe("zh-CN");

    controller.setEnvelope = ok({
      preference: "en-US",
      effectiveLocale: "en-US",
      source: "file",
      issue: null,
      revision: 2,
    });
    await expect(slice.saveUiLanguage("en-US")).resolves.toBe("saved");
    expect(controller.clears).toBe(2);
    expect(slice.languageEpoch).toBe(2);
  });

  it("保存语言是独立入口：只调 uiPreferences:set，不触碰 settings", async () => {
    const slice = makeSlice();
    const outcome = await slice.saveUiLanguage("en-US");
    expect(outcome).toBe("saved");
    expect(controller.setCalls).toEqual([{ preference: "en-US" }]);
    expect(controller.settingsCalls).toBe(0);
    expect(slice.effectiveLocale).toBe("en-US");
  });

  it("旧的 get 回声不能覆盖刚保存的新偏好", async () => {
    const slice = makeSlice();
    const staleLoad = slice.loadUiPreferences();
    expect(slice.uiPreferencesRequestSeq).toBe(1);

    controller.setEnvelope = ok({
      preference: "en-US",
      effectiveLocale: "en-US",
      source: "file",
      issue: null,
      revision: 1,
    });
    await expect(slice.saveUiLanguage("en-US")).resolves.toBe("saved");
    expect(slice.effectiveLocale).toBe("en-US");

    controller.getDeferred.shift()?.(ok(systemState));
    await expect(staleLoad).resolves.toBe(false);
    expect(slice.effectiveLocale).toBe("en-US");
    expect(slice.uiPreferences?.revision).toBe(1);
  });

  it("保存失败保留原语言、不推进状态；非法响应同样不采纳", async () => {
    const slice = makeSlice();
    const first = slice.loadUiPreferences();
    controller.getDeferred.shift()?.(ok(systemState));
    await first;

    controller.setEnvelope = {
      ok: false,
      error: { code: "UI_PREFERENCES_SAVE_FAILED", message: "disk full" },
    };
    await expect(slice.saveUiLanguage("en-US")).resolves.toBe("failed");
    expect(slice.effectiveLocale).toBe("zh-CN");
    expect(slice.uiPreferences?.preference).toBe("system");
    expect(slice.uiPreferencesSaveFailed).toBe(true);

    controller.setEnvelope = ok({
      preference: "en-US",
      effectiveLocale: "fr-FR",
      source: "file",
      issue: null,
      revision: 2,
    } as never);
    await expect(slice.saveUiLanguage("en-US")).resolves.toBe("failed");
    expect(slice.effectiveLocale).toBe("zh-CN");
  });
});
