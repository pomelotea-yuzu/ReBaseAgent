import type { ProxyState } from "@shared/ipc";
import { useState } from "react";
import type { ReactNode } from "react";
import { proxyRecoveryView } from "../lib/proxy-recovery-view";
import type { RecordingDraft, RecordingDraftPatch } from "../lib/recording-draft";
import { isRecordingDraftDirty, recordingApplyRequest } from "../lib/recording-draft";
import { FOCUS_RING } from "./IconButton";
import { copyPayload } from "./LongText";

/**
 * U8 任务 2.4/2.7/2.8/2.9：录制工作区的**纯视图**（只吃 props；容器在下方）。
 *
 * 判据来源：design D2/D3 + delta 场景（逐字标题）：
 * - 「接入地址只来自已核实监听」：地址仅从最新有效 running=true 的 port 构造，
 *   草稿端口 / upstream / 应用在飞一律不可复制（「停止或未知状态撤销地址」同源）；
 * - 「key 捕获状态」「停止服务不称取消运行」：意图 / 监听 / 凭据三层分别呈现，
 *   文字与状态徽标同源，不靠颜色单打独斗；
 * - 「录制状态不冒充接入验证」：只有五字段契约里的事实，没有连通测试 / 速率 / 最近请求；
 * - 「录制刷新只读且错误可重试」：状态刷新 = 只读 loadProxyStatus，失败给重试入口。
 *
 * 本包无 jsdom：能力断言用 renderToStaticMarkup 打在本组件（喂 props）；
 * 输入在**变更事件**同步 store（关闭协商 D6 顺序，无 debounce）。
 */

/**
 * 已核实监听地址：仅 running=true 时由 port 构造；其余情形 null（不可复制）。
 *
 * ⚠️ tasks 2.3b：**恢复中也不给地址**。此刻 `running` 必为 false，本函数已经返回
 * null；这里额外写明是因为将来若有人想"给个预测端口"，那就是把配置草稿
 * 冒充成已核实事实。
 */
export function verifiedProxyAddress(proxy: ProxyState | null, applying: boolean): string | null {
  if (applying) return null;
  if (proxy === null || proxy.running !== true) return null;
  return `http://127.0.0.1:${proxy.port}/v1`;
}

/**
 * 状态区的三层事实行（意图 / 监听 / 凭据）+ 恢复阶段行。
 *
 * tasks 2.3b：本地监听与凭据两行改从 `proxyRecoveryView` 取值，顶栏与本页共用
 * 一份判据（原先这里自己写 `proxy.running ? … : "未监听…"`，会与顶栏的阶段文案
 * 出现"一边说失败一边说已停"的自相矛盾）。
 *
 * 四行固定顺序：启用意图 → 本地监听 → 恢复原因（仅有诊断时） → 本会话凭据。
 * 凭据行**始终保留**：delta 要求「本会话尚未捕获凭据时如实显示未捕获」，
 * 恢复成功也不能因为"看起来一切正常"就省掉它。
 */
export function recordingStatusLines(
  proxy: ProxyState | null,
  statusReadFailed: boolean,
): ReadonlyArray<{ label: string; value: string }> {
  if (statusReadFailed || proxy === null) {
    return [{ label: "真实状态", value: "状态待读取（读取失败或尚未读到；可只读重试）" }];
  }
  const view = proxyRecoveryView(proxy, statusReadFailed);
  const lines: Array<{ label: string; value: string }> = [
    {
      label: "保存的启用意图",
      value: proxy.enabled ? "已启用（配置已保存）" : "未启用",
    },
    { label: "本地监听", value: view.listenLine },
  ];
  // 受控原因只在真的有诊断时占一行：没有就不占位，避免出现空承诺的行
  if (view.reason !== null) {
    lines.push({ label: "恢复失败原因", value: view.reason });
  }
  lines.push({
    label: "本会话凭据",
    value: proxy.hasKey ? "已捕获（本会话有请求经过）" : "尚未捕获 key（重发预期不可用）",
  });
  return lines;
}

export function RecordingWorkspaceView({
  draft,
  proxy,
  statusReadFailed,
  applying,
  applyError,
  onField,
  onApply,
  onDiscard,
  onRefreshStatus,
  onOpenRecords,
  onRefreshRuns,
}: {
  readonly draft: RecordingDraft;
  readonly proxy: ProxyState | null;
  readonly statusReadFailed: boolean;
  readonly applying: boolean;
  readonly applyError: string | null;
  readonly onField: (patch: RecordingDraftPatch) => void;
  readonly onApply: () => void;
  readonly onDiscard: (expectedRevision: number) => void;
  readonly onRefreshStatus: () => void;
  readonly onOpenRecords: () => void;
  readonly onRefreshRuns: () => void;
}): ReactNode {
  const request = recordingApplyRequest(draft);
  const fieldErrors = request.ok ? { port: null, upstream: null } : request.errors;
  const dirty = isRecordingDraftDirty(draft);
  const address = verifiedProxyAddress(proxy, applying);
  const statusLines = recordingStatusLines(proxy, statusReadFailed);
  // 仅在恢复中 / 恢复失败时非 null：正常监听/停止不占用这一块，也不显示重试按钮
  const recoveryView = proxyRecoveryView(proxy, statusReadFailed);
  const recovery =
    recoveryView.phase === "recovering" || recoveryView.phase === "failed" ? recoveryView : null;
  const [copyFeedback, setCopyFeedback] = useState<"copied" | "unavailable" | null>(null);

  const copyAddress = (): void => {
    if (address === null) return;
    const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?: unknown } } })
      .navigator?.clipboard;
    if (
      clipboard === undefined ||
      typeof (clipboard as { writeText?: unknown }).writeText !== "function"
    ) {
      setCopyFeedback("unavailable");
      return;
    }
    void (clipboard as { writeText: (t: string) => Promise<void> })
      .writeText(copyPayload(address))
      .then(() => setCopyFeedback("copied"))
      .catch(() => setCopyFeedback("unavailable"));
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5" data-recording-body>
      {/* —— 配置区（保存并应用是唯一的配置写通道）—— */}
      <section className="rounded border border-gray-200" aria-label="录制配置">
        <div className="border-b border-gray-100 px-4 py-2 text-reading-meta font-medium text-gray-700">
          配置（「保存并应用」同时保存并启停本地监听）
        </div>
        <div className="flex flex-col gap-3 px-4 py-3">
          <label className="flex items-center gap-2 text-reading-meta text-gray-700">
            <input
              type="checkbox"
              data-recording-enabled
              checked={draft.enabled}
              onChange={(e) => onField({ enabled: e.target.checked })}
              disabled={applying}
              className="h-4 w-4"
            />
            启用录制代理（保存的意图；监听是否成功以下方真实状态为准）
          </label>
          <label className="flex flex-col gap-1 text-reading-meta text-gray-700">
            监听端口
            <input
              type="text"
              data-recording-port
              value={draft.portText}
              onChange={(e) => onField({ portText: e.target.value })}
              disabled={applying}
              className={`w-40 rounded border px-2 py-1 font-code text-reading-meta ${
                request.ok ? "border-gray-300" : "border-red-400"
              }`}
            />
            {fieldErrors.port !== null ? (
              <span className="text-reading-meta text-red-700" data-recording-port-error>
                {fieldErrors.port}
              </span>
            ) : null}
          </label>
          <label className="flex flex-col gap-1 text-reading-meta text-gray-700">
            upstream base_url
            <input
              type="text"
              data-recording-upstream
              value={draft.upstreamText}
              onChange={(e) => onField({ upstreamText: e.target.value })}
              disabled={applying}
              className={`w-full rounded border px-2 py-1 font-code text-reading-meta ${
                request.ok ? "border-gray-300" : "border-red-400"
              }`}
            />
            {fieldErrors.upstream !== null ? (
              <span className="text-reading-meta text-red-700" data-recording-upstream-error>
                {fieldErrors.upstream}
              </span>
            ) : null}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-recording-apply
              onClick={onApply}
              disabled={!request.ok || applying}
              title={
                applying
                  ? "应用进行中（含状态回读），结束后才能再次应用"
                  : request.ok
                    ? "保存配置并按启用意图启停本地监听"
                    : "字段未通过校验：修正后才能应用（不会发出部分有效的配置写调用）"
              }
              className={
                request.ok && !applying
                  ? `cursor-pointer rounded bg-sky-600 px-3 py-1 text-reading-meta text-white hover:bg-sky-700 ${FOCUS_RING}`
                  : `cursor-not-allowed rounded bg-gray-200 px-3 py-1 text-reading-meta text-gray-400 ${FOCUS_RING}`
              }
            >
              {applying ? "应用中…" : "保存并应用"}
            </button>
            {dirty ? (
              <>
                <span className="text-reading-meta text-amber-700" data-recording-dirty>
                  有未应用的修改（偏离已核实的保存配置）
                </span>
                <button
                  type="button"
                  data-recording-discard
                  onClick={() => onDiscard(draft.revision)}
                  className={`rounded border border-gray-300 px-2 py-0.5 text-reading-meta text-gray-600 hover:bg-gray-50 ${FOCUS_RING}`}
                >
                  放弃修改
                </button>
              </>
            ) : null}
          </div>
          {applyError !== null ? (
            <p
              className="rounded bg-red-50 px-2 py-1 text-reading-meta text-red-800"
              data-recording-apply-error
            >
              应用失败：{applyError}
              。配置可能已保存但监听未启动（以下方真实状态为准）；重新应用须再次点击。
            </p>
          ) : null}
        </div>
      </section>

      {/* —— 状态区（意图 / 监听 / 凭据三层；未知显式呈现 + 只读重试）—— */}
      <section className="rounded border border-gray-200" aria-label="录制真实状态">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2">
          <span className="text-reading-meta font-medium text-gray-700">
            真实状态（与配置输入无关）
          </span>
          <button
            type="button"
            data-recording-refresh-status
            onClick={onRefreshStatus}
            title="只读重读状态；不重新应用、不启停服务"
            className={`rounded border border-gray-300 px-2 py-0.5 text-reading-meta text-gray-600 hover:bg-gray-50 ${FOCUS_RING}`}
          >
            重读状态
          </button>
        </div>
        <dl className="flex flex-col gap-1 px-4 py-3">
          {statusLines.map((line) => (
            <div key={line.label} className="flex flex-wrap items-baseline gap-2">
              <dt className="w-28 shrink-0 text-reading-meta text-gray-500">{line.label}</dt>
              <dd className="text-reading-meta text-gray-800">{line.value}</dd>
            </div>
          ))}
        </dl>
        {/*
          tasks 2.3b：失败/恢复中的**就近处置区**（delta「录制页展示受控原因、状态重读
          和显式『保存并应用』重试」「状态重读与显式应用重试区分」）。

          两个按钮的差别是这一节的重点，不是文案差别：
          - 「重读状态」= 只读核对，永远不会启动监听；
          - 「保存并应用」= 唯一会再次尝试监听的通道。
          把它们并排放、且各带 title 说明，用户才知道"再点一次重读"不会让代理
          自己起来。恢复中不给应用按钮（正在起，等它自己出结果）。
        */}
        {recovery !== null ? (
          <div
            className={`flex flex-wrap items-center gap-2 border-t px-4 py-2 ${
              recovery.phase === "failed"
                ? "border-red-100 bg-red-50"
                : "border-amber-100 bg-amber-50"
            }`}
            data-recording-recovery
            data-recovery-phase={recovery.phase}
          >
            <span
              className={`text-reading-meta ${
                recovery.phase === "failed" ? "text-red-800" : "text-amber-800"
              }`}
            >
              {recovery.phase === "failed"
                ? "启动恢复失败：已保存的启用意图仍然保留，处理后用「保存并应用」重试"
                : "正在恢复本地监听…完成后本区会显示本次结果"}
            </span>
            <button
              type="button"
              data-recording-recovery-refresh
              onClick={onRefreshStatus}
              title="只读重读状态：只核对当前事实，不启动监听、不调用模型"
              className={`rounded border border-gray-300 bg-white px-2 py-0.5 text-reading-meta text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
            >
              重读状态
            </button>
            {recovery.phase === "failed" ? (
              <button
                type="button"
                data-recording-recovery-apply
                onClick={onApply}
                disabled={!request.ok || applying}
                title={
                  request.ok
                    ? "显式重试：按当前保存的配置再次尝试监听（本次成功或失败都会如实呈现）"
                    : "配置字段未通过校验：请先在上方修正端口与 upstream"
                }
                className={
                  request.ok && !applying
                    ? `cursor-pointer rounded bg-sky-600 px-2 py-0.5 text-reading-meta text-white hover:bg-sky-700 ${FOCUS_RING}`
                    : `cursor-not-allowed rounded bg-gray-200 px-2 py-0.5 text-reading-meta text-gray-400 ${FOCUS_RING}`
                }
              >
                保存并应用
              </button>
            ) : null}
          </div>
        ) : null}
        <p className="border-t border-gray-100 px-4 py-2 text-reading-meta text-gray-500">
          停用只停止本地接入服务；不承诺取消外部 Agent 或在途请求。
        </p>
      </section>

      {/* —— 接入地址区（只来自已核实监听；停止/在飞/未知不可复制）—— */}
      <section className="rounded border border-gray-200" aria-label="本地接入地址">
        <div className="border-b border-gray-100 px-4 py-2 text-reading-meta font-medium text-gray-700">
          本地接入地址（把应用的 base_url 指到这里即可录制）
        </div>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          {address !== null ? (
            <>
              <code className="break-all rounded bg-gray-50 px-2 py-1 font-code text-reading-meta text-gray-800">
                {address}
              </code>
              <button
                type="button"
                data-recording-copy-address
                aria-label={`复制接入地址 ${address}`}
                onClick={copyAddress}
                className={`rounded border border-gray-300 px-2 py-0.5 text-reading-meta text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
              >
                复制地址
              </button>
              {copyFeedback !== null ? (
                <span className="text-reading-meta text-gray-500" aria-live="polite">
                  {copyFeedback === "copied" ? "已复制" : "当前环境不支持复制"}
                </span>
              ) : null}
              <span className="text-reading-meta text-gray-400">
                复制不发送任何请求（不做连通性测试）。
              </span>
            </>
          ) : (
            <span className="text-reading-meta text-gray-500" data-recording-address-unavailable>
              {applying
                ? "应用进行中：地址在本次应用结束并核实监听后才可复制"
                : "当前未监听或状态未知：接入地址不可复制（不提供草稿端口的假地址）"}
            </span>
          )}
        </div>
      </section>

      {/* —— 记录区（只读入口 + 显式刷新）—— */}
      <section className="rounded border border-gray-200" aria-label="代理记录">
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-4 py-2">
          <span className="text-reading-meta font-medium text-gray-700">代理记录</span>
          <span className="text-reading-meta text-gray-400">
            经代理录制的运行与本地创建共用一份列表；显式刷新为只读。
          </span>
        </div>
        <div className="flex flex-wrap gap-2 px-4 py-3">
          <button
            type="button"
            data-recording-open-records
            onClick={onOpenRecords}
            title="打开运行列表并按代理来源筛选（保留当前选择与搜索）"
            className={`rounded border border-gray-300 px-2 py-0.5 text-reading-meta text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
          >
            查看代理记录
          </button>
          <button
            type="button"
            data-recording-refresh-runs
            onClick={onRefreshRuns}
            title="只读刷新运行列表；不 toggle、不调用模型"
            className={`rounded border border-gray-300 px-2 py-0.5 text-reading-meta text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
          >
            刷新记录列表
          </button>
        </div>
      </section>
    </div>
  );
}
