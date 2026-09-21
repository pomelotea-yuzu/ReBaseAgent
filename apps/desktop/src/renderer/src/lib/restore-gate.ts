/**
 * 内容挂载后恢复阅读位置的门控（U1 共用派生 · 任务 3.6）。
 *
 * 为什么需要它：scroll 恢复动作会被触发**不止一次**——详情从加载中切到加载完成、
 * 页签来回切、分支/设置往返都会重新挂载滚动容器。无门控地恢复会出两种事故：
 *
 * 1. **内容还没挂载就恢复**：容器 `scrollHeight` 还是 0（或只有占位骨架），写进去的
 *    `scrollTop` 会被浏览器夹成 0 —— 用户"恢复"到了顶部，看起来像位置丢了。
 * 2. **恢复过了又被覆盖**：用户已经在恢复后往下滚了几屏，此时迟到的恢复动作再写一次
 *    旧位置，会把用户读数顶回去（"恢复"变成"回滚"）。
 *
 * 故恢复必须满足三个条件，且**每个「内容身份」只允许恢复一次**：
 * - 内容已就绪（详情不是加载中/失败态）；
 * - 该 run 的详情身份（`detailKey`，取 `meta.id`）发生了变化或与上次恢复的相同但尚未恢复过；
 * - 容器已完成布局（高度可测，见 `canRestoreScroll`）。
 *
 * 纪律：**「没恢复过」和「不能恢复」是两回事**。前者允许重试（内容晚一点挂载完再来一次），
 * 后者是硬性拒绝（加载中就是不恢复）。用同一个布尔值表达两者会导致内容永挂载不出来的场景
 * 下无限重试，或内容终于就绪却因为"试过一次"而放弃恢复。
 */

/** 一次恢复动作的判定结果 */
export interface RestoreDecision {
  /** 是否此刻执行恢复 */
  restore: boolean;
  /** 记录用的下一状态：不变或把 `restored` 置真 */
  next: RestoreState;
}

/** 每个目标（概览 / 步骤目录 / 调用详情）各自的恢复记账 */
export interface RestoreState {
  /** 已成功恢复过的内容身份（`detailKey`）；`null` = 还没恢复过任何内容 */
  restoredKey: string | null;
}

export const initialRestoreState: RestoreState = { restoredKey: null };

/** 该目标在给定内容身份下是否已经恢复过 */
export function hasRestored(state: RestoreState, detailKey: string): boolean {
  return state.restoredKey === detailKey;
}

/**
 * 判断此刻是否应当执行滚动恢复。
 *
 * @param state       该目标的恢复记账
 * @param detailKey   当前内容身份（run 的 `meta.id`；不同 run 视为不同内容）
 * @param contentReady 内容是否已就绪（加载中/失败/空态 ⇒ false）
 * @param measurable  容器是否已布局到可测高度（见 `canRestoreScroll`）
 *
 * 规则：内容没就绪 ⇒ 不恢复且**不记账**（下次内容就绪时仍可恢复）；
 *       已就绪但容器还没量出来 ⇒ 不恢复且不记账（等布局，允许重试）；
 *       已就绪且可测但这一内容已恢复过 ⇒ 不恢复（防"恢复覆盖用户后续滚动"）；
 *       否则 ⇒ 恢复并把该内容身份记为已恢复。
 */
export function decideRestore(input: {
  state: RestoreState;
  detailKey: string | null;
  contentReady: boolean;
  measurable: boolean;
}): RestoreDecision {
  if (input.detailKey === null) return { restore: false, next: input.state };
  if (!input.contentReady) return { restore: false, next: input.state };
  if (!input.measurable) return { restore: false, next: input.state };
  if (hasRestored(input.state, input.detailKey)) return { restore: false, next: input.state };
  return { restore: true, next: { restoredKey: input.detailKey } };
}

/**
 * 内容身份变了（切 run / 重读得到新详情）时是否应当作废恢复记账。
 *
 * 必须作废：否则 A→B→A 回到 A 时，A 的身份以 `meta.id` 计与上次相同，会被误判成
 * "已恢复过"从而**跳过**恢复——恰恰是 spec 场景「跨运行返回恢复阅读」要求生效的路径。
 */
/**
 * 内容身份变了（切 run / 重读）时作废恢复记账。
 *
 * ⚠️ **实测结论：本函数对「A→B→A 返回 A 仍恢复」不是必要条件。** `decideRestore` 只记
 * 一个 `restoredKey`，切到 B 时该值已被 B 覆盖，回 A 自然重新恢复——把本函数改成恒
 * `false`（永不作废）全套用例照样绿（已变异验证并据此收敛，不留"看起来有用"的死代码）。
 *
 * 它只用于表达"这两个身份不是一个内容"这一判断；真正让**同一 run 重读**重新武装恢复的是
 * `restoreIdentity` 把 span 指纹折进身份（内容变 ⇒ 身份变 ⇒ 恢复窗口自动重开）。
 */
export function shouldResetRestore(state: RestoreState, detailKey: string | null): boolean {
  if (detailKey === null) return state.restoredKey !== null;
  return state.restoredKey !== null && state.restoredKey !== detailKey;
}

/**
 * 由详情算出**内容身份**：`meta.id` + span 组成指纹。
 *
 * 为什么不能只用 `meta.id`：同一 run 被重读/重写后 id 不变，`decideRestore` 会以
 * "这个身份恢复过"跳过恢复，而内容可能整段变了（记录被裁剪、span 被换掉）——
 * 用户看到的是按旧内容裁剪过的位置。把 span id 序列折进身份，内容一变身份就变，
 * 恢复窗口自动重新打开（无需在 store 里为"同 run 重读"专门加一条清账通道）。
 *
 * 只取 span id 与数量：够区分内容变化，又不把正文副本带进任何状态（design D6 纪律）。
 */
export function restoreIdentity(detail: {
  meta: { id: string };
  spans: ReadonlyArray<{ id: string }>;
}): string {
  return `${detail.meta.id}#${detail.spans.length}#${detail.spans.map((s) => s.id).join(",")}`;
}
