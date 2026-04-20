import * as vscode from "vscode";
import { isActiveStatus, type WorkflowRun } from "../core/domain/types.js";
import type { WorkflowStore } from "../services/workflow-store.js";
import type { StoreSnapshot } from "../core/store/snapshot.js";

/**
 * Status-bar badge reflecting (in priority order):
 *   1. any in-progress run — spinning icon;
 *   2. any run awaiting manual approval (`action_required`) — pulsing warning;
 *   3. the latest run on the current branch;
 *   4. the latest run anywhere.
 *
 * This layering keeps user attention on the most important state, rather
 * than always showing whatever shipped last.
 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscription: vscode.Disposable;
  private enabled: boolean;

  // Pulse state for action_required — alternates icon every tick.
  private pulseTimer: NodeJS.Timeout | null = null;
  private pulseOn = false;

  constructor(private readonly store: WorkflowStore, enabled: boolean) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "workflowMonitor.openInBrowser";
    this.enabled = enabled;
    this.subscription = store.onDidChange((snap) => this.render(snap));
    this.render(store.snapshot());
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) { this.stopPulse(); this.item.hide(); }
    else this.render(this.store.snapshot());
  }

  private render(snap: StoreSnapshot): void {
    if (!this.enabled) { this.item.hide(); return; }
    if (!snap.repo || snap.status === "no-repo") { this.item.hide(); return; }

    const priority = findPriorityRun(snap);
    if (!priority) {
      this.stopPulse();
      this.item.text = "$(github-action) Actions";
      this.item.tooltip = `${snap.repo.owner}/${snap.repo.repo} · no runs yet`;
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }

    const visuals = visualsFor(priority);
    const branch = priority.headBranch ? ` ${priority.headBranch}` : "";
    const prefix = visuals.prefix ?? "";
    const labelBase = `${visuals.icon} ${prefix}#${priority.runNumber}${branch}`.trim();

    if (visuals.pulse) this.startPulse(labelBase, visuals);
    else {
      this.stopPulse();
      this.item.text = labelBase;
    }
    this.item.backgroundColor = visuals.bgColor;
    this.item.tooltip = buildTooltip(snap, priority, visuals);
    this.item.show();
  }

  private startPulse(label: string, visuals: Visuals): void {
    if (this.pulseTimer) return;
    this.pulseOn = true;
    const tick = () => {
      this.pulseOn = !this.pulseOn;
      this.item.text = this.pulseOn
        ? label
        : label.replace(visuals.icon, visuals.altIcon ?? "$(circle-large-outline)");
    };
    this.item.text = label;
    this.pulseTimer = setInterval(tick, 900);
  }

  private stopPulse(): void {
    if (this.pulseTimer) { clearInterval(this.pulseTimer); this.pulseTimer = null; }
  }

  dispose(): void {
    this.stopPulse();
    this.subscription.dispose();
    this.item.dispose();
  }
}

// --- selection -------------------------------------------------------------

function findPriorityRun(snap: StoreSnapshot): WorkflowRun | null {
  const allRuns: WorkflowRun[] = [];
  for (const runs of snap.runsByWorkflowId.values()) allRuns.push(...runs);
  if (allRuns.length === 0) return null;

  // 1. action_required (needs attention NOW)
  const actionReq = allRuns.find((r) => r.conclusion === "action_required");
  if (actionReq) return actionReq;

  // 2. any in-progress run
  const inProgress = allRuns.find((r) => isActiveStatus(r.status));
  if (inProgress) return inProgress;

  // 3/4. latest on current branch, else latest overall.
  let best: WorkflowRun | null = null;
  for (const r of allRuns) {
    if (snap.branch && r.headBranch !== snap.branch) continue;
    if (!best || r.id > best.id) best = r;
  }
  if (best) return best;
  for (const r of allRuns) if (!best || r.id > best.id) best = r;
  return best;
}

// --- visuals ---------------------------------------------------------------

interface Visuals {
  icon: string;
  altIcon?: string;
  prefix?: string;
  pulse: boolean;
  bgColor: vscode.ThemeColor | undefined;
}

function visualsFor(run: WorkflowRun): Visuals {
  if (run.conclusion === "action_required") {
    return {
      icon: "$(warning)",
      altIcon: "$(circle-large-outline)",
      prefix: "action needed · ",
      pulse: true,
      bgColor: new vscode.ThemeColor("statusBarItem.warningBackground"),
    };
  }
  if (isActiveStatus(run.status)) {
    return { icon: "$(sync~spin)", pulse: false, bgColor: undefined };
  }
  if (run.status !== "completed") {
    return { icon: "$(circle-outline)", pulse: false, bgColor: undefined };
  }
  switch (run.conclusion) {
    case "success":
      return { icon: "$(pass-filled)", pulse: false, bgColor: undefined };
    case "failure":
    case "startup_failure":
    case "timed_out":
      return { icon: "$(error)", pulse: false, bgColor: new vscode.ThemeColor("statusBarItem.errorBackground") };
    case "cancelled":
      return { icon: "$(circle-slash)", pulse: false, bgColor: undefined };
    case "skipped":
      return { icon: "$(debug-step-over)", pulse: false, bgColor: undefined };
    default:
      return { icon: "$(circle-outline)", pulse: false, bgColor: undefined };
  }
}

function buildTooltip(snap: StoreSnapshot, run: WorkflowRun, visuals: Visuals): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  if (visuals.pulse) md.appendMarkdown(`### ⚠ ${snap.repo!.owner}/${snap.repo!.repo}: action required\n\n`);
  else md.appendMarkdown(`**${snap.repo!.owner}/${snap.repo!.repo}**\n\n`);
  md.appendMarkdown(`- run: \`#${run.runNumber}\`\n`);
  md.appendMarkdown(`- status: \`${run.status}\`${run.conclusion ? ` (\`${run.conclusion}\`)` : ""}\n`);
  if (run.headBranch) md.appendMarkdown(`- branch: \`${run.headBranch}\`\n`);
  md.appendMarkdown(`- event: \`${run.event}\`\n`);
  return md;
}
