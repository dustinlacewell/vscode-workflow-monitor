import type { Job, Workflow, WorkflowRun } from "../domain/types.js";
import { isActiveStatus } from "../domain/types.js";
import type { StoreSnapshot } from "../store/snapshot.js";

export type BranchFilter = "all" | "current";

/**
 * Apply the current branch filter to a repo-wide run list. `null` branch means
 * we don't yet know which branch the working copy is on; the safe behavior
 * there is to show everything rather than hiding data silently.
 */
export function selectVisibleRuns(
  runs: readonly WorkflowRun[] | undefined,
  branch: string | null,
  branchFilter: BranchFilter,
): readonly WorkflowRun[] {
  if (!runs) return [];
  if (branchFilter === "all") return runs;
  if (!branch) return runs;
  return runs.filter((r) => r.headBranch === branch);
}

export interface WorkflowRow {
  readonly workflow: Workflow;
  readonly latestVisibleRun: WorkflowRun | null;
  readonly visibleRunCount: number;
}

export function selectWorkflowRows(snap: StoreSnapshot, branchFilter: BranchFilter): readonly WorkflowRow[] {
  return snap.workflows.map((wf) => {
    const visible = selectVisibleRuns(snap.runsByWorkflowId.get(wf.id), snap.branch, branchFilter);
    return {
      workflow: wf,
      latestVisibleRun: visible[0] ?? null,
      visibleRunCount: visible.length,
    };
  });
}

export type WorkflowRunsView =
  | { kind: "loading" }
  | { kind: "empty"; reason: "none" | "filtered"; branch: string | null }
  | { kind: "runs"; runs: readonly WorkflowRun[] };

export function selectWorkflowRuns(
  snap: StoreSnapshot,
  workflowId: number,
  branchFilter: BranchFilter,
): WorkflowRunsView {
  const runs = snap.runsByWorkflowId.get(workflowId);
  if (!runs) return { kind: "loading" };
  const visible = selectVisibleRuns(runs, snap.branch, branchFilter);
  if (visible.length > 0) return { kind: "runs", runs: visible };
  return {
    kind: "empty",
    reason: runs.length === 0 ? "none" : "filtered",
    branch: snap.branch,
  };
}

export type RunJobsView =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "jobs"; jobs: readonly Job[] };

export function selectInProgressRunCount(snap: StoreSnapshot): number {
  let count = 0;
  for (const runs of snap.runsByWorkflowId.values()) {
    for (const run of runs) if (isActiveStatus(run.status)) count++;
  }
  return count;
}

export function selectRunJobs(snap: StoreSnapshot, runId: number): RunJobsView {
  const jobs = snap.jobsByRunId.get(runId);
  if (!jobs) return { kind: "loading" };
  if (jobs.length === 0) return { kind: "empty" };
  return { kind: "jobs", jobs };
}
