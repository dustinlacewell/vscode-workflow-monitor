/**
 * Turns the raw GitHub Actions fixtures in packages/site/fixtures/ into a
 * processed `LogSnapshot` JSON that the preview page feeds into the real
 * webview bundle — same parse+enrich pipeline the extension uses at
 * runtime, so what ships on the site is a faithful reproduction.
 *
 * Input:  fixtures/{workflow,run,job.raw,log}.(json|txt)
 * Output: public/preview/snapshot.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RunConclusion, RunStatus, Step } from "../../extension/src/core/domain/types.js";
import { stripTimestamps } from "../../extension/src/util/ansi.js";
import { parseLog } from "../../extension/src/util/log-parser.js";
import { enrichSections } from "../../extension/src/util/log-sections.js";
import type { HeaderModel, LogSnapshot } from "../../extension/src/webview/protocol.js";

interface RawStep {
  readonly number: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
}

interface RawJob {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly steps: RawStep[];
}

interface RawRun {
  readonly number: number;
  readonly headBranch: string;
  readonly headSha: string;
  readonly url: string;
}

interface RawWorkflow { readonly name: string }

// Paths are resolved from the site package root (CWD is the site when
// invoked via `pnpm --filter site`).
const fixturesDir = join(process.cwd(), "fixtures");
const outDir = join(process.cwd(), "src", "data");

const rawLog = readFileSync(join(fixturesDir, "log.txt"), "utf8");
const job = readJson<RawJob>(join(fixturesDir, "job.raw.json"));
const run = readJson<RawRun>(join(fixturesDir, "run.json"));
const workflow = readJson<RawWorkflow>(join(fixturesDir, "workflow.json"));

const steps: Step[] = job.steps.map((s) => ({
  number: s.number,
  name: s.name,
  status: s.status as RunStatus,
  conclusion: (s.conclusion ?? null) as RunConclusion,
  startedAt: s.started_at,
  completedAt: s.completed_at,
}));

const parsed = parseLog(stripTimestamps(rawLog));
const enriched = enrichSections(parsed, steps, job.status as RunStatus);

const header: HeaderModel = {
  ownerRepo: "dustinlacewell/vscode-workflow-monitor",
  workflowName: workflow.name,
  runNumber: run.number,
  jobName: job.name,
  jobStatus: job.status,
  jobConclusion: job.conclusion,
  branch: run.headBranch || null,
  sha: (run.headSha || "").slice(0, 7),
  htmlUrl: run.url,
  actor: null,
};

const snapshot: LogSnapshot = {
  header,
  sections: enriched,
  isTailing: false,
  generation: 1,
};

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "snapshot.json"), JSON.stringify(snapshot));
console.log(`wrote ${enriched.length} sections → ${join(outDir, "snapshot.json")}`);

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
