import * as vscode from "vscode";
import type { GitHubApi } from "../data/github-api.js";
import { GitHubClient } from "../data/github-client.js";
import { GitRepoWatcher, type RepoContext } from "../data/git-repo.js";
import { AuthService } from "../services/auth.js";
import type { LiveSync } from "../services/live-sync.js";
import type { SecretSync } from "../services/secret-sync.js";
import type { WorkflowStore } from "../services/workflow-store.js";
import type { Logger } from "../util/logger.js";
import { repoKey } from "../core/domain/types.js";

/**
 * Owns the top-level state machine for the extension:
 *
 *   unauthenticated ←→ (authed, 0 repos) ←→ (authed, N repos) [→ live syncing]
 *
 * Every event that can move us between those states — sign-in, sign-out,
 * repos-changed — flows through `reconcile()`, which is the *only* place
 * that decides what the store, sync services, and API client should look
 * like. That means one audit trail for status transitions and no
 * cross-component race conditions.
 */
const PUSH_BURST_MS = 30_000;

export class AppCoordinator implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private client: GitHubApi | null = null;

  constructor(
    private readonly auth: AuthService,
    private readonly repoWatcher: GitRepoWatcher,
    private readonly store: WorkflowStore,
    private readonly sync: LiveSync,
    private readonly secretSync: SecretSync,
    private readonly log: Logger,
  ) {
    this.disposables.push(
      auth.onDidChange(() => this.reconcile()),
      repoWatcher.onDidChange(() => this.reconcile()),
      repoWatcher.onDidPush((ctx) => {
        this.log.info(`push detected in ${ctx.coords.owner}/${ctx.coords.repo} → burst polling`);
        this.sync.burst(PUSH_BURST_MS);
      }),
    );
  }

  /** Return the current API client, or null if unauthenticated. */
  get api(): GitHubApi | null { return this.client; }

  /** Boot sequence — call once after constructing the wiring graph. */
  async start(): Promise<void> {
    await this.repoWatcher.start();
    await this.auth.initialize();
    this.reconcile();
  }

  /** Force-retry idempotent: useful after manual sign-in. */
  reconcile(): void {
    const token = this.auth.state.session?.accessToken;
    const contexts = this.repoWatcher.contexts;

    if (!token) {
      this.log.info("reconcile: no auth → unauthenticated");
      this.client = null;
      this.store.setStatus("unauthenticated");
      this.store.setRepos([]);
      this.sync.setRepos([]);
      this.secretSync.setRepos([]);
      this.sync.stop();
      return;
    }
    // Rebuild the client on token changes so a fresh session applies immediately.
    this.client = new GitHubClient(token, this.log);

    if (contexts.length === 0) {
      this.log.info("reconcile: authed, no GitHub repos in workspace → no-repo");
      this.store.setRepos([]);
      this.sync.setRepos([]);
      this.secretSync.setRepos([]);
      this.sync.stop();
      return;
    }

    const summary = contexts.map(shortLabel).join(", ");
    this.log.info(`reconcile: authed + [${summary}] → syncing`);
    const coordsList = contexts.map((c) => ({ coords: c.coords, branch: c.branch }));
    this.store.setRepos(coordsList);
    this.sync.setRepos(contexts);
    this.secretSync.setRepos(contexts);
    this.sync.start();
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

function shortLabel(ctx: RepoContext): string {
  const key = repoKey(ctx.coords);
  return ctx.branch ? `${key}@${ctx.branch}` : key;
}
