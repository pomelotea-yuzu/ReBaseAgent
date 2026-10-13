import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
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
