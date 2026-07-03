import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");

async function buildEntry({ input, outDir, fileName, format }) {
  await build({
    root: rootDir,
    configFile: false,
    logLevel: "warn",
    build: {
      outDir: path.join("dist", outDir),
      emptyOutDir: false,
      minify: false,
      rollupOptions: {
        input: path.join(rootDir, input),
        output: {
          entryFileNames: fileName,
          format,
          inlineDynamicImports: true,
        },
      },
    },
  });
}

async function main() {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  await buildEntry({
    input: "src/background/service-worker.ts",
    outDir: "background",
    fileName: "service-worker.js",
    format: "es",
  });

  // MV3 declarative content_scripts run as classic scripts, so both content
  // entries must be self-contained IIFEs (no ES `import`/`export`).
  await buildEntry({
    input: "src/content/content-script.ts",
    outDir: "content",
    fileName: "content-script.js",
    format: "iife",
  });

  await buildEntry({
    input: "src/content/injected.ts",
    outDir: "content",
    fileName: "injected.js",
    format: "iife",
  });

  await cp(path.join(rootDir, "manifest.json"), path.join(distDir, "manifest.json"));

  const publicDir = path.join(rootDir, "public");
  if (existsSync(publicDir)) {
    await cp(publicDir, distDir, { recursive: true });
  }

  console.log("Build complete -> dist/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
