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

  // U8 任务 3.7：已核实配置变化代次（仅轮换 key 的保存——指纹不变——也作废旧计划）
  it("代次推进 ⇒ config-stale（仅轮换 key：指纹相同、代次不同）", () => {
    expect(
      decidePlanFreshness({
        planRevision: 7,
        draftRevision: 7,
        planConfigStamp: current,
        currentConfigStamp: current,
        planSettingsGeneration: 3,
        currentSettingsGeneration: 4,
      }),
    ).toBe("config-stale");
  });

  it("代次未推进（普通 proxy:status 刷新场景）⇒ 不误使有效计划失效", () => {
    expect(
      decidePlanFreshness({
        planRevision: 7,
        draftRevision: 7,
        planConfigStamp: current,
        currentConfigStamp: current,
        planSettingsGeneration: 4,
        currentSettingsGeneration: 4,
      }),
    ).toBe("fresh");
  });

  it("未接代次的旧调用方（字段缺省）⇒ 行为不变", () => {
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
    // ⚠️ U8 3.1a 改判留痕：ModelAbEditor 提取为独立文件，源码级断言改读新文件
    const src = read("../src/renderer/src/components/ModelAbEditor.tsx");
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

  it("「录制入口保持现有代理区可达」：全局/空态的录制入口打开独立录制工作区", () => {
    // ⚠️ U8（unify-recording-and-experiment-workspaces）1.4 有意改判（2026-10-01）：
    // 本用例旧判据是「openRecording 走 setSettingsSection("proxy") 开设置定位代理分区」，
    // 且禁止 RecordingWorkspace 存在。delta 把本场景的 THEN 改为「打开独立录制工作区，
    // 设置不保留第二份代理配置表单」，故判据随 1.4 翻转；设置侧跳转与移除代理表单归 2.10。
    const app = read("../src/renderer/src/App.tsx");
    const at = app.indexOf("const openRecording");
    expect(at).toBeGreaterThan(-1);
    const block = app.slice(at, at + 160);
    expect(block).toContain("openRecordingWorkspace()");
    // 走的是**独立录制工作区**（新形态），不再定位设置模态的代理分区
    expect(app).toContain("RecordingWorkspace");
    expect(block).not.toContain('setSettingsSection("proxy")');
  });

  // U5 6.7 实机坐实的接线缺陷（「接线少一支」家族）：GlobalBar 的录制入口此前只拿到
  // openSettings（先清 settingsSection 再开）⇒ "proxy" 标记在设置模态挂载前就被清掉，
  // 定位效果（滚到代理分区 + 聚焦首控件）从不发生。单元层只钉了 App.openRecording 的形状，
  // GlobalBar → 开器这一跳没有判据 ⇒ 实机焦点落在 ✕ 而不是代理复选框。修复后钉两层：
  it("录制入口的 GlobalBar 一跳必须走不清 section 的专用开器（6.7 实机缺陷的契约）", () => {
    const app = read("../src/renderer/src/App.tsx");
    // App 把专用开器接到 GlobalBar（与常规 openSettings 分开）
    expect(app).toContain("onOpenRecording={openRecording}");
    const bar = read("../src/renderer/src/components/GlobalBar.tsx");
    const at = bar.indexOf("const openRecording");
    expect(at).toBeGreaterThan(-1);
    const barBlock = bar.slice(at, at + 200);
    // GlobalBar 的录制入口走 onOpenRecording，**不得**再经过会清 section 的 onOpenSettings
    expect(barBlock).toContain("onOpenRecording()");
    expect(barBlock).not.toContain("onOpenSettings()");
    // 开器内部不得先清 settingsSection（清了标记就到不了设置模态的定位 effect）
    const recBlock = app.slice(at, app.indexOf("const openSettings", at));
    expect(recBlock).not.toContain("setSettingsSection(null)");
  });

  it("「设置跳转录制先处理未保存模型字段」：设置内跳转 = 先 dirty 确认，再进录制工作区（源码级接线契约）", () => {
    // ⚠️ U8 2.10：设置不再保留代理表单，本分区只剩真实监听摘要 + 跳转按钮
    const dialog = read("../src/renderer/src/components/SettingsDialog.tsx");
    // 跳转入口是真实按钮，且落在录制分区
    expect(dialog).toContain("data-settings-recording-jump");
    expect(dialog).toContain("openRecordingFromSettings");
    // dirty 时先真模态确认（可取消）；取消 = 零跳转零代理调用（回调里没有 openRecordingWorkspace）
    const jumpAt = dialog.indexOf("const openRecordingFromSettings");
    const jumpBlock = dialog.slice(jumpAt, dialog.indexOf("const plain", jumpAt));
    expect(jumpBlock).toContain("requestConfirm(");
    expect(jumpBlock).toContain("if (!discard) return;");
    expect(jumpBlock).toContain('setApiKey("")');
    expect(jumpBlock).toContain("openRecordingWorkspace()");
    // 设置里不再有第二份代理配置表单（唯一的配置写通道在录制工作区）
    expect(dialog).not.toContain("doProxyApply");
    expect(dialog).not.toContain("proxyCheckboxRef");
  });
});
