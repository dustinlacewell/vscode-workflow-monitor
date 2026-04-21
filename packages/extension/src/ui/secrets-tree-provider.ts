import * as vscode from "vscode";
import type { SecretGroup, SecretsView } from "../core/selectors/secrets.js";
import { selectSecretsView } from "../core/selectors/secrets.js";
import type { SecretSync } from "../services/secret-sync.js";
import type { WorkflowStore } from "../services/workflow-store.js";
import { MessageNode, SecretNode, SecretScopeGroupNode, type TreeNode } from "./tree-items.js";

/**
 * Top-level Secrets tree. Renders the selector view-model verbatim; the
 * per-scope loading states drive lazy fetching — expanding an environment
 * group for the first time asks SecretSync for that scope only.
 */
export class SecretsTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly requested = new Set<string>();

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly store: WorkflowStore,
    private readonly sync: SecretSync,
  ) {
    this.subscriptions.push(store.onDidChange(() => this.emitter.fire(undefined)));
  }

  /** Called by the extension wiring when a repo becomes known/changes. */
  resetLazyLoads(): void {
    this.requested.clear();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem { return element; }

  getChildren(element?: TreeNode): TreeNode[] {
    const snap = this.store.snapshot();
    if (!element) return renderRoot(selectSecretsView(snap));
    if (element instanceof SecretScopeGroupNode) {
      return this.renderGroup(element.group);
    }
    return [];
  }

  private renderGroup(group: SecretGroup): TreeNode[] {
    if (group.view.kind === "loading") {
      // Fire the per-scope fetch once on first expansion so environment
      // secrets don't all pre-fetch on mount.
      if (group.scope.kind === "environment") {
        const key = `env:${group.scope.name}`;
        if (!this.requested.has(key)) {
          this.requested.add(key);
          void this.sync.refreshEnvironment(group.scope.name);
        }
      }
      return [new MessageNode("Loading secrets…", "sync~spin")];
    }
    if (group.view.items.length === 0) {
      return [new MessageNode("No secrets in this scope", "info")];
    }
    return group.view.items.map((s) => new SecretNode(group.scope, s));
  }

  dispose(): void {
    this.subscriptions.forEach((s) => s.dispose());
    this.emitter.dispose();
  }
}

function renderRoot(view: SecretsView): TreeNode[] {
  switch (view.kind) {
    case "idle":
      return [new MessageNode("Open this view to load secrets", "key")];
    case "loading":
      return [new MessageNode("Loading secrets…", "sync~spin")];
    case "error":
      return [new MessageNode(`Error: ${view.errorMessage}`, "error")];
    case "groups":
      return [view.repo, ...view.environments].map((g) => new SecretScopeGroupNode(g));
  }
}
