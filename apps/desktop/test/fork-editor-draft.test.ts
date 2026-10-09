import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { captureCallDraftSource } from "../src/renderer/src/lib/draft-source";
import { auditForbiddenTokens } from "../src/renderer/src/lib/overview-view";
import type { RunDetail } from "../src/shared/ipc";

/**
 * U3（preserve-debugging-drafts）任务 2.1：工具结果编辑器（ForkEditor）改读写 store。
 *
 * 判据来源（desktop-ui delta「编辑核对与明确放弃区分于收起」+ tasks 2.1 验收）：
 *   - result 草稿经步骤页签和运行往返逐字恢复
 *   - 关闭编辑与设置往返保留内容（关闭 ≠ 放弃）
 *   - 去除重新打开时覆盖输入（重开经 ensure 登记基线：已存在条目原样保留）
 *   - 普通/隔离共用保留规则（同一组件、同一 runId+spanId+field 身份）
 *
 * ⚠️ 本包无 jsdom ⇒ 「编辑器消费 store」用两层证据：
 *   1. **源码级接线契约**（ForkEditor 函数体切片 + auditForbiddenTokens 剥注释审计）；
 *   2. **store 行为**：编辑器实际调用的动作序列（ensure → write → 其他状态翻动 → 重读）
 *      逐字恢复，重开 ensure 不覆盖（与 1.1/1.4 的 lib 测试互补，这里走编辑器同形调用）。
 *   "接线对而行为错"归 CDP 实机（任务 6.2）。
 */

// ---------------------------------------------------------------------------
// 源码级接线契约
// ---------------------------------------------------------------------------

const DETAIL_PANEL = readFileSync(
  resolve(import.meta.dirname, "../src/renderer/src/components/DetailPanel.tsx"),
  "utf8",
);

/** 切出 ForkEditor 函数体（到下一个组件定义为止），使禁用型断言不误伤其他编辑器 */
function forkEditorSource(): string {
  const start = DETAIL_PANEL.indexOf("function ForkEditor(");
  const end = DETAIL_PANEL.indexOf("/** tool.invoke 详情");
  if (start < 0 || end < 0 || end <= start) throw new Error("DetailPanel.tsx 结构变化，切片失败");
  return DETAIL_PANEL.slice(start, end);
}

describe("接线契约：ForkEditor 读写 store 草稿（任务 2.1）", () => {
  it("打开时经 ensureCallDraft 登记基线并捕获源基线（captureCallDraftSource）", () => {
    const src = forkEditorSource();
    expect(src).toContain("ensureCallDraft(");
    expect(src).toContain("captureCallDraftSource(run, span)");
  });

  it("输入 onChange 同步写入 store（writeCallDraftText），不再持有本地 value state", () => {
    const src = forkEditorSource();
    expect(src).toContain("writeCallDraftText(");
    // 本地 value state 是"重新打开覆盖输入"的旧根因：该切片内不得再有
    expect(auditForbiddenTokens(src, ["setValue", "useState(() =>"])).toEqual([]);
  });

  it("编辑值从草稿条目派生（callDraftOf）；放弃只经失效视图的 CAS 确认，取消/收起不删草稿", () => {
    const src = forkEditorSource();
    expect(src).toContain("s.callDraftOf(draftKey)");
    // U3 2.5：放弃入口只存在于来源失效视图（确认 + 按当前修订 CAS）；取消/收起路径仍不删
    expect(src).toContain("DraftSourceBanner");
    // U3 5.2：确认改为异步模态，放弃执行点按请求时快照修订做 CAS
    expect(src).toContain("discardCallDraft(draftKey, snapshot.revision)");
  });

  it("普通/隔离共用同一编辑器与同一草稿身份（isolated 分支在 ForkEditor 内）", () => {
    const src = forkEditorSource();
    // 隔离分支不是另一套编辑器：同一 draftKey（runId + spanId + "result"）对两条路径生效
    expect(src).toContain('field: "result"');
    expect(src).toContain("isolated");
  });
});

// ---------------------------------------------------------------------------
// U3 任务 2.6：原值/草稿核对布局 + 按修订明确放弃
// ---------------------------------------------------------------------------

describe("接线契约：原值/草稿核对与按修订放弃（任务 2.6）", () => {
  const src = forkEditorSource;

  it("原值（只读）/草稿（可编辑）就近核对：宽屏并排、窄屏上下，两侧完整可读", () => {
    const code = src();
    // UI 密度 2.3：并排/上下改由 DraftCompareGrid 按实测容器宽决策（xl 断点退场）；
    // 「原值（只读）/草稿（可编辑）」标签与布局类都落在共享布局层里
    expect(code).toContain('compareKey="tool-result"');
    // 切片不含 import 区 ⇒ 断言 JSX 使用（import 在文件头，由 draft-compare-grid.test.tsx 钉）
    expect(code).toContain("<DraftCompareGrid");
    // 原值只读 twin + 两侧都不截断正文（wordWrap）
    expect(code).toContain("readOnly: true");
    expect(code.match(/wordWrap: "on"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("放弃修改：确认核对当前内容、按渲染快照修订 CAS；取消逐字保留", () => {
    const code = src();
    expect(code).toContain("放弃修改");
    // 确认等待期间内容被更新 ⇒ CAS 拒绝（旧确认不作数），界面保持当前内容
    expect(code).toContain("discardCallDraft(draftKey, snapshot.revision)");
    expect(code).toContain("if (!confirmed) return; // 取消：逐字保留");
    // 无变更（含改回基线）时不可放弃
    expect(code).toContain("disabled={inProgress || unchanged}");
  });

  it("清空为零长度的变更同样要经确认（dirty 判据不豁免空串）", () => {
    const code = src();
    // 放弃按钮的可用性由 unchanged（text !== baseline）驱动：空串偏离基线即可放弃
    expect(code).toContain("const unchanged = value === original;");
    expect(code).toContain("disabled={inProgress || unchanged}");
  });
});

// ---------------------------------------------------------------------------
// store 行为：编辑器实际调用的动作序列
// ---------------------------------------------------------------------------

const FIXTURE = resolve(import.meta.dirname, "../../../packages/trace-sdk/fixtures/normal.jsonl");
const record: RunRecord = readRun(FIXTURE);

function detailFrom(rec: RunRecord): RunDetail {
  return {
    meta: rec.meta,
    spans: rec.spans,
    events: rec.events,
    status: rec.status,
    chain: [{ meta: rec.meta, fork: rec.meta.fork }],
    leafSpanIds: rec.spans.map((s) => s.id),
  };
}

const detail = detailFrom(record);
const toolSpan = detail.spans.find((s) => s.id === "s_03");
if (toolSpan === undefined || toolSpan.kind !== "tool.invoke") {
  throw new Error("fixture 缺少 tool.invoke span（s_03）");
}

// store 接线（模块读 window.api，桩须先于动态 import 就位）
(globalThis as Record<string, unknown>).window = { api: {} };
const { useAppStore } = await import("../src/renderer/src/store");
const draftsModule = await import("../src/renderer/src/lib/debugging-drafts");

describe("store 行为：result 草稿逐字恢复与重开不覆盖（ForkEditor 同形调用）", () => {
  const key = { runId: detail.meta.id, spanId: "s_03", field: "result" as const };
  /** 含尾随空白/换行的哨兵：逐字恢复不许 trim */
  const BASELINE = "工具输出原文\n  \n";

  beforeEach(() => {
    useAppStore.setState({ drafts: draftsModule.emptyDraftRepo() });
  });

  it("打开 → 编辑 → 切页签/切运行（其他状态翻动）→ 重开：草稿逐字恢复", () => {
    const run = detail;
    // 打开（编辑器同形：ensure + 源基线捕获）
    useAppStore.getState().ensureCallDraft(key, BASELINE, captureCallDraftSource(run, toolSpan));
    // 键入（Monaco onChange 同形）
    useAppStore.getState().writeCallDraftText(key, "编辑后的工具结果\n");
    const afterEdit = useAppStore.getState().callDraftOf(key);
    expect(afterEdit?.text).toBe("编辑后的工具结果\n");
    const revision = afterEdit?.revision;

    // 步骤页签往返 + 运行往返 + 列表刷新（store 状态翻动；编辑器卸载重挂）
    useAppStore.getState().setReadingTab(detail.meta.id, "overview");
    useAppStore.getState().setReadingTab(detail.meta.id, "steps");
    useAppStore.setState({ selectedRunId: null, detail: null, loadingDetail: true });
    useAppStore.setState({ selectedRunId: detail.meta.id, detail, loadingDetail: false });

    // 重开（编辑器同形：再次 ensure）——条目原样保留，逐字恢复
    useAppStore.getState().ensureCallDraft(key, BASELINE, captureCallDraftSource(run, toolSpan));
    const restored = useAppStore.getState().callDraftOf(key);
    expect(restored?.text).toBe("编辑后的工具结果\n");
    expect(restored?.revision).toBe(revision);
  });

  it("重开不覆盖输入：ensure 传同一基线，已编辑条目原样保留", () => {
    useAppStore.getState().ensureCallDraft(key, BASELINE, captureCallDraftSource(detail, toolSpan));
    useAppStore.getState().writeCallDraftText(key, "用户改过的内容");
    const edited = useAppStore.getState().callDraftOf(key);

    // 模拟重开（open click → ensure）：基线仍是当前源文本
    const reopened = useAppStore
      .getState()
      .ensureCallDraft(key, BASELINE, captureCallDraftSource(detail, toolSpan));
    expect(reopened).toBe(edited); // 同一对象：基线/文本/修订都没动
    expect(reopened.text).toBe("用户改过的内容");
  });

  it("源基线随首次 ensure 落库且重开不换（隔离/普通两条路径同键互认）", () => {
    const source = captureCallDraftSource(detail, toolSpan);
    useAppStore.getState().ensureCallDraft(key, BASELINE, source);
    expect(useAppStore.getState().callDraftOf(key)?.source).toBe(source);

    // 另一次打开再捕获（即使详情对象是重新构造的）也不覆盖已落库的源基线
    const source2 = captureCallDraftSource(detailFrom(readRun(FIXTURE)), toolSpan);
    useAppStore.getState().ensureCallDraft(key, BASELINE, source2);
    expect(useAppStore.getState().callDraftOf(key)?.source).toBe(source);
  });

  it("任务 2.6：清空为零长度的变更同样按修订放弃（空串不绕过确认）", () => {
    useAppStore.getState().ensureCallDraft(key, BASELINE, captureCallDraftSource(detail, toolSpan));
    // 清空为零长度：dirty（需保护），放弃确认后按快照修订 CAS 删除
    useAppStore.getState().writeCallDraftText(key, "");
    const entry = useAppStore.getState().callDraftOf(key)!;
    expect(entry.text).toBe("");
    expect(useAppStore.getState().discardCallDraft(key, entry.revision)).toBe(true);
    expect(useAppStore.getState().callDraftOf(key)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// U3 任务 3.1：预检修订绑定、授权生命周期与迟到守卫
// ---------------------------------------------------------------------------

describe("接线契约：预检修订绑定与授权生命周期（任务 3.1）", () => {
  it("预检结论绑定确认时的草稿修订；迟到响应不安装旧结论", () => {
    const code = forkEditorSource();
    // 确认时记录修订（请求代次），响应按它校验
    expect(code).toContain("const requestedRevision = draftRevision;");
    expect(code).toContain("useAppStore.getState().callDraftOf(draftKey)?.revision ?? null");
    expect(code).toContain("if (currentRevision !== requestedRevision) return;");
    // 取用结论同样要求修订一致：改走又改回同一文本也不复活旧结论
    expect(code).toContain("verified.revision === draftRevision");
  });

  it("恢复/离开编辑器后必须重新预检（结论与授权均为组件局部态）", () => {
    const code = forkEditorSource();
    // useState 局部：组件重挂即重置 ⇒ 恢复草稿后 capability 与授权均为空，须重走门禁
    expect(code).toContain("const [verified, setVerified] = useState<{");
    expect(code).toContain("const [writesAuthorized, setWritesAuthorized] = useState(false);");
    // 结论/comment 明确「恢复编辑器……必须重新预检」的绑定语义
    expect(code).toContain("恢复编辑器（组件");
  });

  it("内容变化使本次副本授权失效（授权只用于当次提交）", () => {
    const code = forkEditorSource();
    // onChange 序列：写草稿 + 作废结论 + 作废授权（design D4）
    expect(code).toContain('writeCallDraftText(draftKey, next ?? "")');
    expect(code).toContain("setVerified(null);");
    expect(code).toContain("setWritesAuthorized(false);");
  });
});

describe("store 行为：预检是只读通道，不动草稿仓库（任务 3.1）", () => {
  const key = { runId: detail.meta.id, spanId: "s_03", field: "result" as const };

  beforeEach(() => {
    useAppStore.setState({ drafts: draftsModule.emptyDraftRepo() });
  });

  it("loadForkCapability 全流程（含失败信封）不写草稿：仓库引用与条目原样", async () => {
    useAppStore
      .getState()
      .ensureCallDraft(key, "草稿内容", captureCallDraftSource(detail, toolSpan));
    useAppStore.getState().writeCallDraftText(key, "编辑后内容");
    const repoBefore = useAppStore.getState().drafts;

    // api 桩注入失败信封（成功路径的形状校验归 store.test；此处核对「预检不碰草稿」）
    (globalThis.window as unknown as { api: Record<string, unknown> }).api.forkCapability =
      async () => ({ ok: false as const, error: { code: "STUB", message: "桩" } });
    const outcome = await useAppStore.getState().loadForkCapability({
      parentRunId: detail.meta.id,
      atSpanId: "s_03",
      edit: { field: "result", value: "编辑后内容" },
    });
    expect(outcome.ok).toBe(false);

    expect(useAppStore.getState().drafts).toBe(repoBefore);
    expect(useAppStore.getState().callDraftOf(key)?.text).toBe("编辑后内容");
  });
});
