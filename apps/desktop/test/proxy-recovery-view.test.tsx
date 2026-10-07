import type { ProxyState } from "@shared/ipc";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  RecordingWorkspaceView,
  recordingStatusLines,
  verifiedProxyAddress,
} from "../src/renderer/src/components/RecordingWorkspaceView";
import { proxyPhaseDotClass, proxyRecoveryView } from "../src/renderer/src/lib/proxy-recovery-view";
import { ensureRecordingDraft, writeRecordingDraft } from "../src/renderer/src/lib/recording-draft";

/**
 * tasks 2.3b：**代理启动恢复结果就近可见**（呈现半边）。
 *
 * 判据来源：desktop-ui delta 三个场景：
 * - 「恢复中到监听成功同步呈现」→ 从恢复中更新为已监听，不停留在旧停止状态；
 *   本会话未捕获凭据时如实显示未捕获，历史阅读不中断；
 * - 「恢复失败显示意图与实际状态」→ 已启用但未监听 + 受控原因可见，
 *   不把失败说成已停用 / 凭据可用 / 监听成功；
 * - 「状态重读与显式应用重试区分」→ 重读只读；显式应用才尝试监听。
 *
 * 本包无 jsdom：呈现能力用 renderToStaticMarkup 打在本组件（喂 props）。
 * 判据层（`proxyRecoveryView`）与呈现层（顶栏/录制页共用同一份）都断言，
 * 因为顶栏与录制页一旦各写一套文案就会出现"一边说失败一边说已停"。
 */

const proxyState = (overrides: Partial<ProxyState> = {}): ProxyState =>
  ({
    enabled: false,
    running: false,
    port: 18787,
    upstreamBaseUrl: "https://api.deepseek.com",
    hasKey: false,
    epoch: "epoch-1",
    revision: 3,
    recordsRevision: 0,
    keyCaptureRevision: 0,
    recovery: "stopped",
    recoveryFailure: null,
    ...overrides,
  }) as ProxyState;

function view(
  overrides: Partial<Parameters<typeof RecordingWorkspaceView>[0]> = {},
  draftOverrides: Parameters<typeof writeRecordingDraft>[1] = {},
): string {
  const draft = writeRecordingDraft(ensureRecordingDraft(null, null), draftOverrides);
  return renderToStaticMarkup(
    <RecordingWorkspaceView
      draft={draft}
      proxy={null}
      statusReadFailed={false}
      applying={false}
      applyError={null}
      onField={() => {}}
      onApply={() => {}}
      onDiscard={() => {}}
      onRefreshStatus={() => {}}
      onOpenRecords={() => {}}
      onRefreshRuns={() => {}}
      {...overrides}
    />,
  );
}

describe("2.3b 恢复中到监听成功同步呈现", () => {
  it("🔴 变异靶：恢复中不得显示成「已停/ 未监听」（判据层 + 呈现层）", () => {
    const view2 = proxyRecoveryView(
      proxyState({ enabled: true, running: false, recovery: "recovering" }),
      false,
    );
    expect(view2.phase).toBe("recovering");
    // 判据 3：恢复中优先于 running=false 这一事实，退化成"已停"就是漏了中间态
    expect(view2.headline).not.toContain("已停");
    expect(view2.listenLine).toContain("正在恢复");

    const html = view({
      proxy: proxyState({ enabled: true, running: false, recovery: "recovering" }),
    });
    expect(html).toContain("正在恢复本地监听");
    expect(html).toContain('data-recovery-phase="recovering"');
    expect(html).not.toContain("代理已停");
  });

  it("恢复成功后呈现已监听，且本会话未捕获凭据如实显示", () => {
    const html = view({
      proxy: proxyState({ enabled: true, running: true, recovery: "stopped", hasKey: false }),
    });
    expect(html).toContain("运行中 · 端口 18787");
    expect(html).toContain("尚未捕获 key");
    // 恢复成功后处置区整体撤掉（没有失败可处置，也不该留着"重试"诱导用户再点）
    expect(html).not.toContain("data-recording-recovery");
  });

  it("恢复成功后接入地址可复制（历史阅读入口不受恢复影响）", () => {
    const proxy = proxyState({ enabled: true, running: true, recovery: "stopped" });
    expect(verifiedProxyAddress(proxy, false)).toBe("http://127.0.0.1:18787/v1");
    const html = view({ proxy });
    expect(html).toContain("data-recording-open-records");
    expect(html).toContain("data-recording-copy-address");
  });
});

describe("2.3b 恢复失败显示意图与实际状态", () => {
  const failed = (overrides: Partial<ProxyState> = {}): ProxyState =>
    proxyState({
      enabled: true,
      running: false,
      recovery: "failed",
      recoveryFailure: {
        code: "PORT_UNAVAILABLE",
        message: "端口 18787 启动监听失败：端口 18787 已被占用，无法启动录制代理",
      },
      ...overrides,
    });

  it("同时呈现「已启用」与「未监听」+ 受控原因，不把失败说成已停用", () => {
    const lines = recordingStatusLines(failed(), false);
    expect(lines[0]?.value).toContain("已启用");
    expect(lines[1]?.value).toContain("未监听");
    // 🔴 判据 2：enabled 仍是 true，文案不能说成"已停用"
    expect(JSON.stringify(lines)).not.toContain("未启用");
    expect(JSON.stringify(lines)).not.toContain("已停用");
    // 受控原因原样透出，不二次加工也不吞掉
    expect(lines[2]?.label).toBe("恢复失败原因");
    expect(lines[2]?.value).toContain("已被占用");
  });

  it("失败时凭据行照旧呈现，不因「看起来已启用」就说凭据可用", () => {
    const lines = recordingStatusLines(failed(), false);
    const credential = lines[lines.length - 1];
    expect(credential?.label).toBe("本会话凭据");
    expect(credential?.value).toContain("尚未捕获 key");
  });

  it("失败处置区：只读重读与显式应用两个入口都在场且各有说明", () => {
    const html = view({ proxy: failed() });
    expect(html).toContain('data-recovery-phase="failed"');
    expect(html).toContain("data-recording-recovery-refresh");
    expect(html).toContain("data-recording-recovery-apply");
    // 判据 3（场景「状态重读与显式应用重试区分」）：两个入口的作用必须写清，
    // 否则用户点"重读"发现代理没起来，会以为按钮坏了
    expect(html).toContain("不启动监听");
    expect(html).toContain("再次尝试监听");
  });

  it("🔴 变异靶：恢复中不给「保存并应用」重试（正在起，等它出结果）", () => {
    const html = view({
      proxy: proxyState({ enabled: true, running: false, recovery: "recovering" }),
    });
    expect(html).toContain("data-recording-recovery-refresh");
    expect(html).not.toContain("data-recording-recovery-apply");
  });

  it("显式应用按钮沿用配置校验门禁：字段非法时不放行（不发出部分有效写调用）", () => {
    const html = view({ proxy: failed() }, { portText: "18787abc" });
    expect(html).toContain("data-recording-recovery-apply");
    // 逐控件判disabled：className 里的 `disabled:` 会凑数，必须钉 disabled=""
    expect(html).toMatch(/data-recording-recovery-apply[^>]*disabled=""/u);
    expect(html).toContain("请先在上方修正端口");
  });

  it("没有诊断时明说未记录，不编一个原因（也不出现空的「原因」行）", () => {
    const noDiag = failed({ recoveryFailure: null });
    const lines = recordingStatusLines(noDiag, false);
    expect(lines.map((l) => l.label)).toEqual([
      "保存的启用意图",
      "本地监听",
      "恢复失败原因",
      "本会话凭据",
    ]);
    expect(lines[2]?.value).toContain("未留下受控诊断");
    // 阶段与诊断不一致时（failed 但无诊断）仍要给出可行动作，不静默
    expect(lines[2]?.value).toContain("重读状态");
  });

  it("状态未知时不沿用上一次的恢复事实（不把上次成功说成现在还好着）", () => {
    for (const v of [proxyRecoveryView(null, false), proxyRecoveryView(failed(), true)]) {
      expect(v.phase).toBe("unknown");
      expect(v.reason).toBeNull();
      expect(v.needsRecordingEntry).toBe(false);
    }
    const html = view({ statusReadFailed: true });
    expect(html).not.toContain("data-recording-recovery");
    expect(html).toContain("状态待读取");
  });
});

describe("2.3b 停止态与恢复态的措辞不混", () => {
  it("未启用 ⇒ 「已停」；已启用但未监听 ⇒ 明说启用不等于监听成功", () => {
    expect(proxyRecoveryView(proxyState({ enabled: false }), false).headline).toBe("代理已停");
    const enabledIdle = proxyRecoveryView(proxyState({ enabled: true }), false);
    expect(enabledIdle.phase).toBe("stopped");
    expect(enabledIdle.headline).toBe("代理已启用 · 未监听");
    expect(enabledIdle.listenLine).toContain("启用不等于监听成功");
    // 正常停止不需要处置入口（没有失败可处理）
    expect(enabledIdle.needsRecordingEntry).toBe(false);
  });

  it("恢复中与失败都需要录制页入口；已监听不需要", () => {
    expect(
      proxyRecoveryView(proxyState({ enabled: true, recovery: "recovering" }), false)
        .needsRecordingEntry,
    ).toBe(true);
    expect(
      proxyRecoveryView(
        proxyState({ enabled: true, recovery: "failed", recoveryFailure: null }),
        false,
      ).needsRecordingEntry,
    ).toBe(true);
    expect(
      proxyRecoveryView(proxyState({ enabled: true, running: true }), false).needsRecordingEntry,
    ).toBe(false);
  });

  it("圆点颜色跟随阶段，但颜色不是唯一区分（各有 headline 文字）", () => {
    expect(proxyPhaseDotClass("listening")).toBe("bg-emerald-500");
    expect(proxyPhaseDotClass("recovering")).toBe("bg-amber-500");
    expect(proxyPhaseDotClass("failed")).toBe("bg-red-500");
    expect(proxyPhaseDotClass("unknown")).toBe("bg-gray-300");
    // 每个阶段都有非空文字，不靠颜色单打独斗
    for (const phase of ["unknown", "recovering", "listening", "stopped", "failed"] as const) {
      const proxy =
        phase === "unknown"
          ? null
          : proxyState({
              enabled: true,
              running: phase === "listening",
              recovery:
                phase === "failed" ? "failed" : phase === "recovering" ? "recovering" : "stopped",
              recoveryFailure:
                phase === "failed" ? { code: "LISTEN_FAILED", message: "启动失败：原因甲" } : null,
            });
      expect(proxyRecoveryView(proxy, false).headline.length).toBeGreaterThan(0);
    }
  });

  it("恢复期间接入地址不可复制（不提供预测端口）", () => {
    expect(
      verifiedProxyAddress(proxyState({ enabled: true, recovery: "recovering" }), false),
    ).toBeNull();
    const html = view({ proxy: proxyState({ enabled: true, recovery: "recovering" }) });
    expect(html).toContain("data-recording-address-unavailable");
    expect(html).not.toContain("data-recording-copy-address");
  });
});
