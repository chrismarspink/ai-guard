import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");

// Build stamp: version comes from package.json (bump it with `npm run bump`),
// buildDate/buildId are generated fresh on every build so each build is
// traceable in chrome://extensions (via version_name) and dist/build-info.json.
const pkg = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const buildId =
  `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
  `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
const BUILD_INFO = { version: pkg.version, buildDate: now.toISOString(), buildId };

async function buildEntry({ input, outDir, fileName, format }) {
  await build({
    root: rootDir,
    configFile: false,
    logLevel: "warn",
    define: { __BUILD_INFO__: JSON.stringify(BUILD_INFO) },
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

  // Emit the manifest with the package version and a human-readable
  // version_name carrying the build date (shown in chrome://extensions), then
  // a machine-readable build-info.json alongside it.
  const manifest = JSON.parse(await readFile(path.join(rootDir, "manifest.json"), "utf8"));
  manifest.version = pkg.version;
  const humanDate = BUILD_INFO.buildDate.slice(0, 16).replace("T", " ");
  manifest.version_name = `${pkg.version} (built ${humanDate} UTC)`;
  await writeFile(path.join(distDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(path.join(distDir, "build-info.json"), JSON.stringify(BUILD_INFO, null, 2) + "\n");

  const publicDir = path.join(rootDir, "public");
  if (existsSync(publicDir)) {
    await cp(publicDir, distDir, { recursive: true });
  }

  console.log(`Build complete -> dist/  (v${pkg.version}, build ${BUILD_INFO.buildId})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
