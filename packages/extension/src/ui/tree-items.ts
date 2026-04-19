import * as vscode from "vscode";
import type { Job, RunConclusion, RunStatus, Step, Workflow, WorkflowRun } from "../domain/types.js";
import { hasFailed } from "../domain/types.js";
import { durationBetween, formatDuration, formatRelative } from "../util/format.js";

/**
 * Context values carry a failure suffix (`-failed`) when the item is in a
 * terminal failure state. Menu `when` clauses use this to restrict commands
 * like "Copy Failure Context" to items that actually have something to copy.
 */
function failSuffix(item: { status: RunStatus; conclusion: RunConclusion }): "" | "-failed" {
  return hasFailed(item) ? "-failed" : "";
}

export type TreeNode =
  | MessageNode
  | WorkflowNode
  | RunNode
  | JobNode
  | StepNode;

export class MessageNode extends vscode.TreeItem {
  readonly kind = "message" as const;
  constructor(label: string, icon?: string, tooltip?: string, command?: vscode.Command) {
    super(label, vscode.TreeItemCollapsibleState.None);
    if (icon) this.iconPath = new vscode.ThemeIcon(icon);
    if (tooltip) this.tooltip = tooltip;
    if (command) this.command = command;
    this.contextValue = "message";
  }
}

function openUrlCommand(url: string, title = "Open on GitHub"): vscode.Command {
  return { command: "githubActionsMonitor.openUrl", title, arguments: [url] };
}

export class WorkflowNode extends vscode.TreeItem {
  readonly kind = "workflow" as const;
  constructor(
    readonly workflow: Workflow,
    readonly latestRun: WorkflowRun | null,
    runCount: number,
  ) {
    super(workflow.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `workflow:${workflow.id}`;
    this.description = latestRun
      ? `#${latestRun.runNumber} · ${latestRun.headBranch ?? "?"}`
      : "no runs yet";
    this.tooltip = new vscode.MarkdownString(
      `**${workflow.name}**\n\n\`${workflow.path}\`\n\n${runCount} recent runs tracked`,
    );
    this.iconPath = iconForRun(latestRun);
    this.contextValue = latestRun ? `workflow${failSuffix(latestRun)}` : "workflow";
    this.command = openUrlCommand(workflow.htmlUrl, "Open workflow on GitHub");
  }
}

export class RunNode extends vscode.TreeItem {
  readonly kind = "run" as const;
  constructor(readonly run: WorkflowRun) {
    super(`#${run.runNumber} · ${run.displayTitle}`, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `run:${run.id}`;
    const parts = [run.event, run.headBranch, run.actorLogin].filter(Boolean);
    this.description = parts.join(" · ");
    this.tooltip = buildRunTooltip(run);
    this.iconPath = iconForRun(run);
    this.contextValue = `run${failSuffix(run)}`;
    this.command = openUrlCommand(run.htmlUrl, "Open run on GitHub");
  }
}

export class JobNode extends vscode.TreeItem {
  readonly kind = "job" as const;
  constructor(readonly job: Job) {
    super(
      job.name,
      job.steps.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.id = `job:${job.id}`;
    this.description = describeJobTiming(job);
    this.tooltip = new vscode.MarkdownString(
      `**${job.name}**\n\nstatus: \`${job.status}\`${job.conclusion ? ` · conclusion: \`${job.conclusion}\`` : ""}${job.steps.length ? `\n\n${job.steps.length} steps` : ""}`,
    );
    this.iconPath = iconForStatus(job.status, job.conclusion);
    this.contextValue = `job${failSuffix(job)}`;
    this.command = openUrlCommand(job.htmlUrl, "Open job on GitHub");
  }
}

export class StepNode extends vscode.TreeItem {
  readonly kind = "step" as const;
  constructor(readonly step: Step, readonly job: Job) {
    super(`${step.number}. ${step.name}`, vscode.TreeItemCollapsibleState.None);
    this.id = `step:${job.id}:${step.number}`;
    this.description = describeStepTiming(step);
    this.tooltip = new vscode.MarkdownString(
      `**${step.name}**\n\nstatus: \`${step.status}\`${step.conclusion ? ` · conclusion: \`${step.conclusion}\`` : ""}`,
    );
    this.iconPath = iconForStatus(step.status, step.conclusion);
    this.contextValue = `step${failSuffix(step)}`;
    // Steps don't have their own URL; open the parent job page (it expands to the failing step).
    this.command = openUrlCommand(job.htmlUrl, "Open job on GitHub");
  }
}

function iconForRun(run: WorkflowRun | null): vscode.ThemeIcon {
  if (!run) return new vscode.ThemeIcon("circle-outline");
  return iconForStatus(run.status, run.conclusion);
}

function iconForStatus(status: RunStatus, conclusion: RunConclusion): vscode.ThemeIcon {
  if (status === "in_progress") {
    return new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("charts.blue"));
  }
  if (status === "queued" || status === "waiting" || status === "pending" || status === "requested") {
    return new vscode.ThemeIcon("clock", new vscode.ThemeColor("charts.yellow"));
  }
  if (status !== "completed") {
    return new vscode.ThemeIcon("circle-outline");
  }
  switch (conclusion) {
    case "success":
      return new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("charts.green"));
    case "failure":
    case "startup_failure":
    case "timed_out":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
    case "cancelled":
      return new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("charts.foreground"));
    case "skipped":
      return new vscode.ThemeIcon("debug-step-over", new vscode.ThemeColor("charts.foreground"));
    case "action_required":
      return new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.yellow"));
    case "neutral":
    case "stale":
    case null:
    default:
      return new vscode.ThemeIcon("circle-outline");
  }
}

function buildRunTooltip(run: WorkflowRun): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.supportHtml = false;
  md.appendMarkdown(`**${run.displayTitle}**\n\n`);
  md.appendMarkdown(`- run: \`#${run.runNumber}\`\n`);
  md.appendMarkdown(`- status: \`${run.status}\`${run.conclusion ? ` (\`${run.conclusion}\`)` : ""}\n`);
  md.appendMarkdown(`- event: \`${run.event}\`\n`);
  if (run.headBranch) md.appendMarkdown(`- branch: \`${run.headBranch}\`\n`);
  md.appendMarkdown(`- sha: \`${run.headSha.slice(0, 7)}\`\n`);
  if (run.actorLogin) md.appendMarkdown(`- actor: \`${run.actorLogin}\`\n`);
  md.appendMarkdown(`- started: ${formatRelative(run.runStartedAt ?? run.createdAt)}\n`);
  if (run.status === "completed") md.appendMarkdown(`- updated: ${formatRelative(run.updatedAt)}\n`);
  return md;
}

function describeJobTiming(job: Job): string {
  if (job.status === "in_progress" && job.startedAt) return `running · started ${formatRelative(job.startedAt)}`;
  const dur = durationBetween(job.startedAt, job.completedAt);
  if (job.status === "completed" && dur !== null) return `${job.conclusion ?? "done"} · ${formatDuration(dur)}`;
  return job.status;
}

function describeStepTiming(step: Step): string {
  if (step.status === "in_progress" && step.startedAt) return "running";
  const dur = durationBetween(step.startedAt, step.completedAt);
  if (step.status === "completed" && dur !== null) {
    return dur < 1000 ? (step.conclusion ?? "done") : `${step.conclusion ?? "done"} · ${formatDuration(dur)}`;
  }
  return step.status;
}

