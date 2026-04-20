import type { Job, RepoCoordinates, Workflow, WorkflowRun } from "../domain/types.js";

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
  readonly errorMessage: string | null;
  readonly lastUpdated: Date | null;
}
