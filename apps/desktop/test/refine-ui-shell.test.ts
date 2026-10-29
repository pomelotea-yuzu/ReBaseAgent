import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ShortIdLabel } from "../src/renderer/src/components/ShortIdLabel";
import { auditForbiddenTokens } from "../src/renderer/src/lib/overview-view";
import { renderWithLocale } from "./i18n/render-with-locale";

/**
 * refine-ui-for-community-release 任务 2.1：全局入口与视图名称整理。
 *
 * 判据来源：desktop-ui delta（MODIFIED「界面提供分支树与轨迹两种视图」）：
 *   - header 切换入口面向用户分别标为「分支关系」和「运行记录」；
 *   - 运行内步骤目录使用「步骤目录」等可辨层级名称，不与应用级视图统一标为「轨迹」；
 *   - 录制接入进入独立录制工作区（规范文字对齐既有实现，见 evidence-index A2 节）。
 *
 * 为什么是源码级断言而不是组件渲染：`GlobalBar` 直接读 `useAppStore`，本包无 jsdom、
 * renderToStaticMarkup 拿不到 store 状态（与 global-bar-recovery-wiring.test.ts 同口径）。
 * 禁用型断言一律走 auditForbiddenTokens（剥注释后扫，不咬自己的文档注释）。
 */

const read = (rel: string): string => readFileSync(resolve(import.meta.dirname, rel), "utf8");

const bar = read("../src/renderer/src/components/GlobalBar.tsx");

describe("视图切换名称：运行记录／分支关系（MODIFIED1）", () => {
  it("两个切换入口面向用户标为「运行记录」「分支关系」（文案取自 i18n 资源）", () => {
    expect(bar).toContain('translator.t("common.viewRuns")');
    expect(bar).toContain('translator.t("common.viewTree")');
    // 独立期望：资源里的中文值正是这两个名称（不以 t(key) 自证）
    const zh = readFileSync(
      resolve(import.meta.dirname, "../../../packages/i18n/src/resources/zh-CN.ts"),
      "utf8",
    );
    expect(zh).toContain('viewRuns: "运行记录"');
    expect(zh).toContain('viewTree: "分支关系"');
  });

  it("应用级视图不再标为「轨迹」（禁用型判据走审计函数，剥注释）", () => {
    expect(auditForbiddenTokens(bar, ['label: "轨迹"', 'label: "分支树"'])).toEqual([]);
    expect(bar).toContain("data-view-option={key}");
  });

  it("标签经 options.map 渲染到按钮（不是只写在数组里）", () => {
    // options 数组是唯一来源：按钮文案由 map 消费，改标签只改一处
    expect(bar).toContain("options.map(({ key, label, icon: Icon, hint })");
    expect(bar).toContain('aria-pressed={active ? "true" : undefined}');
  });
});

describe("步骤目录名称（MODIFIED1）：可辨层级名称已对齐", () => {
  const tree = read("../src/renderer/src/components/SpanTree.tsx");

  it("SpanTree 面向用户使用「步骤目录」（收起/重开入口与宽度标签同源）", () => {
    expect(tree).toContain('"detail.collapseSteps"');
    expect(tree).toContain('"detail.backToCurrentCall"');
    expect(tree).toContain('"detail.stepsWidth"');
    expect(tree).toContain('"detail.collapseStepsTitle"');
    // 独立期望：资源里的中文值就是这些名称（不以 t(key) 自证）
    const zh = readFileSync(
      resolve(import.meta.dirname, "../../../packages/i18n/src/resources/zh-CN.ts"),
      "utf8",
    );
    expect(zh).toContain('collapseSteps: "收起步骤目录"');
    expect(zh).toContain('stepsWidth: "步骤目录宽度"');
    expect(zh).toContain("重新打开步骤目录");
  });
});

describe("录制接入进入既有独立录制工作区（R07/N16 的规范对齐锚点）", () => {
  it("GlobalBar 录制按钮走 onOpenRecording 专用通道（不经过设置）", () => {
    // App.tsx 的 openRecording → openRecordingWorkspace 一跳由
    // settings-roundtrip-invalidate.test.ts 钉住；这里钉 GlobalBar 这一跳。
    expect(bar).toContain("onOpenRecording: () => void");
    expect(bar).toContain("const openRecording = (): void => {");
    expect(bar).toContain("onClick={openRecording}");
  });

  it("按钮可见名称与提示指认独立录制工作区（面向用户文字与实现一致）", () => {
    expect(bar).toContain('translator.t("common.connectRecording")');
    expect(bar).toContain('translator.t("common.connectRecordingHint")');
    // 稳定钩子：按钮身份不靠中文文案定位
    expect(bar).toContain("data-shell-recording");
  });
});

// —— 2.2：对象头身份与完整 ID 可复制（delta ADDED「当前任务身份与返回目的地明确」）——

// RunWorkspace 里的 store 薄壳 import 时会触到 window.api ⇒ 桩先就位再动态 import
// （与 notice-disclosure.test.tsx 同法）。
(globalThis as Record<string, unknown>).window = { api: {} };
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RunHeaderView } = await import("../src/renderer/src/components/RunWorkspace");
const { AuxWorkspaceFrame } = await import("../src/renderer/src/components/AuxWorkspaceFrame");

const renderHeader = (props: {
  selectedRunId: string | null;
  shortId?: string | null;
}): string =>
  renderWithLocale("zh-CN", createElement(RunHeaderView, { detail: null, runs: [], ...props }));

describe("全局栏不再冒充当前对象（2.2 移除 detail 身份展示）", () => {
  it("GlobalBar 不订阅 detail、不渲染 meta.id；对象身份归各工作区对象头", () => {
    expect(auditForbiddenTokens(bar, ["s.detail", "meta.id"])).toEqual([]);
    // UI 整理 3.3：草稿／操作入口统一迁往底部会话活动条（App 外壳），全局栏不再并存
    expect(auditForbiddenTokens(bar, ["<OperationsEntry", "<SessionDraftsEntry"])).toEqual([]);
    expect(read("../src/renderer/src/App.tsx")).toContain("<SessionActivity />");
  });
});

describe("单运行对象头：完整 ID 可访问并复制（N04）", () => {
  it("短 ID 展示 + 复制按钮的可访问名与复制目标都是完整原始 ID", () => {
    const html = renderHeader({ selectedRunId: "r_full000123", shortId: "r_f1" });
    expect(html).toContain("复制完整 运行 ID r_full000123");
    expect(html).toContain('title="复制完整 ID：r_full000123"');
    expect(html).toContain("r_f1");
  });

  it("英文独立期望：可访问名与标题为英文，复制目标仍是完整 ID", () => {
    const html = renderWithLocale(
      "en-US",
      createElement(ShortIdLabel, {
        id: "r_full000123",
        shortId: "r_f1",
        label: "Run ID",
      }),
    );
    expect(html).toContain("Copy full Run ID r_full000123");
    expect(html).toContain('title="Copy full ID: r_full000123"');
    expect(html).toContain("r_full000123");
  });

  it("缺省 shortId ⇒ 回退显示完整 ID，复制目标不变", () => {
    const html = renderHeader({ selectedRunId: "r_full000123" });
    expect(html).toContain("复制完整 运行 ID r_full000123");
    expect(html).toContain("r_full000123");
  });

  it("未选择运行 ⇒ 占位 —，不渲染复制按钮", () => {
    const html = renderHeader({ selectedRunId: null });
    expect(html).not.toContain("复制完整");
  });
});

describe("辅助工作区对象头：run ID 可复制（N04）", () => {
  it("AuxWorkspaceFrame 的 targetLine 接受 ReactNode（string 承载不了复制按钮）", () => {
    const html = renderWithLocale(
      "zh-CN",
      createElement(
        AuxWorkspaceFrame,
        {
          title: "模型实验",
          description: "说明",
          compactDescription: "摘要",
          targetLine: createElement(ShortIdLabel, {
            id: "r_parent000",
            shortId: "r_p1",
            label: "父本运行 ID",
          }),
          returnAvailable: false,
          onReturn: () => {},
        },
        createElement("div", null, "正文"),
      ),
    );
    expect(html).toContain("复制完整 父本运行 ID r_parent000");
  });

  it("实验与编辑容器的 targetLine 用 ShortIdLabel 承载目标 run ID（源码契约）", () => {
    const exp = read("../src/renderer/src/components/ExperimentWorkspace.tsx");
    const msg = read("../src/renderer/src/components/MessagesWorkspace.tsx");
    expect(exp).toContain('label="父本运行 ID"');
    expect(exp).toContain("id={target.runId}");
    // 2.8：messages 来源标签改由 fork 资源投影
    expect(msg).toContain('label={translator.t("fork.messagesSourceRunIdLabel")}');
    expect(msg).toContain("id={target.runId}");
  });

  it("AuxWorkspaceFrame 类型放宽为 ReactNode | null", () => {
    const src = read("../src/renderer/src/components/AuxWorkspaceFrame.tsx");
    expect(src).toContain("readonly targetLine: ReactNode | null;");
  });
});

// —— 2.4：运行列表任务优先、次级指标按需展开（delta ADDED「运行导航突出任务且详细事实可访问」）——

const runList = read("../src/renderer/src/components/RunList.tsx");

describe("运行列表：默认身份与结局清楚，次级指标按需展开（N15）", () => {
  it("列表级「指标」开关存在且用 aria-pressed 表达当前态", () => {
    expect(runList).toContain("const [metricsOpen, setMetricsOpen] = useState(false)");
    expect(runList).toContain("aria-pressed={metricsOpen}");
    expect(runList).toContain('"run.metricsToggleHint"');
  });

  it("次级指标块由 metricsOpen 条件承载，字段与未知语义一个不删", () => {
    expect(runList).toContain('data-run-metrics="true"');
    // 次级：模型 / 步数 / 工具数 / tokens（含失败占位说明）/ 缓存命中 / 时长
    for (const token of [
      "run.steps",
      "run.toolCalls",
      "run.tokensIn + run.tokensOut",
      '"run.zeroUsageSuffix"',
      "run.cacheHit === null ? null",
      "run.durationMs",
    ]) {
      expect(runList, token).toContain(token);
    }
  });

  it("默认可见区：任务、状态、短 ID、时间、「N 出错」在次级块之外（结局不过折叠）", () => {
    // 时间与出错标必须在 metricsOpen 条件**之前**（默认行），模型在条件内
    const metricsAt = runList.indexOf('data-run-metrics="true"');
    expect(metricsAt).toBeGreaterThan(-1);
    const timeAt = runList.indexOf("{formatTime(run.created_at)}</span>");
    const errorsAt = runList.indexOf("{run.toolErrors > 0");
    expect(timeAt).toBeGreaterThan(-1);
    expect(errorsAt).toBeGreaterThan(-1);
    expect(errorsAt).toBeLessThan(metricsAt);
    expect(timeAt).toBeLessThan(metricsAt);
    expect(runList).toContain('run.source === "proxy"');
  });

  it("展开态零逐条扫描：指标块只消费已在场的 RunSummary 字段，无新增读取", () => {
    // 判据：RunList 不得为展开新增 IPC/读取调用（既有 loadRuns 之外）
    expect(auditForbiddenTokens(runList, ["getRun(", "runs:read", "loadRunDetails"])).toEqual([]);
  });
});

// —— 3.1：任务级临时导航适配（delta ADDED「任务布局覆盖不改写手动偏好」）——

describe("任务级导航适配接线（App 外壳）", () => {
  const app = read("../src/renderer/src/App.tsx");

  it("实验 / messages 传入任务适配（创建页保持导航，U5 4.1 既有口径）", () => {
    expect(app).toContain('taskAdaptNav: view === "experiment" || view === "messages"');
  });

  it("比较页恢复入口接线：decideCompareNavVisible 消费 navOpened", () => {
    expect(app).toContain("navOpened: layout.navOpened");
  });
});

// —— 3.3/3.4：会话活动入口统一组织 + clean/dirty 分组 ——

describe("会话活动入口（delta ADDED「会话活动区区分修改与清洁编辑会话」）", () => {
  const activity = read("../src/renderer/src/components/SessionActivity.tsx");

  it("一个入口三组计数：修改（含录制未应用）／操作／结果，不新增第四个并存入口", () => {
    expect(activity).toContain('translator.t("common.sessionActivity")');
    expect(activity).toContain("sessionDirtyCountOf(drafts, recordingDraft)");
    expect(activity).toContain('translator.t("common.draftCount", { count: dirtyCount })');
    expect(activity).toContain('translator.t("common.operationCount", { count: rows.length })');
    expect(activity).toContain(
      'translator.t("common.resultCount", { count: notices.unreadCount })',
    );
    // 事实来源唯一：草稿 deriveDraftList、操作 deriveOperationRows、通知 deriveResultNotices
    for (const fn of ["deriveDraftList(drafts)", "deriveOperationRows(", "deriveResultNotices("]) {
      expect(activity, fn).toContain(fn);
    }
  });

  it("组内分组：dirty 在前、clean 单独分组并标为未修改（N09）", () => {
    expect(activity).toContain("draftItems.filter((item) => item.dirty)");
    expect(activity).toContain('translator.t("common.cleanSessions"');
    // DraftListPanel 对 clean 条目给「未修改」标记（不冒充修改、不加退出保护）
    const panel = read("../src/renderer/src/components/DraftListPanel.tsx");
    expect(panel).toContain('data-draft-clean="true"');
    expect(panel).toContain("未修改");
  });

  it("录制未应用修改纳入修改提示并有可达动作（去录制）", () => {
    expect(activity).toContain("isRecordingDraftDirty(recordingDraft)");
    expect(activity).toContain('translator.t("common.recordingDirty")');
    expect(activity).toContain("openRecordingWorkspace()");
  });

  it("面板语义沿用既有契约：打开即已看、polite live 不在此面板、Esc/✕ 同一关闭", () => {
    expect(activity).toContain("markNoticesSeen(notices.notices.map((one) => one.key))");
    expect(activity).toContain("useEscapeClose(open, closePanel)");
    // polite live 区域仍在 App 外壳（不在本面板内）
    expect(activity).not.toContain("aria-live");
    const app = read("../src/renderer/src/App.tsx");
    expect(app).toContain("<ResultLiveRegion />");
    expect(app).toContain("<SessionActivity />");
  });
});
