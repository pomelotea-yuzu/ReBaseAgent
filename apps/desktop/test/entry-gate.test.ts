import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveEntryGate } from "../src/renderer/src/lib/entry-gate";
import { type OperationSession, initialSession } from "../src/renderer/src/lib/operation-session";

/**
 * U4 任务 4.3：create 与 result（普通/隔离）两个入口的**界面门禁派生**。
 *
 * 判据来源：tasks.md 4.3 + design D6；delta spec `desktop-ui`：
 * - 「初始握手失败禁用主动入口」/「所有入口实际使用同一适配器」——入口可用性一律
 *   从 `operations` 会话派生（`deriveEntryGate`），不再各判一套本地 `in_progress`；
 * - 禁用**必须有可见理由**：按钮只置灰 = 死按钮，`notice` 要说清为什么、下一步做什么；
 * - 门禁只拦"再发一条"，**不锁输入、不锁关闭、不锁只读预检**——那是"自己那次提交在飞"
 *   才需要的冻结（U3 的 `draftFrozen` 语义），两者混起来会让别人的操作把这份草稿冻住；
 * - 只有通信未知才引导"去核对状态"（拿它当通用文案会误导用户去核对一个正在跑的操作）。
 *
 * 组件形状用源码级接线契约钉（与 `test/layout.test.ts`、`create-form-draft.test.ts` 同法）：
 * 这三条都是"少接一支就静默失效"的接线判据，纯 reducer 测不到。
 */

const DIALOG = resolve(import.meta.dirname, "../src/renderer/src/components/CreateRunDialog.tsx");
const PANEL = resolve(import.meta.dirname, "../src/renderer/src/components/DetailPanel.tsx");

function sessionWith(overrides: Partial<OperationSession>): OperationSession {
  return { ...initialSession(), ...overrides };
}

describe("4.3 入口门禁的派生（纯判据）", () => {
  it("空闲会话 ⇒ 可提交且无提示；未握手 ⇒ 禁用并给提示", () => {
    const fresh = deriveEntryGate(initialSession());
    expect(fresh.canSubmit).toBe(false);
    expect(fresh.blockedBy).toBe("not_handshaked");
    expect(fresh.notice).toContain("握手");
    expect(fresh.shouldReconcile).toBe(false);

    const idle = deriveEntryGate(sessionWith({ epoch: "e-1" }));
    expect(idle).toEqual({
      canSubmit: true,
      blockedBy: null,
      notice: null,
      shouldReconcile: false,
    });
  });

  it("五种禁用原因各给一句可读理由，且只有通信未知引导核对", () => {
    const cases: [OperationSession, string][] = [
      [sessionWith({}), "握手"],
      [sessionWith({ epoch: "e-1", unknown: true }), "核对"],
      [sessionWith({ epoch: "e-1", closing: true }), "退出"],
      [sessionWith({ epoch: "e-1", configurationBusy: true }), "变更"],
      [sessionWith({ epoch: "e-1", activeOperationId: "op-1" }), "已有操作"],
    ];
    const reconciles: boolean[] = [];
    for (const [session, keyword] of cases) {
      const gate = deriveEntryGate(session);
      expect(gate.canSubmit, keyword).toBe(false);
      expect(gate.notice, keyword).toBeTruthy();
      expect(gate.notice, `${keyword} 的理由文案`).toContain(keyword);
      reconciles.push(gate.shouldReconcile);
    }
    expect(reconciles).toEqual([false, true, false, false, false]);
  });

  it("本地尚未确认的提交同样禁用入口（与 main 槽同源）", () => {
    const gate = deriveEntryGate(
      sessionWith({ epoch: "e-1", pending: [{ epoch: "e-1", operationId: "op-1" }] }),
    );
    expect(gate.canSubmit).toBe(false);
    expect(gate.blockedBy).toBe("operation_running");
  });
});

describe("4.3 接线契约：create 与 result 都从同一份会话派生", () => {
  const dialog = readFileSync(DIALOG, "utf8");
  const panel = readFileSync(PANEL, "utf8");

  it("两个入口都读 s.operations 并经 deriveEntryGate 判定", () => {
    for (const [src, label] of [
      [dialog, "CreateRunDialog"],
      [panel, "DetailPanel（result 编辑器）"],
    ] as const) {
      expect(src, label).toContain("deriveEntryGate(useAppStore((s) => s.operations))");
    }
  });

  it("门禁 AND 进提交判据，但没有并进输入锁/关闭锁/只读预检", () => {
    // create：canCreate 含 gate，modalLocked 不含 gate（门禁不该锁输入与关闭）
    expect(dialog).toMatch(/const canCreate = submission\.ok && !draftFrozen && gate\.canSubmit/);
    const locked = dialog.slice(
      dialog.indexOf("const modalLocked"),
      dialog.indexOf("\n", dialog.indexOf("const modalLocked")),
    );
    expect(locked).not.toContain("gate.");
    // result：canFork 含 gate
    expect(panel).toMatch(
      /const canFork = canSubmit && sourceExecutable && sourceBlocked === null && gate\.canSubmit/,
    );
    // 只读能力预检不受主动槽影响（spec「只读入口和被动录制不占主动槽」）
    const checkAllowed = panel.slice(
      panel.indexOf("const checkAllowed"),
      panel.indexOf("\n", panel.indexOf("const checkAllowed")),
    );
    expect(checkAllowed).not.toContain("gate.");
    // 本地"自己那次提交在飞"仍走 inProgress/busy，不与门禁混用
    expect(panel).toContain('const inProgress = forking === "in_progress" || draftFrozen;');
  });

  it("禁用理由真的渲染出来（不是只改 disabled 的死按钮）", () => {
    expect(panel).toContain("gate.notice !== null");
    expect(dialog).toContain("blockedReason");
    // create 侧：submission 自身判据通过时，理由回落到门禁文案
    expect(dialog).toMatch(
      /const blockedReason = submission\.ok \? gate\.notice : submission\.reason/,
    );
  });
});
