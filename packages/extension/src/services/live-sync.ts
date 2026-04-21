import * as vscode from "vscode";
import type { GitHubApi } from "../data/github-api.js";
import { GitHubApiError } from "../data/github-api.js";
import { classifyAuthFailure, type AuthFailure } from "../core/auth/failure.js";
import type { RepoCoordinates } from "../core/domain/types.js";
import { isActiveStatus } from "../core/domain/types.js";
import { selectRunsMissingArtifacts } from "../core/selectors/artifacts.js";
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
 * Drives the WorkflowStore by polling the GitHub Actions REST API at an
 * adaptive cadence:
 *   - fast interval when any visible run is still active
 *   - slow interval when everything has settled
 *
 * The loop is a single re-entrant async task guarded by an AbortController,
 * so restart() cleanly cancels an in-flight fetch and starts a new cycle
 * without overlap.
 */
export class LiveSync implements vscode.Disposable {
  private repo: RepoCoordinates | null = null;
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

  setRepo(repo: RepoCoordinates | null): void {
    this.repo = repo;
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

  /** Force an immediate refresh — bypasses the current timer. */
  refresh(): void {
    if (!this.running || this.disposed) return;
    this.scheduleNext(0);
  }

  /**
   * Poll at active cadence for `durationMs`, then fall back to the normal
   * active/idle decision. Used to catch the brief gap between a local push
   * and the first visible run appearing in the GitHub API response.
   */
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
    const repo = this.repo;

    if (!client) {
      this.cycleInFlight = false;
      this.store.setStatus("unauthenticated");
      return;
    }
    if (!repo) {
      this.cycleInFlight = false;
      this.store.setStatus("no-repo");
      return;
    }

    const ac = new AbortController();
    this.abort = ac;

    try {
      const workflows = await client.listWorkflows(repo, ac.signal);
      if (ac.signal.aborted) return;
      const activeWorkflows = workflows.filter((w) => w.state === "active");
      this.store.setWorkflows(activeWorkflows);

      const allRunIds = new Set<number>();
      const activeRunIds = new Set<number>();

      for (const wf of activeWorkflows) {
        if (ac.signal.aborted) return;
        const runs = await client.listRecentRuns(repo, wf.id, this.config.runsPerWorkflow, ac.signal);
        if (ac.signal.aborted) return;
        this.store.setRuns(wf.id, runs);
        for (const r of runs) {
          allRunIds.add(r.id);
          if (isActiveStatus(r.status)) activeRunIds.add(r.id);
        }
      }

      // Jobs are essential for both live progress and post-mortem. Fetch:
      //   - for runs still in-flight (every cycle picks up transitions);
      //   - for runs whose jobs we haven't loaded yet (first post-complete fetch);
      //   - for runs we already cached but where a cached job is still in a
      //     non-terminal status — this catches the "run completed but a job
      //     was mid-transition in our snapshot" case, otherwise the UI shows
      //     a permanent spinner on that job.
      // ETag caching keeps re-fetches of unchanged data cheap.
      const knownJobs = this.store.snapshot().jobsByRunId;
      for (const runId of allRunIds) {
        if (ac.signal.aborted) return;
        const cached = knownJobs.get(runId);
        const anyCachedJobActive = cached?.some((j) => isActiveStatus(j.status)) ?? false;
        const needsFetch = activeRunIds.has(runId) || !cached || anyCachedJobActive;
        if (!needsFetch) continue;
        try {
          const jobs = await client.listJobs(repo, runId, ac.signal);
          if (ac.signal.aborted) return;
          this.store.setJobs(runId, jobs);
        } catch (err) {
          if (isAbort(err)) return;
          this.log.warn(`listJobs(${runId}) failed; skipping`, err);
        }
      }
      this.store.pruneJobs(allRunIds);
      this.store.pruneArtifacts(allRunIds);

      // Completed runs: fetch artifact metadata once each. We don't refetch
      // unless the run id drops and re-appears — artifact lists are effectively
      // immutable post-completion (the server only adds an expired flag over
      // time), and polling them is wasteful.
      for (const runId of selectRunsMissingArtifacts(this.store.snapshot())) {
        if (ac.signal.aborted) return;
        try {
          const artifacts = await client.listArtifacts(repo, runId, ac.signal);
          if (ac.signal.aborted) return;
          this.store.setArtifacts(runId, artifacts);
        } catch (err) {
          if (isAbort(err)) return;
          this.log.warn(`listArtifacts(${runId}) failed; skipping`, err);
        }
      }
    } catch (err) {
      if (isAbort(err)) return;
      this.handleError(err);
    } finally {
      this.cycleInFlight = false;
      if (this.abort === ac) this.abort = null;
      this.scheduleNext(this.pickInterval());
    }
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
      if (err.status === 404) {
        this.store.setStatus("error", `Repository not found or no access: ${this.repo?.owner}/${this.repo?.repo}`);
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
