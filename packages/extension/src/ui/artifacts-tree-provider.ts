import * as vscode from "vscode";
import type { ArtifactGroupsView, ArtifactRunGroup } from "../core/selectors/artifacts.js";
import { selectArtifactGroups } from "../core/selectors/artifacts.js";
import type { WorkflowStore } from "../services/workflow-store.js";
import { ArtifactNode, ArtifactsRunHeaderNode, MessageNode, type TreeNode } from "./tree-items.js";

/**
 * Top-level Artifacts tree. Complementary to the inline artifacts-under-run
 * nodes in the Workflows tree — this view gives a cross-run, chronological
 * browsing surface, which is what you want when you're looking for "the
 * coverage report from the last green build" rather than navigating via a
 * specific workflow.
 */
export class ArtifactsTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  private readonly subscriptions: vscode.Disposable[] = [];

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly store: WorkflowStore) {
    this.subscriptions.push(store.onDidChange(() => this.emitter.fire(undefined)));
  }

  getTreeItem(element: TreeNode): vscode.TreeItem { return element; }

  getChildren(element?: TreeNode): TreeNode[] {
    const snap = this.store.snapshot();
    if (!element) return renderArtifactGroups(selectArtifactGroups(snap));
    if (element instanceof ArtifactsRunHeaderNode) {
      return element.group.items.map((a) => new ArtifactNode(element.group.run, a));
    }
    return [];
  }

  dispose(): void {
    this.subscriptions.forEach((s) => s.dispose());
    this.emitter.dispose();
  }
}

function renderArtifactGroups(view: ArtifactGroupsView): TreeNode[] {
  switch (view.kind) {
    case "loading":
      return [new MessageNode("Waiting for completed runs…", "sync~spin")];
    case "empty":
      return [new MessageNode("No artifacts across recent runs", "archive")];
    case "groups":
      return view.groups.map((g) => new ArtifactsRunHeaderNode(g));
  }
}

export { ArtifactRunGroup };
