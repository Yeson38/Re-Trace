import { defineConfig } from "vite";
// vite-plugin-monaco-editor is CJS; handle interop for ESM config
import _monacoPlugin from "vite-plugin-monaco-editor";

const monacoEditorPlugin =
  (_monacoPlugin as any).default ?? _monacoPlugin;

// Relative base so the built player also works under GitHub Pages subpaths.
export default defineConfig({
  base: "./",
  server: {
    host: true,
    port: 5173,
  },
  plugins: [
    monacoEditorPlugin({
      publicPath: "assets/monaco-workers/",
      languageWorkers: [
        "editorWorkerService",
        "css",
        "html",
        "json",
        "typescript",
      ],
    }),
  ] as any,
  optimizeDeps: {
    exclude: ["https://cdn.jsdelivr.net"],
  },
  build: {
    rollupOptions: {
      // Wasmer SDK packages are optional peer deps for browser C++ recording.
      // They're loaded at runtime; don't try to bundle them.
      external: ["@wasmer/wasi", "@wasmer/wasmfs"],
    },
  },
});
