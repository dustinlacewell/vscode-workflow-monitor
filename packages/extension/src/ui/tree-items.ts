import * as vscode from "vscode";
import type { Environment, Secret, SecretScope } from "../core/domain/secrets.js";
import type { Artifact, Job, RepoCoordinates, RunConclusion, RunStatus, Step, Workflow, WorkflowRun } from "../core/domain/types.js";
import { hasFailed } from "../core/domain/types.js";
import { durationBetween, formatDuration, formatRelative } from "../util/format.js";
import { humanBytes } from "../services/artifact-service.js";

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
  | StepNode
  | ArtifactsGroupNode
  | ArtifactNode
  | SettingsRepoNode
  | SettingsSectionNode
  | EnvironmentNode
  | EnvironmentSubsectionNode
  | SecretNode;

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
    this.command = { command: "workflowMonitor.viewJobLog", title: "View Job Log", arguments: [this] };
  }
}

export class ArtifactsGroupNode extends vscode.TreeItem {
  readonly kind = "artifacts-group" as const;
  constructor(readonly run: WorkflowRun, readonly artifacts: readonly Artifact[] | null) {
    // null => loading; empty array is filtered out upstream (we never show it)
    const count = artifacts?.length ?? 0;
    super(
      "Artifacts",
      count > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    this.id = `artifacts:${run.id}`;
    this.description = artifacts === null ? "loading…" : `${count}`;
    this.iconPath = new vscode.ThemeIcon("archive");
    this.tooltip = artifacts === null
      ? `Fetching artifacts for #${run.runNumber}…`
      : `${count} artifact${count === 1 ? "" : "s"} from run #${run.runNumber}`;
    this.contextValue = "artifacts-group";
  }
}

export class ArtifactNode extends vscode.TreeItem {
  readonly kind = "artifact" as const;
  constructor(readonly run: WorkflowRun, readonly artifact: Artifact) {
    super(artifact.name, vscode.TreeItemCollapsibleState.None);
    this.id = `artifact:${artifact.id}`;
    const parts = [humanBytes(artifact.sizeBytes)];
    if (artifact.expired) parts.push("expired");
    this.description = parts.join(" · ");
    this.iconPath = new vscode.ThemeIcon(artifact.expired ? "archive" : "package");
    this.tooltip = buildArtifactTooltip(run, artifact);
    this.contextValue = artifact.expired ? "artifact-expired" : "artifact";
    // Double-click / enter triggers the download directly.
    if (!artifact.expired) {
      this.command = {
        command: "workflowMonitor.downloadArtifact",
        title: "Download artifact",
        arguments: [this],
      };
    }
  }
}

function buildArtifactTooltip(run: WorkflowRun, artifact: Artifact): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${artifact.name}**\n\n`);
  md.appendMarkdown(`- size: ${humanBytes(artifact.sizeBytes)}\n`);
  md.appendMarkdown(`- run: \`#${run.runNumber}\`\n`);
  md.appendMarkdown(`- created: ${formatRelative(artifact.createdAt)}\n`);
  if (artifact.expiresAt) md.appendMarkdown(`- expires: ${formatRelative(artifact.expiresAt)}\n`);
  if (artifact.expired) md.appendMarkdown(`- **expired** — download unavailable\n`);
  return md;
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
    this.command = { command: "workflowMonitor.viewJobLog", title: "View Job Log", arguments: [this] };
  }
}

// --- settings --------------------------------------------------------------

export type SettingsSectionKind = "environments" | "secrets" | "variables";

/**
 * Top-level node in the Settings tree — one per repo in the workspace.
 * For v1 we only track a single repo but the shape is ready for the
 * multi-repo workspace case (just list several under the root).
 */
export class SettingsRepoNode extends vscode.TreeItem {
  readonly kind = "settings-repo" as const;
  constructor(readonly repo: RepoCoordinates) {
    super(`${repo.owner}/${repo.repo}`, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `settings-repo:${repo.owner}/${repo.repo}`;
    this.iconPath = new vscode.ThemeIcon("repo");
    this.contextValue = "settings-repo";
  }
}

/**
 * Mid-level node for each configuration dimension (Environments / Secrets /
 * Variables). The tree provider decides what to render underneath based on
 * `section`.
 */
export class SettingsSectionNode extends vscode.TreeItem {
  readonly kind = "settings-section" as const;
  constructor(readonly section: SettingsSectionKind, count?: number | "loading") {
    super(SECTION_LABEL[section], vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `settings-section:${section}`;
    if (count === "loading") this.description = "loading…";
    else if (typeof count === "number") this.description = `${count}`;
    this.iconPath = new vscode.ThemeIcon(SECTION_ICON[section]);
    this.contextValue = `settings-section-${section}`;
  }
}

const SECTION_LABEL: Record<SettingsSectionKind, string> = {
  environments: "Environments",
  secrets: "Secrets",
  variables: "Variables",
};

const SECTION_ICON: Record<SettingsSectionKind, string> = {
  environments: "rocket",
  secrets: "lock",
  variables: "symbol-string",
};

/**
 * Environment row under Settings. Collapsible — its children are the
 * env-scoped Secrets and Variables sub-sections. Metadata (protection rules,
 * timestamps) lives in the tooltip + description to keep the label clean.
 */
export class EnvironmentNode extends vscode.TreeItem {
  readonly kind = "environment" as const;
  constructor(readonly environment: Environment) {
    super(environment.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `environment:${environment.name}`;
    if (environment.protectionRuleCount > 0) {
      this.description = `${environment.protectionRuleCount} protection rule${environment.protectionRuleCount === 1 ? "" : "s"}`;
    }
    this.iconPath = new vscode.ThemeIcon("rocket");
    this.tooltip = new vscode.MarkdownString(
      `**${environment.name}**\n\n`
      + `- protection rules: ${environment.protectionRuleCount}\n`
      + `- created: ${formatRelative(environment.createdAt)}\n`
      + `- updated: ${formatRelative(environment.updatedAt)}\n`,
    );
    this.contextValue = "environment";
  }
}

/**
 * Section node belonging to a specific environment — either "Secrets" or
 * "Variables" under one env. The tree provider uses the `environment` +
 * `section` pair to fetch/render the right scoped data.
 */
export class EnvironmentSubsectionNode extends vscode.TreeItem {
  readonly kind = "environment-subsection" as const;
  constructor(
    readonly environment: Environment,
    readonly section: "secrets" | "variables",
    count?: number | "loading",
  ) {
    super(section === "secrets" ? "Secrets" : "Variables", vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `env-subsection:${environment.name}:${section}`;
    if (count === "loading") this.description = "loading…";
    else if (typeof count === "number") this.description = `${count}`;
    this.iconPath = new vscode.ThemeIcon(section === "secrets" ? "lock" : "symbol-string");
    this.contextValue = `env-subsection-${section}`;
  }
}

// --- secrets ---------------------------------------------------------------

export class SecretNode extends vscode.TreeItem {
  readonly kind = "secret" as const;
  constructor(readonly scope: SecretScope, readonly secret: Secret) {
    super(secret.name, vscode.TreeItemCollapsibleState.None);
    this.id = `secret:${scopeIdPart(scope)}:${secret.name}`;
    this.description = `updated ${formatRelative(secret.updatedAt)}`;
    this.iconPath = new vscode.ThemeIcon("lock");
    this.tooltip = new vscode.MarkdownString(
      `**${secret.name}**\n\n`
      + `- scope: ${scope.kind === "repo" ? "repository" : `environment \`${scope.name}\``}\n`
      + `- created: ${formatRelative(secret.createdAt)}\n`
      + `- updated: ${formatRelative(secret.updatedAt)}\n\n`
      + `_GitHub never exposes secret values — the extension only sees metadata._`,
    );
    this.contextValue = "secret";
    this.command = {
      command: "workflowMonitor.copySecretName",
      title: "Copy Secret Name",
      arguments: [this],
    };
  }
}

function scopeIdPart(scope: SecretScope): string {
  return scope.kind === "repo" ? "repo" : `env:${scope.name}`;
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

// The status icon already communicates success/failure/running, so the
// description text only carries *timing* info — duration for completed items,
// "started <rel>" for in-flight ones. Pending/queued rows have neither and
// lean on the icon alone.
function describeJobTiming(job: Job): string {
  if (job.status === "in_progress" && job.startedAt) return `started ${formatRelative(job.startedAt)}`;
  const dur = durationBetween(job.startedAt, job.completedAt);
  if (job.status === "completed" && dur !== null) return formatDuration(dur);
  return "";
}

function describeStepTiming(step: Step): string {
  const dur = durationBetween(step.startedAt, step.completedAt);
  if (step.status === "completed" && dur !== null && dur >= 1000) return formatDuration(dur);
  return "";
}

