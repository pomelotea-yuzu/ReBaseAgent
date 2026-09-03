import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

/**
 * electron-vite 三段构建：main（Node 侧）/ preload（隔离桥）/ renderer（React）。
 * main 与 preload 的 node 依赖全部外置，不进 bundle。
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { "@shared": resolve("src/shared") },
    },
    build: {
      outDir: "dist/main",
      // CJS + .cjs：绕开 "electron 不提供具名导出" 的 ESM 互操作问题，
      // __dirname 也直接可用（package.json 的 main 字段同步指向 index.cjs）
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { "@shared": resolve("src/shared") },
    },
    build: {
      outDir: "dist/preload",
      // sandbox 下 Electron 只支持 CJS preload（package.json 是 type: module，
      // 默认会输出 .mjs，这里强制 CJS + .cjs 扩展名）
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { "@shared": resolve("src/shared") },
    },
    build: {
      outDir: "dist/renderer",
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") },
      },
    },
  },
});
