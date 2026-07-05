// Bump the extension version in package.json AND manifest.json in sync.
// Usage: node scripts/bump.mjs [patch|minor|major]   (default: patch)
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kind = (process.argv[2] || "patch").toLowerCase();
if (!["patch", "minor", "major"].includes(kind)) {
  console.error(`unknown bump kind "${kind}" (use patch|minor|major)`);
  process.exit(1);
}

const pkgPath = path.join(rootDir, "package.json");
const manifestPath = path.join(rootDir, "manifest.json");
const pkg = JSON.parse(await readFile(pkgPath, "utf8"));

const [major, minor, patch] = pkg.version.split(".").map(Number);
const next =
  kind === "major" ? `${major + 1}.0.0`
  : kind === "minor" ? `${major}.${minor + 1}.0`
  : `${major}.${minor}.${patch + 1}`;

pkg.version = next;
await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.version = next;
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

console.log(`Bumped ${kind} -> ${next}  (package.json + manifest.json). Now run: npm run build`);
