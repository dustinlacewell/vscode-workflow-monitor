import * as vscode from "vscode";
import type { AuthFailure } from "../core/auth/failure.js";
import type { Job, JobContext, RepoCoordinates, Workflow, WorkflowRun } from "../core/domain/types.js";
import { isActiveStatus } from "../core/domain/types.js";
import type { StoreSnapshot, StoreStatus } from "../core/store/snapshot.js";

export type { StoreSnapshot, StoreStatus };

/**
 * Single source of truth for the sidebar's domain data.
 *
 * Kept deliberately passive — it does not fetch. The LiveSync service pushes
 * updates in; the UI subscribes to onDidChange and reads snapshot().
 */
export class WorkflowStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<StoreSnapshot>();
  private snap: StoreSnapshot = {
    status: "idle",
    repo: null,
    branch: null,
    workflows: [],
    runsByWorkflowId: new Map(),
    jobsByRunId: new Map(),
    errorMessage: null,
    authFailure: null,
    lastUpdated: null,
  };

  readonly onDidChange = this.emitter.event;

  snapshot(): StoreSnapshot { return this.snap; }

  hasActiveRuns(): boolean {
    for (const runs of this.snap.runsByWorkflowId.values()) {
      if (runs.some((r) => isActiveStatus(r.status))) return true;
    }
    return false;
  }

  /** Find a job across all cached runs + its owning run + workflow name. */
  resolveJob(runId: number, jobId: number): JobContext | null {
    for (const [workflowId, runs] of this.snap.runsByWorkflowId) {
      const run = runs.find((r) => r.id === runId);
      if (!run) continue;
      const jobs = this.snap.jobsByRunId.get(runId);
      const job = jobs?.find((j) => j.id === jobId) ?? null;
      if (!job) return null;
      const workflow = this.snap.workflows.find((w) => w.id === workflowId);
      return { run, workflowName: workflow?.name ?? "Unknown workflow", job };
    }
    return null;
  }

  resolveRun(runId: number): { run: WorkflowRun; workflowName: string } | null {
    for (const [workflowId, runs] of this.snap.runsByWorkflowId) {
      const run = runs.find((r) => r.id === runId);
      if (!run) continue;
      const workflow = this.snap.workflows.find((w) => w.id === workflowId);
      return { run, workflowName: workflow?.name ?? "Unknown workflow" };
    }
    return null;
  }


  setStatus(status: StoreStatus, errorMessage: string | null = null): void {
    this.update({ status, errorMessage });
  }

  setAuthFailure(failure: AuthFailure | null): void {
    this.update({ authFailure: failure });
  }

  setRepo(repo: RepoCoordinates | null, branch: string | null): void {
    if (
      this.snap.repo?.owner === repo?.owner &&
      this.snap.repo?.repo === repo?.repo &&
      this.snap.branch === branch
    ) return;
    this.update({
      repo,
      branch,
      workflows: [],
      runsByWorkflowId: new Map(),
      jobsByRunId: new Map(),
      status: repo ? "loading" : "no-repo",
      errorMessage: null,
      authFailure: null,
    });
  }

  setWorkflows(workflows: readonly Workflow[]): void {
    this.update({ workflows, status: "ready", errorMessage: null, authFailure: null, lastUpdated: new Date() });
  }

  setRuns(workflowId: number, runs: readonly WorkflowRun[]): void {
    const next = new Map(this.snap.runsByWorkflowId);
    next.set(workflowId, runs);
    this.update({ runsByWorkflowId: next, lastUpdated: new Date() });
  }

  setJobs(runId: number, jobs: readonly Job[]): void {
    const next = new Map(this.snap.jobsByRunId);
    next.set(runId, jobs);
    this.update({ jobsByRunId: next, lastUpdated: new Date() });
  }

  pruneJobs(liveRunIds: ReadonlySet<number>): void {
    let changed = false;
    const next = new Map(this.snap.jobsByRunId);
    for (const id of next.keys()) {
      if (!liveRunIds.has(id)) { next.delete(id); changed = true; }
    }
    if (changed) this.update({ jobsByRunId: next });
  }

  private update(patch: Partial<StoreSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.emitter.fire(this.snap);
  }

  dispose(): void { this.emitter.dispose(); }
}
