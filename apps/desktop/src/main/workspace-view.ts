import {
  createWorkspaceBlobStore,
  locateWorkspaceSnapshot,
  readWorkspaceFile,
} from "@rebaseagent/replay";
import type { WorkspaceLocateFailure } from "@rebaseagent/replay";
import type { WorkspaceFile, WorkspaceOrigin } from "@rebaseagent/trace-sdk";
import type {
  WorkspaceInspectFile,
  WorkspaceInspectRequest,
  WorkspaceInspectResult,
  WorkspaceReadFileRequest,
  WorkspaceReadFileResult,
} from "../shared/ipc";
import type { RunRepository } from "./run-repository";

/**
 * 隔离文件检查点的**只读**读取服务（C 任务 1.1）。
 *
 * 三条纪律（与 A 包 `read-api.ts` 的分工一致，本层只做"跨进程裁剪 + 状态归类"）：
 *
 * 1. **不接受任意物理路径**：请求里只有 `runId` / `stepSpanId` / 逻辑 `path`。附件物理位置
 *    由 A 包按**已校验哈希**推导（`workspace-blobs/sha256/<hash>`）——逻辑路径即便写成
 *    `sha256/<hash>` 或 `D:/x`，也只是"清单里没有这条路径"（`not_found`），永不拼进宿主路径。
 * 2. **两次独立读**：`inspectWorkspace` 定位清单并逐项 verify 附件（只判可用性，**不读字节**）；
 *    `readWorkspaceFileForView` 才真正读字节。两者都调 A 包同名接口，本层不重算哈希、
 *    不自己解析 JSONL。
 * 3. **零写入**：整条路径只有 `readFile`；不补写快照、不补附件、不读 source 兜底、不调 LLM/工具。
 *    失败一律是**可辨认的状态**而不是异常——`rejected` 才表示"请求本身不成立"。
 *
 * ⚠️ 本服务**不要求 run 已封存**：读取不是分叉，崩溃 run 里已落盘的检查点正是事故现场。
 */

/** 服务入参：dataDir 与仓库读取器；run 定位与附件校验一律交给 A 包 */
export interface WorkspaceViewDeps {
  /** 数据目录（main 按便携策略解析；trace 与附件都锚在这里） */
  dataDir: string;
  /**
   * 仓库读取器：只用来取**元数据**（profile / 步骤轮号）——清单与字节仍全部走 A 包。
   * 让 main 从同一条已校验通道读 trace，避免本层另开一条 JSONL 解析路径。
   */
  repository: Pick<RunRepository, "loadRunRecord">;
}

/**
 * 清单查看的结果：成功给 `result`，失败给**可展示**的拒绝信息。
 * 判别式联合而不是抛异常——"非法 runId"与"文件损坏"必须能被渲染层分开提示。
 */
export type WorkspaceInspectOutcome =
  | { readonly ok: true; readonly result: WorkspaceInspectResult }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** 把 A 包的定位失败映射成渲染层可展示的错误码 */
function locateFailureToOutcome(failure: WorkspaceLocateFailure): WorkspaceInspectOutcome {
  return { ok: false, code: `WORKSPACE_${failure.code.toUpperCase()}`, message: failure.reason };
}

/** origin 从 A 包的联合类型裁剪成跨进程可传的形状（与 schema 同形） */
function projectOrigin(origin: WorkspaceOrigin): WorkspaceInspectResult["origin"] {
  return origin.kind === "import"
    ? { kind: "import" }
    : { kind: "checkpoint", runId: origin.run_id, stepSpanId: origin.step_span };
}

/** 相对初始快照的变更状态：只按「路径 + 内容哈希」判定，不使用 mtime */
function changeState(
  file: WorkspaceFile,
  initialByPath: ReadonlyMap<string, WorkspaceFile>,
  isInitialSnapshot: boolean,
): WorkspaceInspectFile["change"] {
  if (isInitialSnapshot) return "initial";
  const before = initialByPath.get(file.path);
  if (before === undefined) return "added";
  return before.sha256 === file.sha256 ? "unchanged" : "modified";
}

/**
 * 逐项核对附件的可用性（存在 + 长度 + 哈希），**不读回字节**。
 *
 * 与 A 包分工：`WorkspaceBlobStore.verify` 是"只判可用性、不返回字节"的那一半，
 * 正是清单所需的粒度——列清单时上千个文件全读一遍既慢又浪费。哈希与长度比对仍由
 * A 包负责，本层只把三态归类成渲染层可展示的字段。
 */
async function inspectAvailability(
  store: ReturnType<typeof createWorkspaceBlobStore>,
  file: WorkspaceFile,
): Promise<Pick<WorkspaceInspectFile, "availability" | "unavailableReason">> {
  const verified = await store.verify({ sha256: file.sha256, bytes: file.bytes });
  return verified.state === "ok"
    ? { availability: "ok", unavailableReason: null }
    : { availability: verified.state, unavailableReason: verified.reason };
}

/**
 * 列出某个检查点（本 run 初始快照，或本 run 自有的某个完成步骤）的完整清单。
 *
 * `stepSpanId` 省略 = 初始快照（A 包语义）。指定时只能是**本 run 自有**的 `agent.step`：
 * 祖先前缀是 `resolveBranch` 拼接出来的、不存在于本 run 文件里，因此天然定位不到
 * （A 包报 `step_not_found`）——本层不代填、不兜底。
 */
export async function inspectWorkspace(
  deps: WorkspaceViewDeps,
  request: WorkspaceInspectRequest,
): Promise<WorkspaceInspectOutcome> {
  const locateRequest = {
    dataDir: deps.dataDir,
    runId: request.runId,
    ...(request.stepSpanId === undefined ? {} : { stepSpanId: request.stepSpanId }),
  };
  const located = locateWorkspaceSnapshot(locateRequest);
  if (!located.ok) return locateFailureToOutcome(located.failure);

  const { snapshot, origin, runId, stepSpanId } = located.value;

  // 初始快照必须单独定位一次：分支 run 的"相对初始"是**本 run 的**初始快照，不是父 run 的
  // —— 所以恒按 runId 取 stepSpanId=undefined 那份。取不到直接拒绝（不给"跳过比较"的降级）。
  const initial = locateWorkspaceSnapshot({ dataDir: deps.dataDir, runId });
  if (!initial.ok) return locateFailureToOutcome(initial.failure);
  const initialByPath = new Map(initial.value.snapshot.files.map((file) => [file.path, file]));
  const isInitialSnapshot = stepSpanId === null;

  const store = createWorkspaceBlobStore(deps.dataDir);
  const files: WorkspaceInspectFile[] = [];
  for (const file of snapshot.files) {
    const availability = await inspectAvailability(store, file);
    files.push({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      change: changeState(file, initialByPath, isInitialSnapshot),
      ...availability,
    });
  }

  // profile 与轮号从已校验的 run 记录读（`readRun` 已跑过 schema 与快照 id 重算，
  // 到这里的记录一定是合法的）——本层不另写解析逻辑
  const record = deps.repository.loadRunRecord(runId);
  const workspace = record.meta.workspace;
  const iteration = stepSpanId === null ? null : readStepIteration(record.spans, stepSpanId);

  return {
    ok: true,
    result: {
      runId,
      stepSpanId,
      snapshotId: snapshot.id,
      // 检查点所有者恒等于本次请求的 run：A 包只认本 run 自有记录
      ownerRunId: runId,
      // 轮号取**所属 run 自己的** agent.step.n——不按合并轨迹沿链累加（B 2.2 的纪律）。
      // 这里的 n 直接来自本 run 文件里那个 step 行，不存在跨 run 累加的可能。
      localIteration: iteration,
      profile: workspace?.profile ?? "",
      worldId: workspace?.world_id ?? runId,
      origin: projectOrigin(origin),
      files,
      fileCount: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      unavailableCount: files.filter((file) => file.availability !== "ok").length,
      initialSnapshotId: initial.value.snapshot.id,
    },
  };
}

/**
 * 该 step 的**本地**轮号 = 它在所属 run 文件里的 `agent.step.n`。
 *
 * 解析不到返回 null（不猜数字）：A 包已保证 `stepSpanId` 存在且是 `agent.step`，
 * 故这条分支只在"文件在两次读取之间被改动"时才可能命中。
 */
function readStepIteration(
  spans: readonly { id: string; kind: string; n?: number }[],
  stepSpanId: string,
): number | null {
  const step = spans.find((span) => span.id === stepSpanId);
  if (step === undefined || step.kind !== "agent.step") return null;
  return step.n ?? null;
}

/** 文件读取：把 A 包的结果裁剪成跨进程形状（二进制**不传字节**，只传大小/哈希） */
export async function readWorkspaceFileForView(
  deps: WorkspaceViewDeps,
  request: WorkspaceReadFileRequest,
): Promise<WorkspaceReadFileResult> {
  const result = await readWorkspaceFile({
    dataDir: deps.dataDir,
    runId: request.runId,
    path: request.path,
    ...(request.stepSpanId === undefined ? {} : { stepSpanId: request.stepSpanId }),
  });

  switch (result.status) {
    case "text":
      return {
        status: "text",
        path: result.path,
        bytes: result.file.bytes,
        sha256: result.file.sha256,
        text: result.text,
      };
    case "binary":
      return {
        status: "binary",
        path: result.path,
        bytes: result.file.bytes,
        sha256: result.file.sha256,
      };
    case "not_found":
      return { status: "not_found", path: result.path, reason: result.reason };
    case "missing":
      return {
        status: "missing",
        path: result.path,
        bytes: result.file.bytes,
        sha256: result.file.sha256,
        reason: result.reason,
      };
    case "corrupt":
      return {
        status: "corrupt",
        path: result.path,
        bytes: result.file.bytes,
        sha256: result.file.sha256,
        reason: result.reason,
      };
    case "rejected":
      return { status: "rejected", code: result.failure.code, reason: result.failure.reason };
  }
}
