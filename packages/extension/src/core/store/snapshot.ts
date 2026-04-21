import type { AuthFailure } from "../auth/failure.js";
import type { Artifact, Job, RepoCoordinates, Workflow, WorkflowRun } from "../domain/types.js";
import type { SecretsSnapshot } from "./secrets-snapshot.js";

export type StoreStatus = "idle" | "loading" | "ready" | "error" | "unauthenticated" | "no-repo";

/**
 * The single read-only shape exposed by WorkflowStore to every consumer.
 *
 * Kept in core/ (no vscode/octokit) so selectors and tests can work against
 * plain objects without spinning up the Extension Host.
 */
export interface StoreSnapshot {
  readonly status: StoreStatus;
  readonly repo: RepoCoordinates | null;
  readonly branch: string | null;
  readonly workflows: readonly Workflow[];
  readonly runsByWorkflowId: ReadonlyMap<number, readonly WorkflowRun[]>;
  readonly jobsByRunId: ReadonlyMap<number, readonly Job[]>;
  /**
   * Artifacts fetched for a given run. Absence (no entry) means "not yet
   * fetched" — distinct from an empty array which means "fetched, none
   * exist". The selector layer uses that distinction to render a loading
   * state vs. an empty state.
   */
  readonly artifactsByRunId: ReadonlyMap<number, readonly Artifact[]>;
  readonly errorMessage: string | null;
  /**
   * Structured detail about the last auth-related or API failure — the thing
   * the banner in the sidebar renders. Separate from errorMessage because we
   * want to keep the structure (scopes, headers, route) around for a details
   * view even after the status transitions back to "ready" briefly.
   */
  readonly authFailure: AuthFailure | null;
  /**
   * Secrets + environments state. Co-located on the snapshot so the tree
   * providers subscribe to a single onDidChange, but its `status` field is
   * independent of the workflows status — secrets fetch lifecycle is
   * on-demand, not tied to the polling cycle.
   */
  readonly secrets: SecretsSnapshot;
  readonly lastUpdated: Date | null;
}
