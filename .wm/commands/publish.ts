import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { cmd } from "@ldlework/workmark/define";
import { execAsyncRaw } from "@ldlework/workmark/helpers";
import { publishable } from "../traits/publishable.js";

type PackageMeta = { name: string; version: string };

function readPackage(dir: string): PackageMeta {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as PackageMeta;
}

async function pollForVersion(name: string, version: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const got = (await execAsyncRaw(`npm view ${name} version`, { cwd: process.cwd(), timeout: 10_000 })).trim();
      if (got === version) return true;
    } catch {
      // keep polling
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/** Publish a project according to its publishable trait. */
export default cmd({
  needs: [publishable],
  select: "one",
  flags: {
    otp: z.string().optional().describe("npm 2FA OTP code (required for npm-kind)"),
    dryRun: z.boolean().optional().describe("Run --dry-run without pushing"),
  },
  handler: async ({ otp, dryRun }, { project, traits, exec, ok, fail }) => {
    const kind = traits.publishable.kind;

    if (kind === "npm") {
      if (!otp) return fail("otp required for npm publish");
      const flags = ["--access public", `--otp=${otp}`, dryRun ? "--dry-run" : ""].filter(Boolean).join(" ");
      try {
        const output = await execAsyncRaw(`pnpm publish ${flags}`, { cwd: project.dir, timeout: 120_000 });
        if (dryRun) return ok(`[dry-run] ${output}`);
        const meta = readPackage(project.dir);
        const live = await pollForVersion(meta.name, meta.version, 30_000);
        return ok(`${output}\n${live ? `live: ${meta.name}@${meta.version}` : "published but not yet visible"}\nhttps://www.npmjs.com/package/${meta.name}/v/${meta.version}`);
      } catch (e) {
        return fail(e);
      }
    }

    if (kind === "vsce") {
      return exec(`npx @vscode/vsce publish --no-dependencies`, { cwd: project.dir, timeout: 180_000 });
    }

    // kind === "pages": nothing to do — CI handles it
    return ok(`${project.name}: pages projects are published by CI on push`);
  },
});
