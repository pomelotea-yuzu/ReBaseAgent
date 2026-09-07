/**
 * release:verify CLI —— 发行验收门禁。
 *
 * 用法：
 *   node scripts/release-verify.mjs <artifact-path> [options]
 *
 * 选项：
 *   --app-package <path>   应用 package.json（默认 apps/desktop/package.json）
 *   --renderer-src <dir>   renderer 源码目录（默认 src/renderer）
 *   --renderer-out <dir>   renderer 构建产物目录（默认 dist/renderer）
 *   --json                 输出机器可读的结构化摘要（README / release 文案引用用）
 *   --help                 显示本帮助
 *
 * 唯一体积通过条件：< 100_000_000 bytes。失败输出实际值/阈值/超出量并返回非零退出码。
 * 脚本只读不写，不产生构建副作用。
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRelease } from "./release-check.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(SCRIPT_DIR, "..");

function printHelp() {
  console.log(`release:verify —— ReBaseAgent 发行验收门禁

用法：
  node scripts/release-verify.mjs <artifact-path> [options]

参数：
  artifact-path            待验收的 Windows x64 portable exe 路径

选项：
  --app-package <path>     应用 package.json（默认 ${join(APP_ROOT, "package.json")}）
  --renderer-src <dir>     renderer 源码目录（默认 ${join(APP_ROOT, "src", "renderer")}）
  --renderer-out <dir>     renderer 构建产物目录（默认 ${join(APP_ROOT, "dist", "renderer", "assets")}）
  --json                   输出结构化摘要（供 README / release 文案引用）
  --help                   显示本帮助

通过条件（全部满足）：
  - 文件名严格为 ReBaseAgent-0.2.0-win-x64-portable.exe
  - 应用版本为 0.2.0（读 --app-package 的 version 字段）
  - 文件精确字节数 < 100,000,000
  - renderer 源码无 monaco-editor 包根 / 基础语言聚合入口导入
  - 构建产物含 editor/json worker，且不含 ts/css/html worker
`);
}

function parseArgs(argv) {
  const args = {
    help: false,
    json: false,
    appPackagePath: undefined,
    rendererSrcDir: undefined,
    rendererOutDir: undefined,
    artifactPath: undefined,
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") {
      args.help = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--app-package" || arg === "--renderer-src" || arg === "--renderer-out") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`缺少参数值：${arg}`);
      i += 1;
      if (arg === "--app-package") args.appPackagePath = value;
      else if (arg === "--renderer-src") args.rendererSrcDir = value;
      else args.rendererOutDir = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`未知选项：${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length > 1)
    throw new Error(`最多接受一个 artifact 路径，收到 ${positionals.length} 个`);
  args.artifactPath = positionals[0];
  return args;
}

function formatSummary(r) {
  return `发行验收：${r.ok ? "通过" : "失败"}

artifact : ${r.artifactPath}
文件名   : ${r.fileNameOk ? "✓" : "✗ 不匹配（需要 ReBaseAgent-0.2.0-win-x64-portable.exe）"}
应用版本 : ${r.appVersionOk ? "0.2.0 ✓" : "非 0.2.0 ✗"}
体积     : ${r.size.actual.toLocaleString("en-US")} bytes / 阈值 ${r.size.limit.toLocaleString("en-US")} bytes ${r.size.ok ? "✓" : `✗（超出 ${r.size.excess.toLocaleString("en-US")} bytes）`}

资源审计：
  renderer 源码违规 : ${r.sourceViolations.length === 0 ? "无 ✓" : ""}
${r.sourceViolations.map((v) => `    ✗ ${v.file}:${v.line} — ${v.reason}`).join("\n")}
  worker 集合       : ${r.workers === null ? "（未指定 renderer-out，跳过）" : r.workers.ok ? "editor/json worker 就绪 ✓" : ""}
${
  r.workers === null
    ? ""
    : [
        ...r.workers.missing.map((m) => `    ✗ ${m}`),
        ...r.workers.forbidden.map((f) => `    ✗ 禁用 worker 存在：${f}`),
      ].join("\n")
}
  renderer JS 总字节: ${r.workers === null ? "—" : r.workers.rendererJsBytes.toLocaleString("en-US")}
  worker 总字节     : ${r.workers === null ? "—" : r.workers.workerBytes.toLocaleString("en-US")}
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.artifactPath === undefined) {
    console.error("错误：缺少 artifact 路径。用 --help 查看用法。");
    return 2;
  }

  const result = verifyRelease({
    artifactPath: args.artifactPath,
    appPackagePath: args.appPackagePath ?? join(APP_ROOT, "package.json"),
    rendererSrcDir: args.rendererSrcDir ?? join(APP_ROOT, "src", "renderer"),
    rendererOutDir: args.rendererOutDir ?? join(APP_ROOT, "dist", "renderer", "assets"),
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatSummary(result));
  }
  return result.ok ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`release:verify 失败：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  });
