import type { Artifact, WorkflowRun } from "../domain/types.js";
import type { StoreSnapshot } from "../store/snapshot.js";

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

export function selectRunArtifacts(snap: StoreSnapshot, runId: number): RunArtifactsView {
  const run = findRun(snap, runId);
  if (!run || run.status !== "completed") return { kind: "hidden" };
  const items = snap.artifactsByRunId.get(runId);
  if (!items) return { kind: "loading" };
  if (items.length === 0) return { kind: "empty" };
  return { kind: "artifacts", items: sortArtifacts(items) };
}

/**
 * Every completed run that we haven't yet pulled artifact metadata for. Used
 * by the sync loop to decide which runs need a `listArtifacts` call without
 * re-fetching on every cycle.
 *
 * Non-completed runs are excluded — the artifacts endpoint returns an empty
 * list for in-flight runs anyway, and we want the "hidden" UI state to be
 * honest about the fact that we haven't asked yet.
 */
export function selectRunsMissingArtifacts(snap: StoreSnapshot): readonly number[] {
  const missing: number[] = [];
  for (const runs of snap.runsByWorkflowId.values()) {
    for (const run of runs) {
      if (run.status !== "completed") continue;
      if (!snap.artifactsByRunId.has(run.id)) missing.push(run.id);
    }
  }
  return missing;
}

function findRun(snap: StoreSnapshot, runId: number): WorkflowRun | null {
  for (const runs of snap.runsByWorkflowId.values()) {
    const hit = runs.find((r) => r.id === runId);
    if (hit) return hit;
  }
  return null;
}

/**
 * Stable sort for display: most recently created first, name as tie-breaker
 * so the order is deterministic across fetches.
 */
function sortArtifacts(items: readonly Artifact[]): readonly Artifact[] {
  return [...items].sort((a, b) => {
    const ta = Date.parse(a.createdAt);
    const tb = Date.parse(b.createdAt);
    if (ta !== tb) return tb - ta;
    return a.name.localeCompare(b.name);
  });
}
