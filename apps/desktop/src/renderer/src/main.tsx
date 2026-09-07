import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
// Monaco 离线自托管（design D1）：显式 ESM 入口 + 按需 worker，避免全量打包与 CDN 依赖。
// 副作用导入即完成 loader 配置与 MonacoEnvironment 装配，须在任何 <Editor> 渲染前生效。
import "./monaco-bootstrap";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("未找到 #root 挂载点");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
