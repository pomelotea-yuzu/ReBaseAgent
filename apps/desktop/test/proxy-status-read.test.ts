import { describe, expect, it } from "vitest";
import { initialProxyFactCursor } from "../src/renderer/src/lib/proxy-changes";
import type { ProxyFactCursor } from "../src/renderer/src/lib/proxy-changes";
import {
  acceptProxySnapshot,
  beginStatusRead,
  initialProxyStatusReadState,
  isStatusReadChecking,
  settleStatusRead,
} from "../src/renderer/src/lib/proxy-status-read";

/**
 * tasks 2.1 的**判据半边**：代理状态回读的合并调度与快照采纳守卫。
 *
 * 对应 delta spec `desktop-ui`「重发门禁使用当前代理事实且隔离迟到读取」的
 * 「迟到读取不能覆盖新事实」场景，以及「重复只读核对不撤销未变化的确认」的前置条件。
 *
 * ⚠️ **这里没有「代次守卫」用例是刻意的**（2026-10-07 变异验证的结论）：
 * 合并已保证任一时刻至多一个读取在飞，"响应与请求对不上"不可达。store 侧曾有一道
 * `isLatestStatusRead` 断言，变异测试（替换成 `if (false)`）显示 store 用例全绿
 * ——它从未拒绝过任何响应。留着它等于挂一个永不触发的保险而让人误以为并发防护靠它，
 * 故连同用例一起移除。真正的乱序防线是下面的「快照新旧守卫」。
 *
 * 接线半边（真实 store）见 `proxy-status-store.test.ts`。
 */

const EPOCH_A = "proxy-epoch-0001";
const EPOCH_B = "proxy-epoch-0002";

function facts(overrides?: Partial<{ epoch: string; revision: number; recordsRevision: number }>) {
  return { epoch: EPOCH_A, revision: 0, recordsRevision: 0, ...overrides };
}

function cursorAt(revision: number, recordsRevision = revision, epoch = EPOCH_A): ProxyFactCursor {
  return { epoch, revision, recordsRevision };
}

describe("在途合并：有读取在飞时不并发发射", () => {
  it("第一次调用发射并登记代次；飞行中只登记尾随", () => {
    const first = beginStatusRead(initialProxyStatusReadState);
    expect(first.action).toBe("start");
    if (first.action !== "start") throw new Error("unreachable");
    expect(first.token).toBe(1);
    expect(first.state.inFlight).toBe(1);

    // 飞行中连来三次意图：只登记一次尾随，**不**推进代次（没有新请求被发射）
    let state = first.state;
    for (let i = 0; i < 3; i += 1) {
      const next = beginStatusRead(state);
      expect(next.action).toBe("deferred");
      state = next.state;
    }
    expect(state.pending).toBe(1);
    expect(state.generation).toBe(1);
  });

  it("收尾后补发恰好一次，补发自己登记在途数（计数不残留）", () => {
    const started = beginStatusRead(initialProxyStatusReadState);
    if (started.action !== "start") throw new Error("unreachable");
    const state = beginStatusRead(started.state).state; // 登记尾随
    expect(state.pending).toBe(1);

    const settled = settleStatusRead(state);
    expect(settled.shouldRefire).toBe(true);
    expect(settled.state.inFlight).toBe(0);

    // 补发走完整路径 ⇒ 重新置起在途计数，并在自己收尾时归零
    const refire = beginStatusRead(settled.state);
    if (refire.action !== "start")
      throw new Error("补发必须能发射，否则计数残留会让此后所有读取永不发射");
    expect(refire.token).toBe(2);
    expect(settleStatusRead(refire.state).state).toEqual({
      inFlight: 0,
      pending: 0,
      generation: 2,
    });
  });

  it("无尾随时不补发（否则每次读取都多一次无意义 IPC）", () => {
    const started = beginStatusRead(initialProxyStatusReadState);
    if (started.action !== "start") throw new Error("unreachable");
    expect(settleStatusRead(started.state).shouldRefire).toBe(false);
  });

  it("读取中派生为「核对中」，静默后消失", () => {
    const started = beginStatusRead(initialProxyStatusReadState);
    if (started.action !== "start") throw new Error("unreachable");
    expect(isStatusReadChecking(started.state)).toBe(true);
    expect(isStatusReadChecking(settleStatusRead(started.state).state)).toBe(false);
  });
});

describe("代次只在真正发射时推进（守卫锚点，不是并发计数器）", () => {
  it("被合并的意图不推进代次（没有新请求被发射，就没有新代次）", () => {
    const first = beginStatusRead(initialProxyStatusReadState);
    if (first.action !== "start") throw new Error("unreachable");
    expect(first.state.generation).toBe(1);
    // 合并三次意图：代次不变
    expect(beginStatusRead(first.state).state.generation).toBe(1);
    expect(beginStatusRead(first.state).state.generation).toBe(1);
  });

  it("补发是真正的新请求 ⇒ 代次推进（读取代次单调，可用于诊断乱序）", () => {
    const first = beginStatusRead(initialProxyStatusReadState);
    if (first.action !== "start") throw new Error("unreachable");
    const settled = settleStatusRead(beginStatusRead(first.state).state);
    const second = beginStatusRead(settled.state);
    if (second.action !== "start") throw new Error("unreachable");
    expect(second.state.generation).toBe(2);
    expect(settleStatusRead(second.state).state.generation).toBe(2);
  });
});

describe("快照新旧守卫：最新发起的读取也可能带回过去的事实", () => {
  it("同 epoch 且 revision 落后 ⇒ 整份拒绝（不改游标）", () => {
    const ruling = acceptProxySnapshot(cursorAt(6), facts({ revision: 3, recordsRevision: 1 }));
    expect(ruling.accept).toBe(false);
  });

  it("同 epoch 且 revision 相同 ⇒ 采纳（重复核对同一事实不是回退）", () => {
    const ruling = acceptProxySnapshot(cursorAt(6, 4), facts({ revision: 6, recordsRevision: 4 }));
    expect(ruling.accept).toBe(true);
    if (!ruling.accept) throw new Error("unreachable");
    expect(ruling.cursor).toEqual({ epoch: EPOCH_A, revision: 6, recordsRevision: 4 });
  });

  it("同 epoch 且 revision 前进 ⇒ 采纳并推进游标", () => {
    const ruling = acceptProxySnapshot(cursorAt(4), facts({ revision: 7, recordsRevision: 7 }));
    expect(ruling.accept).toBe(true);
    if (!ruling.accept) throw new Error("unreachable");
    expect(ruling.cursor).toEqual({ epoch: EPOCH_A, revision: 7, recordsRevision: 7 });
  });

  it("recordsRevision 单独落后（状态没变、落盘版本更旧）⇒ 也拒绝", () => {
    // 真实形状：凭据捕获推进 revision，recordsRevision 不动；反过来读到更旧的
    // recordsRevision 同样是"过去"，若采纳会把游标按回去。
    const ruling = acceptProxySnapshot(cursorAt(6, 9), facts({ revision: 6, recordsRevision: 4 }));
    expect(ruling.accept).toBe(false);
  });

  it("跨 epoch 一律采纳（数字不可比，那是新一届 main 的事实）", () => {
    const ruling = acceptProxySnapshot(
      cursorAt(99, 99, EPOCH_A),
      facts({ epoch: EPOCH_B, revision: 0, recordsRevision: 0 }),
    );
    expect(ruling.accept).toBe(true);
    if (!ruling.accept) throw new Error("unreachable");
    expect(ruling.cursor).toEqual({ epoch: EPOCH_B, revision: 0, recordsRevision: 0 });
  });

  it("从未读过状态（epoch=null）⇒ 第一份快照无条件采纳", () => {
    const ruling = acceptProxySnapshot(initialProxyFactCursor, facts({ revision: 0 }));
    expect(ruling.accept).toBe(true);
  });

  it("游标与快照的 recordsRevision 分别只前进：混合新旧字段也不回退", () => {
    const ruling = acceptProxySnapshot(cursorAt(6, 2), facts({ revision: 8, recordsRevision: 5 }));
    expect(ruling.accept).toBe(true);
    if (!ruling.accept) throw new Error("unreachable");
    expect(ruling.cursor).toEqual({ epoch: EPOCH_A, revision: 8, recordsRevision: 5 });
  });
});
