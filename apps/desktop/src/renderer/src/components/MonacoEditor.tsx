/**
 * Monaco 编辑器的懒加载包装（U1 任务 5.6）。
 *
 * 为什么需要它：`@monaco-editor/react` 的 `<Editor>` / `<DiffEditor>` 本身是"半懒"的
 * ——它们的 monaco 实例来自 `loader`，但**谁把 loader 配上本地实例**这件事此前由
 * `main.tsx` 的副作用导入（`import "./monaco-bootstrap"`）完成，而那个副作用导入会
 * **静态**把 monaco 核心打进主 bundle ⇒ 纯浏览路径也加载了 ~8MB 编辑器资源，违反
 * spec「仅在用户进入编辑态时加载编辑器资源」。
 *
 * 本模块把"装配 + 渲染"一起挂到 React 的懒边界上：
 * - `React.lazy` 让 `./MonacoEditors` 成为独立 chunk（webpack/vite 自动分割）；
 * - 该 chunk 在被渲染时才求值，而它内部调用 `ensureMonaco()`（动态 import monaco 核心）；
 * - 因此"进入编辑态"是加载编辑器资源的**唯一**触发点。
 *
 * ⚠️ 测试/无 DOM 环境：`renderToStaticMarkup` 不跑 effect、也不支持懒边界挂起 ⇒
 *    "未加载"时稳定渲染 `MonacoFallback` 占位。因此断言分两层：本模块的**接线契约**
 *    （source 级）与 `MonacoFallback` 的静态渲染；真实加载时机归 7.x CDP。
 */

import { createElement, lazy, useCallback, useEffect, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { classifyHost, layoutRecoveryAction, recoveryNotice } from "../lib/editor-recovery";

/**
 * 加载中/失败时显示的占位（不含任何 monaco 依赖）。
 *
 * `testId` 用于把调用方原本给 `<DiffEditor>` / `<Editor>` 的 `data-testid` 落到 DOM 上：
 * 懒加载未完成时渲染的就是本占位，测试要断言的"进没进编辑器"这个锚点必须继续存在。
 */
export function MonacoFallback({
  height,
  testId,
  extra,
}: {
  height?: number | string;
  testId?: string;
  extra?: Record<string, unknown>;
}) {
  return (
    <div
      {...extra}
      data-testid={testId}
      className="flex items-center justify-center rounded border border-gray-200 bg-gray-50 text-[11px] text-gray-400"
      style={{ height: height ?? 160 }}
    >
      正在加载编辑器…
    </div>
  );
}

type EditorsModule = typeof import("./MonacoEditors");
type CodeEditorProps = ComponentProps<EditorsModule["CodeEditor"]>;
type DiffCodeEditorProps = ComponentProps<EditorsModule["DiffCodeEditor"]>;

/**
 * 给 `<div>` 之外的"原生组件"透传 `data-testid`。
 *
 * 为什么需要：`@monaco-editor/react` 的 `<Editor>` / `<DiffEditor>` 只把已知 props 传给
 * monaco 宿主，**不会**把 `data-*` 落到 DOM 上；但 5.6 之前的 `WorkspaceFileView` 静态
 * import 时，测试用 `vi.mock` 桩掉了这两个组件、桩会照搬 `data-testid`。改成懒包装后
 * 桩被绕开（懒边界内的 `MonacoEditors` 才是真 import 点），所以 `data-*` 必须由**本层**
 * 落到 DOM 上，否则展示层的结构断言失去锚点。
 */
function editorAttrs(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(props)) {
    if (key.startsWith("data-") || key.startsWith("aria-")) out[key] = props[key];
  }
  return out;
}

/**
 * 向上层透传的**行为型** props（非 `data-*`/`aria-*` 那种 DOM 属性）。
 *
 * U2 任务 4.5 的**关键**：`onMount` 不在 `data-*`/`aria-*` 里，`editorAttrs` 会把它过滤掉，
 * 于是编辑器实例永远到不了父组件、差异导航/查找**在结构上无法接线**（这正是 4.5 被误勾的
 * 根因）。此函数把这类"要传给原生组件而非落到 DOM"的回调单独挑出来转发。
 */
const PASSTHROUGH_CALLBACKS = ["onMount"] as const;
function behaviorProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of PASSTHROUGH_CALLBACKS) {
    if (typeof props[key] === "function") out[key] = props[key];
  }
  return out;
}

let editors: ReturnType<typeof lazy<EditorsModule["CodeEditor"]>> | null = null;

/**
 * 懒加载的 `<Editor>` 直替。签名与 `@monaco-editor/react` 的 `Editor` 对齐（透传 props）。
 *
 * `lazy` 的模块工厂只求值一次；这里用模块级 `let` 记住它，避免每次渲染新建 lazy 组件
 * （那会导致每次重渲染都重新挂载、丢编辑器状态）。
 *
 * ⚠️ 不得用 Suspense 包住懒组件——`renderToStaticMarkup` 不支持挂起（会抛
 *    "A component suspended while responding to synchronous input"）。改为**显式状态门**：
 *    `loaded === false` 时直接渲染占位，在 `useEffect` 里 import 成功后置位。静态渲染下
 *    useEffect 不跑 ⇒ 稳定得到占位，结构断言可预测；真实运行下加载完成后正常渲染编辑器。
 */
/**
 * 懒 chunk 的加载态机：`loading | ready | failed`。
 *
 * 🔴 **本轮（任务 4.2）修掉的真实缺陷**：原实现只有 `loaded: boolean` 且
 * `import("./MonacoEditors").then()` **没有 `.catch`** ⇒ chunk 加载失败（离线资源缺失、
 * 路径改名、chunk 404）会永远停在 `MonacoFallback` 的「正在加载编辑器…」，
 * 用户看到的字面是"还在加载"，唯一出口是重启应用——**直接违反 spec**
 * 「加载/恢复失败 SHALL 有明确占位与本地恢复动作，不以重启为唯一出口」。
 *
 * 重试语义（design D5）：**只重试这一个编辑器**——重跑 chunk import，不动草稿、
 * 不恢复旧确认许可、不调用模型、不重挂整棵子树。
 */
type LoadState = "loading" | "ready" | "failed";

/**
 * 懒 chunk 的加载态机。
 *
 * ⚠️ 导出仅为可测：node 环境（本包无 jsdom）跑不了 effect 驱动的挂载，
 * 状态机的三条分支（loading/ready/failed）与重试语义由测试直接驱动本 hook 验证；
 * 组件层用 `renderToStaticMarkup` 断言失败占位的 DOM 契约。
 * 生产路径不使用导出。
 */
export function useLazyEditors(loader: () => Promise<unknown>): [LoadState, () => void] {
  const [state, setState] = useState<LoadState>("loading");
  // 每次重试递增；effect 依赖它 ⇒ 重试即重跑 import
  const [attempt, setAttempt] = useState(0);
  // ⚠️ `loader` 是**外部传入**的函数，把它放进 effect 依赖等于让"调用方每次渲染
  // 新建函数"变成无限重载（父组件重渲染 ⇒ 新 loader 身份 ⇒ 重跑 import ⇒ 再重渲染…）。
  // 生产调用点都用 `useCallback(() => import(...), [])` 稳定身份，但契约不该建立在
  // "调用方记得包 useCallback"上 ⇒ 在此用 ref 固定**首次**那个 loader，身份变化不重载。
  const loaderRef = useRef(loader);
  // `attempt` 是**刻意的重跑触发器**：它不在 effect 体内被读取，唯一作用是让依赖变化
  // 从而重跑一次 chunk import（= 就地重试）。按 lint 建议删掉会让重试按钮变成空操作。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 见上（重跑触发器，非读取）
  useEffect(() => {
    let alive = true;
    setState("loading");
    loaderRef.current().then(
      () => {
        if (alive) setState("ready");
      },
      (e: unknown) => {
        if (alive) setState("failed");
        // 失败原因落进控制台便于真机取证；**不弹窗、不写盘**（诊断走既有日志通道）
        console.error("[monaco] 编辑器懒加载失败", e);
      },
    );
    return () => {
      alive = false;
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return [state, retry];
}

/**
 * 加载失败的占位 + 就地重试入口（spec「恢复失败可见且能就地重试」）。
 *
 * ⚠️ 导出仅为可测（理由同 `useLazyEditors`）：静态渲染即可断言它的 DOM 契约。
 */
export function MonacoLoadFailure({
  testId,
  extra,
  height,
  onRetry,
}: {
  readonly height?: number | string;
  readonly testId?: string;
  readonly extra?: Record<string, unknown>;
  readonly onRetry: () => void;
}) {
  const notice = recoveryNotice("编辑器资源未能加载");
  return (
    <div
      {...extra}
      data-testid={testId}
      data-monaco-failed="true"
      className="flex flex-col items-start justify-center gap-1 rounded border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900"
      style={{ height: height ?? 160 }}
    >
      <span className="font-medium">{notice.title}</span>
      <span className="leading-4">{notice.detail}</span>
      <button
        type="button"
        data-monaco-retry="true"
        onClick={onRetry}
        className="mt-0.5 rounded border border-amber-400 bg-white px-2 py-0.5 text-amber-900 hover:bg-amber-100"
      >
        {notice.action}
      </button>
    </div>
  );
}

/**
 * 把调用方给的可寻址身份（`data-monaco-host` / `data-monaco-target`）透出。
 *
 * 🔴 **为什么必须有锚点**（评审 2026-10-06 的原话）：
 * 「单凭选择器命中某个零尺寸节点不能确认可见编辑器塌缩」。monaco 0.56 在页面里
 * 合法存在 0×0 节点（inline diff 的隐藏侧、EditContext 隐藏输入面），
 * 全页扫 `.monaco-editor` 必然误报。锚点让"哪个编辑器属于哪个目标"可判定。
 */
function hostIdentity(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["data-monaco-host", "data-monaco-target"]) {
    const v = props[key];
    if (typeof v === "string") out[key] = v;
  }
  return out;
}

/**
 * 尺寸恢复接线（design D5）。
 *
 * 观察**锚点宿主自身**的边框盒；只在"从零尺寸恢复到有空间"那一刻调一次
 * `editor.layout()`。两点纪律：
 *   - `layoutRecoveryAction` 在空间未真正回来时返回 null ⇒ 观察回调不自激，
 *     避免"每帧 layout"的重建风暴；
 *   - cleanup 必须 `disconnect()`（design D5 点名"清理 observer，不循环重建"）。
 *
 * ⚠️ 观察的是**我们的宿主 div**，不是 monaco 内部节点：观察 `.monaco-editor`
 * 会命中 0.56 的 0×0 尺寸探针（伪值）。
 */
function useSizeRecovery(
  hostRef: React.RefObject<HTMLDivElement | null>,
  editorRef: React.RefObject<{ layout: () => void } | null>,
): void {
  const last = useRef<{ offsetW: number; offsetH: number }>({ offsetW: 0, offsetH: 0 });
  useEffect(() => {
    const el = hostRef.current;
    if (el === null) return;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const before = last.current;
      const after = { offsetW: el.offsetWidth, offsetH: el.offsetHeight };
      last.current = after;
      if (layoutRecoveryAction(before, after) === "relayout") {
        editorRef.current?.layout();
      }
    });
    observer.observe(el);
    // 初始尺寸记一次：否则首次挂载就有空间时，"折叠再展开"会被误当成
    // "从零恢复"而多调一次 layout
    last.current = { offsetW: el.offsetWidth, offsetH: el.offsetHeight };
    return () => observer.disconnect();
  }, [hostRef, editorRef]);
}

export function MonacoCodeEditor(props: CodeEditorProps) {
  const [state, retry] = useLazyEditors(useCallback(() => import("./MonacoEditors"), []));
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<{ layout: () => void } | null>(null);
  useSizeRecovery(hostRef, editorRef);

  const testId = (props as Record<string, string>)["data-testid"];
  const attrs = {
    ...editorAttrs(props as Record<string, unknown>),
    ...hostIdentity(props as Record<string, unknown>),
  };

  if (state === "failed")
    return (
      <MonacoLoadFailure height={props.height} testId={testId} extra={attrs} onRetry={retry} />
    );
  if (state === "loading")
    return <MonacoFallback height={props.height} testId={testId} extra={attrs} />;

  // 就绪态：外层 div 是**锚点宿主**（承载尺寸观察 + 身份锚点），编辑器在里面。
  // ⚠️ 不能省掉这层 div——没有稳定宿主就既无法观察尺寸也无法判定可见性。
  return createElement(
    "div",
    {
      ref: hostRef,
      className: (props as Record<string, string>).className,
      style: { height: props.height ?? 160 },
      ...attrs,
    },
    createElement(LazyCodeEditor(), {
      ...props,
      ...attrs,
      ...behaviorProps(props as Record<string, unknown>),
      // 尺寸恢复需要 editor 实例；同时**保留调用方的 onMount**（U2 4.5 的接线契约：
      // 差异导航/查找靠它拿实例，漏掉就是"纯逻辑写好、接线少一支"）
      onMount: (editor: unknown, monaco: unknown) => {
        editorRef.current = editor as { layout: () => void };
        const upstream = (props as Record<string, unknown>).onMount;
        if (typeof upstream === "function") {
          (upstream as (e: unknown, m: unknown) => void)(editor, monaco);
        }
      },
    }),
  );
}

let diffEditors: ReturnType<typeof lazy<EditorsModule["DiffCodeEditor"]>> | null = null;

/** 懒加载的 `<DiffEditor>` 直替，同上。 */
export function MonacoDiffEditor(props: DiffCodeEditorProps) {
  const [state, retry] = useLazyEditors(useCallback(() => import("./MonacoEditors"), []));
  const testId = (props as Record<string, string>)["data-testid"];
  const attrs = {
    ...editorAttrs(props as Record<string, unknown>),
    ...hostIdentity(props as Record<string, unknown>),
  };

  if (state === "failed")
    return (
      <MonacoLoadFailure height={props.height} testId={testId} extra={attrs} onRetry={retry} />
    );
  if (state === "loading")
    return <MonacoFallback height={props.height} testId={testId} extra={attrs} />;

  return createElement(LazyDiffEditor(), {
    ...props,
    ...attrs,
    ...behaviorProps(props as Record<string, unknown>),
  });
}

function LazyCodeEditor(): ReturnType<typeof lazy<EditorsModule["CodeEditor"]>> {
  if (editors === null) {
    editors = lazy(() => import("./MonacoEditors").then((m) => ({ default: m.CodeEditor })));
  }
  return editors;
}

function LazyDiffEditor(): ReturnType<typeof lazy<EditorsModule["DiffCodeEditor"]>> {
  if (diffEditors === null) {
    diffEditors = lazy(() =>
      import("./MonacoEditors").then((m) => ({ default: m.DiffCodeEditor })),
    );
  }
  return diffEditors;
}
