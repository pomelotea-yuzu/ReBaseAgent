import { useEffect, useState } from "react";
import { useAppStore } from "../store";

/**
 * 运行配置对话框：baseURL / apiKey / model。
 *
 * 纪律：
 * - apiKey 只进不出——保存时写入 main（单向通道），回读状态永不含密钥
 * - 加密方式明示：safeStorage 可用（safe）与明文降级（plain）分别提示
 * - 清除配置需用户确认（删除数据目录 settings.json，不可恢复）
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useAppStore((s) => s.settings);
  const configured = settings?.configured ?? false;
  const proxy = useAppStore((s) => s.proxy);
  const toggleProxy = useAppStore((s) => s.toggleProxy);

  // 打开时以已保存值预填（apiKey 留空 = 保持原值）
  const [baseURL, setBaseURL] = useState(settings?.baseURL ?? "");
  const [model, setModel] = useState(settings?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // 代理区（启停即保存；状态从 main 回读）
  const [proxyEnabled, setProxyEnabled] = useState(proxy?.enabled ?? false);
  const [proxyPort, setProxyPort] = useState(String(proxy?.port ?? 18787));
  const [proxyUpstream, setProxyUpstream] = useState(
    proxy?.upstreamBaseUrl ?? "https://api.deepseek.com",
  );
  const [proxyBusy, setProxyBusy] = useState(false);
  const [proxyMessage, setProxyMessage] = useState<string | null>(null);

  const saveSettings = useAppStore((s) => s.saveSettings);
  const clearSettings = useAppStore((s) => s.clearSettings);

  const trimmed = {
    baseURL: baseURL.trim(),
    model: model.trim(),
  };
  /** 保存前置条件：baseURL 与 model 必填（apiKey 可为空 = 保持已保存密钥） */
  const missing = [
    trimmed.baseURL.length === 0 ? "baseURL" : "",
    trimmed.model.length === 0 ? "model" : "",
  ].filter(Boolean);
  const canSave = missing.length === 0 && !busy;

  const doSave = async (): Promise<void> => {
    if (!canSave) return;
    setBusy(true);
    setMessage(null);
    const okSaved = await saveSettings({ baseURL: trimmed.baseURL, apiKey, model: trimmed.model });
    if (okSaved) {
      setApiKey("");
      setMessage("已保存。此后“在此重跑”将使用该配置发起真实调用。");
    } else {
      setMessage(useAppStore.getState().error ?? "保存失败");
    }
    setBusy(false);
  };

  const doClear = async (): Promise<void> => {
    if (!window.confirm("清除运行配置？已保存的 apiKey 将一并删除，不可恢复。")) return;
    setBusy(true);
    setMessage(null);
    const okCleared = await clearSettings();
    if (okCleared) {
      setBaseURL("");
      setModel("");
      setApiKey("");
      setMessage("运行配置已清除。");
    } else {
      setMessage(useAppStore.getState().error ?? "清除失败");
    }
    setBusy(false);
  };

  /** 代理保存并应用：启停即保存，端口占用等错误可见 */
  const doProxyApply = async (): Promise<void> => {
    const port = Number.parseInt(proxyPort, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setProxyMessage("端口必须是 1–65535 的整数");
      return;
    }
    setProxyBusy(true);
    setProxyMessage(null);
    const nextState = await toggleProxy({
      enabled: proxyEnabled,
      port,
      upstreamBaseUrl: proxyUpstream.trim(),
    });
    if (nextState === null) {
      setProxyMessage(useAppStore.getState().error ?? "代理操作失败");
    } else {
      setProxyMessage(
        nextState.running
          ? `代理已运行：http://127.0.0.1:${nextState.port}/v1——把你的应用 base_url 改成这个地址即可录制。`
          : "代理已停止。",
      );
    }
    setProxyBusy(false);
  };

  const plain = settings?.encryption === "plain";

  // Esc 关闭对话框；回车不在本层处理（提交走显式按钮）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4">
      <dialog
        open
        aria-label="运行配置"
        onCancel={(e) => e.preventDefault()}
        className="relative m-0 w-105 max-w-full rounded-lg border border-gray-200 bg-white p-4 shadow-xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-gray-800">运行配置（LLM 接入）</div>
            <div className="text-[11px] text-gray-500">
              {configured ? "已配置 · 重跑将使用该接入点" : "尚未配置 · 重跑前必须完成"}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-1.5 text-sm text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        <div className="space-y-2.5">
          <label className="block">
            <span className="mb-0.5 block text-[11px] font-medium text-gray-600">baseURL</span>
            <input
              type="url"
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              placeholder="https://api.deepseek.com/v1"
              spellCheck={false}
              className="w-full rounded border border-gray-300 px-2 py-1 font-code text-xs outline-none focus:border-blue-400"
            />
          </label>

          <label className="block">
            <span className="mb-0.5 block text-[11px] font-medium text-gray-600">apiKey</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={configured ? "留空表示保持已保存的密钥" : "必填"}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded border border-gray-300 px-2 py-1 font-code text-xs outline-none focus:border-blue-400"
            />
          </label>

          <label className="block">
            <span className="mb-0.5 block text-[11px] font-medium text-gray-600">model</span>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="deepseek-chat"
              spellCheck={false}
              className="w-full rounded border border-gray-300 px-2 py-1 font-code text-xs outline-none focus:border-blue-400"
            />
          </label>
        </div>

        {plain ? (
          <div className="mt-3 rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1.5 text-[11px] leading-4 text-amber-800">
            系统加密不可用：apiKey 将以明文保存在数据目录 settings.json 中。请仅在可信环境下使用。
          </div>
        ) : (
          <div className="mt-3 rounded border-l-2 border-emerald-400 bg-emerald-50 px-2 py-1.5 text-[11px] text-emerald-800">
            apiKey 将经系统加密（safeStorage）后写入数据目录 settings.json。
          </div>
        )}

        {message !== null ? <div className="mt-2 text-[11px] text-gray-600">{message}</div> : null}

        {missing.length > 0 ? (
          <div className="mt-2 text-[11px] text-amber-700">
            请先填写：{missing.join("、")}（apiKey 可在已配置后留空以保持不变）
          </div>
        ) : null}

        <div className="mt-4 flex items-center justify-between">
          <button
            type="button"
            onClick={() => {
              void doClear();
            }}
            disabled={!configured || busy}
            className="rounded px-2 py-1 text-[11px] text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            清除配置
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50"
            >
              关闭
            </button>
            <button
              type="button"
              onClick={() => {
                void doSave();
              }}
              disabled={!canSave}
              className="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "保存中…" : "保存"}
            </button>
          </div>
        </div>

        {/* ---------------------------------------------------------------
            本地录制代理：零摩擦接入（key 留在你的应用里，ReBaseAgent 不保管）
            --------------------------------------------------------------- */}
        <div className="mt-4 border-t border-gray-200 pt-3">
          <div className="mb-1 flex items-center justify-between">
            <div className="text-sm font-semibold text-gray-800">本地录制代理（零摩擦接入）</div>
            <span
              className={`inline-flex items-center gap-1 text-[11px] ${
                proxy?.running === true ? "text-emerald-700" : "text-gray-400"
              }`}
            >
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${
                  proxy?.running === true ? "bg-emerald-500" : "bg-gray-300"
                }`}
              />
              {proxy?.running === true ? `运行中 :${proxy.port}` : "已停止"}
            </span>
          </div>
          <div className="mb-2 text-[11px] leading-4 text-gray-500">
            把你的 Agent 应用 base_url 改为{" "}
            <span className="font-code">http://127.0.0.1:&lt;端口&gt;/v1</span>， key
            一字不动即可录制每次 LLM 调用。录制/查看不需要任何配置；key
            仅在本会话内存中暂存用于「编辑重发」。
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-[11px] text-gray-700">
              <input
                type="checkbox"
                checked={proxyEnabled}
                onChange={(e) => setProxyEnabled(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              启用代理
            </label>
            <div className="flex gap-2">
              <label className="block w-24">
                <span className="mb-0.5 block text-[11px] font-medium text-gray-600">端口</span>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={proxyPort}
                  onChange={(e) => setProxyPort(e.target.value)}
                  spellCheck={false}
                  className="w-full rounded border border-gray-300 px-2 py-1 font-code text-xs outline-none focus:border-blue-400"
                />
              </label>
              <label className="block flex-1">
                <span className="mb-0.5 block text-[11px] font-medium text-gray-600">
                  upstream（转发目标，不进 trace）
                </span>
                <input
                  type="url"
                  value={proxyUpstream}
                  onChange={(e) => setProxyUpstream(e.target.value)}
                  placeholder="https://api.deepseek.com"
                  spellCheck={false}
                  className="w-full rounded border border-gray-300 px-2 py-1 font-code text-xs outline-none focus:border-blue-400"
                />
              </label>
            </div>
          </div>

          {proxyMessage !== null ? (
            <div className="mt-2 text-[11px] leading-4 text-gray-600">{proxyMessage}</div>
          ) : null}

          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={() => {
                void doProxyApply();
              }}
              disabled={proxyBusy}
              className="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {proxyBusy ? "应用中…" : "保存并应用"}
            </button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
