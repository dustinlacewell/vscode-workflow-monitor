import * as vscode from "vscode";
import { GitHubApiError, type GitHubClient } from "../data/github-client.js";
import type { RepoCoordinates } from "../domain/types.js";
import { isActiveStatus } from "../domain/types.js";
import type { Logger } from "../util/logger.js";
import type { WorkflowStore } from "./workflow-store.js";

export interface LiveSyncConfig {
  activePollIntervalMs: number;
  idlePollIntervalMs: number;
  runsPerWorkflow: number;
}

export type ClientProvider = () => GitHubClient | null;

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

  constructor(
    private readonly clientProvider: ClientProvider,
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

    const client = this.clientProvider();
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
      this.store.setWorkflows(workflows.filter((w) => w.state === "active"));

      const activeWorkflows = workflows.filter((w) => w.state === "active");
      const liveRunIds = new Set<number>();

      for (const wf of activeWorkflows) {
        if (ac.signal.aborted) return;
        const runs = await client.listRecentRuns(repo, wf.id, this.config.runsPerWorkflow, ac.signal);
        if (ac.signal.aborted) return;
        this.store.setRuns(wf.id, runs);
        for (const r of runs) if (isActiveStatus(r.status)) liveRunIds.add(r.id);
      }

      // Jobs only for currently-active runs — that's where live progress lives.
      for (const runId of liveRunIds) {
        if (ac.signal.aborted) return;
        try {
          const jobs = await client.listJobs(repo, runId, ac.signal);
          if (ac.signal.aborted) return;
          this.store.setJobs(runId, jobs);
        } catch (err) {
          if (isAbort(err)) return;
          this.log.warn(`listJobs(${runId}) failed; skipping`, err);
        }
      }
      this.store.pruneJobs(liveRunIds);
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
    return this.store.hasActiveRuns()
      ? this.config.activePollIntervalMs
      : this.config.idlePollIntervalMs;
  }

  private handleError(err: unknown): void {
    if (err instanceof GitHubApiError) {
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
    this.store.setStatus("error", err instanceof Error ? err.message : String(err));
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
