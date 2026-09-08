import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const shared = (p: string) => fileURLToPath(new URL(`../shared/${p}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  // 1.18 -- a static bundle, and a relative base so it works from a GitHub Pages subpath as
  // happily as from the desktop shell's file server.
  base: "./",
  resolve: {
    alias: [
      // 1.19 -- one copy of the core. The alias points at `shared/` in this repo rather than at a
      // published package, so an edit there is an edit here with no publish step in between.
      {
        find: /^@worklog\/shared\/(.*)$/,
        replacement: shared("$1.ts"),
      },
    ],
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5273,
  },
});
