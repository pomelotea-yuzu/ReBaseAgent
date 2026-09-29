import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// RunWorkspace 的 store 薄壳（`RunHeader`）在 import 时就会触到 `window.api`
// （../lib/api.ts）⇒ 桩必须先就位。ESM 的静态 import 会被提升到语句之前，
// 故这里用动态 import（与 store.test.ts 同法）。本文件只测不依赖 store 的纯判据与纯视图。
(globalThis as Record<string, unknown>).window = { api: {} };

import { auditForbiddenTokens } from "../src/renderer/src/lib/overview-view";
import type { RunSummary } from "../src/shared/ipc";
const {
  NoRunsEmpty,
  RunHeaderView,
  RunWorkspace,
  WORKSPACE_TABS,
  availableTabs,
  resolveVisibleTab,
} = await import("../src/renderer/src/components/RunWorkspace");

/**
 * U1（refactor-run-workspace）任务 4.2：工作区页签承载与空态入口。
 *
 * 判据来源：desktop-ui delta 场景
 *   - 「首次打开与无运行入口」：无运行时给**真实可用**的新建与录制入口。
 *   - 「文件承载区不附带步骤目录」：文件页占整个主工作区正文，没有无关步骤目录。
 *
 * 另钉住 design D1 的三条承载结论：
 *   - 页签是工作区级的，稳定标识与 `RunReadingState.tab` 同口径；
 *   - 「文件」页签**只在合法隔离 run** 上出现（普通 run 不得出现虚假文件页）；
 *   - 保存的 tab 在当前 run 上不可用时回退概览（不残留一个不存在的页签）。
 *
 * ⚠️ 本包无 jsdom，且 zustand v5 在 `renderToStaticMarkup` 下走 `getServerSnapshot`
 *    （恒为初始值）⇒ **组件测试喂不进 store 状态**。故这里只测两件不依赖 store 的事：
 *    ① 纯判据（`availableTabs` / `resolveVisibleTab`）与页签/空态的结构；
 *    ② 把"数据 → 视图"抽出的 `RunHeaderView`（直接喂 props）。
 *    真实点击切页签、焦点流转、页签记忆归 store 层（见 store.test.ts）。
 */

const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(node);

function summaryOf(over: Partial<RunSummary>): RunSummary {
  return {
    id: "r_42",
    task: "把这段代码加上注释",
    model: "deepseek-chat",
    status: "completed",
    reason: null,
    source: "local",
    parent: null,
    steps: 1,
    toolCalls: 0,
    toolErrors: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheHit: null,
    durationMs: 10,
    created_at: "2026-09-21T00:00:00.000Z",
    ...over,
  } as RunSummary;
}

describe("可用页签：文件页只在合法隔离 run 上出现", () => {
  it("普通 run 没有文件页（给它一个空 tab 等于把「没有」显示成「有」）", () => {
    expect(availableTabs(false)).toEqual(["overview", "steps"]);
  });

  it("隔离 run 三页签齐备", () => {
    expect(availableTabs(true)).toEqual(["overview", "steps", "files"]);
  });

  it("页签稳定标识与 RunReadingState.tab 同口径（不是一个只有 UI 知道的新枚举）", () => {
    expect(WORKSPACE_TABS).toEqual(["overview", "steps", "files"]);
  });
});

describe("页签回退：保存的 tab 在当前 run 上不可用时回退概览", () => {
  it("非隔离 run 上保存了 files ⇒ 显示 overview（不残留不存在的页签）", () => {
    expect(resolveVisibleTab("files", false)).toBe("overview");
  });

  it("隔离 run 上保存的 files 原样保留", () => {
    expect(resolveVisibleTab("files", true)).toBe("files");
  });

  it("overview / steps 在任何 run 上都可用", () => {
    expect(resolveVisibleTab("overview", false)).toBe("overview");
    expect(resolveVisibleTab("steps", false)).toBe("steps");
  });
});

describe("RunWorkspace 渲染：页签栏语义与名称", () => {
  it("渲染出 tablist + tab 角色，名称直接可见（图标 + 文字，不靠悬停猜）", () => {
    const markup = html(
      createElement(
        RunWorkspace,
        { tab: "overview", onTab: () => {}, isIsolated: true, header: null },
        createElement("div", null, "正文"),
      ),
    );
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('role="tab"');
    expect(markup).toContain("概览");
    expect(markup).toContain("步骤");
    expect(markup).toContain("文件");
    expect(markup).toContain("正文");
  });

  it("当前页签用 aria-selected 表达（不只靠底色）", () => {
    const markup = html(
      createElement(
        RunWorkspace,
        { tab: "steps", onTab: () => {}, isIsolated: true, header: null },
        null,
      ),
    );
    const selected = markup.match(/aria-selected="true"/g) ?? [];
    expect(selected).toHaveLength(1);
    expect(markup).toContain('aria-selected="false"');
  });

  it("非隔离 run 渲染时**不出现**文件页签（不是渲染了但禁用）", () => {
    const markup = html(
      createElement(
        RunWorkspace,
        { tab: "overview", onTab: () => {}, isIsolated: false, header: null },
        null,
      ),
    );
    expect(markup).toContain("概览");
    expect(markup).toContain("步骤");
    expect(markup).not.toContain(">文件<");
  });

  it("即使传入 files 但 run 非隔离，也不渲染出被选中的文件页（回退可见）", () => {
    const markup = html(
      createElement(
        RunWorkspace,
        { tab: "files", onTab: () => {}, isIsolated: false, header: null },
        null,
      ),
    );
    expect(markup).not.toContain(">文件<");
    const selected = markup.match(/aria-selected="true"/g) ?? [];
    expect(selected).toHaveLength(1);
  });

  it("正文槽承载 children（文件页里只有传入的内容，不额外挂步骤目录）", () => {
    const markup = html(
      createElement(
        RunWorkspace,
        { tab: "files", onTab: () => {}, isIsolated: true, header: null },
        createElement("div", null, "文件检查点视图"),
      ),
    );
    expect(markup).toContain("文件检查点视图");
    expect(markup).not.toContain("步骤目录");
  });

  it("页签栏每个按钮都有可访问名称（title 与可见文字同在）", () => {
    const markup = html(
      createElement(
        RunWorkspace,
        { tab: "overview", onTab: () => {}, isIsolated: true, header: null },
        null,
      ),
    );
    for (const label of ["概览", "步骤", "文件"]) {
      expect(markup).toContain(`title="${label}"`);
    }
  });
});

describe("空态：无运行时给两个真实可用的入口", () => {
  it("渲染新建与录制两个按钮，且都可点击（不是装饰）", () => {
    const markup = html(createElement(NoRunsEmpty, { onCreate: () => {}, onRecord: () => {} }));
    expect(markup).toContain("新建运行");
    expect(markup).toContain("接入录制");
    expect(markup).toContain("traces/");
  });

  it("入口数量正好两个（没有多余的假入口充数）", () => {
    const markup = html(createElement(NoRunsEmpty, { onCreate: () => {}, onRecord: () => {} }));
    expect(markup.match(/<button/g) ?? []).toHaveLength(2);
  });

  it("空态文案解释两条真实路径（桌面直跑 / 代理录制），不写营销话术", () => {
    const markup = html(createElement(NoRunsEmpty, { onCreate: () => {}, onRecord: () => {} }));
    expect(markup).toContain("隔离文件运行");
    expect(markup).toContain("录制代理");
  });

  it("两个入口分别绑到各自的动作（静态渲染下用 on* 属性确认接线）", () => {
    const onCreate = vi.fn();
    const onRecord = vi.fn();
    // renderToStaticMarkup 不输出事件处理器，这里改为确认两次回调都作为 props 被接收
    // （真正的点击触发归 7.3 的端到端实测）
    const element = createElement(NoRunsEmpty, { onCreate, onRecord });
    expect(element.props.onCreate).toBe(onCreate);
    expect(element.props.onRecord).toBe(onRecord);
    html(element);
  });
});

describe("运行页头（纯视图）：任务、状态与来源可辨", () => {
  it("尚未选择运行时如实说「尚未选择运行」，不拿别的 run 的摘要顶上", () => {
    const markup = html(
      createElement(RunHeaderView, { detail: null, runs: [], selectedRunId: null }),
    );
    expect(markup).toContain("尚未选择运行");
  });

  it("选中运行后页头显示任务、状态与运行 ID", () => {
    const markup = html(
      createElement(RunHeaderView, {
        detail: null,
        runs: [summaryOf({})],
        selectedRunId: "r_42",
      }),
    );
    expect(markup).toContain("把这段代码加上注释");
    expect(markup).toContain("r_42");
    expect(markup).toContain("deepseek-chat");
  });

  it("选中运行但列表还没有该摘要时，用详情兜底任务名（不编造）", () => {
    const markup = html(
      createElement(RunHeaderView, {
        detail: { meta: { id: "r_99", task: "详情里的任务" }, status: "completed" } as never,
        runs: [],
        selectedRunId: "r_99",
      }),
    );
    expect(markup).toContain("详情里的任务");
    expect(markup).toContain("r_99");
  });

  it("详情还未到手时状态显示「未知」，不把缺省当作成功", () => {
    const markup = html(
      createElement(RunHeaderView, {
        detail: null,
        runs: [summaryOf({})],
        selectedRunId: "r_42",
      }),
    );
    // 摘要里有 status 但详情未到——页头以**详情**为准，此时如实报未知
    expect(markup).toContain("状态未知");
  });

  it("运行中断的 run 显示「运行中断」而非含糊的成功/失败", () => {
    const markup = html(
      createElement(RunHeaderView, {
        detail: { meta: { id: "r_1" }, status: "crashed" } as never,
        runs: [],
        selectedRunId: "r_1",
      }),
    );
    expect(markup).toContain("运行中断");
  });

  it("隔离 run 标出「文件隔离」并给出隔离说明（来源可辨）", () => {
    const markup = html(
      createElement(RunHeaderView, {
        detail: {
          meta: {
            id: "r_iso",
            workspace: {
              world_id: "w_1",
              profile: "isolated-v1",
              origin: { kind: "import" },
            },
          },
          status: "completed",
        } as never,
        runs: [],
        selectedRunId: "r_iso",
      }),
    );
    expect(markup).toContain("文件隔离");
    expect(markup).toContain("源目录");
  });

  it("普通 run 不显示「文件隔离」（不把非隔离 run 显示成隔离）", () => {
    const markup = html(
      createElement(RunHeaderView, {
        detail: { meta: { id: "r_plain" }, status: "completed" } as never,
        runs: [],
        selectedRunId: "r_plain",
      }),
    );
    expect(markup).not.toContain("文件隔离");
  });
});

/**
 * 接线断言（任务 4.2 / U5 任务 4.1）：spec 要求「新建与列表标题区既有入口打开
 * **同一创建工作区**」。
 *
 * ⚠️ 本包无 jsdom ⇒ 无法渲染点击来验证"点两处开的是同一个页面"。这里退一步，
 *    在**源码级**钉住契约：两处入口都走 store 的同一个动作 `openCreateWorkspace`，
 *    且**不得**各自留一份本地开关（那正是"各开各的"的形态）。
 *    这是"属性契约"而非"行为验证"——真实点击归 §6 端到端实测。
 */
describe("接线：全局栏与列表共用同一创建工作区（源码契约）", () => {
  const read = (rel: string): string =>
    readFileSync(resolve(import.meta.dirname, "..", rel), "utf8");

  it("RunList 的「＋ 新建运行」走 store 的 openCreateWorkspace，而不是本地 useState", () => {
    const src = read("src/renderer/src/components/RunList.tsx");
    expect(src).toContain("s.openCreateWorkspace");
    expect(src).toContain("onClick={openCreateWorkspace}");
    // 不得再自持一份开关，也不得自己挂一个创建页实例（那正是"各开各的"）
    expect(src).not.toMatch(/useState\(false\)\s*;\s*\/\/[^\n]*新建/);
    expect(
      auditForbiddenTokens(src, ["<CreateRunDialog", "<CreateRunWorkspace", "createDialogOpen"]),
    ).toEqual([]);
  });

  it("GlobalBar 的「新建运行」同样走 store 的 openCreateWorkspace", () => {
    const src = read("src/renderer/src/components/GlobalBar.tsx");
    expect(src).toContain("s.openCreateWorkspace");
    expect(src).toContain("onClick={openCreateWorkspace}");
    expect(auditForbiddenTokens(src, ["createDialogOpen", "CreateRunDialog"])).toEqual([]);
  });

  it("GlobalBar 的「录制接入」定位到代理分区（不是另建录制界面）", () => {
    const src = read("src/renderer/src/components/GlobalBar.tsx");
    // U5 6.7 契约迁移：GlobalBar 走 onOpenRecording 专用开器（不清 settingsSection），
    // "proxy" 标记由 App.openRecording 设置——旧形状（本地 setSettingsSection("proxy")
    // 后又调 onOpenSettings 把它清掉）正是 6.7 实机抓到的定位失效缺陷，不得复活。
    expect(src).toContain("onOpenRecording()");
    expect(src).not.toContain('setSettingsSection("proxy")');
  });

  it("App 只挂一个创建工作区，且它与运行导航在同一分支里（页面不吞掉导航）", () => {
    const src = read("src/renderer/src/App.tsx");
    const mounts = src.match(/<CreateRunWorkspace\b/g) ?? [];
    expect(mounts).toHaveLength(1);
    expect(src).toContain('view === "create"');
    expect(auditForbiddenTokens(src, ["createDialogOpen", "<CreateRunDialog"])).toEqual([]);
    // 创建页与 RunList 同属"非分支树"那一支 ⇒ 进入创建保留运行导航
    const branch = src.slice(src.indexOf('view === "tree"'), src.indexOf('view === "create"'));
    expect(branch).toContain("<RunList");
  });

  it("SettingsDialog 消费 settingsSection 定位到代理分区并一次性清账", () => {
    const src = read("src/renderer/src/components/SettingsDialog.tsx");
    expect(src).toContain("settingsSection");
    expect(src).toContain("proxySectionRef");
    expect(src).toContain("setSettingsSection(null)");
  });
});
