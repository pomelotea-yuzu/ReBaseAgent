import { describe, expect, it } from "vitest";
import { DraftCloseGuard, type DraftCloseSender } from "../src/main/draft-close-guard";
import {
  DRAFT_CLOSE_DIRTY_MAX,
  DraftCloseAnswerSchema,
  DraftCloseReportSchema,
} from "../src/shared/ipc";

/**
 * U3 任务 4.1：严格元数据 schema 与 main 会话校验。
 *
 * 判据来源：tasks.md 4.1——「定义严格元数据 schema（含 inputSettled）和 shared/preload
 * 受限接口、订阅/解绑，main 验证 sender/frame/session/sequence」。
 * 验收场景：
 * - 旧会话伪造发送者和乱序消息不影响关闭（delta 场景「旧会话伪造发送者和乱序消息不影响关闭」）；
 * - 设置凭据与调试草稿分离（协议只传元数据——schema 形状断言）。
 *
 * 本组测试只针对纯核心 `draft-close-guard.ts`（不 import electron）；
 * electron 事件适配层属接线，§6 实机验收承载。
 */

const WC = 1; // 目标窗口 webContents id
const FRAME = 100; // 目标窗口主 frame routingId

function setup(options?: { sessionIdPrefix?: string }) {
  let sessionCounter = 0;
  const rotations: string[] = [];
  const rejections: Array<{ reason: string; sender: DraftCloseSender | null }> = [];
  const prefix = options?.sessionIdPrefix ?? "sess";
  const guard = new DraftCloseGuard({
    newSessionId: () => {
      sessionCounter += 1;
      return `${prefix}-${sessionCounter}`;
    },
    onSessionRotated: (_target, sessionId) => {
      rotations.push(sessionId);
    },
    onRejected: (reason, sender) => {
      rejections.push({ reason, sender });
    },
  });
  guard.rotateSession({ webContentsId: WC, getMainFrameRoutingId: (): number => FRAME });
  return { guard, rotations, rejections };
}

function sender(over?: Partial<DraftCloseSender>): DraftCloseSender {
  return { webContentsId: WC, frameRoutingId: FRAME, ...over };
}

/** 完成握手的快捷路径 */
function handshaken(guard: DraftCloseGuard): string {
  const result = guard.handshake(sender());
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  return result.sessionId;
}

describe("U3 4.1 关闭协商：会话与 sender/frame 校验", () => {
  it("握手：未知 webContents 与子 frame 被拒，主 frame 成功并标记握手", () => {
    const { guard, rejections } = setup();
    const unknown = guard.handshake({ webContentsId: 999, frameRoutingId: FRAME });
    expect(unknown.ok).toBe(false);
    const child = guard.handshake({ webContentsId: WC, frameRoutingId: 555 });
    expect(child.ok).toBe(false);
    const ok = guard.handshake(sender());
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.sessionId).toBe("sess-1");
    // 主 frame 动态取值：适配层在事件时现取 routingId，校验用它比对
    const target = guard.targetOf(WC);
    expect(target?.handshaken).toBe(true);
    expect(rejections.map((r) => r.reason)).toEqual([
      "handshake:unknown_target",
      "handshake:non_main_frame",
    ]);
  });

  it("报告：未握手 / 非法载荷 / 旧会话 / 乱序全部被拒，合法报告才更新 lastReported", () => {
    const { guard } = setup();
    const sessionId = handshaken(guard);
    // 未握手时报告被拒（先握手前发一条）
    const early = setup();
    expect(
      early.guard.handleReport(sender(), { sessionId: "sess-1", sequence: 0, dirtyCount: 0 }).ok,
    ).toBe(false);

    // 合法首报
    expect(guard.handleReport(sender(), { sessionId, sequence: 0, dirtyCount: 2 })).toEqual({
      ok: true,
    });
    expect(guard.targetOf(WC)?.lastReported).toEqual({ sequence: 0, dirtyCount: 2 });

    // 乱序（sequence 相同 / 更小）被拒且不改状态
    expect(guard.handleReport(sender(), { sessionId, sequence: 0, dirtyCount: 9 }).ok).toBe(false);
    expect(guard.handleReport(sender(), { sessionId, sequence: -1, dirtyCount: 9 }).ok).toBe(false);
    expect(guard.targetOf(WC)?.lastReported).toEqual({ sequence: 0, dirtyCount: 2 });

    // 旧会话 id 被拒
    expect(
      guard.handleReport(sender(), { sessionId: "sess-old", sequence: 5, dirtyCount: 0 }).ok,
    ).toBe(false);

    // 非法载荷：dirtyCount 负数 / 超界 / 非整数、缺字段、非对象
    expect(guard.handleReport(sender(), { sessionId, sequence: 1, dirtyCount: -1 }).ok).toBe(false);
    expect(
      guard.handleReport(sender(), {
        sessionId,
        sequence: 1,
        dirtyCount: DRAFT_CLOSE_DIRTY_MAX + 1,
      }).ok,
    ).toBe(false);
    expect(guard.handleReport(sender(), { sessionId, sequence: 1, dirtyCount: 1.5 }).ok).toBe(
      false,
    );
    expect(guard.handleReport(sender(), { sessionId, sequence: 1 }).ok).toBe(false);
    expect(guard.handleReport(sender(), "not-an-object").ok).toBe(false);

    // 合法递增报告通过
    expect(guard.handleReport(sender(), { sessionId, sequence: 1, dirtyCount: 0 })).toEqual({
      ok: true,
    });
    expect(guard.targetOf(WC)?.lastReported).toEqual({ sequence: 1, dirtyCount: 0 });
  });

  it("会话轮换：新 sessionId 作废旧会话，序号与握手状态重置", () => {
    const { guard, rotations } = setup();
    const first = handshaken(guard);
    expect(guard.handleReport(sender(), { sessionId: first, sequence: 3, dirtyCount: 1 })).toEqual({
      ok: true,
    });

    const rotated = guard.rotateSession({
      webContentsId: WC,
      getMainFrameRoutingId: (): number => FRAME,
    });
    expect(rotated.sessionId).toBe("sess-2");
    expect(rotations).toEqual(["sess-1", "sess-2"]);

    // 旧会话的报告 / 应答一律被拒
    expect(guard.handleReport(sender(), { sessionId: first, sequence: 4, dirtyCount: 0 }).ok).toBe(
      false,
    );
    // 新会话：握手状态已重置，未握手前消息被拒
    expect(
      guard.handleReport(sender(), { sessionId: "sess-2", sequence: 0, dirtyCount: 0 }).ok,
    ).toBe(false);
    handshaken(guard);
    // 新会话序号重新从 0 开始（旧会话的 sequence=3 不再约束新会话）
    expect(
      guard.handleReport(sender(), { sessionId: "sess-2", sequence: 0, dirtyCount: 1 }),
    ).toEqual({ ok: true });
  });
});

describe("U3 4.1 关闭协商：查询请求身份与迟到应答", () => {
  it("应答：无挂起查询 / requestId 不匹配 / 重放被拒；匹配应答被接受且消费挂起查询", () => {
    const { guard } = setup();
    const sessionId = handshaken(guard);
    // 无挂起查询时应答被拒
    expect(
      guard.handleAnswer(sender(), {
        sessionId,
        requestId: "rq-1",
        sequence: 0,
        dirtyCount: 0,
        inputSettled: true,
      }).ok,
    ).toBe(false);

    const query = guard.beginQuery(WC);
    expect(query).toEqual({ sessionId, requestId: expect.any(String) });
    const requestId = query?.requestId ?? "";

    // requestId 不匹配被拒
    expect(
      guard.handleAnswer(sender(), {
        sessionId,
        requestId: "rq-other",
        sequence: 0,
        dirtyCount: 0,
        inputSettled: true,
      }).ok,
    ).toBe(false);

    // 匹配应答被接受，挂起查询被消费
    expect(
      guard.handleAnswer(sender(), {
        sessionId,
        requestId,
        sequence: 1,
        dirtyCount: 3,
        inputSettled: false,
      }),
    ).toEqual({ ok: true });
    expect(guard.pendingQueryOf(WC)).toBeUndefined();
    expect(guard.takeAnswer(WC)).toEqual({
      sessionId,
      requestId,
      sequence: 1,
      dirtyCount: 3,
      inputSettled: false,
    });

    // 同一 requestId 的迟到重放被拒（挂起查询已消费）
    expect(
      guard.handleAnswer(sender(), {
        sessionId,
        requestId,
        sequence: 2,
        dirtyCount: 3,
        inputSettled: true,
      }).ok,
    ).toBe(false);
    // takeAnswer 取走即清
    expect(guard.takeAnswer(WC)).toBeUndefined();
  });

  it("cancelQuery 清除挂起查询后，迟到应答不再被接受", () => {
    const { guard } = setup();
    const sessionId = handshaken(guard);
    const query = guard.beginQuery(WC);
    guard.cancelQuery(WC);
    expect(
      guard.handleAnswer(sender(), {
        sessionId,
        requestId: query?.requestId ?? "",
        sequence: 0,
        dirtyCount: 0,
        inputSettled: true,
      }).ok,
    ).toBe(false);
  });

  it("detach 后一切消息被拒且 beginQuery 返回 null", () => {
    const { guard } = setup();
    handshaken(guard);
    guard.detach(WC);
    expect(guard.beginQuery(WC)).toBeNull();
    expect(
      guard.handleReport(sender(), { sessionId: "sess-1", sequence: 0, dirtyCount: 0 }).ok,
    ).toBe(false);
    expect(guard.handshake(sender()).ok).toBe(false);
  });
});

describe("U3 4.1 协议形状：只传元数据（凭据与草稿分离）", () => {
  it("report / answer 载荷键恰好是元数据字段，无正文/凭据通道", () => {
    // schema 的键即协议的全部表达力：多一个字段都过不了 strict-ish 形状断言
    expect(Object.keys(DraftCloseReportSchema.shape).sort()).toEqual([
      "dirtyCount",
      "sequence",
      "sessionId",
    ]);
    expect(Object.keys(DraftCloseAnswerSchema.shape).sort()).toEqual([
      "dirtyCount",
      "inputSettled",
      "requestId",
      "sequence",
      "sessionId",
    ]);
    // 有界计数
    expect(DRAFT_CLOSE_DIRTY_MAX).toBe(1_000_000);
  });
});
