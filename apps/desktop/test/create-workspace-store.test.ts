import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { ok } from "@shared/ipc";
import type { Envelope, ListRunsData, RunDetail, WindowApi } from "@shared/ipc";
import { beforeEach, describe, expect, it } from "vitest";
import * as draftLib from "../src/renderer/src/lib/debugging-drafts";
import { initialSession } from "../src/renderer/src/lib/operation-session";
import type { FileReadingState, RunReadingState } from "../src/renderer/src/lib/reading-state";
import { emptyResultReadStore } from "../src/renderer/src/lib/result-verification";
import { deriveRunSummary } from "../src/shared/derive";
import { installOperationChannels } from "./helpers/operation-channels";

/**
 * U5（unify-run-execution-workflow）任务 4.1 的 **store 接线**：新建迁入主工作区。
 *
 * 判据来源：design D1 + delta「桌面端提供原生 run 创建入口」「运行工作区按阅读任务组织」
 * 「创建草稿和实验臂遵守同一保留规则」。验收场景（delta 逐字标题）：
 * - 「创建工作区任务优先且可返回来源」——进入取新来源、页内重复点击与设置往返沿用、
 *   返回恢复有效位置、重载后失效并回退；
 * - 「创建关闭配置再新建仍有任务」——来源与草稿互不决定；
 * - 「首次打开与无运行入口」——首次读取迟到不覆盖已进入的创建页；
 * - 「旧创建设置及执行入口保持可达」——两个入口都走同一个动作，创建页不吞掉运行导航。
 *
 * ⚠️ 复位表纪律（U5 3.1 的教训）：本文件共享同一个 `useAppStore` 单例，
 * 新会话字段（`view` / `createReturnLocation`）必须逐条复位，否则上一条用例的现场
 * 会渗进下一条，表现为"来源莫名还在 / 莫名丢了"这种根本不存在的缺陷。
 */

const SOURCE = "run_ws_source";
const ELSEWHERE = "run_ws_elsewhere";

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures/u1-fixtures");
const recordOf = (name: string): RunRecord => readRun(resolve(FIXTURE_DIR, `${name}.jsonl`));

function detailOf(name: string, id: string): RunDetail {
  const record = recordOf(name);
  const meta = record.meta.id === id ? record.meta : { ...record.meta, id };
  return {
    meta,
    spans: record.spans,
    events: record.events,
    status: record.status,
    chain: [{ meta, fork: record.meta.fork }],
    leafSpanIds: record.spans.map((span) => span.id),
    completeness: "complete",
    spanScope: "own",
    lineage: { status: "complete" },
  };
}

/** 阅读状态 / 文件阅读状态的可克隆底稿（本文件只覆盖 tab、spanId、files 三处） */
const READING_DEFAULT: RunReadingState = {
  tab: "overview",
  spanId: null,
  expandedSteps: {},
  overviewScrollTop: 0,
  stepsScrollTop: 0,
  overviewExpanded: [],
  calls: {},
};

const FILE_DEFAULT: FileReadingState = {
  checkpoint: null,
  path: null,
  pane: "list",
  query: "",
  filter: "auto",
  directoryWidth: 232,
  directoryCollapsed: false,
  diffPreference: "auto",
  wordWrap: true,
  listScrollTop: 0,
  contentScroll: null,
};

const calls: string[] = [];

const apiStub: Record<string, unknown> = {
  listRuns: async (): Promise<Envelope<ListRunsData>> => {
    calls.push("runs:list");
    return ok({
      runs: [
        { ...deriveRunSummary(recordOf("u1-ok")), id: SOURCE },
        { ...deriveRunSummary(recordOf("u1-ok")), id: ELSEWHERE },
      ],
      failed: [],
    });
  },
  getRun: async (id: string): Promise<Envelope<RunDetail>> => {
    calls.push(`runs:get:${id}`);
    return ok(detailOf("u1-ok", id));
  },
};
// U4 的两条操作通道用共享桩（空闲会话）：本文件不测执行登记，只测会话内导航状态
installOperationChannels(apiStub);

(globalThis as Record<string, unknown>).window = { api: apiStub as unknown as WindowApi };

const { useAppStore } = await import("../src/renderer/src/store");

const stateOf = () => useAppStore.getState();
const source = () => stateOf().createReturnLocation;
const reads = () => calls.filter((one) => one.startsWith("runs:get:"));

beforeEach(async () => {
  calls.length = 0;
  useAppStore.setState({
    operations: initialSession(),
    resultReads: emptyResultReadStore(),
    drafts: draftLib.emptyDraftRepo(),
    runs: [],
    failed: [],
    listLoaded: false,
    listStale: false,
    listRefreshInFlight: 0,
    listRefreshPending: 0,
    initialSelectionAttempted: false,
    error: null,
    selectedRunId: null,
    selectedSpanId: null,
    detail: null,
    readingByRun: {},
    navIntents: { byOperationId: {} },
    navGeneration: 0,
    view: "trace",
    createReturnLocation: null,
    settingsSection: null,
  });
  await useAppStore.getState().loadRuns();
  calls.length = 0;
});

describe("4.1 进入创建工作区：来源按当时位置建立", () => {
  it("从轨迹步骤页的某次调用进入 ⇒ 视图切到创建、来源记全运行 / 页签 / 调用", () => {
    useAppStore.setState({
      selectedRunId: SOURCE,
      readingByRun: {
        [SOURCE]: { ...structuredClone(READING_DEFAULT), tab: "steps", spanId: "s_03" },
      },
    });
    const before = stateOf().navGeneration;

    useAppStore.getState().openCreateWorkspace();

    const state = stateOf();
    expect(state.view).toBe("create");
    expect(state.createReturnLocation).toEqual({
      view: "trace",
      runId: SOURCE,
      tab: "steps",
      spanId: "s_03",
      file: null,
    });
    // 进入创建页 = 离开原来在看的那条运行 ⇒ 撤销在飞的自动导航资格
    expect(state.navGeneration).toBe(before + 1);
  });

  it("创建页内重复点击「新建」⇒ 本次来源沿用（同一对象），代次也不推进", () => {
    useAppStore.setState({ selectedRunId: SOURCE, selectedSpanId: "s_03" });
    useAppStore.getState().openCreateWorkspace();
    const first = source();
    const generation = stateOf().navGeneration;

    useAppStore.getState().openCreateWorkspace();

    expect(source()).toBe(first);
    expect(stateOf().navGeneration).toBe(generation);
  });

  it("设置往返（覆盖模态开合、视图未变）后再点新建 ⇒ 仍是本次来源", () => {
    useAppStore.setState({ selectedRunId: SOURCE });
    useAppStore.getState().openCreateWorkspace();
    const first = source();
    // 去设置：App 只翻设置分区，视图始终是创建页 ⇒ 判据"人还在创建页里"
    useAppStore.setState({ settingsSection: "proxy" });
    useAppStore.setState({ settingsSection: null });

    useAppStore.getState().openCreateWorkspace();

    expect(source()).toBe(first);
  });

  it("来源是「进过文件页、停在初始」⇒ 记 checkpoint null（与没进过文件页可分辨）", () => {
    useAppStore.setState({
      selectedRunId: SOURCE,
      readingByRun: {
        [SOURCE]: {
          ...structuredClone(READING_DEFAULT),
          tab: "files",
          files: { ...structuredClone(FILE_DEFAULT), checkpoint: null, path: "a/first.md" },
        },
      },
    });

    useAppStore.getState().openCreateWorkspace();

    expect(source()?.file).toEqual({ checkpoint: null, path: "a/first.md" });
  });

  it("页签写着文件页但从没进入过 ⇒ 不记定位，返回时也不伪造「要看初始」", async () => {
    useAppStore.setState({
      selectedRunId: SOURCE,
      detail: detailOf("u1-ok", SOURCE),
      readingByRun: { [SOURCE]: { ...structuredClone(READING_DEFAULT), tab: "files" } },
    });
    useAppStore.getState().openCreateWorkspace();
    expect(source()?.file).toBeNull();
    // 期间被写入过一份文件状态 ⇒ 返回不该拿"来源"的名义把它抹成初始
    useAppStore.getState().setFileReading(SOURCE, { path: "a/other.md" });

    await useAppStore.getState().returnToCreateSource();

    expect(stateOf().fileReadingOf(SOURCE).path).toBe("a/other.md");
  });

  it("换过工作区再进创建 ⇒ 取新来源（旧的不会被继承）", () => {
    useAppStore.setState({ selectedRunId: SOURCE });
    useAppStore.getState().openCreateWorkspace();
    useAppStore.getState().setView("tree");

    useAppStore.getState().openCreateWorkspace();

    expect(source()).toEqual({
      view: "tree",
      runId: null,
      tab: null,
      spanId: null,
      file: null,
    });
  });
});

describe("4.1 返回来源：能恢复就恢复，失效就回退", () => {
  it("来源运行已不是当前选中 ⇒ 走 selectRun 回到那条，并带回记录的页签与调用", async () => {
    // 现场直接摆放（不经 UI 动作）：真机上任何"点另一条运行"都会先离开创建页，
    // 所以"仍在创建页里但选中项已变"只能构造——这条钉的是**恢复语义**：
    // 回到记录的那条运行，而不是"当前选中那条凑数"。
    useAppStore.setState({
      view: "create",
      selectedRunId: ELSEWHERE,
      createReturnLocation: {
        view: "trace",
        runId: SOURCE,
        tab: "steps",
        spanId: "s_03",
        file: null,
      },
      readingByRun: {
        [SOURCE]: { ...structuredClone(READING_DEFAULT), tab: "steps", spanId: "s_03" },
      },
    });

    await useAppStore.getState().returnToCreateSource();

    const state = stateOf();
    expect(state.view).toBe("trace");
    expect(state.selectedRunId).toBe(SOURCE);
    expect(state.readingOf(SOURCE).tab).toBe("steps");
    expect(state.selectedSpanId).toBe("s_03");
    expect(state.detail?.meta.id).toBe(SOURCE);
    // 来源是一次性凭据：用过即清（不存在"再按一次返回"回到更早的位置）
    expect(state.createReturnLocation).toBeNull();
  });

  it("来源运行仍是当前选中 ⇒ 当场对齐页签，不重复读详情", async () => {
    useAppStore.setState({
      selectedRunId: SOURCE,
      detail: detailOf("u1-ok", SOURCE),
      readingByRun: { [SOURCE]: { ...structuredClone(READING_DEFAULT), tab: "steps" } },
    });
    useAppStore.getState().openCreateWorkspace();
    // 创建页期间该 run 被切到了概览
    useAppStore.getState().setReadingTab(SOURCE, "overview");
    const before = reads().length;

    await useAppStore.getState().returnToCreateSource();

    const state = stateOf();
    expect(state.view).toBe("trace");
    expect(state.readingOf(SOURCE).tab).toBe("steps");
    expect(reads()).toHaveLength(before);
  });

  it("文件页来源 ⇒ 连检查点与路径一起带回（返回后停在原来那份文件上）", async () => {
    useAppStore.setState({
      selectedRunId: SOURCE,
      detail: detailOf("u1-ok", SOURCE),
      readingByRun: {
        [SOURCE]: {
          ...structuredClone(READING_DEFAULT),
          tab: "files",
          files: { ...structuredClone(FILE_DEFAULT), checkpoint: "s_02", path: "src/a.ts" },
        },
      },
    });
    useAppStore.getState().openCreateWorkspace();
    expect(source()?.file).toEqual({ checkpoint: "s_02", path: "src/a.ts" });
    // 创建页期间被切到别的一份文件
    useAppStore.getState().setFileReading(SOURCE, { checkpoint: "s_04", path: "src/b.ts" });

    await useAppStore.getState().returnToCreateSource();

    expect(stateOf().fileReadingOf(SOURCE)).toMatchObject({
      checkpoint: "s_02",
      path: "src/a.ts",
    });
  });

  it("「重载后失效」⇒ 没有来源引用时回退到已有可用工作区，不伪造旧位置", async () => {
    useAppStore.setState({ view: "create", createReturnLocation: null, selectedRunId: SOURCE });

    await useAppStore.getState().returnToCreateSource();

    const state = stateOf();
    expect(state.view).toBe("trace");
    // 不"猜"一条运行去选：当前选中项原样保留（这里本就没有切换动作）
    expect(state.selectedRunId).toBe(SOURCE);
    expect(reads()).toEqual([]);
  });

  it("来源那条运行已不在列表里 ⇒ 回退，且不去挑一条最接近的顶上", async () => {
    useAppStore.setState({
      view: "create",
      selectedRunId: SOURCE,
      createReturnLocation: {
        view: "trace",
        runId: "run_ws_gone",
        tab: "steps",
        spanId: "s_03",
        file: null,
      },
    });

    await useAppStore.getState().returnToCreateSource();

    const state = stateOf();
    expect(state.view).toBe("trace");
    expect(state.selectedRunId).toBe(SOURCE);
    expect(state.readingOf(SOURCE).tab).not.toBe("steps");
    expect(state.createReturnLocation).toBeNull();
    expect(reads()).toEqual([]);
  });
});

describe("4.1 创建页与阅读 / 草稿 / 刷新各管各的", () => {
  it("「首次打开与无运行入口」的反面：首次读取迟到不覆盖已进入的创建页", async () => {
    // 列表还没读回来时用户就进了创建页（真机上"比首帧列表快"是常态）
    useAppStore.setState({ runs: [], listLoaded: false, selectedRunId: null });
    useAppStore.getState().openCreateWorkspace();
    await useAppStore.getState().loadRuns();

    await useAppStore.getState().autoSelectInitialRun();

    const state = stateOf();
    expect(state.view).toBe("create");
    expect(state.selectedRunId).toBeNull();
    // 守卫是一次性的，且**没有**把"已尝试"消费掉：回到轨迹后仍需按原规则自动选
    expect(state.initialSelectionAttempted).toBe(false);
  });

  it("对照：没进创建页时首次自动选择照常发生（新守卫不误伤）", async () => {
    useAppStore.setState({ runs: [], listLoaded: false, selectedRunId: null });
    await useAppStore.getState().loadRuns();
    await useAppStore.getState().autoSelectInitialRun();
    expect(stateOf().selectedRunId).toBe(SOURCE);
  });

  it("后台刷新列表既不换视图、也不动来源引用", async () => {
    useAppStore.setState({ selectedRunId: SOURCE });
    useAppStore.getState().openCreateWorkspace();
    const first = source();

    await useAppStore.getState().loadRuns();

    expect(stateOf().view).toBe("create");
    expect(stateOf().createReturnLocation).toBe(first);
  });

  it("返回来源不清草稿；放弃草稿也不影响在场的来源", () => {
    const store = useAppStore.getState();
    store.ensureCreateRunDraft();
    store.writeCreateRunDraft({ userMessage: "一份长任务" });
    store.openCreateWorkspace();

    void store.returnToCreateSource();
    // 返回只是换工作区：草稿连同正文都在（delta「创建草稿…遵守同一保留规则」）
    expect(stateOf().drafts.create?.userMessage).toBe("一份长任务");

    // 反过来：放弃草稿不清"这次从哪儿来"的引用（两条生命周期互不决定）
    const first = {
      view: "trace",
      runId: SOURCE,
      tab: "overview",
      spanId: null,
      file: null,
    } as const;
    useAppStore.setState({ view: "create", createReturnLocation: first });
    const entry = stateOf().createRunDraftOf();
    expect(stateOf().discardCreateRunDraft(entry?.revision ?? -1)).toBe(true);
    expect(stateOf().drafts.create).toBeNull();
    expect(stateOf().createReturnLocation).toBe(first);
  });

  it("「草稿不含来源」：创建草稿的键集合里不存在位置 / 授权字段", () => {
    useAppStore.getState().ensureCreateRunDraft();
    const entry = stateOf().createRunDraftOf();
    expect(entry).not.toBeNull();
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "mode",
      "revision",
      "systemPrompt",
      "userMessage",
    ]);
  });

  it("在创建页里点某条运行 ⇒ 离开创建页并把来源作废", async () => {
    useAppStore.setState({ selectedRunId: SOURCE });
    useAppStore.getState().openCreateWorkspace();
    expect(stateOf().view).toBe("create");

    await useAppStore.getState().selectRun(ELSEWHERE);

    const state = stateOf();
    expect(state.view).toBe("trace");
    expect(state.selectedRunId).toBe(ELSEWHERE);
    expect(state.createReturnLocation).toBeNull();
  });

  it("同 ID 短路也要退出创建页（否则「打开结果」在创建页里点了没反应）", async () => {
    useAppStore.setState({ selectedRunId: ELSEWHERE, detail: detailOf("u1-ok", ELSEWHERE) });
    useAppStore.getState().openCreateWorkspace();

    // 目标恰是"上一条选中的运行"：旧短路会什么都不发生
    await useAppStore.getState().selectRun(ELSEWHERE);

    expect(stateOf().view).toBe("trace");
    expect(stateOf().selectedRunId).toBe(ELSEWHERE);
  });
});

describe("4.1 接线契约：来源判据只有一份", () => {
  const read = (rel: string): string =>
    readFileSync(resolve(import.meta.dirname, "../src/renderer/src", rel), "utf8");

  it("组件侧不得自己判来源与回退（decideCreateEntry / decideCreateReturn 只在 store）", () => {
    const offenders: string[] = [];
    for (const name of [
      "components/CreateRunWorkspace.tsx",
      "components/GlobalBar.tsx",
      "components/RunList.tsx",
      "App.tsx",
    ]) {
      const src = read(name);
      if (/decideCreateEntry|decideCreateReturn|createReturnLocation/.test(src)) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("覆盖模态判据不再引用创建视图（创建是页面）", () => {
    const storeSrc = read("store.ts");
    const at = storeSrc.indexOf("async function attemptResultNavigation");
    const body = storeSrc.slice(at, storeSrc.indexOf("/**", at + 40));
    expect(body).toContain("coveringModal: state.settingsSection !== null");
    expect(body).not.toContain('view === "create"');
  });

  it("旧对话框通道不得复活：store 里没有 createDialogOpen / setCreateDialogOpen", () => {
    const storeSrc = read("store.ts");
    for (const rel of ["App.tsx", "components/GlobalBar.tsx", "components/RunList.tsx"]) {
      expect(read(rel), rel).not.toContain("createDialogOpen");
    }
    expect(storeSrc).not.toContain("createDialogOpen");
  });
});
