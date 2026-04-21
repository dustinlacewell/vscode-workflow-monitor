import * as vscode from "vscode";
import type {
  EnvironmentView,
  ScopeListView,
  SectionListView,
  SettingsRepoView,
  SettingsView,
} from "../core/selectors/settings.js";
import { selectSettingsView } from "../core/selectors/settings.js";
import type { Secret, Variable } from "../core/domain/secrets.js";
import type { SecretSync } from "../services/secret-sync.js";
import type { WorkflowStore } from "../services/workflow-store.js";
import {
  EnvironmentNode,
  EnvironmentSubsectionNode,
  MessageNode,
  SecretNode,
  SettingsRepoNode,
  SettingsSectionNode,
  VariableNode,
  type TreeNode,
} from "./tree-items.js";

/**
 * Settings tree:
 *
 *   Settings
 *   └── owner/repo
 *       ├── Secrets            (repo scope)
 *       │   └── API_TOKEN
 *       ├── Variables          (repo scope — placeholder)
 *       └── Environments
 *           └── production (2 protection rules)
 *               ├── Secrets
 *               │   └── DEPLOY_KEY
 *               └── Variables
 *
 * Env-scoped secrets load lazily: the per-env `Secrets` subsection only fires
 * a fetch when expanded, so entering a repo with 10 environments doesn't
 * produce 10 eager API calls up-front.
 */
export class SettingsTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly requestedEnvScopes = new Set<string>();

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly store: WorkflowStore,
    private readonly sync: SecretSync,
  ) {
    this.subscriptions.push(store.onDidChange(() => this.emitter.fire(undefined)));
  }

  resetLazyLoads(): void {
    this.requestedEnvScopes.clear();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem { return element; }

  getChildren(element?: TreeNode): TreeNode[] {
    const view = selectSettingsView(this.store.snapshot());
    if (!element) return renderRoot(view);
    const repoView = firstRepo(view);
    if (!repoView) return [];
    if (element instanceof SettingsRepoNode) return renderRepoChildren(repoView);
    if (element instanceof SettingsSectionNode) return renderRepoSection(element, repoView);
    if (element instanceof EnvironmentNode) return renderEnvChildren(element, repoView);
    if (element instanceof EnvironmentSubsectionNode) return this.renderEnvSubsection(element, repoView);
    return [];
  }

  private renderEnvSubsection(
    node: EnvironmentSubsectionNode,
    repoView: SettingsRepoView,
  ): TreeNode[] {
    const envView = findEnv(repoView, node.environment.name);
    if (!envView) return [];
    if (node.section === "variables") return this.renderEnvVariables(node, envView);
    return this.renderEnvSecrets(node, envView);
  }

  private renderEnvSecrets(
    node: EnvironmentSubsectionNode,
    envView: EnvironmentView,
  ): TreeNode[] {
    if (envView.secrets.kind === "loading") {
      this.ensureEnvFetch(node.environment.name);
      return [new MessageNode("Loading secrets…", "sync~spin")];
    }
    if (envView.secrets.items.length === 0) {
      return [new MessageNode("No secrets in this environment", "info")];
    }
    return envView.secrets.items.map((s) => new SecretNode({ kind: "environment", name: envView.environment.name }, s));
  }

  private renderEnvVariables(
    node: EnvironmentSubsectionNode,
    envView: EnvironmentView,
  ): TreeNode[] {
    if (envView.variables.kind === "loading") {
      this.ensureEnvFetch(node.environment.name);
      return [new MessageNode("Loading variables…", "sync~spin")];
    }
    if (envView.variables.items.length === 0) {
      return [new MessageNode("No variables in this environment", "info")];
    }
    return envView.variables.items.map((v) => new VariableNode({ kind: "environment", name: envView.environment.name }, v));
  }

  private ensureEnvFetch(envName: string): void {
    if (this.requestedEnvScopes.has(envName)) return;
    this.requestedEnvScopes.add(envName);
    void this.sync.refreshEnvironment(envName);
  }

  dispose(): void {
    this.subscriptions.forEach((s) => s.dispose());
    this.emitter.dispose();
  }
}

// --- rendering -------------------------------------------------------------

function renderRoot(view: SettingsView): TreeNode[] {
  switch (view.kind) {
    case "idle":
      return [new MessageNode("Initializing…", "sync~spin")];
    case "no-repo":
      return [new MessageNode("No GitHub repository in this workspace", "repo")];
    case "repos":
      return view.repos.map((r) => new SettingsRepoNode(r.repo));
  }
}

function firstRepo(view: SettingsView): SettingsRepoView | null {
  return view.kind === "repos" ? view.repos[0] ?? null : null;
}

function findEnv(repoView: SettingsRepoView, name: string): EnvironmentView | null {
  if (repoView.environments.kind !== "items") return null;
  return repoView.environments.items.find((e) => e.environment.name === name) ?? null;
}

function renderRepoChildren(repoView: SettingsRepoView): TreeNode[] {
  return [
    new SettingsSectionNode("secrets", scopeCount(repoView.repoSecrets)),
    new SettingsSectionNode("variables", scopeCount(repoView.repoVariables)),
    new SettingsSectionNode("environments", envSectionCount(repoView.environments)),
  ];
}

function renderRepoSection(node: SettingsSectionNode, repoView: SettingsRepoView): TreeNode[] {
  switch (node.section) {
    case "secrets":      return renderRepoSecrets(repoView.repoSecrets);
    case "variables":    return renderRepoVariables(repoView.repoVariables);
    case "environments": return renderEnvironments(repoView.environments);
  }
}

function renderRepoSecrets(
  view: ScopeListView<Secret> | { kind: "error"; errorMessage: string },
): TreeNode[] {
  switch (view.kind) {
    case "loading":
      return [new MessageNode("Loading secrets…", "sync~spin")];
    case "error":
      return [new MessageNode(`Error: ${view.errorMessage}`, "error")];
    case "items":
      if (view.items.length === 0) return [new MessageNode("No repository secrets", "info")];
      return view.items.map((s) => new SecretNode({ kind: "repo" }, s));
  }
}

function renderRepoVariables(
  view: ScopeListView<Variable> | { kind: "error"; errorMessage: string },
): TreeNode[] {
  switch (view.kind) {
    case "loading":
      return [new MessageNode("Loading variables…", "sync~spin")];
    case "error":
      return [new MessageNode(`Error: ${view.errorMessage}`, "error")];
    case "items":
      if (view.items.length === 0) return [new MessageNode("No repository variables", "info")];
      return view.items.map((v) => new VariableNode({ kind: "repo" }, v));
  }
}

function renderEnvironments(view: SectionListView<EnvironmentView>): TreeNode[] {
  switch (view.kind) {
    case "loading":
      return [new MessageNode("Loading environments…", "sync~spin")];
    case "error":
      return [new MessageNode(`Error: ${view.errorMessage}`, "error")];
    case "items":
      if (view.items.length === 0) return [new MessageNode("No environments configured", "info")];
      return view.items.map((e) => new EnvironmentNode(e.environment));
  }
}

function renderEnvChildren(node: EnvironmentNode, repoView: SettingsRepoView): TreeNode[] {
  const envView = findEnv(repoView, node.environment.name);
  if (!envView) return [];
  return [
    new EnvironmentSubsectionNode(node.environment, "secrets", scopeCount(envView.secrets)),
    new EnvironmentSubsectionNode(node.environment, "variables", scopeCount(envView.variables)),
  ];
}

function scopeCount<T>(view: ScopeListView<T> | { kind: "error"; errorMessage: string }): number | "loading" | undefined {
  if (view.kind === "loading") return "loading";
  if (view.kind === "error") return undefined;
  return view.items.length;
}

function envSectionCount(view: SectionListView<EnvironmentView>): number | "loading" | undefined {
  if (view.kind === "loading") return "loading";
  if (view.kind === "error") return undefined;
  return view.items.length;
}
