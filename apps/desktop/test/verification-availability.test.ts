import { describe, expect, it } from "vitest";
import { R3Availability } from "../src/main/verification-availability";
import { VerificationInFlightRegistry } from "../src/main/verification-endpoints";

/**
 * R3 可用性分层（4.5；验收 D10/P22/P23 切片）：启动核查未完成/blocked ⇒ 执行面
 * 拒绝且诊断可行动；只读面与旧能力不在本门内（分层可用性）；关闭协商开始 ⇒
 * 请求停止全部在飞 R3（等待真实收尾）。
 */

describe("R3Availability（4.5 执行面唯一门）", () => {
  it("初态 checking：gate 拒绝且码为 R3_STARTUP_CHECKING（不与残留清理并发）", () => {
    const availability = new R3Availability();
    expect(availability.snapshot().state).toBe("checking");
    const gate = availability.gate();
    expect(gate).toMatchObject({ ok: false, code: "R3_STARTUP_CHECKING" });
  });

  it("核查干净 ⇒ available；daemon 不可达/归属不明 ⇒ blocked + 诊断透传（D10/P23）", () => {
    const availability = new R3Availability();
    availability.setAvailable();
    expect(availability.gate()).toEqual({ ok: true });
    availability.setBlocked("存在归属不明的带 owner 标签容器（1 个），R3 保持阻断且未触碰（P23）");
    expect(availability.snapshot().state).toBe("blocked");
    const gate = availability.gate();
    expect(gate).toMatchObject({ ok: false, code: "R3_BLOCKED" });
    if (gate.ok === false) expect(gate.reason).toContain("P23");
  });

  it("blocked 后重新 available（下一次启动核查成功可解除——按会话内状态机）", () => {
    const availability = new R3Availability();
    availability.setBlocked("daemon 不可达");
    availability.setAvailable();
    expect(availability.gate()).toEqual({ ok: true });
    expect(availability.snapshot().reason).toBeNull();
  });
});

describe("在飞登记的 requestStopAll（4.5：正常关闭先停止 R3）", () => {
  it("请求停止全部在飞条目并返回计数；空登记 ⇒ 0", () => {
    const registry = new VerificationInFlightRegistry();
    expect(registry.requestStopAll()).toBe(0);
    const a = registry.register("op-a", "ver-a");
    const b = registry.register("op-b", "ver-b");
    expect(a.isRequested()).toBe(false);
    expect(b.isRequested()).toBe(false);
    expect(registry.requestStopAll()).toBe(2);
    expect(a.isRequested()).toBe(true);
    expect(b.isRequested()).toBe(true);
    // 注销后的条目不再受影响（迟到的关闭不停止新会话之外的东西）
    registry.unregister("op-a");
    expect(registry.requestStopAll()).toBe(1);
  });
});
