import type { Artifact, RepoKey, WorkflowRun } from "../domain/types.js";
import type { PerRepoState, StoreSnapshot } from "../store/snapshot.js";

/**
 * View-model for the artifacts attached to a single run. Kind-tagged so the
 * tree can render three distinct states — not-yet-fetched vs. fetched-empty
 * vs. fetched-with-items — without smuggling a magic sentinel.
 */
export type RunArtifactsView =
  | { kind: "hidden" } // run is still in-flight — don't advertise artifacts yet
  | { kind: "loading" } // run completed, fetch in progress
  | { kind: "empty" } // fetch completed, no artifacts produced
  | { kind: "artifacts"; items: readonly Artifact[] };

export function selectRunArtifacts(per: PerRepoState, runId: number): RunArtifactsView {
  const run = findRun(per, runId);
  if (!run || run.status !== "completed") return { kind: "hidden" };
  const items = per.artifactsByRunId.get(runId);
  if (!items) return { kind: "loading" };
  if (items.length === 0) return { kind: "empty" };
  return { kind: "artifacts", items: sortArtifacts(items) };
}

/**
 * All completed runs in a single repo that haven't had their artifact
 * metadata fetched yet. Used by LiveSync to decide which runs still need
 * a `listArtifacts` call.
 */
export function selectRepoRunsMissingArtifacts(snap: StoreSnapshot, key: RepoKey): readonly number[] {
  const per = snap.repos.get(key);
  if (!per) return [];
  const missing: number[] = [];
  for (const runs of per.runsByWorkflowId.values()) {
    for (const run of runs) {
      if (run.status !== "completed") continue;
      if (!per.artifactsByRunId.has(run.id)) missing.push(run.id);
    }
  }
  return missing;
}

function findRun(per: PerRepoState, runId: number): WorkflowRun | null {
  for (const runs of per.runsByWorkflowId.values()) {
    const hit = runs.find((r) => r.id === runId);
    if (hit) return hit;
  }
  return null;
}

function sortArtifacts(items: readonly Artifact[]): readonly Artifact[] {
  return [...items].sort((a, b) => {
    const ta = Date.parse(a.createdAt);
    const tb = Date.parse(b.createdAt);
    if (ta !== tb) return tb - ta;
    return a.name.localeCompare(b.name);
  });
}
