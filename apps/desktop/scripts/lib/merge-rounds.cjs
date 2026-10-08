"use strict";
/**
 * 合并本轮三次独立运行的实机快照为一份往返证据。
 *
 * 为什么要合并：改窗必须由外部 PowerShell 工具驱动（本机禁止从 Bash 调
 * PowerShell，见 editor-recovery-43-cdp.cjs 注释），所以一次运行 = 一个档位。
 * 每次运行都覆盖同名 measurements.json ⇒ 往返三档必须显式并起来才完整。
 *
 * 用法：node merge-rounds.cjs '<json>' '<json>' '<json>' <标签1> <标签2> <标签3>
 */
const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const OUT = join(__dirname, "..", "..", "..", ".workbuddy", "proxy-editor-recovery");
const MERGED = join(OUT, "roundtrip.json");

const args = process.argv.slice(2);
const files = args.filter((a) => a.startsWith("{") || a.endsWith(".json"));
const labels = args.filter((a) => !a.endsWith(".json"));

const rounds = [];
for (let i = 0; i < files.length; i++) {
  const raw = readFileSync(files[i], "utf8");
  const m = JSON.parse(raw);
  rounds.push({
    label: labels[i] ?? `round-${i + 1}`,
    viewport: m.wide?.viewport ?? null,
    viewportSource: m.wide?.viewportSource ?? null,
    hosts: (m.wideHosts ?? []).map((h) => ({
      role: h.role,
      targetKey: h.targetKey,
      hostOffsetW: h.hostOffsetW,
      hostOffsetH: h.hostOffsetH,
      hostOk: h.hostOk,
      visible: h.visible,
      inViewport: h.inViewport,
      ancestorBreak: h.ancestorBreak,
      scrollableCount: h.scrollableCount,
    })),
    monacoNodeCount: m.monacoNodeCount ?? null,
    hiddenHelperCount: (m.hiddenHelpers ?? []).length,
    collapsedCount: (m.wide?.collapsed ?? []).length,
    failedPlaceholder: (m.wide?.editors ?? []).filter((e) => (e.role ?? "").startsWith("messages-"))
      .length,
  });
}

const merged = {
  note:
    "三次独立运行 = 真实窗口往返 1207 -> 800 -> 1207。改窗由 PowerShell 工具调 ps-dbg.ps1 驱动" +
    "（本机禁止从 Bash 调 PowerShell，故一次运行只能采一个档位）。",
  rounds,
  typed: rounds.length ? null : null,
};
writeFileSync(MERGED, JSON.stringify(merged, null, 2));
console.log(`已合并 ${rounds.length} 档 → ${MERGED}`);
for (const r of rounds) {
  const w = r.viewport ? `${r.viewport.innerW}x${r.viewport.innerH}` : "?";
  console.log(
    `  ${r.label}: viewport=${w}(${r.viewportSource}) hosts=${r.hosts
      .map((h) => `${h.role}:${h.hostOffsetW}x${h.hostOffsetH}${h.visible ? "✓" : "✗"}`)
      .join(" ")} hidden=${r.hiddenHelperCount} monacoNodes=${r.monacoNodeCount}`,
  );
}
void existsSync;
