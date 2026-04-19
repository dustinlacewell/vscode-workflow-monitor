import * as vscode from "vscode";
import type { Job, RepoCoordinates, Workflow, WorkflowRun } from "../domain/types.js";
import { isActiveStatus } from "../domain/types.js";

export type StoreStatus = "idle" | "loading" | "ready" | "error" | "unauthenticated" | "no-repo";

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

  setStatus(status: StoreStatus, errorMessage: string | null = null): void {
    this.update({ status, errorMessage });
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
    });
  }

  setWorkflows(workflows: readonly Workflow[]): void {
    this.update({ workflows, status: "ready", errorMessage: null, lastUpdated: new Date() });
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
