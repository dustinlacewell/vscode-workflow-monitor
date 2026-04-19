#!/usr/bin/env node
/**
 * Build, package, and install the extension into the local VS Code.
 * Run via: `pnpm install:ext` (or `npm run install:ext`).
 *
 * Requires the VS Code CLI (`code`) on PATH. In VS Code:
 *   Cmd/Ctrl-Shift-P → "Shell Command: Install 'code' command in PATH".
 */
import { execSync } from "node:child_process";
import { packageExtension } from "./package-extension.mjs";

const vsixPath = packageExtension();
const cmd = `code --install-extension "${vsixPath}" --force`;

try {
  process.stdout.write(`\n> ${cmd}\n`);
  execSync(cmd, { stdio: "inherit" });
} catch {
  process.stderr.write(`\nFailed to run 'code --install-extension'. Ensure the VS Code CLI is on PATH.\n`);
  process.stderr.write(`The built package is at: ${vsixPath}\n`);
  process.exit(1);
}

process.stdout.write(`\nInstalled ${vsixPath}\n`);
