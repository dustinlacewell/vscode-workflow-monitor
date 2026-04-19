#!/usr/bin/env node
/**
 * Build and package the extension into a .vsix (no install).
 * Shared by `pnpm package` and `pnpm install:ext`.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outDir = join(root, ".build");
const isWindows = process.platform === "win32";

function quote(s) { return /[\s"']/.test(s) ? `"${s.replaceAll('"', '\\"')}"` : s; }

function run(cmd, args) {
  const line = [cmd, ...args].map(quote).join(" ");
  process.stdout.write(`\n> ${line}\n`);
  execSync(line, { stdio: "inherit", cwd: root });
}

function pkgBin(name) {
  const bin = join(root, "node_modules", ".bin", isWindows ? `${name}.cmd` : name);
  return existsSync(bin) ? bin : name;
}

export function packageExtension() {
  run("node", ["esbuild.mjs", "--production"]);
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(outDir)) if (f.endsWith(".vsix")) rmSync(join(outDir, f));
  run(pkgBin("vsce"), ["package", "--no-dependencies", "--out", outDir]);
  const vsix = readdirSync(outDir).find((f) => f.endsWith(".vsix"));
  if (!vsix) throw new Error("vsce produced no .vsix file");
  return join(outDir, vsix);
}

// Run packaging when this file is invoked directly (as `node bin/package-extension.mjs`
// or via `npm run package`). Comparing `import.meta.url` to a URL derived from
// `process.argv[1]` is fragile across path normalisations — a suffix match on
// the script name is both simpler and robust. When install-extension.mjs
// imports this module, process.argv[1] ends with install-extension.mjs, so
// packaging does not auto-run at import time.
const invokedDirectly = /[/\\]package-extension\.mjs$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  const vsixPath = packageExtension();
  process.stdout.write(`\nPackaged: ${vsixPath}\n`);
}
