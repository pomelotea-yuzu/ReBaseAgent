import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DRAFT_CLOSE_QUERY_TIMEOUT_MS,
  DraftCloseFlow,
  type DraftCloseFlowDeps,
  type DraftCloseFlowPorts,
  evaluateCloseAnswer,
} from "../src/main/draft-close-flow";
import { DraftCloseGuard, type DraftCloseSender } from "../src/main/draft-close-guard";
import type { DraftCloseAnswer, DraftCloseQuery } from "../src/shared/ipc";

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
 * 纯逻辑直测：guard 用真实现，原生确认/关窗/发消息为注入端口。
 */

const WC = 1;
const FRAME = 100;

function sender(over?: Partial<DraftCloseSender>): DraftCloseSender {
  return { webContentsId: WC, frameRoutingId: FRAME, ...over };
}

interface Harness {
  flow: DraftCloseFlow;
  guard: DraftCloseGuard;
  queries: DraftCloseQuery[];
  confirms: Array<"dirty" | "unknown">;
  releases: Array<{ sessionId: string; requestId: string }>;
  closeCalls: number;
  setHandshaken: (v: boolean) => void;
  confirmChoice: "return" | "quit";
  sessionId: string;
}

function setup(opts?: {
  confirmChoice?: "return" | "quit";
  hasPendingLoss?: () => boolean;
  scheduleTimeout?: DraftCloseFlowDeps["scheduleTimeout"];
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
    closeCalls: 0,
    setHandshaken: (v: boolean): void => {
      const target = guard.targetOf(WC);
      if (target !== undefined) target.handshaken = v;
    },
    confirmChoice: opts?.confirmChoice ?? "return",
    sessionId: "sess-main",
    flow: null as unknown as DraftCloseFlow,
  };
  const ports: DraftCloseFlowPorts = {
    sendQuery: (query) => {
      h.queries.push(query);
    },
    showConfirm: async (kind) => {
      h.confirms.push(kind);
      return h.confirmChoice;
    },
    closeWindow: () => {
      h.closeCalls += 1;
    },
    sendRelease: (sessionId, requestId) => {
      h.releases.push({ sessionId, requestId });
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
    expect(h.confirms).toEqual(["dirty"]);
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
    expect(h.confirms).toEqual(["dirty"]);
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
    expect(h.confirms).toEqual(["unknown"]);
    expect(h.closeCalls).toBe(0);
    expect(h.releases).toHaveLength(1);

    // 目标已销毁：beginQuery 返回 null，无可核对对象 ⇒ 保守 unknown，不静默放行
    const h2 = setup({ confirmChoice: "return" });
    h2.setHandshaken(true);
    h2.guard.detach(WC);
    const outcome2 = await h2.flow.requestClose();
    expect(outcome2).toBe("canceled");
    expect(h2.confirms).toEqual(["unknown"]);
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
    expect(h.confirms).toEqual(["unknown"]);
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
    expect(h.confirms).toEqual(["dirty"]); // 只弹过一次确认
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
    expect(h.confirms).toEqual(["unknown"]);
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
    expect(h.confirms).toEqual(["unknown"]);

    // 第二轮（用户再次关闭，明确退出）：新鲜查询正常应答，流程完整走通
    h.confirmChoice = "quit";
    h.flow.interceptClose();
    answerThrough(h, { dirtyCount: 1, sequence: 5 });
    expect(await h.flow.requestClose()).toBe("closed");
    expect(h.queries).toHaveLength(2); // 两次独立的新鲜查询
    expect(h.confirms).toEqual(["unknown", "dirty"]); // 第二轮按真实 dirty 确认
    expect(h.closeCalls).toBe(1);
  });

  it("unknown 提示只说明暂时无法确认，不断言崩溃/失联（源码契约）", () => {
    const attach = readFileSync(
      resolve(import.meta.dirname, "../src/main/draft-close-attach.ts"),
      "utf8",
    );
    // 未知档文案必须有「暂时无法确认」语义
    expect(attach).toContain("暂时无法确认草稿状态");
    // 不做存活诊断：文案不得断言崩溃/失联/无响应
    expect(attach).not.toContain("已崩溃");
    expect(attach).not.toContain("失联");
    expect(attach).not.toContain("无响应");
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
    expect(h.confirms).toEqual(["unknown"]);

    // 用户返回 = 已知悉 ⇒ 标志清除；下次关闭 clean 应答直接放行
    expect(h.guard.hasPendingLoss()).toBe(false);
    h.flow.interceptClose();
    answerThrough(h, { dirtyCount: 0, sequence: 5 });
    expect(await h.flow.requestClose()).toBe("closed");
    expect(h.confirms).toEqual(["unknown"]); // 第二轮没有再弹确认
  });
});
