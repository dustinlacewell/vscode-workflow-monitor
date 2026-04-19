import * as vscode from "vscode";
import { isActiveStatus, type WorkflowRun } from "../domain/types.js";
import type { StoreSnapshot, WorkflowStore } from "../services/workflow-store.js";

/**
 * Status-bar badge reflecting the most recent run on the current branch
 * (falling back to the most recent run overall).
 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscription: vscode.Disposable;
  private enabled: boolean;

  constructor(private readonly store: WorkflowStore, enabled: boolean) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "githubActionsMonitor.openInBrowser";
    this.enabled = enabled;
    this.subscription = store.onDidChange((snap) => this.render(snap));
    this.render(store.snapshot());
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.item.hide();
    else this.render(this.store.snapshot());
  }

  private render(snap: StoreSnapshot): void {
    if (!this.enabled) { this.item.hide(); return; }
    if (!snap.repo || snap.status === "no-repo") { this.item.hide(); return; }

    const latest = findLatestRun(snap);
    if (!latest) {
      this.item.text = "$(github-action) Actions";
      this.item.tooltip = "No runs yet";
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }

    const { icon, bgColor } = visualsFor(latest);
    const branch = latest.headBranch ? ` ${latest.headBranch}` : "";
    this.item.text = `${icon} #${latest.runNumber}${branch}`;
    this.item.tooltip = `${snap.repo.owner}/${snap.repo.repo} · ${latest.status}${latest.conclusion ? ` (${latest.conclusion})` : ""}`;
    this.item.backgroundColor = bgColor;
    this.item.show();
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}

function findLatestRun(snap: StoreSnapshot): WorkflowRun | null {
  let best: WorkflowRun | null = null;
  for (const runs of snap.runsByWorkflowId.values()) {
    for (const r of runs) {
      if (snap.branch && r.headBranch !== snap.branch) continue;
      if (!best || r.id > best.id) best = r;
    }
  }
  if (best) return best;
  for (const runs of snap.runsByWorkflowId.values()) {
    for (const r of runs) if (!best || r.id > best.id) best = r;
  }
  return best;
}

function visualsFor(run: WorkflowRun): { icon: string; bgColor: vscode.ThemeColor | undefined } {
  if (isActiveStatus(run.status)) return { icon: "$(sync~spin)", bgColor: undefined };
  if (run.status !== "completed") return { icon: "$(circle-outline)", bgColor: undefined };
  switch (run.conclusion) {
    case "success": return { icon: "$(pass-filled)", bgColor: undefined };
    case "failure":
    case "startup_failure":
    case "timed_out":
      return { icon: "$(error)", bgColor: new vscode.ThemeColor("statusBarItem.errorBackground") };
    case "cancelled": return { icon: "$(circle-slash)", bgColor: undefined };
    case "skipped": return { icon: "$(debug-step-over)", bgColor: undefined };
    case "action_required": return { icon: "$(warning)", bgColor: new vscode.ThemeColor("statusBarItem.warningBackground") };
    default: return { icon: "$(circle-outline)", bgColor: undefined };
  }
}
