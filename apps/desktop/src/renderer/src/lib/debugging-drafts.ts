/**
 * U3（preserve-debugging-drafts）任务 1.1：调用类调试草稿的键、基线与无损字符串存储。
 *
 * 设计依据 design.md D1：
 * - result / system_prompt / user_message / messages 按「当前父本 runId + spanId + 字段」隔离；
 *   继承 span 使用**当前作为父本**的 runId，不把共同祖先的编辑共享到子/兄弟运行。
 *   创建表单与 A/B 批次是独立数据结构（任务 1.3），不在此模块。
 * - 键用结构化嵌套索引（runId → spanId → field），不做可能碰撞的字符串拼接。
 * - 无损保存用户原始字符串：末尾空白、换行、空串、非法 JSON 一律原样；解析只在校验/提交
 *   边界进行，本模块绝不 parse/stringify 后回写编辑器。
 * - 修订号由仓库级单调计数器分配：条目创建与每次**实际内容变化**各分配一次；恢复/收起/
 *   查看/相同文本重复写入不推进。计数器只增不减 ⇒ 放弃后重建同 key 也不复用旧修订（防 ABA）。
 * - dirty 是纯派生：text !== baseline 即有未放弃的编辑；改回基线 dirty=false（条目保留，
 *   其后再次修改继续递增）。仓库**不自动淘汰** dirty 条目。
 * - 放弃走 key + revision 的 CAS：确认打开时记下修订，执行放弃时修订已推进 ⇒ 拒绝删除，
 *   旧确认不作数（任务 1.2）。
 * - 未发生编辑不创建 dirty 项：条目只在编辑器打开（ensure，传入已校验基线）时出现；
 *   ensure 不覆盖已有条目（来源改变的处理归任务 1.4，不得静默重置基线）。
 * - 草稿只在 renderer 内存：不写 localStorage / sessionStorage / URL / 日志 / settings / trace。
 *
 * 选择器引用稳定（zustand 快照约束，同 reading-state 的教训）：写入只沿嵌套路径复制，
 * 未触及条目的对象引用保持不变；相同文本的重复写入返回原仓库引用。
 */

/** 调用类草稿的字段（创建/A-B 批次草稿是独立结构，见任务 1.3） */
export type CallDraftField = "result" | "system_prompt" | "user_message" | "messages";

/** 编辑身份：当前父本 runId + 调用 spanId + 字段。相同 span ID 的不同 run 不串草稿 */
export interface CallDraftKey {
  readonly runId: string;
  readonly spanId: string;
  readonly field: CallDraftField;
}

/** 单个编辑目标的草稿条目 */
export interface CallDraftEntry {
  /** 只读基线：编辑器打开时由已校验详情提供的原文 */
  readonly baseline: string;
  /** 用户原始输入（无损：空白/换行/空串/非法 JSON 原样保留） */
  readonly text: string;
  /** 创建时分配、每次实际内容变化时递增的会话内修订号 */
  readonly revision: number;
}

/** 草稿仓库：嵌套索引 + 会话内单调修订分配器 */
export interface CallDraftRepo {
  readonly byRun: Readonly<
    Record<
      string,
      Readonly<Record<string, Readonly<Partial<Record<CallDraftField, CallDraftEntry>>>>>
    >
  >;
  readonly nextRevision: number;
}

/** 全新空仓库（store 初始化与测试复位用；每次返回新实例，只读不共享可变状态） */
export function emptyCallDraftRepo(): CallDraftRepo {
  return { byRun: {}, nextRevision: 1 };
}

/** 读取某编辑目标的草稿条目；不存在返回 undefined，不改动仓库 */
export function callDraftOf(repo: CallDraftRepo, key: CallDraftKey): CallDraftEntry | undefined {
  return repo.byRun[key.runId]?.[key.spanId]?.[key.field];
}

export interface EnsureCallDraftResult {
  /** 条目已存在时与入参仓库同引用（无变化不触发 store 更新） */
  readonly repo: CallDraftRepo;
  /** 最终生效的条目（已存在则原条目，否则新建） */
  readonly entry: CallDraftEntry;
}

/**
 * 编辑器打开时登记基线：不存在则新建（text = baseline，分配新修订）；
 * 已存在则**原样保留**（不覆盖基线、不推进修订——恢复/重开编辑不得覆盖已有输入）。
 */
export function ensureCallDraft(
  repo: CallDraftRepo,
  key: CallDraftKey,
  baseline: string,
): EnsureCallDraftResult {
  const existing = callDraftOf(repo, key);
  if (existing !== undefined) return { repo, entry: existing };
  const entry: CallDraftEntry = { baseline, text: baseline, revision: repo.nextRevision };
  return { repo: putEntry(repo, key, entry, repo.nextRevision + 1), entry };
}

/**
 * 输入事件同步写入原始文本（设计 D1：不得仅靠 debounce / 失焦 / 卸载保存最后一次输入）。
 * - 条目不存在 ⇒ 编辑器没走 ensure（接线契约），此处不猜测基线、直接忽略：
 *   把首次键入结果当基线会毁掉 dirty 语义，宁缺勿错。
 * - 文本与当前相同（含恢复/重复同步）⇒ 返回原仓库引用，不推进修订。
 * - 实际内容变化 ⇒ 新修订（含改回基线的动作：那也是内容变化），计数器只增不减。
 */
export function writeCallDraftText(
  repo: CallDraftRepo,
  key: CallDraftKey,
  text: string,
): CallDraftRepo {
  const existing = callDraftOf(repo, key);
  if (existing === undefined) return repo;
  if (existing.text === text) return repo;
  return putEntry(
    repo,
    key,
    { ...existing, text, revision: repo.nextRevision },
    repo.nextRevision + 1,
  );
}

/** 沿嵌套路径不可变写入：只复制路径上的对象，兄弟条目引用保持不变 */
function putEntry(
  repo: CallDraftRepo,
  key: CallDraftKey,
  entry: CallDraftEntry,
  nextRevision: number,
): CallDraftRepo {
  const run = repo.byRun[key.runId] ?? {};
  const span = run[key.spanId] ?? {};
  return {
    byRun: {
      ...repo.byRun,
      [key.runId]: { ...run, [key.spanId]: { ...span, [key.field]: entry } },
    },
    nextRevision,
  };
}

/**
 * dirty 派生：text !== baseline 即有未放弃的编辑。
 * - 打开未编辑（ensure）⇒ false，不产生虚假 dirty；
 * - 清空为零长度、输入仅空白、非法 JSON 同样算 dirty（原样字符串比较，无 trim）；
 * - 改回基线 ⇒ false（标记消失），条目保留，其后再次修改继续递增修订。
 * dirty 只表示未放弃的编辑，不表示可提交或执行成功（能力门禁在既有流程）。
 */
export function isCallDraftDirty(entry: CallDraftEntry): boolean {
  return entry.text !== entry.baseline;
}

export interface DiscardCallDraftResult {
  /** 放弃成功时为新仓库引用；未删除时与入参同引用（不触发 store 更新） */
  readonly repo: CallDraftRepo;
  /** 是否真的删除了条目 */
  readonly discarded: boolean;
}

/**
 * 按 key + revision 的放弃校验（CAS 放弃，design D3）：
 * - 条目存在且修订与确认时一致 ⇒ 删除（沿路径剪枝空父级），兄弟条目引用不变；
 * - 确认等待期间内容又变（修订已推进）⇒ **拒绝删除**，旧确认不作数，须重新核对；
 * - 条目不存在（已放弃过 / 从未 ensure）⇒ 幂等，返回原仓库。
 * 删除不触碰修订计数器：重建同 key 必然拿到更新的修订。仓库不自动淘汰 dirty 条目。
 */
export function discardCallDraft(
  repo: CallDraftRepo,
  key: CallDraftKey,
  expectedRevision: number,
): DiscardCallDraftResult {
  const entry = callDraftOf(repo, key);
  if (entry === undefined || entry.revision !== expectedRevision) {
    return { repo, discarded: false };
  }
  const run = repo.byRun[key.runId] ?? {};
  const span = run[key.spanId] ?? {};
  const nextSpan = { ...span };
  delete nextSpan[key.field];
  const nextByRun = { ...repo.byRun };
  if (Object.keys(nextSpan).length === 0) {
    const nextRun = { ...run };
    delete nextRun[key.spanId];
    if (Object.keys(nextRun).length === 0) {
      delete nextByRun[key.runId];
    } else {
      nextByRun[key.runId] = nextRun;
    }
  } else {
    nextByRun[key.runId] = { ...run, [key.spanId]: nextSpan };
  }
  return { repo: { byRun: nextByRun, nextRevision: repo.nextRevision }, discarded: true };
}
