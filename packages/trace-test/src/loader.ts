import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { readRun } from "@rebaseagent/trace-sdk";
import { type TraceTestDefinition, TraceTestDefinitionSchema } from "./definition.js";
import { TraceTestConfigError } from "./errors.js";

/** 加载并校验单个测试定义 JSON（1.2）。任何结构问题都是配置错误，不静默跳过。 */
export function loadDefinition(file: string): TraceTestDefinition {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    throw new TraceTestConfigError(`无法读取测试定义 ${file}：${(e as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new TraceTestConfigError(
      `测试定义 ${basename(file)} 不是合法 JSON：${(e as Error).message}`,
    );
  }
  const parsed = TraceTestDefinitionSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new TraceTestConfigError(
      `测试定义 ${basename(file)} 结构非法：${issue?.path.join(".") || "定义"} ${issue?.message ?? ""}（不支持的 format_version 也会在此被拒绝）`,
    );
  }
  return parsed.data;
}

/** trace 路径相对定义文件解析（1.1/1.2 契约：不依赖 cwd，CI 换目录不崩） */
export function resolveTracePath(definitionFile: string, trace: string): string {
  return isAbsolute(trace) || WIN_DRIVE_PATH.test(trace)
    ? trace
    : resolve(dirname(definitionFile), trace);
}

/**
 * Windows 盘符路径（`D:/...` 或 `D:\...`）在任意平台都视为绝对路径。
 * `node:path.isAbsolute` 是平台相关的——POSIX 上 `D:/x` 会被判为相对路径，
 * 导致 Windows 上编写的测试定义（含盘符绝对路径的 trace）在 Linux CI 中
 * 被错误地拼接进定义目录。V3-in-CI 的场景就是「Windows 上录的卡带进
 * Linux CI 跑」，因此这里必须跨平台识别盘符路径。
 */
const WIN_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/** 递归发现目录下全部 *.json 测试定义（不含 node_modules）；空目录是配置错误 */
export function discoverDefinitions(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive: true, withFileTypes: false })
      .map((e) => String(e))
      .filter((p) => p.endsWith(".json") && !p.includes("node_modules"));
  } catch (e) {
    throw new TraceTestConfigError(`无法读取测试目录 ${dir}：${(e as Error).message}`);
  }
  const files = entries.map((p) => join(dir, p)).sort();
  if (files.length === 0) {
    throw new TraceTestConfigError(`测试目录 ${dir} 下没有找到任何 *.json 测试定义`);
  }
  return files;
}

/** 读取被引用的 trace（复用既有读取器）；读取/校验失败包装为配置错误 */
export function loadTrace(tracePath: string): RunRecord {
  try {
    return readRun(tracePath);
  } catch (e) {
    throw new TraceTestConfigError(`读取 trace 失败（${tracePath}）：${(e as Error).message}`);
  }
}
