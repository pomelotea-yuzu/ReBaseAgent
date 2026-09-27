import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import * as sessionLib from "../src/renderer/src/lib/operation-session";
import { auditForbiddenTokens } from "../src/renderer/src/lib/overview-view";
import { executedFail, installOperationChannels } from "./helpers/operation-channels";

/**
 * U3（preserve-debugging-drafts）任务 2.3：创建表单恢复模式/任务/system，
 * 关闭/设置往返保留，显式放弃重置；保留原锁定判据。
 *
 * 判据来源（tasks 2.3 验收 + delta「创建表单按会话草稿恢复」）：
 *   - 创建关闭配置再新建仍有任务（离开创建页 ≠ 丢弃草稿）
 *   - 切创建模式保留文本而放弃重置表单
 *   - 忙碌锁定判据不变（创建中 / 选目录中 / 待定提交冻结）
 *
 * ⚠️ U5 任务 4.1 的改判（不是削弱）：创建从覆盖模态变成主工作区的一个页面，
 *    所以"关闭对话框 / 模态 Esc 锁"这一族契约换成"表单锁定判据 + 不得做成模态"；
 *    草稿的恢复 / 切模式 / 放弃语义一字未动。
 *
 * ⚠️ 本包无 jsdom ⇒ 与 2.1/2.2 同法：源码级接线契约 + store 同形调用行为；
 *    实机往返归 CDP（任务 6.2）。
 */

// ---------------------------------------------------------------------------
// 源码级接线契约
// ---------------------------------------------------------------------------

const WORKSPACE = readFileSync(
  resolve(import.meta.dirname, "../src/renderer/src/components/CreateRunWorkspace.tsx"),
  "utf8",
);

describe("接线契约：创建工作区读写创建草稿（任务 2.3）", () => {
  it("挂载即登记创建草稿（ensureCreateRunDraft），文本字段从草稿派生", () => {
    expect(WORKSPACE).toContain("ensureCreateRunDraft()");
    expect(WORKSPACE).toContain("s.createRunDraftOf()");
    // 文本读取走草稿（带默认回退），不再持有本地文本 state
    expect(WORKSPACE).toContain('draftEntry?.systemPrompt ?? ""');
    expect(WORKSPACE).toContain('draftEntry?.userMessage ?? ""');
  });

  it("输入同步写入草稿；本地文本 setter 已移除（重开覆盖输入的旧根因）", () => {
    expect(WORKSPACE).toContain("writeCreateRunDraft({ systemPrompt: text })");
    expect(WORKSPACE).toContain("writeCreateRunDraft({ userMessage: text })");
    expect(auditForbiddenTokens(WORKSPACE, ["setSystemPrompt", "setUserMessage"])).toEqual([]);
  });

  it("切模式写草稿且不重置文本（switchMode 不碰 systemPrompt/userMessage）", () => {
    expect(WORKSPACE).toContain("writeCreateRunDraft({ mode })");
    // switchCreateRunMode 的文档契约：文本不属于授权状态（lib 已单测），组件不得在此清文本
    expect(auditForbiddenTokens(WORKSPACE, ['systemPrompt: ""', 'userMessage: ""'])).toEqual([]);
  });

  it("显式放弃：确认后按 CAS 放弃草稿并重置表单（取消不丢内容）", () => {
    expect(WORKSPACE).toContain("discardCreateRunDraft(current.revision)");
    expect(WORKSPACE).toContain("isCreateRunDraftDirty(current)");
    // 放弃同时清除目录引用（design D4）并复位本地授权状态
    expect(WORKSPACE).toContain("setCreateSourceRef(null)");
    expect(WORKSPACE).toContain("setForm(initialCreateRunForm())");
    // 无变更时不可放弃（不制造虚假草稿动作）：判据进 lock.canDiscard，禁用由视图落到按钮
    expect(WORKSPACE).toContain("canDiscard: draftDirty && !formLocked");
  });

  it("锁定判据不变，但创建页不得做成模态（U5 4.1：焦点不禁闭、离页不挡）", () => {
    // U3 3.5 起冻结期也视同忙碌（待定提交期间不得改这份草稿）
    expect(WORKSPACE).toContain("const formLocked = busy || pickingSource || draftFrozen;");
    // 锁位经 `lock` 交给视图（4.2 拆分）；"禁用真的落到控件上"是能力断言，
    // 打在 create-form-view.test.ts 的喂 props 用例上，不在这里靠字符串猜
    const at = WORKSPACE.indexOf("lock={{");
    const lockLiteral = WORKSPACE.slice(at, WORKSPACE.indexOf("}}", at));
    expect(at).toBeGreaterThan(-1);
    expect(lockLiteral).toContain("fields: formLocked");
    expect(lockLiteral).toContain("draftFrozen,");
    expect(lockLiteral).toContain("canSubmit: canCreate");
    // U5 4.1：创建是页面——不得套 ModalDialog（那是"执行期间锁全窗"的旧形态），
    // 也不自己处理 Escape（盖在它上面的确认框才是模态）
    expect(auditForbiddenTokens(WORKSPACE, ["<ModalDialog", 'e.key === "Escape"'])).toEqual([]);
  });

  it("来源与草稿分开：返回来源走 store 动作，页面不自算位置", () => {
    expect(WORKSPACE).toContain("s.returnToCreateSource");
    expect(WORKSPACE).toContain("returnToCreateSource()");
    // 来源引用不进草稿、也不由组件读写（判据全在 lib/create-workspace.ts + store）
    expect(WORKSPACE).not.toContain("createReturnLocation");
  });
});

// ---------------------------------------------------------------------------
// U3 任务 3.2：sourceToken 独立受限引用接线
// ---------------------------------------------------------------------------

const SOURCE_REF = readFileSync(
  resolve(import.meta.dirname, "../src/renderer/src/components/CreateRunWorkspace.tsx"),
  "utf8",
);

describe("接线契约：sourceToken 会话引用（任务 3.2 / U5 任务 4.3 取现场判据）", () => {
  it("重进创建页的底稿走 restoreCreateForm（引用与模式恢复、授权复位）", () => {
    // U5 4.3：这段判据此前散在组件的 useState 初始化里（只能靠字符串钉），
    // 现在收敛到 lib 的纯函数并由 create-run-dialog.test.ts 逐条测行为
    expect(SOURCE_REF).toContain("restoreCreateForm({");
    expect(SOURCE_REF).toContain("sourceRef: useAppStore.getState().createSourceRef");
    expect(SOURCE_REF).toContain("draftMode: useAppStore.getState().createRunDraftOf()?.mode");
    // 组件不再自己决定"授权跟不跟引用回来"——它连 writesAuthorized 这个键都不写
    expect(auditForbiddenTokens(SOURCE_REF, ["writesAuthorized: true"])).toEqual([]);
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

describe("store 行为：创建草稿的恢复与放弃（创建工作区同形调用）", () => {
  beforeEach(() => {
    useAppStore.setState({
      drafts: draftsModule.emptyDraftRepo(),
      createSourceRef: null,
      view: "trace",
      createReturnLocation: null,
      operations: sessionLib.initialSession(),
    });
  });

  it("打开（ensure）→ 填写 → 离开创建页 → 再打开：模式与任务逐字恢复", () => {
    // 第一次打开
    useAppStore.getState().ensureCreateRunDraft();
    useAppStore.getState().writeCreateRunDraft({ systemPrompt: "你是测试助手" });
    useAppStore.getState().writeCreateRunDraft({ userMessage: "总结这份报告" });
    useAppStore.getState().writeCreateRunDraft({ mode: "isolated_files" });

    // 离开创建页（组件卸载；store 其他状态照常翻动）+ 设置往返
    useAppStore.setState({ view: "trace" });
    useAppStore.setState({ settingsSection: "proxy" }); // 设置往返
    useAppStore.setState({ view: "create" });

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
    // 放弃后条目为空；创建页立即重新登记 ⇒ 新空表单、修订不复用（防 ABA）
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

    // 创建页同形序列：CAS 放弃成功后，组件负责清除目录引用
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
    (globalThis.window as unknown as { api: Record<string, unknown> }).api.createRun = executedFail(
      "INVALID_SOURCE_TOKEN",
      "源目录令牌无效或已消费",
    );
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

    // 任务 / 模式在草稿里原样保留（引用清除由创建页 effect 负责——源码契约已钉）
    expect(useAppStore.getState().drafts).toBe(repoBefore);
    const entry = useAppStore.getState().createRunDraftOf();
    expect(entry?.userMessage).toBe("保留的任务");
    expect(entry?.mode).toBe("isolated_files");
  });
});
