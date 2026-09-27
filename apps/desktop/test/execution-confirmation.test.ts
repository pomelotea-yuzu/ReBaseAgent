import type { ProxyState, SettingsState } from "@shared/ipc";
import { describe, expect, it } from "vitest";
import { CREATE_SUBMIT_TARGET } from "../src/renderer/src/lib/draft-submission";
import type { DraftSubmitTarget } from "../src/renderer/src/lib/draft-submission";
import {
  armConfirmation,
  confirmationTargetKey,
  createDisclosure,
  decideConfirmation,
  disclosureLines,
  emptyConfirmationStore,
  releaseConfirmation,
  resultIsolatedDisclosure,
  resultPlainDisclosure,
  settingsStampOf,
} from "../src/renderer/src/lib/execution-confirmation";
import type { ConfirmationBinding } from "../src/renderer/src/lib/execution-confirmation";

/**
 * U5（unify-run-execution-workflow）任务 4.4：**执行前检查与确认**的纯判据。
 *
 * 判据来源：design D2 + delta「执行前检查和确认保持各入口真实语义」。验收场景
 * 「创建和普通重跑只声明已完成的检查」与「返回修改与设置往返撤销旧确认」的判据面都在这里；
 * 接线面（store 与两个入口）见 `execution-confirmation-store.test.ts` 与视图能力断言。
 */

const settings = (over: Partial<SettingsState> = {}): SettingsState =>
  ({
    configured: true,
    encryption: "safe",
    model: "deepseek-chat",
    baseURL: "https://api.deepseek.com/v1",
    ...over,
  }) as SettingsState;

const proxy = (over: Partial<ProxyState> = {}): ProxyState =>
  ({ running: false, port: 18787, hasKey: false, upstream: null, ...over }) as ProxyState;

const TARGET: DraftSubmitTarget = CREATE_SUBMIT_TARGET;
const OTHER: DraftSubmitTarget = { runId: "r_parent", spanId: "s_03", field: "result" };

function binding(over: Partial<ConfirmationBinding> = {}): ConfirmationBinding {
  return {
    channel: "create",
    target: TARGET,
    revision: 3,
    settingsStamp: settingsStampOf({ settings: settings(), proxy: proxy() }),
    generation: 0,
    ...over,
  };
}

describe("4.4 确认是绑定现场的凭据：改了就作废", () => {
  it("未确认过 ⇒ missing（默认没有「顺手已经确认过」这回事）", () => {
    expect(decideConfirmation(emptyConfirmationStore(), binding())).toEqual({
      kind: "missing",
      reason: expect.stringContaining("还没有确认"),
    });
  });

  it("现场逐分量相同才算已确认", () => {
    const armed = armConfirmation(emptyConfirmationStore(), binding());
    expect(decideConfirmation(armed, binding())).toEqual({ kind: "confirmed" });
  });

  it("改输入（修订推进）⇒ 旧确认作废：这就是「返回修改撤销旧确认」", () => {
    const armed = armConfirmation(emptyConfirmationStore(), binding());
    expect(decideConfirmation(armed, binding({ revision: 4 })).kind).toBe("stale");
  });

  it("换设置（模型 / baseURL / 代理状态）⇒ 作废；同模型同代理 ⇒ 仍算同一快照", () => {
    const armed = armConfirmation(emptyConfirmationStore(), binding());
    const stampOf = (s: SettingsState, p: ProxyState) => settingsStampOf({ settings: s, proxy: p });
    const changed = stampOf(settings({ model: "other" }), proxy());
    expect(decideConfirmation(armed, binding({ settingsStamp: changed })).kind).toBe("stale");
    expect(
      decideConfirmation(armed, binding({ settingsStamp: stampOf(settings(), proxy()) })),
    ).toEqual({ kind: "confirmed" });
    // 代理起来也算变化（messages 入口的凭据门禁跟它走）
    expect(
      decideConfirmation(
        armed,
        binding({ settingsStamp: stampOf(settings(), proxy({ running: true })) }),
      ).kind,
    ).toBe("stale");
  });

  it("检查代次推进 ⇒ 旧响应不能安装确认", () => {
    const armed = armConfirmation(emptyConfirmationStore(), binding({ generation: 5 }));
    expect(decideConfirmation(armed, binding({ generation: 6 })).kind).toBe("stale");
  });

  it("通道变了 ⇒ 作废（同一目标键不会串到别的入口）", () => {
    const armed = armConfirmation(emptyConfirmationStore(), binding());
    expect(decideConfirmation(armed, binding({ channel: "result" })).kind).toBe("stale");
  });

  it("同现场重复 arm ⇒ 引用不变（不制造新的会话状态）", () => {
    const armed = armConfirmation(emptyConfirmationStore(), binding());
    expect(armConfirmation(armed, binding())).toBe(armed);
  });

  it("撤销 ⇒ 回到 missing；显式放弃与返回编辑共用这一个出口", () => {
    const armed = armConfirmation(emptyConfirmationStore(), binding());
    const released = releaseConfirmation(armed, TARGET);
    expect(decideConfirmation(released, binding()).kind).toBe("missing");
    // 幂等：没有记录时撤销返回同一对象
    expect(releaseConfirmation(released, TARGET)).toBe(released);
  });

  it("确认记录按目标键隔离：一个目标的确认不覆盖另一个", () => {
    const armed = armConfirmation(emptyConfirmationStore(), binding({ target: OTHER }));
    expect(confirmationTargetKey(OTHER)).not.toBe(confirmationTargetKey(TARGET));
    expect(decideConfirmation(armed, binding({ target: OTHER }))).toEqual({ kind: "confirmed" });
    expect(decideConfirmation(armed, binding()).kind).toBe("missing");
  });
});

describe("4.4 设置快照不含凭据本身", () => {
  it("apiKey 的值不出现在指纹里（指纹会进渲染与日志风险面）", () => {
    const stamp = settingsStampOf({
      settings: { ...settings(), apiKey: "sk-secret-value" } as SettingsState,
      proxy: proxy({ hasKey: true }),
    });
    expect(stamp).not.toContain("sk-secret-value");
    expect(stamp).toContain("key");
  });
});

describe("4.5 隔离 result 的确认：与普通路径边界不同，措辞也各说各的", () => {
  const precheck = {
    parentId: "r_parent",
    stepSpanId: "s_02",
    atSpanId: "s_05",
    checkpointLabel: "第 2 轮结束检查点 ck_02",
    continueLabel: "从该轮轮末继续",
    configHash: "a".repeat(24),
  };

  it("预检在场 ⇒ 直接父 / 轮号 / 整轮检查点进事实，只读预检才算「已做的检查」", () => {
    const d = resultIsolatedDisclosure({
      toolName: "read_file",
      oldValue: "旧结果",
      newValue: "新结果",
      modelSummary: "deepseek-chat @ https://api.deepseek.com/v1",
      writesAuthorized: true,
      precheck,
    });
    const rows = disclosureLines(d)
      .map((row) => `${row.label}=${row.value}`)
      .join("\n");
    expect(rows).toContain("直接父=r_parent");
    expect(rows).toContain("本地轮号=s_02");
    expect(rows).toContain("整轮结束检查点=第 2 轮结束检查点 ck_02");
    expect(d.checks.join("\n")).toContain("runs:forkCapability");
    expect(d.limits.join("\n")).toContain("不重做");
    expect(d.limits.join("\n")).toContain("不撤销已经发生的写入");
    // 隔离路径绝不借用普通路径的措辞（场景要的是"边界不同"）
    expect(d.limits.join("\n")).not.toContain("世界不隔离");
  });

  it("没有预检结论 ⇒ 不说做过只读检查，并指出缺的是哪一项", () => {
    const d = resultIsolatedDisclosure({
      toolName: null,
      oldValue: "a",
      newValue: "b",
      modelSummary: "m",
      writesAuthorized: false,
      precheck: null,
    });
    expect(d.checks).toEqual([expect.stringContaining("本地字段检查")]);
    expect(d.checks.join("\n")).not.toContain("forkCapability");
    expect(d.facts.map((row) => row.value).join("\n")).toContain("尚未取得只读预检结论");
    expect(d.facts.map((row) => row.value).join("\n")).toContain("未勾选");
  });

  it("授权是本次事实：勾了才写「已勾选」，父 trace 的历史标注不算授权", () => {
    const granted = resultIsolatedDisclosure({
      toolName: null,
      oldValue: "a",
      newValue: "b",
      modelSummary: "m",
      writesAuthorized: true,
      precheck,
    });
    expect(granted.facts.map((row) => row.value).join("\n")).toContain("已勾选");
    expect(granted.limits.join("\n")).toContain("不从历史记录补授权");
  });
});

describe("4.4 披露只说确实做过的事", () => {
  it("纯对话创建：只有本地字段检查，并明说没有连通性预检", () => {
    const d = createDisclosure({
      mode: "chat",
      systemPrompt: "",
      userMessage: "解释一下时间旅行调试",
      modelSummary: "当前模型 deepseek-chat（https://api.deepseek.com/v1）",
      sourcePath: null,
      writesAuthorized: false,
    });
    expect(d.checks).toEqual([expect.stringContaining("本地字段检查")]);
    expect(d.limits.join("\n")).toContain("没有独立的模型连通性预检");
    // 不预告采集结果，也不写"目录检查通过"（诚实的那句"没有连通性预检"里含"连通"两字，
    // 所以这里只禁**肯定式**措辞，别把它写成裸子串）
    const all = disclosureLines(d)
      .map((row) => `${row.label}${row.value}`)
      .join("\n");
    expect(all).not.toMatch(/检查通过|已连接|校验成功/);
    expect(d.facts).toContainEqual({ label: "工具表", value: "空（纯对话不调用工具）" });
    expect(d.facts.map((row) => row.label)).not.toContain("源目录");
  });

  it("隔离创建：源目录与本次授权进事实，并明说没有采集预览接口", () => {
    const d = createDisclosure({
      mode: "isolated_files",
      systemPrompt: "简洁回答",
      userMessage: "读一下 a.txt",
      modelSummary: "当前模型 m",
      sourcePath: "D:\\lab\\src",
      writesAuthorized: true,
    });
    expect(d.facts).toContainEqual({ label: "源目录", value: "D:\\lab\\src" });
    expect(d.facts).toContainEqual({ label: "本次副本写入", value: "已勾选" });
    expect(d.limits.join("\n")).toContain("没有目录采集预览接口");
    // 采集范围只以"要到提交后才可知"的形式出现，不给数字
    expect(d.limits.join("\n")).not.toMatch(/\d+ 个文件|字节/);
  });

  it("普通 result：说明不隔离与后续工具真副作用，不借用隔离话术", () => {
    const d = resultPlainDisclosure({
      parentRunId: "r_parent",
      atSpanId: "s_03",
      toolName: "read_file",
      oldValue: "旧内容",
      newValue: "新内容",
      parentModel: "deepseek-chat",
      configModel: "deepseek-chat",
    });
    const all = [...d.facts.map((row) => row.value), ...d.limits].join("\n");
    expect(all).toContain("世界不隔离");
    expect(all).toContain("后续");
    // 隔离路径专属的"轮末检查点/不重做所选工具"不得出现在普通路径
    expect(d.limits.join("\n")).not.toContain("轮末检查点");
    expect(d.facts.map((row) => row.value).join("\n")).toContain(
      "与父 run 该步录制的模型相同（deepseek-chat）",
    );
  });

  it("模型不同 ⇒ 复用缓存/计费提示；任一未知 ⇒ 直说不推断（不把未知包装成风险）", () => {
    const different = resultPlainDisclosure({
      parentRunId: "r_p",
      atSpanId: "s_1",
      toolName: null,
      oldValue: "a",
      newValue: "b",
      parentModel: "old-model",
      configModel: "new-model",
    });
    expect(different.facts.map((row) => row.value).join("\n")).toContain("前缀缓存可能不命中");
    const unknown = resultPlainDisclosure({
      parentRunId: "r_p",
      atSpanId: "s_1",
      toolName: null,
      oldValue: "a",
      newValue: "b",
      parentModel: null,
      configModel: "m",
    });
    expect(unknown.facts.map((row) => row.value).join("\n")).toContain("不据此推断一致性");
    expect(unknown.facts.map((row) => row.value).join("\n")).not.toContain("前缀缓存");
  });
});
