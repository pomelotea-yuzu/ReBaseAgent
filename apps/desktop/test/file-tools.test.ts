import { describe, expect, it } from "vitest";
import type { WorkspaceReadFileResult } from "../src/shared/ipc";

/**
 * U2 任务 4.4 / 4.5 / 4.6：阅读工具**可启用性判据**（纯逻辑层，design D6）。
 *
 * 对应 delta（requirement「文件阅读工具操作完整原文且保持只读」）：
 * -「不可比较或未就绪时工具诚实禁用」：按实际可读/可比较/就绪状态启用，禁时给说明。
 * -「复制路径原文及元信息」：复制**完整**原文；无文本侧**不复制为空文件**。
 * - 只读：本模块不得含任何编辑/替换/回写/导出入口。
 */

const { sideReadiness, copyableText, copyableMeta, resolveToolEnablement } = await import(
  "../src/renderer/src/lib/file-tools"
);

function text(t: string): WorkspaceReadFileResult {
  return { status: "text", path: "a.txt", bytes: t.length, sha256: "a".repeat(64), text: t };
}

describe("U2 4.4 sideReadiness：真实状态归一", () => {
  it("text ⇒ ready；**空串也是合法空文件**（ready，不是 empty）", () => {
    expect(sideReadiness(text("内容"), { loading: false, failed: false })).toBe("ready");
    expect(sideReadiness(text(""), { loading: false, failed: false })).toBe("ready");
  });

  it("null + failed ⇒ failed（不折成 not_found）；null + loading ⇒ loading；否则 empty", () => {
    expect(sideReadiness(null, { loading: false, failed: true })).toBe("failed");
    expect(sideReadiness(null, { loading: true, failed: false })).toBe("loading");
    expect(sideReadiness(null, { loading: false, failed: false })).toBe("empty");
  });

  it("binary/missing/corrupt/rejected ⇒ unavailable；not_found 单列", () => {
    const mk = (status: string): WorkspaceReadFileResult =>
      ({ status, path: "a.txt", bytes: 1, sha256: "a".repeat(64) }) as WorkspaceReadFileResult;
    expect(sideReadiness(mk("binary"), { loading: false, failed: false })).toBe("unavailable");
    expect(sideReadiness(mk("missing"), { loading: false, failed: false })).toBe("unavailable");
    expect(sideReadiness(mk("corrupt"), { loading: false, failed: false })).toBe("unavailable");
    expect(sideReadiness(mk("rejected"), { loading: false, failed: false })).toBe("unavailable");
    expect(sideReadiness(mk("not_found"), { loading: false, failed: false })).toBe("not_found");
  });
});

describe("U2 4.4 复制内容：完整原文 / 元信息，不冒充空文件", () => {
  it("copyableText 只对 text 给全文；不可读侧返回 null（绝不返回空串冒充）", () => {
    expect(copyableText(text("hello"))).toBe("hello");
    expect(copyableText(text(""))).toBe(""); // 真实空文件，可复制为空串
    expect(
      copyableText({ status: "binary", path: "a", bytes: 9, sha256: "b".repeat(64) }),
    ).toBeNull();
    expect(copyableText(null)).toBeNull();
  });

  it("copyableMeta 对 binary/missing/corrupt 给真实大小与哈希", () => {
    const m = copyableMeta({
      status: "binary",
      path: "a",
      bytes: 1234,
      sha256: "c".repeat(64),
    });
    expect(m).toEqual({ bytes: 1234, sha256: "c".repeat(64) });
  });

  it("copyableMeta 不用于 not_found/rejected（没有真实大小可谈）", () => {
    expect(copyableMeta({ status: "not_found", path: "a", reason: "不在清单" })).toBeNull();
  });
});

describe("U2 4.5/4.6 工具诚实启用", () => {
  it("两 ready + 可比较 + 并排 ⇒ 全部工具可用（差异导航开启）", () => {
    const t = resolveToolEnablement({
      hasPath: true,
      left: "ready",
      right: "ready",
      diffEligible: true,
      editorReady: true,
      mode: "sideBySide",
      diffCount: 3,
    });
    expect(t.copyPath).toBe(true);
    expect(t.copyLeftText).toBe(true);
    expect(t.copyRightText).toBe(true);
    expect(t.find).toBe(true);
    expect(t.prevDiff).toBe(true);
    expect(t.nextDiff).toBe(true);
    expect(t.modeToggle).toBe(true);
  });

  it("**只有一侧 ready + 单侧只读视图就绪** ⇒ 该侧可复制/查找/换行；另一侧禁；差异导航禁", () => {
    // U2 5.4 实机修正：原先 find/wordWrap 绑 `diffEligible`，单侧可读时被一并禁掉，
    // 违反 delta「单侧可读时该侧仍可复制查找」。
    const t = resolveToolEnablement({
      hasPath: true,
      left: "unavailable",
      right: "ready",
      diffEligible: false,
      editorReady: true,
      mode: "inline",
      diffCount: 0,
    });
    expect(t.copyLeftText).toBe(false);
    expect(t.copyRightText).toBe(true);
    expect(t.copyMeta).toBe(true); // 有不可用侧 ⇒ 可复制其元信息
    expect(t.find).toBe(true); // 该侧有只读编辑器 ⇒ 查找可用
    expect(t.wordWrap).toBe(true);
    expect(t.prevDiff).toBe(false); // 没有 diff ⇒ 不假跳转
    expect(t.nextDiff).toBe(false);
    expect(t.modeToggle).toBe(false); // 进不了 diff ⇒ 不给模式切换
  });

  it("一侧 ready 但**编辑器根本没就绪** ⇒ 查找/换行仍诚实禁用（不空转）", () => {
    const t = resolveToolEnablement({
      hasPath: true,
      left: "unavailable",
      right: "ready",
      diffEligible: false,
      editorReady: false,
      mode: "inline",
      diffCount: 0,
    });
    expect(t.find).toBe(false);
    expect(t.wordWrap).toBe(false);
  });

  it("**没有差异**（diffCount=0）⇒ 不假跳转（差异导航禁）", () => {
    const t = resolveToolEnablement({
      hasPath: true,
      left: "ready",
      right: "ready",
      diffEligible: true,
      editorReady: true,
      mode: "sideBySide",
      diffCount: 0,
    });
    expect(t.prevDiff).toBe(false);
    expect(t.nextDiff).toBe(false);
  });

  it("inline 模式下差异导航禁用（没有并排真实 diff 可导航）", () => {
    const t = resolveToolEnablement({
      hasPath: true,
      left: "ready",
      right: "ready",
      diffEligible: true,
      editorReady: true,
      mode: "inline",
      diffCount: 5,
    });
    expect(t.prevDiff).toBe(false);
    expect(t.find).toBe(true); // 查找仍可用
  });

  it("无路径 ⇒ 路径复制禁", () => {
    const t = resolveToolEnablement({
      hasPath: false,
      left: "empty",
      right: "empty",
      diffEligible: false,
      editorReady: false,
      mode: "inline",
      diffCount: 0,
    });
    expect(t.copyPath).toBe(false);
  });
});
