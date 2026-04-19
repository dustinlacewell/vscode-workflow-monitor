import * as vscode from "vscode";
import type { StoreSnapshot, WorkflowStore } from "../services/workflow-store.js";
import {
  JobNode,
  MessageNode,
  RunNode,
  type TreeNode,
  WorkflowNode,
} from "./tree-items.js";

/**
 * Translates the reactive WorkflowStore snapshot into a TreeDataProvider.
 *
 * Each state transition fires onDidChangeTreeData(undefined) — VS Code will
 * re-query getChildren for visible nodes only, so this is cheap even with
 * many workflows.
 */
export class WorkflowsTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  private readonly subscription: vscode.Disposable;
  private tickerTimer: NodeJS.Timeout | null = null;

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly store: WorkflowStore) {
    this.subscription = store.onDidChange(() => this.emitter.fire(undefined));
    // Relative timestamps ("32s ago") go stale without data changes — refresh
    // the tree once a minute so labels stay honest without re-fetching.
    this.tickerTimer = setInterval(() => this.emitter.fire(undefined), 60_000);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem { return element; }

  getChildren(element?: TreeNode): TreeNode[] {
    const snap = this.store.snapshot();
    if (!element) return this.rootChildren(snap);
    if (element instanceof WorkflowNode) return this.workflowChildren(element, snap);
    if (element instanceof RunNode) return this.runChildren(element, snap);
    return [];
  }

  private rootChildren(snap: StoreSnapshot): TreeNode[] {
    switch (snap.status) {
      case "no-repo":
        return [new MessageNode("No GitHub repository in this workspace", "repo")];
      case "unauthenticated":
        return [new MessageNode(
          "Sign in to GitHub to load workflows",
          "sign-in",
          snap.errorMessage ?? undefined,
          { command: "githubActionsMonitor.signIn", title: "Sign in to GitHub" },
        )];
      case "error":
        return [new MessageNode(`Error: ${snap.errorMessage ?? "unknown"}`, "error")];
      case "loading":
        if (snap.workflows.length === 0) return [new MessageNode("Loading workflows…", "sync~spin")];
        break;
      case "idle":
        return [new MessageNode("Initializing…", "sync~spin")];
      case "ready":
        break;
    }
    if (snap.workflows.length === 0) {
      return [new MessageNode("No workflows found in this repository", "info")];
    }
    return snap.workflows.map((wf) => {
      const runs = snap.runsByWorkflowId.get(wf.id) ?? [];
      const latest = runs[0] ?? null;
      return new WorkflowNode(wf, latest, runs.length);
    });
  }

  private workflowChildren(node: WorkflowNode, snap: StoreSnapshot): TreeNode[] {
    const runs = snap.runsByWorkflowId.get(node.workflow.id);
    if (!runs) return [new MessageNode("Loading runs…", "sync~spin")];
    if (runs.length === 0) return [new MessageNode("No runs yet", "info")];
    return runs.map((r) => new RunNode(r));
  }

  private runChildren(node: RunNode, snap: StoreSnapshot): TreeNode[] {
    const jobs = snap.jobsByRunId.get(node.run.id);
    if (!jobs) {
      // Jobs are only fetched while a run is active. For completed runs we
      // surface a clickable link to the GitHub run page rather than fire an
      // extra request per expansion.
      if (node.run.status !== "completed") return [new MessageNode("Loading jobs…", "sync~spin")];
      return [new MessageNode(
        "Open run on GitHub for logs →",
        "link-external",
        undefined,
        { command: "githubActionsMonitor.openUrl", title: "Open run on GitHub", arguments: [node.run.htmlUrl] },
      )];
    }
    if (jobs.length === 0) return [new MessageNode("No jobs reported yet", "info")];
    return jobs.map((j) => new JobNode(j));
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
    if (this.tickerTimer) clearInterval(this.tickerTimer);
  }
}
