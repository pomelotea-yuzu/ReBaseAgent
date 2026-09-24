import type { RunDetail } from "@shared/ipc";

import type { CreateRunMode } from "./create-run";

/**
 * U3（preserve-debugging-drafts）任务 1.1/1.2/1.3：会话调试草稿的键、基线、
 * 无损字符串存储、dirty 派生与 CAS 放弃。
 *
 * 设计依据 design.md D1/D3/D4：
 * - result / system_prompt / user_message / messages 按「当前父本 runId + spanId + 字段」隔离；
 *   继承 span 使用**当前作为父本**的 runId，不把共同祖先的编辑共享到子/兄弟运行。
 * - 创建与 A/B 各保留**独立数据结构**（不抽象成任意字段的通用表单引擎）：
 *   · 创建 = 会话内单份 {mode, systemPrompt, userMessage}；目录引用是独立会话字段，
 *     授权（writesAuthorized）、凭据、dry-run 计划一律**不进**草稿。
 *   · A/B = runId + 起始 llm spanId 下的整批有序臂，臂带**稳定行 ID**；
 *     dirty 只比较语义字段与行顺序，不比较随机行 ID；初始臂不算修改。
 * - 键用结构化嵌套索引，不做可能碰撞的字符串拼接。
 * - 无损保存用户原始字符串：末尾空白、换行、空串、非法 JSON 一律原样；解析只在校验/提交
 *   边界进行，本模块绝不 parse/stringify 后回写编辑器。
 * - 修订号由**全 slice 共享**的会话内单调计数器分配：条目创建与每次实际内容变化各分配
 *   一次；恢复/收起/查看/相同内容重复写入不推进。计数器只增不减 ⇒ 放弃后重建同 key
 *   也不复用旧修订（防 ABA）。
 * - dirty 是纯派生：内容偏离基线即有未放弃的编辑；改回基线 dirty=false（条目保留）。
 *   仓库**不自动淘汰** dirty 条目。
 * - 放弃走 key + revision 的 CAS：确认打开时记下修订，执行放弃时修订已推进 ⇒ 拒绝删除，
 *   旧确认不作数。
 * - 草稿只在 renderer 内存：不写 localStorage / sessionStorage / URL / 日志 / settings / trace。
 *
 * 选择器引用稳定（zustand 快照约束，同 reading-state 的教训）：写入只沿嵌套路径复制，
 * 未触及条目的对象引用保持不变；无实际变化的写入返回原仓库引用。
 */

// ---------------------------------------------------------------------------
// 调用类草稿（任务 1.1/1.2）
// ---------------------------------------------------------------------------

/** 调用类草稿的字段 */
export type CallDraftField = "result" | "system_prompt" | "user_message" | "messages";

// ---------------------------------------------------------------------------
// 源基线（任务 1.4，design D2）：编辑目标在登记时刻的已校验源事实
// ---------------------------------------------------------------------------

/**
 * 「源基线」：登记草稿那一刻，已校验详情里编辑目标所依赖的源身份与内容事实。
 *
 * 恢复草稿时由 `lib/draft-source.ts` 的重验函数与当前详情逐项比较：缺失、损坏、
 * 内容改变或资格失效 ⇒ 保留草稿但禁止提交，不静默用新原文重置基线（design D2）。
 *
 * - 只存事实、不做算法版本签名或迁移：草稿不跨 renderer 会话，恢复只比较事实源
 *   与当前门禁，无需升级路径（design D2 明文）。
 * - 不含授权、凭据、dry-run 计划（D1/D4 纪律同前）。
 * - 事实输入来自**已通过 schema 校验**的详情（store 的 detail 字段），不在本层重验格式。
 */
export interface CallDraftSource {
  /** run 级资格事实：登记时刻的已校验值（恢复时逐项与当前详情比较） */
  readonly runStatus: RunDetail["status"];
  /** 自有叶子 span 集（各执行入口「leafOwned」判据的输入） */
  readonly leafSpanIds: readonly string[];
  /** 源配置指纹（prompt fork / A/B 入口判据；undefined = 代理录制缺省，事实照存） */
  readonly configHash: string | undefined;
  /** 录制来源是本地代理（messages 重发入口的资格事实） */
  readonly proxy: boolean;
  /** 隔离文件运行（prompt fork / A/B 的入口排除项；result 续跑走只读预检） */
  readonly isolated: boolean;
  /** 目标 span 的内容事实：重建请求所依赖字段（恢复时按编辑字段选用比较） */
  readonly target: CallDraftTargetFacts;
}

/** 目标 span 的内容事实。llm.call 记录重建请求所依赖字段的签名与启动文本 */
export type CallDraftTargetFacts =
  | {
      readonly kind: "llm.call";
      /** 首条字符串 system / user 消息（prompt fork 两字段的直接编辑对象） */
      readonly startupSystem: string | null;
      readonly startupUser: string | null;
      /** 父录制模型（A/B 空 fork 判据输入） */
      readonly model: string;
      /** scalarRequestParams 的稳定 JSON 签名（A/B 继承/空 fork 判据输入） */
      readonly paramsSignature: string;
      /** 工具表签名（risky 工具判据与 config 指纹的输入） */
      readonly toolsSignature: string;
      /** 完整请求消息签名（messages 字段的编辑对象；prompt 字段经启动文本覆盖） */
      readonly messagesSignature: string;
    }
  | {
      /** tool.invoke 的 result 编辑：源内容 = 登记时的结果文本，已存于条目 baseline */
      readonly kind: "tool.invoke";
    };

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
  /**
   * 任务 1.4：登记时刻的源基线（undefined = 旧条目无源基线；恢复重验时按
   * 「无法核对来源」保守拒绝——宁可禁执行，不可拿错误来源放行）。
   * 只在条目创建时写入；重开编辑**不覆盖**（与 baseline 同纪律）。
   */
  readonly source?: CallDraftSource;
}

// ---------------------------------------------------------------------------
// 创建表单草稿（任务 1.3）：会话内单份；目录引用/授权/凭据不在此结构
// ---------------------------------------------------------------------------

/** 创建草稿条目（相对默认纯对话空表单比较 dirty；模式修改也算 dirty） */
export interface CreateRunDraftEntry {
  readonly mode: CreateRunMode;
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly revision: number;
}

export interface CreateRunDraftPatch {
  readonly mode?: CreateRunMode;
  readonly systemPrompt?: string;
  readonly userMessage?: string;
}

// ---------------------------------------------------------------------------
// A/B 批次草稿（任务 1.3）：整批有序臂 + 稳定行 ID；授权/计划不在此结构
// ---------------------------------------------------------------------------

/** A/B 批次草稿键：父本 runId + 起始 llm spanId */
export interface ModelAbDraftKey {
  readonly runId: string;
  readonly spanId: string;
}

/** 单臂草稿行：稳定行 ID（增删/重排不变）+ 原样文本（非法 JSON 不清洗） */
export interface ModelAbArmRow {
  readonly key: string;
  readonly model: string;
  readonly paramsText: string;
}

/** 基线臂内容：语义字段，不含随机行 ID（dirty 比较不看行 ID） */
export interface ModelAbBaselineArm {
  readonly model: string;
  readonly paramsText: string;
}

export interface ModelAbDraftEntry {
  /** 编辑器打开时的初始臂内容（放弃整批后由此恢复） */
  readonly baseline: ReadonlyArray<ModelAbBaselineArm>;
  readonly rows: ReadonlyArray<ModelAbArmRow>;
  /** 批次修订：增删行/改语义字段/改顺序都推进；仅行 ID 变化不推进 */
  readonly revision: number;
  /** 任务 1.4：登记时刻的源基线（纪律同 CallDraftEntry.source） */
  readonly source?: CallDraftSource;
}

/** 行 ID 生成器（模块级单调；与 DetailPanel 旧 armKeySeq 语义一致，任务 2.4 迁移用） */
let armRowKeySeq = 0;
export function newArmRowKey(): string {
  armRowKeySeq += 1;
  return `arm-${armRowKeySeq}`;
}

// ---------------------------------------------------------------------------
// 仓库：三区 + 全 slice 共享的单调修订分配器
// ---------------------------------------------------------------------------

export interface DraftRepo {
  /** 调用类草稿：runId → spanId → field → entry */
  readonly calls: Readonly<
    Record<
      string,
      Readonly<Record<string, Readonly<Partial<Record<CallDraftField, CallDraftEntry>>>>>
    >
  >;
  /** A/B 批次草稿：runId → spanId → entry */
  readonly modelAb: Readonly<Record<string, Readonly<Record<string, ModelAbDraftEntry>>>>;
  /** 创建表单草稿（会话内单份；null = 默认空表单，未冒充草稿） */
  readonly create: CreateRunDraftEntry | null;
  /** 会话内单调修订分配器：只增不减，删除重建不复用（防 ABA） */
  readonly nextRevision: number;
}

/** 全新空仓库（store 初始化与测试复位用；每次返回新实例，只读不共享可变状态） */
export function emptyDraftRepo(): DraftRepo {
  return { calls: {}, modelAb: {}, create: null, nextRevision: 1 };
}

// ---------------------------------------------------------------------------
// 调用类草稿读写（任务 1.1/1.2）
// ---------------------------------------------------------------------------

/** 读取某编辑目标的草稿条目；不存在返回 undefined，不改动仓库 */
export function callDraftOf(repo: DraftRepo, key: CallDraftKey): CallDraftEntry | undefined {
  return repo.calls[key.runId]?.[key.spanId]?.[key.field];
}

export interface EnsureCallDraftResult {
  /** 条目已存在时与入参仓库同引用（无变化不触发 store 更新） */
  readonly repo: DraftRepo;
  /** 最终生效的条目（已存在则原条目，否则新建） */
  readonly entry: CallDraftEntry;
}

/**
 * 编辑器打开时登记基线：不存在则新建（text = baseline，分配新修订）；
 * 已存在则**原样保留**（不覆盖基线、不推进修订、不换源基线——恢复/重开编辑不得覆盖已有输入）。
 * `source` 为任务 1.4 的源基线：只在创建时随条目落库，来自已校验详情。
 */
export function ensureCallDraft(
  repo: DraftRepo,
  key: CallDraftKey,
  baseline: string,
  source?: CallDraftSource,
): EnsureCallDraftResult {
  const existing = callDraftOf(repo, key);
  if (existing !== undefined) return { repo, entry: existing };
  const entry: CallDraftEntry = { baseline, text: baseline, revision: repo.nextRevision, source };
  return { repo: putCallEntry(repo, key, entry, repo.nextRevision + 1), entry };
}

/**
 * 输入事件同步写入原始文本（design D1：不得仅靠 debounce / 失焦 / 卸载保存最后一次输入）。
 * - 条目不存在 ⇒ 编辑器没走 ensure（接线契约），此处不猜测基线、直接忽略：
 *   把首次键入结果当基线会毁掉 dirty 语义，宁缺勿错。
 * - 文本与当前相同（含恢复/重复同步）⇒ 返回原仓库引用，不推进修订。
 * - 实际内容变化 ⇒ 新修订（含改回基线的动作：那也是内容变化），计数器只增不减。
 */
export function writeCallDraftText(repo: DraftRepo, key: CallDraftKey, text: string): DraftRepo {
  const existing = callDraftOf(repo, key);
  if (existing === undefined) return repo;
  if (existing.text === text) return repo;
  return putCallEntry(
    repo,
    key,
    { ...existing, text, revision: repo.nextRevision },
    repo.nextRevision + 1,
  );
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

export interface DiscardResult {
  /** 放弃成功时为新仓库引用；未删除时与入参同引用（不触发 store 更新） */
  readonly repo: DraftRepo;
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
  repo: DraftRepo,
  key: CallDraftKey,
  expectedRevision: number,
): DiscardResult {
  const entry = callDraftOf(repo, key);
  if (entry === undefined || entry.revision !== expectedRevision) {
    return { repo, discarded: false };
  }
  const run = repo.calls[key.runId] ?? {};
  const span = run[key.spanId] ?? {};
  const nextSpan = { ...span };
  delete nextSpan[key.field];
  const nextByRun = { ...repo.calls };
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
  return { repo: { ...repo, calls: nextByRun }, discarded: true };
}

/** 沿嵌套路径不可变写入：只复制路径上的对象，兄弟条目引用保持不变 */
function putCallEntry(
  repo: DraftRepo,
  key: CallDraftKey,
  entry: CallDraftEntry,
  nextRevision: number,
): DraftRepo {
  const run = repo.calls[key.runId] ?? {};
  const span = run[key.spanId] ?? {};
  return {
    ...repo,
    calls: {
      ...repo.calls,
      [key.runId]: { ...run, [key.spanId]: { ...span, [key.field]: entry } },
    },
    nextRevision,
  };
}

// ---------------------------------------------------------------------------
// 创建表单草稿（任务 1.3）
// ---------------------------------------------------------------------------

/**
 * 打开创建流程时读取或初始化草稿：已存在原样返回（不推进修订）；
 * 不存在则以默认纯对话空表单为内容分配新修订（dirty 派生为 false，不冒充草稿）。
 */
export function ensureCreateRunDraft(repo: DraftRepo): EnsureCreateRunDraftResult {
  if (repo.create !== null) return { repo, entry: repo.create };
  const entry: CreateRunDraftEntry = {
    mode: "chat",
    systemPrompt: "",
    userMessage: "",
    revision: repo.nextRevision,
  };
  return { repo: { ...repo, create: entry, nextRevision: repo.nextRevision + 1 }, entry };
}

export interface EnsureCreateRunDraftResult {
  /** 无变化时与入参仓库同引用 */
  readonly repo: DraftRepo;
  readonly entry: CreateRunDraftEntry;
}

/**
 * 合并写入创建草稿（切模式只传 mode ⇒ 文本保留，即「切创建模式保留文本」）。
 * - 未 ensure（null）⇒ 忽略（接线契约同调用类草稿）；
 * - 无实际内容变化 ⇒ 返回原仓库引用，不推进修订；
 * - 任一字段实际变化（含模式切换）⇒ 新修订。
 */
export function writeCreateRunDraft(repo: DraftRepo, patch: CreateRunDraftPatch): DraftRepo {
  const cur = repo.create;
  if (cur === null) return repo;
  const next = {
    mode: patch.mode ?? cur.mode,
    systemPrompt: patch.systemPrompt ?? cur.systemPrompt,
    userMessage: patch.userMessage ?? cur.userMessage,
  };
  if (
    next.mode === cur.mode &&
    next.systemPrompt === cur.systemPrompt &&
    next.userMessage === cur.userMessage
  ) {
    return repo;
  }
  return {
    ...repo,
    create: { ...cur, ...next, revision: repo.nextRevision },
    nextRevision: repo.nextRevision + 1,
  };
}

/** 创建 dirty：相对默认纯对话空表单比较；模式修改也算 dirty */
export function isCreateRunDraftDirty(entry: CreateRunDraftEntry): boolean {
  return entry.mode !== "chat" || entry.systemPrompt !== "" || entry.userMessage !== "";
}

/**
 * 放弃创建草稿（CAS）：确认后恢复默认空表单 = 删除条目；旧确认（修订已推进）不动仓库。
 * 目录引用的清除由 store 接线负责（引用独立于草稿，design D4）。
 */
export function discardCreateRunDraft(repo: DraftRepo, expectedRevision: number): DiscardResult {
  if (repo.create === null || repo.create.revision !== expectedRevision) {
    return { repo, discarded: false };
  }
  return { repo: { ...repo, create: null }, discarded: true };
}

// ---------------------------------------------------------------------------
// A/B 批次草稿（任务 1.3）
// ---------------------------------------------------------------------------

/** 读取某父本起始调用的批次草稿；不存在返回 undefined，不改动仓库 */
export function modelAbDraftOf(
  repo: DraftRepo,
  key: ModelAbDraftKey,
): ModelAbDraftEntry | undefined {
  return repo.modelAb[key.runId]?.[key.spanId];
}

export interface EnsureModelAbDraftResult {
  /** 已存在时与入参仓库同引用（重开编辑不覆盖已有批次、不推进修订） */
  readonly repo: DraftRepo;
  readonly entry: ModelAbDraftEntry;
}

/**
 * 打开 A/B 编辑器时登记批次：不存在则以传入基线臂初始化（每臂分配稳定行 ID）；
 * 已存在则原样保留（不覆盖、不推进修订、不换源基线）。
 * `source` 为任务 1.4 的源基线：只在创建时随条目落库，来自已校验详情。
 */
export function ensureModelAbDraft(
  repo: DraftRepo,
  key: ModelAbDraftKey,
  baselineArms: ReadonlyArray<ModelAbBaselineArm>,
  source?: CallDraftSource,
): EnsureModelAbDraftResult {
  const existing = modelAbDraftOf(repo, key);
  if (existing !== undefined) return { repo, entry: existing };
  const entry: ModelAbDraftEntry = {
    baseline: baselineArms.map((arm) => ({ ...arm })),
    rows: baselineArms.map((arm) => ({
      key: newArmRowKey(),
      model: arm.model,
      paramsText: arm.paramsText,
    })),
    revision: repo.nextRevision,
    source,
  };
  return { repo: putModelAbEntry(repo, key, entry, repo.nextRevision + 1), entry };
}

/** 语义序列比较：只看 (model, paramsText) 与顺序，不比较随机行 ID（design D1） */
function sameSemanticSequence(
  a: ReadonlyArray<ModelAbBaselineArm>,
  b: ReadonlyArray<ModelAbBaselineArm>,
): boolean {
  if (a.length !== b.length) return false;
  return a.every((arm, i) => {
    const other = b[i];
    return other !== undefined && arm.model === other.model && arm.paramsText === other.paramsText;
  });
}

/**
 * 整批替换行列表（增删行/改内容/重排都经此，任务 2.4 接线）。
 * - 未 ensure ⇒ 忽略；
 * - 语义序列与行 ID 都不变 ⇒ 返回原仓库引用；
 * - 仅行 ID 变化（语义不变，如删掉一条同内容臂再原样加回）⇒ 更新行引用但**不推进修订**
 *   （行 ID 不是内容）；
 * - 语义序列变化（内容/数量/顺序）⇒ 新修订。
 */
export function setModelAbRows(
  repo: DraftRepo,
  key: ModelAbDraftKey,
  rows: ReadonlyArray<ModelAbArmRow>,
): DraftRepo {
  const existing = modelAbDraftOf(repo, key);
  if (existing === undefined) return repo;
  const semanticSame = sameSemanticSequence(existing.rows, rows);
  const keysSame =
    existing.rows.length === rows.length &&
    existing.rows.every((row, i) => {
      const other = rows[i];
      return other !== undefined && row.key === other.key;
    });
  if (semanticSame && keysSame) return repo;
  if (semanticSame) {
    return putModelAbEntry(repo, key, { ...existing, rows: [...rows] }, repo.nextRevision);
  }
  return putModelAbEntry(
    repo,
    key,
    { ...existing, rows: [...rows], revision: repo.nextRevision },
    repo.nextRevision + 1,
  );
}

/** A/B dirty：行语义序列偏离基线（内容/数量/顺序任一变化）；初始臂不算修改 */
export function isModelAbDraftDirty(entry: ModelAbDraftEntry): boolean {
  return !sameSemanticSequence(entry.baseline, entry.rows);
}

/**
 * 放弃整个 A/B 批次（CAS）：确认后删除条目，编辑器下次打开以基线重建；
 * 确认后批次又变（修订推进）⇒ 旧确认不动仓库。仓库不自动淘汰 dirty 批次。
 */
export function discardModelAbDraft(
  repo: DraftRepo,
  key: ModelAbDraftKey,
  expectedRevision: number,
): DiscardResult {
  const entry = modelAbDraftOf(repo, key);
  if (entry === undefined || entry.revision !== expectedRevision) {
    return { repo, discarded: false };
  }
  const run = repo.modelAb[key.runId] ?? {};
  const nextByRun = { ...repo.modelAb };
  const nextRun = { ...run };
  delete nextRun[key.spanId];
  if (Object.keys(nextRun).length === 0) {
    delete nextByRun[key.runId];
  } else {
    nextByRun[key.runId] = nextRun;
  }
  return { repo: { ...repo, modelAb: nextByRun }, discarded: true };
}

/** 沿嵌套路径不可变写入：只复制路径上的对象，兄弟批次引用保持不变 */
function putModelAbEntry(
  repo: DraftRepo,
  key: ModelAbDraftKey,
  entry: ModelAbDraftEntry,
  nextRevision: number,
): DraftRepo {
  const run = repo.modelAb[key.runId] ?? {};
  return {
    ...repo,
    modelAb: { ...repo.modelAb, [key.runId]: { ...run, [key.spanId]: entry } },
    nextRevision,
  };
}

// ---------------------------------------------------------------------------
// 创建源目录引用（任务 1.3，design D4）：独立受限会话引用，**不属于** DraftRepo
// ---------------------------------------------------------------------------

/**
 * 创建源目录的会话引用：仅含 main 已签发 token 与用于核对的 name/path。
 * 授权（writesAuthorized）、有效期判定、dry-run 计划都不在此——main 是 token
 * 是否有效的唯一判定者；本引用不写阅读偏好或任何持久状态。
 */
export interface CreateSourceRef {
  readonly token: string;
  readonly name: string;
  readonly path: string;
}
