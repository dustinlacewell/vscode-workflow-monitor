import * as vscode from "vscode";
import type { WorkflowStore } from "../services/workflow-store.js";
import type { ViewStateService } from "../services/view-state.js";
import type { AuthFailure } from "../core/auth/failure.js";
import { missingScopes, summariseAuthFailure } from "../core/auth/failure.js";
import { selectRunArtifacts } from "../core/selectors/artifacts.js";
import type { BranchBanner, RepoBodyView, RepoView, RootView } from "../core/selectors/root-view.js";
import { selectRootView } from "../core/selectors/root-view.js";
import { selectRunJobs, selectWorkflowRuns, type WorkflowRow } from "../core/selectors/runs.js";
import type { PerRepoState } from "../core/store/snapshot.js";
import type { RepoCoordinates } from "../core/domain/types.js";
import { repoKey } from "../core/domain/types.js";
import {
  ArtifactNode,
  ArtifactsGroupNode,
  JobNode,
  MessageNode,
  RunNode,
  StepNode,
  type TreeNode,
  WorkflowNode,
  WorkflowsRepoNode,
} from "./tree-items.js";

/**
 * Thin VS Code adapter over the pure selectors in `core/selectors/`.
 *
 * Multi-repo aware: when the workspace tracks a single GitHub repo the tree
 * renders flat (exactly as it did before this refactor). When more than one
 * repo is tracked, each appears as a WorkflowsRepoNode at the root,
 * expanding to its own workflow list. The branching lives entirely in
 * `renderRootView`; everything below is shape-identical.
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

    if (element instanceof WorkflowsRepoNode) {
      const per = snap.repos.get(repoKey(element.repo));
      if (!per) return [];
      return renderRepoBody(per, filter);
    }
    if (element instanceof WorkflowNode) {
      const per = snap.repos.get(repoKey(element.repo));
      if (!per) return [];
      return renderWorkflowRuns(element.repo, selectWorkflowRuns(per, element.workflow.id, filter));
    }
    if (element instanceof RunNode) {
      const per = snap.repos.get(repoKey(element.repo));
      if (!per) return [];
      return renderRunChildren(element.repo, element.run, selectRunJobs(per, element.run.id), selectRunArtifacts(per, element.run.id));
    }
    if (element instanceof JobNode) return element.job.steps.map((s) => new StepNode(element.repo, s, element.job));
    if (element instanceof ArtifactsGroupNode) {
      return element.artifacts?.map((a) => new ArtifactNode(element.repo, element.run, a)) ?? [];
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
    case "repos":
      return renderRepos(view.repos);
  }
}

function renderRepos(repos: readonly RepoView[]): TreeNode[] {
  if (repos.length === 0) return [new MessageNode("No repositories tracked", "info")];
  if (repos.length === 1) {
    // Single-repo: render that repo's body directly at root, skipping the
    // repo wrapper entirely. Existing single-repo UX is unchanged.
    return renderRepoBodyFromView(repos[0]!);
  }
  // Multi-repo: each becomes a WorkflowsRepoNode carrying its own body.
  return repos.map((r) => new WorkflowsRepoNode(
    r.repo.repo,
    r.repo.workflows.length,
    r.repo.branch,
  ));
}

function renderRepoBody(per: PerRepoState, filter: "all" | "current"): TreeNode[] {
  // For a WorkflowsRepoNode expansion we need to re-derive the body — we
  // could cache the selector's output but the cost is negligible.
  if (per.errorMessage) return [new MessageNode(`Error: ${per.errorMessage}`, "error")];
  if (per.workflows.length === 0) return [new MessageNode("No workflows in this repository", "info")];

  const rows = per.workflows.map((wf) => {
    const runs = per.runsByWorkflowId.get(wf.id);
    const visible = filter === "all" || !per.branch
      ? runs ?? []
      : (runs ?? []).filter((r) => r.headBranch === per.branch);
    return { workflow: wf, latestVisibleRun: visible[0] ?? null, visibleRunCount: visible.length };
  });
  const banner: BranchBanner | null = per.branch
    ? (filter === "current" ? { kind: "current", branch: per.branch } : { kind: "all", branch: per.branch })
    : null;
  return renderWorkflowRows(per.repo, banner, rows);
}

function renderRepoBodyFromView(view: RepoView): TreeNode[] {
  return renderRepoBodyView(view.repo.repo, view.body);
}

function renderRepoBodyView(repo: RepoCoordinates, body: RepoBodyView): TreeNode[] {
  switch (body.kind) {
    case "error":
      return [new MessageNode(`Error: ${body.errorMessage}`, "error")];
    case "empty":
      return [new MessageNode("No workflows found in this repository", "info")];
    case "workflows":
      return renderWorkflowRows(repo, body.banner, body.rows);
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
  return [
    new MessageNode(
      summariseAuthFailure(failure),
      iconForFailureKind(failure),
      buildFailureTooltip(failure, opts.signInLabel),
      RECONNECT_COMMAND,
    ),
    new MessageNode(
      "Show details…",
      "info",
      `Open failure details for ${failure.route ?? "GitHub API call"}`,
      { ...DETAILS_COMMAND, arguments: [failure] },
    ),
  ];
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

function renderWorkflowRows(repo: RepoCoordinates, banner: BranchBanner | null, rows: readonly WorkflowRow[]): TreeNode[] {
  const nodes: TreeNode[] = rows.map((row) => new WorkflowNode(repo, row.workflow, row.latestVisibleRun, row.visibleRunCount));
  if (banner) nodes.unshift(renderBranchBanner(banner));
  return nodes;
}

function renderBranchBanner(banner: BranchBanner): MessageNode {
  const toggle = { command: "workflowMonitor.toggleBranchFilter", title: "Toggle branch filter" };
  return banner.kind === "current"
    ? new MessageNode(`Filtering to branch: ${banner.branch}`, "git-branch", "Click to toggle to all branches", toggle)
    : new MessageNode(`Showing all branches`, "list-unordered", `Click to filter to ${banner.branch}`, toggle);
}

function renderWorkflowRuns(repo: RepoCoordinates, view: ReturnType<typeof selectWorkflowRuns>): TreeNode[] {
  switch (view.kind) {
    case "loading":
      return [new MessageNode("Loading runs…", "sync~spin")];
    case "empty":
      return view.reason === "none"
        ? [new MessageNode("No runs yet", "info")]
        : [new MessageNode(`No runs on ${view.branch ?? "current branch"}`, "info")];
    case "runs":
      return view.runs.map((r) => new RunNode(repo, r));
  }
}

function renderRunChildren(
  repo: RepoCoordinates,
  run: import("../core/domain/types.js").WorkflowRun,
  jobs: ReturnType<typeof selectRunJobs>,
  artifacts: ReturnType<typeof selectRunArtifacts>,
): TreeNode[] {
  const nodes = renderRunJobs(repo, jobs);
  const group = renderArtifactsGroup(repo, run, artifacts);
  if (group) nodes.push(group);
  return nodes;
}

function renderRunJobs(repo: RepoCoordinates, view: ReturnType<typeof selectRunJobs>): TreeNode[] {
  switch (view.kind) {
    case "loading":
      return [new MessageNode("Loading jobs…", "sync~spin")];
    case "empty":
      return [new MessageNode("No jobs reported yet", "info")];
    case "jobs":
      return view.jobs.map((j) => new JobNode(repo, j));
  }
}

function renderArtifactsGroup(
  repo: RepoCoordinates,
  run: import("../core/domain/types.js").WorkflowRun,
  view: ReturnType<typeof selectRunArtifacts>,
): ArtifactsGroupNode | null {
  switch (view.kind) {
    case "hidden":
    case "empty":
      return null;
    case "loading":
      return new ArtifactsGroupNode(repo, run, null);
    case "artifacts":
      return new ArtifactsGroupNode(repo, run, view.items);
  }
}
