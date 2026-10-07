import { ProxyChangeEventSchema } from "@shared/ipc";
import type { ProxyChangeEvent } from "@shared/ipc";
import { describe, expect, it } from "vitest";
import {
  cursorFromStatus,
  initialProxyFactCursor,
  shouldApplyChange,
  shouldReconcileOnActivate,
} from "../src/renderer/src/lib/proxy-changes";
import type { ProxyFactCursor } from "../src/renderer/src/lib/proxy-changes";
import { FAKE_PROXY_EPOCH, proxyStateFixture } from "./helpers/proxy-state-fixture";

/**
 * tasks 1.4 的**判据半边**：`proxy-changes.ts` 的四条规则。
 *
 * 判据来源：design D1 + delta spec `desktop-ui`
 * 「被动代理录制自动更新列表并保留阅读」/「代理录制状态回读与重发门禁」。
 * 逐字对应的验收场景：
 * - 「订阅前与失焦期间的变化可补读」⇒ 规则 2（旧会话丢弃）+ 失焦补读判据；
 * - 「并发录制保留筛选和当前阅读」⇒ 规则 3（乱序不回退）+ 规则 4（只有 records 刷列表）；
 * - 「会话 revision 快照或激活核对补齐更新」⇒ `cursorFromStatus` 的单调守卫。
 *
 * ⚠️ 这些是**纯函数**测试（不碰 store、不碰 window.api）。接线半边在
 * `proxy-change-store.test.ts`——判据在 lib 里绿不代表接上了消费点。
 */

const EPOCH_A = FAKE_PROXY_EPOCH;
const EPOCH_B = "proxy-epoch-0002";

function changeEvent(overrides?: Partial<ProxyChangeEvent>): ProxyChangeEvent {
  return {
    epoch: EPOCH_A,
    revision: 1,
    recordsRevision: 1,
    changes: ["records"],
    ...overrides,
  };
}

/** 已读过状态、且已采纳到 recordsRevision=1 的游标 */
function cursorAt(overrides?: Partial<ProxyFactCursor>): ProxyFactCursor {
  return { epoch: EPOCH_A, revision: 1, recordsRevision: 1, ...overrides };
}

describe("载荷校验：非法通知整条丢弃，不按部分字段处理", () => {
  it("只认受控形状：缺字段 / 多余类别 / 空 changes 一律不过", () => {
    // 一个坏载荷若被"宽容处理"，就能把 hasKey 之类的门禁事实带歪
    expect(
      ProxyChangeEventSchema.safeParse({
        epoch: "",
        revision: 0,
        recordsRevision: 0,
        changes: ["records"],
      }).success,
    ).toBe(false);
    expect(
      ProxyChangeEventSchema.safeParse({ epoch: EPOCH_A, recordsRevision: 0, changes: ["records"] })
        .success,
    ).toBe(false);
    expect(
      ProxyChangeEventSchema.safeParse({ epoch: EPOCH_A, revision: 0, changes: ["records"] })
        .success,
    ).toBe(false);
    // 空通知没有意义：main 不该发，收到也不采纳
    expect(
      ProxyChangeEventSchema.safeParse({
        epoch: EPOCH_A,
        revision: 0,
        recordsRevision: 0,
        changes: [],
      }).success,
    ).toBe(false);
    // 类别是封闭枚举——不能夹带任意字符串
    expect(
      ProxyChangeEventSchema.safeParse({
        epoch: EPOCH_A,
        revision: 0,
        recordsRevision: 0,
        changes: ["credentials"],
      }).success,
    ).toBe(false);
    // revision 必须是非负整数（-1 / 小数都拒）
    expect(
      ProxyChangeEventSchema.safeParse({
        epoch: EPOCH_A,
        revision: -1,
        recordsRevision: 0,
        changes: ["status"],
      }).success,
    ).toBe(false);
    expect(
      ProxyChangeEventSchema.safeParse({
        epoch: EPOCH_A,
        revision: 1.5,
        recordsRevision: 0,
        changes: ["status"],
      }).success,
    ).toBe(false);
  });

  it("不含凭据/输入字段：载荷只有 epoch、两个 revision 与类别", () => {
    // delta「通知只包含受控元信息」的形状半边——若将来有人往里加 key 或 messages，
    // 这条断言会响（键集合是封闭的）
    const parsed = ProxyChangeEventSchema.parse(changeEvent());
    expect(Object.keys(parsed).sort()).toEqual(["changes", "epoch", "recordsRevision", "revision"]);
    expect(parsed.changes).toEqual(["records"]);
  });
});

describe("规则 2：旧 main 会话的通知一律丢弃", () => {
  it("epoch 不同 ⇒ 不触发任何读取，也不回写游标", () => {
    const before = cursorAt();
    const plan = shouldApplyChange(
      before,
      changeEvent({ epoch: EPOCH_B, revision: 99, recordsRevision: 99 }),
    );
    expect(plan.reloadStatus).toBe(false);
    expect(plan.reloadRuns).toBe(false);
    // 关键：游标原样返回。若这里跟着旧通知走了，新 main 的事实会被按回旧状态
    expect(plan.cursor).toBe(before);
  });

  it("尚未读过状态（epoch=null）⇒ 首条通知照常采纳，不当旧会话丢", () => {
    // 反过来也成立：把"没读过"误判成"旧会话"会让首次订阅后的通知全部失效
    const plan = shouldApplyChange(initialProxyFactCursor, changeEvent());
    expect(plan.reloadStatus).toBe(true);
    expect(plan.reloadRuns).toBe(true);
    expect(plan.cursor).toEqual({ epoch: EPOCH_A, revision: 1, recordsRevision: 1 });
  });
});

describe("规则 3：同会话内 revision 不回退", () => {
  it("落后的通知（乱序到达）不触发读取，游标不动", () => {
    const before = cursorAt({ revision: 5, recordsRevision: 5 });
    const plan = shouldApplyChange(before, changeEvent({ revision: 3, recordsRevision: 3 }));
    expect(plan.reloadStatus).toBe(false);
    expect(plan.reloadRuns).toBe(false);
    expect(plan.cursor).toBe(before);
  });

  it("同 revision 的重复通知不刷列表（burst 去重的第一道）", () => {
    const before = cursorAt({ revision: 5, recordsRevision: 5 });
    const plan = shouldApplyChange(before, changeEvent({ revision: 5, recordsRevision: 5 }));
    expect(plan.reloadRuns).toBe(false);
    // 状态仍重读：读到的可能是另一维度的事实
    expect(plan.reloadStatus).toBe(true);
  });

  it("cursorFromStatus 遇乱序响应只前进、不回退", () => {
    const advanced = cursorFromStatus(initialProxyFactCursor, {
      epoch: EPOCH_A,
      revision: 7,
      recordsRevision: 4,
    });
    expect(advanced).toEqual({ epoch: EPOCH_A, revision: 7, recordsRevision: 4 });
    // 迟到的旧响应（status 请求在飞时又来了通知）不得把版本拉回去
    const stale = cursorFromStatus(advanced, { epoch: EPOCH_A, revision: 3, recordsRevision: 1 });
    expect(stale).toEqual({ epoch: EPOCH_A, revision: 7, recordsRevision: 4 });
  });

  it("cursorFromStatus 遇会话轮换整份重来（新旧数字不在同一尺度上）", () => {
    const rotated = cursorFromStatus(cursorAt({ revision: 9, recordsRevision: 9 }), {
      epoch: EPOCH_B,
      revision: 1,
      recordsRevision: 0,
    });
    expect(rotated).toEqual({ epoch: EPOCH_B, revision: 1, recordsRevision: 0 });
  });
});

describe("规则 4：只有 records 类别才触发列表刷新", () => {
  it("纯 status（凭据捕获）⇒ 刷状态但不刷列表", () => {
    // 凭据变化不产生新 run，刷列表是白读一次全量 traces
    const plan = shouldApplyChange(
      cursorAt(),
      changeEvent({ revision: 2, recordsRevision: 1, changes: ["status"] }),
    );
    expect(plan.reloadStatus).toBe(true);
    expect(plan.reloadRuns).toBe(false);
    expect(plan.cursor.recordsRevision).toBe(1);
  });

  it("records ⇒ 刷列表也刷状态（一次外部请求可能既捕获 key 又落盘）", () => {
    const plan = shouldApplyChange(
      cursorAt(),
      changeEvent({ revision: 2, recordsRevision: 2, changes: ["records"] }),
    );
    expect(plan.reloadRuns).toBe(true);
    expect(plan.reloadStatus).toBe(true);
    expect(plan.cursor).toEqual({ epoch: EPOCH_A, revision: 2, recordsRevision: 2 });
  });

  it("records 但 recordsRevision 未前进 ⇒ 不刷列表（重复投递同一落盘事实）", () => {
    const plan = shouldApplyChange(
      cursorAt({ revision: 2, recordsRevision: 2 }),
      changeEvent({ revision: 3, recordsRevision: 2 }),
    );
    expect(plan.reloadRuns).toBe(false);
  });
});

describe("失焦/激活补读：只在确实落后时才要求刷列表", () => {
  const cursor = cursorAt({ revision: 4, recordsRevision: 4 });

  it("同会话且 recordsRevision 未变 ⇒ 不刷（每次点回窗口都白读全量 traces 是不可接受的）", () => {
    expect(shouldReconcileOnActivate(cursor, cursor).reloadRuns).toBe(false);
  });

  it("同会话但落盘版本落后 ⇒ 补刷（失焦期间有新 run 落盘）", () => {
    expect(
      shouldReconcileOnActivate(cursor, { epoch: EPOCH_A, revision: 6, recordsRevision: 6 })
        .reloadRuns,
    ).toBe(true);
  });

  it("状态读取失败（epoch=null）⇒ 一律要求补刷：状态未知时不能断言没有变化", () => {
    // 这是 store 里 loadProxyStatus 失败时游标不前进的落点
    expect(shouldReconcileOnActivate(cursor, initialProxyFactCursor).reloadRuns).toBe(true);
    expect(
      shouldReconcileOnActivate(cursor, { epoch: null, revision: 0, recordsRevision: 0 })
        .reloadRuns,
    ).toBe(true);
  });

  it("会话轮换 ⇒ 一律补刷（上一届 main 的游标与本届不可比）", () => {
    expect(
      shouldReconcileOnActivate(cursor, { epoch: EPOCH_B, revision: 0, recordsRevision: 0 })
        .reloadRuns,
    ).toBe(true);
    expect(
      shouldReconcileOnActivate(initialProxyFactCursor, {
        epoch: EPOCH_A,
        revision: 0,
        recordsRevision: 0,
      }).reloadRuns,
    ).toBe(true);
  });

  it("只用状态里的 recordsRevision 判定：status revision 前进不单独触发刷列表", () => {
    // 纯凭据捕获推进了 revision 但没落盘 ⇒ 列表无需重读
    expect(
      shouldReconcileOnActivate(cursor, { epoch: EPOCH_A, revision: 9, recordsRevision: 4 })
        .reloadRuns,
    ).toBe(false);
  });
});

describe("夹具自检：本文件用的状态夹具确实过 schema", () => {
  it("proxyStateFixture 过 ProxyState 形状（防止夹具与 schema 各自漂移）", () => {
    // 这条是给未来的自己：一旦 ProxyStateSchema 再加字段，这里会先响
    const state = proxyStateFixture({
      hasKey: true,
      epoch: EPOCH_B,
      revision: 3,
      recordsRevision: 2,
    });
    expect(state.epoch).toBe(EPOCH_B);
    expect(Object.keys(state).sort()).toEqual([
      "enabled",
      "epoch",
      "hasKey",
      "keyCaptureRevision",
      "port",
      "recordsRevision",
      "revision",
      "running",
      "upstreamBaseUrl",
    ]);
  });
});
