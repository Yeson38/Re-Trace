import { defineConfig } from "vite";

// Relative base so the built player also works under GitHub Pages subpaths.
export default defineConfig({
  base: "./",
  server: {
    host: true,
    port: 5173,
  },
});
