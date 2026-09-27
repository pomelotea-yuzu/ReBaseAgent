import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * U3 任务 5.2：放弃确认接真模态 + Esc 只关最上层（design D7）。
 *
 * 判据来源：tasks.md 5.2——「放弃确认接模态包装，最上层 Esc、Monaco 弹层优先
 * 和触发点失效回退」。
 * 验收场景：
 * - Esc 只关闭最上层并恢复焦点（ModalDialog 原生 top layer 承担，见 5.1）；
 * - 放弃可取消且只影响指定目标（requestConfirm 的取消=false + 各执行点修订 CAS）。
 *
 * ⚠️ 无 jsdom ⇒ 行为归 §6 CDP；本组钉：
 *   ① 确认队列的纯逻辑（单实例挂起、后来请求直接拒绝）；
 *   ② 接线契约：放弃确认全部迁出 window.confirm（同步原生），执行类确认保留原生。
 */

describe("U3 5.2 requestConfirm：单实例挂起与取消语义", () => {
  it("无宿主消费时首个请求挂起；等待期间的新请求立即拒绝（false=取消语义）", async () => {
    // 动态引入以隔离模块级 pending 状态
    const mod = await import("../src/renderer/src/components/ConfirmDialog");
    const first = mod.requestConfirm({ title: "t", message: "m" });
    const second = await mod.requestConfirm({ title: "t2", message: "m2" });
    // 单实例纪律：第二个请求被直接拒绝
    expect(second).toBe(false);
    // 首个请求仍挂起（宿主 settle 前不决议）——用哨兵竞速验证"未决议"
    const sentinel = await Promise.race([
      first.then(() => "settled" as const),
      Promise.resolve().then(() => "pending" as const),
    ]);
    expect(sentinel).toBe("pending");
  });

  it("宿主渲染契约：取消为初始焦点、确认按钮可改标签", () => {
    const src = readFileSync(
      resolve(import.meta.dirname, "../src/renderer/src/components/ConfirmDialog.tsx"),
      "utf8",
    );
    expect(src).toContain("initialFocusRef={cancelRef}");
    expect(src).toContain("确认放弃");
    // ModalDialog 是唯一容器（复用 5.1 的 top layer 语义）
    expect(src).toContain("<ModalDialog");
    // settle 必须清 pending（宿主不残留旧请求）
    expect(src).toContain("pendingConfirm = null;");
    // 取消路径有两条：ModalDialog onClose（Esc）+ 取消按钮——都必须 settle(false)。
    // 无 jsdom 走不到 onClose ⇒ 以结构断言钉住（行为归 §6 CDP）
    expect((src.match(/settle\(false\)/g) ?? []).length).toBe(2);
  });
});

describe("U3 5.2 接线契约（源码级）：放弃确认迁出 window.confirm", () => {
  const detail = readFileSync(
    resolve(import.meta.dirname, "../src/renderer/src/components/DetailPanel.tsx"),
    "utf8",
  );
  const create = readFileSync(
    resolve(import.meta.dirname, "../src/renderer/src/components/CreateRunWorkspace.tsx"),
    "utf8",
  );
  const globalBar = readFileSync(
    resolve(import.meta.dirname, "../src/renderer/src/components/GlobalBar.tsx"),
    "utf8",
  );

  it("放弃确认全部经 requestConfirm（DetailPanel 9 处 + 创建 1 处）", () => {
    // 列表1 + prompt 字段/横幅2 + result 字段/横幅2 + messages 字段/横幅2 + A/B 整批/横幅2
    expect(detail).toContain("void requestConfirm({");
    const detailCount = (detail.match(/requestConfirm\(\{/g) ?? []).length;
    expect(detailCount).toBe(9);
    expect(create).toContain("void requestConfirm({");
    // 全会话入口（GlobalBar）的放弃点同样迁移
    expect(globalBar).toContain("void requestConfirm({");
    // 放弃类调用点不得再出现同步原生确认
    expect(detail).not.toContain('window.confirm("放弃');
    expect(detail).not.toContain("window.confirm(\n      `放弃");
    expect(create).not.toContain("window.confirm");
    expect(globalBar).not.toContain("window.confirm");
  });

  it("执行确认的原生 window.confirm 只剩 A/B 一处（U5 4.6 迁走 prompt 与 messages）", () => {
    // U3 时代有三处执行确认：prompt 从头重跑 / A/B 实验 / proxy messages 重发。
    // U5 任务 4.6 把后两处之外的 prompt 与 messages 换成"就地核对 + 一次性确认凭据"
    //（判据在 lib/execution-confirmation.ts，执法点在 store.beginDraftSubmission）；
    // A/B 那一处仍走原生确认，其"当前预览计划确认 + 修订失效"由 §4.7 收口。
    const count = (detail.match(/window\.confirm/g) ?? []).length;
    expect(count).toBe(1);
    expect(detail).toContain("确认执行模型 A/B 实验？");
    expect(detail).not.toContain("确认从头重跑？");
    expect(detail).not.toContain("确认重发？");
  });

  it("异步确认后 CAS 仍按快照修订校验（旧确认不能删新修订）", () => {
    // 每个放弃执行点必须用快照 revision 而非实时 revision 调 discard
    expect(detail).toContain("discardCallDraft(draftKeyOf(field), snapshot.revision)");
    expect(detail).toContain("discardCallDraft(draftKey, snapshot.revision)");
    expect(detail).toContain("discardModelAbDraft(draftKey, snapshot.revision)");
    expect(create).toContain("discardCreateRunDraft(current.revision)");
  });
});
