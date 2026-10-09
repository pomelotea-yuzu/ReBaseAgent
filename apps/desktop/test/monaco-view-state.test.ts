import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * UI 密度 2.5（improve-workspace-reading-and-editing）：**Monaco 布局/视图状态接线**。
 *
 * 三块（design D3「Monaco 布局变化调用 layout…视图状态按草稿键/比较身份保存。
 * 复用可靠性 change 的可见宿主恢复机制，不另造恢复通道」）：
 *   1. `lib/editor-view-state` 纯函数——会话级保存/恢复 + 非法 JSON 容错（直接跑真函数）；
 *   2. `MonacoEditor.tsx` 源码契约——diff 编辑器对齐单编辑器的宿主/尺寸恢复/视图状态
 *      接线，且**复用同一个** useSizeRecovery（无重复 observer）；
 *   3. file diff 不参与视图状态——其滚动恢复由 U2 4.3 专属通道唯一权威承载，
 *      键推导要求 host+target 同时存在 ⇒ 无 target 天然不启用（源码切片钉住）。
 *
 * ⚠️ 本包无 jsdom：静态渲染不跑 effect、懒编辑器稳定落 loading 占位 ⇒
 *    就绪态行为由 ①+② 承载；真实 monaco 的光标/滚动语义归 §4 实机 CDP。
 */

const read = (rel: string): string =>
  readFileSync(resolve(import.meta.dirname, `../src/renderer/src/${rel}`), "utf8");

const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

// ---------------------------------------------------------------------------
// ① lib 纯函数（真跑）
// ---------------------------------------------------------------------------

const {
  captureEditorViewState,
  parseViewStateJson,
  resetEditorViewStatesForTest,
  restoreEditorViewState,
  stringifyViewState,
  viewStateKeyOf,
} = await import("../src/renderer/src/lib/editor-view-state");

/** 假编辑器：记录 restoreViewState 调用；saveViewState 返回构造时给的快照 */
function fakeEditor(save: unknown) {
  const restored: unknown[] = [];
  return {
    restored,
    saveViewState: (): unknown => save,
    restoreViewState: (state: unknown): void => {
      restored.push(state);
    },
  };
}

beforeEach(() => {
  resetEditorViewStatesForTest();
});

describe("2.5 viewStateKeyOf：host+target 同时在才启用", () => {
  it("两者都是非空字符串 ⇒ 键 = host|target", () => {
    expect(viewStateKeyOf("prompt-draft", "run1:span2:system_prompt")).toBe(
      "prompt-draft|run1:span2:system_prompt",
    );
  });

  it("缺 host / 缺 target / 空串 / 非字符串 ⇒ null（不启用）", () => {
    expect(viewStateKeyOf(undefined, "t")).toBeNull();
    expect(viewStateKeyOf("h", undefined)).toBeNull();
    expect(viewStateKeyOf("", "t")).toBeNull();
    expect(viewStateKeyOf("h", "")).toBeNull();
    expect(viewStateKeyOf(123, "t")).toBeNull();
    expect(viewStateKeyOf("h", null)).toBeNull();
  });

  it("file diff 只有 host 无 target ⇒ 天然不启用（无需调用方排除）", () => {
    expect(viewStateKeyOf("file-diff", undefined)).toBeNull();
  });
});

describe("2.5 stringifyViewState / parseViewStateJson：非法 JSON 容错", () => {
  it("普通对象 ⇄ JSON 往返", () => {
    const raw = stringifyViewState({ lineNumber: 3, column: 7 });
    expect(raw).toBe('{"lineNumber":3,"column":7}');
    expect(parseViewStateJson(raw)).toEqual({ lineNumber: 3, column: 7 });
  });

  it("循环引用 / undefined ⇒ null，不抛（保存端容错）", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(stringifyViewState(cyclic)).toBeNull();
    expect(stringifyViewState(undefined)).toBeNull();
  });

  it("非法 JSON / 空串 / null ⇒ null，不抛（恢复端容错）", () => {
    expect(parseViewStateJson("not-json{")).toBeNull();
    expect(parseViewStateJson("")).toBeNull();
    expect(parseViewStateJson(null)).toBeNull();
  });
});

describe("2.5 capture / restore：按键保存、恢复的是等值快照", () => {
  it("capture 后 restore ⇒ restoreViewState 收到等值对象（光标/滚动随 view state 走）", () => {
    const editor = fakeEditor({ lineNumber: 12, column: 3, scrollTop: 240 });
    captureEditorViewState(editor, "prompt-draft|run1:span2:messages");
    const fresh = fakeEditor(null);
    restoreEditorViewState(fresh, "prompt-draft|run1:span2:messages");
    expect(fresh.restored).toEqual([{ lineNumber: 12, column: 3, scrollTop: 240 }]);
  });

  it("无存档的键 ⇒ 不调 restoreViewState（新目标保持默认视图）", () => {
    const editor = fakeEditor(null);
    restoreEditorViewState(editor, "no-such-key");
    expect(editor.restored).toEqual([]);
  });

  it("editor 或 key 为 null ⇒ 双向都 no-op（file diff / 未启用路径）", () => {
    const editor = fakeEditor({ a: 1 });
    expect(() => captureEditorViewState(editor, null)).not.toThrow();
    expect(() => restoreEditorViewState(editor, null)).not.toThrow();
    expect(() => captureEditorViewState(null, "k")).not.toThrow();
    expect(() => restoreEditorViewState(null, "k")).not.toThrow();
    expect(editor.restored).toEqual([]);
  });

  it("saveViewState 抛循环引用 ⇒ capture 不抛、不存（restore 无效果）", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const editor = {
      restored: [] as unknown[],
      saveViewState: (): unknown => cyclic,
      restoreViewState: (state: unknown): void => {
        editor.restored.push(state);
      },
    };
    expect(() => captureEditorViewState(editor, "k")).not.toThrow();
    const fresh = fakeEditor(null);
    restoreEditorViewState(fresh, "k");
    expect(fresh.restored).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ② MonacoEditor.tsx 源码契约：diff 对齐单编辑器 + 无重复 observer
// ---------------------------------------------------------------------------

describe("2.5 MonacoDiffEditor 对齐单编辑器的宿主/恢复/视图状态接线", () => {
  const SRC = stripComments(read("components/MonacoEditor.tsx"));

  it("diff 就绪态有锚点宿主 div（承载尺寸观察与身份锚点）", () => {
    const slice = SRC.slice(SRC.indexOf("export function MonacoDiffEditor"));
    expect(slice).toContain("ref: hostRef");
    expect(slice).toContain("useSizeRecovery(hostRef, editorRef)");
  });

  it("复用**同一个**尺寸恢复机制——剥注释后 new ResizeObserver 全文件只此一处", () => {
    expect(SRC.match(/new ResizeObserver/g)?.length).toBe(1);
  });

  it("两个编辑器的 onMount 合成都在调用方 onMount 之后恢复视图状态（最后写入手）", () => {
    expect(SRC.match(/restoreEditorViewState\(editorRef\.current, viewStateKey\);/g)?.length).toBe(
      2,
    );
    // upstream 先行：调用方对实例的设置不被视图状态恢复覆盖顺序颠倒
    expect(
      SRC.match(/const upstream = \(props as Record<string, unknown>\)\.onMount;/g)?.length,
    ).toBe(2);
  });

  it("两个编辑器都在卸载前保存视图状态（cleanup 时机，键经 ref 取最新值）", () => {
    expect(SRC.match(/useCaptureViewStateOnUnmount\(viewStateKey, editorRef\);/g)?.length).toBe(2);
    const hook = SRC.slice(SRC.indexOf("function useCaptureViewStateOnUnmount"));
    expect(hook).toContain("captureEditorViewState(editorRef.current, keyRef.current)");
  });

  it("editorRef 统一 EditorLike（layout + saveViewState/restoreViewState 结构子集）", () => {
    expect(SRC.match(/useRef<EditorLike \| null>\(null\)/g)?.length).toBe(2);
  });
});

describe("2.5 file diff 不参与视图状态（U2 4.3 通道唯一权威）", () => {
  const WFS = stripComments(read("components/WorkspaceFileView.tsx"));

  it("file diff 调用点只有 data-monaco-host，无 data-monaco-target", () => {
    const start = WFS.indexOf('data-monaco-host="file-diff"');
    const end = WFS.indexOf("onMount={onDiffMount}");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const slice = WFS.slice(start, end);
    expect(slice).not.toContain("data-monaco-target");
  });

  it("compare-diff 保持比较身份 target（视图状态按比较身份保存的启用证据）", () => {
    const CS = stripComments(read("components/CompareWorkspaceView.tsx"));
    expect(CS).toContain("data-monaco-target={`${left.runId}:${right.runId}:text-diff`}");
  });
});

// ---------------------------------------------------------------------------
// ③ 静态渲染：loading 占位契约在宿主化之后保持（锚点/高度透传不变）
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = { api: {} };

const { MonacoDiffEditor } = await import("../src/renderer/src/components/MonacoEditor");

describe("2.5 MonacoDiffEditor 静态渲染（loading 态）", () => {
  it("占位带 data-monaco-host 锚点与高度（宿主化前后 DOM 契约不变）", () => {
    const html = renderToStaticMarkup(
      createElement(MonacoDiffEditor, {
        "data-testid": "diff-editor",
        "data-monaco-host": "file-diff",
        height: "100%",
        original: "a",
        modified: "b",
      }),
    );
    expect(html).toContain('data-monaco-host="file-diff"');
    expect(html).toContain('data-testid="diff-editor"');
    expect(html).toContain("正在加载编辑器…");
  });
});
