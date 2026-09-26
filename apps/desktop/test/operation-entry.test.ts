import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OperationRecord } from "@shared/operations";
import { describe, expect, it } from "vitest";
import {
  deriveOperationRows,
  hasWatchableOperation,
  operationBadge,
} from "../src/renderer/src/lib/operation-list";
import { type OperationSession, initialSession } from "../src/renderer/src/lib/operation-session";

/**
 * U4 任务 4.7：全局栏「操作」入口。
 *
 * 判据来源：tasks.md 4.7 + design D6；delta spec `desktop-ui`（逐字标题）：
 * - 「所有入口实际使用同一适配器」的后半段——入口能查到**同一条登记**（数据源就是
 *   `operations` 会话快照，不是第二份状态）；
 * - 「结果不可读不重执行且不锁配置」——运行 ID 只作为"打开记录"的定位，
 *   派生行不带任何"重跑/重试执行"的动作；
 * - 「核对结果只由用户明确打开」——核对与轮询都不导航，只有"打开记录"切页面；
 * - 「操作入口在窄窗口和键盘下可达」——按钮可聚焦、面板受视口宽度约束、长 ID 断行不遮挡；
 * - 「不显示虚构阶段、百分比或取消能力」——派生值只有四种状态标签，
 *   组件里不该出现进度条/百分比/停止按钮。
 *
 * 组件形状按源码级接线契约钉（本仓无 jsdom 环境，与 `modal-dialog.test.ts` 等同法）。
 */

const EPOCH = "11111111-1111-4111-8111-111111111111";
const OLD_EPOCH = "22222222-2222-4222-8222-222222222222";
const OP_RUNNING = "aaaaaaaa-0000-4000-8000-000000000001";
const OP_DONE = "bbbbbbbb-0000-4000-8000-000000000002";
const OP_BANNED = "cccccccc-0000-4000-8000-000000000003";
const OP_STALE = "dddddddd-0000-4000-8000-000000000004";

function record(
  operationId: string,
  state: OperationRecord["state"],
  overrides: Partial<OperationRecord> = {},
): OperationRecord {
  const base: OperationRecord = {
    epoch: EPOCH,
    operationId,
    target: { kind: "modelAb", parentRunId: "run_parent", armCount: 2 },
    state,
    rejection: null,
    startedAt: "2026-09-26T00:00:00.000Z",
    settledAt: state === "running" ? null : "2026-09-26T00:00:05.000Z",
    runIds: state === "running" ? [] : ["run_child_one", "run_child_two"],
    experimentId: "exp_one",
    arms: [],
    requestOutcome: state === "settled" ? "returned" : null,
    errorCode: null,
    diagnostics:
      state === "running" ? [] : [{ code: "ARM_FAILED", stage: "execute", message: "一臂失败" }],
  };
  if (state === "notAccepted") {
    return {
      ...base,
      startedAt: null,
      settledAt: null,
      rejection: "reconcile_tombstone",
      target: null,
      runIds: [],
      experimentId: null,
      diagnostics: [],
    };
  }
  return { ...base, ...overrides };
}

function sessionWith(overrides: Partial<OperationSession>): OperationSession {
  return { ...initialSession(), epoch: EPOCH, ...overrides };
}

const ENTRY = resolve(import.meta.dirname, "../src/renderer/src/components/OperationsEntry.tsx");
const BAR = resolve(import.meta.dirname, "../src/renderer/src/components/GlobalBar.tsx");

describe("4.7 入口的数据派生（只报 main 给得出的事实）", () => {
  const rows = deriveOperationRows(
    sessionWith({
      operations: [record(OP_DONE, "settled"), record(OP_RUNNING, "running")],
    }),
  );

  it("四种状态各有中文标签；A/B 行带臂数与实验号，不编造阶段", () => {
    const running = rows.find((one) => one.operationId === OP_RUNNING);
    const done = rows.find((one) => one.operationId === OP_DONE);
    expect(running?.phase).toBe("running");
    expect(running?.kindLabel).toBe("模型 A/B");
    expect(running?.targetText).toContain("2 臂");
    expect(running?.runLinks).toEqual([]);
    expect(done?.hint).toContain("不等于运行成功");
    expect(done?.experimentId).toBe("exp_one");
    expect(done?.diagnosticCount).toBe(1);
    // settled 的 runIds 是身份，note 明说"未确认文件可读"
    expect(done?.runLinks[0]?.note).toContain("未确认文件可读");
  });

  it("新的在前、封禁与未知历史都保留（不按面板开合或本地关联裁剪）", () => {
    const withAll = deriveOperationRows(
      sessionWith({
        operations: [
          record(OP_DONE, "settled"),
          record(OP_RUNNING, "running"),
          record(OP_BANNED, "notAccepted"),
        ],
        pending: [{ epoch: OLD_EPOCH, operationId: OP_STALE }],
      }),
    );
    // 后登记的在前（快照按登记顺序，入口倒序展示），未知历史殿后且不丢任何一条
    expect(withAll.map((one) => one.operationId)).toEqual([
      OP_BANNED,
      OP_RUNNING,
      OP_DONE,
      OP_STALE,
    ]);
    const stale = withAll.find((one) => one.operationId === OP_STALE);
    expect(stale?.phase).toBe("unknown");
    expect(stale?.kindLabel).toBeNull();
    expect(stale?.runLinks).toEqual([]);
    // 封禁行没有目标事实，但不能被省略
    expect(withAll.find((one) => one.operationId === OP_BANNED)?.targetText).toContain("封禁");
  });

  it("按钮上的最小事实只有计数（没有百分比），并标出是否需要盯", () => {
    expect(operationBadge(rows).label).toBe("操作 2 · 执行中 1");
    expect(operationBadge(rows).attention).toBe(true);
    const idle = deriveOperationRows(sessionWith({ operations: [record(OP_DONE, "settled")] }));
    expect(operationBadge(idle)).toEqual({ label: "操作 1", attention: false });
    expect(operationBadge([]).label).toBe("操作 0");
  });

  it("有 running / 本地在飞 / 旧未知历史才需要继续盯着", () => {
    expect(hasWatchableOperation(sessionWith({ operations: [record(OP_DONE, "settled")] }))).toBe(
      false,
    );
    expect(
      hasWatchableOperation(sessionWith({ operations: [record(OP_RUNNING, "running")] })),
    ).toBe(true);
    expect(
      hasWatchableOperation(sessionWith({ pending: [{ epoch: EPOCH, operationId: OP_STALE }] })),
    ).toBe(true);
    expect(
      hasWatchableOperation(
        sessionWith({ pending: [{ epoch: OLD_EPOCH, operationId: OP_STALE }] }),
      ),
    ).toBe(true);
  });
});

describe("4.7 接线契约：入口挂在既有全局栏，且两种查询不混用", () => {
  const entry = readFileSync(ENTRY, "utf8");
  const bar = readFileSync(BAR, "utf8");

  it("挂在现有全局栏（不新开一处界面），数据源就是 operations 会话", () => {
    expect(bar).toContain("<OperationsEntry />");
    expect(entry).toContain("useAppStore((s) => s.operations)");
    // 不另起一份登记状态
    expect(entry).not.toContain("useState<OperationRecord");
  });

  it("核对只发 reconcile(operationId)，打开只走 reopenRun(runId)", () => {
    const reconcile = entry.slice(
      entry.indexOf("onReconcile={(operationId)"),
      entry.indexOf("onOpenRun={(runId)"),
    );
    expect(reconcile).toContain("reconcileOperation(operationId)");
    expect(reconcile).not.toContain("reopenRun(");
    const open = entry.slice(entry.indexOf("onOpenRun={(runId)"));
    expect(open).toContain("reopenRun(runId)");
    expect(open).not.toContain("reconcileOperation(");
    // 「按同 ID 重试读取」要有真通道：selectRun 对已选中同 ID 会短路 ⇒ 入口不能用它
    expect(entry).not.toContain("selectRun(");
    // 两个动作的入参类型不同名 ⇒ 想混用得改代码
    expect(entry).toContain("onReconcile: (operationId: string) => void");
    expect(entry).toContain("onOpenRun: (runId: string) => void");
  });

  it("不显示进度/百分比/停止按钮；不自动导航（核对与刷新都留面板在原处）", () => {
    // 只看**UI 手段**（注释里出现"停止/百分比"这类词是允许且必要的，不能拿来当断言对象）
    for (const affordance of [
      "<progress",
      "aria-valuenow",
      'role="progressbar"',
      "abort(",
      "cancelExecution",
      "%",
    ]) {
      expect(entry, affordance).not.toContain(affordance);
    }
    // 状态标签恰好四种，没有第五种"阶段"
    const labels = entry.slice(
      entry.indexOf("const PHASE_LABELS"),
      entry.indexOf("function OperationRowView"),
    );
    expect(labels.match(/: "/g)).toHaveLength(4);
    // 只有"打开记录"会收起面板并切页面
    expect(
      entry.slice(entry.indexOf("onOpenRun={(runId)")).indexOf("setOpen(false)"),
    ).toBeGreaterThan(-1);
    expect(
      entry.slice(entry.indexOf("onReconcile={(operationId)"), entry.indexOf("onOpenRun={(runId)")),
    ).not.toContain("setOpen(false)");
  });

  it("窄窗口与键盘可达：受视口宽度约束、长 ID 断行、按钮可聚焦且带 aria 关系", () => {
    expect(entry).toContain("max-w-[90vw]");
    expect(entry).toContain("overflow-y-auto");
    expect(entry).toContain("break-all");
    expect(entry).toContain("aria-expanded");
    expect(entry).toContain('aria-controls="operations-panel"');
    expect(entry).toContain('id="operations-panel"');
    expect(entry).toContain("FOCUS_RING");
  });
});
