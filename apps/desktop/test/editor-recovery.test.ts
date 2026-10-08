/**
 * 任务 4.2：编辑器恢复契约的判据层测试。
 *
 * 覆盖 spec「可见消息编辑器可恢复且不丢草稿」的三条：
 * - 可见宿主恢复非零尺寸（`classifyHost` / `layoutRecoveryAction`）；
 * - 恢复失败可见且能就地重试（`shouldShowFailure` / `recoveryNotice`）；
 * - 隐藏 Monaco 节点不误报（宿主零尺寸 ⇒ `pending-space`，**不是** `failed`）。
 */
import { describe, expect, it } from "vitest";
import {
  classifyHost,
  layoutRecoveryAction,
  preservedOnRecovery,
  recoveryNotice,
  shouldShowFailure,
} from "../src/renderer/src/lib/editor-recovery";

/** 满档事实：可见、有框、在视口内、有内容面。 */
const okFacts = {
  offsetW: 800,
  offsetH: 200,
  inViewport: true,
  ancestorBreak: null,
  scrollableCount: 1,
};

describe("classifyHost · 可见性判定", () => {
  it("宿主有框 + 在视口内 + 有内容面 ⇒ ok", () => {
    expect(classifyHost(okFacts)).toEqual({ kind: "ok" });
  });

  // 🔴 评审 2026-10-06 的原话：「单凭选择器命中某个零尺寸节点不能确认可见编辑器塌缩」。
  // 隐藏 helper 的 0×0 绝不能被判成失败——否则用户收起面板就弹"加载失败"。
  it("宿主自身零尺寸 ⇒ pending-space（隐藏 helper / 折叠态），不是 failed", () => {
    const hidden = { ...okFacts, offsetW: 0, offsetH: 0, scrollableCount: 0 };
    expect(classifyHost(hidden)).toEqual({ kind: "pending-space" });
    expect(shouldShowFailure(classifyHost(hidden))).toBe(false);
  });

  it("只有高度为 0 也算未获空间（宽仍在但被压扁）", () => {
    const squashed = { ...okFacts, offsetH: 0, scrollableCount: 0 };
    expect(classifyHost(squashed).kind).toBe("pending-space");
  });

  it("祖先链有塌断点 ⇒ pending-space，即使宿主自己有框", () => {
    const broken = { ...okFacts, ancestorBreak: "div.collapsed(offsetW=0)" };
    expect(classifyHost(broken)).toEqual({ kind: "pending-space" });
    expect(shouldShowFailure(classifyHost(broken))).toBe(false);
  });

  it("不在视口内 ⇒ pending-space", () => {
    expect(classifyHost({ ...okFacts, inViewport: false }).kind).toBe("pending-space");
  });

  it("可见但读不到内容面 ⇒ needs-layout（要重新 layout，不是失败）", () => {
    const empty = { ...okFacts, scrollableCount: 0 };
    expect(classifyHost(empty)).toEqual({ kind: "needs-layout" });
    expect(shouldShowFailure(classifyHost(empty))).toBe(false);
  });
});

describe("shouldShowFailure · 只有真失败才提示", () => {
  it("needs-layout 不弹错误（可自愈，不是产品坏了）", () => {
    expect(shouldShowFailure({ kind: "needs-layout" })).toBe(false);
  });

  it("pending-space 不弹错误", () => {
    expect(shouldShowFailure({ kind: "pending-space" })).toBe(false);
  });

  it("failed 弹错误", () => {
    expect(shouldShowFailure({ kind: "failed", reason: "装配失败" })).toBe(true);
  });
});

describe("recoveryNotice · 失败占位文案的三条边界", () => {
  const notice = recoveryNotice("编辑器资源未能加载");

  it("给出标题、详情与就地重试入口名", () => {
    expect(notice.title).toBe("编辑器未能加载");
    expect(notice.action).toBe("就地重试");
    expect(notice.detail).toContain("编辑器资源未能加载");
  });

  // spec：恢复 SHALL 保留草稿/非法文本/view state，不自动提交，不恢复旧许可
  it("文案明说草稿与目标保持原样（不以重启为唯一出口）", () => {
    expect(notice.detail).toContain("草稿与目标保持原样");
    expect(notice.detail).toContain("只恢复这一个编辑器");
  });

  it("原因原样透传（不吞诊断）", () => {
    expect(recoveryNotice("chunk 404").detail).toContain("chunk 404");
  });
});

describe("layoutRecoveryAction · 只在空间真正回来时动一次", () => {
  it("从零尺寸恢复到有空间 ⇒ relayout", () => {
    expect(layoutRecoveryAction({ offsetW: 0, offsetH: 0 }, { offsetW: 800, offsetH: 200 })).toBe(
      "relayout",
    );
  });

  it("从压扁（高 0）恢复 ⇒ relayout", () => {
    expect(layoutRecoveryAction({ offsetW: 800, offsetH: 0 }, { offsetW: 800, offsetH: 200 })).toBe(
      "relayout",
    );
  });

  // 🔴 observer 自激的来源：空间没回来也反复 layout ⇒ 重建风暴
  it("仍是零尺寸 ⇒ null（不触发布局，避免 observer 自激）", () => {
    expect(layoutRecoveryAction({ offsetW: 0, offsetH: 0 }, { offsetW: 0, offsetH: 0 })).toBeNull();
  });

  it("一直有空间（普通 resize）⇒ null，不做额外 layout", () => {
    expect(layoutRecoveryAction({ offsetW: 800, offsetH: 200 }, { offsetW: 900, offsetH: 200 })).toBeNull();
  });
});

describe("preservedOnRecovery · 恢复时保留什么", () => {
  it("保留草稿、非法文本与 view state", () => {
    const kept = preservedOnRecovery(false);
    expect(kept.keepDraft).toBe(true);
    expect(kept.keepIllegalText).toBe(true);
    expect(kept.keepViewState).toBe(true);
  });

  it("不自动提交、不恢复旧许可", () => {
    const kept = preservedOnRecovery(true);
    expect(kept.autoSubmit).toBe(false);
    expect(kept.restoreOldPermission).toBe(false);
  });

  it("重挂与不重挂口径一致（契约不随实现方式漂移）", () => {
    expect(preservedOnRecovery(true)).toEqual(preservedOnRecovery(false));
  });
});
