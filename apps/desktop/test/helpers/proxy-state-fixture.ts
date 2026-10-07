import { ok } from "../../src/shared/ipc";
import type { ProxyState } from "../../src/shared/ipc";

/**
 * 代理状态的**测试夹具工厂**（design D1 引入 epoch/revision/recordsRevision 之后）。
 *
 * 为什么不手写对象字面量：`ProxyStateSchema` 新增了三个必填版本字段，
 * 散落在各测试里的 `{ enabled, running, port, upstreamBaseUrl, hasKey }`
 * 会**静默**过不了 schema（测试目录不在 tsconfig 的 include 里，
 * `pnpm typecheck` 绿并不覆盖它）——表现为 `proxy` 被置 null、
 * `recordingStatusReadFailed` 变 true，症状离病因很远。
 *
 * 纪律：新增 ProxyState 字段时**只改这里**，不要在用例里写字面量；
 * 用例只通过 `overrides` 覆盖它真正关心的字段。
 */

/** 夹具用的固定会话 epoch（断言"同一会话内不变"时可复用） */
export const FAKE_PROXY_EPOCH = "proxy-epoch-0001";

/** 默认版本事实：尚未捕获凭据、无落盘记录 */
export const DEFAULT_PROXY_REVISION = 0;
export const DEFAULT_PROXY_RECORDS_REVISION = 0;
/** 默认捕获版本：一次都没捕获过凭据 */
export const DEFAULT_KEY_CAPTURE_REVISION = 0;

export function proxyStateFixture(overrides?: Partial<ProxyState>): ProxyState {
  return {
    enabled: false,
    running: false,
    port: 18787,
    upstreamBaseUrl: "",
    hasKey: false,
    epoch: FAKE_PROXY_EPOCH,
    revision: DEFAULT_PROXY_REVISION,
    recordsRevision: DEFAULT_PROXY_RECORDS_REVISION,
    keyCaptureRevision: DEFAULT_KEY_CAPTURE_REVISION,
    ...overrides,
  };
}

/** `proxy:status` 通道的成功应答（信封形状） */
export function proxyStatusOk(overrides?: Partial<ProxyState>) {
  return ok(proxyStateFixture(overrides));
}
