import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RunDetail } from "@shared/ipc";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AuxWorkspaceFrame } from "../src/renderer/src/components/AuxWorkspaceFrame";
import {
  RunActionsBarView,
  experimentEntryReason,
} from "../src/renderer/src/components/RunActionsBar";
import { decideExperimentEntry } from "../src/renderer/src/lib/aux-workspace";
import { stripComments } from "../src/renderer/src/lib/overview-view";

// RunActionsBar → store → lib/api.ts 在模块级读 window.api：先打桩再求值（引擎室纪律）
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).window = { api: {} };
});

/**
 * U8 任务 1.4：入口接线与工作区外壳的**能力断言**。
 *
 * 无 jsdom：能力断言打在「只吃 props 的纯视图」上（renderToStaticMarkup）；
 * 「组件被挂在哪」的外壳接线打在**源码级接线契约**上（App 分支 / GlobalBar 通道）——
 * 组件级测试覆盖不到挂载点（U1 三次复发的教训）。
 */

const APP_SRC = stripComments(
  readFileSync(resolve(import.meta.dirname, "../src/renderer/src/App.tsx"), "utf8"),
);
const norm = (s: string): string => s.replace(/\s+/g, " ");

/** 最小 RunDetail 形状（decideExperimentEntry 只读 meta.id / meta.workspace / spans） */
function detailFixture(input: {
  id?: string;
  workspace?: unknown;
  spanKinds?: readonly string[];
}): RunDetail {
  return {
    meta: {
      id: input.id ?? "r_parent",
      ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
    },
    spans: (input.spanKinds ?? ["llm.call", "agent.step"]).map((kind, i) => ({
      id: `s_${String(i + 1).padStart(2, "0")}`,
      kind,
    })),
  } as unknown as RunDetail;
}

describe("U8 1.4：实验入口决策（decideExperimentEntry）", () => {
  it("详情未读取 ⇒ disabled no-detail", () => {
    expect(decideExperimentEntry(null)).toEqual({ kind: "disabled", reason: "no-detail" });
  });

  it("隔离运行（带 meta.workspace）⇒ disabled isolated，不提供旁路", () => {
    const d = detailFixture({ workspace: { profile: "file-tools-v1" } });
    expect(decideExperimentEntry(d)).toEqual({ kind: "disabled", reason: "isolated" });
  });

  it("无自有 llm.call ⇒ disabled no-own-llm-call", () => {
    const d = detailFixture({ spanKinds: ["agent.step", "tool.invoke"] });
    expect(decideExperimentEntry(d)).toEqual({ kind: "disabled", reason: "no-own-llm-call" });
  });

  it("普通 run ⇒ open，目标绑定**首次**自有 llm.call（不得用后续调用）", () => {
    const d = detailFixture({ spanKinds: ["agent.step", "llm.call", "llm.call"] });
    expect(decideExperimentEntry(d)).toEqual({
      kind: "open",
      target: { runId: "r_parent", spanId: "s_02" },
    });
  });
});

describe("U8 1.4：运行级入口的纯视图（RunActionsBarView）", () => {
  it("open ⇒ 入口按钮可用且无理由文案", () => {
    const html = renderToStaticMarkup(
      <RunActionsBarView
        decision={{ kind: "open", target: { runId: "r1", spanId: "s1" } }}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain("模型实验");
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain("data-experiment-entry-reason");
  });

  it("三类 disabled ⇒ 逐控件 disabled 属性 + 就近理由（不是只给灰按钮）", () => {
    for (const reason of ["no-detail", "isolated", "no-own-llm-call"] as const) {
      const html = renderToStaticMarkup(
        <RunActionsBarView decision={{ kind: "disabled", reason }} onOpen={() => {}} />,
      );
      // 逐控件判属性：入口按钮自己的开标签带 disabled=""
      expect(html).toMatch(/data-experiment-entry[^>]* disabled=""/);
      expect(html).toContain("data-experiment-entry-reason");
      expect(html).toContain(experimentEntryReason(reason));
    }
  });
});

describe("U8 1.4：辅助工作区外壳（AuxWorkspaceFrame）", () => {
  it("有来源 ⇒ 返回来源是真实可点按钮", () => {
    const html = renderToStaticMarkup(
      <AuxWorkspaceFrame
        title="模型实验"
        description="d"
        targetLine={null}
        returnAvailable={true}
        onReturn={() => {}}
      >
        <p>正文</p>
      </AuxWorkspaceFrame>,
    );
    expect(html).toContain('aria-label="返回来源"');
    expect(html).not.toContain('disabled=""');
  });

  it("无来源（重载后）⇒ 按钮禁用并说明原因，不伪造回不去的入口", () => {
    const html = renderToStaticMarkup(
      <AuxWorkspaceFrame
        title="录制接入"
        description="d"
        targetLine={null}
        returnAvailable={false}
        onReturn={() => {}}
      >
        <p>正文</p>
      </AuxWorkspaceFrame>,
    );
    expect(html).toMatch(/aria-label="返回来源"[^>]*disabled=""/);
    expect(html).toContain("重载后来源失效");
  });

  it("目标身份行原样呈现；null 时不出现伪造身份", () => {
    const withTarget = renderToStaticMarkup(
      <AuxWorkspaceFrame
        title="t"
        description="d"
        targetLine="父本 r1 · 首次模型调用 s1"
        returnAvailable={true}
        onReturn={() => {}}
      >
        正文
      </AuxWorkspaceFrame>,
    );
    expect(withTarget).toContain("父本 r1 · 首次模型调用 s1");
    const without = renderToStaticMarkup(
      <AuxWorkspaceFrame
        title="t"
        description="d"
        targetLine={null}
        returnAvailable={true}
        onReturn={() => {}}
      >
        正文
      </AuxWorkspaceFrame>,
    );
    expect(without).not.toContain("父本");
  });
});

describe("U8 1.4：外壳接线契约（源码级——组件测试覆盖不到「挂在哪」）", () => {
  it("App 的三个辅助视图分支必须挂对应工作区组件（不得缺失或挂错）", () => {
    for (const [view, component] of [
      ["recording", "RecordingWorkspace"],
      ["experiment", "ExperimentWorkspace"],
      ["messages", "MessagesWorkspace"],
    ] as const) {
      expect(
        APP_SRC.includes(`view === "${view}"`) && APP_SRC.includes(`<${component} />`),
        `App 分支 view === "${view}" 应挂 <${component} />`,
      ).toBe(true);
    }
  });

  it("录制入口（全局栏/空态共用 openRecording）必须走 store 的 openRecordingWorkspace", () => {
    expect(norm(APP_SRC)).toContain("useAppStore.getState().openRecordingWorkspace()");
    // 不再经设置模态定位代理分区（旧形态不得残留）
    expect(APP_SRC).not.toContain('setSettingsSection("proxy");');
  });

  it("运行页头挂 RunActionsBar（实验入口），旧形态（无入口）不得回来", () => {
    expect(APP_SRC).toContain("<RunActionsBar compact />");
  });
});

describe("U8 6.11：键盘闭环的焦点回位接线（实机坐实补齐）", () => {
  const FRAME_SRC = stripComments(
    readFileSync(
      resolve(import.meta.dirname, "../src/renderer/src/components/AuxWorkspaceFrame.tsx"),
      "utf8",
    ),
  );
  const STORE_SRC = stripComments(
    readFileSync(resolve(import.meta.dirname, "../src/renderer/src/store.ts"), "utf8"),
  );
  const RECORDING_SRC = stripComments(
    readFileSync(
      resolve(import.meta.dirname, "../src/renderer/src/components/RecordingWorkspace.tsx"),
      "utf8",
    ),
  );

  it("辅助工作区主容器带 data-aux-frame 焦点锚点（真实可聚焦容器，不是说明文字）", () => {
    const html = renderToStaticMarkup(
      <AuxWorkspaceFrame
        title="录制接入"
        description="d"
        targetLine={null}
        returnAvailable={true}
        onReturn={() => {}}
      >
        body
      </AuxWorkspaceFrame>,
    );
    expect(html).toContain('data-aux-frame="true"');
    expect(html).toContain('tabindex="-1"');
  });

  it("returnToAuxSource 返回后焦点落回辅助工作区主容器（场景「返回有效来源焦点」）", () => {
    const start = STORE_SRC.indexOf("async returnToAuxSource(");
    expect(start).toBeGreaterThan(-1);
    const body = STORE_SRC.slice(start, STORE_SRC.indexOf("\n  },", start));
    expect(body).toContain('document.querySelector<HTMLElement>("[data-aux-frame]")');
    expect(body).toContain('document.querySelector<HTMLElement>("main")');
    expect(body).toContain("?.focus()");
  });

  it("录制应用完成后焦点回到应用按钮（应用在飞禁用期焦点落 body 的回位）", () => {
    const start = RECORDING_SRC.indexOf("onApply={() => {");
    expect(start).toBeGreaterThan(-1);
    const body = RECORDING_SRC.slice(start, RECORDING_SRC.indexOf("}}", start));
    expect(body).toContain("applyRecordingDraft()");
    expect(body).toContain(
      'document.querySelector<HTMLElement>("[data-recording-apply]")?.focus()',
    );
  });
});
