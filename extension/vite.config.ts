import { defineConfig } from "vite";

// The production bundle is produced by scripts/build.mjs via three separate
// Vite JS-API builds (one ES module for the service worker, two IIFEs for
// the content scripts) rather than a single `vite build` here, because MV3
// content scripts must ship as classic scripts and can't share an output
// format/pass with the ES-module service worker without a plugin like
// @crxjs/vite-plugin. This file exists so Vitest (which auto-loads
// vite.config.ts) picks up shared test config.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
