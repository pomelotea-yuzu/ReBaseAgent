import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api";
// 全部编辑器特性（folding / find / suggest 等），不含任何语言定义。
// 不导入 editor.main 或包根：那会连带全部语言定义与 css/html/typescript worker。
import "monaco-editor/features/register.all";
// JSON 语言贡献：高亮 + 诊断，经 json.worker 提供（产品唯一需要的富语言）。
// plaintext 是 editor 核心内建语言，不需要 basic-languages 聚合入口。
import "monaco-editor/language/json/monaco.contribution";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";

/**
 * Monaco 按需装配（design D1）：
 * - 只打包 editor 核心、全部编辑器特性与 JSON 语言贡献；
 * - 只装配 editor.worker 与 json.worker，`json` label 走 JSON worker、其余回退 editor worker；
 * - 显式指向本地实例，禁止 @monaco-editor/react 默认从 CDN 拉取（离线可用）。
 * 需在任何 <Editor> 渲染前配置一次。
 *
 * 注：monaco-editor@0.56 的 package exports 把 `esm/vs/` 目录映射为包根直接子路径，
 * 故深层入口写 `monaco-editor/editor/editor.api` 而非 `monaco-editor/esm/vs/...`。
 */
globalThis.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === "json") {
      return new JsonWorker();
    }
    return new EditorWorker();
  },
};

loader.config({ monaco });

export { monaco };
