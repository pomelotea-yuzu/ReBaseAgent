/**
 * 编辑器恢复契约的**纯函数层**（`fix-proxy-recording-reliability` 任务 4.2）。
 *
 * 为什么不直接写在组件里：本包无 jsdom，几何判定（谁可见、谁塌缩、要不要重挂）需要
 * 能在 node 侧被**逐条测到**的判据；写进组件就只能靠实机截图验收。抽到这里后：
 *   - 组件只负责喂事实（宿主几何、加载态、实例）；
 *   - 判定与文案由本模块单测覆盖；
 *   - 实机探针（`scripts/editor-collapse-probe.cjs`）用**同一套判据**复核，
 *     避免"单测一套口径、实机另一套口径"。
 *
 * ⚠️ 与 spec 的对应关系（`specs/desktop-ui/spec.md`「可见消息编辑器可恢复且不丢草稿」）：
 *   - 「隐藏 Monaco helper 的零尺寸 SHALL NOT 单独作为可见塌缩的判据」
 *     ⇒ `classifyHost` 的 `hidden` 判定只看**锚点宿主自身**，非锚点节点一律不进判定；
 *   - 「恢复失败可见且能就地重试」⇒ `recoveryNotice`；
 *   - 「不自动提交或清空」由调用方保证（本模块不碰草稿，只给文案与动作名）。
 */

/** 一个锚点宿主的观测事实（与实机探针的采集字段同名同义）。 */
export interface EditorHostFacts {
  /** 宿主自身边框盒宽高（CSS px）。`offsetWidth/Height`，不受 transform 影响。 */
  readonly offsetW: number;
  readonly offsetH: number;
  /** 与视口矩形是否有实际交集面积。 */
  readonly inViewport: boolean;
  /** 祖先链上第一个塌断点的描述；null = 无塌断点。 */
  readonly ancestorBreak: string | null;
  /** 可见滚动面数量（0 = 没读到文字面）。 */
  readonly scrollableCount: number;
}

export type EditorHostVerdict =
  /** 正常：可见有框、在视口内、有内容面。 */
  | { readonly kind: "ok" }
  /** 加载/恢复失败：宿主有框但拿不到内容面，且已超出重试预算。 */
  | { readonly kind: "failed"; readonly reason: string }
  /** 可见但内容面读不到 ⇒ 需要就地 layout 恢复（不是隐藏 helper）。 */
  | { readonly kind: "needs-layout" }
  /** 尚未获得空间（祖先塌断或不在视口）⇒ 等宿主重新给空间，不报失败。 */
  | { readonly kind: "pending-space" };

/**
 * 单个锚点宿主的可见性判定。
 *
 * 🔴 **顺序即语义**：`hostOk` 必须在最前。宿主自身零尺寸 ⇒ 那是"还没拿到空间"
 * （折叠/最小化/面板关闭），**不是失败**——把它判成 failed 就会在用户收起面板时
 * 弹一条"编辑器加载失败"，这正是 04/07 评审里那个假缺陷的同族形态。
 */
export function classifyHost(facts: EditorHostFacts): EditorHostVerdict {
  const hostOk = facts.offsetW > 0 && facts.offsetH > 0;
  if (!hostOk) return { kind: "pending-space" };
  if (facts.ancestorBreak !== null || !facts.inViewport) return { kind: "pending-space" };
  if (facts.scrollableCount === 0) return { kind: "needs-layout" };
  return { kind: "ok" };
}

/**
 * 是否应显示失败占位。
 *
 * 只有 `failed` 才显示——`pending-space` 与 `needs-layout` 都是**可自愈**状态，
 * 弹错误等于把"用户还没展开面板"说成"产品坏了"。
 */
export function shouldShowFailure(verdict: EditorHostVerdict): boolean {
  return verdict.kind === "failed";
}

/** 失败占位文案。`reason` 由调用方给（装配失败 / chunk 失败 / 布局恢复失败）。 */
export function recoveryNotice(reason: string): {
  readonly title: string;
  readonly detail: string;
  readonly action: string;
} {
  return {
    title: "编辑器未能加载",
    // 三条边界写进文案：不清草稿、不恢复旧许可、不以重启为唯一出口
    detail: `${reason}。草稿与目标保持原样，重试只恢复这一个编辑器。`,
    action: "就地重试",
  };
}

/**
 * 尺寸恢复：**从零/无空间恢复到有空间**时该做什么。
 *
 * 返回 `null` 表示不需要动（避免 observer 循环重建——每帧调 `layout()` 会与
 * 观察回调互相触发，这是"重建风暴"的来源）。
 */
export function layoutRecoveryAction(
  before: { readonly offsetW: number; readonly offsetH: number },
  after: { readonly offsetW: number; readonly offsetH: number },
): "relayout" | null {
  const gainedSpace =
    after.offsetW > 0 && after.offsetH > 0 && (before.offsetW === 0 || before.offsetH === 0);
  return gainedSpace ? "relayout" : null;
}

/**
 * 重挂（remount）时该保留什么 —— 契约的单一出处。
 *
 * spec：「恢复 SHALL 保留目标草稿、完整非法文本、model/view state，不自动提交」。
 * `remount` 形参当前**恒为 false**（本轮只做 layout 恢复，不重挂）；写成入参是为了
 * 将来真需要重挂时有明确判据，而不是临场决定丢什么。
 */
export function preservedOnRecovery(remount: boolean): {
  readonly keepDraft: true;
  readonly keepIllegalText: true;
  readonly keepViewState: true;
  readonly autoSubmit: false;
  readonly restoreOldPermission: false;
} {
  void remount;
  return {
    keepDraft: true,
    keepIllegalText: true,
    keepViewState: true,
    autoSubmit: false,
    restoreOldPermission: false,
  };
}
