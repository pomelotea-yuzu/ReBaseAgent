import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ShortIdLabel } from "../src/renderer/src/components/ShortIdLabel";
import { auditForbiddenTokens } from "../src/renderer/src/lib/overview-view";

/**
 * refine-ui-for-community-release 任务 2.1：全局入口与视图名称整理。
 *
 * 判据来源：desktop-ui delta（MODIFIED「界面提供分支树与轨迹两种视图」）：
 *   - header 切换入口面向用户分别标为「分支关系」和「运行记录」；
 *   - 运行内步骤目录使用「步骤目录」等可辨层级名称，不与应用级视图统一标为「轨迹」；
 *   - 录制接入进入独立录制工作区（规范文字对齐既有实现，见 evidence-index A2 节）。
 *
 * 为什么是源码级断言而不是组件渲染：`GlobalBar` 直接读 `useAppStore`，本包无 jsdom、
 * renderToStaticMarkup 拿不到 store 状态（与 global-bar-recovery-wiring.test.ts 同口径）。
 * 禁用型断言一律走 auditForbiddenTokens（剥注释后扫，不咬自己的文档注释）。
 */

const read = (rel: string): string => readFileSync(resolve(import.meta.dirname, rel), "utf8");

const bar = read("../src/renderer/src/components/GlobalBar.tsx");

describe("视图切换名称：运行记录／分支关系（MODIFIED1）", () => {
  it("两个切换入口面向用户标为「运行记录」「分支关系」", () => {
    expect(bar).toContain('label: "运行记录"');
    expect(bar).toContain('label: "分支关系"');
  });

  it("应用级视图不再标为「轨迹」（禁用型判据走审计函数，剥注释）", () => {
    expect(auditForbiddenTokens(bar, ['label: "轨迹"', 'label: "分支树"'])).toEqual([]);
  });

  it("标签经 options.map 渲染到按钮（不是只写在数组里）", () => {
    // options 数组是唯一来源：按钮文案由 map 消费，改标签只改一处
    expect(bar).toContain("options.map(({ key, label, icon: Icon, hint })");
    expect(bar).toContain('aria-pressed={active ? "true" : undefined}');
  });
});

describe("步骤目录名称（MODIFIED1）：可辨层级名称已对齐", () => {
  const tree = read("../src/renderer/src/components/SpanTree.tsx");

  it("SpanTree 面向用户使用「步骤目录」（收起/重开入口与宽度标签同源）", () => {
    expect(tree).toContain("收起步骤目录");
    expect(tree).toContain("重新打开步骤目录");
    expect(tree).toContain('label="步骤目录宽度"');
  });
});

describe("录制接入进入既有独立录制工作区（R07/N16 的规范对齐锚点）", () => {
  it("GlobalBar 录制按钮走 onOpenRecording 专用通道（不经过设置）", () => {
    // App.tsx 的 openRecording → openRecordingWorkspace 一跳由
    // settings-roundtrip-invalidate.test.ts 钉住；这里钉 GlobalBar 这一跳。
    expect(bar).toContain("onOpenRecording: () => void");
    expect(bar).toContain("const openRecording = (): void => {");
    expect(bar).toContain("onClick={openRecording}");
  });

  it("按钮可见名称与提示指认独立录制工作区（面向用户文字与实现一致）", () => {
    expect(bar).toContain("录制接入");
    expect(bar).toContain("打开录制工作区");
  });
});

// —— 2.2：对象头身份与完整 ID 可复制（delta ADDED「当前任务身份与返回目的地明确」）——

// RunWorkspace 里的 store 薄壳 import 时会触到 window.api ⇒ 桩先就位再动态 import
// （与 notice-disclosure.test.tsx 同法）。
(globalThis as Record<string, unknown>).window = { api: {} };
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RunHeaderView } = await import("../src/renderer/src/components/RunWorkspace");
const { AuxWorkspaceFrame } = await import("../src/renderer/src/components/AuxWorkspaceFrame");

const renderHeader = (props: {
  selectedRunId: string | null;
  shortId?: string | null;
}): string =>
  renderToStaticMarkup(createElement(RunHeaderView, { detail: null, runs: [], ...props }));

describe("全局栏不再冒充当前对象（2.2 移除 detail 身份展示）", () => {
  it("GlobalBar 不订阅 detail、不渲染 meta.id；对象身份归各工作区对象头", () => {
    expect(auditForbiddenTokens(bar, ["s.detail", "meta.id"])).toEqual([]);
    // 全局栏其余入口不受影响
    expect(bar).toContain("<OperationsEntry />");
    expect(bar).toContain("<SessionDraftsEntry />");
  });
});

describe("单运行对象头：完整 ID 可访问并复制（N04）", () => {
  it("短 ID 展示 + 复制按钮的可访问名与复制目标都是完整原始 ID", () => {
    const html = renderHeader({ selectedRunId: "r_full000123", shortId: "r_f1" });
    expect(html).toContain("复制完整 运行 ID r_full000123");
    expect(html).toContain('title="复制完整 ID：r_full000123"');
    expect(html).toContain("r_f1");
  });

  it("缺省 shortId ⇒ 回退显示完整 ID，复制目标不变", () => {
    const html = renderHeader({ selectedRunId: "r_full000123" });
    expect(html).toContain("复制完整 运行 ID r_full000123");
    expect(html).toContain("r_full000123");
  });

  it("未选择运行 ⇒ 占位 —，不渲染复制按钮", () => {
    const html = renderHeader({ selectedRunId: null });
    expect(html).not.toContain("复制完整");
  });
});

describe("辅助工作区对象头：run ID 可复制（N04）", () => {
  it("AuxWorkspaceFrame 的 targetLine 接受 ReactNode（string 承载不了复制按钮）", () => {
    const html = renderToStaticMarkup(
      createElement(
        AuxWorkspaceFrame,
        {
          title: "模型实验",
          description: "说明",
          compactDescription: "摘要",
          targetLine: createElement(ShortIdLabel, {
            id: "r_parent000",
            shortId: "r_p1",
            label: "父本运行 ID",
          }),
          returnAvailable: false,
          onReturn: () => {},
        },
        createElement("div", null, "正文"),
      ),
    );
    expect(html).toContain("复制完整 父本运行 ID r_parent000");
  });

  it("实验与编辑容器的 targetLine 用 ShortIdLabel 承载目标 run ID（源码契约）", () => {
    const exp = read("../src/renderer/src/components/ExperimentWorkspace.tsx");
    const msg = read("../src/renderer/src/components/MessagesWorkspace.tsx");
    expect(exp).toContain('label="父本运行 ID"');
    expect(exp).toContain("id={target.runId}");
    expect(msg).toContain('label="来源运行 ID"');
    expect(msg).toContain("id={target.runId}");
  });

  it("AuxWorkspaceFrame 类型放宽为 ReactNode | null", () => {
    const src = read("../src/renderer/src/components/AuxWorkspaceFrame.tsx");
    expect(src).toContain("readonly targetLine: ReactNode | null;");
  });
});
