import { useEffect } from "react";
import { DetailPanel } from "./components/DetailPanel";
import { RunList } from "./components/RunList";
import { SpanTree } from "./components/SpanTree";
import { useAppStore } from "./store";

export default function App() {
  const error = useAppStore((s) => s.error);
  const runs = useAppStore((s) => s.runs);
  const failed = useAppStore((s) => s.failed);
  const loadingList = useAppStore((s) => s.loadingList);
  const detail = useAppStore((s) => s.detail);

  // 挂载时加载一次列表。只读工具，不做文件监听——目录内容变化后重新打开即可
  useEffect(() => {
    void useAppStore.getState().loadRuns();
  }, []);

  const empty = !loadingList && runs.length === 0 && failed.length === 0;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-2">
        <span className="text-sm font-semibold text-gray-900">ReBaseAgent</span>
        <span className="text-[11px] text-gray-500">
          不止回放 Agent 做了什么，而是让你改变它做了什么
        </span>
        {detail !== null ? (
          <span className="ml-auto font-code text-[11px] text-gray-400">{detail.meta.id}</span>
        ) : null}
      </header>

      {error !== null ? (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-[11px] text-red-700">
          {error}
        </div>
      ) : null}

      <main className="flex min-h-0 flex-1">
        <RunList />
        <SpanTree />
        <DetailPanel />
      </main>

      {empty ? (
        <footer className="border-t border-gray-200 bg-gray-50 px-4 py-2 text-[11px] text-gray-500">
          数据目录的 traces/ 下还没有 trace 文件——把 *.jsonl 放进去后重新打开即可。
        </footer>
      ) : null}
    </div>
  );
}
