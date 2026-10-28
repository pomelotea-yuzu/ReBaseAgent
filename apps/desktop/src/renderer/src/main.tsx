import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { I18nProvider } from "./i18n";
import { applyHtmlLang } from "./lib/html-lang";
import { useAppStore } from "./store";
import "./index.css";
// ⚠️ Monaco **不在此静态装配**（U1 任务 5.6）：编辑器资源必须懒加载，
// 只在用户进入编辑态时经 `<MonacoCodeEditor>` 触发 `ensureMonaco()`。
// 在此 `import "./monaco-bootstrap"` 会把 ~8MB 编辑器核心打进主 bundle，
// 纯浏览路径也会加载它——违反 spec「仅在用户进入编辑态时加载编辑器资源」。

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("未找到 #root 挂载点");
}
const mountElement: HTMLElement = rootElement;

function Root() {
  const locale = useAppStore((s) => s.effectiveLocale);
  useEffect(() => {
    applyHtmlLang(document.documentElement, locale);
  }, [locale]);
  // locale 不挂在 key 上：切语言只刷新订阅者，不重建编辑器/工作区/焦点。
  return (
    <I18nProvider locale={locale}>
      <App />
    </I18nProvider>
  );
}

async function bootstrap(): Promise<void> {
  // 业务视图挂载前先取语言偏好：避免先按旧语言渲染再闪换。
  // IPC 异常时最多等 1.5s 后按 fallback 渲染；未完成的读取仍会在 store 里更新。
  await Promise.race([
    useAppStore.getState().loadUiPreferences(),
    new Promise<void>((resolve) => setTimeout(resolve, 1500)),
  ]);
  createRoot(mountElement).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}

void bootstrap();
