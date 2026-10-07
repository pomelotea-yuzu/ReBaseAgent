import type { ProxyState, SettingsState } from "@shared/ipc";
import { describe, expect, it } from "vitest";
import type { DraftSubmitTarget } from "../src/renderer/src/lib/draft-submission";
import {
  armConfirmation,
  decideConfirmation,
  emptyConfirmationStore,
  settingsStampOf,
} from "../src/renderer/src/lib/execution-confirmation";
import type { ConfirmationBinding } from "../src/renderer/src/lib/execution-confirmation";
import { proxyStateFixture } from "./helpers/proxy-state-fixture";

/**
 * tasks 2.2a：**执行确认绑定凭据捕获版本与真实监听/配置语义**。
 *
 * 判据来源：desktop-ui delta「重发门禁使用当前代理事实且隔离迟到读取」——
 * 「确认 SHALL 绑定语义状态及捕获版本，监听/配置/凭据变化撤销旧确认，
 * 重复同事实读取不撤销已核对确认」。
 *
 * 要证伪的三件事，逐条对应本文件三组：
 * 1. `hasKey=true → true` 的**凭据更换**必须作废旧确认（靠捕获版本，不是靠布尔）；
 * 2. 监听/上游配置变化必须作废（打去别处 = 花别处的钱）；
 * 3. 重复读**同一组语义值**必须**不**作废（读几次都不该逼用户重新核对）。
 */

const settings = (over: Partial<SettingsState> = {}): SettingsState =>
  ({
    configured: true,
    encryption: "safe",
    model: "deepseek-chat",
    baseURL: "https://api.deepseek.com/v1",
    ...over,
  }) as SettingsState;

const TARGET: DraftSubmitTarget = { runId: "r_01", spanId: "s_02", field: "messages" };

function binding(stamp: string, over: Partial<ConfirmationBinding> = {}): ConfirmationBinding {
  return {
    channel: "messages",
    target: TARGET,
    revision: 2,
    settingsStamp: stamp,
    generation: 0,
    ...over,
  };
}

const stampOf = (proxy: ProxyState | null): string =>
  settingsStampOf({ settings: settings(), proxy });

/** 代理在跑、已捕获 key 的基线现场 */
const live = (over: Partial<ProxyState> = {}): ProxyState =>
  proxyStateFixture({
    running: true,
    enabled: true,
    port: 18787,
    upstreamBaseUrl: "https://api.deepseek.com/v1",
    hasKey: true,
    keyCaptureRevision: 3,
    ...over,
  });

describe("2.2a 凭据轮换撤销旧确认", () => {
  it("hasKey 同样为 true、只换捕获版本 ⇒ 旧确认作废", () => {
    const armed = armConfirmation(emptyConfirmationStore(), binding(stampOf(live())));
    // 捕获版本推进 = 换了 key（布尔一位都没变）
    const rotated = decideConfirmation(armed, binding(stampOf(live({ keyCaptureRevision: 4 }))));
    expect(rotated.kind).toBe("stale");
    expect(rotated.kind === "stale" ? rotated.reason : "").toContain("凭据");
  });

  it("🔴 变异靶：只绑 hasKey 的旧实现挡不住这条（指纹逐字相同 ⇒ confirmed）", () => {
    // 这条断言是本任务存在意义的自证：若无捕获版本，两次指纹全等。
    const before = stampOf(live({ keyCaptureRevision: 3 }));
    const after = stampOf(live({ keyCaptureRevision: 4 }));
    expect(before).not.toBe(after);
  });

  it("捕获版本只在真捕获时推进：hasKey 一直是 true 到版本 1，也算换了 key", () => {
    const armed = armConfirmation(
      emptyConfirmationStore(),
      binding(stampOf(live({ keyCaptureRevision: 1 }))),
    );
    expect(decideConfirmation(armed, binding(stampOf(live({ keyCaptureRevision: 2 })))).kind).toBe(
      "stale",
    );
  });

  it("未捕获（hasKey=false）时捕获版本不同也作废：事实从「没 key」变成「有 key」", () => {
    const armed = armConfirmation(
      emptyConfirmationStore(),
      binding(stampOf(live({ hasKey: false, keyCaptureRevision: 0 }))),
    );
    expect(
      decideConfirmation(armed, binding(stampOf(live({ hasKey: true, keyCaptureRevision: 1 }))))
        .kind,
    ).toBe("stale");
  });
});

describe("2.2a 监听与上游配置变化撤销旧确认", () => {
  it("upstream 换了、running 仍为 true ⇒ 作废（这次打去别处）", () => {
    const armed = armConfirmation(emptyConfirmationStore(), binding(stampOf(live())));
    const moved = decideConfirmation(
      armed,
      binding(stampOf(live({ upstreamBaseUrl: "https://other.example.com/v1" }))),
    );
    expect(moved.kind).toBe("stale");
  });

  it("端口换了、running 仍为 true ⇒ 作废", () => {
    const armed = armConfirmation(emptyConfirmationStore(), binding(stampOf(live())));
    expect(decideConfirmation(armed, binding(stampOf(live({ port: 18888 })))).kind).toBe("stale");
  });

  it("监听停掉 ⇒ 作废（已由既有 proxy-on/off 覆盖，这里钉住不回归）", () => {
    const armed = armConfirmation(emptyConfirmationStore(), binding(stampOf(live())));
    expect(decideConfirmation(armed, binding(stampOf(live({ running: false })))).kind).toBe(
      "stale",
    );
  });

  it("🔴 变异靶：只有 running 布尔时，upstream/端口变化指纹全等", () => {
    expect(stampOf(live({ upstreamBaseUrl: "https://a/v1" }))).not.toBe(
      stampOf(live({ upstreamBaseUrl: "https://b/v1" })),
    );
  });
});

describe("2.2a 重复只读核对不撤销未变化的确认", () => {
  it("同会话重复回读相同语义状态与捕获版本 ⇒ 指纹逐字相同、确认保留", () => {
    const first = stampOf(live());
    const second = stampOf(live());
    const third = stampOf(live());
    expect(second).toBe(first);
    expect(third).toBe(first);
    const armed = armConfirmation(emptyConfirmationStore(), binding(first));
    expect(decideConfirmation(armed, binding(third)).kind).toBe("confirmed");
  });

  it("🔴 变异靶：把读取代次/revision 写进指纹 ⇒ 这条会红（revision 每次读取同值也不变，epoch 亦然）", () => {
    // 说明为什么指纹只能用语义值：proxy:status 每次返回同一组语义事实，
    // 任何"读取次数/代次"型字段都不在这条路径上变化（真正推进它们的是事实变化）。
    const reads = [0, 1, 2, 3].map(() => stampOf(live()));
    expect(new Set(reads).size).toBe(1);
  });

  it("反复 arm 同一现场不制造新状态（引用稳定，不触发重绘风暴）", () => {
    const armed = armConfirmation(emptyConfirmationStore(), binding(stampOf(live())));
    expect(armConfirmation(armed, binding(stampOf(live())))).toBe(armed);
  });

  it("状态未读（proxy=null）⇒ 与任何已读现场都不同：未知不能冒充已核对", () => {
    expect(stampOf(null)).not.toBe(stampOf(live()));
    expect(stampOf(null)).toContain("proxy-unread");
  });
});
