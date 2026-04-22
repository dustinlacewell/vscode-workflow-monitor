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
import type { RepoCoordinates } from "../core/domain/types.js";
import { sameRepo } from "../core/domain/types.js";
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
 *   ├── owner/backend
 *   │   ├── Secrets
 *   │   ├── Variables
 *   │   └── Environments
 *   │       └── production
 *   │           ├── Secrets
 *   │           └── Variables
 *   └── owner/frontend
 *       └── …
 *
 * Multi-repo: every tracked repo appears as its own SettingsRepoNode at root.
 * Single-repo still renders a single SettingsRepoNode expanded-by-default.
 * Lazy per-env fetch stays in place — expanding a per-env Secrets subsection
 * triggers that one env's fetch if the eager pre-fetch didn't already cover it.
 */
export class SettingsTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  private readonly subscriptions: vscode.Disposable[] = [];

  readonly onDidChangeTreeData = this.emitter.event;

  // Kept for engine API compatibility — the engine no longer calls it.
  // Removing the method would force a signature change in extension.ts wiring.
  constructor(private readonly store: WorkflowStore, _engine: { refreshView: (view: "settings") => void }) {
    void _engine;
    this.subscriptions.push(store.onDidChange(() => this.emitter.fire(undefined)));
  }

  getTreeItem(element: TreeNode): vscode.TreeItem { return element; }

  getChildren(element?: TreeNode): TreeNode[] {
    const view = selectSettingsView(this.store.snapshot());
    if (!element) return renderRoot(view);
    if (element instanceof SettingsRepoNode) {
      const repoView = findRepo(view, element.repo);
      return repoView ? renderRepoChildren(repoView) : [];
    }
    if (element instanceof SettingsSectionNode) {
      const repoView = findRepo(view, element.repo);
      return repoView ? renderRepoSection(element, repoView) : [];
    }
    if (element instanceof EnvironmentNode) {
      const repoView = findRepo(view, element.repo);
      return repoView ? renderEnvChildren(element, repoView) : [];
    }
    if (element instanceof EnvironmentSubsectionNode) {
      const repoView = findRepo(view, element.repo);
      return repoView ? this.renderEnvSubsection(element, repoView) : [];
    }
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
      return [new MessageNode("Loading secrets…", "sync~spin")];
    }
    if (envView.secrets.items.length === 0) {
      return [new MessageNode("No secrets in this environment", "info")];
    }
    return envView.secrets.items.map((s) => new SecretNode(node.repo, { kind: "environment", name: envView.environment.name }, s));
  }

  private renderEnvVariables(
    node: EnvironmentSubsectionNode,
    envView: EnvironmentView,
  ): TreeNode[] {
    if (envView.variables.kind === "loading") {
      return [new MessageNode("Loading variables…", "sync~spin")];
    }
    if (envView.variables.items.length === 0) {
      return [new MessageNode("No variables in this environment", "info")];
    }
    return envView.variables.items.map((v) => new VariableNode(node.repo, { kind: "environment", name: envView.environment.name }, v));
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

function findRepo(view: SettingsView, repo: RepoCoordinates): SettingsRepoView | null {
  if (view.kind !== "repos") return null;
  return view.repos.find((r) => sameRepo(r.repo, repo)) ?? null;
}

function findEnv(repoView: SettingsRepoView, name: string): EnvironmentView | null {
  if (repoView.environments.kind !== "items") return null;
  return repoView.environments.items.find((e) => e.environment.name === name) ?? null;
}

function renderRepoChildren(repoView: SettingsRepoView): TreeNode[] {
  return [
    new SettingsSectionNode(repoView.repo, "secrets", scopeCount(repoView.repoSecrets)),
    new SettingsSectionNode(repoView.repo, "variables", scopeCount(repoView.repoVariables)),
    new SettingsSectionNode(repoView.repo, "environments", envSectionCount(repoView.environments)),
  ];
}

function renderRepoSection(node: SettingsSectionNode, repoView: SettingsRepoView): TreeNode[] {
  switch (node.section) {
    case "secrets":      return renderRepoSecrets(node.repo, repoView.repoSecrets);
    case "variables":    return renderRepoVariables(node.repo, repoView.repoVariables);
    case "environments": return renderEnvironments(node.repo, repoView.environments);
  }
}

function renderRepoSecrets(
  repo: RepoCoordinates,
  view: ScopeListView<Secret> | { kind: "error"; errorMessage: string },
): TreeNode[] {
  switch (view.kind) {
    case "loading":
      return [new MessageNode("Loading secrets…", "sync~spin")];
    case "error":
      return [new MessageNode(`Error: ${view.errorMessage}`, "error")];
    case "items":
      if (view.items.length === 0) return [new MessageNode("No repository secrets", "info")];
      return view.items.map((s) => new SecretNode(repo, { kind: "repo" }, s));
  }
}

function renderRepoVariables(
  repo: RepoCoordinates,
  view: ScopeListView<Variable> | { kind: "error"; errorMessage: string },
): TreeNode[] {
  switch (view.kind) {
    case "loading":
      return [new MessageNode("Loading variables…", "sync~spin")];
    case "error":
      return [new MessageNode(`Error: ${view.errorMessage}`, "error")];
    case "items":
      if (view.items.length === 0) return [new MessageNode("No repository variables", "info")];
      return view.items.map((v) => new VariableNode(repo, { kind: "repo" }, v));
  }
}

function renderEnvironments(repo: RepoCoordinates, view: SectionListView<EnvironmentView>): TreeNode[] {
  switch (view.kind) {
    case "loading":
      return [new MessageNode("Loading environments…", "sync~spin")];
    case "error":
      return [new MessageNode(`Error: ${view.errorMessage}`, "error")];
    case "items":
      if (view.items.length === 0) return [new MessageNode("No environments configured", "info")];
      return view.items.map((e) => new EnvironmentNode(repo, e.environment));
  }
}

function renderEnvChildren(node: EnvironmentNode, repoView: SettingsRepoView): TreeNode[] {
  const envView = findEnv(repoView, node.environment.name);
  if (!envView) return [];
  return [
    new EnvironmentSubsectionNode(node.repo, node.environment, "secrets", scopeCount(envView.secrets)),
    new EnvironmentSubsectionNode(node.repo, node.environment, "variables", scopeCount(envView.variables)),
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
