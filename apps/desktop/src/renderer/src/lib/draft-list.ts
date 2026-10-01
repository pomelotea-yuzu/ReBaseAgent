import {
  type DraftRepo,
  isCallDraftDirty,
  isCreateRunDraftDirty,
  isModelAbDraftDirty,
} from "./debugging-drafts";
import type { RecordingDraft } from "./recording-draft";
import { isRecordingDraftDirty } from "./recording-draft";

/**
 * U3（preserve-debugging-drafts）任务 2.5：草稿列表与调用旁标记的**纯逻辑**。
 *
 * 设计依据 design.md D2：
 * - 步骤页的「本运行草稿列表」与全局栏的「会话草稿入口」**复用同一份派生与同一张
 *   列表视图**（不再造第二份存储）：本模块只按 runId 过滤，视图组件共用。
 * - 列表条目携带**可辨认的运行和字段身份**（runId + spanId + field）与完整可复制
 *   文本（`copyText` 不截断）；`preview` 只是展示截断。
 * - 「定位」= 把条目身份交给 store 的 `openDraftAt`（切运行/页签/选中 span 或打开
 *   创建表单）；定位失效（源记录缺失/损坏/改变）由编辑器内 1.4 的重验函数裁决，
 *   失效视图（复制/放弃）在编辑器与列表两处都可达。
 * - 创建草稿没有 run 身份（runId 为空串），仅在全会话列表出现，不进本运行过滤结果。
 */

/** 草稿种类：调用类四字段 + A/B 批次 + 创建表单 */
export type DraftKind =
  | "result"
  | "system_prompt"
  | "user_message"
  | "messages"
  | "model_ab"
  | "create";

/** 列表与定位界面的人类可读字段名（spec：「展示可辨认的运行和字段身份」） */
export const DRAFT_KIND_LABELS: Record<DraftKind, string> = {
  result: "工具结果重跑",
  system_prompt: "prompt · system",
  user_message: "prompt · user",
  messages: "messages 重发",
  model_ab: "模型 A/B 批次",
  create: "新建运行表单",
};

export interface DraftListItem {
  readonly runId: string;
  /** 创建草稿无 span 身份（null） */
  readonly spanId: string | null;
  readonly field: DraftKind;
  /** 稳定列表 key（渲染 key 与测试定位用，不是编辑身份——编辑身份是 runId+spanId+field） */
  readonly listKey: string;
  readonly title: string;
  /** 展示预览（截断、换行可见化；不做 trim/清洗） */
  readonly preview: string;
  /** 完整可复制文本（不截断：A/B 为行摘要 JSON，创建为表单 JSON） */
  readonly copyText: string;
  readonly dirty: boolean;
  readonly revision: number;
}

/** 预览截断上限（字符；换行以 ⏎ 可见化，正文不丢——完整内容走 copyText） */
const PREVIEW_MAX = 80;

export function truncatePreview(text: string, max: number = PREVIEW_MAX): string {
  const flat = text.replace(/\r?\n/g, "⏎");
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * 派生草稿列表（全会话；`filter.runId` 提供时只含该运行，创建草稿被排除——
 * 它不属于任何运行）。顺序：调用类 → A/B → 创建，遍历序稳定（对象键序）。
 */
export function deriveDraftList(
  repo: DraftRepo,
  filter?: { runId?: string | null },
): DraftListItem[] {
  const out: DraftListItem[] = [];
  const onlyRun = filter?.runId;

  for (const [runId, spans] of Object.entries(repo.calls)) {
    if (onlyRun !== undefined && onlyRun !== null && runId !== onlyRun) continue;
    for (const [spanId, fields] of Object.entries(spans)) {
      for (const field of ["result", "system_prompt", "user_message", "messages"] as const) {
        const entry = fields[field];
        if (entry === undefined) continue;
        out.push({
          runId,
          spanId,
          field,
          listKey: `${runId}|${spanId}|${field}`,
          title: DRAFT_KIND_LABELS[field],
          preview: truncatePreview(entry.text),
          copyText: entry.text,
          dirty: isCallDraftDirty(entry),
          revision: entry.revision,
        });
      }
    }
  }

  for (const [runId, spans] of Object.entries(repo.modelAb)) {
    if (onlyRun !== undefined && onlyRun !== null && runId !== onlyRun) continue;
    for (const [spanId, entry] of Object.entries(spans)) {
      const copyText = JSON.stringify(
        entry.rows.map((r) => ({ model: r.model, paramsText: r.paramsText })),
      );
      out.push({
        runId,
        spanId,
        field: "model_ab",
        listKey: `${runId}|${spanId}|model_ab`,
        title: DRAFT_KIND_LABELS.model_ab,
        preview: truncatePreview(
          entry.rows
            .map((r) => `${r.model}(${r.paramsText === "" ? "沿用父 params" : r.paramsText})`)
            .join(" / "),
        ),
        copyText,
        dirty: isModelAbDraftDirty(entry),
        revision: entry.revision,
      });
    }
  }

  // 创建草稿不属于任何运行：只在全会话视图（未按 run 过滤）出现
  if (repo.create !== null && (onlyRun === undefined || onlyRun === null)) {
    const create = repo.create;
    const copyText = JSON.stringify({
      mode: create.mode,
      systemPrompt: create.systemPrompt,
      userMessage: create.userMessage,
    });
    out.push({
      runId: "",
      spanId: null,
      field: "create",
      listKey: "|create",
      title: DRAFT_KIND_LABELS.create,
      preview: truncatePreview(`[${create.mode}] ${create.userMessage || create.systemPrompt}`),
      copyText,
      dirty: isCreateRunDraftDirty(create),
      revision: create.revision,
    });
  }

  return out;
}

/**
 * dirty 草稿计数（U3 任务 4.2 关闭协商的元数据源）：
 * 复用列表派生的 dirty 判定，保证「徽章/列表看到的 dirty」与「上报给 main 的
 * dirtyCount」是**同一口径**——两处判定不得漂移。
 * 全会话口径：调用类 + A/B 批次 + 创建表单（含未通过校验的输入）。
 */
export function dirtyCountOf(repo: DraftRepo): number {
  return deriveDraftList(repo).filter((item) => item.dirty).length;
}

/**
 * U8 任务 2.3：会话 dirty 计数（关闭协商上报口径）——**草稿仓库 + 录制配置草稿**合计。
 * 录制未应用修改单独算一条（「只有录制草稿未应用」也要触发退出保护）；
 * baseline 未读时 isRecordingDraftDirty 已判不 dirty（默认表单不误报）。
 */
export function sessionDirtyCountOf(
  repo: DraftRepo,
  recordingDraft: RecordingDraft | null,
): number {
  return (
    dirtyCountOf(repo) + (recordingDraft !== null && isRecordingDraftDirty(recordingDraft) ? 1 : 0)
  );
}

/** 调用旁草稿标记（llm.call / tool.invoke 头部小徽章）；null = 该调用无草稿 */
export function draftBadgeForSpan(
  repo: DraftRepo,
  runId: string,
  spanId: string,
): { label: string; dirty: boolean } | null {
  const fields = repo.calls[runId]?.[spanId];
  const ab = repo.modelAb[runId]?.[spanId];
  const labels: string[] = [];
  let dirty = false;

  if (fields !== undefined) {
    for (const field of ["result", "system_prompt", "user_message", "messages"] as const) {
      const entry = fields[field];
      if (entry === undefined) continue;
      labels.push(DRAFT_KIND_LABELS[field]);
      if (isCallDraftDirty(entry)) dirty = true;
    }
  }
  if (ab !== undefined) {
    labels.push(DRAFT_KIND_LABELS.model_ab);
    if (isModelAbDraftDirty(ab)) dirty = true;
  }

  if (labels.length === 0) return null;
  return {
    label: labels.length === 1 ? `草稿：${labels[0]}` : `草稿 ×${labels.length}`,
    dirty,
  };
}
