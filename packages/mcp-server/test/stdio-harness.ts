import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ErrorEnvelopeSchema, SuccessEnvelopeSchema } from "../src/envelope.js";
import { QUERY_API_VERSION } from "../src/server.js";
import { DATA_DIR_FLAG } from "../src/startup.js";

/**
 * 5.3 的真实 stdio 线务器（测试专用，走**裸 JSON-RPC 帧**）。
 *
 * 为什么不用官方 Client 跑全部判据：Client 把帧封装成 promise，取消与响应的**先后**
 * 就被藏起来了。5.3 要钉的正是"这一帧到底有没有发出去"（S13/S14），所以：
 * - 需要看帧序与缺席 ⇒ 用这里的裸线务器；
 * - 需要证真实客户端也能跑通 ⇒ 用 SDK 的 `Client` + `StdioClientTransport`（另一处测试）。
 *
 * 纪律：
 * - `writeFrames()` 把一批帧作为**同一次 write** 交给子进程：SDK 的 stdio 传输在同一个
 *   `data` 事件里同步逐帧分发，因此"请求 + 针对它的取消"必然在 handler 起跑前都被处理完
 *   ⇒ 取消判据不靠时序运气（详见 stdio-lifecycle.test.ts 的说明）。
 * - 所有等待都有上限，子进程一律 `afterAll` 兜底回收：宁可测试红，也不让会话挂住。
 */

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const NODE = process.execPath;

const DEFAULT_WAIT_MS = 25_000;

export interface WireFrame {
  readonly jsonrpc: "2.0";
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

export interface ExitResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** 一行一个 JSON-RPC 帧（与 SDK 的 `serializeMessage` 同形状） */
export function encodeFrame(frame: Record<string, unknown>): string {
  return JSON.stringify(frame);
}

export function initFrame(id: number, protocolVersion = "2025-06-18"): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "mcp0-53-raw", version: "0.0.1" },
    },
  };
}

export const INITIALIZED_FRAME: Record<string, unknown> = {
  jsonrpc: "2.0",
  method: "notifications/initialized",
};

export function requestFrame(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method, params };
}

export function callFrame(
  id: number,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return requestFrame(id, "tools/call", { name, arguments: args });
}

/** `notifications/cancelled`：id 是这条通知自己的（通知不带 id，这里只留 method） */
export function cancelFrame(requestId: number, reason = "user cancelled"): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId, reason },
  };
}

interface Waiter {
  predicate: () => unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  description: string;
}

export class StdioSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly outChunks: string[] = [];
  private readonly errChunks: string[] = [];
  private readonly stderrLines: string[] = [];
  private readonly framesById: WireFrame[] = [];
  private readonly unparsed: string[] = [];
  private outBuffer = "";
  private errBuffer = "";
  private waiters: Waiter[] = [];
  private exitPromise: Promise<ExitResult> | undefined;
  private exited: ExitResult | undefined;

  private constructor(dataDir: string, extraArgs: readonly string[]) {
    this.child = spawn(NODE, [CLI, ...extraArgs, DATA_DIR_FLAG, dataDir], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.ingest(chunk, true);
    });
    this.child.stderr.on("data", (chunk: string) => {
      this.ingest(chunk, false);
    });
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("close", (code) => {
      this.flushBuffers();
      this.exited = { code, stdout: this.stdoutText(), stderr: this.stderrText() };
      this.failAll(new Error(`服务进程已退出（code=${String(code)}）`));
    });
  }

  static async start(dataDir: string, extraArgs: readonly string[] = []): Promise<StdioSession> {
    const session = new StdioSession(dataDir, extraArgs);
    // 就绪信号来自 stderr 的 server_ready：起进程后立刻写帧同样合法，这里只是让批次更可控
    await session.waitFor(
      () => (session.stderrLines.some((line) => line.includes("server_ready")) ? true : undefined),
      "等待 server_ready",
    );
    return session;
  }

  /** 一次 write 交出全部帧（同一批 ⇒ 同一个 data 事件内同步分发） */
  writeFrames(frames: readonly Record<string, unknown>[]): void {
    this.child.stdin.write(frames.map((frame) => `${encodeFrame(frame)}\n`).join(""));
  }

  writeFrame(frame: Record<string, unknown>): void {
    this.writeFrames([frame]);
  }

  /** 原样写入（用来喂非 JSON 文本：线务上的畸形输入不能靠封装函数造假） */
  writeRaw(text: string): void {
    this.child.stdin.write(text);
  }

  closeStdin(): void {
    this.child.stdin.end();
  }

  kill(): void {
    try {
      this.child.kill();
    } catch {
      // 已退出的进程无需处理
    }
  }

  /** 兜底回收：kill 后等落定（清临时数据根之前必须让子进程真走掉，否则 Windows 会 EBUSY） */
  async dispose(): Promise<void> {
    this.kill();
    try {
      await this.waitExit();
    } catch {
      // waitExit 的兜底超时：进程已被 kill，不再等它
    }
  }

  get frames(): readonly WireFrame[] {
    return this.framesById;
  }

  framesFor(id: number | string): WireFrame[] {
    return this.framesById.filter((frame) => frame.id === id);
  }

  /** 恰好一帧：0 帧与多帧都算异常（多帧 = 同一请求被回了两遍） */
  frameFor(id: number | string): WireFrame {
    const found = this.framesFor(id);
    if (found.length !== 1) {
      throw new Error(
        `id=${String(id)} 应有 1 帧响应，实得 ${String(found.length)}；stderr=${this.stderrText().slice(0, 400)}`,
      );
    }
    return found[0] as WireFrame;
  }

  stdoutText(): string {
    return this.outChunks.join("");
  }

  stderrText(): string {
    return this.errChunks.join("");
  }

  stderrFor(eventName: string): string[] {
    return this.stderrLines.filter((line) => line.includes(` ${eventName} `));
  }

  /** stdout 里未能解析成 JSON 的行（协议面污染 ⇒ 必须为空） */
  unparsedStdout(): string[] {
    return [...this.unparsed];
  }

  async waitForFrame(id: number | string): Promise<WireFrame> {
    await this.waitFor(() => this.framesFor(id)[0], `等待 id=${String(id)} 的响应帧`);
    return this.frameFor(id);
  }

  async waitForStderr(needle: string): Promise<string> {
    return this.waitFor(
      () => this.stderrLines.find((line) => line.includes(needle)),
      `等待 stderr 含 ${needle}`,
    );
  }

  /** 关闭 stdin 并等进程落定（EOF 释放资源的判据入口） */
  async end(): Promise<ExitResult> {
    this.closeStdin();
    return this.waitExit();
  }

  waitExit(): Promise<ExitResult> {
    if (this.exited !== undefined) return Promise.resolve(this.exited);
    this.exitPromise ??= new Promise<ExitResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`服务进程未在 ${String(DEFAULT_WAIT_MS)}ms 内退出`));
      }, DEFAULT_WAIT_MS);
      this.child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout: this.stdoutText(), stderr: this.stderrText() });
      });
    });
    return this.exitPromise;
  }

  private ingest(chunk: string, isStdout: boolean): void {
    if (isStdout) {
      this.outChunks.push(chunk);
      this.outBuffer += chunk;
      this.drainBuffer(true);
    } else {
      this.errChunks.push(chunk);
      this.errBuffer += chunk;
      this.drainBuffer(false);
    }
    this.pump();
  }

  private drainBuffer(isStdout: boolean): void {
    for (;;) {
      const index = isStdout ? this.outBuffer.indexOf("\n") : this.errBuffer.indexOf("\n");
      if (index === -1) return;
      const line = (
        isStdout ? this.outBuffer.slice(0, index) : this.errBuffer.slice(0, index)
      ).replace(/\r$/, "");
      if (isStdout) {
        this.outBuffer = this.outBuffer.slice(index + 1);
        if (line.trim().length > 0) this.recordStdoutLine(line);
      } else {
        this.errBuffer = this.errBuffer.slice(index + 1);
        if (line.trim().length > 0) this.stderrLines.push(line);
      }
    }
  }

  /** 进程退出时把没凑满一行的残段也记账，"半帧"这条事实才不会漏网 */
  private flushBuffers(): void {
    if (this.outBuffer.trim().length > 0) this.unparsed.push(this.outBuffer);
    if (this.errBuffer.trim().length > 0) this.stderrLines.push(this.errBuffer);
    this.outBuffer = "";
    this.errBuffer = "";
  }

  private recordStdoutLine(line: string): void {
    try {
      this.framesById.push(JSON.parse(line) as WireFrame);
    } catch {
      this.unparsed.push(line);
    }
  }

  private async waitFor<T>(predicate: () => T | undefined, description: string): Promise<T> {
    const immediate = predicate();
    if (immediate !== undefined) return immediate;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.timer !== timer);
        reject(
          new Error(
            `${description} 超时；stdout=${this.stdoutText().slice(0, 600)} stderr=${this.stderrText().slice(0, 600)}`,
          ),
        );
      }, DEFAULT_WAIT_MS);
      this.waiters.push({
        predicate,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        description,
      });
      this.pump();
    });
  }

  /** 每次收到新数据都复核一遍等待条件 */
  private pump(): void {
    const still: Waiter[] = [];
    for (const waiter of this.waiters) {
      let value: unknown;
      try {
        value = waiter.predicate();
      } catch (error) {
        clearTimeout(waiter.timer);
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      if (value === undefined) {
        still.push(waiter);
        continue;
      }
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    }
    this.waiters = still;
  }

  private failAll(error: Error): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`${waiter.description}：${error.message}`));
    }
  }
}

/**
 * 结果帧取出：协议错误帧（`error`）在这里直接判红——业务失败走的是 tool result，
 * 只有旁路/畸形请求才落到 JSON-RPC 错误域，两者混了就是判据失真。
 */
/** 6.2 改判：正文本体只在 content 投影（data 内对应位是 bodyIn 指针），从帧的 tool result 提取 */
export function frameBodyTexts(frame: WireFrame): string[] {
  const result = resultOf(frame);
  const content = result.content;
  if (!Array.isArray(content)) throw new Error("帧的 tool result 没有 content");
  const texts = [];
  for (const line of (content[0]?.text ?? "").split("\n")) {
    const match = /^\s*text: (.*)$/.exec(line);
    if (match === null) continue;
    const parsed = JSON.parse(match[1]);
    if (typeof parsed === "string") texts.push(parsed);
  }
  return texts;
}

export function resultOf(frame: WireFrame): Record<string, unknown> {
  if (frame.error !== undefined) {
    throw new Error(`期望 tool result 帧，实得协议错误帧：${JSON.stringify(frame.error)}`);
  }
  return frame.result as Record<string, unknown>;
}

export function envelopeOf(frame: WireFrame): ReturnType<typeof SuccessEnvelopeSchema.parse> {
  return SuccessEnvelopeSchema.parse(resultOf(frame).structuredContent);
}

export function okData<T>(frame: WireFrame): {
  data: T;
  envelope: ReturnType<typeof SuccessEnvelopeSchema.parse>;
} {
  const envelope = envelopeOf(frame);
  if (envelope.apiVersion !== QUERY_API_VERSION) {
    throw new Error(`apiVersion 应为 ${QUERY_API_VERSION}，实得 ${envelope.apiVersion}`);
  }
  return { data: envelope.data as T, envelope };
}

/** 业务失败：仍是 tool result 帧（isError + 统一信封），不是 JSON-RPC 错误帧 */
export function errorOf(frame: WireFrame): ReturnType<typeof ErrorEnvelopeSchema.parse>["error"] {
  const result = resultOf(frame);
  if (result.isError !== true) throw new Error("业务失败应带 isError:true");
  return ErrorEnvelopeSchema.parse(result.structuredContent).error;
}

/**
 * 数据根的目录树（只列名字，不读字节）：5.3 的"零写入"线务面判据。
 * 完整的集合 + SHA-256 字节指纹归 5.4，这里只钉"没多出文件、也没建目录"。
 */
export function treeListing(dir: string): string[] {
  const into: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current).sort()) {
      const next = join(current, name);
      const target = `${prefix}/${name}`;
      into.push(target);
      let children: string[] | undefined;
      try {
        children = readdirSync(next);
      } catch {
        children = undefined;
      }
      if (children !== undefined) walk(next, target);
    }
  };
  walk(dir, "");
  return into;
}
