import * as vscode from "vscode";
import type { WorkflowStore } from "../services/workflow-store.js";
import type { ViewStateService } from "../services/view-state.js";
import type { AuthFailure } from "../core/auth/failure.js";
import { missingScopes, summariseAuthFailure } from "../core/auth/failure.js";
import { selectRunArtifacts } from "../core/selectors/artifacts.js";
import type { BranchBanner, RootView } from "../core/selectors/root-view.js";
import { selectRootView } from "../core/selectors/root-view.js";
import { selectRunJobs, selectWorkflowRuns, type WorkflowRow } from "../core/selectors/runs.js";
import type { WorkflowRun } from "../core/domain/types.js";
import {
  ArtifactNode,
  ArtifactsGroupNode,
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
      return renderRunChildren(
        element.run,
        selectRunJobs(snap, element.run.id),
        selectRunArtifacts(snap, element.run.id),
      );
    }
    if (element instanceof JobNode) return element.job.steps.map((s) => new StepNode(s, element.job));
    if (element instanceof ArtifactsGroupNode) {
      return element.artifacts?.map((a) => new ArtifactNode(element.run, a)) ?? [];
    }
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
      return renderUnauthenticated(view.authFailure, view.errorMessage);
    case "error":
      return renderError(view.authFailure, view.errorMessage);
    case "loading":
      return [new MessageNode("Loading workflows…", "sync~spin")];
    case "empty":
      return [new MessageNode("No workflows found in this repository", "info")];
    case "workflows":
      return renderWorkflowRows(view.banner, view.rows);
  }
}

const RECONNECT_COMMAND: vscode.Command = { command: "workflowMonitor.signIn", title: "Sign in to GitHub" };
const DETAILS_COMMAND: vscode.Command = { command: "workflowMonitor.showAuthDetails", title: "Show details" };

function renderUnauthenticated(failure: AuthFailure | null, fallbackMessage: string | null): TreeNode[] {
  if (!failure) {
    return [new MessageNode(
      "Sign in to GitHub to load workflows",
      "sign-in",
      fallbackMessage ?? undefined,
      RECONNECT_COMMAND,
    )];
  }
  return renderFailureBanner(failure, { signInLabel: "Click to reconnect to GitHub" });
}

function renderError(failure: AuthFailure | null, message: string): TreeNode[] {
  if (!failure) return [new MessageNode(`Error: ${message}`, "error")];
  return renderFailureBanner(failure, { signInLabel: "Click to retry after reconnecting" });
}

function renderFailureBanner(failure: AuthFailure, opts: { signInLabel: string }): TreeNode[] {
  const nodes: TreeNode[] = [
    new MessageNode(
      summariseAuthFailure(failure),
      iconForFailureKind(failure),
      buildFailureTooltip(failure, opts.signInLabel),
      RECONNECT_COMMAND,
    ),
    new MessageNode(
      "Show details\u2026",
      "info",
      `Open failure details for ${failure.route ?? "GitHub API call"}`,
      { ...DETAILS_COMMAND, arguments: [failure] },
    ),
  ];
  return nodes;
}

function iconForFailureKind(failure: AuthFailure): string {
  switch (failure.kind) {
    case "bad-credentials":
    case "insufficient-scope":
      return "shield";
    case "forbidden":
      return "lock";
    case "not-found":
      return "question";
    case "server-error":
      return "server";
    case "network":
      return "debug-disconnect";
    case "other":
      return "error";
  }
}

function buildFailureTooltip(failure: AuthFailure, signInLabel: string): string {
  const parts = [signInLabel];
  if (failure.route) parts.push(`Endpoint: ${failure.route}`);
  const missing = missingScopes(failure);
  if (missing.length > 0) parts.push(`Missing scope: ${missing.join(", ")}`);
  if (failure.currentScopes && failure.currentScopes.length > 0) {
    parts.push(`Token scopes: ${failure.currentScopes.join(", ")}`);
  }
  return parts.join("\n");
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

function renderRunChildren(
  run: WorkflowRun,
  jobs: ReturnType<typeof selectRunJobs>,
  artifacts: ReturnType<typeof selectRunArtifacts>,
): TreeNode[] {
  const nodes = renderRunJobs(jobs);
  const group = renderArtifactsGroup(run, artifacts);
  if (group) nodes.push(group);
  return nodes;
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

/**
 * The artifacts row only appears when there's something worth showing.
 * "hidden" (run still in flight) and "empty" (run completed, nothing produced)
 * both suppress the node — otherwise every job list would grow a noisy
 * "Artifacts: 0" row.
 */
function renderArtifactsGroup(
  run: WorkflowRun,
  view: ReturnType<typeof selectRunArtifacts>,
): ArtifactsGroupNode | null {
  switch (view.kind) {
    case "hidden":
    case "empty":
      return null;
    case "loading":
      return new ArtifactsGroupNode(run, null);
    case "artifacts":
      return new ArtifactsGroupNode(run, view.items);
  }
}
