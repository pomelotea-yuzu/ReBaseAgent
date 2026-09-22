/**
 * U1 7.4 · 只读哈希基线工具。
 *
 * 对指定数据目录下的**文件**逐文件算 SHA-256（相对路径→哈希），并统计文件数。
 * 只对"应只读"的既有数据做快照：traces/*.jsonl（运行轨迹）与 workspace-blobs/**（隔离文件世界）。\n * 用法：node scripts/u1-74-snapshot.cjs <out-json>
 */
"use strict";
const { createHash } = require("node:crypto");
const { readFileSync, readdirSync, statSync, writeFileSync, existsSync } = require("node:fs");
const { join, relative } = require("node:path");

const REPO = join(__dirname, "..", "..", "..");
const DATA = join(REPO, ".rebaseagent");
const SCOPES = ["traces", "workspace-blobs"];

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}
function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const out = {};
for (const scope of SCOPES) {
  const root = join(DATA, scope);
  if (!existsSync(root)) {
    console.error("missing scope", scope);
    process.exit(1);
  }
  const map = {};
  let count = 0;
  let bytes = 0;
  for (const file of walk(root)) {
    const rel = relative(DATA, file).replace(/\\/g, "/");
    map[rel] = sha256(file);
    count++;
    bytes += statSync(file).size;
  }
  out[scope] = { fileCount: count, bytes, files: map };
}
out.meta = { dataDir: DATA, scopes: SCOPES, at: new Date().toISOString() };

const destArg = process.argv[2];
writeFileSync(destArg ?? "ROC.hash.json", JSON.stringify(out, null, 2));
console.log(
  `snapshot: traces=${out.traces.fileCount} files/${out.traces.bytes}B, workspace-blobs=${out["workspace-blobs"].fileCount} files/${out["workspace-blobs"].bytes}B`,
);
