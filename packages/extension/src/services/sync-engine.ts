import * as vscode from "vscode";
import type { GitHubApi } from "../data/github-api.js";
import { GitHubApiError } from "../data/github-api.js";
import type { RepoContext } from "../data/git-repo.js";
import { classifyAuthFailure } from "../core/auth/failure.js";
import { encryptSecretValue, ensureSodiumReady } from "../core/auth/encrypt.js";
import type { SecretScope } from "../core/domain/secrets.js";
import type {
  RepoCoordinates,
  RepoKey,
  WorkflowRun,
} from "../core/domain/types.js";
import { isActiveStatus, repoKey } from "../core/domain/types.js";
import type { Logger } from "../util/logger.js";
import { AuthService } from "./auth.js";
import type { WorkflowStore } from "./workflow-store.js";

export type ApiProvider = () => GitHubApi | null;

export type ViewId = "workflows" | "settings";

export type Cadence =
  | { kind: "poll" }                                     // adaptive loop
  | { kind: "visibility"; view: ViewId }                 // fire when view becomes visible
  | { kind: "on-completion" };                           // fired by the poll loop on run transition

/**
 * Everything the engine needs to drive one piece of remote state. Fetchers
 * are plain records — no classes, no inheritance — so registering is cheap
 * and the cadence policy is data, not behaviour.
 */
export interface Fetcher {
  readonly id: string;
  readonly repoKey: RepoKey;
  readonly cadence: Cadence;
  /** Actual network work. Should populate the store via its closure. */
  readonly fetch: (signal: AbortSignal) => Promise<void>;
}

/**
 * Source of visibility events for one tree view. The engine owns the
 * subscription; callers pass the VS Code TreeView in.
 */
export interface VisibilitySource {
  readonly id: ViewId;
  readonly onDidChangeVisibility: vscode.Event<{ visible: boolean }>;
  readonly visible: boolean;
}

export interface SyncEngineConfig {
  activePollIntervalMs: number;
  idlePollIntervalMs: number;
  runsPerWorkflow: number;
}

/**
 * Owns every fetch the extension performs.
 *
 * Three cadence buckets:
 *   - **poll**: a single adaptive loop (fast when any run is active, slow
 *     otherwise) that fans out every repo's poll-bucket fetchers in parallel.
 *     Returns what was fetched so the poll loop can notice run → completed
 *     transitions and dispatch on-completion fetchers.
 *   - **visibility**: fired in parallel whenever a registered view becomes
 *     visible. No polling, no re-ticks: each visible→invisible→visible
 *     re-entry re-fetches, which catches out-of-band edits (GitHub website,
 *     `gh` CLI, teammate) on the next tab-back.
 *   - **on-completion**: one-shot fetchers registered by the poll loop when
 *     it observes a run transitioning to `completed`. Primarily artifacts.
 *
 * Writes (secrets / variables) live on the engine too so there's one place
 * that holds the `GitHubApi` + `WorkflowStore` pair. The engine is the
 * single injectable that commands/trees/coordinator reach for.
 */
export class SyncEngine implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  private repos: readonly RepoContext[] = [];
  private fetchers = new Map<string, Fetcher>();
  private registerFetchers: (ctx: RepoContext) => Fetcher[] = () => [];
  private buildOnCompletion: ((repo: RepoCoordinates, run: WorkflowRun) => Fetcher) | null = null;
  private readonly aborts = new Map<string, AbortController>();
  private readonly inFlight = new Set<string>();

  // poll loop
  private running = false;
  private disposed = false;
  private cycleInFlight = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private burstUntil = 0;

  // visibility state
  private readonly visibilityById = new Map<ViewId, VisibilitySource>();
  private readonly visibilityFiredOnce = new Set<ViewId>();

  constructor(
    private readonly apiProvider: ApiProvider,
    private readonly store: WorkflowStore,
    private readonly log: Logger,
    private config: SyncEngineConfig,
  ) {}

  // --- lifecycle ---------------------------------------------------------

  /**
   * `registerFor(ctx)` is called for each tracked repo as the watcher's list
   * changes. It should return the full set of fetchers for that repo —
   * every poll / visibility fetcher that should exist while this repo is
   * tracked. The engine wipes & re-registers on each setRepos call.
   */
  setRegistrar(registerFor: (ctx: RepoContext) => readonly Fetcher[]): void {
    this.registerFetchers = (ctx) => [...registerFor(ctx)];
  }

  /**
   * Tell the engine how to build an on-completion fetcher for a (repo, run)
   * pair. Kept separate from `setRegistrar` because these are built lazily,
   * one per run id the poll loop observes transitioning to `completed`.
   */
  setOnCompletionBuilder(build: (repo: RepoCoordinates, run: WorkflowRun) => Fetcher): void {
    this.buildOnCompletion = build;
  }

  setRepos(repos: readonly RepoContext[]): void {
    const seenKeys = new Set(repos.map((r) => repoKey(r.coords)));

    // Abort + drop fetchers for repos that disappeared.
    for (const [id, f] of this.fetchers) {
      if (!seenKeys.has(f.repoKey)) {
        this.aborts.get(id)?.abort();
        this.aborts.delete(id);
        this.fetchers.delete(id);
      }
    }

    // Register fetchers for any newly-tracked repos.
    const prevKeys = new Set(this.repos.map((r) => repoKey(r.coords)));
    for (const ctx of repos) {
      if (prevKeys.has(repoKey(ctx.coords))) continue;
      for (const f of this.registerFetchers(ctx)) this.fetchers.set(f.id, f);
    }

    this.repos = repos;

    // Re-fire visibility fetchers for views that are currently visible, so
    // a newly-tracked repo immediately populates the view the user is looking
    // at without waiting for them to toggle it.
    for (const source of this.visibilityById.values()) {
      if (source.visible) this.fireVisibility(source.id);
    }

    if (this.running) this.scheduleNext(0);
  }

  updateConfig(next: SyncEngineConfig): void {
    this.config = next;
    if (this.running) this.scheduleNext(0);
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.scheduleNext(0);
  }

  stop(): void {
    this.running = false;
    this.clearPollTimer();
    for (const ac of this.aborts.values()) ac.abort();
    this.aborts.clear();
    this.inFlight.clear();
  }

  registerVisibilitySource(source: VisibilitySource): void {
    this.visibilityById.set(source.id, source);
    this.disposables.push(source.onDidChangeVisibility((e) => {
      if (!e.visible) return;
      this.fireVisibility(source.id);
    }));
    // If the view is already visible at registration time, fire once.
    if (source.visible) this.fireVisibility(source.id);
  }

  /** Manual refresh — re-fires every fetcher for the given view. */
  refreshView(view: ViewId): void {
    this.fireVisibility(view);
  }

  /** Manual refresh — bumps the poll loop. */
  refreshPoll(): void {
    if (!this.running) return;
    this.scheduleNext(0);
  }

  /** Short-term promotion to the fast poll interval (used post-push). */
  burst(durationMs: number): void {
    this.burstUntil = Date.now() + durationMs;
    if (this.running) this.scheduleNext(0);
  }

  // --- visibility fanout -------------------------------------------------

  private fireVisibility(view: ViewId): void {
    this.visibilityFiredOnce.add(view);
    const fetchers = [...this.fetchers.values()].filter(
      (f) => f.cadence.kind === "visibility" && f.cadence.view === view,
    );
    for (const f of fetchers) void this.runFetcher(f);
  }

  // --- poll loop ---------------------------------------------------------

  private scheduleNext(delayMs: number): void {
    this.clearPollTimer();
    if (!this.running || this.disposed) return;
    this.pollTimer = setTimeout(() => { void this.runPollCycle(); }, delayMs);
  }

  private clearPollTimer(): void {
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
  }

  private async runPollCycle(): Promise<void> {
    if (this.cycleInFlight || this.disposed) return;
    const client = this.apiProvider();
    if (!client) { this.store.setStatus("unauthenticated"); return; }
    if (this.repos.length === 0) { this.store.setStatus("no-repo"); return; }

    this.cycleInFlight = true;
    // Snapshot the set of run ids per repo before the cycle so we can detect
    // transitions to `completed` afterwards and dispatch on-completion work.
    const preCycle = this.snapshotRunStatuses();

    try {
      const pollFetchers = [...this.fetchers.values()].filter((f) => f.cadence.kind === "poll");
      await Promise.all(pollFetchers.map((f) => this.runFetcher(f)));
      this.dispatchOnCompletion(preCycle);
    } finally {
      this.cycleInFlight = false;
      this.scheduleNext(this.pickInterval());
    }
  }

  private pickInterval(): number {
    if (Date.now() < this.burstUntil) return this.config.activePollIntervalMs;
    return this.store.hasActiveRuns()
      ? this.config.activePollIntervalMs
      : this.config.idlePollIntervalMs;
  }

  // --- on-completion dispatch -------------------------------------------

  private snapshotRunStatuses(): Map<RepoKey, Map<number, string>> {
    const out = new Map<RepoKey, Map<number, string>>();
    for (const [key, per] of this.store.snapshot().repos) {
      const inner = new Map<number, string>();
      for (const runs of per.runsByWorkflowId.values()) {
        for (const run of runs) inner.set(run.id, run.status);
      }
      out.set(key, inner);
    }
    return out;
  }

  private dispatchOnCompletion(pre: Map<RepoKey, Map<number, string>>): void {
    if (!this.buildOnCompletion) return;
    const post = this.store.snapshot();
    for (const [key, per] of post.repos) {
      const before = pre.get(key);
      for (const runs of per.runsByWorkflowId.values()) {
        for (const run of runs) {
          const prevStatus = before?.get(run.id);
          const transitioned =
            run.status === "completed" &&
            prevStatus !== undefined &&
            prevStatus !== "completed";
          if (!transitioned) continue;
          // Build + run one-shot on-completion fetcher for this run.
          const fetcher = this.buildOnCompletion(per.repo, run);
          void this.runFetcher(fetcher);
        }
      }
    }
  }

  // --- fetcher execution -------------------------------------------------

  private async runFetcher(f: Fetcher): Promise<void> {
    if (this.inFlight.has(f.id)) return;
    this.inFlight.add(f.id);
    const ac = new AbortController();
    this.aborts.get(f.id)?.abort();
    this.aborts.set(f.id, ac);
    try {
      await f.fetch(ac.signal);
    } catch (err) {
      if (isAbort(err)) return;
      this.handleError(f, err);
    } finally {
      this.inFlight.delete(f.id);
      if (this.aborts.get(f.id) === ac) this.aborts.delete(f.id);
    }
  }

  private handleError(f: Fetcher, err: unknown): void {
    if (err instanceof GitHubApiError) {
      // Auth issues are token-wide, not per-fetcher.
      if (err.status === 401 || err.status === 403) {
        const failure = classifyAuthFailure({
          status: err.status,
          message: err.message,
          route: err.route,
          headers: err.headers ?? undefined,
          documentationUrl: err.documentationUrl,
          requestedScopes: AuthService.REQUESTED_SCOPES,
        });
        this.store.setAuthFailure(failure);
        this.store.setStatus("unauthenticated", err.message);
        this.log.warn(`Auth rejected by GitHub (${f.id}); pausing loop.`);
        this.stop();
        return;
      }
      if (err.status === 404) {
        this.store.setRepoError(f.repoKey, `Repository not found or no access.`);
        return;
      }
      this.store.setRepoError(f.repoKey, `${err.status ?? "?"} ${err.message}`);
      this.log.warn(`Fetcher ${f.id} failed`, err);
      return;
    }
    this.log.warn(`Fetcher ${f.id} failed`, err);
    const msg = err instanceof Error ? err.message : String(err);
    this.store.setRepoError(f.repoKey, msg);
  }

  // --- write operations (settings) ---------------------------------------

  async writeSecret(repo: RepoCoordinates, scope: SecretScope, name: string, value: string): Promise<void> {
    const { api } = this.requireContext();
    const key = repoKey(repo);
    await ensureSodiumReady();
    const pubKey = scope.kind === "repo"
      ? await api.getRepoPublicKey(repo)
      : await api.getEnvironmentPublicKey(repo, scope.name);
    const ciphertext = encryptSecretValue(pubKey.key, value);
    if (scope.kind === "repo") {
      await api.putRepoSecret(repo, name, ciphertext, pubKey.keyId);
    } else {
      await api.putEnvironmentSecret(repo, scope.name, name, ciphertext, pubKey.keyId);
    }
    await this.refreshSecretScope(api, repo, key, scope);
  }

  async deleteSecret(repo: RepoCoordinates, scope: SecretScope, name: string): Promise<void> {
    const { api } = this.requireContext();
    const key = repoKey(repo);
    if (scope.kind === "repo") await api.deleteRepoSecret(repo, name);
    else await api.deleteEnvironmentSecret(repo, scope.name, name);
    await this.refreshSecretScope(api, repo, key, scope);
  }

  async writeVariable(repo: RepoCoordinates, scope: SecretScope, name: string, value: string, exists: boolean): Promise<void> {
    const { api } = this.requireContext();
    const key = repoKey(repo);
    const normalized = value.replace(/\r\n/g, "\n");
    if (scope.kind === "repo") {
      if (exists) await api.updateRepoVariable(repo, name, normalized);
      else await api.createRepoVariable(repo, name, normalized);
    } else {
      if (exists) await api.updateEnvironmentVariable(repo, scope.name, name, normalized);
      else await api.createEnvironmentVariable(repo, scope.name, name, normalized);
    }
    await this.refreshVariableScope(api, repo, key, scope);
  }

  async deleteVariable(repo: RepoCoordinates, scope: SecretScope, name: string): Promise<void> {
    const { api } = this.requireContext();
    const key = repoKey(repo);
    if (scope.kind === "repo") await api.deleteRepoVariable(repo, name);
    else await api.deleteEnvironmentVariable(repo, scope.name, name);
    await this.refreshVariableScope(api, repo, key, scope);
  }

  private async refreshSecretScope(api: GitHubApi, repo: RepoCoordinates, key: RepoKey, scope: SecretScope): Promise<void> {
    if (scope.kind === "repo") {
      this.store.setSecrets(key, { kind: "repo" }, await api.listRepoSecrets(repo));
      return;
    }
    this.store.setSecrets(key, { kind: "environment", name: scope.name }, await api.listEnvironmentSecrets(repo, scope.name));
  }

  private async refreshVariableScope(api: GitHubApi, repo: RepoCoordinates, key: RepoKey, scope: SecretScope): Promise<void> {
    if (scope.kind === "repo") {
      this.store.setVariables(key, { kind: "repo" }, await api.listRepoVariables(repo));
      return;
    }
    this.store.setVariables(key, { kind: "environment", name: scope.name }, await api.listEnvironmentVariables(repo, scope.name));
  }

  private requireContext(): { api: GitHubApi } {
    const api = this.apiProvider();
    if (!api) throw new Error("Not signed in to GitHub");
    return { api };
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.disposables.forEach((d) => d.dispose());
  }
}

export function onCompletionFetcherId(key: RepoKey, runId: number): string {
  return `on-completion:artifact:${key}:${runId}`;
}

function isAbort(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.message === "The operation was aborted.";
}

// Re-export for fetcher authors: they'll often need these when building fetch closures.
export type { WorkflowRun };
export { isActiveStatus };
