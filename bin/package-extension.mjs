#!/usr/bin/env node
/**
 * Build and package the extension into a .vsix (no install).
 * Shared by `pnpm package` and `pnpm install:ext`.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const vsixPath = packageExtension();
  process.stdout.write(`\nPackaged: ${vsixPath}\n`);
}
