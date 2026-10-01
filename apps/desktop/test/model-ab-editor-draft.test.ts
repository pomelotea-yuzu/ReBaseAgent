import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import type { ExecutedRequest } from "@shared/operations";
import { beforeEach, describe, expect, it } from "vitest";
import { captureCallDraftSource } from "../src/renderer/src/lib/draft-source";
import { auditForbiddenTokens } from "../src/renderer/src/lib/overview-view";
import type { RunDetail } from "../src/shared/ipc";
import { executedFail, installOperationChannels } from "./helpers/operation-channels";

/**
 * U3（preserve-debugging-drafts）任务 2.4：A/B 编辑器接入批次草稿。
 *
 * 判据来源（tasks 2.4 验收 + delta「实验批次按会话草稿恢复」）：
 *   - 实验臂增删和非法参数可恢复（稳定行 ID；非法 paramsText 原样）
 *   - 实验预览和结果不隐式清理批次（预检/执行只动本地 plan/executed）
 *   - 恢复时清理临时计划和许可（打开即复位：计划重新校验、授权重新勾选）
 *
 * ⚠️ 本包无 jsdom ⇒ 与 2.1/2.2/2.3 同法：源码级接线契约 + store 同形调用行为；
 *    实机往返归 CDP（任务 6.2）。
 */

// ---------------------------------------------------------------------------
// 源码级接线契约
// ---------------------------------------------------------------------------

// ⚠️ U8 3.1a 改判留痕（2026-10-01）：ModelAbEditor 提取为独立文件
// components/ModelAbEditor.tsx（逐字搬出、零行为变化），源码级断言整文件改读新文件
// （不再需要切片——该文件只承载这一个组件与它的两个展示助手）。
const MODEL_AB_EDITOR = readFileSync(
  resolve(import.meta.dirname, "../src/renderer/src/components/ModelAbEditor.tsx"),
  "utf8",
);

describe("接线契约：ModelAbEditor 批次草稿（任务 2.4）", () => {
  const src = () => MODEL_AB_EDITOR;

  it("打开经 ensureModelAbDraft 登记基线臂与源基线；行来自草稿条目", () => {
    const code = src();
    expect(code).toContain(
      "ensureModelAbDraft(draftKey, baselineArms, captureCallDraftSource(run, span))",
    );
    expect(code).toContain("s.modelAbDraftOf(draftKey)");
    // 行 ID 用共享生成器（1.3 预留），不再持有本地行 state
    expect(code).toContain("newArmRowKey()");
    expect(
      auditForbiddenTokens(code, ["setRows", "useState<Array<{ key: string; arm: ArmDraft }>>"]),
    ).toEqual([]);
  });

  it("U8 6.7 实机坐实：工作区形态（alwaysOpen）挂载即登记基线草稿（运行入口直达可编辑）", () => {
    const code = src();
    // 「接线少一支」家族（2026-10-01）：alwaysOpen 恒展开 ⇒ 不走折叠态展开按钮的
    // ensure 路径 ⇒ 运行入口打开的工作区没有草稿，臂行不渲染。钉住挂载 effect 的
    // 接线：条件、调用与幂等语义（ensure 已存在批次原样保留）三段缺一不可。
    const effectStart = code.indexOf("if (!alwaysOpen) return;");
    expect(effectStart).toBeGreaterThan(-1);
    const effectBody = code.slice(effectStart, code.indexOf("}, [alwaysOpen", effectStart));
    expect(effectBody).toContain(
      "ensureModelAbDraft(draftKey, baselineArms, captureCallDraftSource(run, span))",
    );
  });

  it("增删行/改参数统一经 setModelAbRows 落 store；行变更作废已校验计划", () => {
    const code = src();
    // store 动作在组件里别名为 writeRows（选择器处可见真实通道名）
    expect(code).toContain("s.setModelAbRows");
    expect(code).toContain("writeRows(");
    // commitRows 是唯一行写入路径（updateArm / 删行 / 加行都走它），且都清 plan
    expect(code).toContain("const commitRows = ");
    expect(code).toContain("setPlan(null);");
  });

  it("打开即清理临时计划与许可（授权不随草稿恢复）；放弃只经失效视图 CAS，预览/执行不隐式清理批次", () => {
    const code = src();
    // 打开点击序列：复位本地临时态 + ensure 草稿
    // U5 5.1 改判（两边留痕）：批次呈现改吃登记快照——本地指针由 `executed`（信封数据）
    // 改为 `executedOperationId`（提交身份）。
    // U8 4.1 再改判（两边留痕）：批次结果区迁到实验工作区（ExperimentResults，按 main
    // 登记派生）⇒ 提交身份指针从编辑器移除，"临时态清理"这条判据本身不变（只剩计划与许可）。
    expect(code).not.toContain("executedOperationId");
    expect(code).toContain("setPlan(null);");
    expect(code).toContain("setAllowSideEffects(false);");
    // U3 2.5：放弃入口只在来源失效视图（CAS + 确认）；预览/执行路径无任何草稿删除
    expect(code).toContain("DraftSourceBanner");
    // U3 5.2：确认改为异步模态，放弃执行点按请求时快照修订做 CAS
    expect(code).toContain("discardModelAbDraft(draftKey, snapshot.revision)");
  });

  it("任务 2.6：放弃整批（不提供批量清除）+ 基线臂/批次草稿核对网格", () => {
    const code = src();
    // 放弃整批：确认核对全部臂内容，按渲染快照修订 CAS
    expect(code).toContain("放弃整批");
    expect(code).toContain("discardModelAbDraft(draftKey, snapshot.revision)");
    // 无修改（批次与基线一致）不可放弃
    expect(code).toContain("disabled={inProgress || !isBatchDirty}");
    // 核对网格：父本基线臂只读 vs 批次草稿，宽屏并排窄屏上下
    expect(code).toContain('data-draft-compare="model-ab"');
    expect(code).toContain("grid-cols-1 gap-2 xl:grid-cols-2");
    expect(code).toContain("原值（父本基线臂 · 只读）");
    // 6.9 实机缺陷：无空格 JSON 长拉丁串（`{"temperature":0.777…`）在窄盒不断行 ⇒
    // 两侧臂行绘制右溢 26~36px 截文 ⇒ 基线与草稿臂行一律 break-all 强制断行
    expect(code).toContain('className="font-code break-all text-[11px] leading-4 text-gray-600"');
    expect(code).toContain('className="font-code break-all text-[11px] leading-4 text-gray-700"');
  });
});

// ---------------------------------------------------------------------------
// store 行为：增删行与非法参数恢复（编辑器同形调用）
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
const firstLlmSpan = detail.spans.find((s) => s.id === "s_02");
if (firstLlmSpan === undefined || firstLlmSpan.kind !== "llm.call") {
  throw new Error("fixture 缺少首个 llm.call span（s_02）");
}

// store 接线（模块读 window.api，桩须先于动态 import 就位）
(globalThis as Record<string, unknown>).window = { api: {} };
// U4：主动/A-B 只读预览两条通道都要先握手取 epoch，这里装上默认应答
installOperationChannels((globalThis.window as unknown as { api: Record<string, unknown> }).api);
const { useAppStore } = await import("../src/renderer/src/store");
const draftsModule = await import("../src/renderer/src/lib/debugging-drafts");

describe("store 行为：A/B 批次草稿的增删行与恢复（ModelAbEditor 同形调用）", () => {
  const key = { runId: detail.meta.id, spanId: "s_02" };
  const source = captureCallDraftSource(detail, firstLlmSpan);
  const BASELINE = [
    { model: "deepseek-chat", paramsText: "" },
    { model: "deepseek-chat", paramsText: "" },
  ];

  beforeEach(() => {
    useAppStore.setState({ drafts: draftsModule.emptyDraftRepo() });
  });

  it("打开 → 改参数（含非法 JSON）/增删行 → 关闭往返 → 重开：逐字恢复且行 ID 稳定", () => {
    // 打开（编辑器同形：ensure 基线臂 + 源基线）
    useAppStore.getState().ensureModelAbDraft(key, BASELINE, source);
    const initialKeys = useAppStore
      .getState()
      .modelAbDraftOf(key)!
      .rows.map((r) => r.key);

    // 改第一臂 paramsText 为非法 JSON（guard 会拦提交，但草稿原样暂存）
    const rows1 = useAppStore.getState().modelAbDraftOf(key)!.rows;
    useAppStore
      .getState()
      .setModelAbRows(key, [{ ...rows1[0]!, model: "m-b", paramsText: "]{ 非法 JSON" }, rows1[1]!]);
    // 加一臂
    const rows2 = useAppStore.getState().modelAbDraftOf(key)!.rows;
    useAppStore
      .getState()
      .setModelAbRows(key, [
        ...rows2,
        { key: draftsModule.newArmRowKey(), model: "m-c", paramsText: "" },
      ]);

    // 关闭往返（store 其他状态翻动；组件卸载）
    useAppStore.setState({ detail: null, selectedRunId: null });

    // 重开（ensure 原样保留）——臂内容与行 ID 都恢复
    useAppStore.getState().ensureModelAbDraft(key, BASELINE, source);
    const restored = useAppStore.getState().modelAbDraftOf(key)!;
    expect(restored.rows.map((r) => r.model)).toEqual(["m-b", "deepseek-chat", "m-c"]);
    expect(restored.rows[0]!.paramsText).toBe("]{ 非法 JSON");
    expect(restored.rows.map((r) => r.key)).toEqual([...initialKeys, restored.rows[2]!.key]);
  });

  it("删行恢复：删除的臂重开仍不在（批次修订推进）", () => {
    useAppStore.getState().ensureModelAbDraft(key, BASELINE, source);
    const rows = useAppStore.getState().modelAbDraftOf(key)!.rows;
    useAppStore
      .getState()
      .setModelAbRows(key, [
        rows[0]!,
        rows[1]!,
        { key: draftsModule.newArmRowKey(), model: "m-c", paramsText: "" },
      ]);
    const rows3 = useAppStore.getState().modelAbDraftOf(key)!.rows;
    useAppStore.getState().setModelAbRows(key, [rows3[0]!, rows3[1]!]);

    useAppStore.getState().ensureModelAbDraft(key, BASELINE, source);
    expect(
      useAppStore
        .getState()
        .modelAbDraftOf(key)!
        .rows.map((r) => r.model),
    ).toEqual(["deepseek-chat", "deepseek-chat"]);
  });

  it("仅行 ID 变化不推进修订；语义变化推进（dirty 判据不比较随机行 ID）", () => {
    useAppStore.getState().ensureModelAbDraft(key, BASELINE, source);
    const before = useAppStore.getState().modelAbDraftOf(key)!;

    // 同语义 + 换行 ID（删同内容臂再加回的等价场景）
    useAppStore.getState().setModelAbRows(
      key,
      [before.rows[1]!, before.rows[0]!].map((r) => ({ ...r, key: draftsModule.newArmRowKey() })),
    );
    const afterKeySwap = useAppStore.getState().modelAbDraftOf(key)!;
    expect(afterKeySwap.revision).toBe(before.revision);

    // 语义变化（model 改了）⇒ 推进
    const rows = afterKeySwap.rows;
    useAppStore.getState().setModelAbRows(key, [{ ...rows[0]!, model: "m-x" }, rows[1]!]);
    expect(useAppStore.getState().modelAbDraftOf(key)!.revision).toBeGreaterThan(before.revision);
  });
});

// ---------------------------------------------------------------------------
// U3 任务 3.3：A/B 预览绑定批次修订 / 请求代次，内容变化或恢复后重新预览与授权
// ---------------------------------------------------------------------------

describe("接线契约：A/B 预览修订绑定与迟到守卫（任务 3.3）", () => {
  const src = () => MODEL_AB_EDITOR;

  it("预览发起时记录批次修订；迟到响应按它校验，且先守卫后安装", () => {
    const code = src();
    expect(code).toContain("const requestedRevision = draftRevision;");
    expect(code).toContain("useAppStore.getState().modelAbDraftOf(draftKey)?.revision ?? null");
    expect(code).toContain("if (currentRevision !== requestedRevision) return;");
    expect(code).toContain("setPlanRevision(requestedRevision);");
    // 顺序有牙：守卫必须在 setPlan 之前（先装后判等于装上了旧计划）
    expect(code.indexOf("if (currentRevision !== requestedRevision) return;")).toBeLessThan(
      code.indexOf("setPlan(result);"),
    );
  });

  it("计划与当前批次修订同源：修订推进即失效，改走又改回也不复活", () => {
    const code = src();
    expect(code).toContain(
      "const draftRevision = draftEntry !== undefined ? draftEntry.revision : null;",
    );
    // U5 任务 5.3 改判（两边留痕）：修订比对从组件字面量迁进 `decidePlanFreshness` 纯判据
    // （行为单测在 `settings-roundtrip-invalidate.test.ts` 的 decidePlanFreshness 节；
    //  配置指纹一并进同一判据）。这里钉"组件把两份修订都交给了它、activePlan 只认 fresh"。
    expect(code).toContain('plan !== null && planFreshness === "fresh" ? plan : null');
    // U8 3.7 扩展（两边留痕）：新鲜度判据再带上**已核实配置变化代次**（仅轮换 key 的
    // 保存也作废旧计划；proxy:status 刷新不推进代次）——判据调用多两个实参
    expect(code.replace(/\s+/g, " ")).toContain(
      "decidePlanFreshness({ planRevision, draftRevision, planConfigStamp, currentConfigStamp, planSettingsGeneration, currentSettingsGeneration: settingsChangeGeneration, })",
    );
    // 渲染/执行只认派生计划，不直接读原始局部态（否则旧计划仍会被展示/执行）
    expect(code).not.toContain("{plan !== null ?");
    expect(code).toContain("{activePlan !== null ?");
    // U5 4.7 追加就地确认（只加不减：activePlan 判据仍在原位）
    expect(code).toContain("if (!canSubmit || activePlan === null || !abConfirmed) return;");
    // U4 4.4 追加了统一门禁（只加不减：activePlan 判据仍在原位；表达式换行 ⇒ 归一空白）
    expect(code.replace(/\s+/g, " ")).toContain(
      "disabled={ inProgress || !canSubmit || activePlan === null || !gate.canSubmit || !abConfirmed }",
    );
  });

  it("内容变化作废副作用许可；恢复/离开后计划与许可均须重来（组件局部态）", () => {
    const code = src();
    // commitRows 是唯一行写入路径：改行既清计划也清授权（切片进函数体，避免被别处的复位序列糊过去）
    const commit = (() => {
      const a = MODEL_AB_EDITOR.indexOf("const commitRows = ");
      const b = MODEL_AB_EDITOR.indexOf("const updateArm = ", a);
      return MODEL_AB_EDITOR.slice(a, b);
    })();
    expect(commit).toContain("setPlan(null);");
    expect(commit).toContain("setAllowSideEffects(false);");
    // 计划修订与副作用许可都是组件局部态 ⇒ 重挂载即重置，恢复后必须重新预览并重新勾选
    expect(code).toContain(
      "const [planRevision, setPlanRevision] = useState<number | null>(null);",
    );
    expect(code).toContain("const [allowSideEffects, setAllowSideEffects] = useState(false);");
  });
});

describe("store 行为：A/B 预览不隐式清理批次（任务 3.3）", () => {
  const key = { runId: detail.meta.id, spanId: "s_02" };
  const source = captureCallDraftSource(detail, firstLlmSpan);
  const BASELINE = [
    { model: "deepseek-chat", paramsText: "" },
    { model: "deepseek-chat", paramsText: "" },
  ];

  beforeEach(() => {
    useAppStore.setState({ drafts: draftsModule.emptyDraftRepo() });
  });

  it("dry-run 预览（成功或失败信封）不写、不清、不推进批次草稿", async () => {
    useAppStore.getState().ensureModelAbDraft(key, BASELINE, source);
    useAppStore.getState().setModelAbRows(key, [
      { key: draftsModule.newArmRowKey(), model: "m-a", paramsText: "" },
      { key: draftsModule.newArmRowKey(), model: "m-b", paramsText: '{"temperature":0.9}' },
    ]);
    const entryBefore = useAppStore.getState().modelAbDraftOf(key)!;
    const repoBefore = useAppStore.getState().drafts;

    const api = (globalThis.window as unknown as { api: Record<string, unknown> }).api;
    // U4：预览是只读通道（runs:modelAbPlan），主动执行通道一次都不该被碰到
    let activeCalls = 0;
    const rejected = executedFail("SHOULD_NOT_RUN", "预览不该占主动槽");
    api.modelAb = async (request: ExecutedRequest<unknown>) => {
      activeCalls += 1;
      return rejected(request);
    };
    api.modelAbPlan = async () => ({
      ok: true as const,
      data: { experimentId: "exp_stub", ids: [], ok: true, plan: [], sideEffectsAllowed: false },
    });
    const planned = await useAppStore
      .getState()
      .modelAb(detail.meta.id, [{ model: "m-a" }, { model: "m-b" }], true);
    expect(planned?.experimentId).toBe("exp_stub");
    expect(activeCalls).toBe(0);

    // 预览是只读通道：仓库引用与批次条目（内容/修订/行 ID）原样
    expect(useAppStore.getState().drafts).toBe(repoBefore);
    const entryAfter = useAppStore.getState().modelAbDraftOf(key)!;
    expect(entryAfter).toBe(entryBefore);
    expect(entryAfter.revision).toBe(entryBefore.revision);
    expect(entryAfter.rows.map((r) => r.model)).toEqual(["m-a", "m-b"]);
    expect(entryAfter.rows[1]!.paramsText).toBe('{"temperature":0.9}');

    // 失败信封同样不动草稿（业务拒绝、部分失败都不清批次）
    api.modelAbPlan = async () => ({
      ok: false as const,
      error: { code: "STUB", message: "桩" },
    });
    expect(await useAppStore.getState().modelAb(detail.meta.id, [], true)).toBeNull();
    expect(useAppStore.getState().drafts).toBe(repoBefore);
    expect(useAppStore.getState().modelAbDraftOf(key)).toBe(entryBefore);
  });

  it("批次修订随语义变化推进：迟到响应因此拿不到旧修订（守卫判据有效）", () => {
    useAppStore.getState().ensureModelAbDraft(key, BASELINE, source);
    const requestedRevision = useAppStore.getState().modelAbDraftOf(key)!.revision;
    const rows = useAppStore.getState().modelAbDraftOf(key)!.rows;
    // 预览在飞时用户改了臂内容 ⇒ 响应到达时修订已不同，旧计划不得安装
    useAppStore.getState().setModelAbRows(key, [{ ...rows[0]!, model: "m-late" }, rows[1]!]);
    const currentRevision = useAppStore.getState().modelAbDraftOf(key)!.revision;
    expect(currentRevision).not.toBe(requestedRevision);

    // 放弃批次后取修订为 null（响应到达时批次已不存在 ⇒ 同样被守卫拒绝）
    expect(useAppStore.getState().discardModelAbDraft(key, currentRevision)).toBe(true);
    expect(useAppStore.getState().modelAbDraftOf(key)?.revision ?? null).toBeNull();
  });
});
