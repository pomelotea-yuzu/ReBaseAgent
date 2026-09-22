/**
 * Monaco 按需装配（design D1）。
 *
 * 装配内容（离线自托管，不联网）：
 * - 只打包 editor 核心、全部编辑器特性与 JSON 语言贡献；
 * - 只装配 editor.worker 与 json.worker，`json` label 走 JSON worker、其余回退 editor worker；
 * - 显式指向本地实例，禁止 @monaco-editor/react 默认从 CDN 拉取。
 *
 * ⚠️ **懒加载纪律（U1 任务 5.6）**：本模块**不再被 `main.tsx` 静态导入**。
 *    spec 明写「该编辑器 SHALL 为懒加载资源，仅在用户进入编辑态时加载，纯浏览路径不加载
 *    编辑器资源」——此前 `main.tsx` 的副作用导入会把整个 monaco 核心（~8MB）打进主 bundle，
 *    纯浏览也会加载它。现在唯一的加载入口是 `ensureMonaco()`，由 `<MonacoCodeEditor>` /
 *    `<MonacoDiffEditor>` 在**首次渲染时**调用，故纯浏览路径（概览/步骤阅读、不点"在此重跑"）
 *    不会触发本模块的动态导入。
 *
 * 幂等：并发/多次调用共享同一个进行中的 Promise，避免重复装配 worker 与 loader。
 *
 * 注：monaco-editor@0.56 的 package exports 把 `esm/vs/` 目录映射为包根直接子路径，
 * 故深层入口写 `monaco-editor/editor/editor.api` 而非 `monaco-editor/esm/vs/...`。
 */

/** 已装配的 monaco 实例类型（延迟到装配时才需要，避免本模块静态依赖 monaco 包） */
export interface MonacoApi {
  readonly [key: string]: unknown;
}

let pending: Promise<MonacoApi> | null = null;

/**
 * 装配并返回 monaco 实例（幂等）。
 *
 * 全部 monaco 相关 import 都在**函数体内**动态进行 ⇒ 本模块被静态引入也不会把 monaco
 * 打进调用方 chunk。`loader.config` 只配置一次（`pending` 守卫）。
 */
export function ensureMonaco(): Promise<MonacoApi> {
  if (pending !== null) return pending;

  pending = (async () => {
    const [{ loader }, monaco] = await Promise.all([
      import("@monaco-editor/react"),
      (async () => {
        const api = await import("monaco-editor/editor/editor.api");
        // 全部编辑器特性（folding / find / suggest 等），不含任何语言定义。
        // 不导入 editor.main 或包根：那会连带全部语言定义与 css/html/typescript worker。
        await import("monaco-editor/features/register.all");
        // JSON 语言贡献：高亮 + 诊断，经 json.worker 提供（产品唯一需要的富语言）。
        // plaintext 是 editor 核心内建语言，不需要 basic-languages 聚合入口。
        await import("monaco-editor/language/json/monaco.contribution");
        const [{ default: EditorWorker }, { default: JsonWorker }] = await Promise.all([
          import("monaco-editor/editor/editor.worker?worker"),
          import("monaco-editor/language/json/json.worker?worker"),
        ]);
        globalThis.MonacoEnvironment = {
          getWorker(_workerId: string, label: string): Worker {
            return label === "json" ? new JsonWorker() : new EditorWorker();
          },
        };
        return api;
      })(),
    ]);

    loader.config({ monaco });
    return monaco as MonacoApi;
  })();

  return pending;
}

/** 仅测试用：重置幂等状态（生产路径不得调用） */
export function __resetMonacoForTest(): void {
  pending = null;
}
