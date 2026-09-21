import { useEffect, useState } from "react";
import { BranchTree } from "./components/BranchTree";
import { ComparePanel } from "./components/ComparePanel";
import { DetailPanel } from "./components/DetailPanel";
import { RunList } from "./components/RunList";
import { SettingsDialog } from "./components/SettingsDialog";
import { SpanTree } from "./components/SpanTree";
import { useAppStore } from "./store";

export default function App() {
  const error = useAppStore((s) => s.error);
  const runs = useAppStore((s) => s.runs);
  const failed = useAppStore((s) => s.failed);
  const loadingList = useAppStore((s) => s.loadingList);
  const detail = useAppStore((s) => s.detail);
  const settingsConfigured = useAppStore((s) => s.settings?.configured);
  const proxy = useAppStore((s) => s.proxy);
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 挂载时加载一次列表与运行配置。只读工具，不做文件监听——目录内容变化后重新打开即可
  useEffect(() => {
    void (async () => {
      await useAppStore.getState().loadRuns();
      // 首次自动选择（任务 3.5）：列表首次成功加载且尚无选中项时，尝试最近可读摘要
      // 对应的运行并进入概览。只尝试一条——详情失败留在该 run 的原位错误态，不遍历其他记录。
      await useAppStore.getState().autoSelectInitialRun();
    })();
    void useAppStore.getState().loadSettings();
    void useAppStore.getState().loadProxyStatus();
  }, []);

  const empty = !loadingList && runs.length === 0 && failed.length === 0;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-2">
        <span className="text-sm font-semibold text-gray-900">ReBaseAgent</span>
        <span className="text-[11px] text-gray-500">
          不止回放 Agent 做了什么，而是让你改变它做了什么
        </span>
        <span className="ml-auto flex items-center gap-3">
          <span className="flex items-center gap-1 text-[11px]">
            <button
              type="button"
              onClick={() => setView("trace")}
              className={`rounded px-2 py-0.5 ${
                view === "trace"
                  ? "bg-blue-600 text-white"
                  : "border border-gray-300 text-gray-600 hover:bg-gray-50"
              }`}
              title="三栏视图：运行列表 / span 树 / 详情"
            >
              轨迹
            </button>
            <button
              type="button"
              onClick={() => setView("tree")}
              className={`rounded px-2 py-0.5 ${
                view === "tree"
                  ? "bg-blue-600 text-white"
                  : "border border-gray-300 text-gray-600 hover:bg-gray-50"
              }`}
              title="全宽分支树：节点为运行、连线为分叉，可勾选多条对照"
            >
              分支树
            </button>
          </span>
          {detail !== null ? (
            <span className="font-code text-[11px] text-gray-400">{detail.meta.id}</span>
          ) : null}
          {proxy !== null ? (
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="flex items-center gap-1.5 rounded border border-gray-300 px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50"
              title="本地录制代理：把你的 Agent 应用 base_url 指到 http://127.0.0.1:<端口>/v1，key 一字不动即可录制"
            >
              <span
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
            onClick={() => setSettingsOpen(true)}
            className="flex items-center gap-1.5 rounded border border-gray-300 px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50"
            title="配置 LLM 接入（baseURL / apiKey / model），供“在此重跑”发起真实调用"
          >
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                settingsConfigured === true ? "bg-emerald-500" : "bg-gray-300"
              }`}
            />
            运行配置
          </button>
        </span>
      </header>

      {error !== null ? (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-[11px] text-red-700">
          {error}
        </div>
      ) : null}

      <main className="flex min-h-0 flex-1">
        {view === "trace" ? (
          <>
            <RunList />
            <SpanTree />
            <DetailPanel />
          </>
        ) : (
          <>
            <BranchTree />
            <ComparePanel />
          </>
        )}
      </main>

      {empty ? (
        <footer className="border-t border-gray-200 bg-gray-50 px-4 py-2 text-[11px] text-gray-500">
          数据目录的 traces/ 下还没有 trace 文件——把 *.jsonl 放进去后重新打开即可。
        </footer>
      ) : null}

      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}
