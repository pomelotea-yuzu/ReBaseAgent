/**
 * 发行检查模块：release:verify CLI 与 vitest 共用的纯函数 + 确定性审计。
 *
 * 门禁（见 openspec change finish-v2-desktop-release）：
 * - 体积：单文件 portable 必须严格小于 100_000_000 bytes（Gitee 单附件阈值）。
 * - 身份：输入文件名与应用版本必须为 v0.2.0，旧 v0.1.0 产物不得冒充本次结果。
 * - 资源：renderer 源码不得从 monaco-editor 包根 / 基础语言聚合入口导入；
 *   构建产物必须包含 editor/json worker，且不得包含 ts/css/html worker。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

/** 分发体积硬阈值：严格小于 100,000,000 bytes，不用 100 MiB。 */
export const BYTE_LIMIT = 100_000_000;
/** 本次发行目标名（编码版本 0.2.0），builder 按 artifactName 模板生成。 */
export const EXPECTED_ARTIFACT_NAME = "ReBaseAgent-0.2.0-win-x64-portable.exe";
/** 本次发行应用版本。 */
export const EXPECTED_APP_VERSION = "0.2.0";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/**
 * renderer 源码静态审计规则：
 * - 禁止 `monaco-editor` 包根（只允许显式 ESM 子路径入口）
 * - 禁止基础语言聚合入口 `basic-languages/monaco.contribution`
 */
export const SOURCE_IMPORT_RULES = [
  {
    id: "monaco-package-root",
    pattern: /["']monaco-editor["']/,
    reason: "不得从 monaco-editor 包根导入（应使用显式 ESM 入口，见 design D1）",
  },
  {
    id: "monaco-basic-languages-entry",
    pattern: /basic-languages[\\/]monaco\.contribution/,
    reason: "不得导入基础语言聚合入口（plaintext 是 editor 内建语言，无需聚合入口）",
  },
];

/** 构建产物必须具备的 worker（Vite ?worker 按入口文件名输出）。 */
export const REQUIRED_WORKERS = [
  { label: "editor.worker", pattern: /^editor\.worker-.*\.js$/ },
  { label: "json.worker", pattern: /^json\.worker-.*\.js$/ },
];
/** 构建产物不得包含的未使用 worker。 */
export const FORBIDDEN_WORKER_PATTERNS = [
  /^ts\.worker-.*\.js$/,
  /^css\.worker-.*\.js$/,
  /^html\.worker-.*\.js$/,
];

/** 尺寸判定纯函数：唯一通过条件是 < BYTE_LIMIT。 */
export function isUnderByteLimit(bytes) {
  return bytes < BYTE_LIMIT;
}

/**
 * 尺寸判定结果；超出量按“还需减少多少字节才严格达标”计算。
 * @returns {{ ok: boolean, actual: number, limit: number, excess: number }}
 */
export function checkSize(bytes) {
  return {
    ok: isUnderByteLimit(bytes),
    actual: bytes,
    limit: BYTE_LIMIT,
    excess: Math.max(0, bytes - (BYTE_LIMIT - 1)),
  };
}

/**
 * 纯文本源码审计：返回给定文件内容中违反导入规则的条目（含文件路径与行号）。
 * @returns {Array<{ file: string, line: number, reason: string }>}
 */
export function auditRendererSourceText(relPath, content) {
  const violations = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    for (const rule of SOURCE_IMPORT_RULES) {
      if (rule.pattern.test(line)) {
        violations.push({ file: relPath, line: i + 1, reason: rule.reason });
      }
    }
  }
  return violations;
}

/** 递归收集目录下可审计源码文件的相对路径（跳过 node_modules）。 */
function collectSourceFiles(rootDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
        out.push(full);
      }
    }
  };
  walk(rootDir);
  return out;
}

/** 静态扫描 renderer 源码目录，返回全部违规导入（含具体路径）。 */
export function auditRendererSource(rootDir) {
  const violations = [];
  for (const file of collectSourceFiles(rootDir)) {
    const content = readFileSync(file, "utf8");
    violations.push(...auditRendererSourceText(relative(rootDir, file), content));
  }
  return violations;
}

/**
 * 构建产物 worker 审计（纯函数版）：files 为 assets 目录下的文件名列表。
 * @returns {{ ok: boolean, missing: string[], forbidden: string[] }}
 */
export function auditWorkerFileList(files) {
  const missing = [];
  for (const { label, pattern } of REQUIRED_WORKERS) {
    if (!files.some((f) => pattern.test(f))) {
      missing.push(`缺少必需 worker：${label}`);
    }
  }
  const forbidden = files.filter((f) => FORBIDDEN_WORKER_PATTERNS.some((p) => p.test(f)));
  return { ok: missing.length === 0 && forbidden.length === 0, missing, forbidden };
}

/**
 * 构建产物 worker 审计（目录版）：读取 assets 目录并附带字节数报告。
 * @returns {{ ok: boolean, missing: string[], forbidden: string[], rendererJsBytes: number, workerBytes: number }}
 */
export function auditWorkerAssets(assetsDir) {
  const files = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
  const base = auditWorkerFileList(files);

  let rendererJsBytes = 0;
  let workerBytes = 0;
  for (const f of files) {
    const size = statSync(join(assetsDir, f)).size;
    rendererJsBytes += size;
    if (/\.worker-.*\.js$/.test(f)) workerBytes += size;
  }

  return {
    ...base,
    forbidden: base.forbidden.map((f) => join(assetsDir, f)),
    rendererJsBytes,
    workerBytes,
  };
}

/**
 * 发行验收总入口：身份 + 体积 + 资源审计。
 * 任何一项失败即返回 ok=false；不做任何写入，供 CLI 输出与文档引用。
 * @param {{ artifactPath: string, appPackagePath?: string, rendererSrcDir?: string, rendererOutDir?: string }} options
 * @returns {{ ok: boolean, artifactPath: string, fileNameOk: boolean, appVersionOk: boolean, size: object, sourceViolations: object[], workers: object | null }}
 */
export function verifyRelease(options) {
  const { artifactPath } = options;
  const name = artifactPath.split(/[\\/]/).pop() ?? artifactPath;
  const fileNameOk = name === EXPECTED_ARTIFACT_NAME;

  let appVersionOk = true;
  if (options.appPackagePath !== undefined) {
    appVersionOk =
      existsSync(options.appPackagePath) &&
      JSON.parse(readFileSync(options.appPackagePath, "utf8")).version === EXPECTED_APP_VERSION;
  }

  const size = existsSync(artifactPath)
    ? checkSize(statSync(artifactPath).size)
    : { ok: false, actual: -1, limit: BYTE_LIMIT, excess: BYTE_LIMIT };

  const sourceViolations =
    options.rendererSrcDir !== undefined ? auditRendererSource(options.rendererSrcDir) : [];

  const workers =
    options.rendererOutDir !== undefined ? auditWorkerAssets(options.rendererOutDir) : null;

  const ok =
    fileNameOk && appVersionOk && size.ok && sourceViolations.length === 0 && (workers?.ok ?? true);

  return { ok, artifactPath, fileNameOk, appVersionOk, size, sourceViolations, workers };
}
