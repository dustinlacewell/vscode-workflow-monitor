/**
 * Pure domain types. No vscode / octokit imports live here so
 * the rest of the extension can depend on this module without
 * pulling runtime dependencies.
 */

export interface RepoCoordinates {
  readonly owner: string;
  readonly repo: string;
}

export type RunStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "waiting"
  | "requested"
  | "pending"
  | "unknown";

export type RunConclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "neutral"
  | "stale"
  | "startup_failure"
  | null;

export interface Workflow {
  readonly id: number;
  readonly name: string;
  readonly path: string;
  readonly state: "active" | "deleted" | "disabled_fork" | "disabled_inactivity" | "disabled_manually";
  readonly htmlUrl: string;
}

export interface WorkflowRun {
  readonly id: number;
  readonly workflowId: number;
  readonly runNumber: number;
  readonly name: string | null;
  readonly displayTitle: string;
  readonly status: RunStatus;
  readonly conclusion: RunConclusion;
  readonly event: string;
  readonly headBranch: string | null;
  readonly headSha: string;
  readonly actorLogin: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly runStartedAt: string | null;
  readonly htmlUrl: string;
}

export interface Job {
  readonly id: number;
  readonly runId: number;
  readonly name: string;
  readonly status: RunStatus;
  readonly conclusion: RunConclusion;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly htmlUrl: string;
}

export function isActiveStatus(status: RunStatus): boolean {
  return status === "in_progress" || status === "queued" || status === "waiting" || status === "requested" || status === "pending";
}
