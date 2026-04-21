import type { AuthFailure } from "../auth/failure.js";
import type { Artifact, Job, RepoCoordinates, RepoKey, Workflow, WorkflowRun } from "../domain/types.js";
import type { SecretsSnapshot } from "./secrets-snapshot.js";

export type StoreStatus = "idle" | "loading" | "ready" | "error" | "unauthenticated" | "no-repo";

/**
 * Everything we hold per GitHub repository tracked in the workspace. Each
 * key in `StoreSnapshot.repos` maps to one of these.
 *
 * Keyed sub-maps (`runsByWorkflowId`, `jobsByRunId`, `artifactsByRunId`)
 * follow the same pattern we used before the multi-repo refactor, just
 * scoped to this one repo.
 */
export interface PerRepoState {
  readonly repo: RepoCoordinates;
  readonly branch: string | null;
  readonly workflows: readonly Workflow[];
  readonly runsByWorkflowId: ReadonlyMap<number, readonly WorkflowRun[]>;
  readonly jobsByRunId: ReadonlyMap<number, readonly Job[]>;
  readonly artifactsByRunId: ReadonlyMap<number, readonly Artifact[]>;
  /** Per-repo error — one repo's 404 shouldn't blank the others. */
  readonly errorMessage: string | null;
  readonly lastUpdated: Date | null;
}

export function emptyPerRepoState(repo: RepoCoordinates, branch: string | null): PerRepoState {
  return {
    repo,
    branch,
    workflows: [],
    runsByWorkflowId: new Map(),
    jobsByRunId: new Map(),
    artifactsByRunId: new Map(),
    errorMessage: null,
    lastUpdated: null,
  };
}

/**
 * The single read-only shape exposed by WorkflowStore to every consumer.
 *
 * Multi-repo: the workspace may contain several GitHub repositories at once
 * (multi-root workspaces with microservice-style layouts are the classic
 * case). Each one lives in `repos` under its `repoKey(coords)`.
 *
 * The global fields (status, authFailure, errorMessage) describe the
 * auth/connection layer, not any one repo. Per-repo errors live on
 * `PerRepoState.errorMessage`.
 */
export interface StoreSnapshot {
  readonly status: StoreStatus;
  readonly repos: ReadonlyMap<RepoKey, PerRepoState>;
  /** Settings data (secrets/variables/environments) keyed by the same RepoKey. */
  readonly secretsByRepo: ReadonlyMap<RepoKey, SecretsSnapshot>;
  readonly errorMessage: string | null;
  readonly authFailure: AuthFailure | null;
  readonly lastUpdated: Date | null;
}
