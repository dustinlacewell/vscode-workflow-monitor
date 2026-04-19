import * as vscode from "vscode";
import { GitHubClient } from "./data/github-client.js";
import { GitRepoWatcher } from "./data/git-repo.js";
import { AuthService } from "./services/auth.js";
import { LiveSync, type LiveSyncConfig } from "./services/live-sync.js";
import { WorkflowStore } from "./services/workflow-store.js";
import { RunNode, WorkflowNode, JobNode } from "./ui/tree-items.js";
import { WorkflowsTreeProvider } from "./ui/tree-provider.js";
import { StatusBar } from "./ui/status-bar.js";
import { createLogger } from "./util/logger.js";

/**
 * Composition root. Builds the dependency graph, wires cross-layer events,
 * and registers VS Code contributions. Nothing here contains business logic —
 * it should read like a wiring diagram.
 */
export function activate(context: vscode.ExtensionContext): void {
  const log = createLogger("GitHub Actions Monitor");
  context.subscriptions.push({ dispose: () => log.dispose() });

  // --- services ----------------------------------------------------------
  const store = new WorkflowStore();
  const auth = new AuthService(log);
  const repoWatcher = new GitRepoWatcher(log);

  let client: GitHubClient | null = null;
  const getClient = () => client;

  const sync = new LiveSync(getClient, store, log, readConfig());
  context.subscriptions.push(store, auth, repoWatcher, sync);

  // --- UI ----------------------------------------------------------------
  const treeProvider = new WorkflowsTreeProvider(store);
  const treeView = vscode.window.createTreeView("githubActionsMonitor.workflows", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  const statusBar = new StatusBar(store, vscode.workspace.getConfiguration("githubActionsMonitor").get("showStatusBar", true));
  context.subscriptions.push(treeProvider, treeView, statusBar);

  // --- wiring ------------------------------------------------------------
  const reconcile = (): void => {
    const token = auth.state.session?.accessToken;
    const ctx = repoWatcher.context;
    client = token ? new GitHubClient(token, log) : null;

    if (!client) {
      log.info("reconcile: no auth → unauthenticated");
      store.setStatus("unauthenticated");
      sync.setRepo(null);
      sync.stop();
      return;
    }
    if (!ctx) {
      log.info("reconcile: authed, no GitHub repo in workspace → no-repo");
      store.setRepo(null, null);
      sync.setRepo(null);
      sync.stop();
      return;
    }
    log.info(`reconcile: authed + ${ctx.coords.owner}/${ctx.coords.repo}@${ctx.branch ?? "?"} → syncing`);
    store.setRepo(ctx.coords, ctx.branch);
    sync.setRepo(ctx.coords);
    sync.start();
  };

  context.subscriptions.push(
    auth.onDidChange(() => reconcile()),
    repoWatcher.onDidChange(() => reconcile()),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("githubActionsMonitor")) return;
      const cfg = vscode.workspace.getConfiguration("githubActionsMonitor");
      sync.updateConfig(readConfig());
      statusBar.setEnabled(cfg.get("showStatusBar", true));
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      // Re-evaluate which repo in a multi-root workspace is "active".
      // The watcher listens to git-state changes, but not editor focus.
      // Firing manually is cheap; no-op if nothing changed.
      void repoWatcher.start(); // idempotent; triggers recompute via internal listeners
    }),
  );

  // --- commands ----------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand("githubActionsMonitor.signIn", async () => {
      const state = await auth.signIn();
      if (!state.session) vscode.window.showWarningMessage("GitHub sign-in was cancelled.");
    }),
    vscode.commands.registerCommand("githubActionsMonitor.refresh", () => sync.refresh()),
    vscode.commands.registerCommand("githubActionsMonitor.openUrl", (url: unknown) => {
      if (typeof url !== "string" || url.length === 0) return;
      void vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand("githubActionsMonitor.openInBrowser", (node?: WorkflowNode | RunNode | JobNode) => {
      const url = pickUrl(node, store);
      if (url) void vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand("githubActionsMonitor.rerunWorkflow", async (node?: RunNode) => {
      if (!node || !client || !repoWatcher.context) return;
      try {
        await client.rerunWorkflow(repoWatcher.context.coords, node.run.id);
        vscode.window.showInformationMessage(`Re-running #${node.run.runNumber}…`);
        sync.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Re-run failed: ${errMsg(err)}`);
      }
    }),
    vscode.commands.registerCommand("githubActionsMonitor.cancelRun", async (node?: RunNode) => {
      if (!node || !client || !repoWatcher.context) return;
      const confirm = await vscode.window.showWarningMessage(
        `Cancel run #${node.run.runNumber}?`,
        { modal: true },
        "Cancel run",
      );
      if (confirm !== "Cancel run") return;
      try {
        await client.cancelRun(repoWatcher.context.coords, node.run.id);
        sync.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Cancel failed: ${errMsg(err)}`);
      }
    }),
    vscode.commands.registerCommand("githubActionsMonitor.viewLogs", (node?: RunNode) => {
      if (!node) return;
      void vscode.env.openExternal(vscode.Uri.parse(node.run.htmlUrl));
    }),
  );

  // --- boot --------------------------------------------------------------
  void (async () => {
    await repoWatcher.start();
    await auth.initialize();
    reconcile();
  })();
}

export function deactivate(): void {
  /* context.subscriptions handles all teardown */
}

function readConfig(): LiveSyncConfig {
  const cfg = vscode.workspace.getConfiguration("githubActionsMonitor");
  return {
    activePollIntervalMs: cfg.get<number>("activePollIntervalMs", 2500),
    idlePollIntervalMs: cfg.get<number>("idlePollIntervalMs", 30000),
    runsPerWorkflow: cfg.get<number>("runsPerWorkflow", 5),
  };
}

function pickUrl(node: WorkflowNode | RunNode | JobNode | undefined, store: WorkflowStore): string | null {
  if (node instanceof WorkflowNode) return node.workflow.htmlUrl;
  if (node instanceof RunNode) return node.run.htmlUrl;
  if (node instanceof JobNode) return node.job.htmlUrl;
  // Status-bar click: jump to the most recent run, falling back to Actions tab.
  const snap = store.snapshot();
  for (const runs of snap.runsByWorkflowId.values()) {
    if (runs[0]) return runs[0].htmlUrl;
  }
  if (snap.repo) return `https://github.com/${snap.repo.owner}/${snap.repo.repo}/actions`;
  return null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
