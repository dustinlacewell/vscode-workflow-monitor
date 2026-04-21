import * as vscode from "vscode";
import type { GitHubApi } from "../data/github-api.js";
import { GitHubApiError } from "../data/github-api.js";
import { classifyAuthFailure } from "../core/auth/failure.js";
import type { RepoCoordinates } from "../core/domain/types.js";
import type { Logger } from "../util/logger.js";
import { AuthService } from "./auth.js";
import type { WorkflowStore } from "./workflow-store.js";

export type ApiProvider = () => GitHubApi | null;

/**
 * Fetches repo/environment secrets.
 *
 * No polling loop — secrets change rarely. But `refresh()` does fetch every
 * scope *eagerly in parallel*, so by the time the user navigates into an
 * environment the data is already cached. This is what keeps perceived
 * latency at ~1 round-trip instead of 1-per-click.
 *
 * Triggers:
 *   - `setRepo()` fires `refresh()` automatically the first time a real repo
 *     resolves, so the data is ready by the time the user opens Settings.
 *   - tree visibility change re-fires `refresh()` (cheap thanks to ETag).
 *   - explicit `Refresh` title action.
 *   - `refreshEnvironment()` is still exposed for after-write reloads of a
 *     single scope (not used on first-expansion anymore).
 *
 * Failures feed the same AuthFailure banner as LiveSync, so "Missing scope"
 * diagnostics work for secrets too.
 */
export class SecretSync implements vscode.Disposable {
  private repo: RepoCoordinates | null = null;
  private abort: AbortController | null = null;
  private disposed = false;
  private inFlight = false;

  constructor(
    private readonly apiProvider: ApiProvider,
    private readonly store: WorkflowStore,
    private readonly log: Logger,
  ) {}

  setRepo(repo: RepoCoordinates | null): void {
    if (this.repo?.owner === repo?.owner && this.repo?.repo === repo?.repo) return;
    this.repo = repo;
    this.abort?.abort();
    this.abort = null;
    // Prefetch on repo resolution so the user isn't waiting when they open
    // the Settings view. Subsequent repo changes also fire a refresh — stale
    // data from a different repo would be worse than a brief loading state.
    if (repo) void this.refresh();
  }

  /**
   * Full fetch: repo secrets + env list + every env's secrets, all in parallel.
   * For a typical repo (2-5 environments) that's 4-7 concurrent calls, all of
   * which ETag-cache beyond the first time, so a second `refresh()` is nearly
   * free.
   */
  async refresh(): Promise<void> {
    if (this.disposed || this.inFlight) return;
    const api = this.apiProvider();
    const repo = this.repo;
    if (!api || !repo) return;

    this.inFlight = true;
    const ac = new AbortController();
    this.abort?.abort();
    this.abort = ac;
    this.store.setSecretsStatus("loading");

    try {
      const [repoSecrets, environments] = await Promise.all([
        api.listRepoSecrets(repo, ac.signal),
        api.listEnvironments(repo, ac.signal),
      ]);
      if (ac.signal.aborted) return;
      this.store.setEnvironments(environments);
      this.store.setSecrets({ kind: "repo" }, repoSecrets);

      // Eager parallel fetch for every environment's secrets. Each failure
      // is isolated — one env 403 shouldn't blank the whole tree.
      await Promise.all(environments.map((env) => this.fetchEnvSecrets(api, repo, env.name, ac.signal)));
    } catch (err) {
      if (isAbort(err)) return;
      this.handleError(err);
    } finally {
      this.inFlight = false;
      if (this.abort === ac) this.abort = null;
    }
  }

  private async fetchEnvSecrets(
    api: GitHubApi,
    repo: RepoCoordinates,
    envName: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const secrets = await api.listEnvironmentSecrets(repo, envName, signal);
      if (signal.aborted) return;
      this.store.setSecrets({ kind: "environment", name: envName }, secrets);
    } catch (err) {
      if (isAbort(err)) return;
      this.log.warn(`listEnvironmentSecrets(${envName}) failed`, err);
    }
  }

  /** Targeted reload for a single environment — used by post-write flows. */
  async refreshEnvironment(envName: string): Promise<void> {
    if (this.disposed) return;
    const api = this.apiProvider();
    const repo = this.repo;
    if (!api || !repo) return;
    try {
      const secrets = await api.listEnvironmentSecrets(repo, envName);
      this.store.setSecrets({ kind: "environment", name: envName }, secrets);
    } catch (err) {
      if (isAbort(err)) return;
      this.handleError(err);
    }
  }

  private handleError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.log.warn("Secret sync failed", err);
    this.store.setSecretsStatus("error", message);
    if (err instanceof GitHubApiError) {
      this.store.setAuthFailure(classifyAuthFailure({
        status: err.status ?? null,
        message: err.message,
        route: err.route,
        headers: err.headers ?? undefined,
        documentationUrl: err.documentationUrl,
        requestedScopes: AuthService.REQUESTED_SCOPES,
      }));
    }
  }

  dispose(): void {
    this.disposed = true;
    this.abort?.abort();
    this.abort = null;
  }
}

function isAbort(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.message === "The operation was aborted.";
}
