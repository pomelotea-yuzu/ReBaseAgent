import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { auditForbiddenTokens } from "../src/renderer/src/lib/overview-view";

/**
 * U3（preserve-debugging-drafts）任务 2.3：创建表单恢复模式/任务/system，
 * 关闭/设置往返保留，显式放弃重置；保留原忙碌关闭限制。
 *
 * 判据来源（tasks 2.3 验收 + delta「创建表单按会话草稿恢复」）：
 *   - 创建关闭配置再新建仍有任务（关闭对话框 ≠ 丢弃草稿）
 *   - 切创建模式保留文本而放弃重置表单
 *   - 忙碌关闭限制保留（创建中/选目录中 modalLocked 不变）
 *
 * ⚠️ 本包无 jsdom ⇒ 与 2.1/2.2 同法：源码级接线契约 + store 同形调用行为；
 *    实机往返归 CDP（任务 6.2）。
 */

// ---------------------------------------------------------------------------
// 源码级接线契约
// ---------------------------------------------------------------------------

const DIALOG = readFileSync(
  resolve(import.meta.dirname, "../src/renderer/src/components/CreateRunDialog.tsx"),
  "utf8",
);

describe("接线契约：CreateRunDialog 读写创建草稿（任务 2.3）", () => {
  it("挂载即登记创建草稿（ensureCreateRunDraft），文本字段从草稿派生", () => {
    expect(DIALOG).toContain("ensureCreateRunDraft()");
    expect(DIALOG).toContain("s.createRunDraftOf()");
    // 文本读取走草稿（带默认回退），不再持有本地文本 state
    expect(DIALOG).toContain('draftEntry?.systemPrompt ?? ""');
    expect(DIALOG).toContain('draftEntry?.userMessage ?? ""');
  });

  it("输入同步写入草稿；本地文本 setter 已移除（重开覆盖输入的旧根因）", () => {
    expect(DIALOG).toContain("writeCreateRunDraft({ systemPrompt: e.target.value })");
    expect(DIALOG).toContain("writeCreateRunDraft({ userMessage: e.target.value })");
    expect(auditForbiddenTokens(DIALOG, ["setSystemPrompt", "setUserMessage"])).toEqual([]);
  });

  it("切模式写草稿且不重置文本（switchMode 不碰 systemPrompt/userMessage）", () => {
    expect(DIALOG).toContain("writeCreateRunDraft({ mode })");
    // switchCreateRunMode 的文档契约：文本不属于授权状态（lib 已单测），组件不得在此清文本
    expect(auditForbiddenTokens(DIALOG, ['systemPrompt: ""', 'userMessage: ""'])).toEqual([]);
  });

  it("显式放弃：确认后按 CAS 放弃草稿并重置表单（取消不丢内容）", () => {
    expect(DIALOG).toContain("discardCreateRunDraft(current.revision)");
    expect(DIALOG).toContain("isCreateRunDraftDirty(current)");
    // 放弃同时清除目录引用（design D4）并复位本地授权状态
    expect(DIALOG).toContain("setCreateSourceRef(null)");
    expect(DIALOG).toContain("setForm(initialCreateRunForm())");
    // 无变更时不可放弃（不制造虚假草稿动作）
    expect(DIALOG).toContain("!draftDirty");
  });

  it("原忙碌关闭限制保留（modalLocked 禁用关闭与 Esc）", () => {
    expect(DIALOG).toContain("const modalLocked = busy || pickingSource;");
    expect(DIALOG).toContain('if (e.key === "Escape" && !modalLocked) onClose();');
    expect(DIALOG).toContain("disabled={modalLocked}");
  });
});

// ---------------------------------------------------------------------------
// store 行为：关闭/重开恢复、切模式保留文本、显式放弃重置（编辑器同形调用）
// ---------------------------------------------------------------------------

// store 接线（模块读 window.api，桩须先于动态 import 就位）
(globalThis as Record<string, unknown>).window = { api: {} };
const { useAppStore } = await import("../src/renderer/src/store");
const draftsModule = await import("../src/renderer/src/lib/debugging-drafts");

describe("store 行为：创建草稿的恢复与放弃（CreateRunDialog 同形调用）", () => {
  beforeEach(() => {
    useAppStore.setState({
      drafts: draftsModule.emptyDraftRepo(),
      createSourceRef: null,
      createDialogOpen: false,
    });
  });

  it("打开（ensure）→ 填写 → 关闭对话框 → 再打开：模式与任务逐字恢复", () => {
    // 第一次打开
    useAppStore.getState().ensureCreateRunDraft();
    useAppStore.getState().writeCreateRunDraft({ systemPrompt: "你是测试助手" });
    useAppStore.getState().writeCreateRunDraft({ userMessage: "总结这份报告" });
    useAppStore.getState().writeCreateRunDraft({ mode: "isolated_files" });

    // 关闭对话框（组件卸载；store 其他状态照常翻动）
    useAppStore.setState({ createDialogOpen: false });
    useAppStore.setState({ settingsSection: "proxy" }); // 设置往返
    useAppStore.setState({ createDialogOpen: true });

    // 第二次打开（编辑器同形：ensure 已存在条目原样保留）
    const entry = useAppStore.getState().ensureCreateRunDraft();
    expect(entry.mode).toBe("isolated_files");
    expect(entry.systemPrompt).toBe("你是测试助手");
    expect(entry.userMessage).toBe("总结这份报告");
  });

  it("切模式保留文本：只推进 mode，systemPrompt/userMessage 原样且修订照常推进", () => {
    useAppStore.getState().ensureCreateRunDraft();
    useAppStore.getState().writeCreateRunDraft({ userMessage: "任务 A" });
    const before = useAppStore.getState().createRunDraftOf()!;

    useAppStore.getState().writeCreateRunDraft({ mode: "isolated_files" });
    const after = useAppStore.getState().createRunDraftOf()!;
    expect(after.mode).toBe("isolated_files");
    expect(after.userMessage).toBe("任务 A");
    expect(after.systemPrompt).toBe(before.systemPrompt);
    expect(after.revision).toBeGreaterThan(before.revision);
  });

  it("显式放弃（CAS）：确认后整份重置为新空表单修订；取消不动仓库", () => {
    useAppStore.getState().ensureCreateRunDraft();
    useAppStore.getState().writeCreateRunDraft({ userMessage: "要被放弃的任务" });
    const dirty = useAppStore.getState().createRunDraftOf()!;
    expect(draftsModule.isCreateRunDraftDirty(dirty)).toBe(true);

    // 确认放弃（编辑器同形：按当前修订 CAS）
    expect(useAppStore.getState().discardCreateRunDraft(dirty.revision)).toBe(true);
    // 放弃后条目为空；对话框立即重新登记 ⇒ 新空表单、修订不复用（防 ABA）
    const fresh = useAppStore.getState().ensureCreateRunDraft();
    expect(fresh.mode).toBe("chat");
    expect(fresh.userMessage).toBe("");
    expect(fresh.revision).toBeGreaterThan(dirty.revision);
  });

  it("旧放弃确认不能删除新修订（确认后继续输入）", () => {
    useAppStore.getState().ensureCreateRunDraft();
    useAppStore.getState().writeCreateRunDraft({ userMessage: "确认时的内容" });
    const confirmedRevision = useAppStore.getState().createRunDraftOf()!.revision;

    // 确认等待期间继续输入 ⇒ 修订推进 ⇒ 旧确认作废
    useAppStore.getState().writeCreateRunDraft({ userMessage: "确认后的新内容" });
    expect(useAppStore.getState().discardCreateRunDraft(confirmedRevision)).toBe(false);
    expect(useAppStore.getState().createRunDraftOf()?.userMessage).toBe("确认后的新内容");
  });

  it("放弃同时清除目录引用（design D4：明确放弃创建清除引用）", () => {
    useAppStore.getState().ensureCreateRunDraft();
    useAppStore.getState().writeCreateRunDraft({ userMessage: "任务" });
    useAppStore.getState().setCreateSourceRef({ token: "tok_x", name: "数据", path: "D:/data" });
    const rev = useAppStore.getState().createRunDraftOf()!.revision;

    // 对话框同形序列：CAS 放弃成功后，组件负责清除目录引用
    if (useAppStore.getState().discardCreateRunDraft(rev)) {
      useAppStore.getState().setCreateSourceRef(null);
    }
    expect(useAppStore.getState().createSourceRef).toBeNull();
    // 引用不进草稿仓库（1.3 的隔离纪律）
    expect(JSON.stringify(useAppStore.getState().drafts)).not.toContain("tok_x");
  });
});
