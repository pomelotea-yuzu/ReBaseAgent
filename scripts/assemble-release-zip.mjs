#!/usr/bin/env node
/**
 * 组装发行 zip（0.6.0-rc.1 起 zip 附带 mcp/ 只读诊断目录）。
 *
 * zip 布局（沿 0.5.0-rc.1 的 zip-only 口径扩展）：
 *   ReBaseAgent-<version>-win-x64-portable.exe   桌面便携主程序（不内嵌 MCP）
 *   mcp/                                          MCP 只读诊断自包含目录
 *     ├─ dist/cli.js                              入口：node mcp/dist/cli.js --data-dir <dir>
 *     └─ node_modules/                            pnpm --prod deploy（hoisted）的扁平依赖闭包
 *   SHA256SUMS.txt                                zip 内全部文件逐条 sha256（不含自身）
 *   使用说明.txt                                  桌面用法 + MCP 一节
 *
 * 关键工程事实（实测，别按直觉改）：
 *   - deploy 必须带 `--config.node-linker=hoisted`：pnpm 默认 .pnpm+symlink 布局既不能
 *     cpSync 拷贝（SDK 传递依赖 zod-to-json-schema 只在 .pnpm，断链在 initialize 才炸），
 *     也不能原样进 zip（Windows 解压 symlink 需特权）。扁平化是分发形态的唯一正解。
 *   - deploy 目标必须是仓库内相对路径：仓库外绝对路径下 workspace 依赖（file: 协议）的
 *     symlink 会被当相对路径拼进包目录（ENOENT）。
 *   - 探针不能用 spawnSync+input：写完即 EOF，服务端 EOF 退出先于 tools/call 处理完
 *     （5.3 的 EOF 纪律）⇒ 异步 spawn、一次 write 交整批帧、收齐再关 stdin。
 *
 * 自验（全过才输出 ASSEMBLE_PASS，任一失败非零退出）：
 *   ① deploy 目录 stdio 探针：initialize（能力恰 {tools:{}}）→ tools/list（恰 13 个）
 *      → tools/call list_runs（空 traces 数据根）。
 *   ② zip 结构：7za 列表顶层恰 exe/说明/SUMS + mcp；SUMS 行数与文件数一致。
 *   ③ zip 内 exe 逐字节 = 源 exe（抽出重算 sha256）。
 *
 * 跑法：node scripts/assemble-release-zip.mjs --exe <exe 路径> [--out <目录>] [--keep-work]
 * 输出目录默认 release/stable（正式）；测试务必给 --out 临时目录，绝不覆盖既有产物。
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const exePath = resolve(flag("exe") ?? "");
const outDir = resolve(flag("out") ?? "release/stable");
const keepWork = args.includes("--keep-work");

if (exePath === "" || !existsSync(exePath)) {
  console.error("用法：--exe <ReBaseAgent-<version>-win-x64-portable.exe> [--out <目录>]");
  process.exit(2);
}
const exeName = basename(exePath);
const versionMatch = /^ReBaseAgent-(\d+\.\d+\.\d+[^/]*)-win-x64-portable\.exe$/.exec(exeName);
if (versionMatch === null) {
  console.error(`exe 名不符合发行约定：${exeName}`);
  process.exit(2);
}
const version = versionMatch[1];
const zipName = `ReBaseAgent-${version}-win-x64.zip`;

const REPO = resolve(import.meta.dirname, "..");
const SZ = join(
  process.env.LOCALAPPDATA ?? "",
  "electron-builder/Cache/7zip@1.0.0/7zip-win-x64-1nrf7/bin/7za.exe",
);
const run = (cmd, cmdArgs, opts = {}) => {
  const r = spawnSync(cmd, cmdArgs, { encoding: "utf8", ...opts });
  if (r.status !== 0) {
    console.error(
      `命令失败（exit ${r.status}）：${cmd} ${cmdArgs.join(" ")}\n${r.stdout}\n${r.stderr}`,
    );
    process.exit(1);
  }
  return r;
};
const sha256Of = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
// 本机 7za 的**写档**被系统策略拦（建/解 zip 均「拒绝访问」，非沙箱亦然）；读（l）不受影响。
// 打包与抽验走 .NET ZipFile：entryNameEncoding=UTF8 ⇒ 条目名带 UTF-8 标志（7za/资源管理器
// 解压正确；实测不带该参数时「使用说明.txt」会被按系统码页写成乱码）。-EncodedCommand 免转义。
const psRun = (psLines) => {
  const encoded = Buffer.from(psLines.join("\n"), "utf16le").toString("base64");
  return run("powershell", ["-NoProfile", "-EncodedCommand", encoded]);
};
const psQuote = (v) => v.replaceAll("'", "''");

// ---------------------------------------------------------------------------
// 1) pnpm --prod deploy（hoisted 扁平闭包）
// ---------------------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), `ra-zip-${version}-`));
console.log(`work: ${work}`);
const deployDir = join(REPO, ".rebaseagent", "assemble-deploy");
rmSync(deployDir, { recursive: true, force: true });
run(
  process.execPath,
  [
    "D:/nodejs/node_modules/corepack/dist/pnpm.js",
    "--filter",
    "@rebaseagent/mcp-server",
    "--prod",
    "--config.node-linker=hoisted",
    "deploy",
    ".rebaseagent/assemble-deploy",
  ],
  { cwd: REPO },
);
const mcpDir = join(work, "mcp");
cpSync(deployDir, mcpDir, { recursive: true });
// pnpm 的 bin 误建残片（deploy 副作用，实测在包目录下）——收尾清掉
const stray = join(REPO, "packages/mcp-server/.rebaseagent");
if (existsSync(stray)) rmSync(stray, { recursive: true, force: true });
if (!existsSync(join(mcpDir, "dist", "cli.js"))) {
  console.error("deploy 产物缺 dist/cli.js");
  process.exit(1);
}
// dist 的类型文件与 sourcemap 不参与运行，清掉（node_modules 闭包原样保留，不动完整性）
const slim = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) slim(p);
    else if (name.endsWith(".d.ts") || name.endsWith(".d.ts.map") || name.endsWith(".js.map"))
      rmSync(p, { force: true });
  }
};
slim(join(mcpDir, "dist"));

// ---------------------------------------------------------------------------
// 2) stdio 自验探针
// ---------------------------------------------------------------------------
const probeData = join(work, "probe-data");
mkdirSync(join(probeData, "traces"), { recursive: true });
await new Promise((resolveProbe, rejectProbe) => {
  const child = spawn(process.execPath, [join(mcpDir, "dist", "cli.js"), "--data-dir", probeData], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const frames = [];
  let settled = false;
  const finish = () => {
    if (settled) return;
    const init = frames.find((f) => f.id === 1);
    const tools = frames.find((f) => f.id === 2);
    const call = frames.find((f) => f.id === 3);
    if (init === undefined || tools === undefined || call === undefined) return;
    settled = true;
    clearTimeout(timer);
    const toolNames = (tools.result?.tools ?? []).map((t) => t.name);
    const text = call.result?.content?.[0]?.text ?? "";
    const problems = [];
    if (init.result?.serverInfo?.name !== "rebaseagent-mcp")
      problems.push(`initialize serverInfo 异常：${JSON.stringify(init.result?.serverInfo)}`);
    if (JSON.stringify(init.result?.capabilities) !== '{"tools":{}}')
      problems.push(
        `capabilities 应恰 {"tools":{}}，实得 ${JSON.stringify(init.result?.capabilities)}`,
      );
    if (toolNames.length !== 13) problems.push(`tools/list 应 13 个，实得 ${toolNames.length}`);
    if (!text.includes("list_runs") || !text.includes("0"))
      problems.push(`list_runs content 异常：${text.split("\n")[0]}`);
    child.stdin.end();
    child.on("exit", () => {
      if (problems.length > 0) rejectProbe(new Error(problems.join("；")));
      else {
        console.log("① stdio 探针：initialize {tools:{}} / 7 工具 / list_runs 空数据根 ✓");
        resolveProbe();
      }
    });
  };
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      child.kill();
      rejectProbe(new Error("探针 30s 未收齐响应帧"));
    }
  }, 30_000);
  child.stdout.on("data", (d) => {
    buf += d;
    let idx = buf.indexOf("\n");
    while (idx >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) frames.push(JSON.parse(line));
      idx = buf.indexOf("\n");
    }
    finish();
  });
  child.on("error", (e) => {
    if (!settled) {
      settled = true;
      rejectProbe(e);
    }
  });
  // 一次 write 交出整批帧（SDK 在同一 data 事件同步逐帧分发；拆开写时序不再确定）
  child.stdin.write(
    `${[
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "assemble-probe", version: "0" },
        },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_runs", arguments: {} },
      }),
    ].join("\n")}\n`,
  );
});

// ---------------------------------------------------------------------------
// 3) 使用说明 + SHA256SUMS + 组装 zip
// ---------------------------------------------------------------------------
const usage = readFileSync(join(REPO, "scripts/release-usage-zh.txt"), "utf8").replaceAll(
  "{{VERSION}}",
  version,
);
mkdirSync(join(work, "stage"));
cpSync(exePath, join(work, "stage", exeName));
cpSync(mcpDir, join(work, "stage", "mcp"), { recursive: true });
writeFileSync(join(work, "stage", "使用说明.txt"), usage);

const sums = [];
const walk = (abs, rel) => {
  for (const name of readdirSync(abs)) {
    const p = join(abs, name);
    const r = rel === "" ? name : `${rel}/${name}`;
    if (statSync(p).isDirectory()) walk(p, r);
    else sums.push(`${sha256Of(p)}  ${r}`);
  }
};
walk(join(work, "stage"), "");
sums.sort((a, b) => a.slice(65).localeCompare(b.slice(65)));
writeFileSync(join(work, "stage", "SHA256SUMS.txt"), `${sums.join("\n")}\n`);

mkdirSync(outDir, { recursive: true });
const zipPath = join(outDir, zipName);
if (existsSync(zipPath)) {
  console.error(`目标已存在，拒绝覆盖：${zipPath}`);
  process.exit(1);
}
psRun([
  "Add-Type -AssemblyName System.IO.Compression.FileSystem",
  `[System.IO.Compression.ZipFile]::CreateFromDirectory('${psQuote(join(work, "stage"))}', '${psQuote(zipPath)}', [System.IO.Compression.CompressionLevel]::Optimal, $false, [System.Text.Encoding]::UTF8)`,
]);
const zipBytes = statSync(zipPath).size;
const zipSha = sha256Of(zipPath);
console.log(`② zip：${zipPath}（${zipBytes} B，sha256 ${zipSha.slice(0, 16)}…）`);

// ---------------------------------------------------------------------------
// 4) 结构与一致性自验
// ---------------------------------------------------------------------------
const listing = run(SZ, ["l", "-ba", "-sccUTF-8", zipPath])
  .stdout.split("\n")
  .map((l) => l.trim())
  .filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l))
  .map((l) => l.split(/\s{2,}/).slice(-1)[0])
  // 7za 列表用反斜杠；与 SUMS（walk 生成，正斜杠）与顶层判断统一为正斜杠
  .map((n) => n.replaceAll("\\", "/"));
const top = new Set(listing.map((n) => (n.includes("/") ? n.split("/")[0] : n)));
const expectedTop = new Set([exeName, "mcp", "SHA256SUMS.txt", "使用说明.txt"]);
const structProblems = [];
for (const t of top) if (!expectedTop.has(t)) structProblems.push(`多余顶层：${t}`);
for (const t of expectedTop) if (!top.has(t)) structProblems.push(`缺顶层：${t}`);
const listed = listing.filter((n) => n !== "SHA256SUMS.txt").length;
if (sums.length !== listed)
  structProblems.push(`SUMS 行数 ${sums.length} ≠ zip 内文件数（除 SUMS）${listed}`);
mkdirSync(join(work, "extract"));
psRun([
  "Add-Type -AssemblyName System.IO.Compression.FileSystem",
  `$z=[System.IO.Compression.ZipFile]::OpenRead('${psQuote(zipPath)}')`,
  `$e=$z.Entries | Where-Object { $_.Name -eq '${psQuote(exeName)}' }`,
  `[System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, '${psQuote(join(work, "extract", exeName))}', $true)`,
  "$z.Dispose()",
]);
if (sha256Of(join(work, "extract", exeName)) !== sha256Of(exePath))
  structProblems.push("zip 内 exe 与源 exe 哈希不一致");
if (structProblems.length > 0) {
  console.error(`③ 结构自验失败：${structProblems.join("；")}`);
  process.exit(1);
}
console.log(`③ 结构自验：顶层恰 4 项 / SUMS ${sums.length} 行对齐 / exe 逐字节一致 ✓`);

if (!keepWork) rmSync(work, { recursive: true, force: true });
console.log(`ASSEMBLE_PASS ${zipPath}`);
console.log(`SHA256 ${zipSha}`);
console.log(`BYTES ${zipBytes}`);
