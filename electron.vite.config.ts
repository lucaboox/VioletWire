import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: "dist-electron/main" },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: "dist-electron/preload", rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react()],
    build: {
      outDir: path.join(projectRoot, "dist", "renderer").replaceAll("\\", "/"),
      rollupOptions: {
        input: {
          main: path.join(projectRoot, "src/renderer/index.html"),
          controls: path.join(projectRoot, "src/renderer/controls.html"),
        },
      },
    },
  },
});
