import type {
  EndSpanPatch,
  RunEventInput,
  RunMetaInput,
  SpanKind,
  StartSpanAttr,
  TraceStreamEvent,
  Tracer,
  WorkspaceOrigin,
} from "@rebaseagent/trace-sdk";
import { FORMAT_VERSION } from "@rebaseagent/trace-sdk";
import { FILE_TOOLS_V1_PROFILE } from "./file-tools.js";
import type { WorkspaceWorld } from "./world.js";

/**
 * 隔离运行的**检查点 Tracer 包装器**（A design §5）。
 *
 * 它实现既有的 `Tracer` 接口并**委托**一个真实 `JsonlTracer`，只做三件 loop 不该知道的事：
 *
 * 1. **startRun 覆盖 meta**：把 runLoop 写的 `format_version: 1` 与自动 id 换成
 *    `v2 + 本次隔离 run id`，并注入 `run.meta.workspace`（profile / world_id / 审计标注 /
 *    初始快照 / origin）。loop 因此**完全不感知**文件系统——它照旧写自己的 v1 meta。
 * 2. **记录 span 的 kind**：`endSpan(id, patch)` 的签名里**没有 kind**（id 与 kind 的关联
 *    只在运行期知道），所以必须在 `startSpan` 时记下来。
 * 3. **轮末注入检查点**：`endSpan(agent.step)` 时把世界**当前映射**冻结成清单，
 *    与调用方给的 patch 合并后一起提交。这一步是同步的纯内存操作——文件 blob 在给
 *    工具返回成功**之前**就已经发布并刷盘了（2.2/2.5），所以检查点只是"引用哪些哈希"的记录，
 *    **不需要**在 loop 内等待任何异步复制。
 *
 * ## 为什么必须包装而不是改 loop
 *
 * `runLoop` 的签名与语义是共享契约（桌面、代理、卡带都用它），加一个"隔离模式"参数会让
 * 文件系统概念渗进纯 TS 循环。包装器让 loop **零改动**：它写它的 v1，wrapper 在边界上换掉。
 * 因此本模块也**不**新增 loop 生命周期回调、**不**把文件状态塞进 messages。
 *
 * ## 三个顺序/一致性约束
 *
 * - **初始快照必须在首次 LLM 前就绪**：`startRun` 时世界已经建好（导入或从父检查点分叉），
 *   meta 里的 `initial_snapshot` 直接冻结当前映射 ⇒ 首次 LLM 之前文件事实已落盘。
 * - **`world_id` 必须等于本 run id**（schema 的跨字段约束）：所以 id 由包装器生成、
 *   同时用于 meta 与 `world_id`，不能从外部塞两个可能不一致的值。
 * - **`workspace_snapshot` 只能挂在 agent.step 上**：BaseTracer 对写错 kind 的会直接抛错
 *   （见 1.3 的实现说明），wrapper 只在记录为 `agent.step` 的 id 上注入。
 */

/** 包装器构造参数 */
export interface CheckpointTracerOptions {
  /** 被委托的底层 Tracer（真实场景是 `JsonlTracer`，测试可用 `MemoryTracer`） */
  readonly delegate: Tracer;
  /** 本 run 的世界实例：`snapshot()` 提供检查点，`id` 之外的字段不参与 meta 注入 */
  readonly world: WorkspaceWorld;
  /** 本 run 的 id（== `world_id`；根 run 由编排层生成） */
  readonly runId: string;
  /** 初始快照的来源：根 run 为 `import`，分支为 `checkpoint` 指向直接父 */
  readonly origin: WorkspaceOrigin;
}

/**
 * 检查点 Tracer。**所有** `Tracer` 方法都转发给底层，仅在 startRun 与 endSpan(step) 做加工。
 *
 * 刻意不继承 `BaseTracer`：继承会带来第二份 span id 序号与活跃表，与底层冲突（同一 span
 * 会被登记两次、id 也会错位）。包装器是**透明的**——id 由底层生成、由底层落盘，
 * 本类只做"记住 kind"与"补一个字段"。
 */
export class WorkspaceCheckpointTracer implements Tracer {
  private readonly delegate: Tracer;
  private readonly world: WorkspaceWorld;
  private readonly runId: string;
  private readonly origin: WorkspaceOrigin;
  /** span id → kind。endSpan 的签名不带 kind，只能靠 startSpan 记 */
  private readonly spanKinds = new Map<string, SpanKind>();
  /** 本次 run 是否已经开始（防止在 startRun 之前 endSpan 到 agent.step 上误判） */
  private started = false;

  constructor(options: CheckpointTracerOptions) {
    this.delegate = options.delegate;
    this.world = options.world;
    this.runId = options.runId;
    this.origin = options.origin;
  }

  /**
   * 覆盖 meta 的版本/id 并注入 workspace。
   *
   * 覆盖而非校验：runLoop **一定**会写 `format_version: 1` 与它自己的 id，这是它的正常行为，
   * 隔离语义由本层负责（design §5「root 用 Tracer wrapper 覆盖 startRun 的 id」）。
   * 因此这里不读 `meta.format_version` 也不 assert 它是 1——那会把 loop 的实现细节变成契约。
   */
  startRun(meta: RunMetaInput): void {
    const initialSnapshot = this.world.snapshot();
    const injected: RunMetaInput = {
      ...meta,
      id: this.runId,
      // v2 = 隔离格式：让旧读取器明确拒绝（而不是静默剥掉 workspace 字段后降级执行同名 write_file）
      format_version: FORMAT_VERSION,
      workspace: {
        profile: FILE_TOOLS_V1_PROFILE,
        world_id: this.runId,
        // 审计标注：创建方声称本次已确认副本写入。**不是**权限判据（真正的授权是当前请求的
        // allowFileWrites，已在 3.3 门禁校验）——这里恒真只是记录形状。
        write_authorized: true,
        initial_snapshot: initialSnapshot,
        origin: this.origin,
      },
    };
    this.started = true;
    this.delegate.startRun(injected);
  }

  startSpan(attr: StartSpanAttr): string {
    const id = this.delegate.startSpan(attr);
    this.spanKinds.set(id, attr.kind);
    return id;
  }

  /**
   * 结束 span：若是 `agent.step`，把世界当前映射冻结成清单，与调用方 patch 合并后提交。
   *
   * ⚠️ **合并方向**：`workspace_snapshot` 由 wrapper **强制**写入，调用方给的值被忽略
   * （loop 不传；若将来有人传，静默采用调用方值会让"检查点反映真实文件状态"这条性质
   * 依赖调用方自觉）。其余字段原样透传。
   *
   * 冻结发生在 `endSpan` 调用的**那一刻**：此刻该轮全部顺序工具都已执行完
   * （loop 的 `endSpan(step)` 在工具循环之后），所以清单包含本轮所有写入。
   */
  endSpan(id: string, patch: EndSpanPatch = {}): void {
    const kind = this.spanKinds.get(id);
    this.spanKinds.delete(id);

    if (kind !== "agent.step") {
      this.delegate.endSpan(id, patch);
      return;
    }

    const stepPatch = {
      ...(patch as Record<string, unknown>),
      workspace_snapshot: this.world.snapshot(),
    };
    this.delegate.endSpan(id, stepPatch as EndSpanPatch);
  }

  endRun(event: RunEventInput): void {
    this.started = false;
    this.delegate.endRun(event);
  }

  /** 订阅委托底层：订阅者拿到的 `span.end` 事件里**已带**检查点（加工发生在 delegate 之前） */
  subscribe(listener: (event: TraceStreamEvent) => void): () => void {
    return this.delegate.subscribe(listener);
  }

  /** 是否已 startRun（编排层用它区分"跑过"与"预检就失败"；不参与 trace 语义） */
  hasStarted(): boolean {
    return this.started;
  }
}

/** 便捷构造：把世界与 run 身份一起交给包装器 */
export function createWorkspaceCheckpointTracer(
  options: CheckpointTracerOptions,
): WorkspaceCheckpointTracer {
  return new WorkspaceCheckpointTracer(options);
}
