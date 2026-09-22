import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * U1 任务 6.0：受控服务回归前置（6.4–6.6 复用）。
 *
 * 提供三件事（design D7）：
 *   1. **每流程重置剧本/服务**：`withMockLlm` 每个流程起一个全新实例，流程结束即关停。
 *      "重置"不做状态清理而是**换实例**——没有跨流程残留的可能（比 reset 更硬）。
 *   2. **使用测试配置并恢复原配置**：`applyTestSettings` 把 baseURL 指到受控服务，
 *      返回的 `restore()` 逐字节还原（原本不存在则删除），保障回归后不留痕。
 *   3. **日志只存受控测试数据**：`handle.entries()` 是内存镜像，断言请求格式/次数/顺序。
 *
 * ⚠️ 本模块只在测试与受控回归中使用，**不进产品代码路径**。
 */

const require = createRequire(import.meta.url);

/** 剧本回合（字段含义见 `scripts/mock-llm-server.cjs` 头注释） */
export interface MockTurn {
  content?: string;
  reasoning?: string;
  toolCalls?: Array<{ id?: string; name: string; args?: string }>;
  mode?: "sse" | "json" | "fail";
  status?: number;
  errorBody?: unknown;
  delayMs?: number;
  usage?: { in?: number; out?: number; cache_hit?: number; cache_miss?: number };
}

export interface MockScript {
  turns?: MockTurn[];
  fallback?: MockTurn;
}

export interface MockLogEntry {
  n: number;
  at: string;
  path: string;
  model?: string;
  stream: boolean;
  mode: "sse" | "json" | "fail";
  messages: Array<{ role: string; chars: number | null }>;
  tools: string[];
  turn: { content?: string } | { toolCalls: string[] };
}

export interface MockLlmHandle {
  port: number;
  url: string;
  /** 传给应用设置 baseURL 的值（客户端自拼 `/chat/completions`） */
  baseURL: string;
  served: () => number;
  entries: () => MockLogEntry[];
  reset: (nextScript?: MockScript) => void;
  close: () => Promise<void>;
}

interface MockModule {
  startMockLlmServer: (options: {
    script?: MockScript;
    logPath?: string;
    port?: number;
  }) => Promise<MockLlmHandle>;
  createMockLlmServer: (options: {
    script?: MockScript;
    logPath?: string;
    port?: number;
  }) => MockLlmHandle;
  DEFAULT_SCRIPT: MockScript;
}

export const mockLlm: MockModule = require("../../scripts/mock-llm-server.cjs");

/** 起一个受控服务实例（端口系统分配）；调用方负责 `close()` */
export function startMockLlm(
  options: { script?: MockScript; logPath?: string } = {},
): Promise<MockLlmHandle> {
  return mockLlm.startMockLlmServer(options);
}

/**
 * 每流程隔离：起服务 → 跑 fn → **无论成败**关停。
 *
 * ⚠️ 用"新实例"而不是"同一实例 + reset"：前者从结构上不可能串响应/串计数，
 * 后者依赖调用方记得 reset（忘记就静默污染下一个流程）。
 */
export async function withMockLlm<T>(
  script: MockScript,
  fn: (handle: MockLlmHandle) => Promise<T>,
): Promise<T> {
  const handle = await startMockLlm({ script });
  try {
    return await fn(handle);
  } finally {
    await handle.close();
  }
}

/** 文件快照（用于逐字节还原） */
export interface FileSnapshot {
  path: string;
  /** 原本是否存在；false 时 restore 应删除该文件 */
  existed: boolean;
  /** 原内容（existed 为 false 时为空串） */
  content: string;
}

export function snapshotFile(path: string): FileSnapshot {
  const existed = existsSync(path);
  return { path, existed, content: existed ? readFileSync(path, "utf8") : "" };
}

/** 逐字节还原（原本不存在则删除）；返回是否已还原到位 */
export function restoreFile(snapshot: FileSnapshot): boolean {
  if (snapshot.existed) {
    writeFileSync(snapshot.path, snapshot.content, "utf8");
    return readFileSync(snapshot.path, "utf8") === snapshot.content;
  }
  rmSync(snapshot.path, { force: true });
  return !existsSync(snapshot.path);
}

/** 受控测试配置（写入 `<dataDir>/settings.json`；与 main `SETTINGS_FILE_NAME` 同源） */
export interface TestSettings {
  baseURL: string;
  model: string;
  apiKey: string;
  upstreamBaseUrl?: string;
  proxyPort?: number;
}

/**
 * 把运行配置指向受控服务，并返回**逐字节还原**函数。
 *
 * 用法：
 *   const settingsPath = join(dataDir, "settings.json");
 *   const restore = applyTestSettings(settingsPath, { baseURL: handle.baseURL, model: "mock-model", apiKey: "test-key" });
 *   try { ...回归... } finally { expect(restore()).toBe(true); }
 */
export function applyTestSettings(settingsPath: string, settings: TestSettings): () => boolean {
  const snapshot = snapshotFile(settingsPath);
  const stored: Record<string, unknown> = {
    baseURL: settings.baseURL,
    model: settings.model,
    apiKey: settings.apiKey,
  };
  if (settings.upstreamBaseUrl !== undefined) stored.upstreamBaseUrl = settings.upstreamBaseUrl;
  if (settings.proxyPort !== undefined) stored.proxyPort = settings.proxyPort;
  writeFileSync(settingsPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  return () => restoreFile(snapshot);
}

/** `<dataDir>/settings.json` 路径（路径拼接只写一处，避免各流程写歪） */
export function settingsFileIn(dataDir: string): string {
  return join(dataDir, "settings.json");
}

/** 断言辅助：请求日志压缩成"格式/次数/顺序"三要素，便于回归比对 */
export function summarize(
  entries: MockLogEntry[],
): Array<{ mode: string; stream: boolean; tools: string[] }> {
  return entries.map((e) => ({ mode: e.mode, stream: e.stream, tools: e.tools }));
}
