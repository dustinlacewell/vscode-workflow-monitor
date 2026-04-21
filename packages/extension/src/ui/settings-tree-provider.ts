import * as vscode from "vscode";
import type {
  SectionListView,
  SecretsSectionView,
  SettingsRepoView,
  SettingsView,
  VariablesSectionView,
} from "../core/selectors/settings.js";
import { selectSettingsView } from "../core/selectors/settings.js";
import type { Environment } from "../core/domain/secrets.js";
import type { SecretSync } from "../services/secret-sync.js";
import type { WorkflowStore } from "../services/workflow-store.js";
import {
  EnvironmentNode,
  MessageNode,
  SecretNode,
  SecretScopeGroupNode,
  SettingsRepoNode,
  SettingsSectionNode,
  type TreeNode,
} from "./tree-items.js";

/**
 * Settings tree:
 *
 *   Settings
 *   └── owner/repo
 *       ├── Environments (N)
 *       │   ├── production (2 protection rules · updated 2h ago)
 *       │   └── staging
 *       ├── Secrets
 *       │   ├── Repository (3)
 *       │   ├── production (1)
 *       │   └── staging
 *       └── Variables  (coming soon)
 *
 * Mirrors upstream's nesting so users coming from the official extension see
 * the same shape. Per-scope lazy fetching — expanding an environment under
 * Secrets for the first time triggers the env-secrets fetch for that env
 * only, nothing eager at mount.
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
    if (element instanceof SettingsRepoNode) return renderRepoChildren(findRepoView(view, element));
    if (element instanceof SettingsSectionNode) return this.renderSection(element, view);
    if (element instanceof SecretScopeGroupNode) return this.renderSecretScope(element);
    return [];
  }

  private renderSection(node: SettingsSectionNode, view: SettingsView): TreeNode[] {
    if (view.kind !== "repos" || view.repos[0] === undefined) return [];
    const repo = view.repos[0];
    switch (node.section) {
      case "environments": return renderEnvironments(repo.environments);
      case "secrets":      return renderSecretsSection(repo.secrets);
      case "variables":    return renderVariablesSection(repo.variables);
    }
  }

  private renderSecretScope(node: SecretScopeGroupNode): TreeNode[] {
    if (node.group.view.kind === "loading") {
      if (node.group.scope.kind === "environment") {
        const key = `env:${node.group.scope.name}`;
        if (!this.requestedEnvScopes.has(key)) {
          this.requestedEnvScopes.add(key);
          void this.sync.refreshEnvironment(node.group.scope.name);
        }
      }
      return [new MessageNode("Loading secrets…", "sync~spin")];
    }
    if (node.group.view.items.length === 0) {
      return [new MessageNode("No secrets in this scope", "info")];
    }
    return node.group.view.items.map((s) => new SecretNode(node.group.scope, s));
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

function findRepoView(view: SettingsView, node: SettingsRepoNode): SettingsRepoView | null {
  if (view.kind !== "repos") return null;
  return view.repos.find((r) => r.repo.owner === node.repo.owner && r.repo.repo === node.repo.repo) ?? null;
}

function renderRepoChildren(repoView: SettingsRepoView | null): TreeNode[] {
  if (!repoView) return [];
  return [
    new SettingsSectionNode("environments", sectionCount(repoView.environments)),
    new SettingsSectionNode("secrets", secretsSectionCount(repoView.secrets)),
    new SettingsSectionNode("variables"),
  ];
}

function sectionCount<T>(view: SectionListView<T>): number | "loading" | undefined {
  if (view.kind === "loading") return "loading";
  if (view.kind === "error") return undefined;
  return view.items.length;
}

function secretsSectionCount(view: SecretsSectionView): number | "loading" | undefined {
  if (view.kind === "idle" || view.kind === "loading") return "loading";
  if (view.kind === "error") return undefined;
  let total = 0;
  if (view.repo.view.kind === "secrets") total += view.repo.view.items.length;
  for (const env of view.environments) if (env.view.kind === "secrets") total += env.view.items.length;
  return total;
}

function renderEnvironments(view: SectionListView<Environment>): TreeNode[] {
  switch (view.kind) {
    case "loading":
      return [new MessageNode("Loading environments…", "sync~spin")];
    case "error":
      return [new MessageNode(`Error: ${view.errorMessage}`, "error")];
    case "items":
      if (view.items.length === 0) return [new MessageNode("No environments configured", "info")];
      return view.items.map((e) => new EnvironmentNode(e));
  }
}

function renderSecretsSection(view: SecretsSectionView): TreeNode[] {
  switch (view.kind) {
    case "idle":
    case "loading":
      return [new MessageNode("Loading secrets…", "sync~spin")];
    case "error":
      return [new MessageNode(`Error: ${view.errorMessage}`, "error")];
    case "groups":
      return [view.repo, ...view.environments].map((g) => new SecretScopeGroupNode(g));
  }
}

function renderVariablesSection(_view: VariablesSectionView): TreeNode[] {
  return [new MessageNode(
    "Variables — not yet implemented",
    "tools",
    "This surface is planned but not wired up in this build.",
  )];
}
