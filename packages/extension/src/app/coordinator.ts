import * as vscode from "vscode";
import type { GitHubApi } from "../data/github-api.js";
import { GitHubClient } from "../data/github-client.js";
import { GitRepoWatcher } from "../data/git-repo.js";
import { AuthService } from "../services/auth.js";
import type { LiveSync } from "../services/live-sync.js";
import type { WorkflowStore } from "../services/workflow-store.js";
import type { Logger } from "../util/logger.js";

/**
 * Owns the top-level state machine for the extension:
 *
 *   unauthenticated ←→ (authed, no repo) ←→ (authed, repo) [→ live syncing]
 *
 * Every event that can move us between those states — sign-in, sign-out,
 * repo-found, repo-lost — flows through `reconcile()`, which is the *only*
 * place that decides what the store, live-sync, and API client should look
 * like. That means one audit trail for status transitions and no
 * cross-component race conditions.
 */
export class AppCoordinator implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private client: GitHubApi | null = null;

  constructor(
    private readonly auth: AuthService,
    private readonly repoWatcher: GitRepoWatcher,
    private readonly store: WorkflowStore,
    private readonly sync: LiveSync,
    private readonly log: Logger,
  ) {
    this.disposables.push(
      auth.onDidChange(() => this.reconcile()),
      repoWatcher.onDidChange(() => this.reconcile()),
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
    const ctx = this.repoWatcher.context;

    if (!token) {
      this.log.info("reconcile: no auth → unauthenticated");
      this.client = null;
      this.store.setStatus("unauthenticated");
      this.sync.setRepo(null);
      this.sync.stop();
      return;
    }
    // Rebuild the client on token changes so a fresh session applies immediately.
    this.client = new GitHubClient(token, this.log);

    if (!ctx) {
      this.log.info("reconcile: authed, no GitHub repo in workspace → no-repo");
      this.store.setRepo(null, null);
      this.sync.setRepo(null);
      this.sync.stop();
      return;
    }

    this.log.info(`reconcile: authed + ${ctx.coords.owner}/${ctx.coords.repo}@${ctx.branch ?? "?"} → syncing`);
    this.store.setRepo(ctx.coords, ctx.branch);
    this.sync.setRepo(ctx.coords);
    this.sync.start();
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
