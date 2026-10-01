import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as draftLib from "../src/renderer/src/lib/debugging-drafts";
import { type DraftCloseApi, DraftCloseClient } from "../src/renderer/src/lib/draft-close-client";
import { dirtyCountOf } from "../src/renderer/src/lib/draft-list";
import type { DraftCloseSessionPayload, Envelope } from "../src/shared/ipc";

/**
 * U3 任务 4.2：renderer 关闭协商客户端与 dirty 汇总。
 *
 * 判据来源：tasks.md 4.2——「renderer 订阅 dirty 汇总，查询时同步控件/model 已接收
 * 输入，锁定新编辑并应答，取消后解锁恢复焦点」。
 * 验收场景：
 * - 最新 clean 应答才允许直接关闭（renderer 侧：应答携带**应答时现取**的 dirtyCount，
 *   且必须发生在输入同步与上锁之后——顺序契约）；
 * - 退出输入锁保留已接收文字且不重放按键（renderer 侧：flush 先于锁先于应答；
 *   锁释放由 release 驱动）。
 *
 * ⚠️ 本包无 jsdom：client 为纯逻辑直测；App 接线用源码级契约断言（本文件末组）。
 */

/** 可检视的假 api：记录发出/订阅，事件手动发射 */
class FakeDraftCloseApi implements DraftCloseApi {
  handshakeResult: Envelope<DraftCloseSessionPayload> = {
    ok: true,
    data: { sessionId: "sess-1" },
  };
  readonly answers: Unknown[] = [];
  readonly reports: Unknown[] = [];
  readonly listeners = {
    session: new Set<(payload: DraftCloseSessionPayload) => void>(),
    query: new Set<(query: { sessionId: string; requestId: string }) => void>(),
    release: new Set<(release: { sessionId: string; requestId: string }) => void>(),
  };
  unsubCount = 0;

  draftCloseHandshake(): Promise<Envelope<DraftCloseSessionPayload>> {
    return Promise.resolve(this.handshakeResult);
  }
  draftCloseAnswer(answer: unknown): void {
    this.answers.push(answer);
  }
  draftCloseReport(report: unknown): void {
    this.reports.push(report);
  }
  onDraftCloseSession(listener: (payload: DraftCloseSessionPayload) => void): () => void {
    this.listeners.session.add(listener);
    return () => {
      this.listeners.session.delete(listener);
      this.unsubCount += 1;
    };
  }
  onDraftCloseQuery(
    listener: (query: { sessionId: string; requestId: string }) => void,
  ): () => void {
    this.listeners.query.add(listener);
    return () => {
      this.listeners.query.delete(listener);
      this.unsubCount += 1;
    };
  }
  onDraftCloseRelease(
    listener: (release: { sessionId: string; requestId: string }) => void,
  ): () => void {
    this.listeners.release.add(listener);
    return () => {
      this.listeners.release.delete(listener);
      this.unsubCount += 1;
    };
  }
  emitSession(sessionId: string): void {
    for (const l of this.listeners.session) l({ sessionId });
  }
  emitQuery(sessionId: string, requestId: string): void {
    for (const l of this.listeners.query) l({ sessionId, requestId });
  }
  emitRelease(sessionId: string, requestId: string): void {
    for (const l of this.listeners.release) l({ sessionId, requestId });
  }
}
type Unknown = Record<string, unknown>;

async function microtasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeClient(api: FakeDraftCloseApi, opts?: { initialDirty?: number }) {
  let dirty = opts?.initialDirty ?? 0;
  let composing = false; // 任务 4.3：输入法组合进行中
  const log: string[] = [];
  const client = new DraftCloseClient({
    api,
    getDirtyCount: () => dirty,
    flushInputs: () => {
      dirty = 5; // 模拟「锁前同步把尚未入 store 的输入收进来」
      log.push("flush");
    },
    isInputSettled: () => !composing,
    onLockChange: (locked) => {
      log.push(`lock:${String(locked)}`);
    },
  });
  return {
    client,
    log,
    setDirty: (n: number): void => {
      dirty = n;
    },
    setComposing: (v: boolean): void => {
      composing = v;
    },
  };
}

describe("U3 4.2 关闭协商客户端：握手、查询应答与输入锁", () => {
  it("握手采用会话 id；查询按「同步输入→上锁→应答」顺序发出最新 dirtyCount", async () => {
    const api = new FakeDraftCloseApi();
    const { client, log } = makeClient(api, { initialDirty: 2 });
    client.start();
    await microtasks();
    expect(client.currentSessionId).toBe("sess-1");

    api.emitQuery("sess-1", "rq-1");
    expect(log).toEqual(["flush", "lock:true"]);
    expect(client.isLocked).toBe(true);
    // 应答只此一条：flush 把 dirty 从 2 同步成 5，应答**现取** 5（不是旧值）
    expect(api.answers).toEqual([
      { sessionId: "sess-1", requestId: "rq-1", sequence: 1, dirtyCount: 5, inputSettled: true },
    ]);
  });

  it("旧会话查询被忽略（不应答、不上锁）", async () => {
    const api = new FakeDraftCloseApi();
    const { client, log } = makeClient(api);
    client.start();
    await microtasks();
    api.emitQuery("sess-old", "rq-1");
    expect(log).toEqual([]);
    expect(api.answers).toEqual([]);
    expect(client.isLocked).toBe(false);
  });

  it("release 匹配当前请求身份才解锁；旧 requestId 的释放不解锁", async () => {
    const api = new FakeDraftCloseApi();
    const { client, log } = makeClient(api);
    client.start();
    await microtasks();
    api.emitQuery("sess-1", "rq-1");
    expect(client.isLocked).toBe(true);

    // 旧/伪造 requestId 的释放不解锁
    api.emitRelease("sess-1", "rq-old");
    expect(client.isLocked).toBe(true);
    // 会话不匹配的释放同样忽略
    api.emitRelease("sess-old", "rq-1");
    expect(client.isLocked).toBe(true);

    api.emitRelease("sess-1", "rq-1");
    expect(log).toEqual(["flush", "lock:true", "lock:false"]);
    expect(client.isLocked).toBe(false);
  });

  it("会话推送轮换：序号重置，旧会话的查询不再应答", async () => {
    const api = new FakeDraftCloseApi();
    const { client } = makeClient(api);
    client.start();
    await microtasks();
    api.emitQuery("sess-1", "rq-1");
    expect(api.answers).toHaveLength(1);

    api.emitSession("sess-2");
    expect(client.currentSessionId).toBe("sess-2");
    expect(client.isLocked).toBe(false);
    api.emitQuery("sess-1", "rq-2");
    expect(api.answers).toHaveLength(1);
    // 新会话序号重新从 1 起
    api.emitQuery("sess-2", "rq-3");
    expect(api.answers[1]?.sequence).toBe(1);
  });

  it("dirtyCount 变化才上报，序号与应答共用单调流", async () => {
    const api = new FakeDraftCloseApi();
    const { client, setDirty } = makeClient(api, { initialDirty: 0 });
    client.start();
    await microtasks();

    client.reportDirtyIfChanged();
    expect(api.reports).toEqual([{ sessionId: "sess-1", sequence: 1, dirtyCount: 0 }]);
    // 值未变：不重发
    client.reportDirtyIfChanged();
    expect(api.reports).toHaveLength(1);
    // 变化：下一条序号递增
    setDirty(3);
    client.reportDirtyIfChanged();
    expect(api.reports[1]).toEqual({ sessionId: "sess-1", sequence: 2, dirtyCount: 3 });
    // 应答接在同一条流上（乱序防护由 main 按 sequence 判）
    api.emitQuery("sess-1", "rq-1");
    expect(api.answers[0]?.sequence).toBe(3);
  });

  it("stop 解绑全部订阅并解锁；重复 start 幂等不重复订阅", async () => {
    const api = new FakeDraftCloseApi();
    const { client } = makeClient(api);
    client.start();
    client.start();
    await microtasks();
    api.emitQuery("sess-1", "rq-1");
    expect(api.answers).toHaveLength(1); // 幂等 ⇒ 只应答一次

    client.stop();
    expect(client.isLocked).toBe(false);
    api.emitQuery("sess-1", "rq-2");
    expect(api.answers).toHaveLength(1); // 解绑后不再应答
    expect(api.unsubCount).toBe(3);
  });
});

describe("U3 4.2 dirtyCountOf：与草稿列表同一 dirty 口径", () => {
  it("调用类 + A/B 批次 + 创建表单的 dirty 条目计数，clean 条目不计", () => {
    let repo = draftLib.emptyDraftRepo();
    expect(dirtyCountOf(repo)).toBe(0);

    // 调用类：未编辑不计，写入后计 1
    const callKey: draftLib.CallDraftKey = {
      runId: "run_a",
      spanId: "span_1",
      field: "result",
    };
    repo = draftLib.ensureCallDraft(repo, callKey, "baseline").repo;
    expect(dirtyCountOf(repo)).toBe(0);
    repo = draftLib.writeCallDraftText(repo, callKey, "edited");
    expect(dirtyCountOf(repo)).toBe(1);

    // A/B：初始臂不计，语义变化计 1
    const abKey: draftLib.ModelAbDraftKey = { runId: "run_a", spanId: "span_1" };
    repo = draftLib.ensureModelAbDraft(repo, abKey, [
      { model: "m1", paramsText: "" },
      { model: "m2", paramsText: "" },
    ]).repo;
    expect(dirtyCountOf(repo)).toBe(1);
    repo = draftLib.setModelAbRows(repo, abKey, [
      ...draftLib.modelAbDraftOf(repo, abKey)!.rows,
      { key: draftLib.newArmRowKey(), model: "m3", paramsText: "0.7" },
    ]);
    expect(dirtyCountOf(repo)).toBe(2);

    // 创建：未编辑不计，模式修改计 1
    repo = draftLib.ensureCreateRunDraft(repo).repo;
    expect(dirtyCountOf(repo)).toBe(2);
    repo = draftLib.writeCreateRunDraft(repo, { userMessage: "任务" });
    expect(dirtyCountOf(repo)).toBe(3);
  });
});

describe("U3 4.3 输入法组合：inputSettled 判定", () => {
  it("组合进行中应答 inputSettled=false（不得冒充 clean）；无组合时为 true", async () => {
    const api = new FakeDraftCloseApi();
    const { client, setComposing } = makeClient(api);
    client.start();
    await microtasks();

    // 组合进行中：查询应答必须标 false（main 据此走 unknown 降级，不直接关闭）
    setComposing(true);
    api.emitQuery("sess-1", "rq-1");
    expect(api.answers[0]?.inputSettled).toBe(false);
    api.emitRelease("sess-1", "rq-1");

    // 组合已收尾：恢复正常 true
    setComposing(false);
    api.emitQuery("sess-1", "rq-2");
    expect(api.answers[1]?.inputSettled).toBe(true);
  });

  it("组合收尾发生在查询之后也不重发应答（main 的确认不被自动关闭）", async () => {
    const api = new FakeDraftCloseApi();
    const { client, setComposing } = makeClient(api);
    client.start();
    await microtasks();
    setComposing(true);
    api.emitQuery("sess-1", "rq-1");
    expect(api.answers).toHaveLength(1);
    // 尾随 compositionend 到达：只翻状态，不产生第二条应答
    setComposing(false);
    client.reportDirtyIfChanged();
    expect(api.answers).toHaveLength(1);
  });
});

describe("U3 4.2 App 接线契约（源码级）", () => {
  const APP = readFileSync(resolve(import.meta.dirname, "../src/renderer/src/App.tsx"), "utf8");
  const HOOK = readFileSync(
    resolve(import.meta.dirname, "../src/renderer/src/lib/use-draft-close-guard.ts"),
    "utf8",
  );

  it("App 调用 useDraftCloseGuard 并在锁定时渲染 DraftCloseLockOverlay", () => {
    expect(APP).toContain("useDraftCloseGuard()");
    expect(APP).toContain("<DraftCloseLockOverlay />");
    // 遮罩必须条件渲染（锁定才挂载），不是常驻
    expect(APP).toMatch(/draftCloseLocked \? <DraftCloseLockOverlay \/> : null/);
  });

  it("锁的键盘/剪贴板阻止走 document 捕获监听，且在解锁时恢复焦点", () => {
    // 捕获阶段（键盘/粘贴/拖放）+ 解锁还焦点，两层合起来才是完整输入锁
    expect(HOOK).toMatch(/addEventListener\(type, block,\s*options\)/);
    expect(HOOK).toContain("capture: true");
    expect(HOOK).toContain('"paste"');
    expect(HOOK).toContain("prevFocus.focus()");
    // hook 必须订阅 store 驱动 dirty 上报（不是轮询）
    expect(HOOK).toContain("useAppStore.subscribe");
    // hook 的 dirty 计数必须来自 draft-list 的同一口径函数
    // （⚠️ U8 2.3 有意改判：dirtyCountOf → sessionDirtyCountOf——录制配置草稿的未应用
    // 修改一并计入关闭协商，计数函数随之更名；口径仍是「与列表同一来源」）
    expect(HOOK).toContain("sessionDirtyCountOf");
  });

  it("任务 4.3：组合跟踪 + 尾随收尾放行（只拦可取消事件）+ isInputSettled 接线", () => {
    // document 捕获跟踪组合状态，喂给 client 的 isInputSettled
    expect(HOOK).toContain('"compositionstart"');
    expect(HOOK).toContain('"compositionend"');
    expect(HOOK).toContain("isInputSettled: () => !composingRef.current");
    // 锁内只阻止可取消事件 ⇒ 锁前组合的尾随 composition 插入不被拦（可收尾）
    expect(HOOK).toContain("if (!event.cancelable) return;");
    // client 侧：应答的 inputSettled 必须来自依赖注入，不得硬编码 true
    const CLIENT_SRC = readFileSync(
      resolve(import.meta.dirname, "../src/renderer/src/lib/draft-close-client.ts"),
      "utf8",
    );
    expect(CLIENT_SRC).toContain("inputSettled: this.deps.isInputSettled()");
    expect(CLIENT_SRC).not.toContain("inputSettled: true");
  });
});
