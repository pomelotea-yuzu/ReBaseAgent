/**
 * 紧凑全局栏（U1 任务 4.2 · design D1/D2）。
 *
 * 三个**真实可用**的入口（delta：「全局栏 SHALL 提供真实可用的新建运行、录制接入和设置入口」）：
 *   - 新建运行 → 与列表标题区**同一个** `CreateRunDialog`（状态在 store，见 `createDialogOpen`）
 *   - 录制接入 → 打开设置并**定位到代理分区**（不是另开一套录制 UI）
 *   - 设置     → 常规打开设置
 *
 * 另有轨迹/分支树视图切换与状态指示。全部按钮带可访问名称与可见焦点
 * （4.1 的 `FOCUS_RING` 与 `IconButton` 契约）。
 *
 * ⚠️ 图标 + 文字而非纯图标：这是首屏级入口，「图标悬停可辨用途」对它们不够，
 *    名称必须直接可见（纯图标形态留给 4.5 的密集工具条）。
 */

import { Activity, GitBranch, Plus, Radio, ScrollText, Settings, Waypoints } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { deriveDraftList } from "../lib/draft-list";
import { useAppStore } from "../store";
import { requestConfirm } from "./ConfirmDialog";
import { DraftListPanel } from "./DraftListPanel";
import { FOCUS_RING } from "./IconButton";

/** 视图切换按钮（轨迹 / 分支树）：两者互斥，用 aria-pressed 表达当前态 */
function ViewToggle() {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);

  const options = [
    {
      key: "trace" as const,
      label: "轨迹",
      icon: Activity,
      hint: "三栏视图：运行列表 / 轨迹树 / 详情",
    },
    {
      key: "tree" as const,
      label: "分支树",
      icon: GitBranch,
      hint: "全宽分支树：节点为运行、连线为分叉，可勾选多条对照",
    },
  ];

  return (
    // fieldset + legend：一组互斥的视图切换按钮，语义分组由原生元素表达
    // （比在 div 上手写 role="group" 更贴合规则集）
    <fieldset className="m-0 flex items-center gap-0.5 border-0 p-0">
      <legend className="sr-only">主视图切换</legend>
      {options.map(({ key, label, icon: Icon, hint }) => {
        const active = view === key;
        return (
          <button
            key={key}
            type="button"
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

/** 代理/配置状态指示（点开即设置；带文字，不只靠小圆点） */
function StatusIndicators({ onOpenSettings }: { onOpenSettings: () => void }): ReactNode {
  const proxy = useAppStore((s) => s.proxy);
  const settingsConfigured = useAppStore((s) => s.settings?.configured);

  return (
    <div className="flex items-center gap-2 text-reading-meta">
      {proxy !== null ? (
        <button
          type="button"
          onClick={onOpenSettings}
          className={`inline-flex cursor-pointer items-center gap-1.5 rounded border border-gray-300 px-2 py-0.5 text-gray-600 hover:bg-gray-50 ${FOCUS_RING}`}
          title="本地录制代理：把你的 Agent 应用 base_url 指到 http://127.0.0.1:<端口>/v1，key 一字不动即可录制"
        >
          <Radio size={12} aria-hidden="true" focusable="false" role="presentation" />
          <span
            aria-hidden="true"
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              proxy.running ? "bg-emerald-500" : "bg-gray-300"
            }`}
          />
          代理{proxy.running ? ` :${proxy.port}` : " 已停"}
          {proxy.running && !proxy.hasKey ? (
            <span className="text-amber-600">未捕获 key</span>
          ) : null}
        </button>
      ) : null}
      <button
        type="button"
        onClick={onOpenSettings}
        // U3 5.1：模态关闭时的焦点回退锚点——触发元素已卸载时聚焦这个常驻入口
        data-modal-focus-fallback
        className={`inline-flex cursor-pointer items-center gap-1.5 rounded border border-gray-300 px-2 py-0.5 text-gray-600 hover:bg-gray-50 ${FOCUS_RING}`}
        title="配置 LLM 接入（baseURL / apiKey / model），供“在此重跑”发起真实调用"
      >
        <Settings size={12} aria-hidden="true" focusable="false" role="presentation" />
        <span
          aria-hidden="true"
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            settingsConfigured === true ? "bg-emerald-500" : "bg-gray-300"
          }`}
        />
        运行配置
      </button>
    </div>
  );
}

/**
 * U3 任务 2.5：会话草稿入口（全局）。
 *
 * 与步骤页的「本运行草稿列表」共用同一份派生（`deriveDraftList` 全量、不按 run
 * 过滤）与同一个 `DraftListPanel` 视图——design D2「两个入口复用同一列表视图和
 * 选择逻辑」。保证源 run 消失后仍能从会话级入口复制/放弃草稿内容。
 */
function SessionDraftsEntry() {
  const drafts = useAppStore((s) => s.drafts);
  const openDraftAt = useAppStore((s) => s.openDraftAt);
  const discardCallDraft = useAppStore((s) => s.discardCallDraft);
  const discardModelAbDraft = useAppStore((s) => s.discardModelAbDraft);
  const discardCreateRunDraft = useAppStore((s) => s.discardCreateRunDraft);
  const items = useMemo(() => deriveDraftList(drafts), [drafts]);
  const dirtyCount = items.filter((item) => item.dirty).length;
  const [panelOpen, setPanelOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={panelOpen ? "true" : undefined}
        onClick={() => setPanelOpen((prev) => !prev)}
        title="本会话的全部调试草稿（不落盘；关闭应用即清空）"
        className={`inline-flex cursor-pointer items-center gap-1.5 rounded border px-2 py-0.5 text-reading-meta ${
          dirtyCount > 0
            ? "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
            : "border-gray-300 text-gray-700 hover:bg-gray-50"
        } ${FOCUS_RING}`}
      >
        <ScrollText size={12} aria-hidden="true" focusable="false" role="presentation" />
        会话草稿{dirtyCount > 0 ? ` · ${dirtyCount}` : ""}
      </button>
      {panelOpen ? (
        <div className="absolute right-0 top-full z-40 mt-1 max-h-80 w-96 max-w-[90vw] overflow-y-auto rounded border border-gray-200 bg-white p-2 shadow-xl">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] font-semibold text-gray-700">会话草稿</span>
            <button
              type="button"
              onClick={() => setPanelOpen(false)}
              className={`rounded px-1 text-[11px] text-gray-400 hover:bg-gray-100 ${FOCUS_RING}`}
              aria-label="关闭草稿列表"
            >
              ✕
            </button>
          </div>
          <DraftListPanel
            items={items}
            emptyHint="本会话暂无草稿：编辑重跑 / prompt / messages / A-B 或填写创建表单后出现在这里。"
            onOpen={(item) => {
              setPanelOpen(false);
              void openDraftAt({ runId: item.runId, spanId: item.spanId, field: item.field });
            }}
            onCopy={(item) => {
              void navigator.clipboard.writeText(item.copyText);
            }}
            onDiscard={(item) => {
              // U3 5.2：放弃确认走真模态（异步）——CAS 按列表条目修订校验
              const field = item.field;
              const runId = item.runId;
              const spanId = item.spanId;
              void requestConfirm({
                title: "放弃草稿",
                message: `放弃「${item.title}」的草稿？${field === "create" ? "" : `（run ${runId}${spanId !== null ? ` · ${spanId}` : ""}）`}\n内容将被删除，不可撤销。`,
              }).then((confirmed) => {
                if (!confirmed) return;
                if (field === "create") {
                  discardCreateRunDraft(item.revision);
                  return;
                }
                if (spanId === null) return;
                if (field === "model_ab") {
                  discardModelAbDraft({ runId, spanId }, item.revision);
                  return;
                }
                discardCallDraft({ runId, spanId, field }, item.revision);
              });
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

export function GlobalBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const setCreateDialogOpen = useAppStore((s) => s.setCreateDialogOpen);
  const setSettingsSection = useAppStore((s) => s.setSettingsSection);
  const detail = useAppStore((s) => s.detail);

  /** 录制接入 = 打开设置并定位代理分区（不另建录制界面） */
  const openRecording = (): void => {
    setSettingsSection("proxy");
    onOpenSettings();
  };

  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-gray-200 bg-white px-3 py-1.5">
      <span className="text-reading-body font-semibold text-gray-900">ReBaseAgent</span>
      <ViewToggle />

      <div className="ml-auto flex flex-wrap items-center gap-x-2 gap-y-1.5">
        {detail !== null ? (
          <span className="font-code text-reading-meta text-gray-400">{detail.meta.id}</span>
        ) : null}
        <SessionDraftsEntry />
        <button
          type="button"
          onClick={() => setCreateDialogOpen(true)}
          title="直接在桌面端跑一个 run（纯对话，或隔离文件运行；不需代理、不需写代码）"
          className={`inline-flex cursor-pointer items-center gap-1.5 rounded border border-gray-300 px-2 py-0.5 text-reading-meta text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
        >
          <Plus size={12} aria-hidden="true" focusable="false" role="presentation" />
          新建运行
        </button>
        <button
          type="button"
          onClick={openRecording}
          title="打开设置里的录制代理分区，把现有 Agent 的 base_url 指过来即可录制"
          className={`inline-flex cursor-pointer items-center gap-1.5 rounded border border-gray-300 px-2 py-0.5 text-reading-meta text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
        >
          <Waypoints size={12} aria-hidden="true" focusable="false" role="presentation" />
          录制接入
        </button>
        <StatusIndicators onOpenSettings={onOpenSettings} />
      </div>
    </header>
  );
}
