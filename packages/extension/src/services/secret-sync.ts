import * as vscode from "vscode";
import type { GitHubApi } from "../data/github-api.js";
import { GitHubApiError } from "../data/github-api.js";
import { classifyAuthFailure } from "../core/auth/failure.js";
import { encryptSecretValue, ensureSodiumReady } from "../core/auth/encrypt.js";
import type { SecretScope } from "../core/domain/secrets.js";
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
      const [repoSecrets, repoVariables, environments] = await Promise.all([
        api.listRepoSecrets(repo, ac.signal),
        api.listRepoVariables(repo, ac.signal),
        api.listEnvironments(repo, ac.signal),
      ]);
      if (ac.signal.aborted) return;
      this.store.setEnvironments(environments);
      this.store.setSecrets({ kind: "repo" }, repoSecrets);
      this.store.setVariables({ kind: "repo" }, repoVariables);

      // Eager parallel fetch for every environment's secrets + variables.
      // Each failure is isolated — one env 403 shouldn't blank the tree.
      await Promise.all(
        environments.flatMap((env) => [
          this.fetchEnvSecrets(api, repo, env.name, ac.signal),
          this.fetchEnvVariables(api, repo, env.name, ac.signal),
        ]),
      );
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

  private async fetchEnvVariables(
    api: GitHubApi,
    repo: RepoCoordinates,
    envName: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const variables = await api.listEnvironmentVariables(repo, envName, signal);
      if (signal.aborted) return;
      this.store.setVariables({ kind: "environment", name: envName }, variables);
    } catch (err) {
      if (isAbort(err)) return;
      this.log.warn(`listEnvironmentVariables(${envName}) failed`, err);
    }
  }

  /**
   * Create or update a secret in the given scope. Handles the public-key
   * fetch, seal-box encryption, PUT, and targeted refetch.
   *
   * Throws on failure (the command handler surfaces the message) rather than
   * quietly swallowing — upstream #513's silent-save bug was the opposite
   * choice, and the fix is to be loud about the PUT response.
   */
  async writeSecret(scope: SecretScope, name: string, value: string): Promise<void> {
    const { api, repo } = this.requireContext();
    await ensureSodiumReady();
    const key = scope.kind === "repo"
      ? await api.getRepoPublicKey(repo)
      : await api.getEnvironmentPublicKey(repo, scope.name);
    const ciphertext = encryptSecretValue(key.key, value);
    if (scope.kind === "repo") {
      await api.putRepoSecret(repo, name, ciphertext, key.keyId);
    } else {
      await api.putEnvironmentSecret(repo, scope.name, name, ciphertext, key.keyId);
    }
    await this.refreshScope(scope);
  }

  /** Delete a secret in the given scope. Refreshes the affected scope on success. */
  async deleteSecret(scope: SecretScope, name: string): Promise<void> {
    const { api, repo } = this.requireContext();
    if (scope.kind === "repo") {
      await api.deleteRepoSecret(repo, name);
    } else {
      await api.deleteEnvironmentSecret(repo, scope.name, name);
    }
    await this.refreshScope(scope);
  }

  /**
   * Create or update a variable. GitHub distinguishes create (POST) from
   * update (PATCH), so we pick the right call based on whether the name
   * is already known in the snapshot.
   */
  async writeVariable(scope: SecretScope, name: string, value: string, exists: boolean): Promise<void> {
    const { api, repo } = this.requireContext();
    const normalized = value.replace(/\r\n/g, "\n");
    if (scope.kind === "repo") {
      if (exists) await api.updateRepoVariable(repo, name, normalized);
      else await api.createRepoVariable(repo, name, normalized);
    } else {
      if (exists) await api.updateEnvironmentVariable(repo, scope.name, name, normalized);
      else await api.createEnvironmentVariable(repo, scope.name, name, normalized);
    }
    await this.refreshVariableScope(scope);
  }

  async deleteVariable(scope: SecretScope, name: string): Promise<void> {
    const { api, repo } = this.requireContext();
    if (scope.kind === "repo") {
      await api.deleteRepoVariable(repo, name);
    } else {
      await api.deleteEnvironmentVariable(repo, scope.name, name);
    }
    await this.refreshVariableScope(scope);
  }

  private async refreshVariableScope(scope: SecretScope): Promise<void> {
    const { api, repo } = this.requireContext();
    if (scope.kind === "repo") {
      const variables = await api.listRepoVariables(repo);
      this.store.setVariables({ kind: "repo" }, variables);
      return;
    }
    const variables = await api.listEnvironmentVariables(repo, scope.name);
    this.store.setVariables({ kind: "environment", name: scope.name }, variables);
  }

  private async refreshScope(scope: SecretScope): Promise<void> {
    const { api, repo } = this.requireContext();
    if (scope.kind === "repo") {
      const secrets = await api.listRepoSecrets(repo);
      this.store.setSecrets({ kind: "repo" }, secrets);
      return;
    }
    const secrets = await api.listEnvironmentSecrets(repo, scope.name);
    this.store.setSecrets({ kind: "environment", name: scope.name }, secrets);
  }

  private requireContext(): { api: GitHubApi; repo: RepoCoordinates } {
    const api = this.apiProvider();
    const repo = this.repo;
    if (!api) throw new Error("Not signed in to GitHub");
    if (!repo) throw new Error("No GitHub repository detected in this workspace");
    return { api, repo };
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
