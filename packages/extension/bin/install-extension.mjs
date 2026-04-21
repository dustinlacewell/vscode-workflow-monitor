#!/usr/bin/env node
/**
 * Build, package, and install the extension into the local VS Code.
 * Run via: `pnpm install:ext` (or `npm run install:ext`).
 *
 * Requires the VS Code CLI (`code`) on PATH. In VS Code:
 *   Cmd/Ctrl-Shift-P → "Shell Command: Install 'code' command in PATH".
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { packageExtension } from "./package-extension.mjs";

const vsixPath = packageExtension();
const cli = resolveCodeCli();

// Node >=18.20.2 / 20.12.2 / 22.0.0 rejects .cmd/.bat in execFile without shell: true
// (CVE-2024-27980 mitigation). On Windows the resolved CLI is typically code.cmd.
const needsShell = /\.(cmd|bat)$/i.test(cli);

try {
  process.stdout.write(`\n> ${cli} --install-extension "${vsixPath}" --force\n`);
  if (needsShell) {
    execSync(`"${cli}" --install-extension "${vsixPath}" --force`, { stdio: "inherit" });
  } else {
    execFileSync(cli, ["--install-extension", vsixPath, "--force"], { stdio: "inherit" });
  }
} catch {
  process.stderr.write(`\nFailed to run the VS Code CLI.\n`);
  process.stderr.write(`The built package is at: ${vsixPath}\n`);
  process.exit(1);
}

process.stdout.write(`\nInstalled ${vsixPath}\n`);

/**
 * On Windows, bare `code` on PATH often resolves to `Code.exe` (the GUI
 * launcher) instead of the CLI — `--install-extension` is silently rejected.
 * Prefer `code.cmd` from the same install directory, falling back to PATH.
 */
function resolveCodeCli() {
  if (process.platform !== "win32") return "code";
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const cmd = join(dir, "code.cmd");
    if (existsSync(cmd)) return cmd;
    // VS Code's bin dir sits next to the exe; if the exe is on PATH, look beside it.
    const exeBin = join(dir, "bin", "code.cmd");
    if (existsSync(exeBin)) return exeBin;
  }
  try {
    const where = execSync("where code.cmd", { stdio: ["ignore", "pipe", "ignore"] })
      .toString().split(/\r?\n/).find((l) => l.trim().length > 0);
    if (where) return where.trim();
  } catch { /* fall through */ }
  return "code";
}
