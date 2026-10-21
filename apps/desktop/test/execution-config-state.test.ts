import { describe, expect, it } from "vitest";
import { ExecutionConfigState, MAIN_EXECUTION_LIMITS } from "../src/main/execution-config-state";
import type { RunSettings } from "../src/main/settings";

/**
 * R2.2 5.2：执行配置修订（ExecutionConfigState）。
 *
 * 判据（design D2）：
 * - 相同有效值重复刷新/保存 ⇒ 不轮换；
 * - 端点（含隐藏路径）、模型、密钥、执行限制变化 ⇒ 轮换；
 * - 清除后重配 ⇒ 经历 unavailable，修订必然变化；
 * - 解密失败按 unavailable 处理（不改写密钥、不把异常带进修订）；
 * - 修订是随机生成的不透明值，不由 secret 哈希构造（测试注入序列可见）。
 */

function settings(over: Partial<RunSettings> = {}): RunSettings {
  return {
    baseURL: "https://api.example.com/v1",
    model: "deepseek-chat",
    apiKey: "sk-secret-a",
    encrypted: true,
    ...over,
  };
}

function makeState(initial: RunSettings | null) {
  let current = initial;
  let failure: unknown = null;
  let seq = 0;
  const source = {
    load: (): RunSettings | null => {
      if (failure !== null) throw failure;
      return current;
    },
  };
  const state = new ExecutionConfigState(
    source,
    MAIN_EXECUTION_LIMITS,
    () => `rev-${String(++seq)}`,
  );
  return {
    state,
    setSettings: (value: RunSettings | null) => {
      current = value;
    },
    setFailure: (error: unknown) => {
      failure = error;
    },
  };
}

describe("ExecutionConfigState：修订轮换判据", () => {
  it("相同有效值重复刷新不轮换；端点/模型/密钥变化才轮换", () => {
    const h = makeState(settings());
    const first = h.state.refresh();
    expect(first.settings).toEqual(settings());
    expect(first.loadError).toBeNull();
    const rev = first.revision;

    expect(h.state.refresh().revision).toBe(rev);
    expect(h.state.refresh().revision).toBe(rev);

    h.setSettings(settings({ baseURL: "https://hidden.example.com/internal/v1" }));
    const endpointChanged = h.state.refresh();
    expect(endpointChanged.revision).not.toBe(rev);

    const rev2 = endpointChanged.revision;
    h.setSettings(settings({ baseURL: "https://hidden.example.com/internal/v1", model: "m2" }));
    const modelChanged = h.state.refresh();
    expect(modelChanged.revision).not.toBe(rev2);

    const rev3 = modelChanged.revision;
    h.setSettings(
      settings({
        baseURL: "https://hidden.example.com/internal/v1",
        model: "m2",
        apiKey: "sk-secret-b",
      }),
    );
    expect(h.state.refresh().revision).not.toBe(rev3);
  });

  it("encrypted 元信息变化不轮换（不是运行配置）", () => {
    const h = makeState(settings({ encrypted: true }));
    const rev = h.state.refresh().revision;
    h.setSettings(settings({ encrypted: false }));
    expect(h.state.refresh().revision).toBe(rev);
  });

  it("清除 → 重复不可用不轮换 → 重配同值也轮换（中间经历 unavailable）", () => {
    const h = makeState(settings());
    const original = h.state.refresh().revision;

    h.setSettings(null);
    const cleared = h.state.refresh();
    expect(cleared.settings).toBeNull();
    expect(cleared.revision).not.toBe(original);
    expect(h.state.refresh().revision).toBe(cleared.revision);

    h.setSettings(settings());
    const reconfigured = h.state.refresh();
    expect(reconfigured.settings).toEqual(settings());
    expect(reconfigured.revision).not.toBe(cleared.revision);
    expect(reconfigured.revision).not.toBe(original);
  });

  it("解密失败按 unavailable 处理并保留 loadError；恢复后轮换", () => {
    const h = makeState(settings());
    const configured = h.state.refresh().revision;

    h.setFailure(new Error("decrypt failed"));
    const failed = h.state.refresh();
    expect(failed.settings).toBeNull();
    expect(failed.loadError).toBeInstanceOf(Error);
    expect(failed.revision).not.toBe(configured);

    const failedAgain = h.state.refresh();
    expect(failedAgain.revision).toBe(failed.revision);

    h.setFailure(null);
    const recovered = h.state.refresh();
    expect(recovered.settings).toEqual(settings());
    expect(recovered.revision).not.toBe(failed.revision);
  });

  it("修订是注入的随机序列，不从密钥派生", () => {
    const h = makeState(settings({ apiKey: "sk-very-secret-value" }));
    const rev = h.state.refresh().revision;
    expect(rev).toBe("rev-2");
    expect(rev).not.toContain("secret");
    expect(rev).not.toContain("sk-");
  });
});
