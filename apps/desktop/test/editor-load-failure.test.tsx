/**
 * 任务 4.3 · S3 半边：加载/恢复失败的 UI 契约与状态机。
 *
 * ## 为什么这层是单测而不是实机（诚实边界，勿当"实机已验证"引用）
 *
 * 实机注入尝试过两条路，都不成立（2026-10-08 实测）：
 *   ① CDP `Fetch` 域拦 `*MonacoEditor*` 请求并 `failRequest` ⇒ **`Fetch.requestPaused`
 *      一次都没触发**（paused=0）。原因是 dev 下该 chunk 已被浏览器 HTTP 缓存，
 *      收起/重开工作区不会重新发请求 ⇒ 注入面不存在。
 *   ② 页内 hook `import()` ⇒ vite 把动态 import 编译成 `__vitePreload(() => import(url))`，
 *      页内拦不到。
 * 而"chunk 取不到"的真实形态就是**网络失败**，Fetch 域本该是对的面——所以这条限制
 * 是 dev 缓存造成的，不是判据错。生产/packaged 环境的同场景归 5.x 离线冒烟。
 *
 * 因此分层：注入面（失败态是否可达）由本测试承载（直接驱动 loader 拒绝），
 * 真实窗口下的**恢复行为**由 `scripts/editor-recovery-43-cdp.cjs` 承载。
 */
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MonacoLoadFailure } from "../src/renderer/src/components/MonacoEditor";

describe("MonacoLoadFailure · 失败占位的 DOM 契约", () => {
  const html = renderToStaticMarkup(
    <MonacoLoadFailure
      height={200}
      testId="messages-draft-editor"
      extra={{
        "data-monaco-host": "messages-draft",
        "data-monaco-target": "run_x:s_02:messages",
      }}
      onRetry={() => {}}
    />,
  );

  // 🔴 关键：失败态必须**自带可寻址身份**。隐藏 helper 不误报（spec 场景三）的前提是
  // 每个编辑器都有锚点；失败占位若丢了锚点，探针就看不见它 ⇒ "失败可见"无法验证。
  it("保留 data-monaco-host 锚点（探针能寻址到失败实例）", () => {
    expect(html).toContain('data-monaco-host="messages-draft"');
    expect(html).toContain('data-monaco-target="run_x:s_02:messages"');
  });

  it("带失败标记 data-monaco-failed", () => {
    expect(html).toContain('data-monaco-failed="true"');
  });

  it("保留调用方的 data-testid（既有展示层断言不失效）", () => {
    expect(html).toContain('data-testid="messages-draft-editor"');
  });

  it("给出可辨的失败标题（不是「正在加载」）", () => {
    expect(html).toContain("编辑器未能加载");
    // 旧实现的文案是「正在加载编辑器…」——失败时显示它就是本轮修掉的缺陷本身
    expect(html).not.toContain("正在加载编辑器");
  });

  it("给出就地重试入口", () => {
    expect(html).toContain('data-monaco-retry="true"');
    expect(html).toContain("就地重试");
  });

  // spec：恢复 SHALL 保留草稿、不自动提交、不恢复旧许可、不以重启为唯一出口
  it("文案写明草稿保持原样、重试只影响这一个编辑器", () => {
    expect(html).toContain("草稿与目标保持原样");
    expect(html).toContain("只恢复这一个编辑器");
  });

  it("失败占位是真实 button（可点），不是文字", () => {
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
  });

  it("沿用请求的高度（塌缩时不改变布局节奏）", () => {
    expect(html).toContain("height:200px");
  });
});

describe("失败占位不是普通加载占位", () => {
  // 两条路径互斥：失败时**不能**同时显示「正在加载编辑器…」，否则用户仍以为在等
  it("失败态不含加载中文案", () => {
    const html = renderToStaticMarkup(<MonacoLoadFailure height={160} onRetry={() => {}} />);
    expect(html).not.toContain("正在加载编辑器");
  });

  it("失败态没有 data-monaco-failed=false 之类的软标记（只认 true）", () => {
    const html = renderToStaticMarkup(<MonacoLoadFailure height={160} onRetry={() => {}} />);
    expect(html).toContain('data-monaco-failed="true"');
    expect(html).not.toContain('data-monaco-failed="false"');
  });
});

describe("懒加载状态机 · 拒绝必须进 failed（不是永远 loading）", () => {
  /**
   * 🔴 **为什么这里是源码断言而不是行为断言**（第一版栽在这）：
   *   本包无 jsdom 也没有 react-test-renderer ⇒ 跑不了 effect，行为断言只能
   *   "镜像"一份状态转移逻辑。第一版就是这么写的，结果把实现的 `setState("failed")`
   *   删掉后**测试仍然全绿**——它测的是复制品，不是产品。
   *   改为直接断言实现的结构：拒绝分支必须真的把状态置成 failed，且必须挂在
   *   `.then(_, 拒绝分支)` / `.catch` 上。这样删掉任一半边都会红。
   */
  const SRC = readFileSync(
    new URL("../src/renderer/src/components/MonacoEditor.tsx", import.meta.url),
    "utf8",
  );

  /** 取 `loader()` 那一段的状态机实现（到下一个 `}, [` 或 useCallback 之前）。 */
  function stateMachine(): string {
    const start = SRC.indexOf("export function useLazyEditors");
    expect(start).toBeGreaterThan(-1);
    const end = SRC.indexOf("const retry = useCallback", start);
    return SRC.slice(start, end === -1 ? start + 2000 : end);
  }

  it("实现了 failed 状态（本轮修掉的缺陷就是缺这一态）", () => {
    expect(SRC).toContain('type LoadState = "loading" | "ready" | "failed"');
  });

  it('状态机里真的有 setState("failed")（删掉它必红）', () => {
    expect(stateMachine()).toContain('setState("failed")');
  });

  // 旧实现是 `loader().then(() => setState("ready"))` —— 只有成功分支
  //
  // ⚠️ 断言按**语义**写（"loader 调用 + 两参 then"），不钉死 `loader()` 字面：
  //   实现已改为 `loaderRef.current()`（固定首次身份，防调用方漏包 useCallback 导致
  //   无限重载），字面匹配会在这种正当重构时假红。
  it("拒绝分支挂在加载调用的第二个参数或 .catch 上（不是被忽略）", () => {
    const m = stateMachine();
    const call2 = /(?:loader\(\)|loaderRef\.current\(\))\.then\([\s\S]*?,\s*\(e:\s*unknown\)\s*=>/;
    const callCatch = /(?:loader\(\)|loaderRef\.current\(\))[\s\S]*?\.catch\(/;
    expect(call2.test(m) || callCatch.test(m)).toBe(true);
  });

  it("重试入口递增 attempt 并进 effect 依赖（重试才真的重跑加载）", () => {
    const m = stateMachine();
    expect(m).toContain("setAttempt");
    expect(m).toMatch(/\}, \[attempt\]\)/);
  });

  // 「loader 身份被 ref 固定」是本轮修掉的第二个真问题：原依赖数组是 [loader, attempt]，
  // 调用方每次渲染新建 loader ⇒ 无限重载（重载 ⇒ setState ⇒ 再渲染 ⇒ …）。
  it("加载器身份用 ref 固定，不因调用方重建函数而重载", () => {
    const m = stateMachine();
    expect(m).toContain("useRef(loader)");
    // 依赖数组里不得再有 loader
    expect(m).not.toMatch(/\}, \[[^\]]*\bloader\b[^\]]*\]\)/);
  });

  it("重试只重跑加载，不触发模型调用/草稿写入（本层不碰 store 与 IPC）", () => {
    expect(SRC).not.toMatch(/from "\.\.\/store"/);
    expect(SRC).not.toMatch(/window\.api/);
    expect(SRC).not.toMatch(/useAppStore/);
  });

  it("尺寸观察在 cleanup 时 disconnect（不泄漏 observer）", () => {
    expect(SRC).toContain("observer.disconnect()");
  });

  it("failed 分支渲染失败占位，两个编辑器包装层都接了", () => {
    // 两个包装各一处：漏一处就是"diff 编辑器没有就地重试"
    const occurrences = SRC.split('state === "failed"').length - 1;
    expect(occurrences).toBe(2);
  });
});
