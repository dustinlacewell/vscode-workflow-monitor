import type { AuthFailure } from "../auth/failure.js";
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
  /**
   * Structured detail about the last auth-related or API failure — the thing
   * the banner in the sidebar renders. Separate from errorMessage because we
   * want to keep the structure (scopes, headers, route) around for a details
   * view even after the status transitions back to "ready" briefly.
   */
  readonly authFailure: AuthFailure | null;
  readonly lastUpdated: Date | null;
}
