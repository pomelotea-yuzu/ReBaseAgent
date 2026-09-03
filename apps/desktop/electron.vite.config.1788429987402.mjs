// electron.vite.config.ts
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
var __electron_vite_injected_dirname = "D:\\ReBaseAgent\\apps\\desktop";
var electron_vite_config_default = defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { "@shared": resolve("src/shared") }
    },
    build: {
      outDir: "dist/main",
      rollupOptions: {
        input: { index: resolve(__electron_vite_injected_dirname, "src/main/index.ts") }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { "@shared": resolve("src/shared") }
    },
    build: {
      outDir: "dist/preload",
      // sandbox 下 Electron 只支持 CJS preload（package.json 是 type: module，
      // 默认会输出 .mjs，这里强制 CJS + .cjs 扩展名）
      rollupOptions: {
        input: { index: resolve(__electron_vite_injected_dirname, "src/preload/index.ts") },
        output: { format: "cjs", entryFileNames: "[name].cjs" }
      }
    }
  },
  renderer: {
    root: resolve(__electron_vite_injected_dirname, "src/renderer"),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { "@shared": resolve("src/shared") }
    },
    build: {
      outDir: "dist/renderer",
      rollupOptions: {
        input: { index: resolve(__electron_vite_injected_dirname, "src/renderer/index.html") }
      }
    }
  }
});
export {
  electron_vite_config_default as default
};
