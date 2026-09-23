/**
 * Monaco 实际渲染层（**只被懒 chunk 求值**，U1 任务 5.6）。
 *
 * ⚠️ 本文件**不得被任何非懒路径静态引入**——它就是那条懒边界内的实体。
 *    一旦被静态 import，编辑器资源又会回到主 bundle，spec「仅在进入编辑态时加载」即被破坏。
 *    （`test/monaco-lazy.test.ts` 有 source 级契约钉住这一点。）
 *
 * 职责：先 `ensureMonaco()` 完成离线装配（配置 loader 指向本地实例 + 装配两个 worker），
 * 再渲染 `@monaco-editor/react` 的原生组件。装配是幂等的，重复渲染不会重复装配。
 *
 * U2 任务 4.5：本层**原样透传 props**（`createElement(Editor, props)`），因此
 * `@monaco-editor/react` 的 `onMount` 会自然抵达原生组件，编辑器实例（`IStandaloneCodeEditor`
 * / `IStandaloneDiffEditor`）经它外抛给上层的 `MonacoEditor.tsx`。**本文件不需要额外改动**
 * ——真正的过滤发生在中间层 `MonacoEditor.tsx` 的 `editorAttrs`（它只透传 `data-*`/`aria-*`）。
 */

import { DiffEditor, Editor } from "@monaco-editor/react";
import type { ComponentProps } from "react";
import { createElement, useEffect, useState } from "react";
import { ensureMonaco } from "../monaco-bootstrap";

type EditorProps = ComponentProps<typeof Editor>;
type DiffEditorProps = ComponentProps<typeof DiffEditor>;

/**
 * 在渲染真正的编辑器前完成 Monaco 装配。
 *
 * 用 `useState` 而不是 `useEffect` + `Suspense`：装配完成前先渲染一个空 div，
 * 完成后切到真正的 Editor——避免"loader 未配置却先挂载 Editor"的竞态。
 */
function useMonacoReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void ensureMonaco().then(() => {
      if (alive) setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);
  return ready;
}

export function CodeEditor(props: EditorProps) {
  const ready = useMonacoReady();
  if (!ready) return createElement("div", { style: { height: props.height ?? 160 } });
  return createElement(Editor, props);
}

export function DiffCodeEditor(props: DiffEditorProps) {
  const ready = useMonacoReady();
  if (!ready) return createElement("div", { style: { height: props.height ?? 160 } });
  return createElement(DiffEditor, props);
}
