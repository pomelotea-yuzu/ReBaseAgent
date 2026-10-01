import type {
  CreateReturnLocation,
  ReadingLocationSnapshot,
  WorkspaceView,
} from "./create-workspace";

/**
 * U7（improve-branch-comparison）任务 2.1–2.5：比较导航判据（design D1）。
 *
 * 三组决策集中在本文件，store 只做接线：
 *
 * 1. **独立 pair 状态**（2.2）：详细比较用 `leftRunId/rightRunId`，不绑侧栏选中项、
 *    不动 `compareIds` 全局集合（进入/交换不改全局集合，D1）；
 * 2. **父子入口**（2.1/2.5）：概览/可信结果的「与父运行对比」恒**父左子右**；
 *    model_params 臂被实验门禁挡住，不提供普通比较旁路（design D5）；
 * 3. **返回位置**（2.3）：类型与创建页的来源引用同形（`CreateReturnLocation`），
 *    捕获/返回决策复用同一批函数——不抄第二份判据。
 *
 * 手动两条的左右顺序（2.5）：由 `compareIds` 的**加入顺序**决定（第一条在左），
 * store 接线处现取，不因父子关系自动重排——与显式父子入口的父左子右并存。
 */

/** 详细比较的一对对象：left/right 的顺序即修改方向（左=原值侧） */
export interface ComparePair {
  readonly leftRunId: string;
  readonly rightRunId: string;
}

/** pair 的一侧更换决策 */
export type PairSideEditDecision =
  /** 换成功（另一侧不受影响） */
  | { readonly kind: "replace"; readonly pair: ComparePair }
  /** 换的就是本侧现值 ⇒ 幂等无变化（不触发重读） */
  | { readonly kind: "unchanged" }
  /** 相同 ID 不构成两条比较（spec「相同 ID 不被接受为两条」） */
  | { readonly kind: "rejected"; readonly reason: "same-id" };

/**
 * 更换 pair 的一侧。另一侧的现值不可挪到本侧（两枚 runId 必须互异）。
 * 更换**不**改变侧栏选中项与全局对照集合——那是接线层的纪律（D1），本函数
 * 只产出新 pair。
 */
export function decidePairSideEdit(
  pair: ComparePair,
  side: "left" | "right",
  newRunId: string,
): PairSideEditDecision {
  const current = side === "left" ? pair.leftRunId : pair.rightRunId;
  const other = side === "left" ? pair.rightRunId : pair.leftRunId;
  if (newRunId === current) return { kind: "unchanged" };
  if (newRunId === other) return { kind: "rejected", reason: "same-id" };
  return {
    kind: "replace",
    pair:
      side === "left"
        ? { leftRunId: newRunId, rightRunId: pair.rightRunId }
        : { leftRunId: pair.leftRunId, rightRunId: newRunId },
  };
}

/** 交换左右（标题、修改方向、每侧内容随序号同步更新——方向由消费方现算） */
export function swapComparePair(pair: ComparePair): ComparePair {
  return { leftRunId: pair.rightRunId, rightRunId: pair.leftRunId };
}

/** 「与父运行对比」入口的三态（delta「父子入口默认父左子右」） */
export type CompareWithParentDecision =
  /** 打开：左=真实直接父，右=当前运行（不因加入顺序重排） */
  | { readonly kind: "open"; readonly pair: ComparePair }
  /** 无 parent 引用 ⇒ 不显示入口（scenario 原文） */
  | { readonly kind: "hidden"; readonly reason: "no-parent" }
  /**
   * model_params 臂遵守实验比较门禁（design D5）⇒ 不提供绕过门禁的普通
   * 父子比较入口；§5 的实验比较工作区是它的唯一合法路径。
   */
  | { readonly kind: "blocked"; readonly reason: "model-params-gate" };

/** 判定某条 run 能否从概览/可信结果进入「与父运行对比」 */
export function decideCompareWithParent(detail: {
  meta: {
    id: string;
    parent: string | null;
    fork: { edit: { field: string } } | null;
  };
}): CompareWithParentDecision {
  const { parent, fork } = detail.meta;
  if (parent === null) return { kind: "hidden", reason: "no-parent" };
  if (fork?.edit.field === "model_params") {
    return { kind: "blocked", reason: "model-params-gate" };
  }
  return { kind: "open", pair: { leftRunId: parent, rightRunId: detail.meta.id } };
}

/**
 * 比较页的来源引用：与创建页的来源引用同形（视图 / 运行 / 页签 / 调用 / 文件定位）。
 * 复用同一类型与同一批捕获/恢复判据，避免两处口径漂移；§3.3 落地树视口恢复时
 * 在 `CreateReturnLocation` 上扩展树半边字段（两处同时受益）。
 */
export type CompareReturnLocation = CreateReturnLocation;

/** 可以充当比较来源的视图（创建页与比较页自身都不是比较的来源） */
export type CompareSourceView = Exclude<WorkspaceView, "create" | "compare">;

/** 进入比较时对来源引用的处置（语义同创建：页内重复进入沿用，跨视图进来重记） */
export type CompareEntryDecision =
  | { readonly kind: "keep"; readonly reason: "already-in-compare" }
  | { readonly kind: "capture"; readonly location: CompareReturnLocation };

/**
 * 决定这次进入比较要不要重记来源。
 *
 * 与创建的唯一差别在"页内"的判定值是 `compare` 视图。捕获复用
 * `decideCreateEntry` 的落点（同形判据，那里对 trace/tree 的阅读位置照记），
 * 这里只做视图分流——不复制它的字段挑选逻辑。
 */
export function decideCompareEntry(
  snapshot: ReadingLocationSnapshot,
  capture: (snapshot: ReadingLocationSnapshot) => {
    kind: "capture";
    location: CompareReturnLocation;
  },
): CompareEntryDecision {
  if (snapshot.view === "compare") return { kind: "keep", reason: "already-in-compare" };
  return capture(snapshot);
}

/**
 * 手动集合进入详细比较的 pair 决策（2.2/2.5）：
 * - 恰好两条 ⇒ 按加入顺序（`compareIds` 的现序）定左右，先子后父也是子左父右；
 * - 三或四条 ⇒ 不自动选两条（须显式选择，§5.3 的指标表交互）；
 * - 零或一条 ⇒ 无 pair（比较工作区显示单条自有指标/引导，不伪造第二条）。
 */
export type ManualPairDecision =
  | { readonly kind: "pair"; readonly pair: ComparePair }
  | { readonly kind: "none"; readonly reason: "needs-two" | "explicit-select" };

export function decideManualPair(compareIds: readonly string[]): ManualPairDecision {
  if (compareIds.length === 2) {
    const left = compareIds[0];
    const right = compareIds[1];
    if (left !== undefined && right !== undefined) {
      return { kind: "pair", pair: { leftRunId: left, rightRunId: right } };
    }
  }
  if (compareIds.length >= 3) return { kind: "none", reason: "explicit-select" };
  return { kind: "none", reason: "needs-two" };
}

// ---------------------------------------------------------------------------
// U7 任务 5.8：宽度适配与导航状态恢复（design D6）
// ---------------------------------------------------------------------------

/**
 * 双运行正文并排阈值（CSS px，按**正文容器**宽度判，不是整窗）。
 * design D6：初始实现常量，可依实测调整，但须满足相同可达性判据。
 */
export const COMPARE_STACK_THRESHOLD = 960;

export type CompareBodyLayout = "side-by-side" | "stacked";

/**
 * 双运行正文并排还是上下排列：容器宽度 ≥ 阈值 ⇒ 并排；
 * 否则上下排列（对象标题随每列头部自然重复）。
 */
export function decideCompareBodyLayout(
  containerWidth: number,
  threshold: number = COMPARE_STACK_THRESHOLD,
): CompareBodyLayout {
  return containerWidth >= threshold ? "side-by-side" : "stacked";
}

/**
 * 比较页的导航可见性：**窄窗**（narrow/single 档）首次进入默认收起，退出恢复
 * 用户原状态——通过纯显示决策实现，**不写回偏好**（与 U1 自动折叠同一纪律：
 * 偏好没被改过，宽度回来自然恢复）。wide/medium 档沿用用户当前状态。
 */
export function decideCompareNavVisible(input: {
  view: WorkspaceView;
  breakpoint: "wide" | "medium" | "narrow" | "single";
  navVisible: boolean;
}): boolean {
  if (input.view !== "compare") return input.navVisible;
  return input.breakpoint === "wide" || input.breakpoint === "medium" ? input.navVisible : false;
}
