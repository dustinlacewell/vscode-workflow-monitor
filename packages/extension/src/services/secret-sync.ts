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
 * Fetches repo/environment secrets *on demand*. Unlike LiveSync, there's no
 * polling loop — secrets change rarely and each refresh costs one API call
 * per environment plus two for the repo/env lists. Instead:
 *
 *   - `refresh()` performs a full fetch of everything (called on tree
 *     visibility + user refresh command + repo change).
 *   - `refreshScope(scope)` reloads just one scope (when the user expands
 *     an environment group the first time, to avoid fetching N env lists
 *     eagerly if they only care about one).
 *
 * Failures feed the same AuthFailure banner as the main sync loop so the
 * "Missing scope" diagnostics work for secrets too.
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
  }

  /**
   * Top-level refresh: list environments + repo secrets; environment-scoped
   * secrets are deferred to first expansion via refreshScope().
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
      // Order matters: setEnvironments flips status to "ready"; we want
      // setSecrets to not reset lastUpdated unnecessarily.
      this.store.setEnvironments(environments);
      this.store.setSecrets({ kind: "repo" }, repoSecrets);
    } catch (err) {
      if (isAbort(err)) return;
      this.handleError(err);
    } finally {
      this.inFlight = false;
      if (this.abort === ac) this.abort = null;
    }
  }

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
