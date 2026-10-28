/**
 * 紧凑全局栏（U1 任务 4.2 · design D1/D2）。
 *
 * 三个**真实可用**的入口（delta：「全局栏 SHALL 提供真实可用的新建运行、录制接入和设置入口」）：
 *   - 新建运行 → 与列表标题区**同一个**创建工作区（判据在 store 的 `openCreateWorkspace`，
 *     U5 任务 4.1 起它是主工作区的一个页面，不再是覆盖模态）
 *   - 录制接入 → 打开**独立录制工作区**（U8 1.4 起；不是另开一套录制 UI）
 *   - 设置     → 常规打开设置
 *
 * 另有运行记录／分支关系视图切换与状态指示；草稿／操作入口已统一到
 * 底部会话活动条（SessionActivity，UI 整理 3.3）。全部按钮带可访问名称与可见焦点
 * （4.1 的 `FOCUS_RING` 与 `IconButton` 契约）。
 *
 * ⚠️ 图标 + 文字而非纯图标：这是首屏级入口，「图标悬停可辨用途」对它们不够，
 *    名称必须直接可见（纯图标形态留给 4.5 的密集工具条）。
 */

import {
  Activity,
  GitBranch,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Radio,
  Settings,
  Waypoints,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslator } from "../i18n";
import { proxyPhaseDotClass, proxyRecoveryView } from "../lib/proxy-recovery-view";
import { useAppStore } from "../store";
import { FOCUS_RING } from "./IconButton";

/** 视图切换按钮（运行记录 / 分支关系）：两者互斥，用 aria-pressed 表达当前态。
 * 面向用户的名称按 UI 整理 delta（MODIFIED「界面提供分支树与轨迹两种视图」）：
 * 应用级两视图标为「运行记录」「分支关系」，不再把应用级视图统称「轨迹」。 */
function ViewToggle() {
  const translator = useTranslator();
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);

  const options = [
    {
      key: "trace" as const,
      label: translator.t("common.viewRuns"),
      icon: Activity,
      hint: translator.t("common.viewRunsHint"),
    },
    {
      key: "tree" as const,
      label: translator.t("common.viewTree"),
      icon: GitBranch,
      hint: translator.t("common.viewTreeHint"),
    },
  ];

  return (
    // fieldset + legend：一组互斥的视图切换按钮，语义分组由原生元素表达
    // （比在 div 上手写 role="group" 更贴合规则集）
    <fieldset className="m-0 flex items-center gap-0.5 border-0 p-0">
      <legend className="sr-only">{translator.t("common.viewSwitchLegend")}</legend>
      {options.map(({ key, label, icon: Icon, hint }) => {
        const active = view === key;
        return (
          <button
            key={key}
            type="button"
            data-view-option={key}
            aria-pressed={active ? "true" : undefined}
            title={hint}
            onClick={() => setView(key)}
            className={`inline-flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-reading-meta ${
              active ? "bg-sky-100 font-medium text-sky-900" : "text-gray-600 hover:bg-gray-100"
            } ${FOCUS_RING}`}
          >
            <Icon size={13} aria-hidden="true" focusable="false" role="presentation" />
            <span>{label}</span>
          </button>
        );
      })}
    </fieldset>
  );
}

/**
 * 代理/配置状态指示（点开即设置；带文字，不只靠小圆点）。
 *
 * tasks 2.3b（delta「代理启动恢复结果就近可见」）：代理这一项按**恢复阶段**呈现，
 * 不再只有"运行/已停"两态。恢复中与恢复失败各自显式说明，并给出去录制工作区的
 * 入口——这两态用户都需要"为什么/ 怎么办"，顶栏是唯一always在的地方。
 * 文案与圆点颜色全部来自 `proxyRecoveryView`（顶栏与录制页共用一份判据），
 * 这里不做任何自己的措辞判断。
 */
function StatusIndicators({
  onOpenSettings,
  onOpenRecording,
}: {
  onOpenSettings: () => void;
  onOpenRecording: () => void;
}): ReactNode {
  const translator = useTranslator();
  const proxy = useAppStore((s) => s.proxy);
  const statusReadFailed = useAppStore((s) => s.recordingStatusReadFailed);
  const settingsConfigured = useAppStore((s) => s.settings?.configured);
  const view = proxyRecoveryView(proxy, statusReadFailed);

  return (
    <div className="flex items-center gap-2 text-reading-meta">
      {proxy !== null || statusReadFailed ? (
        <button
          type="button"
          data-shell-proxy
          onClick={onOpenSettings}
          className={`inline-flex cursor-pointer items-center gap-1.5 rounded border px-2 py-0.5 hover:bg-gray-50 ${FOCUS_RING} ${
            view.phase === "failed"
              ? "border-red-300 text-red-800"
              : view.phase === "recovering"
                ? "border-amber-300 text-amber-800"
                : "border-gray-300 text-gray-600"
          }`}
          title={translator.t("common.proxyStatusHint")}
        >
          <Radio size={12} aria-hidden="true" focusable="false" role="presentation" />
          <span
            aria-hidden="true"
            data-proxy-phase-dot
            data-proxy-phase={view.phase}
            className={`inline-block h-1.5 w-1.5 rounded-full ${proxyPhaseDotClass(view.phase)}`}
          />
          <span data-proxy-phase-label>{view.headline}</span>
          {/* delta：「本会话尚未捕获凭据时如实显示未捕获」——只在真的在监听时说 */}
          {view.phase === "listening" && proxy?.hasKey !== true ? (
            <span className="text-amber-600">{translator.t("common.proxyNoKey")}</span>
          ) : null}
        </button>
      ) : null}
      {/*恢复中 / 失败：顶栏给就近入口去看受控原因与重试（delta「顶栏保留简短异常与录制页入口」） */}
      {view.needsRecordingEntry ? (
        <button
          type="button"
          data-proxy-open-recording
          onClick={onOpenRecording}
          title={translator.t(
            view.phase === "failed"
              ? "common.proxyOpenRecordingFailedHint"
              : "common.proxyOpenRecordingRecoveringHint",
          )}
          className={`inline-flex cursor-pointer items-center gap-1 rounded border px-2 py-0.5 hover:bg-gray-50 ${FOCUS_RING} ${
            view.phase === "failed"
              ? "border-red-300 text-red-800"
              : "border-amber-300 text-amber-800"
          }`}
        >
          {translator.t(
            view.phase === "failed" ? "common.proxyFixInRecording" : "common.proxyRecovering",
          )}
        </button>
      ) : null}
      <button
        type="button"
        onClick={onOpenSettings}
        // U3 5.1：模态关闭时的焦点回退锚点——触发元素已卸载时聚焦这个常驻入口
        data-modal-focus-fallback
        data-shell-settings
        className={`inline-flex cursor-pointer items-center gap-1.5 rounded border border-gray-300 px-2 py-0.5 text-gray-600 hover:bg-gray-50 ${FOCUS_RING}`}
        title={translator.t("common.runConfigHint")}
      >
        <Settings size={12} aria-hidden="true" focusable="false" role="presentation" />
        <span
          aria-hidden="true"
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            settingsConfigured === true ? "bg-emerald-500" : "bg-gray-300"
          }`}
        />
        {translator.t("common.runConfig")}
      </button>
    </div>
  );
}

export function GlobalBar({
  onOpenSettings,
  onOpenRecording,
  navigation,
}: {
  onOpenSettings: () => void;
  /** 录制入口（U8 1.4 起）：打开**独立录制工作区**（不再是"开设置定位代理分区"） */
  onOpenRecording: () => void;
  navigation?: { visible: boolean; onToggle: () => void };
}) {
  const translator = useTranslator();
  const openCreateWorkspace = useAppStore((s) => s.openCreateWorkspace);

  /** 录制接入 = 打开独立录制工作区（U8 1.4；配置/状态随 §2 落地） */
  const openRecording = (): void => {
    onOpenRecording();
  };

  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-gray-200 bg-white px-3 py-1.5">
      {navigation !== undefined ? (
        <button
          id="run-navigation-toggle"
          type="button"
          aria-label={translator.t(
            navigation.visible ? "common.collapseRunList" : "common.openRunList",
          )}
          title={translator.t(navigation.visible ? "common.collapseRunList" : "common.openRunList")}
          aria-expanded={navigation.visible}
          aria-controls="run-navigation"
          onClick={navigation.onToggle}
          className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-gray-600 hover:bg-gray-100 ${FOCUS_RING}`}
        >
          {navigation.visible ? (
            <PanelLeftClose size={16} aria-hidden="true" />
          ) : (
            <PanelLeftOpen size={16} aria-hidden="true" />
          )}
        </button>
      ) : null}
      <span className="text-reading-body font-semibold text-gray-900">ReBaseAgent</span>
      <ViewToggle />

      <div className="ml-auto flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        {/* UI 整理 2.2（delta「当前任务身份与返回目的地明确」）：全局栏不再展示
            侧栏最近选中 run 的 ID——它不随工作区变化，在比较/编辑/新建/录制页
            会被读成"当前对象"。对象身份由各工作区自己的对象头呈现（RunHeaderView /
            CompareWorkspaceView / AuxWorkspaceFrame），完整 ID 在那里可复制。 */}
        {/* UI 整理 3.3：草稿与操作入口迁往底部「会话活动」统一入口（App 外壳）——
            全局栏只保留身份无关的常驻动作（新建/录制/设置与状态指示）。 */}
        <button
          type="button"
          data-shell-new-run
          onClick={openCreateWorkspace}
          title={translator.t("common.newRunHint")}
          className={`inline-flex cursor-pointer items-center gap-1.5 rounded border border-gray-300 px-2 py-0.5 text-reading-meta text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
        >
          <Plus size={12} aria-hidden="true" focusable="false" role="presentation" />
          {translator.t("common.newRun")}
        </button>
        <button
          type="button"
          data-shell-recording
          onClick={openRecording}
          title={translator.t("common.connectRecordingHint")}
          className={`inline-flex cursor-pointer items-center gap-1.5 rounded border border-gray-300 px-2 py-0.5 text-reading-meta text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
        >
          <Waypoints size={12} aria-hidden="true" focusable="false" role="presentation" />
          {translator.t("common.connectRecording")}
        </button>
        <StatusIndicators onOpenSettings={onOpenSettings} onOpenRecording={openRecording} />
      </div>
    </header>
  );
}
