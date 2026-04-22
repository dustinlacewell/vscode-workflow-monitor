import * as vscode from "vscode";
import { AppCoordinator } from "./app/coordinator.js";
import { GitRepoWatcher } from "./data/git-repo.js";
import { ArtifactService } from "./services/artifact-service.js";
import { AuthService } from "./services/auth.js";
import { DiagnosticsService } from "./services/diagnostics-service.js";
import { selectInProgressRunCount } from "./core/selectors/runs.js";
import type { FetcherDeps } from "./services/fetchers.js";
import { LogService } from "./services/log-service.js";
import { NotificationService, type NotificationConfig } from "./services/notification-service.js";
import { SyncEngine, type SyncEngineConfig } from "./services/sync-engine.js";
import { ViewStateService } from "./services/view-state.js";
import { WorkflowDefinitionService } from "./services/workflow-definitions.js";
import { WorkflowStore } from "./services/workflow-store.js";
import { registerCommands } from "./ui/commands.js";
import { LogWebviewService } from "./ui/log-webview-panel.js";
import { SettingsTreeProvider } from "./ui/settings-tree-provider.js";
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

  // The engine needs the coordinator's API provider; the coordinator needs
  // the engine. A late-bound holder breaks the cycle without leaking a
  // mutable variable beyond this scope.
  const apiHolder: { coord: AppCoordinator | null } = { coord: null };
  const apiProvider = () => apiHolder.coord?.api ?? null;
  const engineConfig = readSyncConfig();
  const engine = new SyncEngine(apiProvider, store, log, engineConfig);

  const fetcherDeps: FetcherDeps = {
    apiProvider,
    store,
    log,
    runsPerWorkflow: () => engineConfig.runsPerWorkflow,
  };
  const coordinator = new AppCoordinator(auth, repoWatcher, store, engine, log, fetcherDeps);
  apiHolder.coord = coordinator;

  // --- higher-level feature services -------------------------------------
  const logs = new LogService(apiProvider);
  const logPanels = new LogWebviewService(context.extensionUri, logs, store, log);
  const artifacts = new ArtifactService(apiProvider);
  const definitions = new WorkflowDefinitionService(apiProvider);
  const diagnostics = new DiagnosticsService(logs, store, log);
  const notifications = new NotificationService(store, context.workspaceState, readNotificationConfig());

  context.subscriptions.push(
    store, auth, repoWatcher, viewState, engine, coordinator,
    logs, logPanels, definitions, diagnostics, notifications,
  );

  // --- UI ----------------------------------------------------------------
  const treeProvider = new WorkflowsTreeProvider(store, viewState);
  const treeView = vscode.window.createTreeView("workflowMonitor.workflows", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  const settingsTreeProvider = new SettingsTreeProvider(store, engine);
  const settingsTreeView = vscode.window.createTreeView("workflowMonitor.settings", {
    treeDataProvider: settingsTreeProvider,
    showCollapseAll: true,
  });

  // Hand both views to the engine so it can own all visibility-driven
  // fetches. onDidChangeVisibility here goes away — the engine runs its
  // own fetcher set when a view becomes visible.
  engine.registerVisibilitySource({
    id: "workflows",
    // Live getter — `treeView.visible` changes over time; capturing it at
    // registration would leave us reading a stale boolean when setRepos
    // asks whether to fire visibility fetchers post-repo-resolution.
    get visible() { return treeView.visible; },
    onDidChangeVisibility: treeView.onDidChangeVisibility,
  });
  engine.registerVisibilitySource({
    id: "settings",
    get visible() { return settingsTreeView.visible; },
    onDidChangeVisibility: settingsTreeView.onDidChangeVisibility,
  });

  const statusBar = new StatusBar(store, readStatusBarEnabled());
  const updateBadge = () => {
    const count = selectInProgressRunCount(store.snapshot());
    treeView.badge = count > 0
      ? { value: count, tooltip: `${count} workflow run${count === 1 ? "" : "s"} in progress` }
      : undefined;
  };
  updateBadge();
  context.subscriptions.push(
    treeProvider, treeView, settingsTreeProvider, settingsTreeView, statusBar,
    store.onDidChange(updateBadge),
  );

  // --- commands ----------------------------------------------------------
  context.subscriptions.push(registerCommands({
    coordinator, auth, store, engine, logs, logPanels, artifacts,
    definitions, diagnostics, notifications, viewState, log,
  }));

  // --- reactive config + workspace tweaks --------------------------------
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("workflowMonitor")) return;
      engine.updateConfig(readSyncConfig());
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

function readSyncConfig(): SyncEngineConfig {
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
