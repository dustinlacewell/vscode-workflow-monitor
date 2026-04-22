import * as vscode from "vscode";
import type { GitHubApi } from "../data/github-api.js";
import { GitHubClient } from "../data/github-client.js";
import { GitRepoWatcher, type RepoContext } from "../data/git-repo.js";
import { AuthService } from "../services/auth.js";
import { artifactOnCompletionFetcher, buildFetchersFor, type FetcherDeps } from "../services/fetchers.js";
import type { SyncEngine } from "../services/sync-engine.js";
import type { WorkflowStore } from "../services/workflow-store.js";
import type { Logger } from "../util/logger.js";
import { repoKey } from "../core/domain/types.js";

const PUSH_BURST_MS = 30_000;

/**
 * Top-level state machine. Reconciles (auth × repos) and hands the resulting
 * repo list to the sync engine.
 */
export class AppCoordinator implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private client: GitHubApi | null = null;

  constructor(
    private readonly auth: AuthService,
    private readonly repoWatcher: GitRepoWatcher,
    private readonly store: WorkflowStore,
    private readonly engine: SyncEngine,
    private readonly log: Logger,
    fetcherDeps: FetcherDeps,
  ) {
    engine.setRegistrar((ctx: RepoContext) => buildFetchersFor(ctx, fetcherDeps));
    engine.setOnCompletionBuilder((repo, run) => artifactOnCompletionFetcher(repo, run, fetcherDeps));

    this.disposables.push(
      auth.onDidChange(() => this.reconcile()),
      repoWatcher.onDidChange(() => this.reconcile()),
      repoWatcher.onDidPush((ctx) => {
        this.log.info(`push detected in ${ctx.coords.owner}/${ctx.coords.repo} → burst polling`);
        this.engine.burst(PUSH_BURST_MS);
      }),
    );
  }

  get api(): GitHubApi | null { return this.client; }

  async start(): Promise<void> {
    await this.repoWatcher.start();
    await this.auth.initialize();
    this.reconcile();
  }

  reconcile(): void {
    const token = this.auth.state.session?.accessToken;
    const contexts = this.repoWatcher.contexts;

    if (!token) {
      this.log.info("reconcile: no auth → unauthenticated");
      this.client = null;
      this.store.setStatus("unauthenticated");
      this.store.setRepos([]);
      this.engine.setRepos([]);
      this.engine.stop();
      return;
    }
    this.client = new GitHubClient(token, this.log);

    if (contexts.length === 0) {
      this.log.info("reconcile: authed, no GitHub repos in workspace → no-repo");
      this.store.setRepos([]);
      this.engine.setRepos([]);
      this.engine.stop();
      return;
    }

    const summary = contexts.map(shortLabel).join(", ");
    this.log.info(`reconcile: authed + [${summary}] → syncing`);
    this.store.setRepos(contexts.map((c) => ({ coords: c.coords, branch: c.branch })));
    this.engine.setRepos(contexts);
    this.engine.start();
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

function shortLabel(ctx: RepoContext): string {
  const key = repoKey(ctx.coords);
  return ctx.branch ? `${key}@${ctx.branch}` : key;
}
