import {
  type NotAcceptedReason,
  OPERATION_DIAGNOSTIC_MAX,
  type OperationArmSummary,
  type OperationDiagnostic,
  OperationDiagnosticsListSchema,
  type OperationRecord,
  type OperationSlotState,
  type OperationStatusResult,
  OperationStatusResultSchema,
  type OperationTarget,
  OperationUuidSchema,
  type RegistryVersion,
  type RequestOutcome,
  findSlotStateViolation,
} from "../shared/operations";

/**
 * U4 操作登记的 main 侧**纯逻辑核心**（design D1/D3）：main 会话内唯一的
 * `OperationRegistry`，持有 epoch、单调登记版本、受限元数据记录与一个主动执行槽。
 *
 * 本文件**不 import electron**（与 `draft-close-guard.ts` 同一分层理由）：
 * 全部依赖都是普通数据，可在 vitest 下直接单测；electron 事件 → 受限数据的适配在
 * `ipc.ts` / `draft-close-attach.ts`（测试路径之外）。
 *
 * 纪律：
 * - **只存允许字段**：正文、messages 内容、编辑值、sourceToken、授权值、apiKey、
 *   原始 Error/stack、模型响应、A/B 原始计划都没有对应字段（见 shared/operations）；
 * - **终态与封禁保留至 main 会话结束**：不提供任何按 UI 开合/列表淘汰清除记录的路径，
 *   因此重载后的首次握手必然能恢复 settled 与 notAccepted；
 * - **每次可变状态转换都递增 registryVersion**：包括 closing / configurationBusy 标记。
 *   renderer 的版本守卫据此不会「丢掉更新的锁状态」；
 * - **快照出口自证自洽**：`snapshot()` 输出前同时过 schema 精炼与槽引用检查，
 *   main 造出自相矛盾的快照时立即暴露，而不是让 renderer 猜。
 */

/** 注册表可观察变化的类别（测试与后续诊断用；不进入快照） */
export type RegistryChange = "accept" | "settle" | "not-accepted" | "identity" | "flag";

/**
 * 判重结论（design D2 第 2 步）。四种结果各自对应的后续动作由调用方（`tryAccept`）
 * 决定——registry 只回答「这个 ID 我见过吗、参数一样吗」，不做任何执行。
 */
export type AcceptanceLookup =
  | { outcome: "absent" }
  | { outcome: "duplicate"; record: OperationRecord }
  | { outcome: "banned"; record: OperationRecord }
  | { outcome: "conflict"; record: OperationRecord };

/** `tryAccept` 的五种结果——除 `accepted` 外都不产生任何执行副作用 */
export type AcceptResult =
  | { kind: "accepted"; record: OperationRecord }
  | { kind: "duplicate"; record: OperationRecord }
  | { kind: "banned"; record: OperationRecord }
  | { kind: "conflict"; record: OperationRecord }
  | { kind: "not-accepted"; record: OperationRecord };

export interface OperationRegistryOptions {
  /** epoch 生成器（默认 crypto.randomUUID；测试可注入固定值） */
  newEpoch?: () => string;
  /** 时间源（毫秒；测试注入固定时钟以获得确定的 ISO 时间戳） */
  now?: () => number;
  /** 每次登记版本变更的通知（装配层可接日志；不影响返回值） */
  onChanged?: (change: RegistryChange, version: RegistryVersion) => void;
}

/** 一条操作的内部可变状态；`toRecord()` 是它唯一的出口，且只产出允许字段 */
interface MutableOperation {
  readonly epoch: string;
  readonly operationId: string;
  target: OperationTarget | null;
  state: OperationRecord["state"];
  rejection: NotAcceptedReason | null;
  startedAt: string | null;
  settledAt: string | null;
  readonly runIds: string[];
  experimentId: string | null;
  readonly arms: OperationArmSummary[];
  requestOutcome: RequestOutcome | null;
  errorCode: string | null;
  readonly diagnostics: OperationDiagnostic[];
  /**
   * 会话 HMAC 摘要（**内部字段，绝不出快照**）：判重只比摘要，因此登记里
   * 既没有正文、也没有可跨会话复用的原始请求。reconcile 先到的 tombstone 为 null。
   */
  fingerprint: string | null;
}

function toRecord(operation: MutableOperation): OperationRecord {
  return {
    epoch: operation.epoch,
    operationId: operation.operationId,
    target: operation.target,
    state: operation.state,
    rejection: operation.rejection,
    startedAt: operation.startedAt,
    settledAt: operation.settledAt,
    runIds: [...operation.runIds],
    experimentId: operation.experimentId,
    arms: operation.arms.map((arm) => ({ ...arm })),
    requestOutcome: operation.requestOutcome,
    errorCode: operation.errorCode,
    diagnostics: operation.diagnostics.map((one) => ({ ...one })),
  };
}

/** 不变量被破坏（调用方逻辑错误）——必须以异常暴露，不能静默产出错登记 */
export class OperationRegistryInvariantError extends Error {
  constructor(reason: string) {
    super(`操作登记不变量被破坏：${reason}`);
    this.name = "OperationRegistryInvariantError";
  }
}

export class OperationRegistry {
  /** main 每次启动生成一次；全窗口共用，renderer 的文档会话 id 不能替代它 */
  readonly epoch: string;
  private readonly now: () => number;
  private readonly onChanged?: OperationRegistryOptions["onChanged"];
  private readonly operations = new Map<string, MutableOperation>();
  private version: RegistryVersion = 1;
  private activeOperationId: string | null = null;
  private closing = false;
  private configurationBusy = false;

  constructor(options: OperationRegistryOptions = {}) {
    this.epoch = (options.newEpoch ?? ((): string => crypto.randomUUID()))();
    this.now = options.now ?? ((): number => Date.now());
    this.onChanged = options.onChanged;
  }

  /** 当前登记版本（单调递增）：renderer 用它丢弃乱序/过期快照 */
  get registryVersion(): RegistryVersion {
    return this.version;
  }

  /** 当前占槽的操作 id（null = 空闲）。running 与占槽是同一事实的两面 */
  get activeId(): string | null {
    return this.activeOperationId;
  }

  /** 全局状态部分：status 与 reconcile 共用，锁由它派生而非由被查操作派生 */
  slotState(): OperationSlotState {
    return {
      epoch: this.epoch,
      registryVersion: this.version,
      activeOperationId: this.activeOperationId,
      closing: this.closing,
      configurationBusy: this.configurationBusy,
    };
  }

  /**
   * 本会话全部操作的受限元数据快照（含 settled 与 notAccepted）。
   * **不接受任何过滤参数**——按 renderer 关联或面板开合裁剪会让重载后读不到终态/封禁。
   */
  snapshot(): OperationStatusResult {
    const result: OperationStatusResult = {
      ...this.slotState(),
      operations: [...this.operations.values()].map(toRecord),
    };
    const violation = findSlotStateViolation(result, result.operations);
    if (violation !== null) throw new OperationRegistryInvariantError(`快照不自洽：${violation}`);
    const parsed = OperationStatusResultSchema.safeParse(result);
    if (!parsed.success) {
      throw new OperationRegistryInvariantError(
        `快照不合契约：${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}：${issue.message}`)
          .join("；")}`,
      );
    }
    return result;
  }

  /** 单条操作的受限快照（不存在返回 null）；查询本身不改变任何状态 */
  recordOf(operationId: string): OperationRecord | null {
    const operation = this.operations.get(operationId);
    return operation === undefined ? null : toRecord(operation);
  }

  /** 本会话已登记的操作数（性能测量用；不参与任何判定） */
  get size(): number {
    return this.operations.size;
  }

  // ---------------------------------------------------------------------------
  // 状态转换核心（1.4 的接受判定与 1.5 的收口都建立在这些 owner 校验之上）
  // ---------------------------------------------------------------------------

  /**
   * 判重（D2 第 2 步）：**在占槽与任何副作用之前**同步查 operationId。
   * - 同 ID 同指纹 → `duplicate`，调用方只关联原操作/原终态，绝不重新读配置或消费许可；
   * - 同 ID 异指纹（含换通道、换模式、改正文、调臂顺序）→ `conflict`，原登记一字不改；
   * - 已 notAccepted → `banned`，连指纹都不比（封禁结论永不复活）。
   */
  inspectForAcceptance(spec: {
    operationId: string;
    fingerprint: string;
  }): AcceptanceLookup {
    const existing = this.operations.get(spec.operationId);
    if (existing === undefined) return { outcome: "absent" };
    if (existing.state === "notAccepted") {
      return { outcome: "banned", record: toRecord(existing) };
    }
    if (existing.fingerprint === spec.fingerprint) {
      return { outcome: "duplicate", record: toRecord(existing) };
    }
    return { outcome: "conflict", record: toRecord(existing) };
  }

  /**
   * 接受序列的同步段（design D2 第 2–4 步）：**整段不含 await**，因此"查重 → 判锁 →
   * 占槽"是一个原子决定——两个不同入口在同一轮事件循环里同时提交，必然只有一个被接受。
   *
   * - `accepted`  ⇒ 已登记 running 并占槽；调用方随后才允许读 settings、消费许可、开始编排；
   * - `duplicate` ⇒ 同 ID 同参：只返回原关联/原终态，绝不重新执行；
   * - `banned`    ⇒ 该 ID 曾未接受（含 reconcile 封禁）：原结论照实返回，永不复活；
   * - `conflict`  ⇒ 同 ID 异参（含跨通道复用）：原登记一字不改，稳定码 OPERATION_CONFLICT；
   * - `not-accepted` ⇒ 新 ID 撞上 closing / 配置变更 / 槽忙：已登记 notAccepted 并封禁该 ID，
   *   零执行、零许可消费；用户要再试必须**换新的 operationId**。
   */
  tryAccept(spec: {
    operationId: string;
    target: OperationTarget;
    fingerprint: string;
  }): AcceptResult {
    const lookup = this.inspectForAcceptance(spec);
    if (lookup.outcome === "duplicate") return { kind: "duplicate", record: lookup.record };
    if (lookup.outcome === "banned") return { kind: "banned", record: lookup.record };
    if (lookup.outcome === "conflict") return { kind: "conflict", record: lookup.record };
    const gate = this.isAccepting();
    if (!gate.accepting) {
      return {
        kind: "not-accepted",
        record: this.registerNotAccepted({
          operationId: spec.operationId,
          target: spec.target,
          reason: gate.reason,
          fingerprint: spec.fingerprint,
        }),
      };
    }
    return { kind: "accepted", record: this.registerRunning(spec) };
  }

  /**
   * 登记 running 并占槽。调用方（`tryAccept`）必须已经确认槽空闲且没有
   * closing/configurationBusy；这里只做**不变量复核**，不重复业务判定。
   */
  registerRunning(spec: {
    operationId: string;
    target: OperationTarget;
    fingerprint: string;
  }): OperationRecord {
    this.assertOperationId(spec.operationId);
    if (this.activeOperationId !== null) {
      throw new OperationRegistryInvariantError("执行槽已被占用");
    }
    if (this.operations.has(spec.operationId)) {
      throw new OperationRegistryInvariantError("同一 operationId 重复登记");
    }
    const operation = this.newOperation({
      operationId: spec.operationId,
      target: spec.target,
      fingerprint: spec.fingerprint,
      state: "running",
      rejection: null,
      startedAt: this.timestamp(),
    });
    this.operations.set(spec.operationId, operation);
    this.activeOperationId = spec.operationId;
    this.bump("accept");
    return toRecord(operation);
  }

  /**
   * 登记 notAccepted：忙碌/关闭/配置变更被拒，或 reconcile 先到的永久封禁。
   * 不占槽、不写执行时间；同一 ID 一旦 notAccepted 就永不复活。
   */
  registerNotAccepted(spec: {
    operationId: string;
    target: OperationTarget | null;
    reason: NotAcceptedReason;
    /** 被拒请求的指纹（可选）：仅作内部留痕，封禁判定从不依赖它 */
    fingerprint?: string | null;
  }): OperationRecord {
    this.assertOperationId(spec.operationId);
    if (this.operations.has(spec.operationId)) {
      throw new OperationRegistryInvariantError("已存在的操作不能被改写为 notAccepted");
    }
    const operation = this.newOperation({
      operationId: spec.operationId,
      target: spec.target,
      fingerprint: spec.fingerprint ?? null,
      state: "notAccepted",
      rejection: spec.reason,
      startedAt: null,
    });
    this.operations.set(spec.operationId, operation);
    this.bump("not-accepted");
    return toRecord(operation);
  }

  /**
   * 置 settled 并**仅当自己是槽 owner 时**释放槽。
   *
   * owner 校验是「旧操作收尾不能释放新操作」的落点：A 已结束后其重复完成
   * 回调（或迟到结果）到达时，B 仍占槽，本次调用不改全局锁、不报错、
   * 也不把 B 的记录改成 A。
   */
  settle(spec: {
    operationId: string;
    requestOutcome: RequestOutcome;
    errorCode?: string | null;
  }): OperationRecord {
    const operation = this.requireOperation(spec.operationId);
    if (operation.state === "settled") {
      // 重复完成：既有终态与时间戳都不改写，也绝不二次释放槽
      return toRecord(operation);
    }
    if (operation.state === "notAccepted") {
      throw new OperationRegistryInvariantError("notAccepted 不能被反标为已执行");
    }
    operation.state = "settled";
    operation.settledAt = this.timestamp();
    operation.requestOutcome = spec.requestOutcome;
    operation.errorCode = spec.errorCode ?? null;
    this.releaseSlotOf(operation);
    this.bump("settle");
    return toRecord(operation);
  }

  /**
   * 追加可信运行身份（去重）。runId 只来自实际回调/结构化结果，
   * 且**一旦登记就不因后续失败而撤销**——它是身份事实，不是成功证明。
   */
  attachRunId(operationId: string, runId: string): void {
    const operation = this.requireRunning(operationId, "追加运行身份");
    if (operation.runIds.includes(runId)) return;
    operation.runIds.push(runId);
    this.bump("identity");
  }

  /** 声明本批次的 experimentId（仅 A/B；其余操作会在 schema 精炼处被拒） */
  attachExperimentId(operationId: string, experimentId: string): void {
    const operation = this.requireRunning(operationId, "关联 experimentId");
    if (operation.experimentId === experimentId) return;
    if (operation.experimentId !== null) {
      throw new OperationRegistryInvariantError("同一操作不得关联两个 experimentId");
    }
    operation.experimentId = experimentId;
    this.bump("identity");
  }

  /**
   * 追加/更新一个 A/B 臂摘要。未开始的臂由调用方显式登记 `id:null`，
   * 绝不凭空生成身份；已知 id 不会因为后续失败而回退为 null。
   */
  attachArm(operationId: string, arm: OperationArmSummary): void {
    const operation = this.requireRunning(operationId, "追加臂摘要");
    const existing = operation.arms.find((one) => one.index === arm.index);
    if (existing === undefined) {
      operation.arms.push({ ...arm });
    } else {
      if (existing.id !== null && arm.id !== null && existing.id !== arm.id) {
        throw new OperationRegistryInvariantError(`臂 ${arm.index} 出现两个运行身份`);
      }
      existing.id = existing.id ?? arm.id;
      existing.outcome = arm.outcome ?? existing.outcome;
    }
    operation.arms.sort((left, right) => left.index - right.index);
    this.bump("identity");
  }

  /**
   * 追加受控诊断（稳定码 + 限长文案）。诊断**不是登记变更**：不递增 registryVersion，
   * 因此诊断到达绝不会让一个迟到的终态被 renderer 当成「更新的状态」而采纳。
   */
  addDiagnostic(operationId: string, diagnostic: OperationDiagnostic): void {
    const operation = this.operations.get(operationId);
    if (operation === undefined) return;
    const parsed = OperationDiagnosticsListSchema.element.safeParse(diagnostic);
    if (!parsed.success) return;
    operation.diagnostics.push(parsed.data);
    // 超过上限即丢弃新条目：诊断丢失不得改变终态、runIds 或封禁事实
    if (operation.diagnostics.length > OPERATION_DIAGNOSTIC_MAX) {
      operation.diagnostics.length = OPERATION_DIAGNOSTIC_MAX;
    }
  }

  // ---------------------------------------------------------------------------
  // 关闭协商与配置变更标记（D3）：都不是主动 operation，不入 runIds
  // ---------------------------------------------------------------------------

  /** 退出协商开始/结束（D7）：期间拒绝新主动执行 */
  setClosing(closing: boolean): void {
    if (this.closing === closing) return;
    this.closing = closing;
    this.bump("flag");
  }

  /** 代理异步启停等配置变更开始（同步占标记，await 前完成） */
  beginConfigurationChange(): void {
    if (this.configurationBusy) {
      throw new OperationRegistryInvariantError("配置变更标记已被占用");
    }
    this.configurationBusy = true;
    this.bump("flag");
  }

  /** 配置变更结束（finally 调用；未占标记时释放为无操作） */
  endConfigurationChange(): void {
    if (!this.configurationBusy) return;
    this.configurationBusy = false;
    this.bump("flag");
  }

  /** 当前是否可接受新主动执行（不含判重，判重在 1.4 的接受序列里） */
  isAccepting(): { accepting: true } | { accepting: false; reason: NotAcceptedReason } {
    if (this.closing) return { accepting: false, reason: "closing" };
    if (this.configurationBusy) return { accepting: false, reason: "configuration_busy" };
    if (this.activeOperationId !== null) return { accepting: false, reason: "busy" };
    return { accepting: true };
  }

  // ---------------------------------------------------------------------------

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private newOperation(spec: {
    operationId: string;
    target: OperationTarget | null;
    fingerprint: string | null;
    state: OperationRecord["state"];
    rejection: NotAcceptedReason | null;
    startedAt: string | null;
  }): MutableOperation {
    return {
      epoch: this.epoch,
      operationId: spec.operationId,
      target: spec.target,
      state: spec.state,
      rejection: spec.rejection,
      startedAt: spec.startedAt,
      settledAt: null,
      runIds: [],
      experimentId: null,
      arms: [],
      requestOutcome: null,
      errorCode: null,
      diagnostics: [],
      fingerprint: spec.fingerprint,
    };
  }

  /** 入口即拒绝非 UUID 身份：坏 id 必须在本该被拒绝的那一次调用上暴露 */
  private assertOperationId(operationId: string): void {
    if (!OperationUuidSchema.safeParse(operationId).success) {
      throw new OperationRegistryInvariantError("operationId 必须是 UUID");
    }
  }

  private bump(change: RegistryChange): void {
    this.version += 1;
    this.onChanged?.(change, this.version);
  }

  private requireOperation(operationId: string): MutableOperation {
    const operation = this.operations.get(operationId);
    if (operation === undefined) {
      throw new OperationRegistryInvariantError(`未登记的操作 ${operationId}`);
    }
    return operation;
  }

  private requireRunning(operationId: string, action: string): MutableOperation {
    const operation = this.requireOperation(operationId);
    if (operation.state !== "running") {
      throw new OperationRegistryInvariantError(
        `${operationId} 已 ${operation.state}，不能${action}`,
      );
    }
    return operation;
  }

  /** 只有槽 owner 的终态才动槽；「running 却不占槽」是 main 内部错误，必须暴露 */
  private releaseSlotOf(operation: MutableOperation): void {
    if (this.activeOperationId === operation.operationId) {
      this.activeOperationId = null;
      return;
    }
    throw new OperationRegistryInvariantError("收尾的操作不是当前槽 owner");
  }
}
