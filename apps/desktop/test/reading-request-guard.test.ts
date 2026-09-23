import { describe, expect, it } from "vitest";
import type { WorkspaceInspectResult, WorkspaceReadFileResult } from "../src/shared/ipc";

/**
 * U2 任务 3.1：清单与两侧读取的**身份 / 代次守卫**。
 *
 * 对应 delta（requirement「文件两侧读取状态真实且旧响应不覆盖新选择」）：
 * -「快速切换不串清单正文错误和加载」：旧的成功/失败/异常迟到，标题、清单、内容、错误及
 *   loading **只对应当前请求**；旧请求 finally 不清除新 loading。
 * -「同对象重试与往返有请求代次」：A→B→A 或同一对象连续重试，较旧的请求后返回也**只有
 *   最新代次生效**——**不能因 run/step/path 相同就接受旧结果**。
 *
 * ⚠️ 这是**纯逻辑层**测试：不挂 React、不跑 effect、不需要 jsdom。真实组件里的接线
 *    （响应必过 `accept`、loading 由状态机持有）另有 source 级契约钉住。
 */

const { RequestGuard, settleList, settleSide, sideResult, sideLoading, sideFailed } = await import(
  "../src/renderer/src/lib/reading-request-guard"
);

function inspectResult(seed: string): WorkspaceInspectResult {
  const h = seed.repeat(64).slice(0, 64);
  return {
    runId: "run_a",
    stepSpanId: null,
    snapshotId: h,
    ownerRunId: "run_a",
    localIteration: null,
    profile: "file-tools-v1",
    worldId: "run_a",
    origin: { kind: "import" },
    files: [],
    fileCount: 0,
    totalBytes: 0,
    unavailableCount: 0,
    initialSnapshotId: h,
  };
}

function textResult(path: string, text: string): WorkspaceReadFileResult {
  return {
    status: "text",
    path,
    bytes: text.length,
    sha256: "a".repeat(64),
    text,
  };
}

// ---------------------------------------------------------------------------
// 代次守卫本身
// ---------------------------------------------------------------------------

describe("RequestGuard：单调代次，同 key 重试也各有代次", () => {
  it("每次 begin 都递增代次（同 key 也不例外）", () => {
    const guard = new RequestGuard();
    const first = guard.begin("selected", "run_a\u0000\u0000a.txt");
    const second = guard.begin("selected", "run_a\u0000\u0000a.txt");
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(first.key).toBe(second.key);
  });

  it("**同对象重试**：旧 token 不再被接受（不能因 key 相同就承认旧结果）", () => {
    const guard = new RequestGuard();
    const stale = guard.begin("selected", "k");
    const fresh = guard.begin("selected", "k");
    expect(guard.accept(stale)).toBe(false);
    expect(guard.accept(fresh)).toBe(true);
  });

  it("**A→B→A 往返**：回到 A 后，第一次 A 的迟到响应被拒，第二次 A 的才生效", () => {
    const guard = new RequestGuard();
    const a1 = guard.begin("selected", "A");
    const b = guard.begin("selected", "B");
    const a2 = guard.begin("selected", "A");
    // 三个 token 的 key 关系：a1.key === a2.key !== b.key
    expect(a1.key).toBe(a2.key);
    expect(b.key).not.toBe(a1.key);
    expect(guard.accept(a1)).toBe(false); // 旧的 A，即便 key 与当前相同
    expect(guard.accept(b)).toBe(false);
    expect(guard.accept(a2)).toBe(true);
  });

  it("invalidate 后所有在飞 token 一律不接受", () => {
    const guard = new RequestGuard();
    const token = guard.begin("list", "k");
    guard.invalidate();
    expect(guard.accept(token)).toBe(false);
  });

  it("invalidate 使后续 begin 的代次继续递增，不会复用小值", () => {
    const guard = new RequestGuard();
    guard.begin("list", "k");
    guard.invalidate();
    const after = guard.begin("list", "k");
    expect(after.generation).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// settle：把"判定后的状态"收口
// ---------------------------------------------------------------------------

describe("settleList / settleSide：旧代次一律返回 null（一个字节都不写）", () => {
  it("当前代次的成功 → 折成 ok 状态", () => {
    const guard = new RequestGuard();
    const token = guard.begin("list", "k");
    const next = settleList(guard, token, { ok: true, data: inspectResult("a") });
    expect(next?.kind).toBe("ok");
  });

  it("当前代次的业务失败 → 折成 failed 状态（与结果层的 missing/binary 不同层）", () => {
    const guard = new RequestGuard();
    const token = guard.begin("selected", "k");
    const next = settleSide(guard, token, { ok: false, code: "READ_FAIL", message: "boom" });
    expect(next).toEqual({ kind: "failed", code: "READ_FAIL", message: "boom" });
  });

  it("**旧代次的成功也被拒**：返回 null 而不是写旧结果", () => {
    const guard = new RequestGuard();
    const stale = guard.begin("list", "k");
    guard.begin("list", "k"); // 同 key 重试
    expect(settleList(guard, stale, { ok: true, data: inspectResult("b") })).toBeNull();
  });

  it("**旧代次的失败也被拒**：不能把旧错误扣到新选择上", () => {
    const guard = new RequestGuard();
    const stale = guard.begin("selected", "k");
    guard.begin("selected", "k");
    expect(settleSide(guard, stale, { ok: false, code: "E", message: "旧错误" })).toBeNull();
  });

  it("旧代次的异常（异常也被折成 outcome 后）同样被拒", () => {
    const guard = new RequestGuard();
    const stale = guard.begin("selected", "k");
    guard.begin("selected", "k");
    // 调用方把 throw 折成 {ok:false, code:"UNEXPECTED"}
    expect(
      settleSide(guard, stale, { ok: false, code: "UNEXPECTED", message: "rejected" }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 状态查询：null 不等于"不存在"
// ---------------------------------------------------------------------------

describe("侧状态查询：失败不冒充结果，加载不冒充 idle", () => {
  it("只有 ok 才给出结果；failed/loading/idle 一律 null（**不是** not_found）", () => {
    expect(sideResult({ kind: "idle" })).toBeNull();
    expect(sideResult({ kind: "loading" })).toBeNull();
    expect(sideResult({ kind: "failed", code: "E", message: "m" })).toBeNull();
    const result = textResult("a.txt", "hi");
    expect(sideResult({ kind: "ok", result })).toBe(result);
  });

  it("loading 可分辨（旧请求 finally 不该把它抹掉——由调用方持有状态保证）", () => {
    expect(sideLoading({ kind: "loading" })).toBe(true);
    expect(sideLoading({ kind: "ok", result: textResult("a.txt", "") })).toBe(false);
    expect(sideLoading({ kind: "failed", code: "E", message: "m" })).toBe(false);
  });

  it("通道失败可与结果层的 missing/binary/not_found 分辨", () => {
    expect(sideFailed({ kind: "failed", code: "E", message: "m" })).toBe(true);
    // 结果层说"附件缺失"并不是通道失败——它是一条**真实事实**
    expect(
      sideFailed({
        kind: "ok",
        result: {
          status: "missing",
          path: "a",
          bytes: 0,
          sha256: "a".repeat(64),
          reason: "no blob",
        },
      }),
    ).toBe(false);
    expect(
      sideFailed({ kind: "ok", result: { status: "not_found", path: "a", reason: "不在清单" } }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 延迟 promise 端到端：模拟真实竞态时序
// ---------------------------------------------------------------------------

describe("延迟 promise 时序：快速切换不串清单/正文/错误/加载", () => {
  it("慢 A 的成功迟到，不覆盖已切到的 B 的成功", async () => {
    const guard = new RequestGuard();
    let resolveA: (v: { ok: true; data: WorkspaceInspectResult }) => void = () => {};
    const aPromise = new Promise<{ ok: true; data: WorkspaceInspectResult }>((r) => {
      resolveA = r;
    });

    const tokenA = guard.begin("list", "A");
    let state: ReturnType<typeof settleList> = { kind: "loading" };
    void aPromise.then((outcome) => {
      const next = settleList(guard, tokenA, outcome);
      if (next !== null) state = next;
    });

    // 切到 B 并立即成功
    const tokenB = guard.begin("list", "B");
    const bNext = settleList(guard, tokenB, { ok: true, data: inspectResult("b") });
    if (bNext !== null) state = bNext;
    expect(state?.kind).toBe("ok");

    // A 现在才回来
    resolveA({ ok: true, data: inspectResult("a") });
    await aPromise;
    await Promise.resolve();
    // 仍然是 B 的结果（不能串）
    expect(state?.kind).toBe("ok");
    if (state?.kind === "ok") {
      expect(state.result.snapshotId).toBe("b".repeat(64).slice(0, 64));
    }
  });

  it("慢 A 的**失败**迟到，不会把已成功的 B 打成错误", async () => {
    const guard = new RequestGuard();
    let resolveA: (v: { ok: false; code: string; message: string }) => void = () => {};
    const aPromise = new Promise<{ ok: false; code: string; message: string }>((r) => {
      resolveA = r;
    });

    const tokenA = guard.begin("list", "A");
    let state: ReturnType<typeof settleList> = { kind: "loading" };
    void aPromise.then((outcome) => {
      const next = settleList(guard, tokenA, outcome);
      if (next !== null) state = next;
    });

    const tokenB = guard.begin("list", "B");
    const bNext = settleList(guard, tokenB, { ok: true, data: inspectResult("b") });
    if (bNext !== null) state = bNext;

    resolveA({ ok: false, code: "E", message: "旧清单错误" });
    await aPromise;
    await Promise.resolve();
    expect(state?.kind).toBe("ok"); // 没被旧失败打成 failed
  });

  it("同一对象连续重试：只有最后一个请求的结果生效", async () => {
    const guard = new RequestGuard();
    const resolvers: Array<(v: { ok: true; data: WorkspaceReadFileResult }) => void> = [];
    const tokens = [1, 2, 3].map((i) => {
      const token = guard.begin("selected", "same-key");
      const p = new Promise<{ ok: true; data: WorkspaceReadFileResult }>((r) => {
        resolvers[i - 1] = r;
      });
      void p;
      return token;
    });

    let state: ReturnType<typeof settleSide> = { kind: "loading" };

    // 三次重试按 2 → 1 → 3 乱序返回
    const order = [1, 0, 2];
    for (const idx of order) {
      resolvers[idx]?.({ ok: true, data: textResult("a.txt", `v${idx + 1}`) });
      const next = settleSide(guard, tokens[idx]!, {
        ok: true,
        data: textResult("a.txt", `v${idx + 1}`),
      });
      if (next !== null) state = next;
    }

    expect(state?.kind).toBe("ok");
    // 只有第 3 次（最后一次 begin）生效
    if (state?.kind === "ok") {
      expect(state.result.status).toBe("text");
      expect(state.result.status === "text" && state.result.text).toBe("v3");
    }
  });
});
