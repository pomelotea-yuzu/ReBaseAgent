import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SettingsStateSchema, ok } from "@shared/ipc";
import type { Envelope, SettingsState } from "@shared/ipc";
import { beforeEach, describe, expect, it } from "vitest";
import { settingsDraftDirty } from "../src/renderer/src/lib/settings-form";

/**
 * U5（unify-run-execution-workflow）任务 5.4：**设置未保存关闭确认、单向 key、
 * 保存防重入与失败/回读失败反馈**。
 *
 * 判据来源：delta「设置往返保留编辑并真实反馈配置结果」之
 * 「未保存设置关闭可继续或放弃」「单向密钥与保存反馈不冒充连通」「保存失败和保存后回读失败区分」。
 *
 * ⚠️ 无 jsdom ⇒ 对话框走源码级契约（判据都沉在 `lib/settings-form.ts` 与 store 三态里）；
 * 禁用型断言先剥注释。
 */

const saved: SettingsState = {
  configured: true,
  baseURL: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  encryption: "safe",
};
const cleanDraft = {
  draft: { baseURL: saved.baseURL ?? "", model: saved.model ?? "", apiKey: "" },
  saved,
};

describe("5.4 settingsDraftDirty：什么算未保存修改", () => {
  it("与已保存/已应用值逐项相同 ⇒ 不脏（trim 同值也没改）", () => {
    expect(settingsDraftDirty(cleanDraft)).toBe(false);
    expect(
      settingsDraftDirty({
        ...cleanDraft,
        draft: { ...cleanDraft.draft, baseURL: "  https://api.deepseek.com/v1  " },
      }),
    ).toBe(false);
  });

  // ⚠️ U8 2.10 有意改判（2026-10-01）：本用例旧判据是「模型字段或代理字段任何一项偏离
  // ⇒ 脏」；delta 把代理未应用字段从设置里移除（独立录制工作区有自己的草稿与退出保护，
  // 见 lib/recording-draft.ts），故代理偏离分支删除，判据只剩模型三件。
  it("模型字段任何一项偏离 ⇒ 脏", () => {
    expect(settingsDraftDirty({ ...cleanDraft, draft: { ...cleanDraft.draft, model: "x" } })).toBe(
      true,
    );
    expect(
      settingsDraftDirty({ ...cleanDraft, draft: { ...cleanDraft.draft, baseURL: "https://x" } }),
    ).toBe(true);
  });

  it("单向 key：apiKey 只要打过字就算未保存输入（它从未离开渲染层暂存）", () => {
    expect(
      settingsDraftDirty({ ...cleanDraft, draft: { ...cleanDraft.draft, apiKey: "sk-" } }),
    ).toBe(true);
  });

  it("设置尚未配置（saved null）⇒ 空表单不脏、填了才脏", () => {
    const none = {
      draft: { baseURL: "", model: "", apiKey: "" },
      saved: null,
    };
    expect(settingsDraftDirty(none)).toBe(false);
    expect(settingsDraftDirty({ ...none, draft: { ...none.draft, model: "m" } })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// store 三态：saved / save-failed / reread-failed
// ---------------------------------------------------------------------------

type SettingsSaveOutcome = "saved" | "save-failed" | "reread-failed";

interface OutcomeResult {
  outcome: SettingsSaveOutcome;
  settings: SettingsState | null;
}

const apiStub: Record<string, unknown> = {};
(globalThis as Record<string, unknown>).window = { api: apiStub };
const { useAppStore } = await import("../src/renderer/src/store");

async function runSave(input: {
  save: Envelope<{ configured: true }> | { ok: false; error: { code: string; message: string } };
  reread: Envelope<SettingsState> | { ok: false; error: { code: string; message: string } };
}): Promise<OutcomeResult> {
  useAppStore.setState({ settings: saved });
  let rereadCalls = 0;
  apiStub.saveSettings = async () => input.save;
  apiStub.getSettings = async () => {
    rereadCalls += 1;
    return input.reread;
  };
  const outcome = await useAppStore.getState().saveSettings({
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "",
    model: "deepseek-chat",
  });
  void rereadCalls;
  return { outcome, settings: useAppStore.getState().settings };
}

describe("5.4 store.saveSettings：保存与回读是两个结论", () => {
  beforeEach(() => {
    useAppStore.setState({ error: null });
  });

  it("保存成功 + 回读成功 ⇒ saved，settings 是回读后的新事实", async () => {
    const next: SettingsState = { ...saved, model: "deepseek-reasoner" };
    const result = await runSave({ save: ok({ configured: true as const }), reread: ok(next) });
    expect(result.outcome).toBe("saved");
    expect(result.settings?.model).toBe("deepseek-reasoner");
  });

  it("保存失败 ⇒ save-failed，错误入 store，settings 原样（没写进去也不该动事实）", async () => {
    const result = await runSave({
      save: { ok: false, error: { code: "SETTINGS_SAVE_FAILED", message: "写盘失败" } },
      reread: ok(saved),
    });
    expect(result.outcome).toBe("save-failed");
    expect(result.settings).not.toBeNull();
    expect(useAppStore.getState().error).toContain("写盘失败");
  });

  it("「保存失败和保存后回读失败区分」：回读失败 ⇒ reread-failed，且**不把旧摘要当新配置事实**（settings 清空）", async () => {
    const result = await runSave({
      save: ok({ configured: true as const }),
      reread: { ok: false, error: { code: "SETTINGS_READ_FAILED", message: "读取失败" } },
    });
    expect(result.outcome).toBe("reread-failed");
    expect(result.settings).toBeNull();
  });

  it("回读载荷形状不合法也算 reread-failed（不是 saved）", async () => {
    const result = await runSave({
      save: ok({ configured: true as const }),
      reread: ok({ configured: false } as unknown as SettingsState),
    });
    expect(result.outcome).toBe("reread-failed");
    expect(result.settings).toBeNull();
  });
});

describe("5.4 单向 key 与不冒充连通（结构判据）", () => {
  it("SettingsState 的键集里**没有** apiKey：回读只含配置状态", () => {
    expect(Object.keys(SettingsStateSchema.shape)).not.toContain("apiKey");
    expect(Object.keys(SettingsStateSchema.shape).sort()).toEqual(
      ["baseURL", "configured", "encryption", "model"].sort(),
    );
  });

  const codeOf = (rel: string): string =>
    readFileSync(resolve(import.meta.dirname, rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");

  it("设置对话框不冒充连通、不清调试草稿、防重入双保险、只读重试走读通道", () => {
    const src = codeOf("../src/renderer/src/components/SettingsDialog.tsx");
    // ① 反馈措辞：只称"已保存/回读"，不称连接测试/连接成功
    expect(src).toContain("未发起任何连接测试");
    for (const forbidden of ["连接成功", "测试连接", "verifyConnection", "ping"]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
    // ② 关闭确认三路同源（模态 Esc/✕/关闭按钮都走 requestClose），继续编辑=取消语义
    expect(
      src.match(/onClose=\{requestClose\}|onClick={requestClose}/g)?.length,
    ).toBeGreaterThanOrEqual(3);
    expect(src).toContain("继续编辑");
    expect(src).toContain("放弃修改并关闭");
    // ③ 保存防重入：渲染期 canSave 含 busy，事件入口再挡一次
    expect(src).toContain("const canSave = missing.length === 0 && !busy");
    expect(src).toContain("if (busy || !canSave) return;");
    // ④ 只读重试只调 loadSettings（写通道一次都不碰）
    expect(src).toContain("await loadSettings()");
    expect(src).toContain("data-reread-settings");
    const rereadBlock = src.slice(src.indexOf("const doReread"), src.indexOf("const doClear"));
    expect(rereadBlock).not.toContain("saveSettings(");
    // ⑤ 放弃路径碰不到调试草稿与会话提交（结构上就没有那条通道）
    const imports = src
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import"))
      .join("\n");
    for (const forbidden of ["debugging-drafts", "draft-submission", "operations"]) {
      expect(imports, forbidden).not.toContain(forbidden);
    }
  });
});
