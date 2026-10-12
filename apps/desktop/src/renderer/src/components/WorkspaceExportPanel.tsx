import type { KeyboardEvent } from "react";
import type { WorkspaceExportFeedback } from "../lib/workspace-export-state";

/**
 * R2.1 任务 6.1/6.2/6.3：文件页的**导出选定检查点**面板（展示层，只吃 props）。
 *
 * 四条纪律（spec delta 硬约束）：
 * 1. **资格与文本工具解耦**：入口可用性只取决于「检查点清单已核实且全部附件可用」——
 *    与 Monaco 是否挂载、是否选中文件、有无 diff、是否二进制**完全无关**（初始快照、
 *    空快照、无变化、纯二进制检查点都可以导出）。已知选定附件缺失/损坏 ⇒ 禁用并说明。
 * 2. **确认先行**：点击入口只展开确认卡（检查点 / 空目录要求 / files/ 布局 / 未保留状态），
 *    用户在确认卡里显式点「选择目标目录并导出」才打开原生对话框；取消确认或取消目录
 *    选择都零写入。目标物理路径由 main 对话框决定，本组件没有任何路径输入。
 * 3. **反馈按提交身份绑定**（5.3 的会话状态）：成功/失败/取消都以提交时的 run/step 为键，
 *    迟到反馈不覆盖新对象、不抢焦点、不自动切运行；切页不中止 main 写入。
 * 4. **诚实边界**：文件导出成功 ≠ 测试通过 ≠ 项目可运行 ≠ 已应用补丁；补丁不可用
 *    不被描述为文件导出失败；重载后反馈丢失 = 结果未知（本会话不自动重发）。
 */

export interface WorkspaceExportPanelProps {
  readonly runId: string;
  readonly stepSpanId: string | null;
  /** 当前检查点的可读名（确认卡与成功反馈里显示） */
  readonly checkpointLabel: string;
  /** 入口资格：清单已核实且全部附件可用 */
  readonly eligible: boolean;
  /** 不可用时的具体原因（title 与禁用说明共用；eligible 时为 null） */
  readonly ineligibleReason: string | null;
  /** 同一提交目标（run+step）的当前反馈；null = 本会话尚无该目标的反馈 */
  readonly feedback: WorkspaceExportFeedback | null;
  /** 确认卡是否展开（父层持有；选择切换时父层可收起） */
  readonly expanded: boolean;
  readonly onToggleExpanded: () => void;
  /** 用户在确认卡里确认：打开原生目录选择并导出（main 侧接手） */
  readonly onConfirm: () => void;
}

/** 补丁三态的展示行（written 列覆盖与排除，not_available 列原因与排除） */
function PatchFeedback({
  feedback,
}: { feedback: Extract<WorkspaceExportFeedback, { kind: "exported" }> }) {
  const patch = feedback.result.patch;
  if (patch.status === "no_text_changes") {
    return (
      <div className="text-gray-600">
        补丁：与初始快照无文本差异（no_text_changes），未生成 changes.patch。
      </div>
    );
  }
  if (patch.status === "not_available") {
    return (
      <div className="text-amber-800">
        <div>补丁不可用{patch.reason === null ? "" : `：${patch.reason}`}；文件导出不受影响。</div>
        {patch.excluded.map((entry) => (
          <div key={entry.path} className="font-code text-[10px]">
            {entry.path}：{entry.reason}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="text-gray-700">
      <div>
        补丁已生成 changes.patch（{patch.bytes} 字节）；覆盖 {patch.covered.length}{" "}
        个路径的文本修改/新增。
      </div>
      {patch.covered.map((path) => (
        <div key={path} className="font-code text-[10px] text-gray-500">
          + {path}
        </div>
      ))}
      {patch.excluded.map((entry) => (
        <div key={entry.path} className="font-code text-[10px] text-amber-700">
          {entry.path}：未覆盖（{entry.reason}）
        </div>
      ))}
    </div>
  );
}

/** 单条反馈的正文（按 kind 分流；全部不抢焦点、不触发导航） */
function ExportFeedbackBody({ feedback }: { feedback: WorkspaceExportFeedback }) {
  switch (feedback.kind) {
    case "in-flight":
      return (
        <div className="rounded border-l-2 border-violet-400 bg-violet-50 px-2 py-1.5 text-[11px] leading-4 text-violet-900">
          正在导出「{feedback.stepSpanId === null ? "初始检查点" : `检查点 ${feedback.stepSpanId}`}
          」… 切换页面不会中止导出；返回本页可查看结果。重载后本提示会丢失，请以目标目录中的
          rebaseagent-export.json 为准。
        </div>
      );
    case "canceled":
      return (
        <div className="rounded border-l-2 border-gray-300 bg-gray-50 px-2 py-1.5 text-[11px] leading-4 text-gray-600">
          已取消：未选择目标目录，没有写入任何内容。
        </div>
      );
    case "failed":
      return (
        <div className="rounded border-l-2 border-red-400 bg-red-50 px-2 py-1.5 text-[11px] leading-4 text-red-800">
          <div>
            导出失败（{feedback.code}）：{feedback.reason}
          </div>
          {feedback.retained.length > 0 ? (
            <div className="mt-1">
              目标中残留本次导出的半成品（清理未完成），请勿直接使用，也不要把残留当作完整导出：
              <div className="font-code text-[10px]">
                {feedback.retained.map((path) => (
                  <div key={path}>{path}</div>
                ))}
              </div>
            </div>
          ) : null}
          <div className="mt-1 text-red-600">
            当前 run/文件选择/草稿未被改写；可换一个空目录重试。
          </div>
        </div>
      );
    case "exported":
      return (
        <div className="rounded border-l-2 border-emerald-500 bg-emerald-50 px-2 py-1.5 text-[11px] leading-4 text-emerald-900">
          <div className="font-semibold">
            已导出 {feedback.result.fileCount} 个文件（共 {feedback.result.totalFileBytes}{" "}
            字节）到：
          </div>
          <div className="break-all font-code text-[10px]">{feedback.result.targetDir}</div>
          <div className="mt-0.5 text-gray-600">
            文件树在 <span className="font-code">{feedback.result.filesRoot}/</span>{" "}
            下；带回原项目时复制该目录内容。根部另有{" "}
            <span className="font-code">rebaseagent-export.json</span>{" "}
            清单（含逐文件哈希与未保留状态）。
          </div>
          <div className="mt-1">
            <PatchFeedback feedback={feedback} />
          </div>
          <div className="mt-1 text-gray-500">
            权限、可执行位、时间戳、链接、空目录与外部服务状态未保留（原状态未知）。导出成功只表示材料已导出，
            不表示项目可构建、测试通过或已应用。
          </div>
        </div>
      );
  }
}

export function WorkspaceExportPanel({
  runId,
  stepSpanId,
  checkpointLabel,
  eligible,
  ineligibleReason,
  feedback,
  expanded,
  onToggleExpanded,
  onConfirm,
}: WorkspaceExportPanelProps) {
  /** 任务 6.4：Esc 收起确认卡（零写入；焦点落回入口按钮，不丢在页面外） */
  const onEscape = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape" || !expanded) return;
    event.stopPropagation();
    onToggleExpanded();
    // 收起后入口按钮仍在 DOM（流内渲染，无卸载）⇒ 直接聚焦完成焦点回收
    event.currentTarget.querySelector<HTMLButtonElement>("[data-export-entry]")?.focus();
  };

  return (
    <div className="mt-1" data-export-panel={runId} onKeyDown={onEscape}>
      <button
        type="button"
        data-export-entry="true"
        disabled={!eligible}
        aria-expanded={expanded ? "true" : "false"}
        onClick={onToggleExpanded}
        title={
          eligible
            ? "把当前检查点导出为独立结果材料（文件树 + 清单 + 适用的文本补丁）"
            : (ineligibleReason ?? "当前不可导出")
        }
        className="rounded border border-violet-300 px-2 py-0.5 text-[11px] text-violet-700 hover:bg-violet-50 focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
      >
        {expanded ? "收起导出" : "导出选定检查点"}
      </button>
      {ineligibleReason !== null ? (
        <span className="ml-2 text-[10px] text-gray-400">{ineligibleReason}</span>
      ) : null}

      {expanded && eligible ? (
        <div
          className="mt-1.5 rounded border border-violet-200 bg-violet-50/60 px-3 py-2 text-[11px] leading-5 text-gray-700"
          data-export-confirm="true"
        >
          <div className="font-semibold text-gray-800">
            导出「{checkpointLabel}」（{stepSpanId === null ? "本 run 初始检查点" : "自有完成步骤"}
            ）
          </div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            <li>目标必须是一个**空目录**（由系统目录选择器指定；不会覆盖任何既有文件）。</li>
            <li>
              导出布局：<span className="font-code">files/</span> 文件树（项目文件原样存放）+ 根部{" "}
              <span className="font-code">rebaseagent-export.json</span> 清单 + 适用的{" "}
              <span className="font-code">changes.patch</span> 文本补丁。
            </li>
            <li>
              只复制已校验的普通文件字节；权限、可执行位、时间戳、链接、空目录、外部服务**未保留**（原状态未知）。
            </li>
            <li>源目录、trace、父/兄弟运行与本页阅读位置都不会被改动。</li>
          </ul>
          <div className="mt-1.5 flex gap-2">
            <button
              type="button"
              data-export-confirm="true"
              onClick={onConfirm}
              className="rounded border border-violet-400 bg-violet-600 px-2 py-0.5 text-[11px] text-white hover:bg-violet-700 focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:outline-none"
            >
              选择目标目录并导出
            </button>
            <button
              type="button"
              data-export-cancel="true"
              onClick={onToggleExpanded}
              className="rounded border border-gray-300 bg-white px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50"
            >
              取消（不写入）
            </button>
          </div>
        </div>
      ) : null}

      {feedback === null ? null : (
        <div className="mt-1.5" data-export-feedback={feedback.kind}>
          <ExportFeedbackBody feedback={feedback} />
        </div>
      )}
    </div>
  );
}
