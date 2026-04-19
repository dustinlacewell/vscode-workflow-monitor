import * as vscode from "vscode";
import { AppCoordinator } from "./app/coordinator.js";
import { GitRepoWatcher } from "./data/git-repo.js";
import { ArtifactService } from "./services/artifact-service.js";
import { AuthService } from "./services/auth.js";
import { DiagnosticsService } from "./services/diagnostics-service.js";
import { LiveSync, type LiveSyncConfig } from "./services/live-sync.js";
import { LogService } from "./services/log-service.js";
import { NotificationService, type NotificationConfig } from "./services/notification-service.js";
import { ViewStateService } from "./services/view-state.js";
import { WorkflowDefinitionService } from "./services/workflow-definitions.js";
import { WorkflowStore } from "./services/workflow-store.js";
import { registerCommands } from "./ui/commands.js";
import { LogWebviewService } from "./ui/log-webview-panel.js";
import { StatusBar } from "./ui/status-bar.js";
import { WorkflowsTreeProvider } from "./ui/tree-provider.js";
import { createLogger } from "./util/logger.js";

/**
 * Composition root. Instantiate services, wire cross-layer events, register
 * contributions. Anything with logic belongs elsewhere — this file should
 * read as a dependency graph.
 */
export function activate(context: vscode.ExtensionContext): void {
  const log = createLogger("GitHub Actions Monitor");
  context.subscriptions.push({ dispose: () => log.dispose() });

  // --- stateless / low-level services ------------------------------------
  const store = new WorkflowStore();
  const auth = new AuthService(log);
  const repoWatcher = new GitRepoWatcher(log);
  const viewState = new ViewStateService(context.workspaceState);

  // `sync` needs the coordinator's API provider; the coordinator needs
  // `sync` at construction. A late-bound holder breaks the cycle without
  // leaking a mutable variable beyond this scope.
  const apiHolder: { coord: AppCoordinator | null } = { coord: null };
  const apiProvider = () => apiHolder.coord?.api ?? null;

  const sync = new LiveSync(apiProvider, store, log, readSyncConfig());
  const coordinator = new AppCoordinator(auth, repoWatcher, store, sync, log);
  apiHolder.coord = coordinator;

  // --- higher-level feature services -------------------------------------
  const logs = new LogService(apiProvider);
  const logPanels = new LogWebviewService(context.extensionUri, logs, store, log);
  const artifacts = new ArtifactService(apiProvider);
  const definitions = new WorkflowDefinitionService(apiProvider);
  const diagnostics = new DiagnosticsService(logs, store, log);
  const notifications = new NotificationService(store, context.workspaceState, readNotificationConfig());

  context.subscriptions.push(
    store, auth, repoWatcher, viewState, sync, coordinator,
    logs, logPanels, definitions, diagnostics, notifications,
  );

  // --- UI ----------------------------------------------------------------
  const treeProvider = new WorkflowsTreeProvider(store, viewState);
  const treeView = vscode.window.createTreeView("workflowMonitor.workflows", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  const statusBar = new StatusBar(store, readStatusBarEnabled());
  context.subscriptions.push(treeProvider, treeView, statusBar);

  // --- commands ----------------------------------------------------------
  context.subscriptions.push(registerCommands({
    coordinator, auth, store, sync, logs, logPanels, artifacts, definitions,
    diagnostics, notifications, viewState, log,
  }));

  // --- reactive config + workspace tweaks --------------------------------
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("workflowMonitor")) return;
      sync.updateConfig(readSyncConfig());
      statusBar.setEnabled(readStatusBarEnabled());
      notifications.updateConfig(readNotificationConfig());
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      // Re-evaluate which repo in a multi-root workspace is "active" when
      // focus moves between folders. start() is idempotent after init.
      void repoWatcher.start();
    }),
  );

  // --- boot --------------------------------------------------------------
  void coordinator.start();
}

export function deactivate(): void { /* context.subscriptions owns teardown */ }

function readSyncConfig(): LiveSyncConfig {
  const cfg = vscode.workspace.getConfiguration("workflowMonitor");
  return {
    activePollIntervalMs: cfg.get<number>("activePollIntervalMs", 2500),
    idlePollIntervalMs: cfg.get<number>("idlePollIntervalMs", 30000),
    runsPerWorkflow: cfg.get<number>("runsPerWorkflow", 5),
  };
}

function readStatusBarEnabled(): boolean {
  return vscode.workspace.getConfiguration("workflowMonitor").get("showStatusBar", true);
}

function readNotificationConfig(): NotificationConfig {
  const cfg = vscode.workspace.getConfiguration("workflowMonitor");
  return {
    notifyOnFailure: cfg.get<boolean>("notifyOnFailure", false),
    notifyOnSuccess: cfg.get<boolean>("notifyOnSuccess", false),
    notifyOnActionRequired: cfg.get<boolean>("notifyOnActionRequired", true),
  };
}
