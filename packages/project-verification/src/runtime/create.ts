import type { ResourceRegistration } from "../schema.js";
import type { RuntimeResourceFacts } from "./reconcile.js";
import {
  OWNER_LABEL_KEY,
  type RegistrationRequest,
  bindCreatedContainer,
  registerResourceBeforeCreate,
} from "./registration.js";

/**
 * 受控资源创建编排（R3 tasks 3.7「创建前资源登记」；验收 P22 的响应丢失切片）。
 *
 * design D4：「创建资源之前先持久化确定性唯一名称及 owner 标签，create 后再绑定
 * 返回 ID，覆盖响应丢失窗口」——顺序在此钉死：
 *
 * 1. **register**（phase=registered，落盘先行）——此后无论 create 成败，磁盘上都有
 *    名称/owner 归属，启动核查可按 label+名字定位（§1.6 探针 A：按名 start/rm 均成功）；
 * 2. **create**（`docker create --name … --label …`，旗标来自 manifest 映射，3.2）；
 * 3. **bind**（phase=created + 容器 ID）——响应丢失窗口就此关闭。
 *
 * create 结果分四类：成功 / **stale-name**（同名残留未清 ⇒ 拒绝，先跑启动核查）/
 * **failed**（明确未创建：CLI 缺失、daemon 拒绝、spawn 失败——请求未到达引擎）/
 * **unknown**（超时或空响应：请求可能已被引擎处理 ⇒ 按名探查消解；仍不可判则如实
 * unknown，登记保持 registered，等下次启动核查收尾——绝不乐观宣布）。
 */

export class RuntimeCreateUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeCreateUnknownError";
  }
}

export class RuntimeCreateStaleNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeCreateStaleNameError";
  }
}

export interface RuntimeContainerCreatePort {
  /**
   * 创建容器（不启动）。返回 64 位容器 ID。**明确失败**（spawn 失败/daemon 拒绝，
   * 请求未到达引擎）抛普通 Error；**结果未知**（超时/空响应——请求可能已被引擎处理）
   * 抛 RuntimeCreateUnknownError；同名残留抛 RuntimeCreateStaleNameError。
   */
  createContainer(request: {
    readonly name: string;
    readonly labels: Readonly<Record<string, string>>;
    readonly imageRef: string;
    readonly runFlags: readonly string[];
    readonly command: readonly string[];
  }): Promise<{ readonly containerId: string }>;
  /** 按名精确探查容器；明确不存在 ⇒ null；探查本身不可判 ⇒ 抛错。 */
  resolveContainerByName(name: string): Promise<RuntimeResourceFacts | null>;
}

export type RegisteredCreateOutcome =
  | {
      readonly ok: true;
      readonly registration: ResourceRegistration;
      readonly containerId: string;
    }
  | { readonly ok: false; readonly kind: "stale-name" | "failed"; readonly reason: string }
  | {
      readonly ok: false;
      readonly kind: "unknown";
      readonly reason: string;
      /** 已落盘的登记（phase=registered）——下次启动核查按此收尾。 */
      readonly registration: ResourceRegistration;
    };

export interface CreateRegisteredContainerInput {
  readonly root: string;
  readonly port: RuntimeContainerCreatePort;
  readonly request: RegistrationRequest;
  readonly imageRef: string;
  /** manifest → 旗标映射（containerRunFlags）；本函数不内嵌限额常数。 */
  readonly runFlags: readonly string[];
  /** 容器内命令（PID 1 = 受控 supervisor，workloadContainerCommand）。 */
  readonly command: readonly string[];
}

export async function createRegisteredContainer(
  input: CreateRegisteredContainerInput,
): Promise<RegisteredCreateOutcome> {
  // 1. 创建之前先落登记（phase=registered；同名登记已存在 ⇒ 拒绝，不覆盖）
  const registration = registerResourceBeforeCreate(input.root, input.request);

  // 2. create
  let containerId: string;
  try {
    const created = await input.port.createContainer({
      name: registration.containerName,
      labels: { [OWNER_LABEL_KEY]: registration.ownerLabel },
      imageRef: input.imageRef,
      runFlags: input.runFlags,
      command: input.command,
    });
    containerId = created.containerId;
  } catch (error) {
    if (error instanceof RuntimeCreateUnknownError) {
      // 3a. 响应丢失窗口：按名探查消解（§1.6 探针 A 的产品化路径）
      try {
        const resolved = await input.port.resolveContainerByName(registration.containerName);
        if (resolved !== null) {
          const bound = bindCreatedContainer(
            input.root,
            registration.resourceOwnerId,
            resolved.containerId,
          );
          return { ok: true, registration: bound, containerId: resolved.containerId };
        }
        return {
          ok: false,
          kind: "failed",
          reason: `create 结果未知，但按登记名未发现容器（判定未创建）：${error.message}`,
        };
      } catch (resolveError) {
        return {
          ok: false,
          kind: "unknown",
          reason: `create 结果未知且按名探查不可判（${resolveError instanceof Error ? resolveError.message : String(resolveError)}）：${error.message}`,
          registration,
        };
      }
    }
    return {
      ok: false,
      kind: error instanceof RuntimeCreateStaleNameError ? "stale-name" : "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  // 3b. create 成功：绑定容器 ID（phase=created）
  const bound = bindCreatedContainer(input.root, registration.resourceOwnerId, containerId);
  return { ok: true, registration: bound, containerId };
}
