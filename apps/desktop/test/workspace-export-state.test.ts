import { beforeEach, describe, expect, it } from "vitest";
import {
  feedbackFromOutcome,
  workspaceExportKey,
} from "../src/renderer/src/lib/workspace-export-state";
import type { WorkspaceExportFeedback } from "../src/renderer/src/lib/workspace-export-state";
import { ok } from "../src/shared/ipc";
import type { Envelope, WorkspaceExportOutcome } from "../src/shared/ipc";

/**
 * R2.1 任务 5.3：导出反馈的**会话状态**（store 动作 + 纯逻辑折叠）。
 *
 * delta 硬约束 → 用例映射：
 * - 反馈绑定提交 run/step/请求代次 → key/身份断言；
 * - 旧成功/失败/收尾不覆盖新对象 → 同 key 代次守卫（迟到响应整包丢弃）；
 * - 切页不中止 main 写入 → 发起后状态立即可见，响应迟到仍按 key 落库；
 * - 返回定位反馈而不抢焦点 → 数据层只提供按键读取，无任何导航/焦点副作用；
 * - 重载丢失回执 = 结果未知、不自动重发 → store 无任何自动触发（构造保证）。
 */

const EXPORTED: WorkspaceExportOutcome = {
  status: "exported",
  targetDir: "D:/out/target",
  filesRoot: "files",
  fileCount: 2,
  totalFileBytes: 9,
  snapshotId: "a".repeat(64),
  stepSpanId: "s_02",
  patch: {
    status: "written",
    file: "changes.patch",
    bytes: 120,
    sha256: "b".repeat(64),
    covered: ["a.txt"],
    excluded: [{ path: "bin.dat", reason: "binary" }],
  },
  unpreserved: {
    permissions: "未保留（原状态未知）",
    executable_bit: "未保留（原状态未知）",
    timestamps: "未保留（原状态未知）",
    links: "未保留（原状态未知）",
    empty_directories: "未保留（原状态未知）",
    external_services: "未保留（原状态未知）",
  },
};

describe("workspaceExportKey / feedbackFromOutcome（纯逻辑）", () => {
  it("键区分初始快照与自有 step；step 为 null 用固定哨兵", () => {
    expect(workspaceExportKey("r_01", null)).toBe("r_01|initial");
    expect(workspaceExportKey("r_01", "s_02")).toBe("r_01|s_02");
    expect(workspaceExportKey("r_01", null)).not.toBe(workspaceExportKey("r_01", "s_02"));
  });

  it("outcome 三态折叠成带提交身份的反馈", () => {
    const identity = { runId: "r_01", stepSpanId: "s_02" as const, generation: 7 };
    const exported = feedbackFromOutcome(identity, EXPORTED);
    expect(exported).toMatchObject({
      kind: "exported",
      runId: "r_01",
      stepSpanId: "s_02",
      generation: 7,
    });
    if (exported.kind !== "exported") return;
    expect(exported.result.patch.status).toBe("written");

    const canceled = feedbackFromOutcome(identity, { status: "canceled" });
    expect(canceled).toMatchObject({ kind: "canceled", generation: 7 });

    const failed = feedbackFromOutcome(identity, {
      status: "failed",
      code: "target_invalid",
      reason: "目标目录非空",
      retained: ["files/a.txt"],
    });
    expect(failed).toMatchObject({
      kind: "failed",
      code: "target_invalid",
      retained: ["files/a.txt"],
    });
  });
});

/** api 桩的行为控制器（与 store.test.ts 同模式：先就位再 import store） */
const controller: {
  outcomesByCall: (Envelope<WorkspaceExportOutcome> | undefined)[];
  calls: Array<{ runId: string; stepSpanId?: string }>;
} = {
  outcomesByCall: [],
  calls: [],
};

beforeEach(() => {
  controller.outcomesByCall = [];
  controller.calls.length = 0;
});

// window.api 必须在 store 模块 import 前就位（模块只读一次）
(globalThis as Record<string, unknown>).window = {
  api: {
    exportCheckpoint: async (request: { runId: string; stepSpanId?: string }) => {
      controller.calls.push(request);
      const index = controller.calls.length - 1;
      return controller.outcomesByCall[index] ?? ok<WorkspaceExportOutcome>({ status: "canceled" });
    },
  },
};
// store 模块在其 import 的瞬间读 window.api——上面的 stub 必须先就位
const { useAppStore } = await import("../src/renderer/src/store");

describe("store.exportCheckpoint（会话反馈流转）", () => {
  /** 把导出会话状态复位（zustand 单例跨用例存活） */
  function resetExportState(): void {
    useAppStore.setState({ workspaceExports: {}, workspaceExportGenerations: {} });
  }

  beforeEach(() => {
    resetExportState();
  });

  it("成功导出：反馈绑定 run/step/generation，目标与补丁事实原样保存", async () => {
    controller.outcomesByCall = [ok(EXPORTED)];
    const outcome = await useAppStore.getState().exportCheckpoint({
      runId: "r_01",
      stepSpanId: "s_02",
    });
    expect(outcome).toEqual(EXPORTED);
    const feedback = useAppStore.getState().workspaceExports["r_01|s_02"];
    expect(feedback).toMatchObject({
      kind: "exported",
      runId: "r_01",
      stepSpanId: "s_02",
      generation: 1,
    });
    if (feedback?.kind !== "exported") return;
    expect(feedback.result.patch).toEqual(EXPORTED.patch);
    expect(feedback.result.unpreserved.permissions).toContain("未保留");
  });

  it("发起即 in-flight；取消/失败各自可辨认（失败带残留相对路径）", async () => {
    controller.outcomesByCall = [
      { ok: false, error: { code: "INVALID_ARGUMENT", message: "形状非法" } },
    ];
    const pending = useAppStore.getState().exportCheckpoint({ runId: "r_01" });
    expect(useAppStore.getState().workspaceExports["r_01|initial"]).toMatchObject({
      kind: "in-flight",
      stepSpanId: null,
      generation: 1,
    });
    await pending;

    const feedback = useAppStore.getState().workspaceExports["r_01|initial"];
    // 信封失败折成受控 failed（程序性拒绝也是反馈，不是异常）
    expect(feedback).toMatchObject({ kind: "failed", code: "INVALID_ARGUMENT", retained: [] });
  });

  it("同 key 迟到的旧响应不覆盖新提交：代次守卫整包丢弃", async () => {
    // 第一次调用挂起；第二次立即返回新结果；然后放行第一次的迟到响应
    const secondCanceled: WorkspaceExportOutcome = { status: "canceled" };
    controller.outcomesByCall = [ok(EXPORTED), ok(secondCanceled)];
    controller.calls.length = 0;

    const first = useAppStore.getState().exportCheckpoint({ runId: "r_01", stepSpanId: "s_02" });
    // 第一次已在飞；发起第二次（同 key 重试，代次 +1）
    const second = useAppStore.getState().exportCheckpoint({ runId: "r_01", stepSpanId: "s_02" });
    const secondOutcome = await second;
    expect(secondOutcome).toEqual(secondCanceled);
    expect(useAppStore.getState().workspaceExports["r_01|s_02"]).toMatchObject({
      kind: "canceled",
      generation: 2,
    });

    // 迟到的第一次响应：被代次守卫丢弃——返回 null（反馈已归新提交），状态不回退
    const lateOutcome = await first;
    expect(lateOutcome).toBeNull();
    expect(useAppStore.getState().workspaceExports["r_01|s_02"]).toMatchObject({
      kind: "canceled",
      generation: 2,
    });
  });

  it("不同 key 互不影响：A 的失败不影响 B 的成功", async () => {
    controller.outcomesByCall = [
      ok({
        status: "failed",
        code: "attachment_unavailable",
        reason: "附件缺失",
        retained: [],
      }),
      ok(EXPORTED),
    ];
    controller.calls.length = 0;
    await useAppStore.getState().exportCheckpoint({ runId: "r_a", stepSpanId: "s_01" });
    await useAppStore.getState().exportCheckpoint({ runId: "r_b", stepSpanId: "s_01" });
    expect(useAppStore.getState().workspaceExports["r_a|s_01"]).toMatchObject({
      kind: "failed",
      code: "attachment_unavailable",
    });
    expect(useAppStore.getState().workspaceExports["r_b|s_01"]).toMatchObject({
      kind: "exported",
    });
  });

  it("outcome 结构非法：折成 EXPORT_SCHEMA_INVALID 的 failed，不跨进程异常", async () => {
    controller.outcomesByCall = [ok({ status: "nonsense" } as unknown as WorkspaceExportOutcome)];
    const outcome = await useAppStore.getState().exportCheckpoint({ runId: "r_01" });
    expect(outcome).toMatchObject({ status: "failed", code: "EXPORT_SCHEMA_INVALID" });
    expect(useAppStore.getState().workspaceExports["r_01|initial"]).toMatchObject({
      kind: "failed",
      code: "EXPORT_SCHEMA_INVALID",
    });
  });

  it("切页语义：没有取消通道、迟到响应仍按 key 落库（构造保证，这里验证无 abort 入口）", async () => {
    const action = useAppStore.getState().exportCheckpoint;
    // 类型/形状层面：动作之外不存在 cancel/abort 类入口
    const storeKeys = Object.keys(useAppStore.getState()).filter((key) =>
      /cancel|abort/i.test(key),
    );
    expect(storeKeys).toEqual([]);
    expect(typeof action).toBe("function");
  });

  it("类型检查：反馈形状与 WorkspaceExportFeedback 对齐（编译期钉死）", () => {
    const feedback: WorkspaceExportFeedback = feedbackFromOutcome(
      { runId: "r", stepSpanId: null, generation: 1 },
      { status: "canceled" },
    );
    expect(feedback.kind).toBe("canceled");
  });
});
