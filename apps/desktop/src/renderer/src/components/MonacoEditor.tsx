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

import { createElement, lazy, useEffect, useState } from "react";
import type { ComponentProps } from "react";

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
export function MonacoCodeEditor(props: CodeEditorProps) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    void import("./MonacoEditors").then(() => {
      if (alive) setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);
  if (!loaded)
    return (
      <MonacoFallback
        height={props.height}
        testId={(props as Record<string, string>)["data-testid"]}
        extra={editorAttrs(props as Record<string, unknown>)}
      />
    );
  return createElement(LazyCodeEditor(), {
    ...props,
    ...editorAttrs(props as Record<string, unknown>),
    ...behaviorProps(props as Record<string, unknown>),
  });
}

let diffEditors: ReturnType<typeof lazy<EditorsModule["DiffCodeEditor"]>> | null = null;

/** 懒加载的 `<DiffEditor>` 直替，同上。 */
export function MonacoDiffEditor(props: DiffCodeEditorProps) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    void import("./MonacoEditors").then(() => {
      if (alive) setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);
  if (!loaded)
    return (
      <MonacoFallback
        height={props.height}
        testId={(props as Record<string, string>)["data-testid"]}
        extra={editorAttrs(props as Record<string, unknown>)}
      />
    );
  return createElement(LazyDiffEditor(), {
    ...props,
    ...editorAttrs(props as Record<string, unknown>),
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
