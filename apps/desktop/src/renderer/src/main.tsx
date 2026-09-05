import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Monaco 离线自托管：显式指向本地打包的 monaco，避免 @monaco-editor/react 默认从 CDN 拉取
// （本地优先、数据不出机器；无网可编辑）。需在任何 <Editor> 渲染前配置一次。
loader.config({ monaco });

const container = document.getElementById("root");
if (container === null) {
  throw new Error("未找到 #root 挂载点");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
