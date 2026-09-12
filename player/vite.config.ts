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
    // Wasmer JS SDK uses SharedArrayBuffer, which requires Cross-Origin
    // Isolation. These headers enable it for `npm run dev`.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
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
    // Wasmer SDK and other optional runtime deps are fetched from CDN via
    // dynamic import(); keep vite's pre-bundler from trying to resolve them.
    exclude: [],
  },
});
