import * as vscode from "vscode";
import type { AuthFailure } from "../core/auth/failure.js";
import type { Environment, Secret, SecretScope, Variable } from "../core/domain/secrets.js";
import { scopeKey } from "../core/domain/secrets.js";
import type {
  Artifact,
  Job,
  JobContext,
  RepoCoordinates,
  RepoKey,
  Workflow,
  WorkflowRun,
} from "../core/domain/types.js";
import { isActiveStatus, repoKey, sameRepo } from "../core/domain/types.js";
import { EMPTY_SECRETS_SNAPSHOT, type SecretsSnapshot, type SecretsStatus } from "../core/store/secrets-snapshot.js";
import { emptyPerRepoState, type PerRepoState, type StoreSnapshot, type StoreStatus } from "../core/store/snapshot.js";

export type { PerRepoState, StoreSnapshot, StoreStatus };

/**
 * Single source of truth for the sidebar's domain data.
 *
 * Multi-repo-aware: every mutation takes a `RepoKey` so the right per-repo
 * sub-state is updated. Callers stay in the domain by passing
 * `RepoCoordinates` where convenient — the store derives the key internally.
 *
 * Kept deliberately passive — it does not fetch. LiveSync / SecretSync push
 * updates in; the UI subscribes to `onDidChange` and reads `snapshot()`.
 */
export class WorkflowStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<StoreSnapshot>();
  private snap: StoreSnapshot = {
    status: "idle",
    repos: new Map(),
    secretsByRepo: new Map(),
    errorMessage: null,
    authFailure: null,
    lastUpdated: null,
  };

  readonly onDidChange = this.emitter.event;

  snapshot(): StoreSnapshot { return this.snap; }

  hasActiveRuns(): boolean {
    for (const per of this.snap.repos.values()) {
      for (const runs of per.runsByWorkflowId.values()) {
        if (runs.some((r) => isActiveStatus(r.status))) return true;
      }
    }
    return false;
  }

  /** Find a job across any repo's cached runs, returning its owning run + workflow name. */
  resolveJob(key: RepoKey, runId: number, jobId: number): JobContext | null {
    const per = this.snap.repos.get(key);
    if (!per) return null;
    for (const [workflowId, runs] of per.runsByWorkflowId) {
      const run = runs.find((r) => r.id === runId);
      if (!run) continue;
      const jobs = per.jobsByRunId.get(runId);
      const job = jobs?.find((j) => j.id === jobId) ?? null;
      if (!job) return null;
      const workflow = per.workflows.find((w) => w.id === workflowId);
      return { run, workflowName: workflow?.name ?? "Unknown workflow", job };
    }
    return null;
  }

  // --- status + auth (global) ---------------------------------------------

  setStatus(status: StoreStatus, errorMessage: string | null = null): void {
    this.update({ status, errorMessage });
  }

  setAuthFailure(failure: AuthFailure | null): void {
    this.update({ authFailure: failure });
  }

  // --- repo lifecycle -----------------------------------------------------

  /**
   * Replace the set of tracked repos. Any repo not in `next` is dropped from
   * both the workflows data and the settings data. New repos get fresh empty
   * PerRepoState entries.
   */
  setRepos(next: ReadonlyArray<{ coords: RepoCoordinates; branch: string | null }>): void {
    const repos = new Map<RepoKey, PerRepoState>();
    const secretsByRepo = new Map<RepoKey, SecretsSnapshot>();
    for (const { coords, branch } of next) {
      const key = repoKey(coords);
      const existing = this.snap.repos.get(key);
      if (existing && sameRepo(existing.repo, coords)) {
        repos.set(key, { ...existing, branch });
      } else {
        repos.set(key, emptyPerRepoState(coords, branch));
      }
      const existingSecrets = this.snap.secretsByRepo.get(key);
      secretsByRepo.set(key, existingSecrets ?? EMPTY_SECRETS_SNAPSHOT);
    }
    // Only reset status if the set of tracked repos meaningfully shifted.
    const changed = !sameKeySet(this.snap.repos, repos);
    const status: StoreStatus = next.length === 0
      ? "no-repo"
      : changed && this.snap.status !== "unauthenticated" && this.snap.status !== "error"
        ? "loading"
        : this.snap.status;
    this.update({
      repos,
      secretsByRepo,
      status,
      errorMessage: null,
      authFailure: null,
    });
  }

  // --- per-repo workflow data --------------------------------------------

  setWorkflows(key: RepoKey, workflows: readonly Workflow[]): void {
    this.patchRepo(key, (per) => ({ ...per, workflows, errorMessage: null, lastUpdated: new Date() }));
    this.update({ status: "ready", errorMessage: null, authFailure: null });
  }

  setRuns(key: RepoKey, workflowId: number, runs: readonly WorkflowRun[]): void {
    this.patchRepo(key, (per) => {
      const nextMap = new Map(per.runsByWorkflowId);
      nextMap.set(workflowId, runs);
      return { ...per, runsByWorkflowId: nextMap, lastUpdated: new Date() };
    });
  }

  setJobs(key: RepoKey, runId: number, jobs: readonly Job[]): void {
    this.patchRepo(key, (per) => {
      const nextMap = new Map(per.jobsByRunId);
      nextMap.set(runId, jobs);
      return { ...per, jobsByRunId: nextMap, lastUpdated: new Date() };
    });
  }

  setArtifacts(key: RepoKey, runId: number, artifacts: readonly Artifact[]): void {
    this.patchRepo(key, (per) => {
      const nextMap = new Map(per.artifactsByRunId);
      nextMap.set(runId, artifacts);
      return { ...per, artifactsByRunId: nextMap, lastUpdated: new Date() };
    });
  }

  setRepoError(key: RepoKey, errorMessage: string | null): void {
    this.patchRepo(key, (per) => ({ ...per, errorMessage }));
  }

  pruneJobs(key: RepoKey, liveRunIds: ReadonlySet<number>): void {
    this.patchRepo(key, (per) => {
      let changed = false;
      const nextMap = new Map(per.jobsByRunId);
      for (const id of nextMap.keys()) {
        if (!liveRunIds.has(id)) { nextMap.delete(id); changed = true; }
      }
      return changed ? { ...per, jobsByRunId: nextMap } : per;
    });
  }

  pruneArtifacts(key: RepoKey, liveRunIds: ReadonlySet<number>): void {
    this.patchRepo(key, (per) => {
      let changed = false;
      const nextMap = new Map(per.artifactsByRunId);
      for (const id of nextMap.keys()) {
        if (!liveRunIds.has(id)) { nextMap.delete(id); changed = true; }
      }
      return changed ? { ...per, artifactsByRunId: nextMap } : per;
    });
  }

  // --- settings (per-repo) ------------------------------------------------

  setSecretsStatus(key: RepoKey, status: SecretsStatus, errorMessage: string | null = null): void {
    this.patchSecrets(key, (s) => ({ ...s, status, errorMessage }));
  }

  setEnvironments(key: RepoKey, environments: readonly Environment[]): void {
    this.patchSecrets(key, (s) => ({
      ...s,
      environments,
      status: "ready",
      errorMessage: null,
      lastUpdated: new Date(),
    }));
  }

  setSecrets(key: RepoKey, scope: SecretScope, secrets: readonly Secret[]): void {
    this.patchSecrets(key, (s) => {
      const next = new Map(s.secretsByScope);
      next.set(scopeKey(scope), secrets);
      return { ...s, secretsByScope: next, status: "ready", errorMessage: null, lastUpdated: new Date() };
    });
  }

  setVariables(key: RepoKey, scope: SecretScope, variables: readonly Variable[]): void {
    this.patchSecrets(key, (s) => {
      const next = new Map(s.variablesByScope);
      next.set(scopeKey(scope), variables);
      return { ...s, variablesByScope: next, status: "ready", errorMessage: null, lastUpdated: new Date() };
    });
  }

  getSecretsSnapshot(key: RepoKey): SecretsSnapshot {
    return this.snap.secretsByRepo.get(key) ?? EMPTY_SECRETS_SNAPSHOT;
  }

  // --- internals ----------------------------------------------------------

  private patchRepo(key: RepoKey, fn: (per: PerRepoState) => PerRepoState): void {
    const prev = this.snap.repos.get(key);
    if (!prev) return; // ignore writes for a repo we're not tracking
    const next = fn(prev);
    if (next === prev) return;
    const repos = new Map(this.snap.repos);
    repos.set(key, next);
    this.update({ repos });
  }

  private patchSecrets(key: RepoKey, fn: (s: SecretsSnapshot) => SecretsSnapshot): void {
    const prev = this.snap.secretsByRepo.get(key) ?? EMPTY_SECRETS_SNAPSHOT;
    const next = fn(prev);
    if (next === prev) return;
    const secretsByRepo = new Map(this.snap.secretsByRepo);
    secretsByRepo.set(key, next);
    this.update({ secretsByRepo });
  }

  private update(patch: Partial<StoreSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.emitter.fire(this.snap);
  }

  dispose(): void { this.emitter.dispose(); }
}

function sameKeySet<K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a.keys()) if (!b.has(k)) return false;
  return true;
}
