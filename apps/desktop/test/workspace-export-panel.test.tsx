import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WorkspaceExportFeedback } from "../src/renderer/src/lib/workspace-export-state";
import { renderWithLocale } from "./i18n/render-with-locale";

// WorkspaceFileView 的 import 链经 store → lib/api 读 `window.api`（模块级求值）⇒
// 必须先放桩再动态 import（静态 import 会先于桩执行）
(globalThis as Record<string, unknown>).window = { api: {} };

const { WorkspaceExportPanel } = await import(
  "../src/renderer/src/components/WorkspaceExportPanel"
);
const { WorkspaceFileViewBody } = await import("../src/renderer/src/components/WorkspaceFileView");

/**
 * R2.1 任务 6.1/6.2/6.3：文件页**导出选定检查点**面板的结构断言。
 *
 * 本包无 jsdom，`renderToStaticMarkup` 不跑 effect ⇒ 断言打在纯展示层
 * （`WorkspaceExportPanel` 直渲 + `WorkspaceFileViewBody` 经 `exportPanel` props 集成）。
 * 资格判据与反馈数据的生产在连接层（`WorkspaceFileView`）与 store 会话状态
 * （`workspace-export-state.test.ts`），不在本文件。
 *
 * 钉住的义务：
 * 1. 资格不足 ⇒ 入口禁用且给出具体原因（已知附件失败须说明）；
 * 2. 确认卡写明：检查点、空目录要求、files/ 布局、未保留状态；提交/取消两个显式动作；
 * 3. 反馈四态：成功带目标/数量/字节/补丁三态与未保留说明；失败带稳定码与残留警示；
 *    取消明说零写入；在飞说明切页不中止；
 * 4. 诚实边界：成功 ≠ 测试通过 ≠ 已应用；补丁不可用 ≠ 文件导出失败。
 */

const EXPORTED: WorkspaceExportFeedback = {
  kind: "exported",
  runId: "run_x",
  stepSpanId: "s_02",
  generation: 1,
  result: {
    targetDir: "D:/out/target",
    filesRoot: "files",
    fileCount: 2,
    totalFileBytes: 1536,
    snapshotId: "a".repeat(64),
    stepSpanId: "s_02",
    patch: {
      status: "written",
      file: "changes.patch",
      bytes: 120,
      sha256: "b".repeat(64),
      covered: ["a.txt"],
      excluded: [{ path: "bin.dat", reason: "binary" }],
    },
    unpreserved: {
      permissions: "未保留（原状态未知）",
      executable_bit: "未保留（原状态未知）",
      timestamps: "未保留（原状态未知）",
      links: "未保留（原状态未知）",
      empty_directories: "未保留（原状态未知）",
      external_services: "未保留（原状态未知）",
    },
  },
};

const base = {
  runId: "run_x",
  stepSpanId: "s_02" as string | null,
  checkpointLabel: "本 run 第 1 轮结束",
  eligible: true,
  ineligibleReason: null,
  feedback: null,
  expanded: false,
  onToggleExpanded: () => undefined,
  onConfirm: () => undefined,
};

function markup(element: React.ReactElement): string {
  return renderWithLocale("zh-CN", element);
}

describe("导出入口资格（任务 6.1）", () => {
  it("资格不足：入口禁用并显示具体原因（附件缺失说明）", () => {
    const html = markup(
      createElement(WorkspaceExportPanel, {
        ...base,
        eligible: false,
        ineligibleReason: "有 1 个附件缺失或损坏；导出要求全部附件可验证",
      }),
    );
    expect(html).toContain('data-export-entry="true"');
    expect(html).toContain("disabled");
    expect(html).toContain("有 1 个附件缺失或损坏");
  });

  it("资格与文件选择/Monaco/diff 无关：未选文件（selectedPath=null）不影响面板渲染", () => {
    // 资格判据只由连接层的 inspect/unavailableCount 决定；展示层不接收任何 Monaco/diff 信息
    const html = markup(createElement(WorkspaceExportPanel, base));
    expect(html).toContain("导出选定检查点");
    expect(html).not.toContain("diff");
  });

  it("任务 6.4：入口/确认卡/反馈全部流内渲染（无 fixed/overlay），不遮挡正文与文件选择器", () => {
    const expandedHtml = markup(
      createElement(WorkspaceExportPanel, {
        ...base,
        expanded: true,
        feedback: EXPORTED,
      }),
    );
    // data-export-panel 的容器到反馈区之间不允许出现覆盖定位（流内随文档换行，
    // 窄窗/200% 缩放下自然折行，不产生遮挡正文的浮层）
    const panelStart = expandedHtml.indexOf('data-export-panel="run_x"');
    expect(panelStart).toBeGreaterThan(0);
    const panelHtml = expandedHtml.slice(panelStart);
    expect(panelHtml).not.toMatch(/class="[^"]*\b(fixed|absolute|sticky)\b/);
    // 键盘可达：入口有可见焦点态（focus-visible ring）
    expect(panelHtml).toContain("focus-visible:ring");
  });
});

describe("确认卡（任务 6.1）", () => {
  it("未展开：只有入口按钮，没有确认卡", () => {
    const html = markup(createElement(WorkspaceExportPanel, base));
    expect(html).not.toContain('data-export-confirm="true"');
  });

  it("展开：写明检查点、空目录要求、files/ 布局与未保留状态，提供提交与取消", () => {
    const html = markup(createElement(WorkspaceExportPanel, { ...base, expanded: true }));
    expect(html).toContain("本 run 第 1 轮结束");
    expect(html).toContain("空目录");
    expect(html).toContain("files/");
    expect(html).toContain("rebaseagent-export.json");
    expect(html).toContain("changes.patch");
    expect(html).toContain("未保留");
    expect(html).toContain('data-export-confirm="true"');
    expect(html).toContain("选择目标目录并导出");
    expect(html).toContain("取消（不写入）");
    // 确认卡不接受任何物理路径输入（目标只能来自 main 对话框）
    expect(html).not.toMatch(/name="(targetDir|dataDir|blobRoot)"/);
  });
});

describe("反馈四态（任务 6.2/6.3）", () => {
  it("成功：目标目录、files/ 位置、数量/字节、补丁覆盖与排除逐路径、未保留与诚实边界", () => {
    const html = markup(createElement(WorkspaceExportPanel, { ...base, feedback: EXPORTED }));
    expect(html).toContain('data-export-feedback="exported"');
    expect(html).toContain("D:/out/target");
    expect(html).toContain("2 个文件");
    expect(html).toContain("1536");
    expect(html).toContain("changes.patch");
    expect(html).toContain("+ a.txt");
    expect(html).toContain("bin.dat：未覆盖（binary）");
    expect(html).toContain("未保留（原状态未知）");
    expect(html).toContain("不表示项目可构建、测试通过或已应用");
  });

  it("补丁 not_available：显示原因与逐路径排除，不被描述为文件导出失败", () => {
    const feedback: WorkspaceExportFeedback = {
      ...EXPORTED,
      result: {
        ...EXPORTED.result,
        patch: {
          status: "not_available",
          covered: [],
          excluded: [
            { path: "a.txt", reason: "baseline_missing" },
            { path: "bin.dat", reason: "binary" },
          ],
          reason: "补丁基线附件不可用，整份补丁撤销",
        },
      },
    };
    const html = markup(createElement(WorkspaceExportPanel, { ...base, feedback }));
    expect(html).toContain('data-export-feedback="exported"');
    expect(html).toContain("补丁不可用：补丁基线附件不可用，整份补丁撤销");
    expect(html).toContain("文件导出不受影响");
    expect(html).toContain("a.txt：baseline_missing");
    // 文件导出成功的部分仍然显示
    expect(html).toContain("2 个文件");
  });

  it("no_text_changes：明说无文本差异、未生成补丁", () => {
    const feedback: WorkspaceExportFeedback = {
      ...EXPORTED,
      result: {
        ...EXPORTED.result,
        patch: { status: "no_text_changes", covered: [], excluded: [] },
      },
    };
    const html = markup(createElement(WorkspaceExportPanel, { ...base, feedback }));
    expect(html).toContain("no_text_changes");
    expect(html).toContain("未生成 changes.patch");
  });

  it("失败：稳定码 + 原因 + 残留相对路径警示；说明阅读状态未被改写", () => {
    const feedback: WorkspaceExportFeedback = {
      kind: "failed",
      runId: "run_x",
      stepSpanId: null,
      generation: 3,
      code: "target_invalid",
      reason: "目标目录非空（含 2 项），不覆盖既有内容",
      retained: ["files/a.txt", "rebaseagent-export.json"],
    };
    const html = markup(createElement(WorkspaceExportPanel, { ...base, feedback }));
    expect(html).toContain('data-export-feedback="failed"');
    expect(html).toContain("target_invalid");
    expect(html).toContain("目标目录非空");
    expect(html).toContain("files/a.txt");
    expect(html).toContain("rebaseagent-export.json");
    expect(html).toContain("请勿直接使用");
    expect(html).toContain("当前 run/文件选择/草稿未被改写");
  });

  it("取消：明说零写入", () => {
    const feedback: WorkspaceExportFeedback = {
      kind: "canceled",
      runId: "run_x",
      stepSpanId: null,
      generation: 2,
    };
    const html = markup(createElement(WorkspaceExportPanel, { ...base, feedback }));
    expect(html).toContain('data-export-feedback="canceled"');
    expect(html).toContain("没有写入任何内容");
  });

  it("在飞：说明切页不中止、重载后以目标清单为准", () => {
    const feedback: WorkspaceExportFeedback = {
      kind: "in-flight",
      runId: "run_x",
      stepSpanId: null,
      generation: 1,
    };
    const html = markup(createElement(WorkspaceExportPanel, { ...base, feedback }));
    expect(html).toContain('data-export-feedback="in-flight"');
    expect(html).toContain("不会中止导出");
    expect(html).toContain("rebaseagent-export.json");
  });

  it("无反馈：不渲染反馈区（重载后状态为空 = 结果未知，不自动重发）", () => {
    const html = markup(createElement(WorkspaceExportPanel, base));
    expect(html).not.toContain("data-export-feedback");
  });
});

describe("文件页集成（WorkspaceFileViewBody 的 exportPanel 接线）", () => {
  /** 最小 inspect（全部附件可用） */
  function inspect(unavailableCount = 0) {
    return {
      runId: "run_x",
      stepSpanId: "s_02",
      snapshotId: "a".repeat(64),
      ownerRunId: "run_x",
      localIteration: 1,
      profile: "file-tools-v1",
      worldId: "run_x",
      origin: { kind: "import" as const },
      files: [
        {
          path: "a.txt",
          bytes: 10,
          sha256: "c".repeat(64),
          change: "modified" as const,
          availability: "ok" as const,
          unavailableReason: null,
        },
      ],
      fileCount: 1,
      totalBytes: 10,
      unavailableCount,
      initialSnapshotId: "d".repeat(64),
    };
  }

  const run = {
    meta: { id: "run_x", workspace: { profile: "file-tools-v1", world_id: "run_x" } },
    spans: [{ id: "s_2", parent: null, kind: "agent.step", n: 1 }],
    events: [],
    status: "completed",
    chain: [],
    leafSpanIds: ["s_2"],
  } as unknown as Parameters<typeof WorkspaceFileViewBody>[0]["run"];

  it("面板渲染在检查点选择区下方，反馈按提交目标显示", () => {
    const html = markup(
      createElement(WorkspaceFileViewBody, {
        run,
        options: [{ stepSpanId: "s_02", label: "第 1 轮结束" }],
        selection: { stepSpanId: "s_02" },
        onSelect: () => undefined,
        inspect: inspect(),
        inspectError: null,
        loadingList: false,
        selectedPath: null,
        onSelectPath: () => undefined,
        current: null,
        currentKey: null,
        currentLabel: "第 1 轮结束",
        loadingContent: false,
        contentError: null,
        exportPanel: {
          eligible: true,
          ineligibleReason: null,
          feedback: EXPORTED,
          expanded: false,
          onToggleExpanded: () => undefined,
          onConfirm: () => undefined,
        },
      }),
    );
    expect(html).toContain('data-export-panel="run_x"');
    expect(html).toContain("导出选定检查点");
    expect(html).toContain('data-export-feedback="exported"');
  });

  it("不传 exportPanel：面板完全不渲染（旧场景零改动）", () => {
    const html = markup(
      createElement(WorkspaceFileViewBody, {
        run,
        options: [{ stepSpanId: "s_02", label: "第 1 轮结束" }],
        selection: { stepSpanId: "s_02" },
        onSelect: () => undefined,
        inspect: inspect(),
        inspectError: null,
        loadingList: false,
        selectedPath: null,
        onSelectPath: () => undefined,
        current: null,
        currentKey: null,
        currentLabel: "第 1 轮结束",
        loadingContent: false,
        contentError: null,
      }),
    );
    expect(html).not.toContain("data-export-panel");
  });
});
