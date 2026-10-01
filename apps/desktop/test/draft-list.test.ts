import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  emptyDraftRepo,
  ensureCallDraft,
  ensureCreateRunDraft,
  ensureModelAbDraft,
  setModelAbRows,
  writeCallDraftText,
  writeCreateRunDraft,
} from "../src/renderer/src/lib/debugging-drafts";
import type { DraftRepo } from "../src/renderer/src/lib/debugging-drafts";
import {
  deriveDraftList,
  draftBadgeForSpan,
  truncatePreview,
} from "../src/renderer/src/lib/draft-list";

/**
 * U3（preserve-debugging-drafts）任务 2.5：草稿标记、两个列表入口、精确定位、
 * 失效来源的复制/放弃视图。
 *
 * 判据来源（desktop-ui delta「草稿可定位且来源失效不丢输入」）：
 *   - 草稿列表返回精确编辑目标：条目带 runId + spanId + field 的**可辨认身份**，
 *     定位动作把这份身份原样交给 store（不选另一同名调用冒充恢复）
 *   - 本运行列表与全局会话入口共用同一派生/同一视图（design D2）
 *   - 失效视图（复制/放弃）在编辑器（重验闸门 + DraftSourceBanner）与列表（复制/
 *     放弃动作）两处可达；本文件钉 lib 数据与 store 定位，失效判定归 draft-source.test
 */

// ---------------------------------------------------------------------------
// 纯逻辑：deriveDraftList / draftBadgeForSpan
// ---------------------------------------------------------------------------

function repoWithEverything(): DraftRepo {
  let repo = emptyDraftRepo();
  // 运行 A：result（dirty）+ system_prompt（未编辑）+ A/B（dirty）
  repo = ensureCallDraft(repo, { runId: "r_a", spanId: "s1", field: "result" }, "原始结果").repo;
  repo = writeCallDraftText(
    repo,
    { runId: "r_a", spanId: "s1", field: "result" },
    "改过的结果\n第二行",
  );
  repo = ensureCallDraft(repo, { runId: "r_a", spanId: "s1", field: "system_prompt" }, "sys").repo;
  repo = ensureModelAbDraft(repo, { runId: "r_a", spanId: "s2" }, [
    { model: "m", paramsText: "" },
    { model: "m", paramsText: "" },
  ]).repo;
  repo = (function setAbRow(r: DraftRepo): DraftRepo {
    const entry = r.modelAb.r_a?.s2;
    if (entry === undefined) return r;
    return setModelAbRows(r, { runId: "r_a", spanId: "s2" }, [
      { key: entry.rows[0]!.key, model: "m-b", paramsText: "" },
      entry.rows[1]!,
    ]);
  })(repo);
  // 运行 B：messages（dirty，长文本）
  repo = ensureCallDraft(repo, { runId: "r_b", spanId: "s9", field: "messages" }, "[]").repo;
  repo = writeCallDraftText(
    repo,
    { runId: "r_b", spanId: "s9", field: "messages" },
    `[{"role":"user","content":"${"长".repeat(100)}"}]`,
  );
  // 创建草稿
  repo = ensureCreateRunDraft(repo).repo;
  repo = writeCreateRunDraft(repo, { userMessage: "创建任务" });
  return repo;
}

describe("deriveDraftList（两个入口共用的同一派生）", () => {
  it("全会话列表：含调用类 / A/B / 创建，身份可辨认且 dirty 正确", () => {
    const items = deriveDraftList(repoWithEverything());
    const keys = items.map((i) => i.listKey);
    expect(keys).toContain("r_a|s1|result");
    expect(keys).toContain("r_a|s1|system_prompt");
    expect(keys).toContain("r_a|s2|model_ab");
    expect(keys).toContain("r_b|s9|messages");
    expect(keys).toContain("|create");

    const result = items.find((i) => i.listKey === "r_a|s1|result")!;
    expect(result.dirty).toBe(true);
    expect(result.title).toContain("工具结果");
    const untouched = items.find((i) => i.listKey === "r_a|s1|system_prompt")!;
    expect(untouched.dirty).toBe(false);
    const ab = items.find((i) => i.listKey === "r_a|s2|model_ab")!;
    expect(ab.dirty).toBe(true);
  });

  it("copyText 完整不截断；preview 截断且换行可见化（正文不丢）", () => {
    const items = deriveDraftList(repoWithEverything());
    const result = items.find((i) => i.listKey === "r_a|s1|result")!;
    expect(result.copyText).toBe("改过的结果\n第二行");
    expect(result.preview).toContain("⏎");
    expect(result.preview.length).toBeLessThanOrEqual(81);

    const messages = items.find((i) => i.listKey === "r_b|s9|messages")!;
    expect(messages.copyText.length).toBeGreaterThan(80);
    expect(messages.preview.endsWith("…")).toBe(true);
  });

  it("按 runId 过滤（本运行列表）：只含该运行条目，创建草稿被排除", () => {
    const items = deriveDraftList(repoWithEverything(), { runId: "r_a" });
    expect(items.every((i) => i.runId === "r_a")).toBe(true);
    expect(items.every((i) => i.field !== "create")).toBe(true);
    expect(items.map((i) => i.listKey).sort()).toEqual([
      "r_a|s1|result",
      "r_a|s1|system_prompt",
      "r_a|s2|model_ab",
    ]);
  });
});

describe("draftBadgeForSpan（调用旁草稿标记）", () => {
  it("无草稿 ⇒ null；单草稿 ⇒ 草稿：字段；多草稿 ⇒ 草稿 ×N", () => {
    const repo = repoWithEverything();
    expect(draftBadgeForSpan(repo, "r_a", "s_none")).toBeNull();
    const single = draftBadgeForSpan(repo, "r_b", "s9")!;
    expect(single.label).toContain("messages 重发");
    expect(single.dirty).toBe(true);
    const multi = draftBadgeForSpan(repo, "r_a", "s1")!;
    expect(multi.label).toBe("草稿 ×2");
    // A/B 与调用字段同 span 汇总
    const withAb = draftBadgeForSpan(repo, "r_a", "s2")!;
    expect(withAb.label).toContain("A/B");
  });
});

describe("truncatePreview", () => {
  it("短文本原样；超长截断加省略号", () => {
    expect(truncatePreview("短文本")).toBe("短文本");
    const long = "x".repeat(120);
    const out = truncatePreview(long, 80);
    expect(out.length).toBe(81);
    expect(out.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// store 行为：openDraftAt 精确定位（草稿列表「定位」动作的同形调用）
// ---------------------------------------------------------------------------

// store 接线（模块读 window.api，桩须先于动态 import 就位）
(globalThis as Record<string, unknown>).window = { api: {} };
const { useAppStore } = await import("../src/renderer/src/store");

describe("store 行为：openDraftAt 精确返回编辑目标（任务 2.5）", () => {
  beforeEach(() => {
    useAppStore.setState({
      drafts: emptyDraftRepo(),
      pendingDraftTarget: null,
      view: "trace",
      createReturnLocation: null,
      readingByRun: {},
      selectedRunId: null,
      detail: null,
      loadingDetail: false,
    });
  });

  it("调用类目标：切运行（需要时）+ 步骤页签 + 选中 span + 登记 pending", async () => {
    // selectRun 打桩（真实实现会走 IPC；定位职责本身只负责切换与登记）
    let selectedWith: string | null = null;
    useAppStore.setState({
      selectRun: async (id: string) => {
        selectedWith = id;
        useAppStore.setState({ selectedRunId: id });
      },
    });
    await useAppStore
      .getState()
      .openDraftAt({ runId: "r_01", spanId: "s_02", field: "system_prompt" });

    expect(selectedWith).toBe("r_01");
    expect(useAppStore.getState().selectedRunId).toBe("r_01");
    expect(useAppStore.getState().pendingDraftTarget).toEqual({
      runId: "r_01",
      spanId: "s_02",
      field: "system_prompt",
    });
    expect(useAppStore.getState().readingOf("r_01").tab).toBe("steps");
    expect(useAppStore.getState().selectedSpanId).toBe("s_02");
  });

  it("同一运行内的目标不重复 selectRun；create 目标打开创建工作区", async () => {
    useAppStore.setState({
      selectedRunId: "r_01",
      selectRun: async () => {
        throw new Error("同一运行不应再次 selectRun");
      },
    });
    await useAppStore.getState().openDraftAt({ runId: "r_01", spanId: "s_03", field: "result" });
    expect(useAppStore.getState().pendingDraftTarget?.spanId).toBe("s_03");
    expect(useAppStore.getState().selectedSpanId).toBe("s_03");

    await useAppStore.getState().openDraftAt({ runId: "", spanId: null, field: "create" });
    const state = useAppStore.getState();
    // U5 任务 4.1：草稿定位 = 走进创建工作区页面（旧的 `createDialogOpen` 布尔已作废）
    expect(state.view).toBe("create");
    expect(state.pendingDraftTarget).toBeNull();
    // 定位走的是与全局栏同一个入口动作 ⇒ 来源按当时位置重记（这里是 r_01 的调用页）
    expect(state.createReturnLocation).toEqual({
      view: "trace",
      runId: "r_01",
      tab: "steps",
      spanId: "s_03",
      file: null,
    });
  });

  it("consumeDraftTarget 清空 pending（编辑器消费一次后不残留）", () => {
    useAppStore.setState({
      pendingDraftTarget: { runId: "r_01", spanId: "s_02", field: "user_message" },
    });
    useAppStore.getState().consumeDraftTarget();
    expect(useAppStore.getState().pendingDraftTarget).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 接线契约：两个入口共用同一视图组件；编辑器接失效视图与重验闸门
// ---------------------------------------------------------------------------

const DETAIL_PANEL = readFileSync(
  resolve(import.meta.dirname, "../src/renderer/src/components/DetailPanel.tsx"),
  "utf8",
);
const GLOBAL_BAR = readFileSync(
  resolve(import.meta.dirname, "../src/renderer/src/components/GlobalBar.tsx"),
  "utf8",
);
const LIST_PANEL = readFileSync(
  resolve(import.meta.dirname, "../src/renderer/src/components/DraftListPanel.tsx"),
  "utf8",
);

describe("接线契约：草稿入口与失效视图（任务 2.5）", () => {
  // ⚠️ U8 3.1b 改判留痕：ModelAbEditor 迁往独立文件（步骤页不再挂载它），
  // 四编辑器重验闸门的判据改为「DetailPanel 内三个 + ModelAbEditor.tsx 一个」分文件计数。
  const MODEL_AB_EDITOR = readFileSync(
    resolve(import.meta.dirname, "../src/renderer/src/components/ModelAbEditor.tsx"),
    "utf8",
  );
  it("DetailPanel 挂载本运行草稿列表 + 失效横幅；视图组件共享", () => {
    expect(DETAIL_PANEL).toContain("<RunDraftListSection runId={selectedRunId} />");
    expect(DETAIL_PANEL).toContain("deriveDraftList(drafts, { runId })");
    expect(DETAIL_PANEL).toContain("<DraftListPanel");
    expect(DETAIL_PANEL).toContain("DraftSourceBanner");
    // 四个编辑器都叠加重验闸门（恢复重验通过才恢复执行资格）
    const gates =
      (DETAIL_PANEL.match(/sourceBlocked === null/g)?.length ?? 0) +
      (MODEL_AB_EDITOR.match(/sourceBlocked === null/g)?.length ?? 0);
    expect(gates).toBeGreaterThanOrEqual(4);
  });

  it("GlobalBar 挂载全会话入口：同一面板组件、不按 run 过滤", () => {
    expect(GLOBAL_BAR).toContain("<SessionDraftsEntry />");
    expect(GLOBAL_BAR).toContain("deriveDraftList(drafts)");
    expect(GLOBAL_BAR).toContain("<DraftListPanel");
  });

  it("DraftListPanel 提供定位/复制/放弃三个动作（失效视图在列表可达）", () => {
    expect(LIST_PANEL).toContain("onOpen(item)");
    expect(LIST_PANEL).toContain("onCopy(item)");
    expect(LIST_PANEL).toContain("onDiscard(item)");
  });
});
