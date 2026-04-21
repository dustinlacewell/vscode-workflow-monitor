import * as vscode from "vscode";
import type { GitHubApi } from "../data/github-api.js";
import { GitHubApiError } from "../data/github-api.js";
import type { RepoContext } from "../data/git-repo.js";
import { classifyAuthFailure } from "../core/auth/failure.js";
import { encryptSecretValue, ensureSodiumReady } from "../core/auth/encrypt.js";
import type { SecretScope } from "../core/domain/secrets.js";
import type { RepoCoordinates, RepoKey } from "../core/domain/types.js";
import { repoKey } from "../core/domain/types.js";
import type { Logger } from "../util/logger.js";
import { AuthService } from "./auth.js";
import type { WorkflowStore } from "./workflow-store.js";

export type ApiProvider = () => GitHubApi | null;

/**
 * Fetches secrets + variables + environments for every tracked repo.
 *
 * Everything is on-demand (tree visibility, explicit refresh, post-write
 * reloads) — secrets change rarely and polling them is wasteful. But each
 * refresh eagerly fans out per-repo and per-env in parallel, so by the time
 * the user drills into an environment its data is already cached.
 *
 * Multi-repo: writes and refreshes take a `RepoKey` to scope the operation;
 * the store keeps per-repo SecretsSnapshot entries so one repo's 403 doesn't
 * blank the others.
 */
export class SecretSync implements vscode.Disposable {
  private repos: readonly RepoContext[] = [];
  private readonly aborts = new Map<RepoKey, AbortController>();
  private readonly inFlight = new Set<RepoKey>();
  private disposed = false;

  constructor(
    private readonly apiProvider: ApiProvider,
    private readonly store: WorkflowStore,
    private readonly log: Logger,
  ) {}

  setRepos(repos: readonly RepoContext[]): void {
    const seenKeys = new Set(repos.map((r) => repoKey(r.coords)));
    // Abort any in-flight fetches for repos that disappeared from the list.
    for (const [key, ac] of this.aborts) {
      if (!seenKeys.has(key)) {
        ac.abort();
        this.aborts.delete(key);
      }
    }
    const prevKeys = new Set(this.repos.map((r) => repoKey(r.coords)));
    this.repos = repos;
    // Prefetch any newly-tracked repo, so the Settings view is ready before
    // the user opens it.
    for (const ctx of repos) {
      if (!prevKeys.has(repoKey(ctx.coords))) void this.refreshRepo(ctx);
    }
  }

  /** Full refresh of every tracked repo in parallel. */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    await Promise.all(this.repos.map((ctx) => this.refreshRepo(ctx)));
  }

  private async refreshRepo(ctx: RepoContext): Promise<void> {
    if (this.disposed) return;
    const key = repoKey(ctx.coords);
    if (this.inFlight.has(key)) return;
    const api = this.apiProvider();
    if (!api) return;

    this.inFlight.add(key);
    const ac = new AbortController();
    this.aborts.get(key)?.abort();
    this.aborts.set(key, ac);
    this.store.setSecretsStatus(key, "loading");

    try {
      const [repoSecrets, repoVariables, environments] = await Promise.all([
        api.listRepoSecrets(ctx.coords, ac.signal),
        api.listRepoVariables(ctx.coords, ac.signal),
        api.listEnvironments(ctx.coords, ac.signal),
      ]);
      if (ac.signal.aborted) return;
      this.store.setEnvironments(key, environments);
      this.store.setSecrets(key, { kind: "repo" }, repoSecrets);
      this.store.setVariables(key, { kind: "repo" }, repoVariables);

      await Promise.all(
        environments.flatMap((env) => [
          this.fetchEnvSecrets(api, ctx.coords, key, env.name, ac.signal),
          this.fetchEnvVariables(api, ctx.coords, key, env.name, ac.signal),
        ]),
      );
    } catch (err) {
      if (isAbort(err)) return;
      this.handleError(key, err);
    } finally {
      this.inFlight.delete(key);
      if (this.aborts.get(key) === ac) this.aborts.delete(key);
    }
  }

  private async fetchEnvSecrets(
    api: GitHubApi,
    coords: RepoCoordinates,
    key: RepoKey,
    envName: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const secrets = await api.listEnvironmentSecrets(coords, envName, signal);
      if (signal.aborted) return;
      this.store.setSecrets(key, { kind: "environment", name: envName }, secrets);
    } catch (err) {
      if (isAbort(err)) return;
      this.log.warn(`listEnvironmentSecrets(${key}/${envName}) failed`, err);
    }
  }

  private async fetchEnvVariables(
    api: GitHubApi,
    coords: RepoCoordinates,
    key: RepoKey,
    envName: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const variables = await api.listEnvironmentVariables(coords, envName, signal);
      if (signal.aborted) return;
      this.store.setVariables(key, { kind: "environment", name: envName }, variables);
    } catch (err) {
      if (isAbort(err)) return;
      this.log.warn(`listEnvironmentVariables(${key}/${envName}) failed`, err);
    }
  }

  // --- write flows --------------------------------------------------------

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
    await this.refreshSecretScope(repo, key, scope);
  }

  async deleteSecret(repo: RepoCoordinates, scope: SecretScope, name: string): Promise<void> {
    const { api } = this.requireContext();
    const key = repoKey(repo);
    if (scope.kind === "repo") {
      await api.deleteRepoSecret(repo, name);
    } else {
      await api.deleteEnvironmentSecret(repo, scope.name, name);
    }
    await this.refreshSecretScope(repo, key, scope);
  }

  async writeVariable(
    repo: RepoCoordinates,
    scope: SecretScope,
    name: string,
    value: string,
    exists: boolean,
  ): Promise<void> {
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
    await this.refreshVariableScope(repo, key, scope);
  }

  async deleteVariable(repo: RepoCoordinates, scope: SecretScope, name: string): Promise<void> {
    const { api } = this.requireContext();
    const key = repoKey(repo);
    if (scope.kind === "repo") {
      await api.deleteRepoVariable(repo, name);
    } else {
      await api.deleteEnvironmentVariable(repo, scope.name, name);
    }
    await this.refreshVariableScope(repo, key, scope);
  }

  private async refreshSecretScope(repo: RepoCoordinates, key: RepoKey, scope: SecretScope): Promise<void> {
    const { api } = this.requireContext();
    if (scope.kind === "repo") {
      this.store.setSecrets(key, { kind: "repo" }, await api.listRepoSecrets(repo));
      return;
    }
    this.store.setSecrets(
      key,
      { kind: "environment", name: scope.name },
      await api.listEnvironmentSecrets(repo, scope.name),
    );
  }

  private async refreshVariableScope(repo: RepoCoordinates, key: RepoKey, scope: SecretScope): Promise<void> {
    const { api } = this.requireContext();
    if (scope.kind === "repo") {
      this.store.setVariables(key, { kind: "repo" }, await api.listRepoVariables(repo));
      return;
    }
    this.store.setVariables(
      key,
      { kind: "environment", name: scope.name },
      await api.listEnvironmentVariables(repo, scope.name),
    );
  }

  /** Targeted reload for a single env's secrets — used as a lazy-load fallback. */
  async refreshEnvironment(repo: RepoCoordinates, envName: string): Promise<void> {
    if (this.disposed) return;
    const api = this.apiProvider();
    if (!api) return;
    const key = repoKey(repo);
    try {
      const secrets = await api.listEnvironmentSecrets(repo, envName);
      this.store.setSecrets(key, { kind: "environment", name: envName }, secrets);
    } catch (err) {
      if (isAbort(err)) return;
      this.handleError(key, err);
    }
  }

  private requireContext(): { api: GitHubApi } {
    const api = this.apiProvider();
    if (!api) throw new Error("Not signed in to GitHub");
    return { api };
  }

  private handleError(key: RepoKey, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.log.warn(`Secret sync for ${key} failed`, err);
    this.store.setSecretsStatus(key, "error", message);
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
    for (const ac of this.aborts.values()) ac.abort();
    this.aborts.clear();
  }
}

function isAbort(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.message === "The operation was aborted.";
}
