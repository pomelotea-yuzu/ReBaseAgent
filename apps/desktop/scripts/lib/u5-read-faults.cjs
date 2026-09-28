/* eslint-disable */
/**
 * U5 任务 6.1：只读失败注入原语（§6.6 主用，6.3/6.5 复用）。
 *
 * 为什么是"改文件"而不是"改响应"：桥接面 `window.api` 的属性是
 * `writable:false / configurable:false`（U4 6.5 实测），页内篡改 `runs:get` 返回**真机做不到**
 * ⇒ 结果不可读这一类判据在实机只能从**数据侧**诱发。这里把可用的六种诱发放进一处，
 * 并强制"施加 → 还原 → 逐字节核验"成一条链——注入是手段，**不留痕**是判据。
 *
 * ⚠️ 三条纪律：
 * - 目录/文件一律**同卷 rename**，不删文件；还原放 `finally`，还原失败落
 *   `RESTORE-NEEDED.txt` 标记（收尾核验无残留，同 U2/U4 口径）；
 * - 只碰读路径依赖的字节（trace 文件本身），**不碰** settings / blobs / 源目录；
 * - 每种注入的**实际失败形状**由 `test/controlled-read-faults.test.ts` 对着真
 *   `RunRepository` 数出来——"我以为列表会红"不算判据（U4 6.1/6.4 两轮判红都属此类）。
 */
"use strict";

const {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { createHash } = require("node:crypto");
const { join } = require("node:path");

/** 同卷隐藏后缀（不带 .jsonl ⇒ 列表扫描天然看不见目录内的这项） */
const HIDDEN_SUFFIX = ".u5-hidden";
/** 还原失败/残留时的标记文件名（放在 traces 目录里，收尾核验据此判"有无残留"） */
const RESTORE_MARKER = "RESTORE-NEEDED.txt";
/** 远超当前支持版本（trace-sdk `FORMAT_VERSION`）的取值：版本不支持的读失败 */
const UNSUPPORTED_FORMAT_VERSION = 99;
/** 不在 `RunEventSchema.reason` 枚举里的终止原因：详情侧应被 schema 拒（不放宽） */
const UNKNOWN_TERMINAL_REASON = "u5_unknown_reason";

/** 目录指纹：相对路径 ⇒ 内容 sha256（逐字节不变才配说"零写入"） */
function fingerprintDir(dir) {
  const acc = {};
  if (!existsSync(dir)) return acc;
  const walk = (current, prefix) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      if (statSync(full).isDirectory()) walk(full, rel);
      else acc[rel] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  };
  walk(dir, "");
  return acc;
}

/** 指纹差集（added / removed / changed） */
function diffFingerprints(before, after) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [rel, hash] of Object.entries(after)) {
    if (!(rel in before)) added.push(rel);
    else if (before[rel] !== hash) changed.push(rel);
  }
  for (const rel of Object.keys(before)) if (!(rel in after)) removed.push(rel);
  return { added, removed, changed };
}

/** 差集为空 ⇒ 逐字节回到施加前 */
function isCleanDiff(diff) {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}

/** 落"需要人工还原"标记（还原失败或残留时调用；tag 收尾据此判红而不是判绿） */
function markRestoreNeeded(dir, note) {
  const path = join(dir, RESTORE_MARKER);
  const line = `${new Date().toISOString()} ${note}\n`;
  writeFileSync(path, existsSync(path) ? readFileSync(path, "utf8") + line : line);
  return path;
}

/** 无残留时清掉标记（只认自己这份文件名，不碰别的） */
function clearRestoreMarker(dir) {
  const path = join(dir, RESTORE_MARKER);
  if (existsSync(path)) writeFileSync(path, "");
  return path;
}

/** 改写 trace 文件行文本的公共前置：把整文件按行读出 */
function linesOf(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

function writeLines(file, lines) {
  writeFileSync(file, `${lines.join("\n")}\n`);
}

/**
 * 六种只读注入。每个条目：
 * - `说明` 它诱发的是哪一类读失败（对着 delta 场景措辞）
 * - `needsRun` 是否需要具体 run 文件（`tracesDirGone` 整目录级 ⇒ false）
 * - `apply(ctx)` / `restore(ctx)` 施加与还原；`ctx = { tracesDir, file, snapshot }`
 *
 * ⚠️ `unknownTerminalReason` 放在这里不是为了"造出未知原因的正常运行"，而是为了
 * **坐实详情侧到不了那个显示**：终止原因在 `RunEventSchema` 是枚举 ⇒ 记录非法 ⇒
 * 读取失败（spec「非法详情明确读取失败，不为显示未知而放宽 schema」）。
 */
const READ_FAULTS = {
  fileMissing: {
    说明: "可信 ID 指向的结果文件不在盘上（结果缺失）",
    needsRun: true,
    apply(ctx) {
      ctx.hidden = `${ctx.file}${HIDDEN_SUFFIX}`;
      renameSync(ctx.file, ctx.hidden);
    },
    restore(ctx) {
      if (existsSync(ctx.hidden) && !existsSync(ctx.file)) renameSync(ctx.hidden, ctx.file);
    },
  },

  corruptTail: {
    说明: "文件尾部有非法行（损坏 / 半行）",
    needsRun: true,
    apply(ctx) {
      writeFileSync(ctx.file, `${readFileSync(ctx.file, "utf8")}{ 这不是合法 JSON 行\n`);
    },
    restore(ctx) {
      writeFileSync(ctx.file, ctx.snapshot);
    },
  },

  unsupportedVersion: {
    说明: "首行 format_version 高于当前支持版本（版本不支持）",
    needsRun: true,
    apply(ctx) {
      const lines = linesOf(ctx.file);
      const meta = JSON.parse(lines[0]);
      meta.format_version = UNSUPPORTED_FORMAT_VERSION;
      lines[0] = JSON.stringify(meta);
      writeLines(ctx.file, lines);
    },
    restore(ctx) {
      writeFileSync(ctx.file, ctx.snapshot);
    },
  },

  unknownTerminalReason: {
    说明: "终止事件 reason 不在既有枚举内（非法详情，不放宽 schema）",
    needsRun: true,
    apply(ctx) {
      const lines = linesOf(ctx.file);
      const last = JSON.parse(lines[lines.length - 1]);
      if (last.type !== "run.event") throw new Error("末行不是 run.event，无法注入未知原因");
      last.reason = UNKNOWN_TERMINAL_REASON;
      lines[lines.length - 1] = JSON.stringify(last);
      writeLines(ctx.file, lines);
    },
    restore(ctx) {
      writeFileSync(ctx.file, ctx.snapshot);
    },
  },

  noTerminalEvent: {
    说明: "已封存但缺终止事件（读出来是 crashed ⇒ 中断，不是正常结束）",
    needsRun: true,
    apply(ctx) {
      const lines = linesOf(ctx.file);
      const last = JSON.parse(lines[lines.length - 1]);
      if (last.type !== "run.event") throw new Error("末行不是 run.event，无需摘除");
      writeLines(ctx.file, lines.slice(0, -1));
    },
    restore(ctx) {
      writeFileSync(ctx.file, ctx.snapshot);
    },
  },

  tracesDirGone: {
    说明: "整个 traces 目录缺席（列表与详情**同源**失败）",
    needsRun: false,
    apply(ctx) {
      ctx.hidden = `${ctx.tracesDir}${HIDDEN_SUFFIX}`;
      renameSync(ctx.tracesDir, ctx.hidden);
    },
    restore(ctx) {
      if (existsSync(ctx.hidden) && !existsSync(ctx.tracesDir))
        renameSync(ctx.hidden, ctx.tracesDir);
    },
  },
};

const READ_FAULT_KINDS = Object.keys(READ_FAULTS);

/** 施加一次只读注入；返回的句柄必须 `end()`（幂等，还原 + 逐字节核验） */
function beginReadFault(target, kind) {
  const fault = READ_FAULTS[kind];
  if (fault === undefined) {
    throw new Error(`未知只读注入：${kind}（可选：${READ_FAULT_KINDS.join(", ")}）`);
  }
  const tracesDir = target.tracesDir;
  const file = fault.needsRun ? join(tracesDir, `${target.runId}.jsonl`) : null;
  if (fault.needsRun && !existsSync(file)) {
    throw new Error(`注入目标不存在：${file}`);
  }
  const ctx = { tracesDir, file, snapshot: file === null ? null : readFileSync(file) };
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
async function withReadFault(target, kind, fn) {
  const handle = beginReadFault(target, kind);
  try {
    const fnResult = await fn(handle.ctx);
    return { fnResult, restore: handle.end() };
  } catch (e) {
    handle.end();
    throw e;
  }
}

module.exports = {
  READ_FAULTS,
  READ_FAULT_KINDS,
  HIDDEN_SUFFIX,
  RESTORE_MARKER,
  UNSUPPORTED_FORMAT_VERSION,
  UNKNOWN_TERMINAL_REASON,
  fingerprintDir,
  diffFingerprints,
  isCleanDiff,
  beginReadFault,
  withReadFault,
  markRestoreNeeded,
  clearRestoreMarker,
};
