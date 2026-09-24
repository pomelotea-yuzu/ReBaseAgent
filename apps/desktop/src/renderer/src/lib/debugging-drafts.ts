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
 *   查看/相同文本重复写入不推进。计数器只增不减 ⇒ 删除后重建同 key 也不复用旧修订（防 ABA；
 *   放弃动作与 dirty 派生在任务 1.2 接入）。
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
