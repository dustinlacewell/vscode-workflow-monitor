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

export interface Step {
  readonly number: number;
  readonly name: string;
  readonly status: RunStatus;
  readonly conclusion: RunConclusion;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
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
  readonly steps: readonly Step[];
}

export function isActiveStatus(status: RunStatus): boolean {
  return status === "in_progress" || status === "queued" || status === "waiting" || status === "requested" || status === "pending";
}

/**
 * "Failed" for our purposes == the run/job/step reached a terminal state
 * that the user likely wants to investigate. Skipped/cancelled/neutral
 * aren't failures even though they're not successes.
 */
export function isFailureConclusion(conclusion: RunConclusion): boolean {
  return conclusion === "failure" || conclusion === "timed_out" || conclusion === "startup_failure";
}

export function hasFailed(item: { status: RunStatus; conclusion: RunConclusion }): boolean {
  return item.status === "completed" && isFailureConclusion(item.conclusion);
}

/**
 * A job projected with enough surrounding context (owning run, workflow
 * name) to be usable on its own — for log rendering, clipboard export,
 * deep-link URIs, etc. Returning this everywhere instead of bare jobs
 * keeps downstream code from having to re-walk the store every time.
 */
export interface JobContext {
  readonly run: WorkflowRun;
  readonly workflowName: string;
  readonly job: Job;
}

export interface Artifact {
  readonly id: number;
  readonly name: string;
  readonly sizeBytes: number;
  readonly expired: boolean;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly archiveDownloadUrl: string;
}

export type DispatchInputType = "string" | "choice" | "boolean" | "environment" | "number";

export interface DispatchInput {
  readonly name: string;
  readonly description: string | null;
  readonly required: boolean;
  readonly default: string | null;
  readonly type: DispatchInputType;
  readonly options: readonly string[] | null;
}

export interface WorkflowDispatchSpec {
  readonly supported: boolean;
  readonly inputs: readonly DispatchInput[];
}
