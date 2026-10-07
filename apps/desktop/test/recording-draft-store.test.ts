import type { Envelope, ProxyState, WindowApi } from "@shared/ipc";
import { ok } from "@shared/ipc";
import { beforeEach, describe, expect, it } from "vitest";
import * as draftLib from "../src/renderer/src/lib/debugging-drafts";
import { emptyDraftRepo } from "../src/renderer/src/lib/debugging-drafts";
import { sessionDirtyCountOf } from "../src/renderer/src/lib/draft-list";
import { initialSession } from "../src/renderer/src/lib/operation-session";
import { emptyResultReadStore } from "../src/renderer/src/lib/result-verification";
import { installOperationChannels } from "./helpers/operation-channels";
import { proxyStateFixture } from "./helpers/proxy-state-fixture";

/**
 * U8 任务 2.2/2.3/2.5/2.6 的 **store 接线**：录制草稿写入 / CAS 放弃 / 应用收尾 / 代次守卫。
 *
 * 判据来源：design D2 + delta 场景（逐字标题）：
 * - 「录制配置跨页恢复原始输入」的仓库半边（输入无损保留）；
 * - 「录制放弃取消及修订竞争」（CAS 在 store 落地）；
 * - 「录制端口校验不接受部分整数」的零配置写调用（非法 ⇒ 连在飞标记都不出现）；
 * - 「端口占用可见」「应用失败回读也失败保留输入」（toggle 非事务 + 回读分层）；
 * - 「录制应用收尾不覆盖后来输入」（修订守卫）；
 * - 「录制未应用修改参与退出保护」（sessionDirtyCountOf 计入录制一条）。
 */

// 代理状态夹具走共享工厂（test/helpers/proxy-state-fixture.ts）：
// 本文件原先的本地字面量漏了 design D1 新增的 epoch/revision/recordsRevision，
// 且用 `as ProxyState` 把类型错误压掉了——schema 校验静默失败后
// `proxy` 被置 null，症状（草稿 baseline 撤 null、状态待读取）离病因很远。
const proxyState = (overrides: Partial<ProxyState> = {}): ProxyState =>
  proxyStateFixture({ upstreamBaseUrl: "https://api.deepseek.com", ...overrides });

const calls: string[] = [];
/** proxyStatus 桩的应答队列（空 ⇒ 恒返回「旧状态」） */
let statusQueue: Array<Envelope<ProxyState>> = [];
/** proxyToggle 桩的可控行为 */
let toggleQueue: Array<{ delay?: Promise<void>; envelope: Envelope<ProxyState> }> = [];
let toggleFail = false;

const apiStub: Record<string, unknown> = {
  proxyStatus: async (): Promise<Envelope<ProxyState>> => {
    calls.push("proxy:status");
    const next = statusQueue.shift();
    if (next !== undefined) return next;
    return ok(proxyState());
  },
  proxyToggle: async (input: unknown): Promise<Envelope<ProxyState>> => {
    calls.push(`proxy:toggle:${JSON.stringify(input)}`);
    if (toggleFail) {
      return { ok: false, error: { code: "EACCES", message: "listen EADDRINUSE 127.0.0.1:20000" } };
    }
    const queued = toggleQueue.shift();
    if (queued?.delay !== undefined) await queued.delay;
    return queued !== undefined
      ? queued.envelope
      : ok(proxyState({ enabled: true, running: true, ...(input as object) }));
  },
  listRuns: async () => ok({ runs: [], failed: [] }),
};
installOperationChannels(apiStub);

(globalThis as Record<string, unknown>).window = { api: apiStub as unknown as WindowApi };

const { useAppStore } = await import("../src/renderer/src/store");

const stateOf = () => useAppStore.getState();
const toggleCalls = () => calls.filter((c) => c.startsWith("proxy:toggle"));

beforeEach(() => {
  calls.length = 0;
  statusQueue = [];
  toggleQueue = [];
  toggleFail = false;
  useAppStore.setState({
    operations: initialSession(),
    resultReads: emptyResultReadStore(),
    drafts: emptyDraftRepo(),
    runs: [],
    failed: [],
    listLoaded: true,
    initialSelectionAttempted: true,
    error: null,
    selectedRunId: null,
    detail: null,
    navIntents: { byOperationId: {} },
    navGeneration: 0,
    view: "trace",
    proxy: null,
    proxyReadGeneration: 0,
    recordingDraft: null,
    recordingApply: null,
    recordingApplyError: null,
    recordingStatusReadFailed: false,
    settingsSection: null,
  });
});

describe("U8 2.1：进录制页 ensure 草稿（默认表单不误报）", () => {
  it("状态未读 ⇒ 默认值起点、baseline null、不 dirty；状态已读 ⇒ baseline 同源", async () => {
    useAppStore.getState().openRecordingWorkspace();
    expect(stateOf().recordingDraft?.baseline).toBeNull();
    expect(stateOf().recordingDraft?.portText).toBe("18787");

    statusQueue = [ok(proxyState({ enabled: true, port: 19000, upstreamBaseUrl: "https://x" }))];
    await stateOf().loadProxyStatus();
    // 输入原样、baseline 跟随最近可核实事实；输入偏离 baseline ⇒ dirty
    expect(stateOf().recordingDraft?.portText).toBe("18787");
    expect(stateOf().recordingDraft?.baseline?.port).toBe(19000);
    expect(stateOf().recordingDraft?.enabled).toBe(false);
    expect(stateOf().recordingDraft).not.toBeNull();
  });

  it("已有草稿重进页面原样保留（输入不被状态覆盖）", () => {
    useAppStore.getState().openRecordingWorkspace();
    stateOf().writeRecordingDraftFields({ portText: "20000abc" });
    const before = stateOf().recordingDraft;
    useAppStore.getState().openRecordingWorkspace();
    expect(stateOf().recordingDraft).toBe(before);
  });
});

describe("U8 2.2：CAS 放弃（取消零写调用；旧确认删不掉新输入）", () => {
  it("修订一致 ⇒ 恢复 baseline；修订竞争 ⇒ 拒绝且草稿原样", () => {
    useAppStore.getState().openRecordingWorkspace();
    stateOf().writeRecordingDraftFields({ portText: "20000", enabled: true });
    const draft = stateOf().recordingDraft!;
    const staleRevision = draft.revision;
    stateOf().writeRecordingDraftFields({ upstreamText: "https://changed" });
    // 旧修订确认（staleRevision）删不掉新输入
    expect(stateOf().discardRecordingDraftConfirmed(staleRevision)).toBe(false);
    expect(stateOf().recordingDraft?.upstreamText).toBe("https://changed");
    // 当前修订确认 ⇒ 恢复 baseline 值
    const current = stateOf().recordingDraft!;
    expect(stateOf().discardRecordingDraftConfirmed(current.revision)).toBe(true);
    expect(stateOf().recordingDraft?.portText).toBe("18787");
    expect(toggleCalls()).toEqual([]);
  });
});

describe("U8 2.4/2.5：应用收尾与真实状态回读", () => {
  it("非法端口 ⇒ invalid 且零 proxy:toggle 调用（纵深防御第二道也不放行）", async () => {
    useAppStore.getState().openRecordingWorkspace();
    stateOf().writeRecordingDraftFields({ portText: "18787abc" });
    expect(await stateOf().applyRecordingDraft()).toBe("invalid");
    expect(toggleCalls()).toEqual([]);
    expect(stateOf().recordingApply).toBeNull();
  });

  it("成功 ⇒ 回读后 proxy/基线按提交更新、dirty 归零、冻结解除", async () => {
    statusQueue = [ok(proxyState())]; // 进页 ensure 前的状态读取（也验证回读队列次序）
    useAppStore.setState({ proxy: proxyState() });
    useAppStore.getState().openRecordingWorkspace();
    stateOf().writeRecordingDraftFields({ enabled: true, portText: "20000" });
    // 回读取代 toggle 信封成为状态真相源
    statusQueue = [ok(proxyState({ enabled: true, running: true, port: 20000 }))];
    expect(await stateOf().applyRecordingDraft()).toBe("applied");

    expect(toggleCalls().length).toBe(1);
    expect(stateOf().recordingApply).toBeNull();
    expect(stateOf().recordingApplyError).toBeNull();
    expect(stateOf().recordingDraft?.baseline?.port).toBe(20000);
    expect(stateOf().recordingDraft?.baseline?.enabled).toBe(true);
    expect(stateOf().recordingDraft?.portText).toBe("20000");
    expect(stateOf().recordingStatusReadFailed).toBe(false);
  });

  it("「端口占用可见」：toggle 失败 + 回读成功 ⇒ 保留输入与诊断，已保存/监听事实分层可辨", async () => {
    useAppStore.setState({ proxy: proxyState() });
    useAppStore.getState().openRecordingWorkspace();
    stateOf().writeRecordingDraftFields({ enabled: true, portText: "20000" });
    toggleFail = true;
    statusQueue = [ok(proxyState({ enabled: true, running: false, port: 20000 }))];
    expect(await stateOf().applyRecordingDraft()).toBe("start-failed");

    // 输入保留（不伪回滚）；诊断在场；真实状态：已保存 enabled=true 但未监听 running=false
    expect(stateOf().recordingDraft?.portText).toBe("20000");
    expect(stateOf().recordingDraft?.enabled).toBe(true);
    expect(stateOf().recordingApplyError).toContain("EADDRINUSE");
    expect(stateOf().proxy?.enabled).toBe(true);
    expect(stateOf().proxy?.running).toBe(false);
    // baseline 已按「实际保存的意图」更新（回读事实），失败输入与之相同 ⇒ 不再 dirty
    expect(stateOf().recordingDraft?.baseline?.enabled).toBe(true);
  });

  it("「应用失败回读也失败保留输入」：两层诊断 + 状态待读取 + 只读重试不重新 toggle", async () => {
    useAppStore.setState({ proxy: proxyState() });
    useAppStore.getState().openRecordingWorkspace();
    stateOf().writeRecordingDraftFields({ enabled: true, portText: "20000" });
    toggleFail = true;
    statusQueue = [{ ok: false, error: { code: "X", message: "状态读取失败" } }];
    expect(await stateOf().applyRecordingDraft()).toBe("start-failed");

    expect(stateOf().recordingApplyError).toContain("EADDRINUSE");
    expect(stateOf().recordingStatusReadFailed).toBe(true);
    expect(stateOf().recordingDraft?.portText).toBe("20000");
    // 回读失败 ⇒ 没有可核实的当前应用值：baseline 撤到「待读取」（null），
    // 不能拿「可能已保存」的猜测充当事实；重读成功后恢复
    expect(stateOf().recordingDraft?.baseline).toBeNull();
    // 只读重试 = 再读状态，不重新 toggle
    calls.length = 0;
    statusQueue = [ok(proxyState({ enabled: true, running: true, port: 20000 }))];
    await stateOf().loadProxyStatus();
    expect(calls).toEqual(["proxy:status"]);
    expect(toggleCalls()).toEqual([]);
    expect(stateOf().recordingStatusReadFailed).toBe(false);
  });

  it("「录制应用收尾不覆盖后来输入」：在飞期间的新输入不被旧响应覆写基线", async () => {
    useAppStore.setState({ proxy: proxyState() });
    useAppStore.getState().openRecordingWorkspace();
    stateOf().writeRecordingDraftFields({ enabled: true, portText: "20000" });
    let releaseToggle!: (value: Envelope<ProxyState>) => void;
    const gate = new Promise<Envelope<ProxyState>>((resolve) => {
      releaseToggle = resolve;
    });
    toggleQueue = [
      { delay: gate, envelope: ok(proxyState({ enabled: true, running: true, port: 20000 })) },
    ];
    const applying = stateOf().applyRecordingDraft();
    // 在飞标记出现（防重复），随后用户继续输入（修订推进）
    expect(stateOf().recordingApply).not.toBeNull();
    stateOf().writeRecordingDraftFields({ upstreamText: "https://changed-later" });

    releaseToggle(ok(proxyState({ enabled: true, running: true, port: 20000 })));
    statusQueue = [ok(proxyState({ enabled: true, running: true, port: 20000 }))];
    expect(await applying).toBe("applied");

    // 旧响应不覆写后来输入：三个输入字段保持用户改后的值（回读同步 baseline 是合法的
    // 事实更新，但字段一个都不动）；提交值不进入基线判定的输入侧
    const d = stateOf().recordingDraft!;
    expect(d.upstreamText).toBe("https://changed-later");
    expect(d.portText).toBe("20000");
    expect(d.enabled).toBe(true);
    expect(stateOf().recordingApply).toBeNull();
    // dirty 仍成立：upstream 输入偏离（回读同步来的）baseline
    expect(d.upstreamText).not.toBe(d.baseline?.upstreamBaseUrl);
  });

  it("「迟到守卫」在回读失败半边也有牙：toggle 成功 + 回读失败 + 在飞后来输入 ⇒ baseline 不被旧响应抬回", async () => {
    // U8 6.3 反证补牙：回读成功路径上提交值与回读值同源（stale 守卫与回读冗余），
    // 守卫的真实行为差异在「回读失败 + 修订已推进」——旧响应不得把 baseline 从
    // 「待读取（null）」抬回提交值（design D2「响应只更新匹配的修订」）。
    useAppStore.setState({ proxy: proxyState() });
    useAppStore.getState().openRecordingWorkspace();
    stateOf().writeRecordingDraftFields({ enabled: true, portText: "20000" });
    let releaseToggle!: (value: Envelope<ProxyState>) => void;
    const gate = new Promise<Envelope<ProxyState>>((resolve) => {
      releaseToggle = resolve;
    });
    toggleQueue = [
      { delay: gate, envelope: ok(proxyState({ enabled: true, running: true, port: 20000 })) },
    ];
    const applying = stateOf().applyRecordingDraft();
    expect(stateOf().recordingApply).not.toBeNull();
    // 在飞期间继续输入（修订推进）
    stateOf().writeRecordingDraftFields({ upstreamText: "https://changed-later" });

    releaseToggle(ok(proxyState({ enabled: true, running: true, port: 20000 })));
    statusQueue = [{ ok: false, error: { code: "X", message: "状态读取失败" } }];
    expect(await applying).toBe("applied");

    // 回读失败 ⇒ baseline 撤到「待读取」；修订已推进 ⇒ 旧响应不得按提交值抬回
    expect(stateOf().recordingDraft?.baseline).toBeNull();
    expect(stateOf().recordingStatusReadFailed).toBe(true);
    // 后来输入原样保留；toggle 成功 ⇒ 无启动失败诊断；在飞标记解除
    expect(stateOf().recordingDraft?.upstreamText).toBe("https://changed-later");
    expect(stateOf().recordingApplyError).toBeNull();
    expect(stateOf().recordingApply).toBeNull();
  });

  it("在飞期间拒绝重复应用（busy）", async () => {
    useAppStore.setState({ proxy: proxyState() });
    useAppStore.getState().openRecordingWorkspace();
    let releaseToggle!: (value: Envelope<ProxyState>) => void;
    const gate = new Promise<Envelope<ProxyState>>((resolve) => {
      releaseToggle = resolve;
    });
    toggleQueue = [{ delay: gate, envelope: ok(proxyState()) }];
    const applying = stateOf().applyRecordingDraft();
    expect(await stateOf().applyRecordingDraft()).toBe("busy");
    expect(toggleCalls().length).toBe(1);
    releaseToggle(ok(proxyState()));
    await applying;
  });
});

describe("U8 2.3：录制未应用修改参与退出保护（sessionDirtyCountOf）", () => {
  it("只有录制草稿未应用 ⇒ 计一条；与其他草稿并存 ⇒ 合计；默认表单不计", () => {
    // proxy 在场 ⇒ ensure 捕获 baseline（编辑才算 dirty；未读时默认表单不误报）
    useAppStore.setState({ proxy: proxyState() });
    let drafts = draftLib.emptyDraftRepo();
    drafts = draftLib.ensureCreateRunDraft(drafts).repo;
    drafts = draftLib.writeCreateRunDraft(drafts, { userMessage: "hi" });
    useAppStore.setState({ drafts, recordingDraft: null });
    expect(sessionDirtyCountOf(stateOf().drafts, null)).toBe(1);

    useAppStore.getState().openRecordingWorkspace();
    // 默认表单（baseline 未读）不误报
    expect(sessionDirtyCountOf(stateOf().drafts, stateOf().recordingDraft)).toBe(1);

    stateOf().writeRecordingDraftFields({ portText: "20000" });
    expect(sessionDirtyCountOf(stateOf().drafts, stateOf().recordingDraft)).toBe(2);
  });
});
