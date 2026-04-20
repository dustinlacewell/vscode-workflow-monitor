import * as vscode from "vscode";
import type { WorkflowStore } from "../services/workflow-store.js";
import type { ViewStateService } from "../services/view-state.js";
import type { BranchBanner, RootView } from "../core/selectors/root-view.js";
import { selectRootView } from "../core/selectors/root-view.js";
import { selectRunJobs, selectWorkflowRuns, type WorkflowRow } from "../core/selectors/runs.js";
import {
  JobNode,
  MessageNode,
  RunNode,
  StepNode,
  type TreeNode,
  WorkflowNode,
} from "./tree-items.js";

/**
 * Thin VS Code adapter over the pure selectors in `core/selectors/`. Every
 * branch in `getChildren` is a 1:1 translation of a selector view-model to
 * `TreeNode[]` — no filter/sort/state-machine logic lives here anymore.
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
    const filter = this.viewState.state.branchFilter;
    if (!element) return renderRootView(selectRootView(snap, filter));
    if (element instanceof WorkflowNode) {
      const view = selectWorkflowRuns(snap, element.workflow.id, filter);
      return renderWorkflowRuns(view);
    }
    if (element instanceof RunNode) {
      return renderRunJobs(selectRunJobs(snap, element.run.id));
    }
    if (element instanceof JobNode) return element.job.steps.map((s) => new StepNode(s, element.job));
    return [];
  }

  dispose(): void {
    this.subscriptions.forEach((s) => s.dispose());
    this.emitter.dispose();
    if (this.tickerTimer) clearInterval(this.tickerTimer);
  }
}

function renderRootView(view: RootView): TreeNode[] {
  switch (view.kind) {
    case "initializing":
      return [new MessageNode("Initializing…", "sync~spin")];
    case "no-repo":
      return [new MessageNode("No GitHub repository in this workspace", "repo")];
    case "unauthenticated":
      return [new MessageNode(
        "Sign in to GitHub to load workflows",
        "sign-in",
        view.errorMessage ?? undefined,
        { command: "workflowMonitor.signIn", title: "Sign in to GitHub" },
      )];
    case "error":
      return [new MessageNode(`Error: ${view.errorMessage}`, "error")];
    case "loading":
      return [new MessageNode("Loading workflows…", "sync~spin")];
    case "empty":
      return [new MessageNode("No workflows found in this repository", "info")];
    case "workflows":
      return renderWorkflowRows(view.banner, view.rows);
  }
}

function renderWorkflowRows(banner: BranchBanner | null, rows: readonly WorkflowRow[]): TreeNode[] {
  const nodes: TreeNode[] = rows.map((row) => new WorkflowNode(row.workflow, row.latestVisibleRun, row.visibleRunCount));
  if (banner) nodes.unshift(renderBranchBanner(banner));
  return nodes;
}

function renderBranchBanner(banner: BranchBanner): MessageNode {
  const toggle = { command: "workflowMonitor.toggleBranchFilter", title: "Toggle branch filter" };
  return banner.kind === "current"
    ? new MessageNode(`Filtering to branch: ${banner.branch}`, "git-branch", "Click to toggle to all branches", toggle)
    : new MessageNode(`Showing all branches`, "list-unordered", `Click to filter to ${banner.branch}`, toggle);
}

function renderWorkflowRuns(view: ReturnType<typeof selectWorkflowRuns>): TreeNode[] {
  switch (view.kind) {
    case "loading":
      return [new MessageNode("Loading runs…", "sync~spin")];
    case "empty":
      return view.reason === "none"
        ? [new MessageNode("No runs yet", "info")]
        : [new MessageNode(`No runs on ${view.branch ?? "current branch"}`, "info")];
    case "runs":
      return view.runs.map((r) => new RunNode(r));
  }
}

function renderRunJobs(view: ReturnType<typeof selectRunJobs>): TreeNode[] {
  switch (view.kind) {
    case "loading":
      return [new MessageNode("Loading jobs…", "sync~spin")];
    case "empty":
      return [new MessageNode("No jobs reported yet", "info")];
    case "jobs":
      return view.jobs.map((j) => new JobNode(j));
  }
}
