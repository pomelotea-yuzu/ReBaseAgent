import { deriveMissingLlmErrorDetail, forkEditLabel, isPromptForkField } from "@shared/derive";
import { useMemo } from "react";
import { prettyJson } from "../lib/format";
import {
  isolatedBranchBoundaryLabel,
  isolatedRunNotice,
  resumeBoundaryIteration,
} from "../lib/isolated-fork";
import { useAppStore } from "../store";

/**
 * 运行详情提示区（U1 任务 6.1 抽出）。
 *
 * 为什么单独成文件：这些提示原先内联在 `DetailPanel` 里，而 U1 6.1 把**文件页**从
 * `DetailPanel` 内部上提为主工作区的一级承载 ⇒ 文件页也需要同一套边界说明（隔离来源、
 * 源记录不可用、阅读位置失效…）。抽出来两边共用，避免出现"步骤页有、文件页没有"
 * 的两套口径——那正是 delta「保留现有隔离说明和异常」要防的。
 *
 * 六块互不替代，各自只回答一个问题：
 *   1. `IsolatedRunNotice`：这是不是一个文件隔离 run、世界从哪来（v1 老 trace 无此字段 ⇒ 不出现）
 *   2. `SourceUnavailableNotice`：源记录已不可用 ⇒ 依赖它的**新执行**被禁用（只读阅读仍可继续）
 *   3. `ReadingInvalidatedNotice`：上次记的阅读位置不在了 ⇒ 已回退默认
 *   4. `BranchNotice`：本 run 与父 run 的关系（**按 fork 字段分流**，独立执行绝不称"共享前缀"）
 *   5. `ErrorDetailNotice`：错误终止但没有记录失败原因 ⇒ 只陈述"未记录"，不推断原因
 *   6. `ParentChainList`：逐代父链与编辑摘要（代理/prompt fork/模型 A+B 臂才出现）
 *
 * ⚠️ 全部读 store（当前选中 run）。本包无 jsdom 打不到真实渲染，故这层只做"呈现"，
 *    判据本身在 `@shared/derive` 与 `lib/isolated-fork` 里（已有各自测试）。
 */

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

  // 隔离续跑分支：边界是**父 run 该轮的轮末**（不是 at_span 截断）。轮号取边界 step
  // 自身的 `agent.step.n`——即所属 run 的本地轮号，绝不按合并轨迹沿链累加。
  const resumeAfterStep = fork.resume_after_step;
  if (detail.meta.workspace !== undefined && typeof resumeAfterStep === "string") {
    const iteration = resumeBoundaryIteration(detail.spans, resumeAfterStep);
    return (
      <div className="border-b border-violet-200 bg-violet-50 px-4 py-2 text-[11px] leading-5 text-violet-900">
        隔离续跑分支：{isolatedBranchBoundaryLabel(parentHop.meta.id, iteration, resumeAfterStep)}
        ，该轮全部工具的结果作为共享前缀各出现一次。
        <br />
        编辑位置 <span className="font-code">{fork.at_span}</span> · 轮末边界{" "}
        <span className="font-code">{resumeAfterStep}</span>
        （轮号取所属 run 的原始 agent.step.n，不按合并轨迹沿链累加）
      </div>
    );
  }

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
 * 源记录不可用标注（任务 3.5）：
 * 刷新确认当前选中运行的源文件消失或变为读取失败时，屏幕上**已加载的内容保留**
 * （用户还看得见他正在看的东西），但必须明确标出「源记录不可用」，并禁用依赖它的
 * 新执行；重新读取并校验通过前不得以旧内容获得执行资格。
 *
 * 只按列表当前事实陈述，不猜是哪一条失败文件。
 */
function SourceUnavailableNotice() {
  const unavailable = useAppStore((s) => s.sourceUnavailable);
  const reason = useAppStore((s) => s.sourceUnavailableReason);
  const loadRuns = useAppStore((s) => s.loadRuns);
  if (!unavailable) return null;

  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-[11px] leading-5 text-amber-900">
      <span className="font-semibold">源记录不可用：</span>
      {reason === "unreadable"
        ? "刷新时该运行的源文件读取失败，下方内容为之前加载的结果，"
        : "刷新时该运行的记录已不在 traces 目录中，下方内容为之前加载的结果，"}
      依赖它的新执行（重跑、prompt/messages 编辑、模型实验）已禁用。
      <br />
      重新读取并校验通过后自动恢复；也可在左侧列表改选其他运行。
      <button
        type="button"
        onClick={() => {
          void loadRuns();
        }}
        className="ml-1 underline hover:text-amber-950"
      >
        重新读取
      </button>
    </div>
  );
}

/**
 * 失效阅读对象提示（任务 3.6 · delta「失效阅读对象安全回退」）。
 *
 * 只说**事实**：上次记下的阅读位置已不在此次详情里，因此回退到了默认位置。
 * 不说"文件被删了"之类的因果（那不是渲染层能知道的事），也不暗示选了别的 run 的同 ID span。
 */
function ReadingInvalidatedNotice() {
  const invalidated = useAppStore((s) => s.readingInvalidated);
  if (!invalidated) return null;

  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-[11px] leading-5 text-amber-900">
      <span className="font-semibold">原阅读位置不可用：</span>
      上次记录的 span 或展开项已不在本次读取到的轨迹里（可能是记录被重写或缩减）。
      已清理失效引用并回到默认位置。
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

/**
 * 隔离运行标注：明确标注"文件隔离"并说明世界来源。
 * v1 老 trace 没有 `meta.workspace` ⇒ 整块不出现（**不得**把老记录显示成"已恢复历史磁盘状态"）。
 */
function IsolatedRunNotice() {
  const detail = useAppStore((s) => s.detail);
  const notice = isolatedRunNotice(detail);
  if (notice === null) return null;

  return (
    <div className="border-b border-violet-200 bg-violet-50 px-4 py-2 text-[11px] leading-5 text-violet-900">
      {notice}
    </div>
  );
}

/**
 * 提示区组合（顺序即阅读顺序：先"这是什么 run"，再"有没有异常"，最后"与父的关系"）。
 *
 * ⚠️ 步骤页与**文件页**共用本组件——文件页同样需要知道世界来源与源记录是否可用，
 *    否则用户会在一个来历不明的文件清单上做判断。
 */
export function DetailNotices() {
  return (
    <>
      <IsolatedRunNotice />
      <SourceUnavailableNotice />
      <ReadingInvalidatedNotice />
      <BranchNotice />
      <ErrorDetailNotice />
      <ParentChainList />
    </>
  );
}

/** 逐个导出供测试直接渲染（本包无 jsdom，只做静态结构断言） */
export {
  BranchNotice,
  ErrorDetailNotice,
  IsolatedRunNotice,
  ParentChainList,
  ReadingInvalidatedNotice,
  SourceUnavailableNotice,
};
