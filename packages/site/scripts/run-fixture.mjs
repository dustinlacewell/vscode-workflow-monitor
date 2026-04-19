// Bundles + runs scripts/build-fixture.ts in one shot, sidestepping the fact
// that the extension package is authored as CommonJS-flavoured ESM sources.
// We just let esbuild resolve `.js` ↔ `.ts` the way the extension's own build
// does, emit a throwaway bundle, and execute it.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "site-fixture-"));
const outfile = join(dir, "run.mjs");

await build({
  entryPoints: ["scripts/build-fixture.ts"],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  logLevel: "warning",
});

const result = spawnSync(process.execPath, [outfile], { stdio: "inherit" });
rmSync(dir, { recursive: true, force: true });
process.exit(result.status ?? 0);
