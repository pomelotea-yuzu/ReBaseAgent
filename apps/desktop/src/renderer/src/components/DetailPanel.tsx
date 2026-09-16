import { Editor } from "@monaco-editor/react";
import type { SpanLine } from "@rebaseagent/trace-sdk";
import {
  deriveMissingLlmErrorDetail,
  findStepLlm,
  forkEditLabel,
  isPromptForkField,
  spanDurationMs,
} from "@shared/derive";
import type { ModelAbResult, ModelArmPlan, RunDetail } from "@shared/ipc";
import { useMemo, useState } from "react";
import { formatDuration, prettyJson } from "../lib/format";
import { modelAbGuard, riskyToolNames } from "../lib/model-ab";
import type { ArmDraft, Scalar } from "../lib/model-ab";
import { promptForkGuard } from "../lib/prompt-fork";
import type { PromptForkField } from "../lib/prompt-fork";
import { useAppStore } from "../store";
import { BudgetMap } from "./BudgetMap";

const COLLAPSE_THRESHOLD = 600;

/**
 * 长文本区块：默认折叠（展示前若干字符 + 省略），展开后为完整原文。
 * 不做任何截断丢弃——展开即可看到全部内容。
 */
function LongText({ text, label }: { text: string; label: string }) {
  const collapsed = text.length > COLLAPSE_THRESHOLD;
  if (!collapsed) {
    return (
      <pre className="whitespace-pre-wrap break-words font-code text-[11px] leading-5 text-gray-800">
        {text}
      </pre>
    );
  }
  return (
    <details className="group">
      <summary className="cursor-pointer select-none text-[11px] text-gray-500 hover:text-gray-700">
        {label}（{text.length} 字符，点击展开完整内容）
      </summary>
      <pre className="mt-1 whitespace-pre-wrap break-words font-code text-[11px] leading-5 text-gray-800">
        {text}
      </pre>
    </details>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-gray-200 px-4 py-3">
      <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-gray-500">{title}</div>
      {children}
    </div>
  );
}

function KeyValue({ items }: { items: Array<[string, string]> }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-gray-700">
      {items.map(([k, v]) => (
        <span key={k}>
          <span className="text-gray-400">{k}</span> <span className="font-code">{v}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * 缓存命中行（前缀缓存生效与否的唯一可见证据）。
 *
 * 判据是**存在性**（`cache_hit !== undefined`）而不是 truthiness：`0` 是「本次全量计费」——
 * 恰是最该被看见的一态，用 `if (hit)` 会把它静默吞掉；只有**字段缺失**（老 trace / 不支持
 * 缓存的 provider）才整行省略，且不显示 0（未知 ≠ 零命中）。
 * `cache_hit > in` 属异常口径数据：按输入总量 clamp 并显式标注，不显示负值 / 超 100%。
 */
function CacheHitRow({
  usage,
}: { usage: Extract<SpanLine, { kind: "llm.call" }>["response"]["usage"] }) {
  const hit = usage.cache_hit;
  if (hit === undefined) return null;

  const abnormal = hit > usage.in;
  const shownHit = abnormal ? usage.in : hit;
  // in === 0 时不做除法（防 0/0），只展示绝对 tokens
  const percent = usage.in > 0 ? Math.round((shownHit / usage.in) * 100) : null;
  const saved = percent !== null && percent >= 50;
  // 措辞按命中量分档：0 命中才是"全量计费"，少量命中不能说成全量（省了就是省了）
  const verdict =
    hit === 0
      ? "全量计费（无命中）"
      : saved
        ? "前缀缓存生效，本次调用省钱"
        : "部分命中，多数输入仍按全价计费";

  return (
    <div
      className={`mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] ${
        saved ? "text-emerald-700" : "text-amber-700"
      }`}
    >
      <span>缓存命中</span>
      <span className="font-code">{shownHit}</span>
      {percent === null ? null : (
        <span>
          / <span className="font-code">{usage.in}</span>（{percent}%）
        </span>
      )}
      {usage.cache_miss === undefined ? null : (
        <span>
          · miss <span className="font-code">{usage.cache_miss}</span>
        </span>
      )}
      <span>{verdict}</span>
      {abnormal ? (
        <span className="text-red-600">⚠️ 命中数大于输入总量，已按输入总量截断（数据异常）</span>
      ) : null}
    </div>
  );
}

/** 从请求消息中取首条字符串 system / user 消息内容（与 replay 层定位规则同源） */
function startupContents(messages: ReadonlyArray<{ role: unknown; content?: unknown }>): {
  system: string | null;
  user: string | null;
} {
  let system: string | null = null;
  let user: string | null = null;
  for (const message of messages) {
    if (system === null && message.role === "system" && typeof message.content === "string") {
      system = message.content;
    }
    if (user === null && message.role === "user" && typeof message.content === "string") {
      user = message.content;
    }
    if (system !== null && user !== null) break;
  }
  return { system, user };
}

/**
 * prompt fork 编辑器（runs:promptFork 写通道）：
 * 编辑首次 llm.call 启动上下文中的 system prompt 或首条 user message，
 * 确认后从头重跑（独立新轨迹，不共享父前缀）。
 * 一次只改一个变量；空 fork、未配置、缺字符串 system 消息均在本地拦截。
 */
function PromptForkEditor({
  span,
  run,
}: {
  span: Extract<SpanLine, { kind: "llm.call" }>;
  run: RunDetail;
}) {
  const forking = useAppStore((s) => s.forking);
  const forkError = useAppStore((s) => s.forkError);
  const forkErrorCode = useAppStore((s) => s.forkErrorCode);
  const settings = useAppStore((s) => s.settings);
  const promptFork = useAppStore((s) => s.promptFork);
  const resetFork = useAppStore((s) => s.resetFork);

  const { system: originalSystem, user: originalUser } = startupContents(span.request.messages);
  const [field, setField] = useState<PromptForkField>("system_prompt");
  const [value, setValue] = useState(originalSystem ?? "");
  const [open, setOpen] = useState(false);

  const inProgress = forking === "in_progress";
  const original = field === "system_prompt" ? originalSystem : originalUser;
  const unchanged = original === null || value === original;

  const guard = promptForkGuard({
    field,
    hasSystem: originalSystem !== null,
    hasUser: originalUser !== null,
    settingsConfigured: settings?.configured === true,
    unchanged,
  });

  const switchField = (next: PromptForkField): void => {
    setField(next);
    setValue(next === "system_prompt" ? (originalSystem ?? "") : (originalUser ?? ""));
    resetFork();
  };

  if (!open) {
    const unavailable = originalSystem === null;
    return (
      <div className="border-t border-emerald-100 px-4 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              resetFork();
              switchField("system_prompt");
              setOpen(true);
            }}
            disabled={unavailable || inProgress}
            title={
              unavailable ? "首次 llm.call 缺少字符串 system 消息，prompt fork 不可用" : undefined
            }
            className="rounded bg-emerald-600 px-2 py-1 text-[11px] text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            编辑 system prompt 重跑
          </button>
          <button
            type="button"
            onClick={() => {
              resetFork();
              switchField("user_message");
              setOpen(true);
            }}
            disabled={unavailable || inProgress}
            title={
              unavailable ? "首次 llm.call 缺少字符串 system 消息，prompt fork 不可用" : undefined
            }
            className="rounded border border-emerald-500 px-2 py-1 text-[11px] text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            编辑初始 user message 重跑
          </button>
        </div>
        {unavailable ? (
          <div className="mt-1 text-[11px] text-gray-400">
            首次 llm.call 缺少字符串形式的 system 消息，无法重建运行配置，prompt fork 不可用。
          </div>
        ) : (
          <div className="mt-1 text-[11px] text-gray-400">
            prompt fork：修改启动上下文后从头重跑（独立新轨迹，不共享父前缀）。一次只改一项。
          </div>
        )}
      </div>
    );
  }

  const doSubmit = (): void => {
    if (!guard.canSubmit) return;
    const confirmed = window.confirm(
      "确认从头重跑？\n\n" +
        "· 将真实调用模型并计费（不承诺命中父 run 的缓存）\n" +
        "· 父 run 只作对照，不会被修改\n" +
        "· 配置指纹将变化——这是一次新实验，新轨迹从头完整记录",
    );
    if (!confirmed) return;
    void promptFork(run.meta.id, { field, value });
  };

  return (
    <div className="border-t border-emerald-100 bg-emerald-50/60 px-4 py-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-emerald-900">prompt fork · 从头重跑</span>
        <div className="flex items-center gap-1">
          {(["system_prompt", "user_message"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => {
                switchField(f);
              }}
              disabled={inProgress}
              className={`rounded px-1.5 py-0.5 text-[10px] ${
                field === f
                  ? "bg-emerald-600 text-white"
                  : "border border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-100"
              }`}
            >
              {f === "system_prompt" ? "system prompt" : "首条 user message"}
            </button>
          ))}
        </div>
      </div>
      <Editor
        height="140px"
        language="plaintext"
        value={value}
        onChange={(next) => setValue(next ?? "")}
        options={{
          readOnly: inProgress,
          fontSize: 12,
          minimap: { enabled: false },
          lineNumbers: "on",
          scrollBeyondLastLine: false,
          wordWrap: "on",
          scrollbar: { vertical: "auto" },
          folding: true,
          showFoldingControls: "always",
        }}
        className="overflow-hidden rounded border border-emerald-200"
      />
      <div className="mt-1.5 text-[10px] leading-4 text-emerald-700">
        编辑值将替换首次 llm.call 请求中的
        {field === "system_prompt" ? " system prompt" : " 首条 user message"}
        ；新 run 从第 1 步完整执行并记录独立新轨迹。
        {field === "system_prompt" ? "配置指纹（config_hash）将随新值变化。" : ""}
      </div>
      <div className="mt-1 text-[10px] leading-4 text-emerald-600">
        从头重跑，将真实调用模型并计费 · 父 run 只作对照，不会被修改
      </div>

      {!guard.canSubmit && guard.reason !== null ? (
        <div className="mt-1 text-[11px] text-amber-700">{guard.reason}</div>
      ) : null}

      {forking === "error" ? (
        <div className="mt-1 text-[11px] text-red-700">
          {forkError}
          {forkErrorCode === "SETTINGS_NOT_CONFIGURED"
            ? "（请先点击右上角“运行配置”填写 baseURL/apiKey/model）"
            : ""}
        </div>
      ) : null}

      <div className="mt-2 flex items-center justify-end gap-2">
        {inProgress ? (
          <span className="text-[11px] text-emerald-600">重跑中…（真实 LLM 调用，可能耗时）</span>
        ) : null}
        <button
          type="button"
          onClick={() => setValue(original ?? "")}
          disabled={inProgress || original === null}
          className="rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50 disabled:opacity-40"
        >
          恢复原值
        </button>
        <button
          type="button"
          onClick={() => {
            resetFork();
            setOpen(false);
          }}
          disabled={inProgress}
          className="rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50 disabled:opacity-40"
        >
          取消
        </button>
        <button
          type="button"
          onClick={doSubmit}
          disabled={inProgress || !guard.canSubmit}
          className="rounded bg-emerald-600 px-3 py-1 text-[11px] text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          确认从头重跑
        </button>
      </div>
    </div>
  );
}

/** 父 run 录制 params 中的标量子集（A/B 的"沿用父值"与空实验判据） */
function scalarRequestParams(raw: unknown): Record<string, Scalar> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, Scalar> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "boolean") {
      out[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return out;
}

let armKeySeq = 0;
/** 草稿行的稳定 React key */
function newArmKey(): string {
  armKeySeq += 1;
  return `arm-${armKeySeq}`;
}

/** 标量值的展示文本（字符串加引号以便与数字区分） */
function scalarText(value: Scalar): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * 单臂计划（design §4 三段格式，与 CLI `printArmPlan` 字段语义一致）：
 * 生效 params（覆盖/新增/继承）→ 丢弃父录值（整体替换不合并）→ ⚠ 告警。
 * 三个字段全部读自编排层算好的 plan 条目，此处不重算。
 */
function ArmPlanRow({ arm }: { arm: ModelArmPlan }) {
  const entries = Object.entries(arm.params) as Array<[string, Scalar]>;
  const discarded = Object.entries(arm.discarded) as Array<[string, Scalar]>;
  return (
    <div className="border-b border-sky-50 py-1 last:border-b-0">
      <div className="flex items-baseline gap-2 text-[11px]">
        <span className="w-8 shrink-0 text-gray-400">臂 {arm.index + 1}</span>
        <span className="font-code text-gray-800">{arm.model}</span>
        <span className="ml-auto text-[10px] text-gray-400">
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
              return (
                <span key={k} className="mr-2 font-code">
                  {k}={scalarText(v)}
                  <span className="text-gray-400">{tag}</span>
                </span>
              );
            })
          )}
        </div>
        {discarded.length > 0 ? (
          <div className="text-amber-700">
            <span className="text-gray-400">丢弃父录值：</span>
            {discarded.map(([k, v]) => (
              <span key={k} className="mr-2 font-code">
                {k}={scalarText(v)}
              </span>
            ))}
            <span className="text-gray-400">← 整体替换不合并，此项不会进入请求</span>
          </div>
        ) : null}
        {arm.warnings.map((w) => (
          <div key={w.key} className="text-amber-700">
            ⚠ {w.key}：{w.reason}
            <div className="text-gray-500">绕行：{w.workaround}</div>
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
function ModelAbEditor({
  span,
  run,
}: {
  span: Extract<SpanLine, { kind: "llm.call" }>;
  run: RunDetail;
}) {
  const modelAbInFlight = useAppStore((s) => s.modelAbInFlight);
  const modelAbError = useAppStore((s) => s.modelAbError);
  const modelAbErrorCode = useAppStore((s) => s.modelAbErrorCode);
  const settings = useAppStore((s) => s.settings);
  const modelAb = useAppStore((s) => s.modelAb);
  const resetModelAb = useAppStore((s) => s.resetModelAb);

  const parentModel = span.request.model;
  const parentParams = useMemo(() => scalarRequestParams(span.request.params), [span]);
  const risky = useMemo(() => riskyToolNames(span.request.tools), [span]);

  const [open, setOpen] = useState(false);
  /** 草稿行带稳定 key（列表可增删，不能用数组下标做 React key） */
  const [rows, setRows] = useState<Array<{ key: string; arm: ArmDraft }>>(() => [
    { key: newArmKey(), arm: { model: parentModel, paramsText: "" } },
    { key: newArmKey(), arm: { model: parentModel, paramsText: "" } },
  ]);
  const arms = rows.map((row) => row.arm);
  const [allowSideEffects, setAllowSideEffects] = useState(false);
  const [plan, setPlan] = useState<ModelAbResult | null>(null);
  const [executed, setExecuted] = useState<ModelAbResult | null>(null);

  const inProgress = modelAbInFlight;

  const guard = modelAbGuard({
    settingsConfigured: settings?.configured === true,
    parentModel,
    parentParams,
    riskyTools: risky,
    allowSideEffects,
    arms,
  });

  const updateArm = (index: number, patch: Partial<ArmDraft>): void => {
    setRows(rows.map((row, i) => (i === index ? { ...row, arm: { ...row.arm, ...patch } } : row)));
    setPlan(null);
  };

  if (!open) {
    return (
      <div className="border-t border-sky-100 px-4 py-2">
        <button
          type="button"
          onClick={() => {
            resetModelAb();
            setExecuted(null);
            setPlan(null);
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

  const doPreview = (): void => {
    if (!guard.canSubmit) return;
    setExecuted(null);
    void modelAb(run.meta.id, guard.arms, true).then((result) => {
      if (result !== null) setPlan(result);
    });
  };

  const doExecute = (): void => {
    if (!guard.canSubmit || plan === null) return;
    const summary = plan.plan
      .map((arm) => {
        const params =
          Object.keys(arm.params).length > 0
            ? ` ${JSON.stringify(arm.params)}`
            : "（沿用父 params）";
        const discarded =
          Object.keys(arm.discarded).length > 0
            ? `\n    丢弃父录值：${JSON.stringify(arm.discarded)}`
            : "";
        const warnings =
          arm.warnings.length > 0
            ? `\n    ⚠ ${arm.warnings.map((w) => w.key).join("、")} 可能未生效（见计划面板）`
            : "";
        return `臂 ${arm.index + 1}：${arm.model}${params}${discarded}${warnings}`;
      })
      .join("\n");
    const confirmed = window.confirm(
      `确认执行模型 A/B 实验？\n\n· 将按 ${plan.plan.length} 个臂真实调用 ${settings?.baseURL ?? "provider"} 并产生费用\n· 各臂顺序执行，单臂失败不影响其它臂\n${summary}\n${
        plan.sideEffectsAllowed
          ? "· ⚠ 含副作用的工具将被真实执行：外部状态可能已被前一臂改变\n"
          : ""
      }· 父 run 只作对照，不会被修改`,
    );
    if (!confirmed) return;
    void modelAb(run.meta.id, guard.arms, false).then((result) => {
      if (result !== null) setExecuted(result);
    });
  };

  return (
    <div className="border-t border-sky-100 bg-sky-50/60 px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-sky-900">
          模型 A/B 实验 · 同上下文多臂对比
        </span>
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
      </div>

      <div className="space-y-2">
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
                    setRows(rows.filter((_, i) => i !== index));
                    setPlan(null);
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
              setRows([...rows, { key: newArmKey(), arm: { model: parentModel, paramsText: "" } }]);
              setPlan(null);
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

      {!guard.canSubmit && guard.reason !== null ? (
        <div className="mt-2 text-[11px] text-amber-700">{guard.reason}</div>
      ) : null}

      {modelAbInFlight ? <div className="mt-2 text-[11px] text-sky-600">处理中…</div> : null}
      {modelAbError !== null ? (
        <div className="mt-2 text-[11px] text-red-700">
          {modelAbError}
          {modelAbErrorCode === "SETTINGS_NOT_CONFIGURED"
            ? "（请先点击右上角“运行配置”填写 baseURL/apiKey/model）"
            : ""}
        </div>
      ) : null}

      {plan !== null ? (
        <div className="mt-2 rounded border border-sky-200 bg-white px-2 py-1.5">
          <div className="mb-1 flex items-center gap-2 text-[10px] text-gray-500">
            <span className="font-semibold text-sky-800">校验通过 · 执行计划</span>
            <span className="font-code">实验组 {plan.experimentId}</span>
          </div>
          {plan.plan.map((arm) => (
            <ArmPlanRow key={arm.index} arm={arm} />
          ))}
          {plan.sideEffectsAllowed ? (
            <div className="mt-1 text-[10px] leading-4 text-amber-700">
              ⚠ 副作用工具将被真实执行（顺序执行，外部状态可能已被前一臂改变）——本次实验将留痕。
            </div>
          ) : null}
          <div className="mt-1 text-[10px] leading-4 text-gray-400">
            dry-run 不联网、不写文件；真实执行按臂数产生费用。执行后各臂落盘为独立新轨迹。
          </div>
        </div>
      ) : null}

      {executed !== null ? (
        <div className="mt-2 rounded border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-[11px] leading-4 text-emerald-900">
          实验完成（实验组 <span className="font-code">{executed.experimentId}</span>）：
          {executed.ids.length > 0 ? (
            <span>
              {" "}
              成功 {executed.ids.length} 臂
              {executed.plan.length !== executed.ids.length
                ? `（共 ${executed.plan.length} 臂，其余失败或被取消——详情见分支树与各 run 轨迹）`
                : ""}
              。各臂已落盘，可在分支树按“换 model/params（A/B）”标签找到同批节点。
            </span>
          ) : (
            <span> 所有臂均未成功落盘（见上方错误或 provider 响应）。</span>
          )}
        </div>
      ) : null}

      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={doPreview}
          disabled={inProgress || !guard.canSubmit}
          className="rounded border border-sky-500 px-2 py-1 text-[11px] text-sky-700 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {plan !== null ? "重新校验" : "校验并预览计划"}
        </button>
        <button
          type="button"
          onClick={doExecute}
          disabled={inProgress || !guard.canSubmit || plan === null}
          className="rounded bg-sky-600 px-3 py-1 text-[11px] text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
          title={plan === null ? "先校验并预览计划" : undefined}
        >
          确认执行（{plan?.plan.length ?? arms.length} 次真实调用）
        </button>
      </div>
    </div>
  );
}

/** llm.call 详情：完整请求 + 响应（思维链与正文分区）；代理 run 提供编辑重发 */
function LlmCallDetail({
  span,
  run,
}: { span: Extract<SpanLine, { kind: "llm.call" }>; run: RunDetail | null }) {
  const { request, response, error } = span;
  const leafOwned = run?.leafSpanIds.includes(span.id) ?? false;
  const isProxy = run?.meta.source?.kind === "proxy";
  const canResend = isProxy === true && leafOwned && run?.status === "completed";

  /**
   * 空正文文案：失败 / 仅有工具调用 / 仅有思维链 / 真空正文 四态。
   * 旧实现一律写"无正文，仅有工具调用"——对失败调用与 reasoning-only 成功响应都是错的。
   */
  const emptyContentHint =
    error !== undefined
      ? "（调用失败，无响应正文）"
      : response.tool_calls.length > 0
        ? "（无正文，仅有工具调用）"
        : response.reasoning_content !== null
          ? "（无正文，仅有思维链）"
          : "（响应为空正文）";

  return (
    <>
      <Section title="概要">
        <KeyValue
          items={[
            ["模型", request.model],
            ["输入 tokens", String(response.usage.in)],
            ["输出 tokens", String(response.usage.out)],
            ["首 token 延迟", `${response.ttft_ms}ms`],
            ["耗时", formatDuration(spanDurationMs(span))],
            ["工具调用", String(response.tool_calls.length)],
          ]}
        />
        <CacheHitRow usage={response.usage} />
      </Section>

      {error !== undefined ? (
        <Section title="错误（调用失败，错误是数据）">
          <div className="rounded border-l-2 border-red-400 bg-red-50 px-2 py-1.5">
            <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-red-900">
              <span>调用失败</span>
              {error.status === undefined ? null : (
                <span className="rounded bg-red-100 px-1 font-code">HTTP {error.status}</span>
              )}
            </div>
            <LongText text={error.message} label="错误详情" />
            <div className="mt-1 text-[11px] leading-5 text-red-800">
              这是记录于本次调用的失败原因。上列 tokens 与首 token 延迟是
              <span className="font-medium">失败占位零值</span>
              ，不代表实际零消耗或零延迟；请求内容仍可照常查看。
            </div>
          </div>
        </Section>
      ) : null}

      {response.reasoning_content !== null ? (
        <Section title="思维链（reasoning_content）">
          <div className="rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1.5">
            <LongText text={response.reasoning_content} label="思维链" />
          </div>
        </Section>
      ) : null}

      <Section title="响应正文">
        {response.content === null || response.content === "" ? (
          <div className="text-[11px] text-gray-400">{emptyContentHint}</div>
        ) : (
          <LongText text={response.content} label="正文" />
        )}
      </Section>

      {response.tool_calls.length > 0 ? (
        <Section title={`工具调用（${response.tool_calls.length}）`}>
          <LongText text={prettyJson(response.tool_calls)} label="tool_calls" />
        </Section>
      ) : null}

      <Section title={`请求消息（${request.messages.length} 条）`}>
        <div className="space-y-2">
          {request.messages.map((message, index) => (
            <div key={`${message.role}-${index}`} className="rounded bg-gray-50 px-2 py-1.5">
              <div className="mb-1 flex items-center gap-2 text-[10px] text-gray-500">
                <span className="rounded bg-gray-200 px-1 font-code">{message.role}</span>
                {typeof message.tool_call_id === "string" ? (
                  <span className="font-code">tool_call_id: {message.tool_call_id}</span>
                ) : null}
              </div>
              <LongText
                text={
                  typeof message.content === "string"
                    ? message.content
                    : prettyJson(message.content)
                }
                label="内容"
              />
            </div>
          ))}
        </div>
      </Section>

      {request.tools !== undefined ? (
        <Section title={`工具表（${request.tools.length}）`}>
          <LongText text={prettyJson(request.tools)} label="tools" />
        </Section>
      ) : null}

      {request.params !== undefined ? (
        <Section title="采样参数">
          <LongText text={prettyJson(request.params)} label="params" />
        </Section>
      ) : null}

      {(() => {
        // prompt fork 入口：仅限首次 llm.call（启动上下文的事实源）。
        // 代理 run 在录制侧已补 config_hash 时与引擎 run 同判据（不再无条件排除 proxy）；
        // 无 hash 的代理 run 不显示编辑器（服务端 loadForkParent 按缺因兜底）。
        const promptForkable =
          run !== null &&
          run.status === "completed" &&
          run.meta.config_hash !== undefined &&
          leafOwned;
        const firstLlmId = run?.spans.find((s) => s.kind === "llm.call")?.id;
        if (!promptForkable) return null;
        if (firstLlmId === span.id && run !== null) {
          return (
            <>
              <PromptForkEditor key={span.id} span={span} run={run} />
              <ModelAbEditor key={`ab-${span.id}`} span={span} run={run} />
            </>
          );
        }
        return (
          <div className="border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
            prompt fork 与模型 A/B 只从首次 llm.call 的启动上下文出发；打开首次 llm.call（
            {firstLlmId}）使用编辑入口。
          </div>
        );
      })()}

      {canResend && run !== null ? (
        <MessagesForkEditor key={span.id} span={span} run={run} />
      ) : isProxy && run !== null && run.status === "crashed" ? (
        <div className="border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
          该 run 运行中断（未封存），不允许作为重发起点。
        </div>
      ) : null}
    </>
  );
}

/**
 * 代理 run 的"编辑 messages 重发"（单请求级最小分叉，方案 a）：
 * 编辑 request.messages → 经代理用暂存 key 重发 → 新 fork run。
 * 与 runs:fork（tool.result 编辑重跑）完全独立，走 proxy:fork 通道。
 */
function MessagesForkEditor({
  span,
  run,
}: {
  span: Extract<SpanLine, { kind: "llm.call" }>;
  run: RunDetail;
}) {
  const forking = useAppStore((s) => s.forking);
  const forkError = useAppStore((s) => s.forkError);
  const forkErrorCode = useAppStore((s) => s.forkErrorCode);
  const proxyFork = useAppStore((s) => s.proxyFork);
  const resetFork = useAppStore((s) => s.resetFork);
  const proxy = useAppStore((s) => s.proxy);
  const [open, setOpen] = useState(false);
  // 预填 = 完整 messages 的 JSON 文本
  const [value, setValue] = useState(() => prettyJson(span.request.messages));
  const [parseError, setParseError] = useState<string | null>(null);

  const inProgress = forking === "in_progress";
  const unchanged = value === prettyJson(span.request.messages);

  if (!open) {
    return (
      <div className="border-t border-sky-100 px-4 py-2">
        <button
          type="button"
          onClick={() => {
            resetFork();
            setValue(prettyJson(span.request.messages));
            setParseError(null);
            setOpen(true);
          }}
          className="rounded bg-sky-600 px-2 py-1 text-[11px] text-white hover:bg-sky-700"
        >
          编辑 messages 重发
        </button>
      </div>
    );
  }

  const doResend = (): void => {
    // 提交时解析回结构体；解析失败可见报错，不发请求
    let messages: unknown;
    try {
      messages = JSON.parse(value);
    } catch (e) {
      setParseError(`messages 不是合法 JSON：${(e as Error).message}`);
      return;
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      setParseError("messages 必须是非空数组");
      return;
    }
    setParseError(null);
    if (
      !window.confirm(
        "重发将真实调用 upstream 并产生 API 费用；使用的是最近捕获的 key（可能与该 run 录制当时不同）。确认重发？",
      )
    ) {
      return;
    }
    void proxyFork(run.meta.id, span.id, messages as Record<string, unknown>[]);
  };

  return (
    <div className="border-t border-sky-100 bg-sky-50/60 px-4 py-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-sky-900">编辑 messages 重发</span>
        <span className="text-[10px] text-sky-500">
          单请求级分叉 · 源 run 不会被修改 · 重发使用最近捕获的 key
        </span>
      </div>
      <Editor
        height="200px"
        language="json"
        value={value}
        onChange={(next) => setValue(next ?? "")}
        options={{
          readOnly: inProgress,
          fontSize: 12,
          minimap: { enabled: false },
          lineNumbers: "on",
          scrollBeyondLastLine: false,
          wordWrap: "on",
          scrollbar: { vertical: "auto" },
          folding: true,
          showFoldingControls: "always",
        }}
        className="overflow-hidden rounded border border-sky-200"
      />
      <div className="mt-1.5 text-[10px] leading-4 text-sky-600">
        编辑任意一条消息后重发：model / 工具表 / 采样参数与源 run 一致，仅 messages 使用编辑后的值。
      </div>

      {parseError !== null ? (
        <div className="mt-1 text-[11px] text-red-700">{parseError}</div>
      ) : null}

      {unchanged ? (
        <div className="mt-1 text-[11px] text-amber-700">
          未做任何修改（空 fork 被拒绝），编辑后再重发。
        </div>
      ) : null}

      {forking === "error" ? (
        <div className="mt-1 text-[11px] text-red-700">
          {forkError}
          {forkErrorCode === "PROXY_NO_KEY" ? "（请先把你的应用经代理跑一次，再回来重发）" : ""}
        </div>
      ) : null}

      <div className="mt-2 flex items-center justify-end gap-2">
        {inProgress ? (
          <span className="text-[11px] text-sky-600">重发中…（真实 LLM 调用，可能耗时）</span>
        ) : null}
        <button
          type="button"
          onClick={() => {
            resetFork();
            setOpen(false);
          }}
          disabled={inProgress}
          className="rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50 disabled:opacity-40"
        >
          取消
        </button>
        <button
          type="button"
          onClick={doResend}
          disabled={inProgress || unchanged || proxy?.running !== true}
          title={proxy?.running !== true ? "代理未运行，请先在设置中启用" : undefined}
          className="rounded bg-sky-600 px-3 py-1 text-[11px] text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          确认重发
        </button>
      </div>
    </div>
  );
}

/** 当前 tool.invoke 的"模型所见的返回文本"（与 derive/run-loop 组合公式一致） */
function toolMessageText(span: Extract<SpanLine, { kind: "tool.invoke" }>): string {
  if (span.error !== null) return `工具执行失败：${span.error}`;
  const result = span.result;
  if (typeof result === "string") return result;
  if (result === undefined || result === null) return "";
  return prettyJson(result);
}

/** Monaco 语言嗅探：内容可解析为 JSON 用 json，否则纯文本 */
function detectResultLanguage(text: string): "json" | "plaintext" {
  try {
    JSON.parse(text);
    return "json";
  } catch {
    return "plaintext";
  }
}

/** tool.invoke 的"在此重跑"编辑器：改 result → 确认 → runs:fork（唯一写通道） */
function ForkEditor({
  span,
  run,
}: {
  span: Extract<SpanLine, { kind: "tool.invoke" }>;
  run: RunDetail;
}) {
  const forking = useAppStore((s) => s.forking);
  const forkError = useAppStore((s) => s.forkError);
  const forkErrorCode = useAppStore((s) => s.forkErrorCode);
  const forkAt = useAppStore((s) => s.forkAt);
  const resetFork = useAppStore((s) => s.resetFork);
  const settings = useAppStore((s) => s.settings);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(() => toolMessageText(span));

  // 父 run 在该 step 录制的模型（共享查表，与 main 侧 fork 编排同一实现）
  const parentModel = useMemo(
    () => findStepLlm(run.spans, span.id)?.request.model ?? null,
    [run.spans, span.id],
  );
  const configModel = settings?.model ?? null;
  // 只有 tool_result 分叉共享前缀，缓存提示才有意义（prompt fork / 代理 messages 分叉不加）
  const modelMismatch = parentModel !== null && configModel !== null && parentModel !== configModel;

  const original = toolMessageText(span);
  const unchanged = value === original;
  const inProgress = forking === "in_progress";
  // 语言依据原始文本初探一次（避免编辑过程中语言选项来回闪变）
  const language = useMemo(() => detectResultLanguage(original), [original]);

  if (!open) {
    return (
      <div className="border-t border-violet-100 px-4 py-2">
        <button
          type="button"
          onClick={() => {
            resetFork();
            setValue(original);
            setOpen(true);
          }}
          className="rounded bg-violet-600 px-2 py-1 text-[11px] text-white hover:bg-violet-700"
        >
          在此重跑（时间旅行）
        </button>
      </div>
    );
  }

  return (
    <div className="border-t border-violet-100 bg-violet-50/60 px-4 py-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-violet-900">在此重跑</span>
        <span className="text-[10px] text-violet-500">
          从该工具调用之后重跑 · 父 run 文件不会被修改
        </span>
      </div>
      <Editor
        height="140px"
        language={language}
        value={value}
        onChange={(next) => setValue(next ?? "")}
        options={{
          readOnly: inProgress,
          fontSize: 12,
          minimap: { enabled: false },
          lineNumbers: "on",
          scrollBeyondLastLine: false,
          wordWrap: "on",
          scrollbar: { vertical: "auto" },
          // 折叠箭头常驻 gutter（默认 mouseover 才显示，用户反馈不够直观）
          folding: true,
          showFoldingControls: "always",
        }}
        className="overflow-hidden rounded border border-violet-200"
      />
      <div className="mt-1.5 text-[10px] leading-4 text-violet-600">
        以上文本将作为该工具的返回结果重新送入模型；其余上下文（prompt、工具表、此前步骤）与父 run
        完全一致。
      </div>

      {unchanged ? (
        <div className="mt-1 text-[11px] text-amber-700">
          编辑值与原始结果相同（空 fork），需修改后再重跑。
        </div>
      ) : null}

      {modelMismatch ? (
        <div className="mt-1 text-[11px] leading-4 text-amber-700">
          父 run 该步使用 <span className="font-code">{parentModel}</span>，当前运行配置为{" "}
          <span className="font-code">{configModel}</span>
          ——前缀缓存可能不命中，计费口径可能变化（仅提示，不阻止重跑）。
        </div>
      ) : null}

      {forking === "error" ? (
        <div className="mt-1 text-[11px] text-red-700">
          {forkError}
          {forkErrorCode === "SETTINGS_NOT_CONFIGURED"
            ? "（请先点击右上角“运行配置”填写 baseURL/apiKey/model）"
            : ""}
        </div>
      ) : null}

      <div className="mt-2 flex items-center justify-end gap-2">
        {inProgress ? (
          <span className="text-[11px] text-violet-600">重跑中…（真实 LLM 调用，可能耗时）</span>
        ) : null}
        <button
          type="button"
          onClick={() => {
            resetFork();
            setOpen(false);
          }}
          disabled={inProgress}
          className="rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50 disabled:opacity-40"
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => {
            void forkAt(run.meta.id, span.id, value);
          }}
          disabled={inProgress || unchanged}
          className="rounded bg-violet-600 px-3 py-1 text-[11px] text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          确认重跑
        </button>
      </div>
    </div>
  );
}

/** tool.invoke 详情：入参、结果、错误（错误是数据，不改变 run 状态）＋ 分叉入口 */
function ToolInvokeDetail({
  span,
  run,
}: {
  span: Extract<SpanLine, { kind: "tool.invoke" }>;
  run: RunDetail | null;
}) {
  const leafOwned = run?.leafSpanIds.includes(span.id) ?? false;
  // 分叉点必须是当前 run 自身段的 tool.invoke，且 run 已封存（crashed 前缀不稳定）
  const canFork = leafOwned && run?.status === "completed";

  return (
    <>
      <Section title="概要">
        <KeyValue
          items={[
            ["工具", span.tool],
            ["执行耗时", `${span.dur_ms}ms`],
            ["墙上耗时", formatDuration(spanDurationMs(span))],
          ]}
        />
      </Section>

      {span.error !== null ? (
        <Section title="错误（错误是数据不是异常）">
          <div className="rounded border-l-2 border-red-400 bg-red-50 px-2 py-1.5">
            <LongText text={span.error} label="错误信息" />
          </div>
        </Section>
      ) : null}

      <Section title="入参">
        <LongText text={prettyJson(span.args)} label="args" />
      </Section>

      <Section title="结果">
        <LongText text={prettyJson(span.result)} label="result" />
      </Section>

      {canFork && run !== null ? (
        <ForkEditor span={span} run={run} />
      ) : span.kind === "tool.invoke" && run !== null && !leafOwned && run.chain.length > 1 ? (
        <div className="border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
          该调用位于祖先前缀（继承自父 run），不属于当前 run 自身段——打开其所属 run 才可在此重跑。
        </div>
      ) : run !== null && leafOwned && run.status === "crashed" ? (
        <div className="border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
          该 run 运行中断（未封存），不允许作为分叉起点。
        </div>
      ) : null}
    </>
  );
}

/** 分支提示：按 fork 字段分流——共享前缀（result）/ 从头重跑（prompt fork） */
function BranchNotice() {
  const detail = useAppStore((s) => s.detail);
  if (detail === null || detail.chain.length <= 1) return null;
  // 代理分叉 run：不显示"共享前缀"提示（其语义不成立），由父链列表呈现
  if (detail.meta.source?.kind === "proxy") return null;

  const hop = detail.chain[detail.chain.length - 1];
  const parentHop = detail.chain[detail.chain.length - 2];
  const fork = hop?.fork ?? null;
  if (fork === null || parentHop === undefined) return null;

  const field = fork.edit.field;

  // prompt fork：从头重跑的独立新轨迹——禁止"共享前缀"措辞，at_span 不作为普通分叉点展示
  if (isPromptForkField(field)) {
    return (
      <div className="border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-[11px] leading-5 text-emerald-900">
        prompt fork（从头重跑）：本 run 的所有 span 均来自本次完整执行，父 run
        <span className="font-code"> {parentHop.meta.id} </span>
        仅作溯源对照——不共享前缀，父轨迹不会进入本时间线。
        <br />
        编辑字段：<span className="font-code">{forkEditLabel(field)}</span>
      </div>
    );
  }

  // 模型 A/B 臂：同样是从头重跑的独立新轨迹，额外展示实验组标签
  if (field === "model_params") {
    const value = fork.edit.value;
    const experimentId =
      typeof value === "object" && value !== null
        ? (value as { experimentId?: unknown }).experimentId
        : undefined;
    const edited =
      typeof value === "object" && value !== null
        ? (value as { model?: unknown; params?: unknown })
        : undefined;
    return (
      <div className="border-b border-sky-200 bg-sky-50 px-4 py-2 text-[11px] leading-5 text-sky-900">
        模型 A/B 实验臂（从头重跑）：本 run 的所有 span 均来自本次完整执行，父 run
        <span className="font-code"> {parentHop.meta.id} </span>
        仅作对照——不共享前缀。
        <br />
        本臂：<span className="font-code">{String(edited?.model ?? "?")}</span>
        {edited?.params !== undefined ? (
          <span className="font-code"> {prettyJson(edited.params)}</span>
        ) : null}
        {typeof experimentId === "string" ? (
          <>
            {" "}
            · 实验组 <span className="font-code">{experimentId}</span>（同批臂共享此标签）
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="border-b border-violet-200 bg-violet-50 px-4 py-2 text-[11px] leading-5 text-violet-900">
      分支 run：
      <span className="font-code"> {parentHop.meta.id} </span>
      的轨迹截至分叉点
      <span className="font-code"> {fork.at_span} </span>
      为共享前缀（来自父 run 文件，本 run 只记录新增 span）。
      <br />
      编辑字段：<span className="font-code">{fork.edit.field}</span>
    </div>
  );
}

/**
 * 父级溯源链列表：代理分叉（单请求级编辑重发）与 prompt fork（从头重跑）共用——
 * 两者的详情都只呈现本 run 自身 spans，不拼接父轨迹；逐代 run 列出 + 编辑摘要，
 * 点击切换查看。
 */
function ParentChainList() {
  const detail = useAppStore((s) => s.detail);
  const selectedRunId = useAppStore((s) => s.selectedRunId);
  const selectRun = useAppStore((s) => s.selectRun);
  if (detail === null || detail.chain.length <= 1) return null;

  const isProxy = detail.meta.source?.kind === "proxy";
  const forkField = detail.meta.fork?.edit.field;
  const isPromptFork = typeof forkField === "string" && isPromptForkField(forkField);
  // 模型 A/B 臂与 prompt fork 同为"从头重跑"的独立新轨迹，详情只呈现本 run 自身 spans
  const isModelAb = forkField === "model_params";
  if (!isProxy && !isPromptFork && !isModelAb) return null;

  return (
    <div className="border-b border-sky-200 bg-sky-50 px-4 py-2 text-[11px] leading-5 text-sky-900">
      <div className="mb-1 font-semibold">
        {isModelAb
          ? "分叉链（A/B 实验臂 · 从头重跑的独立新轨迹）"
          : isPromptFork
            ? "分叉链（从头重跑的独立新轨迹）"
            : "分叉链（单请求级编辑重发）"}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {detail.chain.map((hop, index) => {
          const editedMessages = hop.fork?.edit.field === "messages";
          const editedField =
            typeof hop.fork?.edit.field === "string" && isPromptForkField(hop.fork.edit.field)
              ? hop.fork.edit.field
              : null;
          const isLeaf = index === detail.chain.length - 1;
          return (
            <span key={hop.meta.id} className="flex items-center gap-1">
              {index > 0 ? <span className="text-sky-400">→</span> : null}
              <button
                type="button"
                onClick={() => {
                  if (!isLeaf) void selectRun(hop.meta.id);
                }}
                className={`rounded px-1.5 py-0.5 font-code ${
                  isLeaf
                    ? "bg-sky-600 text-white"
                    : "border border-sky-300 bg-white text-sky-800 hover:bg-sky-100"
                }`}
                title={isLeaf ? "当前 run" : "查看该代 run 详情"}
              >
                {hop.meta.id}
              </button>
              {editedMessages ? (
                <span className="text-[10px] text-sky-600">已编辑 messages</span>
              ) : editedField !== null ? (
                <span className="text-[10px] text-emerald-700">{forkEditLabel(editedField)}</span>
              ) : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 错误详情缺失提示（诚实降级）。
 *
 * 判定全部落在共享派生层（`deriveMissingLlmErrorDetail`）：错误终止 + 本 run 自有 spans
 * 无任何带 error 的 llm.call。**只查 leafSpanIds 过滤后的 spans**——祖先前缀里的失败
 * 不得冒充本次失败原因，也不得因此隐藏本 run 的缺失提示。
 * 只陈述"未记录"这一事实，不推断原因（空正文 / 零 token / 末尾 llm.call 概不参与）。
 */
function ErrorDetailNotice() {
  const detail = useAppStore((s) => s.detail);
  const missing = useMemo(
    () =>
      detail !== null &&
      deriveMissingLlmErrorDetail({
        events: detail.events,
        spans: detail.spans,
        leafSpanIds: detail.leafSpanIds,
      }),
    [detail],
  );
  if (!missing) return null;

  return (
    <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-[11px] leading-5 text-red-900">
      错误详情未记录：本 run 以「出错终止」收尾，但它自身没有任何记录了失败原因的 LLM 调用
      （代理录制的失败、或早于错误详情记录能力的历史 run）。
      <br />
      此处不推断失败原因；轨迹树上的失败标记只反映各 span 自身记录的 error，不代表本次终止的原因。
    </div>
  );
}

export function DetailPanel() {
  const detail = useAppStore((s) => s.detail);
  const selectedSpanId = useAppStore((s) => s.selectedSpanId);

  const span = useMemo(
    () => detail?.spans.find((s) => s.id === selectedSpanId) ?? null,
    [detail, selectedSpanId],
  );

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-white">
      <div className="border-b border-gray-200 px-4 py-2">
        <div className="text-sm font-semibold text-gray-800">详情</div>
        <div className="text-[11px] text-gray-500">
          {span === null ? "选中左侧任意 span 查看原始请求与响应" : `span ${span.id}`}
        </div>
      </div>

      <BranchNotice />
      <ErrorDetailNotice />
      <ParentChainList />

      <div className="flex-1 overflow-y-auto pb-8">
        {detail !== null ? <BudgetMap key={detail.meta.id} detail={detail} /> : null}
        {span === null ? (
          <div className="px-4 py-6 text-xs text-gray-500">
            {detail === null ? "尚未选择运行。" : "尚未选择 span。"}
          </div>
        ) : span.kind === "llm.call" ? (
          <LlmCallDetail span={span} run={detail} />
        ) : span.kind === "tool.invoke" ? (
          // key=span.id：切换 span 时重置分叉编辑器的编辑状态
          <ToolInvokeDetail key={span.id} span={span} run={detail} />
        ) : (
          <Section title="步骤概要">
            <KeyValue
              items={[
                ["迭代序号", String(span.n)],
                ["耗时", formatDuration(spanDurationMs(span))],
              ]}
            />
            <div className="mt-2 text-[11px] text-gray-500">
              展开该步骤可查看其下的 LLM 调用与工具执行。
            </div>
          </Section>
        )}
      </div>
    </section>
  );
}
