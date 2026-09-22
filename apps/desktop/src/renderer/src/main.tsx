import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
// ⚠️ Monaco **不在此静态装配**（U1 任务 5.6）：编辑器资源必须懒加载，
// 只在用户进入编辑态时经 `<MonacoCodeEditor>` 触发 `ensureMonaco()`。
// 在此 `import "./monaco-bootstrap"` 会把 ~8MB 编辑器核心打进主 bundle，
// 纯浏览路径也会加载它——违反 spec「仅在用户进入编辑态时加载编辑器资源」。

const container = document.getElementById("root");
if (container === null) {
  throw new Error("未找到 #root 挂载点");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
