import * as vscode from "vscode";
import type { GitHubApi } from "../data/github-api.js";
import { GitHubApiError } from "../data/github-api.js";
import type { RepoContext } from "../data/git-repo.js";
import { classifyAuthFailure, type AuthFailure } from "../core/auth/failure.js";
import type { RepoCoordinates, RepoKey } from "../core/domain/types.js";
import { isActiveStatus, repoKey } from "../core/domain/types.js";
import { selectRepoRunsMissingArtifacts } from "../core/selectors/artifacts.js";
import type { Logger } from "../util/logger.js";
import { AuthService } from "./auth.js";
import type { WorkflowStore } from "./workflow-store.js";

export interface LiveSyncConfig {
  activePollIntervalMs: number;
  idlePollIntervalMs: number;
  runsPerWorkflow: number;
}

export type ApiProvider = () => GitHubApi | null;

/**
 * Drives the WorkflowStore by polling the GitHub Actions REST API across
 * every repo in the workspace at an adaptive cadence:
 *   - fast interval when any repo has an active run
 *   - slow interval when everything has settled
 *
 * The loop is a single re-entrant async task guarded by an AbortController,
 * so restart() cleanly cancels an in-flight fetch and starts a new cycle
 * without overlap. Within a cycle each repo's sub-fetches run in parallel
 * with other repos, so total cycle time is ~max(per-repo fetch time), not
 * their sum.
 */
export class LiveSync implements vscode.Disposable {
  private repos: readonly RepoContext[] = [];
  private abort: AbortController | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private disposed = false;
  private cycleInFlight = false;
  private burstUntil = 0;

  constructor(
    private readonly apiProvider: ApiProvider,
    private readonly store: WorkflowStore,
    private readonly log: Logger,
    private config: LiveSyncConfig,
  ) {}

  updateConfig(next: LiveSyncConfig): void {
    this.config = next;
    if (this.running) this.scheduleNext(0);
  }

  setRepos(repos: readonly RepoContext[]): void {
    this.repos = repos;
    if (this.running) this.restart();
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.scheduleNext(0);
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
    this.abort?.abort();
    this.abort = null;
  }

  refresh(): void {
    if (!this.running || this.disposed) return;
    this.scheduleNext(0);
  }

  burst(durationMs: number): void {
    this.burstUntil = Date.now() + durationMs;
    if (this.running) this.scheduleNext(0);
  }

  private restart(): void {
    this.abort?.abort();
    this.abort = null;
    this.clearTimer();
    this.scheduleNext(0);
  }

  private scheduleNext(delayMs: number): void {
    this.clearTimer();
    if (!this.running || this.disposed) return;
    this.timer = setTimeout(() => { void this.runCycle(); }, delayMs);
  }

  private async runCycle(): Promise<void> {
    if (this.cycleInFlight || this.disposed) return;
    this.cycleInFlight = true;

    const client = this.apiProvider();
    if (!client) {
      this.cycleInFlight = false;
      this.store.setStatus("unauthenticated");
      return;
    }
    if (this.repos.length === 0) {
      this.cycleInFlight = false;
      this.store.setStatus("no-repo");
      return;
    }

    const ac = new AbortController();
    this.abort = ac;

    try {
      await Promise.all(this.repos.map((ctx) => this.syncOne(client, ctx, ac.signal)));
    } catch (err) {
      // syncOne isolates its own errors; anything thrown here is top-level.
      if (isAbort(err)) return;
      this.handleError(err);
    } finally {
      this.cycleInFlight = false;
      if (this.abort === ac) this.abort = null;
      this.scheduleNext(this.pickInterval());
    }
  }

  private async syncOne(client: GitHubApi, ctx: RepoContext, signal: AbortSignal): Promise<void> {
    const key = repoKey(ctx.coords);
    try {
      const workflows = await client.listWorkflows(ctx.coords, signal);
      if (signal.aborted) return;
      const activeWorkflows = workflows.filter((w) => w.state === "active");
      this.store.setWorkflows(key, activeWorkflows);

      const allRunIds = new Set<number>();
      const activeRunIds = new Set<number>();

      for (const wf of activeWorkflows) {
        if (signal.aborted) return;
        const runs = await client.listRecentRuns(ctx.coords, wf.id, this.config.runsPerWorkflow, signal);
        if (signal.aborted) return;
        this.store.setRuns(key, wf.id, runs);
        for (const r of runs) {
          allRunIds.add(r.id);
          if (isActiveStatus(r.status)) activeRunIds.add(r.id);
        }
      }

      // Per-repo jobs (same heuristic as the old single-repo loop).
      const per = this.store.snapshot().repos.get(key);
      const knownJobs: ReadonlyMap<number, readonly import("../core/domain/types.js").Job[]> = per?.jobsByRunId ?? new Map();
      for (const runId of allRunIds) {
        if (signal.aborted) return;
        const cached = knownJobs.get(runId);
        const anyCachedJobActive = cached?.some((j) => isActiveStatus(j.status)) ?? false;
        const needsFetch = activeRunIds.has(runId) || !cached || anyCachedJobActive;
        if (!needsFetch) continue;
        try {
          const jobs = await client.listJobs(ctx.coords, runId, signal);
          if (signal.aborted) return;
          this.store.setJobs(key, runId, jobs);
        } catch (err) {
          if (isAbort(err)) return;
          this.log.warn(`listJobs(${ctx.coords.owner}/${ctx.coords.repo}/${runId}) failed; skipping`, err);
        }
      }
      this.store.pruneJobs(key, allRunIds);
      this.store.pruneArtifacts(key, allRunIds);

      // Artifacts for newly-completed runs (immutable post-completion, so
      // one fetch per run id is enough).
      for (const runId of selectRepoRunsMissingArtifacts(this.store.snapshot(), key)) {
        if (signal.aborted) return;
        try {
          const artifacts = await client.listArtifacts(ctx.coords, runId, signal);
          if (signal.aborted) return;
          this.store.setArtifacts(key, runId, artifacts);
        } catch (err) {
          if (isAbort(err)) return;
          this.log.warn(`listArtifacts(${ctx.coords.owner}/${ctx.coords.repo}/${runId}) failed; skipping`, err);
        }
      }
      this.store.setRepoError(key, null);
    } catch (err) {
      if (isAbort(err)) return;
      if (err instanceof GitHubApiError && (err.status === 401 || err.status === 403)) {
        // Auth problems are global (same token covers all repos) — promote to
        // the top-level handler so we stop the loop and surface a banner.
        throw err;
      }
      this.handlePerRepoError(key, err);
    }
  }

  private handlePerRepoError(key: RepoKey, err: unknown): void {
    if (err instanceof GitHubApiError) {
      if (err.status === 404) {
        this.store.setRepoError(key, `Repository not found or no access.`);
      } else {
        this.store.setRepoError(key, `${err.status ?? "?"} ${err.message}`);
      }
      this.log.warn(`Sync for ${key} failed`, err);
      return;
    }
    this.log.error(`Sync for ${key} failed`, err);
    this.store.setRepoError(key, err instanceof Error ? err.message : String(err));
  }

  private pickInterval(): number {
    if (Date.now() < this.burstUntil) return this.config.activePollIntervalMs;
    return this.store.hasActiveRuns()
      ? this.config.activePollIntervalMs
      : this.config.idlePollIntervalMs;
  }

  private handleError(err: unknown): void {
    if (err instanceof GitHubApiError) {
      const failure = this.buildFailure(err);
      this.store.setAuthFailure(failure);
      if (err.status === 401 || err.status === 403) {
        this.store.setStatus("unauthenticated", err.message);
        this.log.warn("Auth rejected by GitHub API; pausing until sign-in refreshes.");
        this.stop();
        return;
      }
      this.store.setStatus("error", `${err.status ?? "?"} ${err.message}`);
      return;
    }
    this.log.error("Sync cycle failed", err);
    const message = err instanceof Error ? err.message : String(err);
    this.store.setAuthFailure(classifyAuthFailure({
      status: null,
      message,
      route: null,
      requestedScopes: AuthService.REQUESTED_SCOPES,
    }));
    this.store.setStatus("error", message);
  }

  private buildFailure(err: GitHubApiError): AuthFailure {
    return classifyAuthFailure({
      status: err.status ?? null,
      message: err.message,
      route: err.route,
      headers: err.headers ?? undefined,
      documentationUrl: err.documentationUrl,
      requestedScopes: AuthService.REQUESTED_SCOPES,
    });
  }

  private clearTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }
}

function isAbort(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.message === "The operation was aborted.";
}

// Retained for typing parity with how the coordinator reaches for repo coords.
export type { RepoCoordinates };
