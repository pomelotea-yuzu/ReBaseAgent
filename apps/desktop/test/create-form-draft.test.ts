import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { auditForbiddenTokens } from "../src/renderer/src/lib/overview-view";
import { installOperationChannels } from "./helpers/operation-channels";

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
    // U3 3.5 起冻结期也视同忙碌（待定提交不得被关窗或 Esc 绕开）
    expect(DIALOG).toContain("const modalLocked = busy || pickingSource || draftFrozen;");
    // U3 6.10：Esc 关闭锁改由 ModalDialog 单通道承担（closeDisabled → keydown 捕获
    // 吞 Escape + cancel 双保险）；原 window keydown 监听与 cancel 双通道并存，
    // 嵌套放弃确认在场时一次按键会同时关掉确认与创建对话框 ⇒ 必须消失
    expect(DIALOG).toContain("closeDisabled={modalLocked}");
    expect(DIALOG).not.toContain('e.key === "Escape"');
    expect(DIALOG).toContain("disabled={modalLocked}");
  });
});

// ---------------------------------------------------------------------------
// U3 任务 3.2：sourceToken 独立受限引用接线
// ---------------------------------------------------------------------------

const SOURCE_REF = readFileSync(
  resolve(import.meta.dirname, "../src/renderer/src/components/CreateRunDialog.tsx"),
  "utf8",
);

describe("接线契约：sourceToken 会话引用（任务 3.2，design D4）", () => {
  it("打开时从会话级引用恢复源目录（授权不随引用恢复，仍为未选）", () => {
    expect(SOURCE_REF).toContain("const ref = useAppStore.getState().createSourceRef;");
    // 授权字段不来自引用：initialCreateRunForm 的 writesAuthorized: false 保留
    expect(SOURCE_REF).toContain("...initialCreateRunForm()");
  });

  it("选择成功镜像到会话引用；取消保留原引用；请求代次守卫迟到响应", () => {
    expect(SOURCE_REF).toContain(
      "setCreateSourceRef({ token: result.sourceToken, name: result.name, path: result.path })",
    );
    expect(SOURCE_REF).toContain("取消目录选择**保留原引用**");
    expect(SOURCE_REF).toContain("const pickGeneration = useRef(0);");
    expect(SOURCE_REF).toContain("if (generation !== pickGeneration.current) return;");
  });

  it("切模式清除引用；INVALID_SOURCE_TOKEN 提示重选但不清空草稿任务", () => {
    // 切模式片段（到 discardDraft 为止）必须含清引用
    const modeStart = SOURCE_REF.indexOf("const switchMode");
    const modeEnd = SOURCE_REF.indexOf("const discardDraft");
    const switchModeSlice = SOURCE_REF.slice(modeStart, modeEnd);
    expect(switchModeSlice).toContain("setCreateSourceRef(null)");
    // 失效令牌：清引用要求重选；任务/系统指令/模式在草稿里原样保留
    expect(SOURCE_REF).toContain('createRunErrorCode !== "INVALID_SOURCE_TOKEN"');
    expect(SOURCE_REF).toContain("不能清空任务");
  });
});

// ---------------------------------------------------------------------------
// store 行为：关闭/重开恢复、切模式保留文本、显式放弃重置（编辑器同形调用）
// ---------------------------------------------------------------------------

// store 接线（模块读 window.api，桩须先于动态 import 就位）
(globalThis as Record<string, unknown>).window = { api: {} };
// U4：创建是主动执行入口，提交前要先与 main 握手取 epoch
installOperationChannels((globalThis.window as unknown as { api: Record<string, unknown> }).api);
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

  it("任务 3.2：INVALID_SOURCE_TOKEN 提交失败不清空草稿任务（要求重选目录）", async () => {
    useAppStore.getState().ensureCreateRunDraft();
    useAppStore.getState().writeCreateRunDraft({ userMessage: "保留的任务" });
    useAppStore.getState().writeCreateRunDraft({ mode: "isolated_files" });
    const repoBefore = useAppStore.getState().drafts;

    // api 桩：main 消费点拒绝（token 失效/已消费）；失败路径的列表刷新一并打桩
    (globalThis.window as unknown as { api: Record<string, unknown> }).api.createRun =
      async () => ({
        ok: false as const,
        error: { code: "INVALID_SOURCE_TOKEN", message: "源目录令牌无效或已消费" },
      });
    (globalThis.window as unknown as { api: Record<string, unknown> }).api.listRuns = async () => ({
      ok: false as const,
      error: { code: "STUB", message: "桩" },
    });
    const created = await useAppStore.getState().createRun({
      systemPrompt: "",
      userMessage: "保留的任务",
      workspace: { mode: "isolated_files", sourceToken: "tok_stale", allowFileWrites: true },
    });
    expect(created).toBe(false);
    expect(useAppStore.getState().createRunErrorCode).toBe("INVALID_SOURCE_TOKEN");

    // 任务 / 模式在草稿里原样保留（引用清除由对话框 effect 负责——源码契约已钉）
    expect(useAppStore.getState().drafts).toBe(repoBefore);
    const entry = useAppStore.getState().createRunDraftOf();
    expect(entry?.userMessage).toBe("保留的任务");
    expect(entry?.mode).toBe("isolated_files");
  });
});
