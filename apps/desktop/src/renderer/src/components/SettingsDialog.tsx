import { useEffect, useRef, useState } from "react";
import { useTranslator } from "../i18n";
import { deriveConfigGate } from "../lib/entry-gate";
import { settingsDraftDirty } from "../lib/settings-form";
import { useAppStore } from "../store";
import { requestConfirm } from "./ConfirmDialog";
import { LanguageSettings } from "./LanguageSettings";
import { ModalDialog } from "./ModalDialog";

/**
 * 运行配置对话框：baseURL / apiKey / model + 本地录制代理 + 界面语言。
 *
 * 纪律：
 * - apiKey 只进不出——保存时写入 main（单向通道），回读状态永不含密钥
 * - 加密方式明示：safeStorage 可用（safe）与明文降级（plain）分别提示
 * - 清除配置需用户确认（删除数据目录 settings.json，不可恢复）
 * - 语言偏好独立保存：切语言不提交未保存的模型输入，也不触发代理应用
 *
 * 任务 4.2：全局栏的「录制接入」要求**定位现有代理设置**（不是另建一套录制界面）。
 * 做法是读 store 的 `settingsSection`：为 `"proxy"` 时把代理分区滚进视口并聚焦
 * 第一个控件。`sectionRef` 只在"被要求定位"时滚动一次，常规打开不受影响。
 */

/** 对话框反馈：成功说明是单行文案；失败给本地化摘要 + 原始说明（main 返回） */
type SettingsNotice =
  | { readonly tone: "info"; readonly text: string }
  | { readonly tone: "error"; readonly summary: string; readonly detail: string | null };

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const translator = useTranslator();
  const settings = useAppStore((s) => s.settings);
  const configured = settings?.configured ?? false;
  const proxy = useAppStore((s) => s.proxy);
  const settingsSection = useAppStore((s) => s.settingsSection);
  const setSettingsSection = useAppStore((s) => s.setSettingsSection);
  const openRecordingWorkspace = useAppStore((s) => s.openRecordingWorkspace);
  const uiPreferences = useAppStore((s) => s.uiPreferences);
  const languageSaving = useAppStore((s) => s.uiPreferencesSaving);
  const languageSaveFailed = useAppStore((s) => s.uiPreferencesSaveFailed);
  const saveUiLanguage = useAppStore((s) => s.saveUiLanguage);
  const proxySectionRef = useRef<HTMLDivElement | null>(null);
  const recordingJumpRef = useRef<HTMLButtonElement | null>(null);

  // 打开时以已保存值预填（apiKey 留空 = 保持原值）
  const [baseURL, setBaseURL] = useState(settings?.baseURL ?? "");
  const [model, setModel] = useState(settings?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<SettingsNotice | null>(null);
  // U5 任务 5.4："已保存但回读失败"的专属态——驱动只读重试按钮
  const [rereadFailed, setRereadFailed] = useState(false);

  const saveSettings = useAppStore((s) => s.saveSettings);
  const loadSettings = useAppStore((s) => s.loadSettings);
  const clearSettings = useAppStore((s) => s.clearSettings);
  // U4 任务 4.8：写动作（保存/清除）绑统一门禁。
  // ⚠️ 只绑写通道：`settings:get` 的读取与"关闭"按钮不受门禁影响
  // （spec「直接 IPC 不能绕过配置锁」的 THEN 句要求读取照常可用），main 判锁仍是最后防线。
  // U8 2.10：代理应用已迁独立录制工作区，设置里不再有第三个写动作。
  const configGate = deriveConfigGate(
    useAppStore((s) => s.operations),
    translator,
  );

  const trimmed = {
    baseURL: baseURL.trim(),
    model: model.trim(),
  };
  /** 保存前置条件：baseURL 与 model 必填（apiKey 可为空 = 保持已保存密钥） */
  const missing = [
    trimmed.baseURL.length === 0 ? "baseURL" : "",
    trimmed.model.length === 0 ? "model" : "",
  ].filter(Boolean);
  const canSave = missing.length === 0 && !busy && configGate.canChange;

  /**
   * U5 任务 5.4（「未保存设置关闭可继续或放弃」）：有未保存修改时，关闭/Esc 先过
   * 真模态确认。"放弃"只丢弃**会话输入**（打过的密钥从未离开渲染层的暂存，单向通道
   * 只在保存成功时写入）；已保存配置、运行阅读与调试草稿一概不动；"继续编辑"逐字保留。
   * U8 2.10：代理字段已迁录制工作区（它有自己的草稿与关闭协商），这里只剩模型三件。
   */
  const dirty = settingsDraftDirty({
    draft: { baseURL, model, apiKey },
    saved: settings,
  });
  const requestClose = (): void => {
    if (!dirty) {
      onClose();
      return;
    }
    void requestConfirm({
      title: translator.t("settings.closeDirtyTitle"),
      message: translator.t("settings.closeDirtyMessage"),
      confirmLabel: translator.t("settings.discardClose"),
      cancelLabel: translator.t("settings.continueEditing"),
    }).then((discard) => {
      if (discard) onClose();
    });
  };

  const doSave = async (): Promise<void> => {
    // U5 任务 5.4：保存中不重复提交（canSave 里的 busy 是渲染期判据，这里再挡一次
    // 同帧双触发——双向保险，不新造状态机）
    if (busy || !canSave) return;
    setBusy(true);
    setNotice(null);
    setRereadFailed(false);
    const outcome = await saveSettings({ baseURL: trimmed.baseURL, apiKey, model: trimmed.model });
    if (outcome === "saved") {
      setApiKey("");
      // 「不冒充连通」：只陈述"已保存并回读到配置状态"，不发连接测试、不说连接成功
      setNotice({ tone: "info", text: translator.t("settings.savedVerified") });
    } else if (outcome === "reread-failed") {
      // 保存已确认，但回读失败 ⇒ 不把旧摘要当新配置事实（store 已清 settings），给只读重试
      setRereadFailed(true);
      setNotice({ tone: "info", text: translator.t("settings.savedRereadFailed") });
    } else {
      // 保存失败：输入（含已打的密钥）**逐字保留**
      setNotice({
        tone: "error",
        summary: translator.t("settings.saveFailedSummary"),
        detail: useAppStore.getState().error,
      });
    }
    setBusy(false);
  };

  /** 只读重试回读：走 `settings:get`，不碰写通道、不受配置写门禁影响 */
  const doReread = async (): Promise<void> => {
    setRereadFailed(false);
    const okReread = await loadSettings();
    if (okReread) {
      setNotice({ tone: "info", text: translator.t("settings.rereadOk") });
    } else {
      setNotice({
        tone: "error",
        summary: translator.t("settings.rereadStillFailedSummary"),
        detail: useAppStore.getState().error,
      });
      setRereadFailed(true);
    }
  };

  /**
   * U5 任务 5.5：清除确认迁到真模态（渲染层最后一处 `window.confirm` 在此归零）。
   * 确认文案**点名保存凭据**一并删除；取消 = 零清除调用、输入逐字保留。
   * "受槽约束"由按钮的 `configGate.canChange` 承担（U4 4.8），这里不重复判锁。
   */
  const doClear = async (): Promise<void> => {
    if (busy) return;
    const confirmed = await requestConfirm({
      title: translator.t("settings.clearTitle"),
      message: translator.t("settings.clearMessage"),
      confirmLabel: translator.t("settings.clearConfirm"),
    });
    if (!confirmed) return;
    setBusy(true);
    setNotice(null);
    setRereadFailed(false);
    const okCleared = await clearSettings();
    if (okCleared) {
      setBaseURL("");
      setModel("");
      setApiKey("");
      setNotice({ tone: "info", text: translator.t("settings.cleared") });
    } else {
      setNotice({
        tone: "error",
        summary: translator.t("settings.clearFailedSummary"),
        detail: useAppStore.getState().error,
      });
    }
    setBusy(false);
  };

  const plain = settings?.encryption === "plain";

  /**
   * U8 任务 2.10：设置内跳转录制工作区。设置内有未保存模型字段/密钥时**先处理**：
   * 继续编辑 = 取消跳转（零代理应用调用）；确认放弃 = 清未保存密钥输入并进入录制，
   * 原调试草稿保留（scenario「设置跳转录制先处理未保存模型字段」）。
   */
  const openRecordingFromSettings = (): void => {
    if (dirty) {
      void requestConfirm({
        title: translator.t("settings.jumpDirtyTitle"),
        message: translator.t("settings.jumpDirtyMessage"),
        confirmLabel: translator.t("settings.discardAndJump"),
        cancelLabel: translator.t("settings.continueEditing"),
      }).then((discard) => {
        if (!discard) return;
        setApiKey("");
        setSettingsSection(null);
        onClose();
        openRecordingWorkspace();
      });
      return;
    }
    setSettingsSection(null);
    onClose();
    openRecordingWorkspace();
  };

  // 「录制接入」定位：滚到录制跳转分区并把焦点放到跳转按钮。只在显式要求时执行一次，
  // 执行后清掉标记。jsdom/静态渲染无布局能力，只有真实 DOM 才逐项调用，故先判方法存在。
  useEffect(() => {
    if (settingsSection !== "proxy") return;
    proxySectionRef.current?.scrollIntoView?.({ block: "start" });
    recordingJumpRef.current?.focus?.();
    setSettingsSection(null);
  }, [settingsSection, setSettingsSection]);

  return (
    // U3 任务 5.1：showModal 真 top layer——Esc 经原生 cancel 关闭（最上层语义），
    // Tab 禁闭与背景 inert 由浏览器保证；原手写 window keydown 监听已移除
    // U5 任务 5.6：设置界面受可用视口高度钳制（长表单/200% 缩放在框内滚动，
    // 不撑破屏幕；宽度上限 `max-w-full` 由 ModalDialog 基层给）
    <ModalDialog
      open
      onClose={requestClose}
      ariaLabel={translator.t("settings.dialogAria")}
      className="max-h-[85vh] w-105 overflow-y-auto p-4"
    >
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-gray-800">
            {translator.t("settings.heading")}
          </div>
          <div className="text-[11px] text-gray-500">
            {configured
              ? translator.t("settings.statusConfigured")
              : translator.t("settings.statusUnconfigured")}
          </div>
        </div>
        <button
          type="button"
          onClick={requestClose}
          className="rounded px-1.5 text-sm text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          aria-label={translator.t("settings.closeAria")}
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
            placeholder={translator.t(
              configured ? "settings.apiKeyKeepPlaceholder" : "settings.apiKeyRequiredPlaceholder",
            )}
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
          {translator.t("settings.encryptionPlain")}
        </div>
      ) : (
        <div className="mt-3 rounded border-l-2 border-emerald-400 bg-emerald-50 px-2 py-1.5 text-[11px] text-emerald-800">
          {translator.t("settings.encryptionSafe")}
        </div>
      )}

      {notice !== null ? (
        <div
          data-settings-notice={notice.tone}
          className={`mt-2 text-[11px] ${
            notice.tone === "error" ? "text-red-700" : "text-gray-600"
          }`}
        >
          {notice.tone === "info" ? (
            notice.text
          ) : (
            <>
              <div>{notice.summary}</div>
              {notice.detail !== null ? (
                <div className="mt-0.5 whitespace-pre-wrap break-words">
                  {translator.t("detail.rawFailureDetail")}
                  {notice.detail}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {/* U5 任务 5.4：保存已确认但回读失败 ⇒ 明确"待读取"，只读重试（不重新保存、不受写门禁） */}
      {rereadFailed ? (
        <button
          type="button"
          data-reread-settings
          onClick={() => {
            void doReread();
          }}
          title={translator.t("settings.rereadTitle")}
          className="mt-1 rounded border border-gray-300 px-2 py-0.5 text-[11px] text-gray-700 hover:bg-gray-50"
        >
          {translator.t("settings.rereadButton")}
        </button>
      ) : null}

      {configGate.notice !== null ? (
        <div data-testid="config-gate-notice" className="mt-2 text-[11px] leading-4 text-amber-700">
          {configGate.notice}
        </div>
      ) : null}

      {missing.length > 0 ? (
        <div className="mt-2 text-[11px] text-amber-700">
          {translator.t("settings.missingFields", {
            fields: missing.join(translator.t("settings.fieldsSeparator")),
          })}
        </div>
      ) : null}

      <div className="mt-4 flex items-center justify-between">
        <button
          type="button"
          onClick={() => {
            void doClear();
          }}
          disabled={!configured || busy || !configGate.canChange}
          className="rounded px-2 py-1 text-[11px] text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {translator.t("settings.clearButton")}
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={requestClose}
            className="rounded border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50"
          >
            {translator.t("settings.closeButton")}
          </button>
          <button
            type="button"
            onClick={() => {
              void doSave();
            }}
            disabled={!canSave}
            className="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? translator.t("settings.saving") : translator.t("settings.save")}
          </button>
        </div>
      </div>

      {/* ---------------------------------------------------------------
            本地录制代理（U8 2.10）：设置**不再保留**第二份代理配置表单——
            配置/启停/地址都在独立录制工作区。本分区只剩真实监听摘要与跳转。
            --------------------------------------------------------------- */}
      <div ref={proxySectionRef} className="mt-4 border-t border-gray-200 pt-3">
        <div className="mb-1 flex items-center justify-between">
          <div className="text-sm font-semibold text-gray-800">
            {translator.t("settings.proxyHeading")}
          </div>
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
            {proxy?.running === true
              ? translator.t("settings.proxyRunning", { port: proxy.port })
              : translator.t("settings.proxyStopped")}
          </span>
        </div>
        <div className="mb-2 text-[11px] leading-4 text-gray-500">
          {translator.t("settings.proxyNote")}
        </div>
        <button
          ref={recordingJumpRef}
          type="button"
          data-settings-recording-jump
          onClick={openRecordingFromSettings}
          className="rounded border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:bg-gray-50"
        >
          {translator.t("settings.openRecording")}
        </button>
      </div>

      <LanguageSettings
        preference={uiPreferences?.preference ?? "system"}
        saving={languageSaving}
        saveFailed={languageSaveFailed}
        issue={uiPreferences?.issue ?? null}
        onChange={(preference) => {
          void saveUiLanguage(preference);
        }}
      />
    </ModalDialog>
  );
}
