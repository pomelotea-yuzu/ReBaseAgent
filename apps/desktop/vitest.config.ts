import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  /**
   * 组件渲染用例（`react-dom/server` 的 renderToStaticMarkup）要求自动 JSX 运行时：
   * vitest 是 per-file 找最近的 **tsconfig.json** 取 jsx 设置，而本包只有
   * tsconfig.node.json / tsconfig.web.json（没有 tsconfig.json）⇒ esbuild 会退化成
   * 经典运行时（React.createElement）并报 "React is not defined"。
   * 与构建侧（tsconfig.web.json 的 react-jsx）显式对齐，别依赖隐式发现。
   */
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    // U7 4.12：比较工作区的静态断言用例含 JSX（renderToStaticMarkup 喂 props），
    // 放行 .test.tsx（esbuild.jsx 已配 automatic，扩展名决定 loader）
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "src/shared"),
    },
  },
});
