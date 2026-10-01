import type { SpanLine } from "@rebaseagent/trace-sdk";
import type { ModelAbResult, ModelArmPlan, RunDetail } from "@shared/ipc";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { isModelAbDraftDirty, newArmRowKey } from "../lib/debugging-drafts";
import type { ModelAbDraftKey } from "../lib/debugging-drafts";
import { captureCallDraftSource, revalidateModelAbDraftSource } from "../lib/draft-source";
import { deriveEntryGate } from "../lib/entry-gate";
import {
  abDisclosure,
  decidePlanFreshness,
  disclosureLines,
  modelConfigStampOf,
} from "../lib/execution-confirmation";
import { modelAbGuard, riskyToolNames, scalarRequestParams } from "../lib/model-ab";
import type { ArmDraft, Scalar } from "../lib/model-ab";
import { deriveAbBatchResult } from "../lib/operation-result-view";
import { useEscapeClose } from "../lib/use-escape-close";
import { useRevokeOnConfigChange } from "../lib/use-revoke-on-config-change";
import { useAppStore } from "../store";
import { AbBatchResultSection } from "./AbBatchResult";
import { requestConfirm } from "./ConfirmDialog";
import { DraftSourceBanner } from "./DraftSourceBanner";
import { EntryGateNotice } from "./EntryGateNotice";
import { LongText, shouldCollapse } from "./LongText";

/**
 * 模型 A/B 实验编辑器（runs:modelAb 写通道）：同一启动上下文跑 2+ 臂（model / params
 * 组合），先 dry-run 出计划再真实执行。一次调用 = 一批：每臂独立 run、独立 tracer、
 * 独立取消信号；experimentId 由 main 侧生成，各臂 fork.edit 带同一标签供分组。
 *
 * ⚠️ U8 3.1a（2026-10-01）自 DetailPanel **逐字搬出**（scalarText / ArmPlanRow / 本组件
 * 三个声明随迁；判据、状态与渲染零改动——工作区侧接线在 3.1b 落地）。本文件由
 * .workbuddy/u8/u8-31/extract-model-ab-editor.cjs 从 DetailPanel 按标记切取生成，
 * 证据：切取前后两文件的公共子串逐字一致。
 */

/** 标量值的展示文本（字符串加引号以便与数字区分） */
function scalarText(value: Scalar): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * 单臂计划（design §4 三段格式，与 CLI `printArmPlan` 字段语义一致）：
 * 生效 params（覆盖/新增/继承）→ 丢弃父录值（整体替换不合并）→ ⚠ 告警。
 * 三个字段全部读自编排层算好的 plan 条目，此处不重算。
 *
 * U8 任务 3.4（delta「长模型上游和告警可完整核对」）：超长值经 `LongText` 呈现——
 * 默认折叠（带真实字符数）、可展开为完整原文、可复制原文；短值保持原内联形态不变
 * （阈值判据复用 `shouldCollapse`，不造第二份）。
 */
export function ArmPlanRow({ arm }: { arm: ModelArmPlan }) {
  const entries = Object.entries(arm.params) as Array<[string, Scalar]>;
  const discarded = Object.entries(arm.discarded) as Array<[string, Scalar]>;
  /** 超长值走 LongText（折叠/展开/复制原文）；短值保持原内联形态 */
  const longOr = (text: string, label: string): React.ReactNode =>
    shouldCollapse(text) ? <LongText text={text} label={label} /> : <span>{text}</span>;
  return (
    <div className="border-b border-sky-50 py-1 last:border-b-0">
      <div className="flex items-baseline gap-2 text-[11px]">
        <span className="w-8 shrink-0 text-gray-400">臂 {arm.index + 1}</span>
        <span className="min-w-0 flex-1 font-code text-gray-800">
          {longOr(arm.model, `臂 ${arm.index + 1} model`)}
        </span>
        <span className="ml-auto shrink-0 text-[10px] text-gray-400">
          {arm.changed.length > 0 ? `改变：${arm.changed.join("、")}` : "与父相同"}
        </span>
      </div>
      <div className="pl-10 text-[10px] leading-4 text-gray-500">
        <div>
          <span className="text-gray-400">生效 params：</span>
          {entries.length === 0 ? (
            <span className="font-code">（沿用父 params）</span>
          ) : (
            entries.map(([k, v]) => {
              const tag = arm.overridden.includes(k)
                ? "（覆盖）"
                : arm.added.includes(k)
                  ? "（新增）"
                  : "（继承）";
              const text = scalarText(v);
              return (
                <span key={k} className="mr-2 font-code">
                  {k}={longOr(text, `臂 ${arm.index + 1} 参数 ${k}`)}
                  <span className="text-gray-400">{tag}</span>
                </span>
              );
            })
          )}
        </div>
        {discarded.length > 0 ? (
          <div className="text-amber-700">
            <span className="text-gray-400">丢弃父录值：</span>
            {discarded.map(([k, v]) => {
              const text = scalarText(v);
              return (
                <span key={k} className="mr-2 font-code">
                  {k}={longOr(text, `臂 ${arm.index + 1} 丢弃值 ${k}`)}
                </span>
              );
            })}
            <span className="text-gray-400">← 整体替换不合并，此项不会进入请求</span>
          </div>
        ) : null}
        {arm.warnings.map((w) => (
          <div key={w.key} className="text-amber-700">
            ⚠ {w.key}：{longOr(w.reason, `告警 ${w.key}`)}
            <div className="text-gray-500">绕行：{longOr(w.workaround, `告警 ${w.key} 绕行`)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 模型 A/B 实验编辑器（runs:modelAb 写通道）：
 * 同一启动上下文跑 2+ 臂（model / params 组合），先 dry-run 出计划再真实执行。
 * 一次调用 = 一批：每臂独立 run、独立 tracer、独立取消信号；experimentId 由
 * main 侧生成，各臂 fork.edit 带同一标签供分支树 / 对照面板分组。
 */
export function ModelAbEditor({
  span,
  run,
  sourceExecutable: sourceExecutableOverride,
  alwaysOpen = false,
}: {
  span: Extract<SpanLine, { kind: "llm.call" }>;
  run: RunDetail;
  /**
   * U8 3.1b：目标作用域的源可用性覆盖。缺省（undefined）= 沿用全局选中详情的门禁
   * （DetailPanel 步骤页语义：编辑器就在当前选中 run 上）；实验工作区传入
   * **按目标 runId 计算**的可用性——目标不跟随侧栏选择，全局门禁在这里会看错对象。
   */
  readonly sourceExecutable?: boolean;
  /** U8 3.1b：工作区形态常开（初始即展开、无「收起」按钮、Esc 不收起；草稿照常保留） */
  readonly alwaysOpen?: boolean;
}) {
  const modelAbInFlight = useAppStore((s) => s.modelAbInFlight);
  const modelAbError = useAppStore((s) => s.modelAbError);
  const modelAbErrorCode = useAppStore((s) => s.modelAbErrorCode);
  const settings = useAppStore((s) => s.settings);
  const modelAb = useAppStore((s) => s.modelAb);
  const resetModelAb = useAppStore((s) => s.resetModelAb);
  const ensureModelAbDraft = useAppStore((s) => s.ensureModelAbDraft);
  const writeRows = useAppStore((s) => s.setModelAbRows);
  // 源记录不可用时禁用依赖它的执行（任务 3.5）；工作区传入目标作用域覆盖（3.1b）
  const sourceExecutableFromSelection = useAppStore((s) => s.canExecuteFromSource)();
  const sourceExecutable = sourceExecutableOverride ?? sourceExecutableFromSelection;

  const parentModel = span.request.model;
  const parentParams = useMemo(() => scalarRequestParams(span.request.params), [span]);
  const risky = useMemo(() => riskyToolNames(span.request.tools), [span]);

  const [open, setOpen] = useState(alwaysOpen);
  const [allowSideEffects, setAllowSideEffects] = useState(false);
  const [plan, setPlan] = useState<ModelAbResult | null>(null);
  // U3 任务 3.3：计划所绑定的批次修订（预览时的请求代次）——见下方 activePlan
  const [planRevision, setPlanRevision] = useState<number | null>(null);
  // U5 任务 5.1：批次结果区改吃**登记 + 独立核实**——这里只留提交身份当指针，
  // 信封 `ModelAbResult` 是请求事实（ids 计数会冒充臂结局），不再进面板。
  const [executedOperationId, setExecutedOperationId] = useState<string | null>(null);
  // U8 任务 3.5：预览的**独立请求状态**——只读 dry-run 有自己的在飞标记与呈现，
  // 不与真实执行的 busy 共用一条文案；重复点击被就地拒绝（不靠按钮禁用单打独斗）。
  // previewing 只描述预览请求本身；执行按钮的禁用仍由 plan/确认/槽门禁决定。
  const [previewing, setPreviewing] = useState(false);

  /**
   * U3 任务 2.4：批次行改由**批次草稿**驱动（稳定行 ID；design D1/D4）。
   * - 打开经 `ensureModelAbDraft` 登记基线（初始两臂）+ 源基线；已存在批次原样保留
   *   ——增删行/非法参数文本经 `setModelAbRows` 落 store，往返逐字恢复；
   * - 临时计划与副作用许可是**本次编辑会话**的本地状态：不进草稿、恢复时清理
   *   （打开即复位——计划须重新校验、授权须重新勾选）；
   * - 预览 / 执行 / 实验结果**不隐式清理批次**（只动本地 plan / executedOperationId——
   *   U5 5.1 后批次呈现改吃登记快照，指针清空即撤面板）；
   * - U3 任务 3.3：计划绑定**预览时的批次修订**（请求代次）——任何内容变化或恢复后
   *   即失效，必须重新预览并重新确认副作用；迟到预览响应不安装旧计划（同 3.1 守卫）；
   * - 放弃整个批次归任务 2.6（CAS 确认）。
   */
  const draftKey: ModelAbDraftKey = useMemo(
    () => ({ runId: run.meta.id, spanId: span.id }),
    [run.meta.id, span.id],
  );
  const draftEntry = useAppStore((s) => s.modelAbDraftOf(draftKey));
  const baselineArms: ReadonlyArray<{ model: string; paramsText: string }> = useMemo(
    () => [
      { model: parentModel, paramsText: "" },
      { model: parentModel, paramsText: "" },
    ],
    [parentModel],
  );
  const rows = (draftEntry?.rows ?? []).map((row) => ({
    key: row.key,
    arm: { model: row.model, paramsText: row.paramsText },
  }));
  // 基线臂只读对照项：给渲染项稳定身份——两臂内容恒等（不能用内容当 key），也禁用下标
  const baselineRows = useMemo(
    () => baselineArms.map((arm, i) => ({ id: `baseline-${i + 1}`, no: i + 1, arm })),
    [baselineArms],
  );
  // U3 任务 2.6：批次 dirty（行语义序列偏离基线；初始两臂不算修改）
  const isBatchDirty = draftEntry !== undefined && isModelAbDraftDirty(draftEntry);

  // U3 任务 3.5：待定执行冻结**整批**（store 侧同时拒绝改行与放弃）
  const draftFrozen = useAppStore((s) => s.isDraftFrozen(draftKey));
  const beginDraftSubmission = useAppStore((s) => s.beginDraftSubmission);

  // U3 任务 3.3：计划必须与当前批次修订同源——修订推进（任何内容变化事件）即失效，
  // 「改走又改回同一文本」也不复活旧计划（修订单调，见 1.2）。恢复/离开编辑器后
  // plan/planRevision 为组件局部态已重置 ⇒ 必须重新预览并重新确认副作用。
  const draftRevision = draftEntry !== undefined ? draftEntry.revision : null;
  // U5 任务 5.3：计划还绑着**预览时的模型配置指纹**——设置往返保存成功后旧计划失效
  // （dry-run 结论要打到的是"当时那台上游"）；代理启停/凭据波动不参与（modelConfigStampOf 的口径）
  const currentConfigStamp = modelConfigStampOf(settings);
  const [planConfigStamp, setPlanConfigStamp] = useState<string | null>(null);
  // U8 任务 3.7：计划还绑着**预览时的已核实配置变化代次**——仅轮换 key 的成功保存
  // （指纹不变）同样作废旧计划；普通 proxy:status 刷新不推进代次、不作废计划。
  const settingsChangeGeneration = useAppStore((s) => s.settingsChangeGeneration);
  const [planSettingsGeneration, setPlanSettingsGeneration] = useState<number | null>(null);
  // U6 任务 4.10：来源撤销令牌——详情重读为 ownOnly、或 main 以来源类稳定码拒绝后，
  // 旧计划与本次副作用许可作废，恢复须重新预览并重新确认（批次草稿正文保留）。
  const sourceRevocation = useAppStore((s) => s.sourceRevocation);
  useRevokeOnConfigChange(sourceRevocation, () => {
    setPlan(null);
    setAllowSideEffects(false);
  });
  const planFreshness = decidePlanFreshness({
    planRevision,
    draftRevision,
    planConfigStamp,
    currentConfigStamp,
    planSettingsGeneration,
    currentSettingsGeneration: settingsChangeGeneration,
  });
  const activePlan = plan !== null && planFreshness === "fresh" ? plan : null;
  // 计划不见了的原因分三种：还没预览、预览所绑的批次修订已推进（改臂/改参数）、配置变了。
  // 后两种要就近说清楚，否则用户只会看到一个禁用的执行按钮。
  const planStale = plan !== null && planFreshness !== "fresh";
  const planStaleText =
    planFreshness === "config-stale"
      ? "预览之后运行配置已改变（设置往返作废这份计划）：须重新校验并预览，旧确认一并作废"
      : "这份计划属于旧批次修订：改臂或改参数后须重新校验并预览，旧确认一并作废";

  // U3 任务 3.3/3.5：待定执行期间视同进行中（预览与执行都禁用），且整批已冻结
  const inProgress = modelAbInFlight || draftFrozen;
  // previewing 只描述预览请求本身；执行按钮的禁用仍由 plan/确认/槽门禁决定
  // U4 任务 4.4：A/B 只有**真实执行**受统一槽约束；"校验并预览计划"走只读通道
  // （runs:modelAbPlan），占槽期间照常可用——把预览一起禁用就是拿门禁当业务判据。
  const operationsSession = useAppStore((s) => s.operations);
  const gate = deriveEntryGate(operationsSession);

  // U5 任务 4.7：A/B 的确认对象是**当前这份预览计划**（同一凭据、同一执法点）。
  // 检查代次由"校验并预览计划"推进：重新预览 ⇒ 旧确认作废，旧响应也装不回新确认。
  const currentConfirmationBinding = useAppStore((s) => s.currentConfirmationBinding);
  const armExecutionConfirmation = useAppStore((s) => s.armExecutionConfirmation);
  const restartExecutionCheck = useAppStore((s) => s.restartExecutionCheck);
  const abBinding = currentConfirmationBinding("model_ab", draftKey);
  const abConfirmed = useAppStore((s) => s.executionConfirmationReady(abBinding));

  // U5 任务 5.1：批次结果区的**唯一事实来源是登记快照 + 读取项**（现算派生，不缓存）。
  // 提交身份是指针：登记还没到场（提交在飞/快照未采纳）时 deriveAbBatchResult 只报等待，
  // 不预告结局；到达后逐臂按 target.armCount 呈现，动作走与操作面板同一批 store 口。
  const resultReads = useAppStore((s) => s.resultReads);
  const openOperationResult = useAppStore((s) => s.openOperationResult);
  const openOperationFailure = useAppStore((s) => s.openOperationFailure);
  const retryResultRead = useAppStore((s) => s.retryResultRead);
  const abBatchView =
    executedOperationId === null
      ? null
      : deriveAbBatchResult({
          operationId: executedOperationId,
          record:
            operationsSession.operations.find((one) => one.operationId === executedOperationId) ??
            null,
          reads: resultReads,
        });

  // U3 任务 2.5：草稿列表的定位目标到达即打开（ensure 幂等；重开不覆盖已有批次；
  // 临时计划/许可照旧清理——授权与计划不随草稿恢复）
  const pending = useAppStore((s) => s.pendingDraftTarget);
  const consumeDraftTarget = useAppStore((s) => s.consumeDraftTarget);
  const discardModelAbDraft = useAppStore((s) => s.discardModelAbDraft);
  useEffect(() => {
    if (pending === null) return;
    if (
      pending.runId !== run.meta.id ||
      pending.spanId !== span.id ||
      pending.field !== "model_ab"
    ) {
      return;
    }
    ensureModelAbDraft(draftKey, baselineArms, captureCallDraftSource(run, span));
    setExecutedOperationId(null);
    setPlan(null);
    setAllowSideEffects(false);
    setOpen(true);
    consumeDraftTarget();
  }, [pending, consumeDraftTarget, ensureModelAbDraft, draftKey, run, span, baselineArms]);

  // U3 任务 2.5/1.4：恢复重验——源缺失/损坏/改变/资格失效 ⇒ 保留批次、禁止执行
  const sourceVerdict =
    draftEntry === undefined
      ? null
      : revalidateModelAbDraftSource({
          runId: run.meta.id,
          spanId: span.id,
          source: draftEntry.source,
          detail: run,
        });
  const sourceBlocked = sourceVerdict?.kind === "blocked" ? sourceVerdict : null;

  const guard = modelAbGuard({
    settingsConfigured: settings?.configured === true,
    parentModel,
    parentParams,
    riskyTools: risky,
    allowSideEffects,
    arms: rows.map((row) => row.arm),
  });
  // 提交闸门 = 既有 guard ∧ 源记录可用（dry-run 也依赖父记录，一并拦截）
  //           ∧ 恢复重验通过（U3 2.5：源缺失/损坏/改变/资格失效都拦）
  const canSubmit = guard.canSubmit && sourceExecutable && sourceBlocked === null;
  const submitBlocked = !guard.canSubmit
    ? guard.reason
    : !sourceExecutable
      ? "源记录不可用：重新读取并校验通过前不能发起新执行"
      : null;

  /** 行变更统一落批次草稿（语义不变仅行 ID 变化不推进修订）；任何行变更作废已校验计划与副作用许可 */
  const commitRows = (next: Array<{ key: string; arm: ArmDraft }>): void => {
    writeRows(
      draftKey,
      next.map((row) => ({ key: row.key, model: row.arm.model, paramsText: row.arm.paramsText })),
    );
    setPlan(null);
    // U3 任务 3.3（design D4）：内容变化使本次副作用许可失效——许可只用于当次构造的批，
    // 改了臂/参数必须重新勾选后再预览/执行（与 result 编辑的副本授权同规则）。
    setAllowSideEffects(false);
  };

  const updateArm = (index: number, patch: Partial<ArmDraft>): void => {
    commitRows(
      rows.map((row, i) => (i === index ? { ...row, arm: { ...row.arm, ...patch } } : row)),
    );
  };

  // U3 任务 6.10（design D7）：Esc 收起与「收起」按钮同动作（保留批次草稿）。
  // U8 3.1b：工作区形态常开 ⇒ Esc 不收起（收起语义只属于步骤页内联形态）。
  useEscapeClose(open && !alwaysOpen && !inProgress, () => {
    resetModelAb();
    setOpen(false);
  });

  if (!open) {
    return (
      <div className="border-t border-sky-100 px-4 py-2">
        <button
          type="button"
          onClick={() => {
            resetModelAb();
            // 恢复/打开即清理临时计划与许可（design D4：授权与计划不随草稿恢复）
            setExecutedOperationId(null);
            setPlan(null);
            setAllowSideEffects(false);
            ensureModelAbDraft(draftKey, baselineArms, captureCallDraftSource(run, span));
            setOpen(true);
          }}
          disabled={inProgress}
          className="rounded bg-sky-600 px-2 py-1 text-[11px] text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          模型 A/B 实验（换 model / params 对比）
        </button>
        <div className="mt-1 text-[11px] text-gray-400">
          用同一启动上下文跑至少两个臂（model / 采样参数组合），先出计划预览，确认后真实执行。
        </div>
      </div>
    );
  }

  /**
   * U3 任务 2.6：放弃**整个批次**（design D3：A/B 放弃整批，不提供批量清除）。
   * 确认核对全部臂内容；CAS 拒绝旧确认删除新修订。
   */
  const discardBatch = (): void => {
    if (draftEntry === undefined || inProgress) return;
    const snapshot = draftEntry;
    const summary = snapshot.rows
      .map(
        (row, i) =>
          `臂 ${i + 1}：${row.model}（${row.paramsText === "" ? "沿用父 params" : row.paramsText}）`,
      )
      .join("\n");
    // U3 5.2：异步模态确认；CAS 按请求时的快照修订校验
    void requestConfirm({
      title: "放弃模型 A/B 批次",
      message: `放弃整个模型 A/B 批次草稿？（run ${run.meta.id} · ${span.id}）\n\n${summary}\n\n放弃整批；按确认时的修订校验：此后批次若被更新，本次放弃不会执行。`,
    }).then((confirmed) => {
      if (!confirmed) return; // 取消：逐字保留
      if (discardModelAbDraft(draftKey, snapshot.revision)) {
        resetModelAb();
        setOpen(false);
      }
    });
  };

  const doPreview = (): void => {
    if (!canSubmit || previewing) return;
    setPreviewing(true);
    // U5 任务 4.7：一次预览 = 一次新的检查 ⇒ 检查代次推进，旧确认作废（旧响应也不能装回）
    restartExecutionCheck(draftKey);
    setExecutedOperationId(null);
    // U3 任务 3.3：记录**发起预览时的批次修订**（请求代次）——响应按它校验；
    // U5 任务 5.3：同一时刻的模型配置指纹一并记录（在飞期间改了设置也不装新计划）
    const requestedRevision = draftRevision;
    const requestedStamp = currentConfigStamp;
    const requestedSettingsGeneration = settingsChangeGeneration;
    void modelAb(run.meta.id, guard.arms, true)
      .then((result) => {
        if (result === null) return;
        // U3 任务 3.3：守卫迟到预览——响应到达时批次修订已推进（或批次已被放弃）
        // ⇒ 不安装旧计划（不给修改后的批次安装旧校验结论）。
        const currentRevision = useAppStore.getState().modelAbDraftOf(draftKey)?.revision ?? null;
        if (currentRevision !== requestedRevision) return;
        setPlan(result);
        setPlanRevision(requestedRevision);
        setPlanConfigStamp(requestedStamp);
        setPlanSettingsGeneration(requestedSettingsGeneration);
      })
      .finally(() => {
        // U8 3.5：无论安装与否都解除预览的独立在飞标记
        setPreviewing(false);
      });
  };

  const doExecute = (): void => {
    // U5 任务 4.7：确认改在就地核对区给出（原生对话框消失）——这里只做最后一道校验：
    // 资格齐备 ∧ 有当前批次的生效计划 ∧ 确认仍绑定着这份现场，缺任一项都不发出执行。
    if (!canSubmit || activePlan === null || !abConfirmed) return;
    // U3 任务 3.5：登记整批提交关联（取批次修订 + 行快照）⇒ 冻结整批；
    // 已有待定提交时拒绝重复提交。收尾由 store 执行函数负责（卸载/收起不解冻）。
    const assoc = beginDraftSubmission({
      channel: "model_ab",
      target: draftKey,
      confirmation: abBinding,
    });
    if (assoc === null) return;
    // U5 任务 5.1：批次结果区从登记快照逐臂呈现——信封返回值不再进面板
    // （modelAb 仍返回 `ModelAbResult` 供请求事实行使用，但"哪条臂成了"只认登记与核实）。
    setExecutedOperationId(assoc.operationId);
    void modelAb(run.meta.id, guard.arms, false, assoc);
  };

  return (
    <div className="border-t border-sky-100 bg-sky-50/60 px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-sky-900">
          模型 A/B 实验 · 同上下文多臂对比
        </span>
        {alwaysOpen ? null : (
          <button
            type="button"
            onClick={() => {
              resetModelAb();
              setOpen(false);
            }}
            disabled={inProgress}
            className="rounded border border-gray-300 px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50 disabled:opacity-40"
          >
            收起
          </button>
        )}
      </div>

      <div className="space-y-2">
        {/* U3 任务 2.6：父本基线臂（只读）与批次草稿就近核对——宽屏并排、窄屏上下 */}
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-2" data-draft-compare="model-ab">
          <div className="min-w-0 rounded border border-gray-200 bg-white px-2 py-1.5">
            <div className="mb-1 text-[10px] font-medium text-gray-500">
              原值（父本基线臂 · 只读）
            </div>
            {baselineRows.map(({ id, no, arm }) => (
              <div key={id} className="font-code break-all text-[11px] leading-4 text-gray-600">
                臂 {no}：{arm.model}
                {arm.paramsText === "" ? "（沿用父 params）" : ` · ${arm.paramsText}`}
              </div>
            ))}
          </div>
          <div className="min-w-0 rounded border border-sky-200 bg-white px-2 py-1.5">
            <div className="mb-1 text-[10px] font-medium text-sky-700">草稿（可编辑批次）</div>
            {rows.map(({ key, arm }, index) => (
              <div key={key} className="font-code break-all text-[11px] leading-4 text-gray-700">
                臂 {index + 1}：{arm.model}
                {arm.paramsText === "" ? "（沿用父 params）" : ` · ${arm.paramsText}`}
              </div>
            ))}
          </div>
        </div>
        {rows.map(({ key, arm }, index) => (
          <div key={key} className="rounded border border-sky-200 bg-white px-2 py-1.5">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[10px] font-semibold text-sky-800">臂 {index + 1}</span>
              <input
                type="text"
                value={arm.model}
                onChange={(e) => updateArm(index, { model: e.target.value })}
                placeholder="model 名"
                disabled={inProgress}
                className="min-w-0 flex-1 rounded border border-gray-300 px-1.5 py-0.5 font-code text-[11px] focus:border-sky-400 focus:outline-none"
              />
              {rows.length > 2 ? (
                <button
                  type="button"
                  onClick={() => {
                    commitRows(rows.filter((_, i) => i !== index));
                  }}
                  disabled={inProgress}
                  className="rounded px-1 text-[11px] text-gray-400 hover:bg-gray-100 disabled:opacity-40"
                  title="移除该臂"
                >
                  ✕
                </button>
              ) : null}
            </div>
            <input
              type="text"
              value={arm.paramsText}
              onChange={(e) => updateArm(index, { paramsText: e.target.value })}
              placeholder={`采样参数 JSON（留空 = 沿用父 run：${
                Object.keys(parentParams).length > 0 ? JSON.stringify(parentParams) : "无"
              }）`}
              disabled={inProgress}
              className="w-full rounded border border-gray-300 px-1.5 py-0.5 font-code text-[11px] focus:border-sky-400 focus:outline-none"
            />
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-center gap-2">
        {rows.length < 4 ? (
          <button
            type="button"
            onClick={() => {
              commitRows([
                ...rows,
                { key: newArmRowKey(), arm: { model: parentModel, paramsText: "" } },
              ]);
            }}
            disabled={inProgress}
            className="rounded border border-sky-300 px-2 py-0.5 text-[11px] text-sky-700 hover:bg-sky-100 disabled:opacity-40"
          >
            + 加一臂（最多 4）
          </button>
        ) : null}
        <span className="text-[11px] text-gray-400">
          父 run：{parentModel}
          {Object.keys(parentParams).length > 0 ? ` ${JSON.stringify(parentParams)}` : ""}
        </span>
      </div>

      {risky.length > 0 ? (
        <label className="mt-2 flex items-start gap-1.5 rounded bg-amber-50 px-2 py-1.5 text-[11px] leading-4 text-amber-800">
          <input
            type="checkbox"
            checked={allowSideEffects}
            onChange={(e) => {
              setAllowSideEffects(e.target.checked);
              setPlan(null);
            }}
            disabled={inProgress}
            className="mt-0.5"
          />
          <span>
            ⚠ 工具 {risky.join("、")} 未标记 sideEffect: false。各臂顺序执行时，前一臂的
            外部副作用会污染后一臂起点，比较结果不可信——确认接受请勾选（将随实验留痕）。
          </span>
        </label>
      ) : null}

      {submitBlocked !== null ? (
        <div className="mt-2 text-[11px] text-amber-700">{submitBlocked}</div>
      ) : null}

      {sourceBlocked !== null && draftEntry !== undefined ? (
        <DraftSourceBanner
          reason={sourceBlocked.reason}
          copyText={JSON.stringify(
            draftEntry.rows.map((r) => ({ model: r.model, paramsText: r.paramsText })),
          )}
          onDiscard={() => {
            if (draftEntry === undefined) return;
            const snapshot = draftEntry;
            void requestConfirm({
              title: "放弃模型 A/B 批次",
              message: "放弃这个模型 A/B 批次草稿？全部臂内容将被删除（不可撤销）。",
            }).then((confirmed) => {
              if (!confirmed) return;
              if (discardModelAbDraft(draftKey, snapshot.revision)) {
                resetModelAb();
                setOpen(false);
              }
            });
          }}
        />
      ) : null}

      {draftFrozen ? (
        <div className="mt-2 rounded border border-violet-200 bg-violet-50 px-2 py-1.5 text-[11px] leading-4 text-violet-800">
          本次执行待处理：已按提交时的批次修订冻结整个批次，请求返回前不可增删臂、改参数或放弃。
          无论成功、业务拒绝还是部分臂失败，批次都先保留；各臂按可信身份核实到正常结束、
          且草稿修订与提交时逐字相同，才自动清理（U5 §2/§3/5.1 已接线）。
        </div>
      ) : null}

      {modelAbInFlight ? <div className="mt-2 text-[11px] text-sky-600">处理中…</div> : null}
      {/* U8 3.5：预览的独立请求状态（只读通道自己的在飞呈现，不冒充执行 busy） */}
      {previewing ? (
        <div className="mt-2 text-[11px] text-sky-600" data-ab-previewing>
          正在校验计划（只读 dry-run：不联网、不写文件）…
        </div>
      ) : null}
      {modelAbError !== null ? (
        <div className="mt-2 text-[11px] text-red-700">
          {modelAbError}
          {modelAbErrorCode === "SETTINGS_NOT_CONFIGURED"
            ? "（请先点击右上角“运行配置”填写 baseURL/apiKey/model）"
            : ""}
        </div>
      ) : null}

      {activePlan !== null ? (
        <div className="mt-2 rounded border border-sky-200 bg-white px-2 py-1.5">
          <div className="mb-1 flex items-center gap-2 text-[10px] text-gray-500">
            <span className="font-semibold text-sky-800">校验通过 · 执行计划</span>
            <span className="font-code">实验组 {activePlan.experimentId}</span>
          </div>
          {activePlan.plan.map((arm) => (
            <ArmPlanRow key={arm.index} arm={arm} />
          ))}
          {activePlan.sideEffectsAllowed ? (
            <div className="mt-1 text-[10px] leading-4 text-amber-700">
              ⚠ 副作用工具将被真实执行（顺序执行，外部状态可能已被前一臂改变）——本次实验将留痕。
            </div>
          ) : null}
          <div className="mt-1 text-[10px] leading-4 text-gray-400">
            dry-run 不联网、不写文件；真实执行按臂数产生费用。执行后各臂落盘为独立新轨迹。
          </div>
        </div>
      ) : null}

      {/*
       * U5 任务 5.1：批次结果区改**逐臂读取状态 + 可信 ID 动作**（原绿色通报框拿
       * 信封 ModelAbResult 的 ids 数组长度计臂数——那是请求事实，缺臂/失败臂会被计成"成功"）。
       */}
      {abBatchView !== null ? (
        <AbBatchResultSection
          view={abBatchView}
          onAct={(action, identity) => {
            if (action === "open-result") {
              void openOperationResult(identity);
              return;
            }
            if (action === "view-failure") {
              void openOperationFailure(identity);
              return;
            }
            if (action === "retry-read") {
              void retryResultRead(identity);
            }
            // "return-draft" 不在臂级出现（草稿返回是记录级动作，走操作面板）
          }}
        />
      ) : null}

      {/*
       * U5 任务 4.7：核对本次实验。事实取自**当前生效的 dry-run 计划**（各臂实际执行的
       * model/params、被丢弃的父录值、静默忽略告警、实验组 ID）；没有计划时只说缺什么，
       * 不把未校验的草稿文本摊开冒充计划。确认与其余入口同一份凭据、同一个执法点。
       */}
      <div className="mt-2 rounded border border-sky-200 bg-white">
        <div className="flex items-center justify-between gap-2 px-2 py-1.5">
          <span className="text-[11px] font-medium text-gray-600">核对本次实验</span>
          <button
            type="button"
            data-confirm-execution
            aria-pressed={abConfirmed ? "true" : undefined}
            disabled={
              inProgress || abConfirmed || activePlan === null || !canSubmit || !gate.canSubmit
            }
            onClick={() => armExecutionConfirmation(abBinding)}
            className={`shrink-0 rounded border px-2 py-0.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-40 ${
              abConfirmed
                ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                : "border-gray-300 text-gray-700 hover:bg-gray-50"
            }`}
          >
            {abConfirmed ? "已确认执行实验" : "已核对，确认执行实验"}
          </button>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 border-t border-gray-100 px-2 py-1.5 text-[11px] leading-4">
          {disclosureLines(
            abDisclosure({
              parentRunId: run.meta.id,
              atSpanId: span.id,
              provider: settings?.baseURL ?? "（未配置 baseURL）",
              armCount: rows.length,
              plan: activePlan,
            }),
          ).map((row) => (
            <div key={`${row.label}-${row.value}`} className="col-span-2 grid grid-cols-subgrid">
              <dt className="text-gray-500">{row.label}</dt>
              <dd className="min-w-0 break-words text-gray-700">{row.value}</dd>
            </div>
          ))}
        </dl>
        {!abConfirmed && (planStale || submitBlocked !== null) ? (
          <div className="border-t border-gray-100 px-2 py-1.5 text-[11px] leading-4 text-amber-800">
            {submitBlocked !== null ? submitBlocked : planStaleText}
          </div>
        ) : null}
      </div>

      <EntryGateNotice gate={gate} />

      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={discardBatch}
          disabled={inProgress || !isBatchDirty}
          title={isBatchDirty ? "放弃整个批次草稿（需确认）" : "批次与基线一致，尚无修改可放弃"}
          className={`mr-auto rounded border px-2 py-1 text-[11px] disabled:cursor-not-allowed disabled:opacity-40 ${
            isBatchDirty
              ? "border-amber-400 text-amber-800 hover:bg-amber-50"
              : "border-gray-200 text-gray-300"
          }`}
        >
          放弃整批
        </button>
        <button
          type="button"
          onClick={doPreview}
          disabled={inProgress || !canSubmit || previewing}
          className="rounded border border-sky-500 px-2 py-1 text-[11px] text-sky-700 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {previewing ? "校验中…" : activePlan !== null ? "重新校验" : "校验并预览计划"}
        </button>
        <button
          type="button"
          onClick={doExecute}
          disabled={
            inProgress || !canSubmit || activePlan === null || !gate.canSubmit || !abConfirmed
          }
          className="rounded bg-sky-600 px-3 py-1 text-[11px] text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
          title={
            activePlan === null
              ? "先校验并预览计划"
              : !abConfirmed
                ? "先核对上面的目标与执行边界并确认"
                : undefined
          }
        >
          {/* U8 3.7/3.9：措辞只称「臂」——臂数不是准确 API 请求数（每臂 loop 可多次调用），
              delta「费用确认区分臂数和请求数」禁止把臂数宣称为请求次数 */}
          确认执行（{activePlan?.plan.length ?? rows.length} 臂）
        </button>
      </div>
    </div>
  );
}
