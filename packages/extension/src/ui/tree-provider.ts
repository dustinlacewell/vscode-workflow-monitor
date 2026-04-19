import * as vscode from "vscode";
import type { StoreSnapshot, WorkflowStore } from "../services/workflow-store.js";
import type { ViewStateService } from "../services/view-state.js";
import type { WorkflowRun } from "../domain/types.js";
import {
  JobNode,
  MessageNode,
  RunNode,
  StepNode,
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
  private readonly subscriptions: vscode.Disposable[] = [];
  private tickerTimer: NodeJS.Timeout | null = null;

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly store: WorkflowStore,
    private readonly viewState: ViewStateService,
  ) {
    this.subscriptions.push(store.onDidChange(() => this.emitter.fire(undefined)));
    this.subscriptions.push(viewState.onDidChange(() => this.emitter.fire(undefined)));
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
    if (element instanceof JobNode) return element.job.steps.map((s) => new StepNode(s, element.job));
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
          { command: "workflowMonitor.signIn", title: "Sign in to GitHub" },
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
    const nodes: TreeNode[] = snap.workflows.map((wf) => {
      const runs = this.visibleRuns(snap.runsByWorkflowId.get(wf.id), snap);
      const latest = runs[0] ?? null;
      return new WorkflowNode(wf, latest, runs.length);
    });
    if (this.viewState.state.branchFilter === "current" && snap.branch) {
      nodes.unshift(new MessageNode(
        `Filtering to branch: ${snap.branch}`,
        "git-branch",
        "Click to toggle to all branches",
        { command: "workflowMonitor.toggleBranchFilter", title: "Toggle branch filter" },
      ));
    } else if (this.viewState.state.branchFilter === "all" && snap.branch) {
      nodes.unshift(new MessageNode(
        `Showing all branches`,
        "list-unordered",
        `Click to filter to ${snap.branch}`,
        { command: "workflowMonitor.toggleBranchFilter", title: "Toggle branch filter" },
      ));
    }
    return nodes;
  }

  private workflowChildren(node: WorkflowNode, snap: StoreSnapshot): TreeNode[] {
    const runs = snap.runsByWorkflowId.get(node.workflow.id);
    if (!runs) return [new MessageNode("Loading runs…", "sync~spin")];
    const visible = this.visibleRuns(runs, snap);
    if (visible.length === 0) {
      return runs.length === 0
        ? [new MessageNode("No runs yet", "info")]
        : [new MessageNode(`No runs on ${snap.branch ?? "current branch"}`, "info")];
    }
    return visible.map((r) => new RunNode(r));
  }

  private visibleRuns(runs: readonly WorkflowRun[] | undefined, snap: StoreSnapshot): readonly WorkflowRun[] {
    if (!runs) return [];
    if (this.viewState.state.branchFilter === "all") return runs;
    if (!snap.branch) return runs;
    return runs.filter((r) => r.headBranch === snap.branch);
  }

  private runChildren(node: RunNode, snap: StoreSnapshot): TreeNode[] {
    const jobs = snap.jobsByRunId.get(node.run.id);
    if (!jobs) return [new MessageNode("Loading jobs…", "sync~spin")];
    if (jobs.length === 0) return [new MessageNode("No jobs reported yet", "info")];
    return jobs.map((j) => new JobNode(j));
  }

  dispose(): void {
    this.subscriptions.forEach((s) => s.dispose());
    this.emitter.dispose();
    if (this.tickerTimer) clearInterval(this.tickerTimer);
  }
}
