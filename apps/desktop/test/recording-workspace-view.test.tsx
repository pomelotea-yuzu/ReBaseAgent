import type { ProxyState } from "@shared/ipc";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  RecordingWorkspaceView,
  recordingStatusLines,
  verifiedProxyAddress,
} from "../src/renderer/src/components/RecordingWorkspaceView";
import { ensureRecordingDraft, writeRecordingDraft } from "../src/renderer/src/lib/recording-draft";

/**
 * U8 任务 2.4/2.7/2.8/2.9 的**纯视图能力断言**（无 jsdom，renderToStaticMarkup 喂 props）。
 * 判据纪律：disabled 类逐控件判 `disabled=""`；「不可复制」类断言打在能力缺失的呈现上，
 * 且配对照（可复制时按钮在场）。
 */

/**
 * ⚠️ 纪律：这里必须显式写出 `recovery` / `recoveryFailure`（tasks 2.3b）。
 * 用 `as ProxyState` 断言字面量时，漏掉的必填字段会是 `undefined`，
 * 于是 `recovery === "recovering"` 之类的比较静默为 false——判据被绕过而测试仍绿。
 * 新增 `ProxyState` 字段时，这个工厂要跟着补。
 */
const proxyState = (overrides: Partial<ProxyState> = {}): ProxyState =>
  ({
    enabled: false,
    running: false,
    port: 18787,
    upstreamBaseUrl: "https://api.deepseek.com",
    hasKey: false,
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

describe("U8 2.7：真实状态三分（意图 / 监听 / 凭据）", () => {
  it("running+hasKey ⇒ 三层事实分行可辨；未监听 ⇒ 明说启用不等于监听成功", () => {
    expect(
      recordingStatusLines(proxyState({ enabled: true, running: true, hasKey: true }), false),
    ).toEqual([
      { label: "保存的启用意图", value: "已启用（配置已保存）" },
      { label: "本地监听", value: "运行中 · 端口 18787" },
      { label: "本会话凭据", value: "已捕获（本会话有请求经过）" },
    ]);
    const lines = recordingStatusLines(proxyState({ enabled: true, running: false }), false);
    expect(lines[1]?.value).toContain("未监听");
    expect(lines[1]?.value).toContain("启用不等于监听成功");
    expect(lines[2]?.value).toContain("尚未捕获 key");
  });

  it("读取失败 / 未读到 ⇒ 「状态待读取」显式呈现，不拿默认值冒充事实", () => {
    for (const lines of [
      recordingStatusLines(null, false),
      recordingStatusLines(proxyState(), true),
    ]) {
      expect(lines).toHaveLength(1);
      expect(lines[0]?.value).toContain("状态待读取");
    }
  });

  it("视图渲染状态行与只读重试入口（重试 = 只读，不重新应用）", () => {
    const html = view({ statusReadFailed: true });
    expect(html).toContain("状态待读取");
    expect(html).toContain("data-recording-refresh-status");
    expect(html).toContain("不重新应用");
  });
});

describe("U8 2.8：接入地址只来自已核实监听", () => {
  it("running ⇒ 地址由真实端口构造且可复制；复制零测试请求的说明在场", () => {
    expect(verifiedProxyAddress(proxyState({ running: true, port: 20000 }), false)).toBe(
      "http://127.0.0.1:20000/v1",
    );
    const html = view({ proxy: proxyState({ running: true, port: 20000 }) });
    expect(html).toContain("http://127.0.0.1:20000/v1");
    expect(html).toContain("data-recording-copy-address");
    expect(html).toContain("不做连通性测试");
  });

  it("未监听 / 读取未知 ⇒ 地址不可复制（不提供草稿端口的假地址）", () => {
    expect(verifiedProxyAddress(proxyState({ running: false }), false)).toBeNull();
    expect(verifiedProxyAddress(null, false)).toBeNull();
    const html = view({ proxy: null });
    expect(html).not.toContain("http://127.0.0.1:");
    expect(html).toContain("data-recording-address-unavailable");
    // 草稿端口即便填了也不进地址
    const withDraftPort = renderToStaticMarkup(
      <RecordingWorkspaceView
        draft={writeRecordingDraft(ensureRecordingDraft(null, null), { portText: "20000" })}
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
      />,
    );
    expect(withDraftPort).not.toContain("127.0.0.1:20000");
  });

  it("应用在飞 ⇒ 地址撤销（应用结束并核实监听后才可复制）", () => {
    expect(verifiedProxyAddress(proxyState({ running: true }), true)).toBeNull();
    const html = view({ proxy: proxyState({ running: true }), applying: true });
    expect(html).toContain("应用进行中");
    expect(html).not.toContain("data-recording-copy-address");
  });
});

describe("U8 2.4：字段校验就近呈现 + 应用门禁（非法零请求的界面半边）", () => {
  it("非法端口 ⇒ 字段处错误 + 原文保留 + 应用按钮逐控件 disabled", () => {
    const html = view({}, { portText: "18787abc" });
    expect(html).toContain("data-recording-port-error");
    expect(html).toContain("18787abc");
    expect(html).toMatch(/data-recording-apply[^>]* disabled=""/);
    expect(html).toContain("不会发出部分有效的配置写调用");
  });

  it("合法字段 ⇒ 应用按钮可用（对照支：disabled 不在场）", () => {
    const html = view({}, { portText: "20000" });
    expect(html).not.toContain("data-recording-apply[^>]* disabled");
    expect(html).not.toMatch(/data-recording-apply[^>]* disabled=""/);
  });

  it("在飞 ⇒ 应用按钮禁用并标「应用中」（防重复提交的呈现半边）", () => {
    const html = view({ applying: true });
    expect(html).toMatch(/data-recording-apply[^>]* disabled=""/);
    expect(html).toContain("应用中");
  });
});

describe("U8 2.2/2.9：放弃入口 / 记录与刷新", () => {
  it("dirty ⇒ 未应用提示 + 放弃按钮在场；非 dirty ⇒ 无放弃按钮（不诱导误操作）", () => {
    // baseline 在场（已核实配置）时偏离才算 dirty；baseline null（未读）不算
    const withBaseline = ensureRecordingDraft(null, {
      enabled: false,
      port: 18787,
      upstreamBaseUrl: "https://api.deepseek.com",
    });
    const dirtyDraft = writeRecordingDraft(withBaseline, { portText: "20000" });
    const dirtyHtml = renderToStaticMarkup(
      <RecordingWorkspaceView
        draft={dirtyDraft}
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
      />,
    );
    expect(dirtyHtml).toContain("data-recording-dirty");
    expect(dirtyHtml).toContain("data-recording-discard");
    const cleanHtml = view();
    expect(cleanHtml).not.toContain("data-recording-discard");
  });

  it("记录入口与只读刷新按钮在场", () => {
    const html = view();
    expect(html).toContain("data-recording-open-records");
    expect(html).toContain("data-recording-refresh-runs");
    expect(html).toContain("只读刷新");
  });
});
