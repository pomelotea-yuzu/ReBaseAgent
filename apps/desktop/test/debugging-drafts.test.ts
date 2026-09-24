import { beforeEach, describe, expect, it } from "vitest";
import type {
  CallDraftKey,
  DraftRepo,
  ModelAbArmRow,
} from "../src/renderer/src/lib/debugging-drafts";
import {
  callDraftOf,
  discardCallDraft,
  discardCreateRunDraft,
  discardModelAbDraft,
  emptyDraftRepo,
  ensureCallDraft,
  ensureCreateRunDraft,
  ensureModelAbDraft,
  isCallDraftDirty,
  isCreateRunDraftDirty,
  isModelAbDraftDirty,
  modelAbDraftOf,
  newArmRowKey,
  setModelAbRows,
  writeCallDraftText,
  writeCreateRunDraft,
} from "../src/renderer/src/lib/debugging-drafts";

/**
 * U3（preserve-debugging-drafts）任务 1.1：调用类草稿的键、基线与无损字符串存储。
 *
 * 判据来源（desktop-ui delta「调试草稿按编辑身份保存在会话内」）：
 *   - 相同 span ID 和不同字段不串草稿
 *   - 非法 JSON 和空输入仍可暂存（原始输入不被格式化 / trim / 替换为原值）
 *   - 输入事件同步保存，修订号随实际内容变化递增；打开未编辑不产生虚假修订
 *
 * ⚠️ 本文件测纯逻辑层与 store 接线；编辑器组件消费（步骤往返逐字恢复）归任务 2.1/2.2。
 */

function key(runId: string, spanId: string, field: CallDraftKey["field"]): CallDraftKey {
  return { runId, spanId, field };
}

function abKey(runId: string, spanId: string) {
  return { runId, spanId };
}

function abRow(key: string, model: string, paramsText: string): ModelAbArmRow {
  return { key, model, paramsText };
}

/** A/B 初始两臂（与编辑器打开时的基线同形：parentModel + 空 paramsText） */
const BASELINE = [
  { model: "parent-model", paramsText: "" },
  { model: "parent-model", paramsText: "" },
];

describe("草稿键隔离（相同 span ID 和不同字段不串草稿）", () => {
  it("两个 run 的相同 span ID 各自独立", () => {
    let repo = emptyDraftRepo();
    repo = ensureCallDraft(repo, key("r_01", "s_03", "result"), "base-a").repo;
    repo = ensureCallDraft(repo, key("r_02", "s_03", "result"), "base-b").repo;
    repo = writeCallDraftText(repo, key("r_01", "s_03", "result"), "edited-a");

    expect(callDraftOf(repo, key("r_01", "s_03", "result"))?.text).toBe("edited-a");
    expect(callDraftOf(repo, key("r_02", "s_03", "result"))?.text).toBe("base-b");
  });

  it("同一 run 同一 span 的不同字段互不影响（切 prompt 字段不重置另一字段）", () => {
    let repo = emptyDraftRepo();
    repo = ensureCallDraft(repo, key("r_01", "s_01", "system_prompt"), "sys-base").repo;
    repo = ensureCallDraft(repo, key("r_01", "s_01", "user_message"), "user-base").repo;
    repo = writeCallDraftText(repo, key("r_01", "s_01", "system_prompt"), "sys-edited");

    expect(callDraftOf(repo, key("r_01", "s_01", "system_prompt"))?.text).toBe("sys-edited");
    expect(callDraftOf(repo, key("r_01", "s_01", "user_message"))?.text).toBe("user-base");
    // 各字段是独立修订流：写 system 不推进 user 的修订
    const sys = callDraftOf(repo, key("r_01", "s_01", "system_prompt"));
    const user = callDraftOf(repo, key("r_01", "s_01", "user_message"));
    expect(sys && user && sys.revision !== user.revision).toBe(true);
  });

  it("跨运行继承 span：编辑落在当前父本 runId 上，不共享到其他 run", () => {
    let repo = emptyDraftRepo();
    // 子运行以自己的 runId 持有继承 span 的编辑（键身份由调用方决定，存储只按键隔离）
    repo = ensureCallDraft(repo, key("r_child", "s_shared", "messages"), "[]").repo;
    repo = ensureCallDraft(repo, key("r_parent", "s_shared", "messages"), "[]").repo;
    repo = writeCallDraftText(repo, key("r_child", "s_shared", "messages"), "[1]");
    expect(callDraftOf(repo, key("r_parent", "s_shared", "messages"))?.text).toBe("[]");
  });
});

describe("无损字符串存储（非法 JSON 和空输入仍可暂存）", () => {
  it("非法 JSON 原样保留，不被格式化或替换为原值", () => {
    let repo = emptyDraftRepo();
    repo = ensureCallDraft(repo, key("r_01", "s_01", "messages"), `[{"role":"user"}]`).repo;
    const broken = `]{ 这是没写完的 JSON "role": "user"`;
    repo = writeCallDraftText(repo, key("r_01", "s_01", "messages"), broken);
    expect(callDraftOf(repo, key("r_01", "s_01", "messages"))?.text).toBe(broken);
  });

  it("空串、仅空白、末尾空白与换行逐字保留（不 trim）", () => {
    let repo = emptyDraftRepo();
    repo = ensureCallDraft(repo, key("r_01", "s_01", "result"), "original").repo;

    repo = writeCallDraftText(repo, key("r_01", "s_01", "result"), "");
    expect(callDraftOf(repo, key("r_01", "s_01", "result"))?.text).toBe("");

    const blank = "   \n\t  ";
    repo = writeCallDraftText(repo, key("r_01", "s_01", "result"), blank);
    expect(callDraftOf(repo, key("r_01", "s_01", "result"))?.text).toBe(blank);

    const trailing = "工具输出\n  \n";
    repo = writeCallDraftText(repo, key("r_01", "s_01", "result"), trailing);
    expect(callDraftOf(repo, key("r_01", "s_01", "result"))?.text).toBe(trailing);
  });

  it("基线本身也原样保存：打开编辑不清洗原 trace 文本", () => {
    const repo = ensureCallDraft(
      emptyDraftRepo(),
      key("r_01", "s_01", "system_prompt"),
      "  原始 system 指令\n",
    );
    expect(repo.entry.baseline).toBe("  原始 system 指令\n");
    expect(repo.entry.text).toBe("  原始 system 指令\n");
  });
});

describe("修订与基线（创建分配、实际内容变化推进）", () => {
  it("ensure 新建条目：text = baseline、分配新修订；再次 ensure 原样保留不推进", () => {
    let repo = emptyDraftRepo();
    const first = ensureCallDraft(repo, key("r_01", "s_01", "result"), "base");
    repo = first.repo;
    expect(first.entry).toEqual({ baseline: "base", text: "base", revision: 1 });

    // 重开编辑（含换了一个来源基线）：不覆盖、不推进——不得静默重置已有输入
    const second = ensureCallDraft(repo, key("r_01", "s_01", "result"), "另一份基线");
    expect(second.repo).toBe(repo);
    expect(second.entry).toBe(first.entry);
  });

  it("每次实际内容变化推进修订；相同文本重复写入不推进也不换引用", () => {
    let repo = emptyDraftRepo();
    repo = ensureCallDraft(repo, key("r_01", "s_01", "result"), "base").repo;

    repo = writeCallDraftText(repo, key("r_01", "s_01", "result"), "v1");
    expect(callDraftOf(repo, key("r_01", "s_01", "result"))?.revision).toBe(2);

    repo = writeCallDraftText(repo, key("r_01", "s_01", "result"), "v1");
    expect(callDraftOf(repo, key("r_01", "s_01", "result"))?.revision).toBe(2);

    repo = writeCallDraftText(repo, key("r_01", "s_01", "result"), "v2");
    expect(callDraftOf(repo, key("r_01", "s_01", "result"))?.revision).toBe(3);
  });

  it("改回基线也是内容变化：修订继续递增，条目保留且 text === baseline", () => {
    let repo = emptyDraftRepo();
    repo = ensureCallDraft(repo, key("r_01", "s_01", "result"), "base").repo;
    repo = writeCallDraftText(repo, key("r_01", "s_01", "result"), "changed");
    repo = writeCallDraftText(repo, key("r_01", "s_01", "result"), "base");

    const entry = callDraftOf(repo, key("r_01", "s_01", "result"));
    expect(entry?.text).toBe("base");
    expect(entry?.baseline).toBe("base");
    expect(entry?.revision).toBe(3);
  });

  it("未 ensure 的目标不接收写入（接线契约：不猜测基线）", () => {
    const repo = emptyDraftRepo();
    expect(writeCallDraftText(repo, key("r_01", "s_01", "result"), "ghost")).toBe(repo);
    expect(callDraftOf(repo, key("r_01", "s_01", "result"))).toBeUndefined();
  });
});

describe("选择器引用稳定（zustand 快照约束）", () => {
  it("写入只沿路径复制：其他 run / 其他字段的条目引用不变", () => {
    let repo = emptyDraftRepo();
    repo = ensureCallDraft(repo, key("r_01", "s_01", "result"), "a").repo;
    repo = ensureCallDraft(repo, key("r_01", "s_01", "system_prompt"), "b").repo;
    repo = ensureCallDraft(repo, key("r_02", "s_01", "result"), "c").repo;
    const entryA = callDraftOf(repo, key("r_01", "s_01", "result"));
    const entryB = callDraftOf(repo, key("r_01", "s_01", "system_prompt"));
    const entryC = callDraftOf(repo, key("r_02", "s_01", "result"));

    repo = writeCallDraftText(repo, key("r_01", "s_01", "result"), "a2");
    expect(callDraftOf(repo, key("r_01", "s_01", "result"))).not.toBe(entryA);
    expect(callDraftOf(repo, key("r_01", "s_01", "system_prompt"))).toBe(entryB);
    expect(callDraftOf(repo, key("r_02", "s_01", "result"))).toBe(entryC);
  });

  it("相同文本写入与未命中写入返回原仓库引用（不触发无关订阅）", () => {
    const repo: DraftRepo = ensureCallDraft(
      emptyDraftRepo(),
      key("r_01", "s_01", "result"),
      "base",
    ).repo;
    expect(writeCallDraftText(repo, key("r_01", "s_01", "result"), "base")).toBe(repo);
    expect(writeCallDraftText(repo, key("r_09", "s_x", "messages"), "no-entry")).toBe(repo);
  });

  it("读取未命中返回 undefined 且不改动仓库", () => {
    const repo = emptyDraftRepo();
    expect(callDraftOf(repo, key("r_x", "s_x", "messages"))).toBeUndefined();
    expect(repo.calls).toEqual({});
  });
});

describe("dirty 派生与回基线（任务 1.2）", () => {
  it("打开未编辑不产生虚假 dirty；清空、仅空白、非法 JSON 都算 dirty", () => {
    let repo = emptyDraftRepo();
    const ensured = ensureCallDraft(repo, key("r_01", "s_01", "result"), "base");
    repo = ensured.repo;
    expect(isCallDraftDirty(ensured.entry)).toBe(false);

    repo = writeCallDraftText(repo, key("r_01", "s_01", "result"), "");
    expect(isCallDraftDirty(callDraftOf(repo, key("r_01", "s_01", "result"))!)).toBe(true);

    repo = writeCallDraftText(repo, key("r_01", "s_01", "result"), "   \n");
    expect(isCallDraftDirty(callDraftOf(repo, key("r_01", "s_01", "result"))!)).toBe(true);

    repo = writeCallDraftText(repo, key("r_01", "s_01", "result"), "]{ 未完成");
    expect(isCallDraftDirty(callDraftOf(repo, key("r_01", "s_01", "result"))!)).toBe(true);
  });

  it("基线本身是空串时，输入空串不算 dirty、输入内容才算", () => {
    let repo = emptyDraftRepo();
    repo = ensureCallDraft(repo, key("r_01", "s_01", "system_prompt"), "").repo;
    expect(isCallDraftDirty(callDraftOf(repo, key("r_01", "s_01", "system_prompt"))!)).toBe(false);

    repo = writeCallDraftText(repo, key("r_01", "s_01", "system_prompt"), "有内容了");
    expect(isCallDraftDirty(callDraftOf(repo, key("r_01", "s_01", "system_prompt"))!)).toBe(true);
  });

  it("改回基线后 dirty=false（标记消失），条目保留且再次修改继续递增", () => {
    let repo = emptyDraftRepo();
    repo = ensureCallDraft(repo, key("r_01", "s_01", "result"), "base").repo;
    repo = writeCallDraftText(repo, key("r_01", "s_01", "result"), "changed");
    expect(isCallDraftDirty(callDraftOf(repo, key("r_01", "s_01", "result"))!)).toBe(true);

    repo = writeCallDraftText(repo, key("r_01", "s_01", "result"), "base");
    const back = callDraftOf(repo, key("r_01", "s_01", "result"));
    expect(isCallDraftDirty(back!)).toBe(false);
    expect(back?.revision).toBe(3);

    repo = writeCallDraftText(repo, key("r_01", "s_01", "result"), "changed again");
    expect(callDraftOf(repo, key("r_01", "s_01", "result"))?.revision).toBe(4);
  });
});

describe("放弃校验（按 key/revision 的 CAS，任务 1.2）", () => {
  it("修订一致才删除：条目消失、空父级剪枝、兄弟条目存活且引用不变", () => {
    let repo = emptyDraftRepo();
    repo = ensureCallDraft(repo, key("r_01", "s_01", "result"), "a").repo;
    repo = ensureCallDraft(repo, key("r_01", "s_01", "system_prompt"), "b").repo;
    repo = ensureCallDraft(repo, key("r_02", "s_01", "result"), "c").repo;
    const sibling = callDraftOf(repo, key("r_01", "s_01", "system_prompt"));
    const otherRun = callDraftOf(repo, key("r_02", "s_01", "result"));
    const target = callDraftOf(repo, key("r_01", "s_01", "result"))!;

    const result = discardCallDraft(repo, key("r_01", "s_01", "result"), target.revision);
    expect(result.discarded).toBe(true);
    expect(callDraftOf(result.repo, key("r_01", "s_01", "result"))).toBeUndefined();
    // 剪枝：r_01/s_01 只剩 system_prompt 字段；r_02 不受影响
    expect(callDraftOf(result.repo, key("r_01", "s_01", "system_prompt"))).toBe(sibling);
    expect(callDraftOf(result.repo, key("r_02", "s_01", "result"))).toBe(otherRun);
  });

  it("修订不因删除重建而复用：放弃后重建同 key 必然拿到更新的修订", () => {
    let repo = emptyDraftRepo();
    repo = ensureCallDraft(repo, key("r_01", "s_01", "result"), "base").repo;
    repo = writeCallDraftText(repo, key("r_01", "s_01", "result"), "v1");
    const oldRevision = callDraftOf(repo, key("r_01", "s_01", "result"))!.revision;

    repo = discardCallDraft(repo, key("r_01", "s_01", "result"), oldRevision).repo;
    const rebuiltResult = ensureCallDraft(repo, key("r_01", "s_01", "result"), "base");
    repo = rebuiltResult.repo;
    const rebuilt = rebuiltResult.entry;
    expect(rebuilt.revision).not.toBe(oldRevision);
    expect(rebuilt.text).toBe("base");
    expect(isCallDraftDirty(rebuilt)).toBe(false);

    // 重建后再编辑：修订继续从新基点递增，不会与旧链撞号
    repo = writeCallDraftText(repo, key("r_01", "s_01", "result"), "v2");
    expect(callDraftOf(repo, key("r_01", "s_01", "result"))?.revision).toBeGreaterThan(
      rebuilt.revision,
    );
  });

  it("无编辑直接放弃后重建同样不复用旧修订（防 ABA）", () => {
    let repo = emptyDraftRepo();
    const firstResult = ensureCallDraft(repo, key("r_01", "s_01", "result"), "base");
    repo = firstResult.repo;
    const first = firstResult.entry;
    repo = discardCallDraft(repo, key("r_01", "s_01", "result"), first.revision).repo;
    const second = ensureCallDraft(repo, key("r_01", "s_01", "result"), "base").entry;
    expect(second.revision).not.toBe(first.revision);
  });

  it("旧放弃确认不能删除新修订：确认后内容又变 ⇒ 拒绝删除，重新核对后才可放弃", () => {
    let repo = emptyDraftRepo();
    repo = ensureCallDraft(repo, key("r_01", "s_01", "result"), "base").repo;
    repo = writeCallDraftText(repo, key("r_01", "s_01", "result"), "确认时的内容");
    const confirmedRevision = callDraftOf(repo, key("r_01", "s_01", "result"))!.revision;

    // 确认等待期间用户继续输入 ⇒ 修订推进
    repo = writeCallDraftText(repo, key("r_01", "s_01", "result"), "确认后的新内容");
    const current = callDraftOf(repo, key("r_01", "s_01", "result"))!;

    const stale = discardCallDraft(repo, key("r_01", "s_01", "result"), confirmedRevision);
    expect(stale.discarded).toBe(false);
    expect(stale.repo).toBe(repo);
    expect(callDraftOf(repo, key("r_01", "s_01", "result"))).toBe(current);

    // 用当前修订重新核对后才能放弃
    const fresh = discardCallDraft(repo, key("r_01", "s_01", "result"), current.revision);
    expect(fresh.discarded).toBe(true);
    expect(callDraftOf(fresh.repo, key("r_01", "s_01", "result"))).toBeUndefined();
  });

  it("放弃不存在的目标幂等：仓库引用不变、discarded=false", () => {
    let repo = emptyDraftRepo();
    repo = ensureCallDraft(repo, key("r_01", "s_01", "result"), "a").repo;
    expect(discardCallDraft(repo, key("r_09", "s_x", "messages"), 1)).toEqual({
      repo,
      discarded: false,
    });
    expect(discardCallDraft(repo, key("r_01", "s_01", "result"), 999)).toEqual({
      repo,
      discarded: false,
    });
  });
});

// ---------------------------------------------------------------------------
// 创建表单草稿（任务 1.3）
// ---------------------------------------------------------------------------

describe("创建草稿（任务 1.3）", () => {
  it("ensure 初始化默认纯对话空表单；重复 ensure 原样保留不推进修订", () => {
    let repo = emptyDraftRepo();
    const first = ensureCreateRunDraft(repo);
    repo = first.repo;
    expect(first.entry).toEqual({ mode: "chat", systemPrompt: "", userMessage: "", revision: 1 });

    const second = ensureCreateRunDraft(repo);
    expect(second.repo).toBe(repo);
    expect(second.entry).toBe(first.entry);
  });

  it("切创建模式保留文本（只写 mode 不动文本），且模式修改推进修订", () => {
    let repo = emptyDraftRepo();
    repo = ensureCreateRunDraft(repo).repo;
    repo = writeCreateRunDraft(repo, { systemPrompt: "sys", userMessage: "user" });

    repo = writeCreateRunDraft(repo, { mode: "isolated_files" });
    expect(repo.create?.mode).toBe("isolated_files");
    expect(repo.create?.systemPrompt).toBe("sys");
    expect(repo.create?.userMessage).toBe("user");
    expect(repo.create?.revision).toBe(3);
  });

  it("无实际内容变化返回原仓库引用；文本变化推进修订", () => {
    let repo = emptyDraftRepo();
    repo = ensureCreateRunDraft(repo).repo;
    const before = repo;
    repo = writeCreateRunDraft(repo, { systemPrompt: "" });
    expect(repo).toBe(before);

    repo = writeCreateRunDraft(repo, { systemPrompt: "s" });
    expect(repo).not.toBe(before);
    expect(repo.create?.revision).toBe(2);
  });

  it("放弃（CAS）后恢复默认空表单；旧确认不动新修订；重建拿新修订", () => {
    let repo = emptyDraftRepo();
    repo = ensureCreateRunDraft(repo).repo;
    repo = writeCreateRunDraft(repo, {
      mode: "isolated_files",
      systemPrompt: "s",
      userMessage: "u",
    });
    const confirmed = repo.create!.revision;

    // 确认等待期间又输入 ⇒ 修订推进，旧确认拒绝
    repo = writeCreateRunDraft(repo, { systemPrompt: "s2" });
    const stale = discardCreateRunDraft(repo, confirmed);
    expect(stale.discarded).toBe(false);
    expect(stale.repo.create?.systemPrompt).toBe("s2");

    const fresh = discardCreateRunDraft(repo, repo.create!.revision);
    expect(fresh.discarded).toBe(true);
    expect(fresh.repo.create).toBeNull(); // 表单回到默认空

    // 重建拿新修订，不复用旧修订
    const rebuilt = ensureCreateRunDraft(fresh.repo);
    expect(rebuilt.entry.revision).toBeGreaterThan(confirmed);
  });

  it("dirty：默认空表单不算 dirty；只切模式、只填文本都算", () => {
    let repo = emptyDraftRepo();
    const fresh = ensureCreateRunDraft(repo);
    expect(isCreateRunDraftDirty(fresh.entry)).toBe(false);

    repo = writeCreateRunDraft(fresh.repo, { mode: "isolated_files" });
    expect(isCreateRunDraftDirty(repo.create!)).toBe(true);

    repo = writeCreateRunDraft(repo, { mode: "chat", userMessage: "任务" });
    expect(isCreateRunDraftDirty(repo.create!)).toBe(true);
  });
});

describe("A/B 批次草稿（任务 1.3）", () => {
  it("ensure 以基线臂初始化（每臂稳定行 ID）；重开原样保留", () => {
    let repo = emptyDraftRepo();
    const first = ensureModelAbDraft(repo, abKey("r_01", "s_01"), BASELINE);
    repo = first.repo;
    expect(first.entry.baseline).toEqual(BASELINE);
    expect(first.entry.rows.map((r) => r.model)).toEqual(["parent-model", "parent-model"]);
    expect(first.entry.rows[0]!.key).not.toBe(first.entry.rows[1]!.key);

    const second = ensureModelAbDraft(repo, abKey("r_01", "s_01"), BASELINE);
    expect(second.repo).toBe(repo);
    expect(second.entry).toBe(first.entry);
  });

  it("增删行推进批次修订；行 ID 顺序无关内容，非法参数原样保存", () => {
    let repo = emptyDraftRepo();
    repo = ensureModelAbDraft(repo, abKey("r_01", "s_01"), BASELINE).repo;
    const baseRevision = modelAbDraftOf(repo, abKey("r_01", "s_01"))!.revision;

    // 新增第三臂（非法 JSON 参数原样）
    const broken = "]{ 未完成";
    repo = setModelAbRows(repo, abKey("r_01", "s_01"), [
      ...modelAbDraftOf(repo, abKey("r_01", "s_01"))!.rows,
      abRow(newArmRowKey(), "model-b", broken),
    ]);
    expect(modelAbDraftOf(repo, abKey("r_01", "s_01"))!.revision).toBeGreaterThan(baseRevision);
    expect(modelAbDraftOf(repo, abKey("r_01", "s_01"))!.rows[2]!.paramsText).toBe(broken);

    // 删除一臂也推进
    repo = setModelAbRows(
      repo,
      abKey("r_01", "s_01"),
      modelAbDraftOf(repo, abKey("r_01", "s_01"))!.rows.slice(0, 2),
    );
    expect(modelAbDraftOf(repo, abKey("r_01", "s_01"))!.rows.length).toBe(2);
    expect(modelAbDraftOf(repo, abKey("r_01", "s_01"))!.revision).toBeGreaterThan(baseRevision);
  });

  it("仅行 ID 变化（语义不变）不推进修订但更新行引用；顺序变化推进修订", () => {
    let repo = emptyDraftRepo();
    repo = ensureModelAbDraft(repo, abKey("r_01", "s_01"), BASELINE).repo;
    const k = abKey("r_01", "s_01");
    const before = modelAbDraftOf(repo, abKey("r_01", "s_01"))!;

    // 删一条同内容臂再原样加回：语义序列不变，仅行 ID 变化
    repo = setModelAbRows(repo, k, [
      before.rows[0]!,
      abRow(newArmRowKey(), before.rows[1]!.model, before.rows[1]!.paramsText),
    ]);
    expect(modelAbDraftOf(repo, abKey("r_01", "s_01"))!.revision).toBe(before.revision);
    expect(modelAbDraftOf(repo, abKey("r_01", "s_01"))!.rows[1]!.key).not.toBe(before.rows[1]!.key);

    // 先让两臂内容不同（相同内容的臂交换语义等价，不应推进修订）
    const mid = modelAbDraftOf(repo, abKey("r_01", "s_01"))!;
    const distinct = setModelAbRows(repo, k, [
      { ...mid.rows[0]!, model: "model-a" },
      { ...mid.rows[1]!, model: "model-b" },
    ]);
    const distinctEntry = modelAbDraftOf(distinct, abKey("r_01", "s_01"))!;
    expect(distinctEntry.revision).toBeGreaterThan(mid.revision);

    // 交换两臂顺序：顺序是语义 ⇒ 再推进修订
    const swapped = setModelAbRows(distinct, k, [
      { ...distinctEntry.rows[1]! },
      { ...distinctEntry.rows[0]! },
    ]);
    expect(modelAbDraftOf(swapped, abKey("r_01", "s_01"))!.revision).toBeGreaterThan(
      distinctEntry.revision,
    );
  });

  it("dirty：初始两臂不算修改；改内容/删臂/换顺序都算", () => {
    let repo = emptyDraftRepo();
    const fresh = ensureModelAbDraft(repo, abKey("r_01", "s_01"), BASELINE);
    expect(isModelAbDraftDirty(fresh.entry)).toBe(false);

    repo = setModelAbRows(fresh.repo, abKey("r_01", "s_01"), [
      { ...fresh.entry.rows[0]!, model: "other-model" },
      { ...fresh.entry.rows[1]! },
    ]);
    expect(isModelAbDraftDirty(modelAbDraftOf(repo, abKey("r_01", "s_01"))!)).toBe(true);
  });

  it("放弃整批（CAS）：删除条目、旧确认不动新修订、重建拿新修订", () => {
    let repo = emptyDraftRepo();
    repo = ensureModelAbDraft(repo, abKey("r_01", "s_01"), BASELINE).repo;
    const k = abKey("r_01", "s_01");
    const confirmed = modelAbDraftOf(repo, abKey("r_01", "s_01"))!.revision;

    repo = setModelAbRows(repo, k, [
      ...modelAbDraftOf(repo, abKey("r_01", "s_01"))!.rows,
      abRow(newArmRowKey(), "m", ""),
    ]);
    const stale = discardModelAbDraft(repo, k, confirmed);
    expect(stale.discarded).toBe(false);
    expect(modelAbDraftOf(stale.repo, abKey("r_01", "s_01"))!.rows.length).toBe(3);

    const fresh = discardModelAbDraft(
      repo,
      k,
      modelAbDraftOf(repo, abKey("r_01", "s_01"))!.revision,
    );
    expect(fresh.discarded).toBe(true);
    expect(modelAbDraftOf(fresh.repo, abKey("r_01", "s_01"))).toBeUndefined(); // 空父级剪枝

    const rebuilt = ensureModelAbDraft(fresh.repo, k, BASELINE);
    expect(rebuilt.entry.revision).toBeGreaterThan(confirmed);
  });

  it("两个 run 的相同起始 span 不串批次", () => {
    let repo = emptyDraftRepo();
    repo = ensureModelAbDraft(repo, abKey("r_01", "s_01"), BASELINE).repo;
    repo = ensureModelAbDraft(repo, abKey("r_02", "s_01"), [
      { model: "x", paramsText: "" },
      { model: "y", paramsText: "" },
    ]).repo;
    repo = setModelAbRows(repo, abKey("r_01", "s_01"), [
      ...modelAbDraftOf(repo, abKey("r_01", "s_01"))!.rows,
      abRow(newArmRowKey(), "extra", ""),
    ]);
    expect(modelAbDraftOf(repo, abKey("r_02", "s_01"))!.rows.length).toBe(2);
  });
});

describe("草稿结构不含授权/凭据/计划（任务 1.3：设置凭据与调试草稿分离）", () => {
  it("三区草稿的序列化结果不含授权、副作用许可、密钥或 token 字段", () => {
    let repo = emptyDraftRepo();
    repo = ensureCallDraft(repo, key("r_01", "s_01", "messages"), "[]").repo;
    repo = writeCallDraftText(repo, key("r_01", "s_01", "messages"), '[{"role":"user"}]');
    repo = ensureModelAbDraft(repo, abKey("r_01", "s_01"), BASELINE).repo;
    repo = writeCreateRunDraft(ensureCreateRunDraft(repo).repo, {
      mode: "isolated_files",
      systemPrompt: "s",
      userMessage: "u",
    });
    const serialized = JSON.stringify({
      calls: repo.calls,
      modelAb: repo.modelAb,
      create: repo.create,
    });
    for (const forbidden of ["writesAuthorized", "allowSideEffects", "apiKey", "sourceToken"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// store 接线：draft slice 与动作（模块读 window.api，桩须先于动态 import 就位）
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = { api: {} };
const { useAppStore } = await import("../src/renderer/src/store");
const draftsModule = await import("../src/renderer/src/lib/debugging-drafts");

describe("store 接线（drafts slice）", () => {
  beforeEach(() => {
    useAppStore.setState({ drafts: draftsModule.emptyDraftRepo() });
  });

  it("ensure 后 callDraftOf 返回同一条目；无关 store 更新不换条目引用", () => {
    const entry = useAppStore.getState().ensureCallDraft(key("r_01", "s_01", "result"), "base");
    expect(useAppStore.getState().callDraftOf(key("r_01", "s_01", "result"))).toBe(entry);

    useAppStore.getState().setSearchQuery("无关更新");
    expect(useAppStore.getState().callDraftOf(key("r_01", "s_01", "result"))).toBe(entry);
  });

  it("写入同步落地 store；其他键条目引用保持稳定", () => {
    const s = useAppStore.getState();
    const entryA = s.ensureCallDraft(key("r_01", "s_01", "result"), "a");
    const entryB = s.ensureCallDraft(key("r_02", "s_02", "messages"), "[]");

    useAppStore.getState().writeCallDraftText(key("r_01", "s_01", "result"), "a2");

    const after = useAppStore.getState();
    expect(after.callDraftOf(key("r_01", "s_01", "result"))?.text).toBe("a2");
    expect(after.callDraftOf(key("r_01", "s_01", "result"))).not.toBe(entryA);
    expect(after.callDraftOf(key("r_02", "s_02", "messages"))).toBe(entryB);
  });

  it("重复写入相同文本不换仓库引用；未 ensure 的写入不建条目", () => {
    useAppStore.getState().ensureCallDraft(key("r_01", "s_01", "result"), "base");
    const repoBefore = useAppStore.getState().drafts;

    useAppStore.getState().writeCallDraftText(key("r_01", "s_01", "result"), "base");
    expect(useAppStore.getState().drafts).toBe(repoBefore);

    useAppStore.getState().writeCallDraftText(key("r_09", "s_09", "messages"), "ghost");
    expect(useAppStore.getState().callDraftOf(key("r_09", "s_09", "messages"))).toBeUndefined();
  });

  it("store 里暂存非法 JSON 与空串后原样读回（同步写入，不经格式化）", () => {
    const k = key("r_01", "s_01", "messages");
    useAppStore.getState().ensureCallDraft(k, `[{"role":"user"}]`);
    const broken = "]{ 未完成";
    useAppStore.getState().writeCallDraftText(k, broken);
    expect(useAppStore.getState().callDraftOf(k)?.text).toBe(broken);

    useAppStore.getState().writeCallDraftText(k, "");
    expect(useAppStore.getState().callDraftOf(k)?.text).toBe("");
  });

  it("store 放弃走 CAS：修订一致才删除，旧确认不动新修订", () => {
    const k = key("r_01", "s_01", "result");
    useAppStore.getState().ensureCallDraft(k, "base");
    useAppStore.getState().writeCallDraftText(k, "确认时的内容");
    const confirmed = useAppStore.getState().callDraftOf(k)!.revision;

    // 确认等待期间继续输入 ⇒ 修订推进
    useAppStore.getState().writeCallDraftText(k, "确认后的新内容");

    expect(useAppStore.getState().discardCallDraft(k, confirmed)).toBe(false);
    expect(useAppStore.getState().callDraftOf(k)?.text).toBe("确认后的新内容");

    const current = useAppStore.getState().callDraftOf(k)!.revision;
    expect(useAppStore.getState().discardCallDraft(k, current)).toBe(true);
    expect(useAppStore.getState().callDraftOf(k)).toBeUndefined();
  });

  it("store 创建草稿：切模式保留文本、放弃恢复默认空表单", () => {
    useAppStore.getState().ensureCreateRunDraft();
    useAppStore.getState().writeCreateRunDraft({ systemPrompt: "sys", userMessage: "user" });
    useAppStore.getState().writeCreateRunDraft({ mode: "isolated_files" });

    const entry = useAppStore.getState().createRunDraftOf();
    expect(entry?.mode).toBe("isolated_files");
    expect(entry?.systemPrompt).toBe("sys");
    expect(entry?.userMessage).toBe("user");

    const confirmed = entry!.revision;
    expect(useAppStore.getState().discardCreateRunDraft(confirmed)).toBe(true);
    expect(useAppStore.getState().createRunDraftOf()).toBeNull();
  });

  it("store A/B 批次：增删行与非法参数经 store 读写原样可恢复", () => {
    const k = { runId: "r_01", spanId: "s_01" };
    useAppStore.getState().ensureModelAbDraft(k, BASELINE);
    const rows = useAppStore.getState().modelAbDraftOf(k)!.rows;
    const revisionBefore = useAppStore.getState().modelAbDraftOf(k)!.revision;
    const broken = "]{ 未完成";
    useAppStore
      .getState()
      .setModelAbRows(k, [
        ...rows,
        { key: draftsModule.newArmRowKey(), model: "m-b", paramsText: broken },
      ]);

    const after = useAppStore.getState().modelAbDraftOf(k)!;
    expect(after.rows.length).toBe(3);
    expect(after.rows[2]!.paramsText).toBe(broken);
    expect(after.revision).toBeGreaterThan(revisionBefore);

    useAppStore.getState().setModelAbRows(k, rows);
    expect(useAppStore.getState().modelAbDraftOf(k)!.rows.length).toBe(2);
  });

  it("store 目录引用独立于草稿：set/clear 生效，写草稿不动引用", () => {
    const ref = { token: "tok_1", name: "数据集", path: "D:/data" };
    useAppStore.getState().setCreateSourceRef(ref);
    expect(useAppStore.getState().createSourceRef).toEqual(ref);

    useAppStore.getState().ensureCreateRunDraft();
    useAppStore.getState().writeCreateRunDraft({ userMessage: "任务" });
    expect(useAppStore.getState().createSourceRef).toBe(ref);

    useAppStore.getState().setCreateSourceRef(null);
    expect(useAppStore.getState().createSourceRef).toBeNull();
    // 目录引用不在草稿仓库里（design D4：独立受限会话引用）
    expect(JSON.stringify(useAppStore.getState().drafts)).not.toContain("tok_1");
  });
});
