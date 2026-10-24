import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { requireRecordId, runtimeRegistrationPath } from "../records/layout.js";
import { type ResourceRegistration, ResourceRegistrationSchema } from "../schema.js";

/**
 * 运行时资源登记（R3 tasks 3.7；验收 P22/P23 的登记面）。
 *
 * design D4 硬规则在此落牙：
 * - **创建之前先落登记**：容器名/owner 归属先持久化（phase=registered），`docker create`
 *   成功后回填容器 ID（phase=created）——create 响应丢失窗口内，按登记名 + owner 标签
 *   仍可定位（§1.6 探针 A 实证：按名 start/rm 均成功）；
 * - **确定性名称**：容器名由 `kind + resourceOwnerId` 确定性派生，resourceOwnerId 随机
 *   唯一 ⇒ 名称全局唯一且可复算；恢复侧以登记内落盘名为准、派生值交叉核对；
 * - **owner 标签**：`rebaseagent.owner=rebaseagent-r3`（label 过滤为精确键值匹配，
 *   name 过滤是子串匹配 ⇒ 资源定位以 label 为主、名字精确比对兜底，§1.6）；
 * - **有界、可原子替换**：登记不是结果事实源、不是操作 registry；整文件临时写入 +
 *   fsync + rename 原子替换（不留半文件）；不存授权/正文/凭据；
 * - **损坏即阻断**：JSON/schema/身份（文件名 ≠ 内容 resourceOwnerId）任一不过 ⇒
 *   `RegistrationIoError`，启动核查侧据此保持 R3 阻断（P23「恢复记录损坏」）。
 */

/** owner 标签键（§1.6 探针口径）。 */
export const OWNER_LABEL_KEY = "rebaseagent.owner";
/** owner 标签值（与 schema `ResourceRegistrationSchema.ownerLabel` literal 一致）。 */
export const OWNER_LABEL_VALUE = "rebaseagent-r3" as const;

export type ResourceOwnerKind = ResourceRegistration["kind"];

/** 登记名派生前缀：kind → 名字段（容器名还需过 Docker 命名字符集）。 */
const KIND_NAME_PREFIX: Record<ResourceOwnerKind, string> = {
  prepare: "r3-prepare",
  verification: "r3-verify",
};

/**
 * 本产品名下容器的名字形态（归属判定之一）：`r3-<prepare|verify>-<resourceOwnerId>`。
 * resourceOwnerId 已被 requireRecordId 收窄为 `[a-z0-9][a-z0-9_-]{0,63}`，
 * 派生名整体满足 Docker 命名规则且总长 ≤ 76。
 */
export const RUNTIME_CONTAINER_NAME_PATTERN = /^r3-(prepare|verify)-[a-z0-9][a-z0-9_-]{0,63}$/;

export class RegistrationIoError extends Error {
  constructor(
    readonly code: "REGISTRATION_CORRUPT" | "REGISTRATION_IO_FAILED" | "REGISTRATION_EXISTS",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "RegistrationIoError";
  }
}

/** 新资源属主 ID：小写 UUID（36 字符，满足 RECORD_ID_PATTERN），每次尝试唯一。 */
export function newResourceOwnerId(): string {
  return randomUUID();
}

/** 由 kind + resourceOwnerId 确定性派生容器名（登记与恢复共用同一派生）。 */
export function deriveContainerName(kind: ResourceOwnerKind, resourceOwnerId: string): string {
  try {
    requireRecordId("resourceOwnerId", resourceOwnerId);
  } catch (error) {
    throw new RegistrationIoError(
      "REGISTRATION_IO_FAILED",
      `resourceOwnerId 不合法：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const name = `${KIND_NAME_PREFIX[kind]}-${resourceOwnerId}`;
  if (!RUNTIME_CONTAINER_NAME_PATTERN.test(name)) {
    throw new RegistrationIoError(
      "REGISTRATION_IO_FAILED",
      `派生容器名不合法（不应发生）：${name}`,
    );
  }
  return name;
}

function registrationDir(root: string): string {
  return join(root, "verification-runtime");
}

/**
 * 原子替换写入：临时文件（同目录，wx 排他）→ rename 覆盖。崩溃不留半文件，
 * 满足 D4「允许原子替换」；Windows 下 `renameSync` 以 MOVEFILE_REPLACE_EXISTING 语义覆盖。
 */
function atomicReplace(file: string, entry: ResourceRegistration): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const temp = join(
    dir,
    `.${entry.resourceOwnerId}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  let written = false;
  try {
    writeFileSync(temp, `${JSON.stringify(entry, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    written = true;
    renameSync(temp, file);
  } finally {
    if (!written || existsSync(temp)) {
      rmSync(temp, { force: true });
    }
  }
}

/** 读取并校验单条登记：JSON/schema/文件名身份三重门，任一不过即损坏。 */
export function readResourceRegistration(
  root: string,
  resourceOwnerId: string,
): ResourceRegistration {
  requireRecordId("resourceOwnerId", resourceOwnerId);
  const file = runtimeRegistrationPath(root, resourceOwnerId);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new RegistrationIoError("REGISTRATION_IO_FAILED", `登记不可读：${String(error)}`);
  }
  return parseRegistrationText(text, resourceOwnerId, file);
}

function parseRegistrationText(
  text: string,
  expectedOwnerId: string,
  file: string,
): ResourceRegistration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RegistrationIoError(
      "REGISTRATION_CORRUPT",
      `登记不是合法 JSON（${file}）：${String(error)}`,
    );
  }
  const checked = ResourceRegistrationSchema.safeParse(parsed);
  if (!checked.success) {
    throw new RegistrationIoError(
      "REGISTRATION_CORRUPT",
      `登记形状不合法（${file}）：${checked.error.issues[0]?.path.join(".")} ${checked.error.issues[0]?.message}`,
    );
  }
  if (checked.data.resourceOwnerId !== expectedOwnerId) {
    throw new RegistrationIoError(
      "REGISTRATION_CORRUPT",
      `登记身份错配（${file}）：文件名 ${expectedOwnerId} ≠ 内容 ${checked.data.resourceOwnerId}`,
    );
  }
  return checked.data;
}

/**
 * 列出数据根内全部登记（恢复枚举面）。**任一损坏即抛错**——无法可信枚举残留时，
 * 调用方（启动核查）必须保持阻断，不得跳过损坏条目继续（P23）。
 */
export function listResourceRegistrations(root: string): ResourceRegistration[] {
  const dir = registrationDir(root);
  if (!existsSync(dir)) {
    return [];
  }
  const entries: ResourceRegistration[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || name.startsWith(".")) {
      continue;
    }
    const ownerId = name.slice(0, -".json".length);
    entries.push(readResourceRegistration(root, ownerId));
  }
  return entries.sort((a, b) => a.resourceOwnerId.localeCompare(b.resourceOwnerId));
}

export interface RegistrationRequest {
  readonly kind: ResourceOwnerKind;
  /** 创建本资源的 main 会话 epoch（新 main 用新 epoch，不恢复旧执行）。 */
  readonly epoch: string;
  /** 数据根绝对路径（归属诊断）。 */
  readonly dataRoot: string;
  readonly preparationId?: string;
  readonly verificationId?: string;
  /** 覆盖随机 ID（测试用）；缺省取 newResourceOwnerId()。 */
  readonly resourceOwnerId?: string;
}

/**
 * **创建资源之前**落登记（phase=registered）。同 ID 已有登记 ⇒ 拒绝（ID 唯一性碰撞
 * 防线；确需重试应换新 ID，不覆盖旧登记——旧登记可能是尚未核查的残留证据）。
 */
export function registerResourceBeforeCreate(
  root: string,
  request: RegistrationRequest,
): ResourceRegistration {
  const resourceOwnerId = request.resourceOwnerId ?? newResourceOwnerId();
  requireRecordId("resourceOwnerId", resourceOwnerId);
  const file = runtimeRegistrationPath(root, resourceOwnerId);
  if (existsSync(file)) {
    throw new RegistrationIoError(
      "REGISTRATION_EXISTS",
      `登记已存在（resourceOwnerId 必须唯一，拒绝覆盖）：${file}`,
    );
  }
  const entry: ResourceRegistration = ResourceRegistrationSchema.parse({
    resourceOwnerId,
    kind: request.kind,
    ownerLabel: OWNER_LABEL_VALUE,
    containerName: deriveContainerName(request.kind, resourceOwnerId),
    epoch: request.epoch,
    dataRoot: request.dataRoot,
    knownContainerIds: [],
    phase: "registered",
    preparationId: request.preparationId ?? null,
    verificationId: request.verificationId ?? null,
    updatedAt: new Date().toISOString(),
  });
  atomicReplace(file, entry);
  return entry;
}

/** 通用阶段推进：读旧登记 → 校验 → 换阶段/补事实 → 原子替换。 */
function advancePhase(
  root: string,
  resourceOwnerId: string,
  mutate: (entry: ResourceRegistration) => ResourceRegistration,
): ResourceRegistration {
  const current = readResourceRegistration(root, resourceOwnerId);
  const next = mutate(current);
  const checked = ResourceRegistrationSchema.parse(next);
  atomicReplace(runtimeRegistrationPath(root, resourceOwnerId), checked);
  return checked;
}

/** create 成功后绑定实际容器 ID（phase=created）——响应丢失窗口就此关闭。 */
export function bindCreatedContainer(
  root: string,
  resourceOwnerId: string,
  containerId: string,
): ResourceRegistration {
  if (!/^[a-f0-9]{64}$/i.test(containerId)) {
    throw new RegistrationIoError(
      "REGISTRATION_IO_FAILED",
      `容器 ID 形态不合法（应为 64 位十六进制）：${containerId}`,
    );
  }
  return advancePhase(root, resourceOwnerId, (entry) => ({
    ...entry,
    phase: "created",
    knownContainerIds: entry.knownContainerIds.includes(containerId)
      ? entry.knownContainerIds
      : [...entry.knownContainerIds, containerId],
    updatedAt: new Date().toISOString(),
  }));
}

/** 资源移除后登记收尾（phase=removed；容器 ID 历史保留，登记本身留作有界日志）。 */
export function markResourceRemoved(root: string, resourceOwnerId: string): ResourceRegistration {
  return advancePhase(root, resourceOwnerId, (entry) => ({
    ...entry,
    phase: "removed",
    updatedAt: new Date().toISOString(),
  }));
}
