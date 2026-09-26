import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CloseConfirmFacts,
  DRAFT_CLOSE_QUERY_TIMEOUT_MS,
  DraftCloseFlow,
  type DraftCloseFlowDeps,
  type DraftCloseFlowPorts,
  type MainCloseFacts,
  buildCloseConfirmText,
  evaluateCloseAnswer,
  evaluateCloseOutcome,
} from "../src/main/draft-close-flow";
import { DraftCloseGuard, type DraftCloseSender } from "../src/main/draft-close-guard";
import { OperationRegistry } from "../src/main/operation-registry";
import type { DraftCloseAnswer, DraftCloseQuery } from "../src/shared/ipc";
import type { OperationKind, OperationTarget } from "../src/shared/operations";

/**
 * U3 任务 4.4：main 关闭决策流。
 *
 * 判据来源：tasks.md 4.4——「main 窗口 close/app.quit 接新鲜查询、原生确认、
 * 正常取消与单次放行，明确不接入阻止系统结束会话的路径」。
 * 验收场景：
 * - 有草稿时关闭可返回或明确退出（dirty 确认，默认返回）；
 * - 最新 clean 应答才允许直接关闭（干净路径经新鲜查询放行并单次 bypass）；
 * - 系统会话结束不沿用普通退出承诺（装配层不注册任何 session-end 拦截——
 *   源码契约断言在文件末组）。
 *
 * U4 任务 5.1/5.2 追加：clean 判定联合 main 活跃槽与配置变更标记；closing 标记
 * 在协商开始时置位、返回时解除；草稿/活跃操作/配置变更合并成**一次**确认文案。
 *
 * 纯逻辑直测：guard 用真实现，原生确认/关窗/发消息为注入端口。
 */

const WC = 1;
const FRAME = 100;

const IDLE_MAIN: MainCloseFacts = { activeOperationId: null, configurationBusy: false };

function sender(over?: Partial<DraftCloseSender>): DraftCloseSender {
  return { webContentsId: WC, frameRoutingId: FRAME, ...over };
}

/** 合并确认的构成事实（默认 main 空闲）——用例只写差异项 */
function facts(
  draft: CloseConfirmFacts["draft"],
  over: Partial<CloseConfirmFacts> = {},
): CloseConfirmFacts {
  return { draft, activeOperation: false, configurationBusy: false, ...over };
}

const EPOCH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";
const ID_D = "44444444-4444-4444-8444-444444444444";

/** registry 的槽状态 → flow 的 main 事实端口（装配层同一形状） */
function slotFacts(registry: OperationRegistry): MainCloseFacts {
  const slot = registry.slotState();
  return {
    activeOperationId: slot.activeOperationId,
    configurationBusy: slot.configurationBusy,
  };
}

/** 真登记一条 running（占住执行槽），返回其 operationId */
function acceptRunning(
  registry: OperationRegistry,
  operationId: string,
  kind: OperationKind = "create",
): string {
  const target: OperationTarget =
    kind === "result"
      ? { kind, mode: "plain", parentRunId: "p", atSpanId: "s_1", editField: "result" }
      : kind === "prompt"
        ? { kind, parentRunId: "p", editField: "system_prompt" }
        : { kind: "create", mode: "plain" };
  const accept = registry.tryAccept({ operationId, target, fingerprint: `fp-${operationId}` });
  expect(accept.kind).toBe("accepted");
  return operationId;
}

interface Harness {
  flow: DraftCloseFlow;
  guard: DraftCloseGuard;
  queries: DraftCloseQuery[];
  confirms: CloseConfirmFacts[];
  releases: Array<{ sessionId: string; requestId: string }>;
  /** closing 端口的调用序列（U4 5.1：置位/解除的时机是可观测事实） */
  closingLog: boolean[];
  /** 端口调用顺序（U4 5.1 的「closing → 查询 → 应答 → 读槽」契约判据） */
  events: string[];
  closeCalls: number;
  setHandshaken: (v: boolean) => void;
  confirmChoice: "return" | "quit";
  /** main 侧事实（U4 5.1）：读槽时点返回的活跃操作与配置变更标记 */
  main: MainCloseFacts;
  /** 确认端口抛错（U4 5.4 异常清理） */
  confirmThrows: boolean;
  sessionId: string;
}

/** 端口覆盖：只替换 closing/读槽两条真实接线（其余端口由 harness 记账桩提供） */
type PortOverrides = Pick<Partial<DraftCloseFlowPorts>, "setClosing" | "readMainFacts">;

function setup(opts?: {
  confirmChoice?: "return" | "quit";
  hasPendingLoss?: () => boolean;
  scheduleTimeout?: DraftCloseFlowDeps["scheduleTimeout"];
  main?: MainCloseFacts;
  ports?: PortOverrides;
}): Harness {
  // flow 在 guard 之后创建；guard 的应答转发经此 ref（与装配层同接线）
  let flowRef: DraftCloseFlow | null = null;
  const guard = new DraftCloseGuard({
    newSessionId: () => "sess-main",
    onAnswerAccepted: (_webContentsId, answer) => {
      flowRef?.notifyAnswer(answer);
    },
  });
  guard.rotateSession({ webContentsId: WC, getMainFrameRoutingId: (): number => FRAME });
  const h: Harness = {
    guard,
    queries: [],
    confirms: [],
    releases: [],
    closingLog: [],
    events: [],
    closeCalls: 0,
    setHandshaken: (v: boolean): void => {
      const target = guard.targetOf(WC);
      if (target !== undefined) target.handshaken = v;
    },
    confirmChoice: opts?.confirmChoice ?? "return",
    main: opts?.main ?? { ...IDLE_MAIN },
    confirmThrows: false,
    sessionId: "sess-main",
    flow: null as unknown as DraftCloseFlow,
  };
  const overrides: PortOverrides = opts?.ports ?? {};
  const ports: DraftCloseFlowPorts = {
    sendQuery: (query) => {
      h.queries.push(query);
      h.events.push("query");
    },
    showConfirm: async (confirmFacts) => {
      if (h.confirmThrows) throw new Error("确认端口异常");
      h.confirms.push(confirmFacts);
      h.events.push("confirm");
      return h.confirmChoice;
    },
    closeWindow: () => {
      h.closeCalls += 1;
      h.events.push("close");
    },
    sendRelease: (sessionId, requestId) => {
      h.releases.push({ sessionId, requestId });
    },
    setClosing: (closing) => {
      h.closingLog.push(closing);
      h.events.push(`closing:${closing}`);
      overrides.setClosing?.(closing);
    },
    readMainFacts: () => {
      h.events.push("readFacts");
      return overrides.readMainFacts?.() ?? h.main;
    },
  };
  h.flow = new DraftCloseFlow(WC, guard, ports, {
    hasPendingLoss: opts?.hasPendingLoss ?? ((): boolean => guard.hasPendingLoss()),
    scheduleTimeout: opts?.scheduleTimeout,
  });
  flowRef = h.flow;
  return h;
}

/** 让 guard 接受一条应答并转发给 flow（走完整协议校验） */
function answerThrough(h: Harness, over?: Partial<DraftCloseAnswer>): void {
  const query = h.queries[h.queries.length - 1];
  if (query === undefined) throw new Error("no query sent");
  const payload: DraftCloseAnswer = {
    sessionId: query.sessionId,
    requestId: query.requestId,
    sequence: h.queries.length,
    dirtyCount: 0,
    inputSettled: true,
    ...over,
  };
  const result = h.guard.handleAnswer(sender(), payload);
  expect(result.ok).toBe(true);
}

describe("U3 4.4 evaluateCloseAnswer：clean/dirty/unknown 判定", () => {
  const base = { sessionId: "s", requestId: "r", sequence: 1, dirtyCount: 0, inputSettled: true };
  it("无应答/未握手/inputSettled=false/会话丢失 ⇒ unknown；dirty>0 ⇒ dirty；其余 clean", () => {
    expect(evaluateCloseAnswer(undefined, { handshaken: true })).toBe("unknown");
    expect(evaluateCloseAnswer(base, { handshaken: false })).toBe("unknown");
    expect(evaluateCloseAnswer({ ...base, inputSettled: false }, { handshaken: true })).toBe(
      "unknown",
    );
    expect(evaluateCloseAnswer(base, { handshaken: true, hasPendingLoss: () => true })).toBe(
      "unknown",
    );
    expect(evaluateCloseAnswer({ ...base, dirtyCount: 2 }, { handshaken: true })).toBe("dirty");
    expect(evaluateCloseAnswer(base, { handshaken: true })).toBe("clean");
  });
});

describe("U4 5.1 evaluateCloseOutcome：clean 判定联合 main 活跃槽与配置变更", () => {
  it("clean + 槽空闲 + 无配置变更 ⇒ 才允许直接关闭", () => {
    expect(evaluateCloseOutcome("clean", IDLE_MAIN)).toEqual({ kind: "close" });
  });
  it("clean 但有活跃操作 ⇒ 合并确认（draft=null 表示草稿侧已知 clean，不冒充有草稿）", () => {
    expect(
      evaluateCloseOutcome("clean", { activeOperationId: "op-1", configurationBusy: false }),
    ).toEqual({ kind: "confirm", facts: facts(null, { activeOperation: true }) });
  });
  it("clean 但配置变更中 ⇒ 按状态待定合入确认，不冒充主动 run", () => {
    expect(
      evaluateCloseOutcome("clean", { activeOperationId: null, configurationBusy: true }),
    ).toEqual({ kind: "confirm", facts: facts(null, { configurationBusy: true }) });
  });
  it("dirty/unknown 与活跃操作并存 ⇒ 一次确认同时带两类事实", () => {
    const main = { activeOperationId: "op-2", configurationBusy: true };
    expect(evaluateCloseOutcome("dirty", main)).toEqual({
      kind: "confirm",
      facts: facts("dirty", { activeOperation: true, configurationBusy: true }),
    });
    expect(evaluateCloseOutcome("unknown", main)).toEqual({
      kind: "confirm",
      facts: facts("unknown", { activeOperation: true, configurationBusy: true }),
    });
  });
});

describe("U4 5.2 buildCloseConfirmText：合并成一次文案", () => {
  it("dirty + 活跃操作 ⇒ message 同时点出两类事实，detail 含「不会取消上游请求」且不称已取消", () => {
    const text = buildCloseConfirmText(facts("dirty", { activeOperation: true }), false);
    expect(text.message).toBe("有未放弃的调试草稿，且有操作正在执行");
    expect(text.detail).toContain("主动操作尚未结束");
    expect(text.detail).toContain("不会取消上游请求");
    expect(text.quitLabel).toBe("退出并丢弃草稿");
  });
  it("只有活跃操作（草稿已知 clean）⇒ 不出现草稿丢失措辞，退出按钮不写「丢弃草稿」", () => {
    const text = buildCloseConfirmText(facts(null, { activeOperation: true }), false);
    expect(text.message).toBe("有操作正在执行");
    expect(text.detail).toContain("主动操作尚未结束");
    expect(text.detail).not.toContain("调试草稿在退出后将丢失");
    expect(text.quitLabel).toBe("退出");
  });
  it("配置变更中 ⇒ 按「配置变更尚未完成」呈现，不写成主动操作在跑", () => {
    const text = buildCloseConfirmText(facts(null, { configurationBusy: true }), false);
    expect(text.message).toBe("有一次配置变更尚未完成");
    expect(text.detail).not.toContain("主动操作尚未结束");
  });
  it("unknown + 会话丢失遗留 ⇒ 两段说明合并进同一次确认", () => {
    const text = buildCloseConfirmText(facts("unknown"), true);
    expect(text.message).toBe("暂时无法确认草稿状态");
    expect(text.detail).toContain("先前会话的调试草稿可能已经丢失");
  });
  it("unknown 档只说「暂时无法确认」，不断言 renderer 存活状态", () => {
    for (const active of [false, true]) {
      const text = buildCloseConfirmText(facts("unknown", { activeOperation: active }), false);
      expect(text.detail).toContain("暂时无法确认草稿状态");
      expect(text.message + text.detail).not.toMatch(/崩溃|失联|无响应|已死/);
    }
  });
});

describe("U3 4.4 决策流：新鲜查询 / 原生确认 / 单次放行", () => {
  it("clean：发新鲜查询 → 有效 clean 应答 → 放行关闭（bypass 恰好消费一次）", async () => {
    const h = setup();
    h.setHandshaken(true);
    // 模拟窗口 close 事件：无 bypass ⇒ 拦截并启动协商
    expect(h.flow.interceptClose()).toBe(false);
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0]?.sessionId).toBe("sess-main");

    answerThrough(h, { dirtyCount: 0, inputSettled: true });
    const outcome = await h.flow.requestClose();
    expect(outcome).toBe("closed");
    expect(h.closeCalls).toBe(1);
    expect(h.confirms).toEqual([]); // clean 不弹确认
    // bypass 一次性：下一个 close 事件放行，再下一个恢复正常拦截
    expect(h.flow.interceptClose()).toBe(true);
    expect(h.flow.interceptClose()).toBe(false);
    expect(h.closeCalls).toBe(1); // 放行路径不再 closeWindow
  });

  it("dirty：有草稿时弹「有草稿」确认且默认返回；返回则取消并通知 renderer 解锁，迟到应答不关窗", async () => {
    const h = setup({ confirmChoice: "return" });
    h.setHandshaken(true);
    h.flow.interceptClose();
    answerThrough(h, { dirtyCount: 3 });
    const outcome = await h.flow.requestClose();
    expect(outcome).toBe("canceled");
    expect(h.confirms).toEqual([facts("dirty")]);
    expect(h.closeCalls).toBe(0);
    // 解锁通知携带查询身份，renderer 据此解锁
    expect(h.releases).toEqual([
      { sessionId: "sess-main", requestId: h.queries[0]?.requestId ?? "" },
    ]);
    // 迟到应答：挂起查询已清除 ⇒ guard 拒绝 ⇒ 决策流不再被唤醒、窗口不关
    const late = h.guard.handleAnswer(sender(), {
      sessionId: "sess-main",
      requestId: h.queries[0]?.requestId ?? "",
      sequence: 9,
      dirtyCount: 0,
      inputSettled: true,
    });
    expect(late.ok).toBe(false);
    expect(h.closeCalls).toBe(0);
  });

  it("dirty + 明确退出：一次性放行重新触发正常关闭", async () => {
    const h = setup({ confirmChoice: "quit" });
    h.setHandshaken(true);
    h.flow.interceptClose();
    answerThrough(h, { dirtyCount: 1 });
    const outcome = await h.flow.requestClose();
    expect(outcome).toBe("closed");
    expect(h.confirms).toEqual([facts("dirty")]);
    expect(h.closeCalls).toBe(1);
    // bypass 已 armed：真实 close 事件放行（窗口随后销毁，不二次协商）
    expect(h.flow.interceptClose()).toBe(true);
  });

  it("inputSettled=false ⇒ unknown 确认；目标缺失（窗口已销毁）⇒ 同样 unknown 不静默放行", async () => {
    // 输入未收尾：应答有效送达但不能当 clean（D6 第 4 步）
    const h = setup({ confirmChoice: "return" });
    h.setHandshaken(true);
    h.flow.interceptClose();
    answerThrough(h, { dirtyCount: 0, inputSettled: false });
    const outcome = await h.flow.requestClose();
    expect(outcome).toBe("canceled");
    expect(h.confirms).toEqual([facts("unknown")]);
    expect(h.closeCalls).toBe(0);
    expect(h.releases).toHaveLength(1);

    // 目标已销毁：beginQuery 返回 null，无可核对对象 ⇒ 保守 unknown，不静默放行
    const h2 = setup({ confirmChoice: "return" });
    h2.setHandshaken(true);
    h2.guard.detach(WC);
    const outcome2 = await h2.flow.requestClose();
    expect(outcome2).toBe("canceled");
    expect(h2.confirms).toEqual([facts("unknown")]);
    expect(h2.queries).toHaveLength(0);
    expect(h2.closeCalls).toBe(0);
  });

  it("会话丢失遗留标志把 clean 降级为 unknown（4.7 前置判定）", async () => {
    const h = setup({ confirmChoice: "return", hasPendingLoss: () => true });
    h.setHandshaken(true);
    h.flow.interceptClose();
    answerThrough(h, { dirtyCount: 0, inputSettled: true });
    const outcome = await h.flow.requestClose();
    expect(outcome).toBe("canceled");
    expect(h.confirms).toEqual([facts("unknown")]);
  });

  it("进行中再次触发复用同一流程（不叠加查询、不重入确认）", async () => {
    const h = setup({ confirmChoice: "return" });
    h.setHandshaken(true);
    h.flow.interceptClose();
    const first = h.flow.requestClose();
    const second = h.flow.requestClose();
    expect(first).toBe(second);
    h.flow.interceptClose(); // 连续点击关闭：复用当前流程（仍是被拦截状态）
    answerThrough(h, { dirtyCount: 2 });
    const outcome = await first;
    expect(outcome).toBe("canceled");
    expect(h.queries).toHaveLength(1); // 只发过一次查询
    expect(h.confirms).toEqual([facts("dirty")]); // 只弹过一次确认
  });
});

describe("U3 4.4 源码契约：不接入系统会话结束路径", () => {
  it("装配层与入口不注册 query-session-end/session-end 拦截（系统结束会话不承诺确认）", () => {
    // 判据：design D6「U3 不接入阻止系统结束会话的异步查询/原生确认」——
    // 源码中不出现对系统会话结束事件的任何监听
    const attach = readFileSync(
      resolve(import.meta.dirname, "../src/main/draft-close-attach.ts"),
      "utf8",
    );
    const index = readFileSync(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");
    for (const src of [attach, index]) {
      expect(src).not.toContain("query-session-end");
      expect(src).not.toContain("session-end");
      expect(src).not.toContain('on("session');
    }
  });
});

describe("U3 4.5 有界查询与超时降级", () => {
  interface TimerRec {
    fn: () => void;
    ms: number;
    canceled: boolean;
  }

  /** 假时钟 harness：定时器不自动触发，由测试手动推进；返回原对象（闭包同一引用） */
  function setupWithTimer(opts?: { confirmChoice?: "return" | "quit" }): {
    h: Harness;
    timers: TimerRec[];
  } {
    const timers: TimerRec[] = [];
    const h = setup({
      ...opts,
      scheduleTimeout: (fn: () => void, ms: number): (() => void) => {
        const rec: TimerRec = { fn, ms, canceled: false };
        timers.push(rec);
        return () => {
          rec.canceled = true;
        };
      },
    });
    return { h, timers };
  }

  it("超时常量为 1.5s（设计初值，非慢机校准）", () => {
    expect(DRAFT_CLOSE_QUERY_TIMEOUT_MS).toBe(1500);
  });

  it("1.5s 内无应答 ⇒ unknown 确认（不诊断存活）；迟到应答被拒且不关窗", async () => {
    const { h, timers } = setupWithTimer();
    h.setHandshaken(true);
    h.flow.interceptClose();
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(1500);

    // 超时触发：走 unknown 降级
    timers[0]?.fn();
    const outcome = await h.flow.requestClose();
    expect(outcome).toBe("canceled");
    expect(h.confirms).toEqual([facts("unknown")]);
    expect(h.closeCalls).toBe(0);
    expect(h.releases).toHaveLength(1); // 通知 renderer 解锁（锁持续到关闭决定）
    // 超时必须清掉 guard 层的挂起查询（否则迟到应答能再次通过协议校验）
    expect(h.guard.pendingQueryOf(WC)).toBeUndefined();

    // 迟到应答：挂起查询已在超时时清除 ⇒ guard 拒绝 ⇒ 不关窗
    const late = h.guard.handleAnswer(sender(), {
      sessionId: "sess-main",
      requestId: h.queries[0]?.requestId ?? "",
      sequence: 1,
      dirtyCount: 0,
      inputSettled: true,
    });
    expect(late.ok).toBe(false);
    expect(h.closeCalls).toBe(0);
  });

  it("应答先于超时到达 ⇒ 正常决策且定时器被取消", async () => {
    const { h, timers } = setupWithTimer();
    h.setHandshaken(true);
    h.flow.interceptClose();
    answerThrough(h, { dirtyCount: 0, inputSettled: true });
    const outcome = await h.flow.requestClose();
    expect(outcome).toBe("closed");
    expect(timers[0]?.canceled).toBe(true);
    expect(h.confirms).toEqual([]);
    expect(h.closeCalls).toBe(1);
  });

  it("慢响应降级后可取消并重新核对：下次查询正常完成", async () => {
    const { h, timers } = setupWithTimer();
    h.setHandshaken(true);

    // 第一轮：超时降级，用户取消（默认返回）
    h.flow.interceptClose();
    timers[0]?.fn();
    expect(await h.flow.requestClose()).toBe("canceled");
    expect(h.confirms).toEqual([facts("unknown")]);

    // 第二轮（用户再次关闭，明确退出）：新鲜查询正常应答，流程完整走通
    h.confirmChoice = "quit";
    h.flow.interceptClose();
    answerThrough(h, { dirtyCount: 1, sequence: 5 });
    expect(await h.flow.requestClose()).toBe("closed");
    expect(h.queries).toHaveLength(2); // 两次独立的新鲜查询
    expect(h.confirms).toEqual([facts("unknown"), facts("dirty")]); // 第二轮按真实 dirty 确认
    expect(h.closeCalls).toBe(1);
  });

  it("unknown 文案只说明暂时无法确认，不断言崩溃/失联（行为判据）", () => {
    const text = buildCloseConfirmText(facts("unknown"), false);
    expect(text.message).toContain("暂时无法确认草稿状态");
    // 不做存活诊断：文案不得断言崩溃/失联/无响应
    expect(`${text.message}${text.detail}`).not.toMatch(/崩溃|失联|无响应/);
  });
});

describe("U3 4.6 防重入 / bypass 生命周期 / 递归 quit", () => {
  it("busy 贯穿协商与确认，结束后回到空闲", async () => {
    const h = setup();
    expect(h.flow.busy).toBe(false);
    h.setHandshaken(true);
    h.flow.interceptClose();
    expect(h.flow.busy).toBe(true);
    answerThrough(h, { dirtyCount: 1 });
    await h.flow.requestClose();
    expect(h.flow.busy).toBe(false);
  });

  it("取消后旧 requestId 应答被拒；新关闭用新 requestId 重新核对", async () => {
    const h = setup({ confirmChoice: "return" });
    h.setHandshaken(true);

    // 第一轮：dirty → 用户返回 → 取消
    h.flow.interceptClose();
    const firstRequestId = h.queries[0]?.requestId ?? "";
    answerThrough(h, { dirtyCount: 2 });
    expect(await h.flow.requestClose()).toBe("canceled");

    // 旧 requestId 的迟到应答被 guard 拒绝（不会唤醒任何流程）
    expect(
      h.guard.handleAnswer(sender(), {
        sessionId: "sess-main",
        requestId: firstRequestId,
        sequence: 50,
        dirtyCount: 0,
        inputSettled: true,
      }).ok,
    ).toBe(false);

    // 第二轮：新关闭 = 新鲜查询（requestId 换新），正常走完
    h.flow.interceptClose();
    const secondRequestId = h.queries[1]?.requestId ?? "";
    expect(secondRequestId).not.toBe(firstRequestId);
    answerThrough(h, { dirtyCount: 0, sequence: 60 });
    expect(await h.flow.requestClose()).toBe("closed");
    // 放行路径的释放通知必须携带**本轮**的 requestId（陈旧身份即泄漏）
    expect(h.releases).toHaveLength(2);
    expect(h.releases[1]?.requestId).toBe(secondRequestId);
  });

  it("确认退出的 bypass 只消费一次：泄漏到下一次关闭 = 重新协商（不静默放行）", async () => {
    const h = setup({ confirmChoice: "quit" });
    h.setHandshaken(true);

    h.flow.interceptClose();
    answerThrough(h, { dirtyCount: 1 });
    expect(await h.flow.requestClose()).toBe("closed");
    expect(h.flow.interceptClose()).toBe(true); // 本次确认退出的 bypass

    // bypass 已消费：下一次关闭必须重新协商（后续会话不复用放行标记）
    h.confirmChoice = "return";
    expect(h.flow.interceptClose()).toBe(false);
    expect(h.flow.busy).toBe(true);
    expect(h.queries).toHaveLength(2); // 新的新鲜查询已发出
    expect(h.closeCalls).toBe(1); // 上一轮的关窗调用，未被重复
  });

  it("源码契约：before-quit 复用 flow.requestClose，不直接退出/不自行操作 bypass", () => {
    const index = readFileSync(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");
    // quit 路径必须经决策流（同一 guard），不得 app.exit 绕过其他窗口的核对
    expect(index).toContain("handle.flow.requestClose()");
    expect(index).not.toContain("app.exit(");
    expect(index).not.toContain("bypassArmed");
    expect(index).not.toContain("armBypass");
  });
});

describe("U3 4.7 决策流 × 遗留标志：重载后空草稿不能直接放行", () => {
  it("遗留标志把 clean 降级为 unknown；用户返回确认后，下次关闭恢复正常核对", async () => {
    const h = setup();
    h.setHandshaken(true);

    // 旧会话 dirty 后重载（rotateSession 评估旧状态 → 置标志）
    const target = h.guard.targetOf(WC);
    if (target !== undefined) target.lastReported = { sequence: 9, dirtyCount: 2 };
    h.guard.rotateSession({ webContentsId: WC, getMainFrameRoutingId: (): number => FRAME });
    expect(h.guard.hasPendingLoss()).toBe(true);
    h.setHandshaken(true);

    // 新会话上报 clean（空仓库）+ 关闭查询得到 clean 应答 ⇒ 仍 unknown（标志不消失）
    h.flow.interceptClose();
    answerThrough(h, { dirtyCount: 0, sequence: 1 });
    const outcome = await h.flow.requestClose();
    expect(outcome).toBe("canceled");
    expect(h.confirms).toEqual([facts("unknown")]);

    // 用户返回 = 已知悉 ⇒ 标志清除；下次关闭 clean 应答直接放行
    expect(h.guard.hasPendingLoss()).toBe(false);
    h.flow.interceptClose();
    answerThrough(h, { dirtyCount: 0, sequence: 5 });
    expect(await h.flow.requestClose()).toBe("closed");
    expect(h.confirms).toEqual([facts("unknown")]); // 第二轮没有再弹确认
  });
});

describe("U4 5.1 决策流 × 操作登记：closing 与活跃槽", () => {
  /**
   * 用**真 registry** 接两条端口（与装配层同一接线）：
   * closing 标记与活跃槽必须是同一个真相源，否则「协商期间拒绝新提交」只是断言。
   */
  function setupWithRegistry(opts?: { confirmChoice?: "return" | "quit" }): {
    h: Harness;
    registry: OperationRegistry;
  } {
    const registry = new OperationRegistry({ newEpoch: () => EPOCH });
    const h = setup({
      ...opts,
      ports: {
        setClosing: (closing): void => registry.setClosing(closing),
        readMainFacts: (): MainCloseFacts => slotFacts(registry),
      },
    });
    return { h, registry };
  }

  it("协商一开始就置 closing：询问期间新主动请求在副作用前被拒（不漏保护）", async () => {
    const { h, registry } = setupWithRegistry();
    h.setHandshaken(true);
    expect(registry.isAccepting()).toEqual({ accepting: true });

    h.flow.interceptClose();
    // 查询已发出、尚未应答——此刻正是「询问期间」
    expect(registry.isAccepting()).toEqual({ accepting: false, reason: "closing" });
    expect(registry.canChangeConfiguration()).toEqual({ ok: false, reason: "closing" });

    answerThrough(h, { dirtyCount: 1 });
    expect(await h.flow.requestClose()).toBe("canceled");
    // 用户返回 ⇒ closing 解除，提交重新开放（以当前 main 槽为准）
    expect(registry.isAccepting()).toEqual({ accepting: true });
  });

  it("询问期间到达的新提交：被拒并留下 notAccepted 封禁，返回后也不自动执行", async () => {
    const { h, registry } = setupWithRegistry();
    h.setHandshaken(true);
    h.flow.interceptClose();
    const lateId = "88888888-8888-4888-8888-888888888888";
    const result = registry.tryAccept({
      operationId: lateId,
      target: { kind: "create", mode: "plain" },
      fingerprint: "fp-late",
    });
    expect(result.kind).toBe("not-accepted");
    answerThrough(h, { dirtyCount: 1 });
    expect(await h.flow.requestClose()).toBe("canceled");
    // 返回后重新开放提交，但那次迟到的提交仍是封禁态（永不复活、也不会补执行）
    expect(registry.isAccepting()).toEqual({ accepting: true });
    expect(registry.recordOf(lateId)?.state).toBe("notAccepted");
    expect(registry.hasInFlightExecution(lateId)).toBe(false);
  });

  it("renderer 报 clean 但 main 仍占槽 ⇒ 不直接关闭，弹一次活跃操作确认", async () => {
    const { h, registry } = setupWithRegistry();
    h.setHandshaken(true);
    // 先有一个 running 占槽（真实登记，不是测试夹具的标志位）
    const runningId = acceptRunning(registry, ID_A);

    h.flow.interceptClose();
    answerThrough(h, { dirtyCount: 0, inputSettled: true });
    expect(await h.flow.requestClose()).toBe("canceled");
    expect(h.confirms).toEqual([facts(null, { activeOperation: true })]);
    expect(h.closeCalls).toBe(0);
    // 返回只解除 closing：**不释放执行槽、不删登记**
    expect(registry.isAccepting()).toEqual({ accepting: false, reason: "busy" });
    expect(registry.recordOf(runningId)?.state).toBe("running");
  });

  it("返回不释放槽；操作随后 settled 也不会自动关窗（已显示确认不被推翻）", async () => {
    const { h, registry } = setupWithRegistry();
    h.setHandshaken(true);
    const runningId = acceptRunning(registry, ID_B, "result");

    h.flow.interceptClose();
    answerThrough(h, { dirtyCount: 0 });
    expect(await h.flow.requestClose()).toBe("canceled");
    expect(h.confirms).toHaveLength(1);

    // 询问之后操作才结束：终态更新 main 事实，但不自行关闭窗口
    registry.settle({ operationId: runningId, requestOutcome: "returned" });
    expect(h.closeCalls).toBe(0);
    expect(h.confirms).toHaveLength(1);
    // 槽已释放 ⇒ 下一次关闭可正常放行
    h.flow.interceptClose();
    answerThrough(h, { dirtyCount: 0, sequence: 7 });
    expect(await h.flow.requestClose()).toBe("closed");
  });

  it("明确退出不伪造取消：登记保持 running、槽不释放，flow 只放行窗口", async () => {
    const { h, registry } = setupWithRegistry({ confirmChoice: "quit" });
    h.setHandshaken(true);
    const runningId = acceptRunning(registry, ID_C, "prompt");

    h.flow.interceptClose();
    answerThrough(h, { dirtyCount: 2 });
    expect(await h.flow.requestClose()).toBe("closed");
    expect(h.closeCalls).toBe(1);
    expect(registry.recordOf(runningId)?.state).toBe("running");
    expect(registry.activeId).toBe(runningId);
  });

  it("窗口销毁 ⇒ closing 解除（一次已结束的协商不得永久封住主动执行与配置变更）", async () => {
    const { h, registry } = setupWithRegistry({ confirmChoice: "quit" });
    h.setHandshaken(true);
    h.flow.interceptClose();
    answerThrough(h, { dirtyCount: 1 });
    expect(await h.flow.requestClose()).toBe("closed");
    // 确认退出路径保持 closing（进程正在结束）
    expect(registry.slotState().closing).toBe(true);
    h.flow.onWindowClosed();
    expect(registry.slotState().closing).toBe(false);
    expect(registry.isAccepting()).toEqual({ accepting: true });
    expect(registry.canChangeConfiguration()).toEqual({ ok: true });
  });

  it("顺序契约：置 closing 早于查询，读活跃槽晚于应答（先读槽会漏掉询问期间刚提交的那一次）", async () => {
    const h = setup();
    h.setHandshaken(true);
    h.flow.interceptClose();
    // 「询问期间刚提交的那一次」：查询已发出、应答未到，槽此刻才被占用
    h.main = { activeOperationId: "late-op", configurationBusy: false };
    answerThrough(h, { dirtyCount: 0 });
    expect(await h.flow.requestClose()).toBe("canceled");

    expect(h.events).toEqual(["closing:true", "query", "readFacts", "confirm", "closing:false"]);
    expect(h.confirms).toEqual([facts(null, { activeOperation: true })]);
  });

  it("配置变更中：clean + configurationBusy ⇒ 合入确认，不冒充主动 run", async () => {
    const h = setup({ main: { activeOperationId: null, configurationBusy: true } });
    h.setHandshaken(true);
    h.flow.interceptClose();
    answerThrough(h, { dirtyCount: 0 });
    expect(await h.flow.requestClose()).toBe("canceled");
    expect(h.confirms).toEqual([facts(null, { configurationBusy: true })]);
  });

  it("重载后新会话报 clean，main 仍有活跃操作 ⇒ 不因重载消失（合并确认）", async () => {
    const registry = new OperationRegistry({ newEpoch: () => EPOCH });
    const runningId = acceptRunning(registry, ID_D);
    const h = setup({
      ports: {
        setClosing: (closing): void => registry.setClosing(closing),
        readMainFacts: (): MainCloseFacts => slotFacts(registry),
      },
    });
    // 旧会话 dirty ⇒ 重载评估置遗留标志 ⇒ unknown；叠加活跃操作 ⇒ 一次确认含两类事实
    const target = h.guard.targetOf(WC);
    if (target !== undefined) target.lastReported = { sequence: 3, dirtyCount: 1 };
    h.guard.rotateSession({ webContentsId: WC, getMainFrameRoutingId: (): number => FRAME });
    h.setHandshaken(true);
    h.flow.interceptClose();
    answerThrough(h, { dirtyCount: 0, sequence: 1 });
    expect(await h.flow.requestClose()).toBe("canceled");
    expect(h.confirms).toEqual([facts("unknown", { activeOperation: true })]);
    expect(registry.recordOf(runningId)?.state).toBe("running");
  });

  it("连续关闭共享同一协商：closing 只置一次、查询只发一次、确认只弹一次（不重入）", async () => {
    const { h, registry } = setupWithRegistry();
    h.setHandshaken(true);
    h.flow.interceptClose();
    h.flow.interceptClose();
    h.flow.interceptClose();
    expect(h.queries).toHaveLength(1);
    expect(h.closingLog).toEqual([true]);
    expect(registry.slotState().closing).toBe(true);

    answerThrough(h, { dirtyCount: 2 });
    expect(await h.flow.requestClose()).toBe("canceled");
    expect(h.confirms).toHaveLength(1);
    expect(h.closingLog).toEqual([true, false]);
    expect(registry.slotState().closing).toBe(false);
  });
});

describe("U4 5.4 closing 标记的取消与异常清理", () => {
  it("clean 路径不弹确认、closing 保持到关窗（进程结束前不重开提交口）", async () => {
    const h = setup();
    h.setHandshaken(true);
    h.flow.interceptClose();
    answerThrough(h, { dirtyCount: 0 });
    expect(await h.flow.requestClose()).toBe("closed");
    expect(h.closingLog).toEqual([true]); // 只置位，未解除
  });

  it("返回路径成对解除：closing 置位后必然解除，且只解除一次", async () => {
    const h = setup();
    h.setHandshaken(true);
    h.flow.interceptClose();
    answerThrough(h, { dirtyCount: 4 });
    expect(await h.flow.requestClose()).toBe("canceled");
    expect(h.closingLog).toEqual([true, false]);
  });

  it("确认端口抛错 ⇒ 解除 closing + 取消挂起查询 + 解除 renderer 输入锁（不留死锁）", async () => {
    const h = setup();
    h.setHandshaken(true);
    h.flow.interceptClose();
    answerThrough(h, { dirtyCount: 1 });
    h.confirmThrows = true;
    await expect(h.flow.requestClose()).rejects.toThrow("确认端口异常");
    expect(h.closingLog).toEqual([true, false]);
    expect(h.guard.pendingQueryOf(WC)).toBeUndefined();
    // 输入锁必须收到释放通知，否则 renderer 永久锁死、无法再次关闭
    expect(h.releases).toHaveLength(1);
    expect(h.flow.busy).toBe(false);

    // 清理后下一次关闭是完整的新鲜协商
    h.confirmThrows = false;
    h.flow.interceptClose();
    answerThrough(h, { dirtyCount: 0, sequence: 8 });
    expect(await h.flow.requestClose()).toBe("closed");
  });

  it("装配层把两条端口接到真 registry（源码契约：不另造一个 closing 标志）", () => {
    const attach = readFileSync(
      resolve(import.meta.dirname, "../src/main/draft-close-attach.ts"),
      "utf8",
    );
    expect(attach).toContain("operations.setClosing(closing)");
    expect(attach).toContain("operations.slotState()");
    // 窗口销毁必须解除 closing——这一支漏接就是「一次协商永久封住提交口」
    expect(attach).toContain("flow?.onWindowClosed()");
    // 装配层不自己判断 clean/活跃槽（判据只有一份，在纯核心）
    expect(attach).not.toContain("activeOperationId === null");
    const index = readFileSync(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");
    // 登记对象由 bootstrap 建一次并穿进 createWindow ⇒ 关闭协商与执行用同一个真相源
    expect(index).toContain("attachDraftCloseGuard(win, operations)");
    expect(index).toContain("const operations = new OperationRegistry()");
  });
});
