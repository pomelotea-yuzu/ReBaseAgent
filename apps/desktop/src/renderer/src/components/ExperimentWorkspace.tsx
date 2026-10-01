import type { SpanLine } from "@rebaseagent/trace-sdk";
import { useEffect } from "react";
import { resolveExecutionGate } from "../lib/workspace-selection";
import { useAppStore } from "../store";
import { AuxWorkspaceFrame } from "./AuxWorkspaceFrame";
import { ModelAbEditor } from "./ModelAbEditor";

/**
 * U8 任务 3.1b：实验工作区容器——**目标作用域**的父本源读取与编辑器挂载。
 *
 * 三条本容器负责的边界（design D1 + delta「运行入口打开明确实验目标」「切运行不更换实验父本」）：
 * 1. 父本详情走**自己的只读读取**（`readExperimentSource`），不借用全局 `detail`
 *    ——目标不跟随侧栏选择，全局详情在这里会看错对象；读取不改选中项、不切页；
 * 2. 目标 span 必须在父本详情里点名存在（首次自有 llm.call）；详情读不出/换内容时
 *    如实说明，不拿别的 span 顶上（3.2 的来源重验在编辑器内部按同一份详情进行）；
 * 3. 源可用性按**目标**计算（列表在场 + ownOnly + 读取中），传给编辑器覆盖
 *    全局选中作用域的默认门禁。
 */
export function ExperimentWorkspace() {
  const target = useAppStore((s) => s.experimentTarget);
  const source = useAppStore((s) => s.experimentSource);
  const location = useAppStore((s) => s.experimentReturnLocation);
  const returnToAuxSource = useAppStore((s) => s.returnToAuxSource);
  const readExperimentSource = useAppStore((s) => s.readExperimentSource);
  const runs = useAppStore((s) => s.runs);

  // 目标在场且尚未读到 ⇒ 发起只读读取（换目标后 openExperimentWorkspace 已回到 idle）
  useEffect(() => {
    if (target !== null && source.phase === "idle") {
      void readExperimentSource();
    }
  }, [target, source.phase, readExperimentSource]);

  const targetInList = target !== null && runs.some((run) => run.id === target.runId);
  const targetExecutable = resolveExecutionGate({
    unavailable: !targetInList,
    reading: source.phase === "reading",
    listLoaded: true,
    // U6 5.12 同口径：父本详情 ownOnly ⇒ 依赖父本的执行入口一并禁用
    lineageIncomplete: source.detail?.completeness === "ownOnly",
  });

  const span =
    target !== null && source.phase === "ready"
      ? (source.detail?.spans.find(
          (candidate): candidate is Extract<SpanLine, { kind: "llm.call" }> =>
            candidate.id === target.spanId && candidate.kind === "llm.call",
        ) ?? null)
      : null;

  let body;
  if (target === null) {
    body = (
      <div className="text-reading-meta text-gray-500">
        未绑定实验目标（会话内目标不跨重载保留；从运行的更多操作重新进入即可）。
      </div>
    );
  } else if (source.phase === "failed") {
    body = (
      <div className="flex flex-col gap-2 text-reading-meta" data-experiment-source-failed>
        <span className="text-red-700">父本详情读取失败：{source.errorMessage}</span>
        <button
          type="button"
          onClick={() => void readExperimentSource()}
          className="w-fit rounded border border-gray-300 px-2 py-0.5 text-gray-600 hover:bg-gray-50"
        >
          只读重试
        </button>
      </div>
    );
  } else if (source.phase !== "ready" || source.detail === null) {
    body = <div className="text-reading-meta text-gray-500">正在读取父本详情…</div>;
  } else if (span === null) {
    body = (
      <div className="text-reading-meta text-amber-700" data-experiment-source-span-missing>
        父本详情里找不到目标调用（{target.spanId}
        ）：详情内容可能已改变；批次草稿保留，执行入口不可用。
      </div>
    );
  } else {
    body = (
      <ModelAbEditor
        key={`${target.runId}:${target.spanId}`}
        span={span}
        run={source.detail}
        sourceExecutable={targetExecutable}
        alwaysOpen={true}
      />
    );
  }

  return (
    <AuxWorkspaceFrame
      title="模型实验"
      description="以一个普通运行及其首次模型调用为父本，编排多臂参数对比。资格由门禁与 main 裁决；臂编辑与计划预览在此完成。"
      targetLine={target === null ? null : `父本 ${target.runId} · 首次模型调用 ${target.spanId}`}
      returnAvailable={location !== null}
      onReturn={() => void returnToAuxSource("experiment")}
    >
      {body}
    </AuxWorkspaceFrame>
  );
}
