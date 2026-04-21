import * as vscode from "vscode";
import type { JobContext, RepoCoordinates, RepoKey, WorkflowRun } from "../core/domain/types.js";
import { repoKey } from "../core/domain/types.js";
import type { WorkflowStore } from "./workflow-store.js";

export interface NotificationConfig {
  notifyOnFailure: boolean;
  notifyOnSuccess: boolean;
  notifyOnActionRequired: boolean;
}

/**
 * Opt-in VS Code notifications when runs complete.
 *
 * To avoid spamming on first boot (when we see a big batch of recent runs
 * for the first time), the service seeds its "already-notified" set on
 * start-up and only fires for runs that transition while it's watching.
 *
 * Per-workspace so dismissing/acking a run in one project doesn't bleed
 * into another.
 */
export class NotificationService implements vscode.Disposable {
  private static readonly STATE_KEY = "notified.v1";

  private readonly subscription: vscode.Disposable;
  private seeded = false;
  private notified: Set<number>;
  private config: NotificationConfig;

  constructor(
    private readonly store: WorkflowStore,
    private readonly memento: vscode.Memento,
    config: NotificationConfig,
  ) {
    this.notified = new Set(memento.get<number[]>(NotificationService.STATE_KEY, []));
    this.config = config;
    this.subscription = store.onDidChange(() => this.react());
  }

  updateConfig(config: NotificationConfig): void { this.config = config; }

  dispose(): void { this.subscription.dispose(); }

  // --- internals ---------------------------------------------------------

  private react(): void {
    const snap = this.store.snapshot();
    // On first state observation, seed and bail — we don't notify on initial load.
    if (!this.seeded) {
      for (const per of snap.repos.values()) {
        for (const runs of per.runsByWorkflowId.values()) for (const r of runs) this.notified.add(r.id);
      }
      this.seeded = true;
      this.persist();
      return;
    }

    for (const per of snap.repos.values()) {
      for (const [workflowId, runs] of per.runsByWorkflowId) {
        for (const r of runs) {
          if (r.status !== "completed") continue;
          if (this.notified.has(r.id)) continue;
          this.notified.add(r.id);
          this.showFor(r, per.repo, per.workflows.find((w) => w.id === workflowId)?.name ?? "workflow");
        }
      }
    }
    this.trimNotifiedSet(snap);
    this.persist();
  }

  private showFor(run: WorkflowRun, repo: RepoCoordinates, workflowName: string): void {
    const key = repoKey(repo);
    const branch = run.headBranch ? ` on \`${run.headBranch}\`` : "";
    const openAction = "Open on GitHub";
    const copyFailure = "Copy Failure Context";

    switch (run.conclusion) {
      case "success":
        if (this.config.notifyOnSuccess) {
          vscode.window.showInformationMessage(
            `✔ ${workflowName} #${run.runNumber}${branch} succeeded`,
            openAction,
          ).then((choice) => { if (choice === openAction) void vscode.env.openExternal(vscode.Uri.parse(run.htmlUrl)); });
        }
        return;
      case "failure":
      case "startup_failure":
      case "timed_out":
        if (this.config.notifyOnFailure) {
          const failingJobCtx = findFailingJob(this.store, key, run.id);
          const actions = [openAction];
          if (failingJobCtx) actions.unshift(copyFailure);
          vscode.window.showErrorMessage(
            `✘ ${workflowName} #${run.runNumber}${branch} ${run.conclusion}`,
            ...actions,
          ).then((choice) => {
            if (choice === openAction) void vscode.env.openExternal(vscode.Uri.parse(run.htmlUrl));
            else if (choice === copyFailure && failingJobCtx) {
              // Delegate to the existing command so we stay DRY.
              void vscode.commands.executeCommand(
                "workflowMonitor.copyFailureContextForJob",
                key,
                failingJobCtx.job.id,
                failingJobCtx.run.id,
              );
            }
          });
        }
        return;
      case "action_required":
        if (this.config.notifyOnActionRequired) {
          vscode.window.showWarningMessage(
            `⚠ ${workflowName} #${run.runNumber}${branch} is awaiting approval`,
            openAction,
          ).then((choice) => { if (choice === openAction) void vscode.env.openExternal(vscode.Uri.parse(run.htmlUrl)); });
        }
        return;
      default:
        // cancelled, skipped, neutral → don't ping the user
        return;
    }
  }

  /** Keep the notified set from growing unbounded — evict runs the store no longer knows. */
  private trimNotifiedSet(snap: ReturnType<WorkflowStore["snapshot"]>): void {
    const live = new Set<number>();
    for (const per of snap.repos.values()) {
      for (const runs of per.runsByWorkflowId.values()) for (const r of runs) live.add(r.id);
    }
    for (const id of [...this.notified]) if (!live.has(id)) this.notified.delete(id);
  }

  private persist(): void {
    void this.memento.update(NotificationService.STATE_KEY, [...this.notified]);
  }
}

function findFailingJob(store: WorkflowStore, key: RepoKey, runId: number): JobContext | null {
  const per = store.snapshot().repos.get(key);
  if (!per) return null;
  const jobs = per.jobsByRunId.get(runId);
  if (!jobs) return null;
  const failing = jobs.find((j) => j.conclusion === "failure" || j.conclusion === "timed_out" || j.conclusion === "startup_failure");
  if (!failing) return null;
  return store.resolveJob(key, runId, failing.id);
}
