import { sanitizeDiagnosticText } from "@rebaseagent/agent-loop";
import type { ProxyForkMeta, ProxyHandler, ProxyRecording } from "@rebaseagent/llm-proxy";
import {
  EmptyForkError,
  buildForkContext,
  buildForkRequest,
  createProxyHandler,
  startProxyServer,
} from "@rebaseagent/llm-proxy";
import type { ProxyHandlerOptions } from "@rebaseagent/llm-proxy";
import type { ProxyChangeKind, ProxyState } from "../shared/ipc";
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
      | "PROXY_FORK_FAILED"
      /** 响应已转发，但**本次**重发的录制写入失败：不借用别的 run id 报成功 */
      | "PROXY_RECORDING_WRITE_FAILED"
      /**
       * 提交携带的**预期凭据捕获版本**与 main 当前值不符（tasks 2.2b）。
       * 语义：确认到提交之间又发生过捕获（含同 hasKey 的 key 更换）。
       * 副作用前拒绝 ⇒ 无上游调用、无新 run，草稿保留并要求重新核对。
       */
      | "PROXY_CREDENTIAL_CHANGED"
      /**
       * 提交携带的**预期代理目标**（upstream/端口）与当前保存的配置不符。
       * 语义：核对时看到的是这台上游，提交前配置变了 ⇒ 费用归属需要重新核对。
       */
      | "PROXY_CONFIG_CHANGED",
    message: string,
  ) {
    super(message);
  }
}

/**
 * U4（design D5）：一次主动重发的**请求局部**上下文。
 *
 * 旧实现是一个 `lastWrittenRunId` 字段，被主动重发与被动录制共用：等待返回期间任何被动
 * 请求都会把它的值换掉，于是"分叉成功了"可能指的是别人的 run。这里改成按 handler 原样
 * 透传下来的**同一个 `ProxyForkMeta` 对象**匹配——被动录制不带 forkMeta，因此根本不进表。
 */
interface ForkWriteContext {
  runId: string | null;
  /** recorder 写入失败的受控文案（llm-proxy 为保护转发会吞掉异常，故在这里自己留痕） */
  writeFailure: string | null;
}

/**
 * 录制落盘面（`ProxyRunRecorder` 结构上即满足）。U4 用它做可注入边界，
 * 以便确定性制造"主动重发等待期间被动录制先后写入"与"录制写入失败"两类交错。
 */
export interface ProxyRecorderSink {
  write(recording: ProxyRecording, fork?: ProxyForkMeta): string;
}

export interface ProxyManagerDeps {
  repository: RunRepository;
  settings: SettingsStore;
  tracesDir: string;
  /** fetch 注入（测试 stub，零真实 API；缺省全局 fetch） */
  fetchImpl?: ProxyHandlerOptions["fetchImpl"];
  /**
   * recorder 工厂（缺省 = `new ProxyRunRecorder(tracesDir)`）。
   * ⚠️ 只是测试接缝，不是授权开关：生产不传，行为与注入前逐字节一致。
   */
  newRecorder?: (tracesDir: string) => ProxyRecorderSink;
  /**
   * 会话 epoch 生成器（缺省 `crypto.randomUUID`；测试注入固定值以断言"会话轮换"）。
   * 它只用于**新旧会话判别**——不是凭据、不是指纹、不参与任何门禁判定。
   */
  newEpoch?: () => string;
}

/** 变化通知的载荷（= `ProxyChangeEvent`；此处只声明 main 侧用到的形状） */
export interface ProxyChangeNotice {
  readonly epoch: string;
  readonly revision: number;
  readonly recordsRevision: number;
  readonly changes: readonly ProxyChangeKind[];
}

export class ProxyManager {
  private readonly keyStore: { lastKey?: string } = {};
  private server: { port: number; stop(): Promise<void> } | null = null;
  private handler: ProxyHandler | null = null;
  /** 按 forkMeta 对象匹配的主动重发上下文（被动录制不入表） */
  private readonly activeForks = new Map<ProxyForkMeta, ForkWriteContext>();

  /**
   * 会话 epoch（design D1）。**一次 main 生命周期内不变**——它回答的是
   * "这条通知来自哪一届 main"，不是"现在几点了"。renderer 用它避免
   * 拿旧会话的 revision 去否决新 main 的事实。
   */
  private readonly epoch: string;
  /** 状态 revision：凭据捕获/更换、监听启停、恢复完成或失败时单调推进 */
  private revision = 0;
  /** 记录 revision：**仅成功落盘**推进（recorder.write 抛错时不推进，design D4） */
  private recordsRevision = 0;
  /**
   * 凭据捕获版本（design D2）：**仅内存的捕获次数**，捕获/更换 key 时推进。
   *
   * ⚠️ 刻意与 `revision` 分开成两个字段：`revision` 也在监听启停、恢复完成时推进，
   * 把它当"凭据换过了"的判据会让**开关代理**作废执行确认（凭据其实没变）。
   * 捕获版本只回答"key 换没换过"——这正是「用谁的钱重发」这一项。
   *
   * 不持久化：重启后 main 不恢复 key，版本回到 0 是事实（`hasKey` 同时为 false），
   * 不是"静默回退"。
   */
  private keyCaptureRevision = 0;
  /**
   * 启动恢复阶段（design D3 / tasks 2.3a）。
   *
   * ⚠️ 刻意**不持久化**：它描述的是"本次 main 生命周期内那次启动尝试"，
   * 下次启动重新走一遍 autoStart，阶段自然从 stopped 起步。
   */
  private recovery: "stopped" | "recovering" | "failed" = "stopped";
  /** 恢复失败的受控诊断；非 null 时 `recovery` 必为 `failed` */
  private recoveryFailure: {
    code: "PORT_UNAVAILABLE" | "LISTEN_FAILED" | "UNKNOWN";
    message: string;
  } | null = null;
  /**
   * 变化通知订阅者。载荷是**不可变快照**，订阅者拿到后无法回写内部状态。
   * 通知本身不抛错（订阅者出错只吞掉自己那一份），更不能影响转发路径。
   */
  private readonly listeners = new Set<(notice: ProxyChangeNotice) => void>();

  constructor(private readonly deps: ProxyManagerDeps) {
    this.epoch = (deps.newEpoch ?? ((): string => crypto.randomUUID()))();
  }

  /**
   * 订阅代理事实变化（design D1）。返回解绑函数。
   *
   * 纪律：这是**只读通知**通道——不为被动录制创建 operation、不占主动执行槽、
   * 不产生模型调用；载荷只有 epoch/revision/recordsRevision 与受控类别。
   *
   * ⚠️ 这里**不做同 tick 合并**：每次事实变化各发一条通知。突发 IO 的防线在
   * renderer 侧（design D6 的原话是「靠 revision、在途合并和尾随刷新控制」）：
   * 重复的 `recordsRevision` 被 `proxy-changes.ts` 去重，而真正贵的列表读取由
   * `loadRuns` 的在途合并 + 尾随补发兜住——N 条通知至多产生「一个在飞 + 一次尾随」。
   * main 侧再加一层微任务合并并不会让列表读取更少，却会让"落盘即通知"多一个
   * 事件循环的延迟，也把 `changes` 的语义从"这次变了什么"变成"这一 tick 变了什么"。
   */
  onChange(listener: (notice: ProxyChangeNotice) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 推进状态 revision 并发出 `status` 变化 */
  private notifyStatus(): void {
    this.revision += 1;
    this.emit(["status"]);
  }

  /**
   * 推进记录 revision 并发出 `records` 变化。
   * ⚠️ 只在 recorder.write **成功返回**后调用；写入失败走 `notifyStatus` 的反面
   * ——不推进、不宣告新 run 可用（design D4 与 llm-proxy delta「写入失败不报告新记录」）。
   */
  private notifyRecord(): void {
    this.recordsRevision += 1;
    this.revision += 1;
    this.emit(["records"]);
  }

  /** 订阅前或失焦期间漏掉的变化由 renderer 读 `status()` 里的 revision 补齐 */
  private emit(changes: ProxyChangeKind[]): void {
    if (this.listeners.size === 0) return;
    const notice: ProxyChangeNotice = Object.freeze({
      epoch: this.epoch,
      revision: this.revision,
      recordsRevision: this.recordsRevision,
      changes: Object.freeze([...changes]) as readonly ProxyChangeKind[],
    });
    // 逐个订阅者隔离：一个人出错不影响其他人，也不影响转发
    for (const listener of [...this.listeners]) {
      try {
        listener(notice);
      } catch {
        // 通知是尽力而为的旁路：renderer 漏一次通知还有 revision 快照兜底
      }
    }
  }

  status(): ProxyState {
    const saved = this.deps.settings.loadProxy();
    return {
      enabled: saved.enabled,
      running: this.server !== null,
      port: this.server?.port ?? saved.port,
      upstreamBaseUrl: saved.upstreamBaseUrl,
      hasKey: this.keyStore.lastKey !== undefined,
      epoch: this.epoch,
      revision: this.revision,
      recordsRevision: this.recordsRevision,
      keyCaptureRevision: this.keyCaptureRevision,
      recovery: this.recovery,
      recoveryFailure: this.recoveryFailure,
    };
  }

  /**
   * 启停即保存（端口/upstream 一并持久化）；已在运行时先停再按新配置启。
   *
   * `enabled=true` 这条路径同时是恢复失败后的**显式重试**入口（delta「端口释放后
   * 显式应用配置可重试」）：与 `autoStart` 走同一个 `attemptListen`，成功与失败都留下
   * 同样的阶段与诊断，界面因此能对「恢复」与「重试」用同一套呈现。
   *
   * ⚠️ 失败**不吞**：异常原样抛给调用方（既有 `proxy:toggle` 语义），但状态里的
   * `recoveryFailure` 已经记好，界面不需要靠 catch 分支拼文案。
   */
  async toggle(input: {
    enabled: boolean;
    port: number;
    upstreamBaseUrl: string;
  }): Promise<ProxyState> {
    this.deps.settings.saveProxy(input);
    if (this.server !== null) {
      // 中间那次"先停"**不单独通知**：它不是用户可观察的稳态（同一 IPC 调用内立刻
      // 重新启或落到停止），发两次通知只会让 renderer 多做一轮无意义刷新。
      // 终态由本方法末尾统一推进一次。
      await this.stopServer();
    }
    if (input.enabled) {
      // ⚠️ 这里必须 await：`toggle` 的返回契约是"返回时监听已就绪"（既有语义）。
      //   漏 await 会让调用方拿到 status().port 就去连，实际还没 listen ⇒ ECONNREFUSED，
      //   且失败时的重抛会变成无人处理的 rejection。
      await this.attemptListen(input.port, input.upstreamBaseUrl);
    } else {
      // 显式停用：阶段与诊断一并复位（与 autoStart 的停用分支同口径）
      this.recovery = "stopped";
      this.recoveryFailure = null;
    }
    this.notifyStatus();
    return this.status();
  }

  /**
   * 应用启动时按 settings 自动恢复（design D3 / tasks 2.3a）。
   *
   * 四条纪律：
   * - **只尝试一次**，不加后台重试（多实例抢端口属于可见失败，不是该悄悄重试的事）；
   * - **失败不阻断应用启动**，历史阅读不受影响；
   * - **失败不伪造 enabled 回滚**：`enabled` 保持用户保存的意图，阶段记`failed`
   *   并留下受控诊断，让渲染层能说清"已启用但未监听"；
   * - **成功与失败都推进状态 revision**：renderer 不能停留在启动前的 stopped 事实里。
   *
   * ⚠️ 状态**回读**（`status()`）绝不触发监听，也不验证上游——回读是只读的。
   */
  async autoStart(): Promise<void> {
    const saved = this.deps.settings.loadProxy();
    if (!saved.enabled) {
      // 保存停用 ⇒ 不尝试监听（delta「保存停用不启动代理」）
      this.recovery = "stopped";
      this.recoveryFailure = null;
      this.notifyStatus();
      return;
    }
    this.recovery = "recovering";
    this.recoveryFailure = null;
    // 「进入恢复中」本身是可观察事实：renderer 首次读状态可能正好落在这段窗口里
    this.notifyStatus();
    // `attemptListen` 失败会重抛；autoStart **刻意吞掉**：恢复失败不阻断应用启动。
    await this.attemptListen(saved.port, saved.upstreamBaseUrl).catch(() => undefined);
    this.notifyStatus();
  }

  /**
   * 尝试监听并记录阶段终态（`autoStart` 与 `toggle(enabled=true)` 共用）。
   *
   * 抽出来的理由：恢复与「显式保存并应用」重试在语义上**是同一件事**——
   * 都是"按当前保存的配置试一次监听"。共用一份实现，界面才能对两者用同一套
   * 阶段呈现，不会出现"恢复有诊断、重试没有"的不一致。
   *
   * 🔴 失败时**不伪造 enabled 回滚**：`enabled` 是用户保存的意图，改它等于
   * 把"用户想开着"悄悄改成"用户关了"（delta「不把失败说成已停用」）。
   */
  private async attemptListen(port: number, upstreamBaseUrl: string): Promise<void> {
    this.recovery = "recovering";
    this.recoveryFailure = null;
    try {
      await this.startServer(port, upstreamBaseUrl);
      this.recovery = "stopped";
      this.recoveryFailure = null;
    } catch (error) {
      this.recovery = "failed";
      this.recoveryFailure = this.classifyRecoveryFailure(error, port);
      throw error;
    }
  }

  /**
   * 把启动异常归成**稳定类别 + 脱敏限长文案**（design D3 / delta「受控失败原因」）。
   *
   * ⚠️ 诊断会显示在界面上，因此必须先脱敏再限长：异常 message 可能带上游地址、
   * 端口占用方的路径，甚至本会话捕获到的 key（若错误链里带了请求头）。
   * 这里把当前暂存的 key 当作 secret 传进去，与 agent-loop 的诊断口径一致。
   *
   * 🔴 归类要同时认**错误码措辞与 llm-proxy 的中文译法**：`startProxyServer` 收到
   * `EADDRINUSE` 后会把错误码翻成「端口 N 已被占用，无法启动录制代理」再抛
   * （packages/llm-proxy/src/server.ts），错误码到这里已经丢失。只按英文
   * `EADDRINUSE`/`address already in use` 匹配会把最常见的端口占用错判成
   * 一般监听失败，界面就会给出"换端口"以外的无用提示。中文与英文都留。
   *
   * 只保留三类别：端口不可用、监听失败、其他。不回传 stack/异常对象/headers。
   */
  private classifyRecoveryFailure(
    error: unknown,
    port: number,
  ): { code: "PORT_UNAVAILABLE" | "LISTEN_FAILED" | "UNKNOWN"; message: string } {
    const raw = error instanceof Error ? error.message : String(error);
    const secrets = this.keyStore.lastKey === undefined ? [] : [this.keyStore.lastKey];
    // 剥掉可能的 "Error: " 前缀，避免和界面自己拼的前缀叠成"Error: Error: …"
    const text = raw.replace(/^(?:Error|TypeError|SystemError):\s*/u, "");
    const available = /\bEADDRINUSE\b|address already in use|端口占用|已被占用|端口已被使用/iu.test(
      text,
    );
    return {
      code: available ? "PORT_UNAVAILABLE" : "LISTEN_FAILED",
      message: sanitizeDiagnosticText(`端口 ${port} 启动监听失败：${text}`, secrets),
    };
  }

  private async startServer(port: number, upstreamBaseUrl: string): Promise<void> {
    const recorder = (this.deps.newRecorder ?? ((dir: string) => new ProxyRunRecorder(dir)))(
      this.deps.tracesDir,
    );
    const proxyBaseUrl = `http://127.0.0.1:${port}/v1`;
    this.handler = createProxyHandler({
      upstreamBaseUrl,
      proxyBaseUrl,
      keyStore: this.keyStore,
      // 捕获事实回执（design D1）：key 的写入发生在 llm-proxy 包内，注入方拿不到
      // "何时发生了捕获"。**每次捕获都推进版本**——哪怕字面量与上次相同，
      // 因为"是否换 key"由桌面侧的捕获版本与 renderer 确认绑定负责判断，
      // 这里只负责"发生过捕获"这一事实。
      onAuthorizationCaptured: () => {
        // 捕获版本与状态 revision 同时推进：前者回答"key 换没换过"，
        // 后者回答"有没有事实变化"。两者都推进才能让 renderer 既刷新门禁
        // 又作废绑在旧凭据上的执行确认（design D2）。
        this.keyCaptureRevision += 1;
        this.notifyStatus();
      },
      recorder: {
        record: (recording: ProxyRecording, fork?: ProxyForkMeta) => {
          // 只匹配"本次主动重发"的上下文：没有 forkMeta（被动录制）或不是登记中的
          // fork 对象，都不碰任何 activeForks 条目——被动 ID 不会被借走
          const context = fork === undefined ? undefined : this.activeForks.get(fork);
          try {
            const id = recorder.write(recording, fork);
            if (context !== undefined) context.runId = id;
          } catch (error) {
            if (context !== undefined) {
              context.writeFailure = error instanceof Error ? error.message : String(error);
            }
            // ⚠️ 写入失败**不**推进 recordsRevision、不发 records 通知
            //（design D4 / llm-proxy delta「写入失败不报告新记录」）：
            // 客户端响应仍按既有转发规则送达，但这条记录并不存在。
            // 原样抛出：llm-proxy 自行吞掉以保护转发（handler.ts:79）。失败事实已经
            // 记在 context 上，因此主动重发既不会误报成功，也不会二次写同一份录制。
            throw error;
          }
          // 成功落盘才推进记录 revision —— 这是"外部录完列表自动可见"的唯一触发点。
          // 主动重发走同一条路径：它同样产出一个新 run，同样该被列表看见。
          this.notifyRecord();
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
    expectedKeyCaptureRevision: number;
    expectedUpstreamBaseUrl: string;
    expectedPort: number;
  }): Promise<{ id: string }> {
    // 0. 提交版本失配 ⇒ 副作用前拒绝（tasks 2.2b / delta「提交前版本变化由 main 拒绝」）。
    //    位置刻意在**读父本之前**：这一条是纯内存比较，不碰磁盘也不碰上游，
    //    「确认到提交之间捕获了新凭据 / 改了代理配置」时不留下任何新 run。
    //    renderer 的禁用只是 UX；这里才是边界。
    if (request.expectedKeyCaptureRevision !== this.keyCaptureRevision) {
      throw new ProxyForkError(
        "PROXY_CREDENTIAL_CHANGED",
        "凭据在核对之后又变过了：请重新核对当前这次重发（草稿与目标已保留）",
      );
    }
    // 🔴 比的是**当前运行事实**而不是 `settings.loadProxy()` 的保存值：
    // `status().port` 在运行中返回的是**实际监听端口**，而保存值可能是 0（由系统分配）
    // 或旧端口——两者在正常运行时就不相等，拿保存值比会把每一次正常重发都误判成失配。
    // renderer 提交的是它 `proxy:status` 读到的值，所以这里必须用同一个来源。
    const current = this.status();
    if (
      request.expectedUpstreamBaseUrl !== current.upstreamBaseUrl ||
      request.expectedPort !== current.port
    ) {
      throw new ProxyForkError(
        "PROXY_CONFIG_CHANGED",
        "代理配置在核对之后又变过了：请重新核对当前这次重发（草稿与目标已保留）",
      );
    }

    // 1. 前置条件：本会话捕获过 key 且代理处理器可用（不落盘 → 重启后自然失效）
    const authorization = this.keyStore.lastKey;
    if (authorization === undefined || this.handler === null) {
      throw new ProxyForkError(
        "PROXY_NO_KEY",
        "本会话未捕获到 key，请先把你的应用经代理跑一次（代理运行且有请求经过后即可重发）",
      );
    }

    // 2. 父 run 必须是已封存的代理 run
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

    // 3. 分叉点必须是当前 run 自身段的 llm.call
    const span = record.spans.find((s) => s.id === request.atSpanId);
    if (span === undefined || span.kind !== "llm.call") {
      throw new ProxyForkError(
        "PROXY_PARENT_INVALID",
        `分叉点 ${request.atSpanId} 不是本 run 的 llm.call span`,
      );
    }

    // 4. 空 fork 防线（main 复核一次；渲染层禁用只是 UX）
    try {
      buildForkRequest(span.request, request.messages);
    } catch (e) {
      if (e instanceof EmptyForkError) {
        throw new ProxyForkError("PROXY_EMPTY_FORK", e.message);
      }
      throw e;
    }

    // 5. 构造分叉请求经代理内部路径发起（走同一转发+录制路径，自动录为 fork run）。
    //    身份只认**本次 forkMeta 对象**匹配到的上下文——等待返回期间到达的被动录制
    //    既不进这张表，也不能改写它的结论。
    const { body } = buildForkRequest(span.request, request.messages);
    const forkMeta: ProxyForkMeta = {
      parent: request.parentRunId,
      atSpan: request.atSpanId,
      editValue: request.messages,
    };
    const context: ForkWriteContext = { runId: null, writeFailure: null };
    this.activeForks.set(forkMeta, context);
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
    } finally {
      this.activeForks.delete(forkMeta);
    }
    if (context.writeFailure !== null) {
      // 录制写失败 ⇒ 这条 fork 记录并不存在。宁可报失败，也不拿别的 run 的 id 冒充成功。
      throw new ProxyForkError(
        "PROXY_RECORDING_WRITE_FAILED",
        `分叉响应已由代理转发，但本次录制写入失败：${context.writeFailure}`,
      );
    }
    if (context.runId === null) {
      throw new ProxyForkError("PROXY_FORK_FAILED", "分叉请求已完成但未产生 run 文件");
    }
    return { id: context.runId };
  }
}
