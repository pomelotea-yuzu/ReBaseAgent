import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DraftCloseFlow,
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
  h.flow = new DraftCloseFlow(WC, guard, ports, { hasPendingLoss: opts?.hasPendingLoss });
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
