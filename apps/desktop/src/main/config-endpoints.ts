import type { Envelope, ProxyState } from "../shared/ipc";
import { ProxyToggleInputSchema, SettingsInputSchema, fail, ok } from "../shared/ipc";
import { OPERATION_ERROR } from "../shared/operations";
import type { TrustedSender } from "./operation-endpoints";
import type { OperationRegistry } from "./operation-registry";
import type { SettingsStore } from "./settings";

/**
 * 配置写通道（`settings:save` / `settings:clear` / `proxy:toggle`）的**纯逻辑处理体**
 * （U4 design D3、tasks 3.5/3.6）。与 `operation-endpoints.ts` 同一分层理由：
 * 本文件不 import electron，可直测「锁住时零写入」「错误不泄漏配置与密钥」这类判据。
 *
 * 为什么这三条要过 main 的锁：此前"未配置 / 忙碌不能改配置"只写在 renderer 的
 * `disabled` 上，直接 invoke 通道就能绕过 ⇒ 一次主动执行跑到一半，配置快照被换掉，
 * 用户看到的"用的是哪套配置"就成了两说。main 判锁与写入之间**不留 await 边界**。
 *
 * 三条共同顺序：可信 sender → 载荷形状 → 同步判锁 → 才写盘/换处理器。
 * 读取类通道（`settings:get` / `proxy:status` / `operations:status`）不受锁影响，
 * 始终可用；配置变更标记经 `operations:status` 的 `configurationBusy` 供界面禁用，
 * 不在 ProxyState 里再放一份（避免同一事实两个来源）。
 */

/** 代理编排里配置写通道真正需要的窄面（`ProxyManager` 结构上满足） */
export interface ProxyConfigWriter {
  status(): ProxyState;
  toggle(input: {
    enabled: boolean;
    port: number;
    upstreamBaseUrl: string;
  }): Promise<ProxyState>;
}

export interface ConfigEndpointDeps {
  settings: SettingsStore;
  proxy: ProxyConfigWriter;
  registry: OperationRegistry;
  isTrustedSender: (sender: TrustedSender) => boolean;
}

function rejectUntrusted(deps: ConfigEndpointDeps, sender: TrustedSender): Envelope<never> | null {
  if (deps.isTrustedSender(sender)) return null;
  return fail(
    OPERATION_ERROR.untrustedSender,
    new Error("配置通道只接受本应用窗口主 frame 的调用"),
  );
}

/** 同步判锁：返回 null 表示可以写；否则给出稳定码与原因（不写盘、不换处理器） */
function configurationBlock(deps: ConfigEndpointDeps): Envelope<never> | null {
  const gate = deps.registry.canChangeConfiguration();
  if (gate.ok) return null;
  return fail(
    OPERATION_ERROR.notAccepted,
    new Error(`配置变更被拒绝（${gate.reason}）：有主动操作或另一项配置变更正在进行`),
  );
}

/**
 * 写失败的对外文案：单行 message（`Error.stack` 是另一个属性，因此永不外泄），
 * 并把**本次提交的密钥值**从文案里抹掉——加密器把入参带进异常信息时不至于顺带回显。
 */
function describeConfigFailure(error: unknown, secret: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw.split(/\r?\n/)[0] ?? "";
  return secret.length > 0 ? firstLine.split(secret).join("[已隐去]") : firstLine;
}

/** `settings:save`：判锁与 `settings.save` 之间无 await ⇒ 检查与写入是一个原子决定 */
export function writeRunSettings(
  deps: ConfigEndpointDeps,
  sender: TrustedSender,
  payload: unknown,
): Envelope<{ configured: true }> {
  const rejected = rejectUntrusted(deps, sender);
  if (rejected !== null) return rejected;
  const parsed = SettingsInputSchema.safeParse(payload);
  if (!parsed.success) {
    return fail("INVALID_ARGUMENT", parsed.error);
  }
  const blocked = configurationBlock(deps);
  if (blocked !== null) return blocked;
  try {
    deps.settings.save(parsed.data);
    return ok({ configured: true });
  } catch (error) {
    return fail(
      "SETTINGS_SAVE_FAILED",
      new Error(describeConfigFailure(error, parsed.data.apiKey)),
    );
  }
}

/** `settings:clear`：同一条锁；清除后 `settings:get` 仍可用（读取不受锁影响） */
export function clearRunSettings(
  deps: ConfigEndpointDeps,
  sender: TrustedSender,
): Envelope<{ configured: false }> {
  const rejected = rejectUntrusted(deps, sender);
  if (rejected !== null) return rejected;
  const blocked = configurationBlock(deps);
  if (blocked !== null) return blocked;
  try {
    deps.settings.clear();
    return ok({ configured: false });
  } catch (error) {
    return fail("SETTINGS_CLEAR_FAILED", new Error(describeConfigFailure(error, "")));
  }
}

/**
 * `proxy:toggle`：启停会**保存配置并异步替换 listener/handler**，因此除了同一把锁，
 * 还要在 await 之前同步占住"配置变更中"标记，`finally` 无条件释放——
 * 期间新主动执行与其他配置变更都被拒（design D3）。
 * 这不是主动 operation：不进 runIds、不是一条执行记录。
 */
export async function toggleProxy(
  deps: ConfigEndpointDeps,
  sender: TrustedSender,
  payload: unknown,
): Promise<Envelope<ProxyState>> {
  const rejected = rejectUntrusted(deps, sender);
  if (rejected !== null) return rejected;
  const parsed = ProxyToggleInputSchema.safeParse(payload);
  if (!parsed.success) {
    return fail("INVALID_ARGUMENT", parsed.error);
  }
  const blocked = configurationBlock(deps);
  if (blocked !== null) return blocked;
  // 判锁与占标记之间不留 await：否则"检查通过 → 别的请求插队占槽 → 我们仍去换处理器"
  deps.registry.beginConfigurationChange();
  try {
    return ok(await deps.proxy.toggle(parsed.data));
  } catch (error) {
    return fail("PROXY_START_FAILED", new Error(describeConfigFailure(error, "")));
  } finally {
    deps.registry.endConfigurationChange();
  }
}
