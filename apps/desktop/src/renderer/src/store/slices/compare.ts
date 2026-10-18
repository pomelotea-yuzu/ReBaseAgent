import { api } from "../../lib/api";
import { deriveCompareFileEntry, isOwnStepTarget } from "../../lib/compare-files";
// AppState 分片：Compare 域（refactor-renderer 4.1 接口 / 5.3 实现迁入；归属依据 change 的 ownership-map.md）
// 工厂以完整 store 的 set/get 为上下文（design D2：无第二 create、不导入 useAppStore）；
// requestCompareRead / enterCompareView 两个域内协调者随域迁入（闭包持有）；
// noteReadingChanged / restoreReadingLocation 由 store.ts 显式注入（results/navigation 域迁出前）。
import type { ComparePair, CompareReturnLocation } from "../../lib/compare-navigation";
import {
  decideCompareWithParent,
  decideManualPair,
  decidePairSideEdit,
  swapComparePair,
} from "../../lib/compare-navigation";
import {
  type CompareReadSession,
  applyCompareResponse,
  beginCompareRead,
  destroyCompareRead,
  emptyCompareReadSession,
  findCompareSelectionViolation,
  retryCompareRead as retryCompareReadState,
  sameCompareSelection,
} from "../../lib/compare-state";
import {
  type CreateReturnLocation,
  decideCreateEntry,
  decideCreateReturn,
} from "../../lib/create-workspace";
import { isIsolatedRun } from "../../lib/isolated-fork";
import { readingStateOf } from "../../lib/reading-state";
import type { AppState, SliceContext } from "../types";

/** 分支对照的条数上限：再多是界面放不下，也失去了"并排看"的意义（原 store.ts 常量随域迁入） */
export const MAX_COMPARE = 4;

export interface CompareState {
  compareRead: CompareReadSession;
  comparePair: ComparePair | null;
  compareStepSelection: { readonly left: string | null; readonly right: string | null };
  comparePrefixFolded: { readonly left: boolean; readonly right: boolean };
  compareEvidenceExpanded: boolean;
  compareReturnLocation: CompareReturnLocation | null;
  /** 加入对照的 run id（上限 4，分支树的选择栏与比较工作区的指标表消费） */
  compareIds: string[];
  /** 对照集合的操作提示（超上限等），空则无提示 */
  compareNotice: string | null;
  /**
   * U7 任务 1.4：进入/更换比较对象并读取。合法性与幂等判据：
   * 非法（数量/重复/空 id）⇒ 不变；与当前选择集同序同 id ⇒ 幂等不重读（保留结论）；
   * 换集 ⇒ 旧结论撤销 + 发起单次 `runs:compare`（旧在飞响应被代次淘汰）。
   * 返回值供调用方与测试区分三分支。
   */
  enterCompareSelection: (
    runIds: readonly string[],
  ) => Promise<"started" | "unchanged" | "invalid">;
  /**
   * U7 任务 1.5：**显式只读重试**——同选择集全量重读（design D3：整组重验保持
   * 共同基线一致）。旧结论先行撤销；无活动选择集时不可重试（返回 false）。
   * 零执行通道调用。
   */
  retryCompareSelectionRead: () => Promise<boolean>;
  /**
   * U7 任务 1.4：离开比较（销毁守卫）。在飞请求作废、结论清空、代次递增——
   * 迟到响应永不复活；不碰选择运行/草稿/操作事实。
   */
  leaveCompare: () => void;
  /**
   * U7 任务 2.1：概览/可信结果的「与父运行对比」入口。父左子右恒定；
   * 无 parent ⇒ hidden（入口不显示），model_params 臂 ⇒ blocked（实验门禁，
   * 不提供普通旁路）。返回值供调用方与测试区分分支。
   */
  openCompareWithParent: (runId: string) => Promise<"opened" | "hidden" | "blocked">;
  /**
   * U7 任务 5.3：从宽幅指标表**显式选择两条**进入详细比较（design D1）。
   * - 两枚 runId 必须互异（相同 ID 不构成两条比较）且都属于当前对照集合
   *   （表列只能来自集合，双保险）；
   * - 显式选择**不改全局集合**（进入/交换不改集合，D1）；
   * - 页内换 pair = 显式换阅读对象 ⇒ 推进阅读代次（2.4 同款）；
   *   步骤选中/折叠随 pair 变更的清理在 `enterCompareView` 内完成。
   */
  openComparePair: (leftRunId: string, rightRunId: string) => Promise<"opened" | "rejected">;
  /**
   * U7 任务 2.2/2.5：从全局对照集合进入比较工作区。恰好两条 ⇒ 按加入顺序
   * （先子在左也是子左父右）；三/四条 ⇒ 不自动选两条（§5.3 显式选择，这里如实
   * 提示后仍进工作区）；零/一条 ⇒ 无详细比较（引导态）。
   */
  openCompareWorkspace: () => Promise<void>;
  /**
   * U7 任务 2.2：更换 pair 的一侧。同 ID 拒绝（两枚 runId 必须互异）、同值幂等；
   * 换成功 ⇒ 推进阅读代次并按新序重读。**不**调 `selectRun`、不动侧栏选择
   * 与全局集合（scenario「更换交换不改变侧栏选择」）。
   */
  setCompareSide: (
    side: "left" | "right",
    runId: string,
  ) => Promise<"replaced" | "unchanged" | "rejected">;
  /** U7 任务 2.2：交换左右。方向、标题、每侧内容随序号同步；推进阅读代次并重读。 */
  swapCompareSides: () => Promise<"swapped" | "none">;
  /**
   * U7 任务 4.8：比较步骤的**复合定位**——左右两列各自的选中调用，身份 =
   * 侧 + run + span。选左不改变右（scenario「重复 span ID 与独立分支不强行
   * 对齐」：两侧重复的 s_01 各归各列）；更换对象清空被换侧，交换随 pair 对调，
   * 换了 pair（新比较集）则两侧全清。
   */
  selectCompareStep: (side: "left" | "right", spanId: string | null) => void;
  /** U7 任务 4.14：切换某一侧的前缀折叠/展开（只动本侧）。 */
  toggleComparePrefix: (side: "left" | "right") => void;
  /** UI 密度 change 1.4：展开/收起修改证据区。 */
  setCompareEvidenceExpanded: (expanded: boolean) => void;
  /**
   * U7 任务 2.3：返回比较的来源页（一次性凭据，恢复/回退都算用掉）。
   * 来源不可用（no-location / run-missing）⇒ 回退到仍有效的来源视图，不选同名运行。
   */
  returnFromCompare: () => Promise<void>;
  /**
   * U7 任务 2.3：从单侧运行/调用回到比较页（打开单侧**不清**来源引用与 pair）。
   * 同 pair 幂等：`enterCompareSelection` 不重读，会话结论与阅读位置保留。
   */
  returnToCompare: () => void;
  /**
   * U7 任务 4.5：比较侧的**单侧错误跳转**——打开目标侧运行并定位其自有失败
   * 调用。spanId 来自该侧已校验详情的错误定位派生（`deriveSideOutputFacts`），
   * 本动作不做二次归属判断；运行不可达（详情读取失败）⇒ false，由视图给
   * 回退说明。打开单侧按 2.3 保留 pair 与来源引用 ⇒ 「返回比较」仍成立。
   */
  openCompareSideError: (runId: string, llmCallSpanId: string) => Promise<boolean>;
  /**
   * U7 任务 5.6/5.7：**分别打开左右侧文件页**（design D6）。
   * - 能力判据用比较响应里该侧的**已校验详情**（isIsolatedRun），普通运行
   *   ⇒ unsupported（不造文件历史、不借当前选中 run 冒充）；
   * - 该侧若有选中的比较步骤，仅**合法自有完成步骤**（leafSpanIds 内 agent.step）
   *   写成文件检查点定位目标，否则不写、走 U2 已保存位置/默认规则；
   * - 落地判据与 `openCompareSideError` 同款（selectRun 后详情读出且归属相符）；
   *   打开单侧保留 pair 与来源引用 ⇒ 「返回比较」仍成立（2.3）。
   */
  openCompareSideFiles: (side: "left" | "right") => Promise<"opened" | "unsupported" | "failed">;
  /** 对照集合加入/移出一条（上限 MAX_COMPARE；加入或移出都清操作提示） */
  toggleCompare: (runId: string) => void;
  /** 清空对照集合与操作提示 */
  clearCompare: () => void;
}

/** compare 分片工厂上下文：完整 set/get + 跨域协调者的显式注入 */
export interface CompareSliceContext extends SliceContext {
  /** results 域协调者（5.5 迁出前由 store.ts 注入）：换阅读对象 ⇒ 撤销在飞导航资格 */
  noteReadingChanged: () => void;
  /** navigation 域协调者（store.ts 注入）：「返回来源」的阅读位置恢复落点 */
  restoreReadingLocation: (
    location: Pick<CreateReturnLocation, "runId" | "tab" | "spanId" | "file">,
  ) => Promise<void>;
}

export function createCompareSlice({
  set,
  get,
  noteReadingChanged,
  restoreReadingLocation,
}: CompareSliceContext): CompareState {
  /**
   * U7 任务 1.4/1.5：一次比较选择集的实际只读请求（design D3 渲染层半边）。
   *
   * 单一咽喉：进入与重试都汇到这里——发请求前记录当代代次，响应落地时把
   * 代次 + 选择集 + 信封一起交给 `applyCompareResponse`（同代次同选择集才采信，
   * 其余整份丢弃）。整条路径零执行通道、零列表刷新、零选择/滚动/焦点变更。
   */
  async function requestCompareRead(runIds: readonly string[], generation: number): Promise<void> {
    const envelope = await api.compareRuns({ runIds: [...runIds] });
    set((state) => ({
      compareRead: applyCompareResponse(state.compareRead, generation, runIds, envelope),
    }));
  }

  /**
   * U7 2.3：进入比较视图的公共落点（父子入口 / 手动集合共用）。
   *
   * - 页内重复进入：来源沿用、代次不推进（与创建页同一纪律——设置往返/重复点击
   *   不该把本次流程的导航资格撤销掉）；
   * - 跨视图进入：现记来源位置 + 推进阅读代次（显式阅读意图，D1）；
   * - pair 非空时按新序触发 `enterCompareSelection`（换集重读 / 同集幂等都在那里判）。
   */
  async function enterCompareView(pair: ComparePair | null): Promise<void> {
    const state = get();
    const alreadyInCompare = state.view === "compare";
    // U7 4.8：prev pair 必须在 setState 前取——换了 pair（新比较集）两侧步骤选中全清
    const prevPair = state.comparePair;
    let location: CompareReturnLocation | null = null;
    if (!alreadyInCompare) {
      const decision = decideCreateEntry({
        view: state.view,
        selectedRunId: state.selectedRunId,
        reading:
          state.view === "trace" && state.selectedRunId !== null
            ? readingStateOf(state.readingByRun, state.selectedRunId)
            : null,
      });
      // decideCompareEntry 的 keep 分支已在上面判掉；这里只可能是 capture
      if (decision.kind === "capture") location = decision.location;
      noteReadingChanged();
    }
    set({
      view: "compare",
      ...(alreadyInCompare ? {} : { compareReturnLocation: location }),
      // 6.4 实机坐实：集合进入（0/1/3/4 条）必须清 pair——pair 残留会让工作区卡在
      // 「正在读取详细比较对象…」（结论 runIds 与残留 pair 永不对齐，重试也出不来）。
      // design 2.2 的「无 pair」语义 = comparePair 置 null（指标表模式承载）。
      comparePair: pair,
    });
    if (pair !== null) {
      const changed =
        prevPair === null ||
        prevPair.leftRunId !== pair.leftRunId ||
        prevPair.rightRunId !== pair.rightRunId;
      if (changed) {
        set({
          compareStepSelection: { left: null, right: null },
          comparePrefixFolded: { left: true, right: true },
          // UI 密度 change 1.4：换 pair 回默认收起（旧 pair 的展开态不带到新对象）
          compareEvidenceExpanded: false,
        });
      }
      await get().enterCompareSelection([pair.leftRunId, pair.rightRunId]);
    }
  }

  return {
    compareRead: emptyCompareReadSession(),
    comparePair: null,
    compareReturnLocation: null,
    compareStepSelection: { left: null, right: null },
    comparePrefixFolded: { left: true, right: true },
    compareEvidenceExpanded: false,
    compareIds: [],
    compareNotice: null,

    async enterCompareSelection(runIds) {
      // U7 1.4：合法性判据与 IPC schema 同源（findCompareSelectionViolation 复用
      // CompareRunsRequestSchema），非法请求连 state 都不动
      const violation = findCompareSelectionViolation(runIds);
      if (violation !== null) return "invalid";
      const current = get().compareRead;
      // 幂等：同序同 id 的重复进入不重读——保留在场结论与（后续 §2 的）阅读位置，
      // 「不以每次开比较清空工作区状态换取简单实现」（design D1）
      if (sameCompareSelection(current.selection, runIds)) return "unchanged";
      const started = beginCompareRead(current, runIds);
      set({ compareRead: started });
      await requestCompareRead(started.selection as string[], started.generation);
      return "started";
    },

    async retryCompareSelectionRead() {
      // U7 1.5：同选择集全量重读；旧结论在 beginCompareRead 内先行撤销
      const next = retryCompareReadState(get().compareRead);
      if (next === null) return false;
      set({ compareRead: next });
      await requestCompareRead(next.selection as string[], next.generation);
      return true;
    },

    leaveCompare() {
      // U7 1.4：销毁守卫——在飞请求作废、结论清空；代次递增使迟到响应永不复活
      set({ compareRead: destroyCompareRead(get().compareRead) });
    },

    async openCompareWithParent(runId) {
      // U7 2.1：入口判据必须喂「当前正读的那条」的已校验详情——detail 归属不符
      // （迟到响应/串号）时按无入口处理，绝不从列表或操作登记猜父本
      const detail = get().detail;
      if (detail === null || detail.meta.id !== runId) return "hidden";
      const decision = decideCompareWithParent(detail);
      if (decision.kind !== "open") return decision.kind;
      await enterCompareView(decision.pair);
      return "opened";
    },

    async openComparePair(leftRunId, rightRunId) {
      // U7 5.3：显式选两条。相同 ID 不构成两条比较；两枚 id 都必须在当前对照集合内
      //（指标表的列本来就来自集合——这里判集合而不是判结论，避免"结论未到就点不动"）
      if (leftRunId === rightRunId) return "rejected";
      const ids = get().compareIds;
      if (!ids.includes(leftRunId) || !ids.includes(rightRunId)) return "rejected";
      // 页内换 pair = 显式换阅读对象 ⇒ 推进代次（与 setCompareSide/swap 同款）
      noteReadingChanged();
      await enterCompareView({ leftRunId, rightRunId });
      return "opened";
    },

    async openCompareWorkspace() {
      // U7 2.2/2.5 + 5.2：手动集合的进入路径。恰好两条 ⇒ 加入顺序定左右（先子后父不重排）；
      // 三/四条 ⇒ 不自动选两条，如实提示后仍进工作区（宽幅指标表显式选择）；
      // 零/一条 ⇒ 无 pair（指标表引导 / 单条自有指标）。
      const decision = decideManualPair(get().compareIds);
      if (decision.kind === "none" && decision.reason === "explicit-select") {
        set({ compareNotice: "已选三条及以上：请在指标表中显式选择两条进入详细比较" });
      }
      await enterCompareView(decision.kind === "pair" ? decision.pair : null);
      // U7 5.2：无 pair 的进入也要让宽幅指标表有数据——对整个对照集合发起一次
      // 只读比较读取（1–4 条均合法；零条无可读）。同集合幂等，不重复请求。
      if (decision.kind === "none" && get().compareIds.length >= 1) {
        await get().enterCompareSelection(get().compareIds);
      }
    },

    async setCompareSide(side, runId) {
      const pair = get().comparePair;
      if (pair === null) return "rejected";
      const decision = decidePairSideEdit(pair, side, runId);
      if (decision.kind === "unchanged") return "unchanged";
      if (decision.kind === "rejected") return "rejected";
      // 更换对象 = 显式换阅读对象 ⇒ 推进阅读代次；**不**调 selectRun、不动侧栏选择
      // 与全局对照集合（scenario「更换交换不改变侧栏选择」）
      noteReadingChanged();
      set({ comparePair: decision.pair });
      // U7 4.8：被换侧的步骤选中随旧对象失效；另一侧保留
      set({
        compareStepSelection: {
          left: side === "left" ? null : get().compareStepSelection.left,
          right: side === "right" ? null : get().compareStepSelection.right,
        },
        comparePrefixFolded: {
          left: side === "left" ? true : get().comparePrefixFolded.left,
          right: side === "right" ? true : get().comparePrefixFolded.right,
        },
      });
      await get().enterCompareSelection([decision.pair.leftRunId, decision.pair.rightRunId]);
      return "replaced";
    },

    async swapCompareSides() {
      const pair = get().comparePair;
      if (pair === null) return "none";
      const swapped = swapComparePair(pair);
      noteReadingChanged();
      set({ comparePair: swapped });
      // U7 4.8：交换 = 左右内容对调 ⇒ 步骤选中随对象一起对调（不是清空）
      const selection = get().compareStepSelection;
      const folded = get().comparePrefixFolded;
      set({
        compareStepSelection: { left: selection.right, right: selection.left },
        comparePrefixFolded: { left: folded.right, right: folded.left },
      });
      // 交换使旧序请求失效（design D3「快速替换、交换、移出或离开使旧请求失效」）
      await get().enterCompareSelection([swapped.leftRunId, swapped.rightRunId]);
      return "swapped";
    },

    selectCompareStep(side, spanId) {
      // U7 4.8：复合定位只动本侧——选左不改变右（重复的 s_01 各归各列）
      const current = get().compareStepSelection;
      set({
        compareStepSelection:
          side === "left" ? { ...current, left: spanId } : { ...current, right: spanId },
      });
    },

    toggleComparePrefix(side) {
      // U7 4.14：折叠/展开只动本侧（折叠是视图压缩，记录不删——展开即恢复）
      const current = get().comparePrefixFolded;
      set({
        comparePrefixFolded:
          side === "left"
            ? { ...current, left: !current.left }
            : { ...current, right: !current.right },
      });
    },

    setCompareEvidenceExpanded(expanded) {
      // UI 密度 change 1.4：只动这一位（纯阅读状态，不触发读取、不动 pair）
      set({ compareEvidenceExpanded: expanded });
    },

    async returnFromCompare() {
      const state = get();
      const decision = decideCreateReturn({
        location: state.compareReturnLocation,
        knownRunIds: state.runs.map((run) => run.id),
      });
      // 一次性凭据：恢复与回退都算用掉（与创建页同纪律）
      set({ compareReturnLocation: null });
      const target = decision.kind === "restore" ? decision.location.view : decision.view;
      noteReadingChanged();
      set({ view: target });
      if (decision.kind !== "restore" || decision.location.runId === null) return;
      await restoreReadingLocation(decision.location);
    },

    async openCompareSideError(runId, llmCallSpanId) {
      // U7 4.5：单侧错误跳转 = 打开该侧运行并定位自有失败调用（同 openOperationFailure
      // 的「先落地、再定位」次序——详情读不出来就不做任何定位）。
      // selectRun 走既有读取通路：比较结论里的 detail 不复用为导航真相源；
      // 2.3 纪律：离开比较视图但保留 pair 与来源引用 ⇒ 「返回比较」仍成立。
      // ⚠️ selectRun 在读取失败时也会落 selectedRunId（原位可重试）——
      // 「落地」判据必须是详情已读出且归属相符，不能只看 selectedRunId。
      await get().selectRun(runId);
      const detail = get().detail;
      if (get().selectedRunId !== runId || detail === null || detail.meta.id !== runId) {
        return false;
      }
      get().setReadingTab(runId, "steps");
      get().selectSpan(llmCallSpanId);
      return true;
    },

    returnToCompare() {
      // U7 2.3：单侧往返的回程。pair 与 compareRead 会话都在（打开单侧不清它们）；
      // 同 pair 下 enterCompareSelection 幂等 ⇒ 这里只切视图，不重读
      if (get().view === "compare") return;
      noteReadingChanged();
      set({ view: "compare" });
    },

    async openCompareSideFiles(side) {
      const pair = get().comparePair;
      if (pair === null) return "failed";
      const runId = side === "left" ? pair.leftRunId : pair.rightRunId;
      // 能力判据的**唯一输入** = 比较响应里该侧的已校验详情（不拿当前选中 run 冒充）
      const conclusion = get().compareRead.conclusion;
      const item =
        conclusion?.kind === "verified"
          ? conclusion.items.find((candidate) => candidate.runId === runId)
          : undefined;
      const detail = item?.status === "ready" ? item.detail : null;
      const reading = readingStateOf(get().readingByRun, runId);
      const entry = deriveCompareFileEntry({
        detail,
        selectedSpanId:
          side === "left" ? get().compareStepSelection.left : get().compareStepSelection.right,
        savedTab: reading.files !== undefined ? "files" : undefined,
      });
      if (entry.kind !== "available") return "unsupported";

      await get().selectRun(runId);
      // 落地判据（同 openCompareSideError）：详情读出、归属相符、且能力仍成立
      const live = get().detail;
      if (get().selectedRunId !== runId || live === null || live.meta.id !== runId) return "failed";
      if (!isIsolatedRun(live)) return "failed";
      // 5.7：显式步骤定位目标必须在**落地后的详情**上复核为合法自有完成步骤
      if (entry.targetCheckpointStepId !== null) {
        if (isOwnStepTarget(live, entry.targetCheckpointStepId)) {
          get().setFileReading(runId, { checkpoint: entry.targetCheckpointStepId });
        }
        // 复核不过 ⇒ 不写：走 U2 已保存合法位置或默认检查点（不提示成功也不伪造定位）
      }
      get().setReadingTab(runId, "files");
      set({ view: "trace" });
      return "opened";
    },

    toggleCompare(runId) {
      const { compareIds } = get();
      if (compareIds.includes(runId)) {
        set({
          compareIds: compareIds.filter((id) => id !== runId),
          compareNotice: null,
        });
        return;
      }
      if (compareIds.length >= MAX_COMPARE) {
        set({ compareNotice: `最多同时对照 ${MAX_COMPARE} 条运行` });
        return;
      }
      set({ compareIds: [...compareIds, runId], compareNotice: null });
    },

    clearCompare() {
      set({ compareIds: [], compareNotice: null });
    },
  };
}
