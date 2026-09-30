/* eslint-disable */
/**
 * U6 任务 6.1：来源链（lineage）注入原语。
 *
 * U5 的 `u5-read-faults.cjs` 只会打"单个 run 文件"（缺失/损坏/版本/终止行/整目录）；
 * U6 的场景主通道是**祖先文件**与**关系篡改**——ownOnly 的唯一合法入口是"祖先 trace
 * 文件确实不存在"，而祖先损坏、祖先未来版本、父链成环、fork 定位非法都必须**严格失败
 * 而不降级**。本模块把这六种诱发放进一处，复用 U5 的指纹/标记/还原原语，判据不变：
 *
 *   施加 → 还原 → 逐字节核验，**不留痕**（还原失败或残留 ⇒ 落 RESTORE-NEEDED.txt）。
 *
 * ⚠️ 三条纪律（继承 U5）：
 * - 文件一律**同卷 rename**，不删文件；还原放 `finally` 语义的 `end()`，不靠调用方记得；
 * - 只碰 trace 文件本身，不碰 settings / blobs / 源目录；
 * - 每种注入的**实际失败形状**由 `test/u6-lineage-faults.test.ts` 对着真
 *   `RunRepository.getRun` 数出来——"我以为会 ownOnly"不算判据。
 *
 * ⚠️ `lineageCycle` / `forkInvalid` 是**关系篡改**（改 meta 行的 parent / fork.at_span），
 * 不是文件级缺失——它们诱发的错误路径与缺失互斥，正好用来钉「已知无效关系不能被
 * 更早缺失遮蔽」与「祖先链成环不降级」两族场景的实机通道。
 */
"use strict";

const {
  clearRestoreMarker,
  diffFingerprints,
  fingerprintDir,
  isCleanDiff,
  markRestoreNeeded,
} = require("./u5-read-faults.cjs");
const { existsSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

/** 同卷隐藏后缀（不带 .jsonl ⇒ 列表扫描天然看不见；与 U5 的 .u5-hidden 区分批次） */
const HIDDEN_SUFFIX = ".u6-hidden";
/** 远超当前支持版本（trace-sdk FORMAT_VERSION）的取值：版本不支持的读失败 */
const UNSUPPORTED_FORMAT_VERSION = 99;
/** fork 定位非法注入时写入的 span id（不属于任何父轨迹） */
const MISSING_SPAN_ID = "u6_fault_missing_span";

/** 把 trace 文件首行（run.meta）读出来改写；mutator 返回 undefined 表示未改动 */
function editMetaLine(file, mutator) {
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const meta = JSON.parse(lines[0]);
  if (meta.type !== "run.meta") throw new Error(`首行不是 run.meta：${file}`);
  const mutated = mutator(meta);
  if (mutated !== undefined) {
    lines[0] = JSON.stringify(mutated);
    writeFileSync(file, `${lines.join("\n")}\n`);
  }
  return meta;
}

/**
 * 六种来源链注入。target = { tracesDir, childRunId, ancestorRunId? }：
 * - 祖先类（ancestor* / lineageCycle）要求 ancestorRunId（直接父或指定祖先）；
 * - forkInvalid / currentMissing 打 childRunId 自身。
 */
const LINEAGE_FAULTS = {
  /** ownOnly 的主通道：祖先 trace 文件不在盘上（同卷 rename 隐藏） */
  ancestorMissing: {
    说明: "祖先 trace 文件缺失（ownOnly 的唯一合法入口）",
    needsAncestor: true,
    apply(ctx) {
      ctx.hiddenAncestor = `${ctx.ancestorFile}${HIDDEN_SUFFIX}`;
      renameSync(ctx.ancestorFile, ctx.hiddenAncestor);
    },
    restore(ctx) {
      if (existsSync(ctx.hiddenAncestor) && !existsSync(ctx.ancestorFile))
        renameSync(ctx.hiddenAncestor, ctx.ancestorFile);
    },
  },

  /** 祖先 JSONL 尾部损坏 ⇒ 严格失败，不降级 ownOnly */
  ancestorCorrupt: {
    说明: "祖先文件尾部非法行（损坏不降级）",
    needsAncestor: true,
    apply(ctx) {
      writeFileSync(
        ctx.ancestorFile,
        `${readFileSync(ctx.ancestorFile, "utf8")}{ 这不是合法 JSON 行\n`,
      );
    },
    restore(ctx) {
      writeFileSync(ctx.ancestorFile, ctx.snapshotAncestor);
    },
  },

  /** 祖先 format_version 抬到远超支持版本 ⇒ 版本守卫在 schema 前拒绝 */
  ancestorFutureVersion: {
    说明: "祖先 format_version 高于当前支持版本（未来版本不降级）",
    needsAncestor: true,
    apply(ctx) {
      editMetaLine(ctx.ancestorFile, (meta) => {
        meta.format_version = UNSUPPORTED_FORMAT_VERSION;
        return meta;
      });
    },
    restore(ctx) {
      writeFileSync(ctx.ancestorFile, ctx.snapshotAncestor);
    },
  },

  /** 关系篡改：直接父的 meta.parent 改指回 child ⇒ 父链成环 */
  lineageCycle: {
    说明: "直接父的 parent 改指回当前 run（父链成环）",
    needsAncestor: true,
    apply(ctx) {
      // ⚠️ 实测形状（对着 readRunLineage 数出来）：结构检查（parent 非空 ⇒ 必须带
      // fork）**先于**成环检查 ⇒ 只改 parent 会先撞「分支 run 缺少 fork 元数据」，
      // 到不了 LINEAGE_CYCLE。补一个形状合法的 fork 才能真正走到成环判定——
      // 这恰好是「可证明错误优先」的顺序证据，注入必须尊重读取器的判定次序。
      editMetaLine(ctx.ancestorFile, (meta) => {
        meta.parent = ctx.childRunId;
        if (meta.fork === null || typeof meta.fork !== "object") {
          const childLines = readFileSync(ctx.childFile, "utf8")
            .split("\n")
            .filter((line) => line.trim().length > 0);
          const spanLine = childLines.find((line) => JSON.parse(line).type === "span");
          const spanId = spanLine === undefined ? "s1" : JSON.parse(spanLine).id;
          meta.fork = { at_span: spanId, edit: { field: "result", value: "u6-cycle" } };
        }
        return meta;
      });
    },
    restore(ctx) {
      writeFileSync(ctx.ancestorFile, ctx.snapshotAncestor);
    },
  },

  /** 关系篡改：child 的 fork.at_span 改指不存在的 span ⇒ 定位非法 */
  forkInvalid: {
    说明: "fork.at_span 不属于指定父轨迹（定位非法）",
    needsAncestor: false,
    apply(ctx) {
      const before = editMetaLine(ctx.childFile, (meta) => {
        if (meta.fork === null || typeof meta.fork !== "object")
          throw new Error("forkInvalid 注入要求 child 带非空 fork 元数据");
        meta.fork = { ...meta.fork, at_span: MISSING_SPAN_ID };
        return meta;
      });
      if (before.fork === null) throw new Error("unreachable：上方已校验");
    },
    restore(ctx) {
      writeFileSync(ctx.childFile, ctx.snapshotChild);
    },
  },

  /** 关系篡改：v1 祖先私带隔离字段（meta.workspace / fork.resume_after_step）⇒ 版本守卫失败 */
  ancestorV1IsolationField: {
    说明: "v1 祖先携带非法隔离字段（值 null/空对象也算存在）",
    needsAncestor: true,
    apply(ctx) {
      editMetaLine(ctx.ancestorFile, (meta) => {
        if (meta.format_version !== 1)
          throw new Error(
            `ancestorV1IsolationField 要求 v1 祖先，实际 format_version=${meta.format_version}`,
          );
        // 值取 null / 空对象——守卫判"字段存在"而非"值有效"，null 也算违规（U6 §1.3 口径）
        meta.workspace = null;
        return meta;
      });
    },
    restore(ctx) {
      writeFileSync(ctx.ancestorFile, ctx.snapshotAncestor);
    },
  },

  /** 关系篡改：删可读祖先的 fork 字段（parent 非空 ⇒ 结构非法）⇒ FORK_INVALID 优先于更早缺失 */
  ancestorForkMissing: {
    说明: "可读祖先缺 fork 元数据（parent 已指向某 run）",
    needsAncestor: true,
    apply(ctx) {
      editMetaLine(ctx.ancestorFile, (meta) => {
        if (meta.parent === null || meta.parent === undefined)
          throw new Error(
            "ancestorForkMissing 要求祖先 parent 非空（根 run 带 fork 是另一种错误）",
          );
        meta.fork = null;
        return meta;
      });
    },
    restore(ctx) {
      writeFileSync(ctx.ancestorFile, ctx.snapshotAncestor);
    },
  },

  /** 当前文件缺失 ⇒ 读取直接失败（D2「缺当前文件直接失败」，不返回 ownOnly） */
  currentMissing: {
    说明: "当前 run 的 trace 文件缺失（读取直接失败）",
    needsAncestor: false,
    apply(ctx) {
      ctx.hiddenChild = `${ctx.childFile}${HIDDEN_SUFFIX}`;
      renameSync(ctx.childFile, ctx.hiddenChild);
    },
    restore(ctx) {
      if (existsSync(ctx.hiddenChild) && !existsSync(ctx.childFile))
        renameSync(ctx.hiddenChild, ctx.childFile);
    },
  },
};

const LINEAGE_FAULT_KINDS = Object.keys(LINEAGE_FAULTS);

/**
 * 施加一次来源链注入；返回的句柄必须 `end()`（幂等，还原 + 逐字节核验）。
 * 前置校验（目标文件存在、ancestor 类必须给 ancestorRunId）在**改任何字节之前**完成。
 */
function beginLineageFault(target, kind) {
  const fault = LINEAGE_FAULTS[kind];
  if (fault === undefined) {
    throw new Error(`未知来源链注入：${kind}（可选：${LINEAGE_FAULT_KINDS.join(", ")}）`);
  }
  const tracesDir = target.tracesDir;
  const childRunId = target.childRunId;
  const childFile = join(tracesDir, `${childRunId}.jsonl`);
  if (!existsSync(childFile)) throw new Error(`注入目标不存在：${childFile}`);
  const ancestorFile = fault.needsAncestor
    ? join(tracesDir, `${target.ancestorRunId}.jsonl`)
    : null;
  if (fault.needsAncestor && (target.ancestorRunId === undefined || !existsSync(ancestorFile))) {
    throw new Error(
      `ancestor 类注入要求存在中的 ancestorRunId：${target.ancestorRunId ?? "(缺省)"}`,
    );
  }
  const ctx = {
    tracesDir,
    childRunId,
    childFile,
    ancestorRunId: target.ancestorRunId ?? null,
    ancestorFile,
    snapshotChild: readFileSync(childFile),
    snapshotAncestor: ancestorFile === null ? null : readFileSync(ancestorFile),
  };
  const before = fingerprintDir(tracesDir);
  fault.apply(ctx);
  let ended = false;

  /** 还原 + 核验；残留或还原失败 ⇒ 落 RESTORE-NEEDED 标记并把差集回给调用方判红 */
  function end() {
    if (ended) throw new Error("注入句柄已 end（不重复还原）");
    ended = true;
    let restoreError = null;
    try {
      fault.restore(ctx);
    } catch (e) {
      restoreError = e instanceof Error ? e.message : String(e);
    }
    const diff = diffFingerprints(before, fingerprintDir(tracesDir));
    const clean = restoreError === null && isCleanDiff(diff);
    if (clean) clearRestoreMarker(tracesDir);
    else
      markRestoreNeeded(tracesDir, `${kind} 未回到施加前：${restoreError ?? JSON.stringify(diff)}`);
    return { clean, restoreError, diff, marked: !clean };
  }

  return { kind, ctx, end };
}

/**
 * 施加 → 跑 fn → **无条件**还原 → 逐字节核验。
 * fn 抛错同样收口（错误原样上抛；还原结果已写进标记，不靠调用方记得清理）。
 */
async function withLineageFault(target, kind, fn) {
  const handle = beginLineageFault(target, kind);
  try {
    const fnResult = await fn(handle.ctx);
    return { fnResult, restore: handle.end() };
  } catch (e) {
    handle.end();
    throw e;
  }
}

module.exports = {
  LINEAGE_FAULTS,
  LINEAGE_FAULT_KINDS,
  HIDDEN_SUFFIX,
  UNSUPPORTED_FORMAT_VERSION,
  MISSING_SPAN_ID,
  editMetaLine,
  beginLineageFault,
  withLineageFault,
};
