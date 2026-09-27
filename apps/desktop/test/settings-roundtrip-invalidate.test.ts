import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProxyState, SettingsState } from "@shared/ipc";
import { describe, expect, it } from "vitest";
import {
  decidePlanFreshness,
  modelConfigStampOf,
  settingsStampOf,
} from "../src/renderer/src/lib/execution-confirmation";

/**
 * U5（unify-run-execution-workflow）任务 5.3：**设置来源返回与摘要刷新，使原检查/许可失效，
 * 保持代理入口可达**。
 *
 * 判据来源：delta「设置往返保留编辑并真实反馈配置结果」之
 * 「两模式配置后返回任务」「重跑编辑配置往返保持阅读」（"配置变更使执行检查或计划失效"半边）
 * 「录制入口保持现有代理区可达」。
 *
 * 分工（别当成重复交付）：确认/检查代次的撤销走 `setSettingsSection` 进出（任务 4.4 已交付，
 * 证据在 `execution-confirmation-store.test.ts`）；**本项补"保存成功改了模型配置"这一路**——
 * A/B 的 dry-run 计划绑定预览时的配置指纹，创建与隔离 result 的**本次副本授权**随指纹变化作废。
 * 摘要的"已核实保存"= `saveSettings` 成功后 store 立即 `loadSettings` 回读（既有实现），
 * 创建页摘要读的就是回读后的状态——这里钉接线，不再造第二份核实。
 */

const settings = (overrides: Partial<SettingsState> = {}): SettingsState => ({
  configured: true,
  baseURL: "http://127.0.0.1:11434/v1",
  model: "qwen2.5",
  encryption: "safe",
  ...overrides,
});

const proxy = (overrides: Partial<ProxyState> = {}): ProxyState =>
  ({
    running: true,
    port: 18787,
    hasKey: true,
    ...overrides,
  }) as ProxyState;

describe("5.3 modelConfigStampOf：只认模型配置的三要素", () => {
  it("model / baseURL / configured 任一变化都换指纹", () => {
    const base = modelConfigStampOf(settings());
    expect(modelConfigStampOf(settings({ model: "llama3" }))).not.toBe(base);
    expect(modelConfigStampOf(settings({ baseURL: "https://api.example.com/v1" }))).not.toBe(base);
    expect(modelConfigStampOf(settings({ configured: false }))).not.toBe(base);
    expect(modelConfigStampOf(null)).not.toBe(base);
  });

  it("加密方式不进指纹（单向存储的读回形状不是「打到哪台上游」的事实）；未读取自成一态", () => {
    expect(modelConfigStampOf(settings({ encryption: "plain" }))).toBe(
      modelConfigStampOf(settings({ encryption: "safe" })),
    );
    expect(modelConfigStampOf(null)).toContain("unread");
  });

  it("与 settingsStampOf 分离：代理启停/凭据波动**不该**作废 A/B 计划（delta 明文分规则）", () => {
    const stampA = settingsStampOf({ settings: settings(), proxy: proxy({ running: true }) });
    const stampB = settingsStampOf({ settings: settings(), proxy: proxy({ running: false }) });
    expect(stampB).not.toBe(stampA);
    expect(modelConfigStampOf(settings())).toBe(modelConfigStampOf(settings()));
  });
});

describe("5.3 decidePlanFreshness：修订与配置是两种要分开的失效", () => {
  const current = modelConfigStampOf(settings());

  it("修订与配置都同源 ⇒ fresh", () => {
    expect(
      decidePlanFreshness({
        planRevision: 7,
        draftRevision: 7,
        planConfigStamp: current,
        currentConfigStamp: current,
      }),
    ).toBe("fresh");
  });

  it("批次修订推进 ⇒ revision-stale（U3 3.3 原判据不回归）", () => {
    expect(
      decidePlanFreshness({
        planRevision: 6,
        draftRevision: 7,
        planConfigStamp: current,
        currentConfigStamp: current,
      }),
    ).toBe("revision-stale");
  });

  it("设置往返改了配置 ⇒ config-stale，且**优先于**修订变化（先说打到哪变了）", () => {
    const other = modelConfigStampOf(settings({ model: "llama3" }));
    expect(
      decidePlanFreshness({
        planRevision: 6,
        draftRevision: 7,
        planConfigStamp: current,
        currentConfigStamp: other,
      }),
    ).toBe("config-stale");
  });

  it("还没预览（修订/指纹为 null）⇒ 不是 fresh，执行按钮不得放行", () => {
    expect(
      decidePlanFreshness({
        planRevision: null,
        draftRevision: 3,
        planConfigStamp: null,
        currentConfigStamp: current,
      }),
    ).toBe("revision-stale");
  });
});

describe("5.3 容器接线（源码级契约）", () => {
  const read = (rel: string) =>
    readFileSync(resolve(import.meta.dirname, rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");

  it("ModelAbEditor：计划安装同时记录配置指纹；activePlan 只认 fresh；失效措辞分两种", () => {
    const src = read("../src/renderer/src/components/DetailPanel.tsx");
    expect(src).toContain("setPlanConfigStamp(requestedStamp)");
    expect(src).toContain('plan !== null && planFreshness === "fresh" ? plan : null');
    expect(src).toContain("预览之后运行配置已改变");
    expect(src).toContain("这份计划属于旧批次修订");
    // 指纹在**发起时**捕获（在飞期间改设置也不装新计划）——requestedStamp 取自请求时的 currentConfigStamp
    expect(src).toContain("const requestedStamp = currentConfigStamp;");
  });

  it("隔离 result 与创建页：配置指纹变化 ⇒ 本次副本授权作废；目录引用/模式照旧保留", () => {
    const panel = read("../src/renderer/src/components/DetailPanel.tsx");
    expect(panel).toContain(
      "useRevokeOnConfigChange(modelConfigStampOf(settings), () => setWritesAuthorized(false));",
    );
    const create = read("../src/renderer/src/components/CreateRunWorkspace.tsx");
    // revoke 回调只动授权：不得顺手清 source/引用/模式（delta 的"保留"半边）
    const revokeBlock = create.slice(
      create.indexOf("useRevokeOnConfigChange("),
      create.indexOf("useRevokeOnConfigChange(") + 240,
    );
    expect(revokeBlock).toContain("setWritesAuthorized(prev, false)");
    for (const forbidden of ["source: null", "setCreateSourceRef", "switchCreateRunMode"]) {
      expect(revokeBlock, forbidden).not.toContain(forbidden);
    }
  });

  it("use-revoke-on-config-change 是纯钩子：只依赖 react，只在指纹**变化**时回调一次", () => {
    const src = read("../src/renderer/src/lib/use-revoke-on-config-change.ts");
    const imports = src
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import"))
      .join("\n");
    expect(imports).not.toContain("../store");
    expect(imports).not.toContain("@shared");
    expect(src).toContain("if (previous.current === currentStamp) return;");
    // 回调经 ref 取最新值：调用方不 memoize 也不会漏清/重清
    expect(src).toContain("revokeRef.current()");
  });

  it("「录制入口保持现有代理区可达」：全局/空态的录制入口定位既有代理分区", () => {
    const app = read("../src/renderer/src/App.tsx");
    const at = app.indexOf("const openRecording");
    expect(at).toBeGreaterThan(-1);
    const block = app.slice(at, at + 160);
    expect(block).toContain('setSettingsSection("proxy")');
    expect(block).toContain("setSettingsOpen(true)");
    // 走的是**既有设置模态的代理分区**，不是新开的工作区/假页面
    expect(app).not.toContain("ProxyWorkspace");
    expect(app).not.toContain("RecordingWorkspace");
  });
});
