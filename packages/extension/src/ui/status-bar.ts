import * as vscode from "vscode";
import type { BadgeView, BadgeVisualKind, PriorityBadge, PriorityReason } from "../core/selectors/status-bar.js";
import { classifyBadgeVisual, selectBadge } from "../core/selectors/status-bar.js";
import type { WorkflowStore } from "../services/workflow-store.js";
import type { StoreSnapshot } from "../core/store/snapshot.js";

/**
 * Status-bar badge. All "which run should this show?" logic lives in
 * `core/selectors/status-bar.ts` as `selectBadge`; this class handles only
 * the VS Code wiring — icons, colours, the pulse timer, and tooltip markup.
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
    if (!this.enabled) { this.stopPulse(); this.item.hide(); return; }
    const view = selectBadge(snap);
    this.applyBadge(view);
  }

  private applyBadge(view: BadgeView): void {
    switch (view.kind) {
      case "hidden":
        this.stopPulse();
        this.item.hide();
        return;
      case "idle":
        this.stopPulse();
        this.item.text = "$(github-action) Actions";
        this.item.tooltip = `${view.repo.owner}/${view.repo.repo} · no runs yet`;
        this.item.backgroundColor = undefined;
        this.item.show();
        return;
      case "priority":
        this.applyPriority(view);
        return;
    }
  }

  private applyPriority(view: PriorityBadge): void {
    const visuals = visualsFor(view);
    const label = buildLabel(view, visuals);
    if (visuals.pulse) this.startPulse(label, visuals);
    else {
      this.stopPulse();
      this.item.text = label;
    }
    this.item.backgroundColor = visuals.bgColor;
    this.item.tooltip = buildTooltip(view, visuals);
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

// --- visuals ---------------------------------------------------------------

interface Visuals {
  icon: string;
  altIcon?: string;
  prefix?: string;
  pulse: boolean;
  bgColor: vscode.ThemeColor | undefined;
}

function visualsFor(view: PriorityBadge): Visuals {
  const kind = view.reason === "action-required"
    ? "action-required"
    : classifyBadgeVisual(view.run.status, view.run.conclusion);
  return VISUALS[kind];
}

const VISUALS: Record<BadgeVisualKind, Visuals> = {
  "action-required": {
    icon: "$(warning)",
    altIcon: "$(circle-large-outline)",
    prefix: "action needed · ",
    pulse: true,
    bgColor: new vscode.ThemeColor("statusBarItem.warningBackground"),
  },
  "in-progress": { icon: "$(sync~spin)", pulse: false, bgColor: undefined },
  "pending": { icon: "$(clock)", pulse: false, bgColor: undefined },
  "success": { icon: "$(pass-filled)", pulse: false, bgColor: undefined },
  "failure": {
    icon: "$(error)",
    pulse: false,
    bgColor: new vscode.ThemeColor("statusBarItem.errorBackground"),
  },
  "cancelled": { icon: "$(circle-slash)", pulse: false, bgColor: undefined },
  "skipped": { icon: "$(debug-step-over)", pulse: false, bgColor: undefined },
  "unknown": { icon: "$(circle-outline)", pulse: false, bgColor: undefined },
};

function buildLabel(view: PriorityBadge, visuals: Visuals): string {
  const branch = view.run.headBranch ? ` ${view.run.headBranch}` : "";
  const prefix = visuals.prefix ?? "";
  const base = `${visuals.icon} ${prefix}#${view.run.runNumber}${branch}`.trim();
  return view.inProgressCount > 1 ? `${base} +${view.inProgressCount - 1}` : base;
}

function buildTooltip(view: PriorityBadge, visuals: Visuals): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  if (visuals.pulse) {
    md.appendMarkdown(`### ⚠ ${view.repo.owner}/${view.repo.repo}: action required\n\n`);
  } else {
    md.appendMarkdown(`**${view.repo.owner}/${view.repo.repo}**\n\n`);
  }
  md.appendMarkdown(`- run: \`#${view.run.runNumber}\`\n`);
  md.appendMarkdown(`- status: \`${view.run.status}\`${view.run.conclusion ? ` (\`${view.run.conclusion}\`)` : ""}\n`);
  if (view.run.headBranch) md.appendMarkdown(`- branch: \`${view.run.headBranch}\`\n`);
  md.appendMarkdown(`- event: \`${view.run.event}\`\n`);
  md.appendMarkdown(`- shown because: ${reasonLabel(view.reason)}\n`);
  if (view.inProgressCount > 0) {
    md.appendMarkdown(`- in-progress runs: **${view.inProgressCount}**\n`);
  }
  return md;
}

function reasonLabel(reason: PriorityReason): string {
  switch (reason) {
    case "action-required": return "run is awaiting manual approval";
    case "in-progress":     return "run is actively running";
    case "on-branch":       return "latest run on the current branch";
    case "latest":          return "latest run in the repository";
  }
}
