import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "../src/renderer/src/lib/overview-view";

/**
 * tasks 2.3b：顶栏恢复呈现的**外壳接线契约**。
 *
 * 为什么是源码级断言而不是组件渲染：`GlobalBar` 直接读 `useAppStore`，本包无
 * jsdom、也没有 store 的渲染先例；而 U1 已经吃过三次"组件测得绿但没挂上"的亏。
 * 组件能测的部分（阶段判据与文案）已在 `proxy-recovery-view.test.tsx` 里，
 * 这里只钉"顶栏确实接了这套判据、确实把录制页通道传下去"。
 *
 * ⚠️ 纪律：源码级断言必须 `stripComments` 后再匹配，否则注释里写着一句
 * "顶栏给入口"就能让断言通过——那是自欺。
 */

const BAR_SRC = stripComments(
  readFileSync(
    resolve(import.meta.dirname, "../src/renderer/src/components/GlobalBar.tsx"),
    "utf8",
  ),
);
const norm = (s: string): string => s.replace(/\s+/g, " ");

describe("2.3b 顶栏按恢复阶段呈现", () => {
  it("顶栏的状态项来自共用判据，不自己写「运行 / 已停」两态", () => {
    expect(BAR_SRC).toContain("proxyRecoveryView");
    expect(BAR_SRC).toContain("proxyPhaseDotClass");
    // 🔴 变异靶：只要顶栏还在用 `proxy.running ?` 自己拼文案，这两条就会红——
    // 那正是"顶栏说失败、录制页说已停"这类自相矛盾的来源
    expect(BAR_SRC).not.toContain("proxy.running ?");
  });

  /*
   * ⚠️ 下面这条是本文件的核心，踩过一次坑才写成这样。
   *
   * 第一版只断言「源码里出现了 proxyRecoveryView / needsRecordingEntry 这些字面量」。
   * 变异验证时把调用整个换成内联字面量（`{ phase: …, needsRecordingEntry: false }`）
   * ——**6 条全绿**。因为函数名还留在 import 与类型位置上，实现却已经与判据脱钩。
   *
   * 源码级断言的正确姿势：钉**数据流**（结果被谁消费），不钉**符号出现**。
   * 符号出现只能证明"文件里提到过它"。
   */
  it("🔴 变异靶：入口按钮与文案真的由判据结果驱动（钉数据流，不钉符号出现）", () => {
    const normed = norm(BAR_SRC);
    // 判据的返回值绑到局部变量，且这个变量被渲染消费
    expect(normed).toMatch(/const view = proxyRecoveryView\(/u);
    // 恢复/失败入口的存在条件来自该变量（换成内联字面量 ⇒ 这里红）
    expect(normed).toMatch(/\{view\.needsRecordingEntry \? \(/u);
    // 文案与阶段标签也都读同一个变量，不另算
    expect(normed).toContain("<span data-proxy-phase-label>{view.headline}</span>");
    expect(normed).toContain("data-proxy-phase={view.phase}");
    expect(normed).toContain("proxyPhaseDotClass(view.phase)");
    // 颜色与边框跟随阶段（内联字面量版本会退回固定灰/灰边框）
    expect(normed).toMatch(/view\.phase === "failed"[\s\S]{0,120}border-red-300/u);
    expect(normed).toMatch(/view\.phase === "recovering"[\s\S]{0,120}border-amber-300/u);
  });

  it("恢复中 / 失败都给出录制页入口（顶栏是唯一常驻的位置）", () => {
    expect(BAR_SRC).toContain("needsRecordingEntry");
    expect(BAR_SRC).toContain("data-proxy-open-recording");
    expect(BAR_SRC).toContain("onOpenRecording");
    // 入口走的是已有的录制工作区通道，不是新开一套 UI
    expect(BAR_SRC).toContain("openRecording");
  });

  it("阶段以 data 属性外露（供实机核对，不只靠肉眼读颜色）", () => {
    expect(BAR_SRC).toContain("data-proxy-phase=");
    expect(BAR_SRC).toContain("data-proxy-phase-dot");
  });

  it("未捕获 key 只在真的在监听时说（失败/恢复中不重复报凭据）", () => {
    const normed = norm(BAR_SRC);
    expect(normed).toContain('view.phase === "listening" && proxy?.hasKey !== true');
  });
});

describe("2.3b 录制页恢复呈现接线", () => {
  const VIEW_SRC = stripComments(
    readFileSync(
      resolve(import.meta.dirname, "../src/renderer/src/components/RecordingWorkspaceView.tsx"),
      "utf8",
    ),
  );

  it("状态行与处置区都从共用判据派生", () => {
    expect(VIEW_SRC).toContain("proxyRecoveryView");
    expect(VIEW_SRC).toContain("data-recording-recovery");
    // 监听行不再自己判running（原先 `proxy.running ? … : "未监听…"` 会在
    // 恢复失败时说出"未监听"却丢掉"已启用"与原因）
    expect(VIEW_SRC).not.toContain("proxy.running ?");
  });

  it("🔴 变异靶：状态行与处置区读同一个判据结果（钉数据流）", () => {
    const normed = norm(VIEW_SRC);
    expect(normed).toMatch(/const recoveryView = proxyRecoveryView\(/u);
    // 状态行取 listenLine / reason —— 换成内联字面量 ⇒ 红
    expect(normed).toContain('{ label: "本地监听", value: view.listenLine }');
    expect(normed).toContain('lines.push({ label: "恢复失败原因", value: view.reason });');
    // 处置区的出现条件来自该变量
    expect(normed).toMatch(
      /recoveryView\.phase === "recovering" \|\| recoveryView\.phase === "failed"/u,
    );
    expect(normed).toContain("data-recovery-phase={recovery.phase}");
    // 重试按钮只在失败时出现（不是恢复中）
    expect(normed).toMatch(/recovery\.phase === "failed" \? \(/u);
  });

  it("失败处置区同时给只读重读与显式应用，两个入口不合并", () => {
    expect(VIEW_SRC).toContain("data-recording-recovery-refresh");
    expect(VIEW_SRC).toContain("data-recording-recovery-apply");
  });
});
