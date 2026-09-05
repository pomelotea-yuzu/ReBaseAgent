import type { ProxyForkMeta, ProxyHandler, ProxyRecording } from "@rebaseagent/llm-proxy";
import {
  EmptyForkError,
  buildForkContext,
  buildForkRequest,
  createProxyHandler,
  startProxyServer,
} from "@rebaseagent/llm-proxy";
import type { ProxyHandlerOptions } from "@rebaseagent/llm-proxy";
import type { ProxyState } from "../shared/ipc";
import { ProxyRunRecorder } from "./proxy-recorder";
import type { RunRepository } from "./run-repository";
import type { SettingsStore } from "./settings";

/**
 * 本地录制代理的 main 侧编排：生命周期（启停/端口占用）、key 内存暂存、
 * 代理分叉（方案 a：编辑 messages 经代理用暂存 key 重发）。
 *
 * 纪律：
 * - key 只进 keyStore（main 内存），不持久化、不进任何日志或 IPC 回传
 * - 分叉校验在 main 复核：父 run 已封存 + 代理来源 + 空 fork 拒绝
 * - fork 走新通道 proxy:fork，完全不碰 runs:fork / replay 路径
 */
export class ProxyForkError extends Error {
  constructor(
    readonly code:
      | "PROXY_NO_KEY"
      | "PROXY_PARENT_INVALID"
      | "PROXY_EMPTY_FORK"
      | "PROXY_FORK_FAILED",
    message: string,
  ) {
    super(message);
  }
}

export interface ProxyManagerDeps {
  repository: RunRepository;
  settings: SettingsStore;
  tracesDir: string;
  /** fetch 注入（测试 stub，零真实 API；缺省全局 fetch） */
  fetchImpl?: ProxyHandlerOptions["fetchImpl"];
}

export class ProxyManager {
  private readonly keyStore: { lastKey?: string } = {};
  private server: { port: number; stop(): Promise<void> } | null = null;
  private handler: ProxyHandler | null = null;
  /** 最近一次分叉写入的 run id（recorder 回调写回，fork 编排读取） */
  private lastWrittenRunId: string | null = null;

  constructor(private readonly deps: ProxyManagerDeps) {}

  status(): ProxyState {
    const saved = this.deps.settings.loadProxy();
    return {
      enabled: saved.enabled,
      running: this.server !== null,
      port: this.server?.port ?? saved.port,
      upstreamBaseUrl: saved.upstreamBaseUrl,
      hasKey: this.keyStore.lastKey !== undefined,
    };
  }

  /** 启停即保存（端口/upstream 一并持久化）；已在运行时先停再按新配置启 */
  async toggle(input: {
    enabled: boolean;
    port: number;
    upstreamBaseUrl: string;
  }): Promise<ProxyState> {
    this.deps.settings.saveProxy(input);
    if (this.server !== null) {
      await this.stopServer();
    }
    if (input.enabled) {
      await this.startServer(input.port, input.upstreamBaseUrl);
    }
    return this.status();
  }

  /** 应用启动时按 settings 自动恢复 */
  async autoStart(): Promise<void> {
    const saved = this.deps.settings.loadProxy();
    if (saved.enabled) {
      try {
        await this.startServer(saved.port, saved.upstreamBaseUrl);
      } catch {
        // 启动失败不阻断应用启动；状态查询可见，用户可在设置里重试
      }
    }
  }

  private async startServer(port: number, upstreamBaseUrl: string): Promise<void> {
    const recorder = new ProxyRunRecorder(this.deps.tracesDir);
    const proxyBaseUrl = `http://127.0.0.1:${port}/v1`;
    this.handler = createProxyHandler({
      upstreamBaseUrl,
      proxyBaseUrl,
      keyStore: this.keyStore,
      recorder: {
        record: (recording: ProxyRecording, fork?: ProxyForkMeta) => {
          this.lastWrittenRunId = recorder.write(recording, fork);
        },
      },
      ...(this.deps.fetchImpl !== undefined ? { fetchImpl: this.deps.fetchImpl } : {}),
    });
    this.server = await startProxyServer({ port, handler: this.handler });
  }

  private async stopServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.handler = null;
    await server?.stop();
  }

  /**
   * 代理分叉：编辑 messages → 用暂存 key 经代理重发 → 录为 fork run。
   * 校验全部在 main 复核（渲染层的禁用只是 UX，不作为安全边界）。
   */
  async fork(request: {
    parentRunId: string;
    atSpanId: string;
    messages: Record<string, unknown>[];
  }): Promise<{ id: string }> {
    // 0. 前置条件：本会话捕获过 key 且代理处理器可用（不落盘 → 重启后自然失效）
    const authorization = this.keyStore.lastKey;
    if (authorization === undefined || this.handler === null) {
      throw new ProxyForkError(
        "PROXY_NO_KEY",
        "本会话未捕获到 key，请先把你的应用经代理跑一次（代理运行且有请求经过后即可重发）",
      );
    }

    // 1. 父 run 必须是已封存的代理 run
    let record: ReturnType<RunRepository["loadRunRecord"]>;
    try {
      record = this.deps.repository.loadRunRecord(request.parentRunId);
    } catch (e) {
      throw new ProxyForkError("PROXY_PARENT_INVALID", `父 run 读取失败：${(e as Error).message}`);
    }
    if (record.status !== "completed") {
      throw new ProxyForkError(
        "PROXY_PARENT_INVALID",
        `只能从已完成的 run 分叉：${request.parentRunId} 运行中断（crashed）`,
      );
    }
    if (record.meta.source?.kind !== "proxy") {
      throw new ProxyForkError(
        "PROXY_PARENT_INVALID",
        "该 run 不是代理录制的 run，不适用「编辑 messages 重发」；SDK 录制的 run 请使用「在此重跑」（tool_result 分叉）",
      );
    }

    // 2. 分叉点必须是当前 run 自身段的 llm.call
    const span = record.spans.find((s) => s.id === request.atSpanId);
    if (span === undefined || span.kind !== "llm.call") {
      throw new ProxyForkError(
        "PROXY_PARENT_INVALID",
        `分叉点 ${request.atSpanId} 不是本 run 的 llm.call span`,
      );
    }

    // 3. 空 fork 防线（main 复核一次；渲染层禁用只是 UX）
    try {
      buildForkRequest(span.request, request.messages);
    } catch (e) {
      if (e instanceof EmptyForkError) {
        throw new ProxyForkError("PROXY_EMPTY_FORK", e.message);
      }
      throw e;
    }

    // 4. 构造分叉请求经代理内部路径发起（走同一转发+录制路径，自动录为 fork run）
    const { body } = buildForkRequest(span.request, request.messages);
    const forkMeta: ProxyForkMeta = {
      parent: request.parentRunId,
      atSpan: request.atSpanId,
      editValue: request.messages,
    };
    this.lastWrittenRunId = null;
    try {
      const result = await this.handler.handle(buildForkContext(body, authorization), forkMeta);
      const recording = await result.recording;
      result.clientOk();
      if (recording === null) {
        throw new ProxyForkError("PROXY_FORK_FAILED", "分叉请求未被录制（内部路径异常）");
      }
    } catch (e) {
      if (e instanceof ProxyForkError) throw e;
      throw new ProxyForkError("PROXY_FORK_FAILED", `分叉重发失败：${(e as Error).message}`);
    }
    if (this.lastWrittenRunId === null) {
      throw new ProxyForkError("PROXY_FORK_FAILED", "分叉请求已完成但未产生 run 文件");
    }
    return { id: this.lastWrittenRunId };
  }
}
