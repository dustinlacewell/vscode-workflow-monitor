import * as vscode from "vscode";
import type { AppCoordinator } from "../app/coordinator.js";
import { formatAuthFailureMarkdown, type AuthFailure } from "../core/auth/failure.js";
import type { JobContext, RepoCoordinates } from "../core/domain/types.js";
import { hasFailed, repoKey } from "../core/domain/types.js";
import { ArtifactService, humanBytes } from "../services/artifact-service.js";
import type { AuthService } from "../services/auth.js";
import type { DiagnosticsService } from "../services/diagnostics-service.js";
import type { LogService } from "../services/log-service.js";
import type { NotificationService } from "../services/notification-service.js";
import type { SyncEngine } from "../services/sync-engine.js";
import type { ViewStateService } from "../services/view-state.js";
import type { WorkflowDefinitionService } from "../services/workflow-definitions.js";
import type { WorkflowStore } from "../services/workflow-store.js";
import type { Logger } from "../util/logger.js";
import type { LogWebviewService } from "./log-webview-panel.js";
import { promptDispatchInputs, promptSecretName, promptSecretValue, promptVariableName, promptVariableValue } from "./prompts.js";
import { ArtifactNode, ArtifactsGroupNode, EnvironmentNode, EnvironmentSubsectionNode, JobNode, RunNode, SecretNode, SettingsSectionNode, StepNode, VariableNode, WorkflowNode, WorkflowsRepoNode } from "./tree-items.js";
import type { SecretScope } from "../core/domain/secrets.js";

type Handler = (...args: unknown[]) => unknown | Promise<unknown>;

/**
 * Registry + small DSL for declaring commands. Every handler that mutates
 * state on a specific repo pulls the repo off the node it was invoked from
 * (every tree node carries `repo: RepoCoordinates`), so nothing here reaches
 * for a global "current repo" — that concept is gone in multi-repo mode.
 */
export interface CommandDeps {
  readonly coordinator: AppCoordinator;
  readonly auth: AuthService;
  readonly store: WorkflowStore;
  readonly engine: SyncEngine;
  readonly logs: LogService;
  readonly logPanels: LogWebviewService;
  readonly artifacts: ArtifactService;
  readonly definitions: WorkflowDefinitionService;
  readonly diagnostics: DiagnosticsService;
  readonly notifications: NotificationService;
  readonly viewState: ViewStateService;
  readonly log: Logger;
}

interface CommandDef {
  readonly id: string;
  readonly handler: Handler;
}

export function registerCommands(deps: CommandDeps): vscode.Disposable {
  const defs: CommandDef[] = [
    ...navCommands(deps),
    ...authCommands(deps),
    ...runCommands(deps),
    ...logCommands(deps),
    ...viewCommands(deps),
    ...dispatchCommands(deps),
    ...artifactCommands(deps),
    ...diagnosticsCommands(deps),
    ...secretsCommands(deps),
    ...variablesCommands(deps),
  ];
  const subs = defs.map((d) => vscode.commands.registerCommand(d.id, d.handler));
  return vscode.Disposable.from(...subs);
}

// --- navigation ------------------------------------------------------------

function navCommands({ store }: CommandDeps): CommandDef[] {
  return [
    {
      id: "workflowMonitor.openUrl",
      handler: (url: unknown) => {
        if (typeof url !== "string" || url.length === 0) return;
        void vscode.env.openExternal(vscode.Uri.parse(url));
      },
    },
    {
      id: "workflowMonitor.openInBrowser",
      handler: (node: unknown) => {
        const url = pickNodeUrl(node, store);
        if (url) void vscode.env.openExternal(vscode.Uri.parse(url));
      },
    },
  ];
}

// --- auth ------------------------------------------------------------------

function authCommands({ auth, store }: CommandDeps): CommandDef[] {
  return [
    {
      id: "workflowMonitor.signIn",
      handler: async () => {
        const state = await auth.signIn();
        if (!state.session) vscode.window.showWarningMessage("GitHub sign-in was cancelled.");
      },
    },
    {
      id: "workflowMonitor.showAuthDetails",
      handler: async (explicit: unknown) => {
        const failure = pickAuthFailure(explicit) ?? store.snapshot().authFailure;
        if (!failure) {
          vscode.window.showInformationMessage("No recent GitHub API failure to inspect.");
          return;
        }
        const doc = await vscode.workspace.openTextDocument({
          content: formatAuthFailureMarkdown(failure),
          language: "markdown",
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      },
    },
  ];
}

function pickAuthFailure(v: unknown): AuthFailure | null {
  if (!v || typeof v !== "object") return null;
  const obj = v as Partial<AuthFailure>;
  if (typeof obj.kind !== "string" || typeof obj.occurredAt !== "string") return null;
  if (!Array.isArray(obj.requestedScopes)) return null;
  return obj as AuthFailure;
}

// --- run management --------------------------------------------------------

function runCommands(deps: CommandDeps): CommandDef[] {
  const { engine } = deps;
  return [
    {
      id: "workflowMonitor.refresh",
      handler: () => engine.refreshPoll(),
    },
    {
      id: "workflowMonitor.rerunWorkflow",
      handler: (node: unknown) => guardRun(deps, node, async (api, repo, run) => {
        await api.rerunWorkflow(repo, run.id);
        vscode.window.showInformationMessage(`Re-running #${run.runNumber}…`);
        engine.refreshPoll();
      }),
    },
    {
      id: "workflowMonitor.rerunFailedJobs",
      handler: (node: unknown) => guardRun(deps, node, async (api, repo, run) => {
        await api.rerunFailedJobs(repo, run.id);
        vscode.window.showInformationMessage(`Re-running failed jobs in #${run.runNumber}…`);
        engine.refreshPoll();
      }),
    },
    {
      id: "workflowMonitor.cancelRun",
      handler: async (node: unknown) => {
        if (!(node instanceof RunNode)) return;
        const confirm = await vscode.window.showWarningMessage(
          `Cancel run #${node.run.runNumber}?`,
          { modal: true },
          "Cancel run",
        );
        if (confirm !== "Cancel run") return;
        await guardRun(deps, node, async (api, repo, run) => {
          await api.cancelRun(repo, run.id);
          engine.refreshPoll();
        });
      },
    },
  ];
}

// --- workflow dispatch -----------------------------------------------------

function dispatchCommands(deps: CommandDeps): CommandDef[] {
  return [
    {
      id: "workflowMonitor.dispatchWorkflow",
      handler: async (node: unknown) => {
        if (!(node instanceof WorkflowNode)) return;
        const api = deps.coordinator.api;
        if (!api) { vscode.window.showWarningMessage("Sign in to GitHub first."); return; }
        const per = deps.store.snapshot().repos.get(repoKey(node.repo));
        const branch = per?.branch ?? null;
        try {
          const spec = await deps.definitions.getDispatchSpec(node.repo, node.workflow, branch);
          if (!spec.supported) {
            vscode.window.showWarningMessage(`Workflow "${node.workflow.name}" does not have a workflow_dispatch trigger.`);
            return;
          }
          const collected = await promptDispatchInputs(spec.inputs, branch ?? "main");
          if (!collected) return;
          await api.dispatchWorkflow(node.repo, node.workflow.id, collected.ref, collected.inputs);
          vscode.window.showInformationMessage(`Dispatched ${node.workflow.name} on ${collected.ref}.`);
          deps.engine.refreshPoll();
        } catch (err) {
          vscode.window.showErrorMessage(errMsg(err));
        }
      },
    },
  ];
}

// --- artifacts -------------------------------------------------------------

function artifactCommands(deps: CommandDeps): CommandDef[] {
  return [
    {
      id: "workflowMonitor.showArtifacts",
      handler: (node: unknown) => guardRun(deps, node, async (api, repo, run) => {
        const per = deps.store.snapshot().repos.get(repoKey(repo));
        const cached = per?.artifactsByRunId.get(run.id);
        const artifacts = cached ?? await api.listArtifacts(repo, run.id);
        if (artifacts.length === 0) { vscode.window.showInformationMessage(`Run #${run.runNumber} has no artifacts.`); return; }
        interface ArtifactPick extends vscode.QuickPickItem { artifact: import("../core/domain/types.js").Artifact }
        const items: ArtifactPick[] = artifacts.map((a) => ({
          label: a.name,
          description: `${humanBytes(a.sizeBytes)}${a.expired ? " · expired" : ""}`,
          ...(a.expiresAt ? { detail: `expires ${a.expiresAt}` } : {}),
          artifact: a,
        }));
        const pick = await vscode.window.showQuickPick(items, {
          title: `Artifacts for run #${run.runNumber}`,
          placeHolder: "Select an artifact to download",
        });
        if (!pick) return;
        await deps.artifacts.saveToDisk(repo, pick.artifact);
      }),
    },
    {
      id: "workflowMonitor.downloadArtifact",
      handler: async (node: unknown) => {
        if (!(node instanceof ArtifactNode)) return;
        try {
          await deps.artifacts.saveToDisk(node.repo, node.artifact);
        } catch (err) {
          vscode.window.showErrorMessage(errMsg(err));
        }
      },
    },
  ];
}

// --- diagnostics -----------------------------------------------------------

function diagnosticsCommands(deps: CommandDeps): CommandDef[] {
  return [
    {
      id: "workflowMonitor.clearDiagnostics",
      handler: () => { deps.diagnostics.clear(); },
    },
  ];
}

// --- secrets ---------------------------------------------------------------

function secretsCommands(deps: CommandDeps): CommandDef[] {
  return [
    {
      id: "workflowMonitor.refreshSecrets",
      handler: () => { deps.engine.refreshView("settings"); },
    },
    {
      id: "workflowMonitor.copySecretName",
      handler: async (node: unknown) => {
        if (!(node instanceof SecretNode)) return;
        await vscode.env.clipboard.writeText(node.secret.name);
        vscode.window.setStatusBarMessage(`Copied "${node.secret.name}" to clipboard`, 2000);
      },
    },
    {
      id: "workflowMonitor.addSecret",
      handler: async (node: unknown) => {
        const target = scopeFromAddContext(node, "secrets");
        if (!target) return;
        const takenNames = collectTakenNames(deps, target.repo, target.scope, "secrets");
        const name = await promptSecretName({ scopeLabel: scopeLabel(target.repo, target.scope), taken: takenNames });
        if (name === null) return;
        const value = await promptSecretValue({
          title: `New secret — ${scopeLabel(target.repo, target.scope)} · ${name}`,
          prompt: "The value is encrypted locally before leaving; GitHub never sees it in plaintext.",
        });
        if (value === null) return;
        try {
          await deps.engine.writeSecret(target.repo, target.scope, name, value);
          vscode.window.showInformationMessage(`Saved secret "${name}" to ${scopeLabel(target.repo, target.scope)}.`);
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to save secret: ${errMsg(err)}`);
        }
      },
    },
    {
      id: "workflowMonitor.updateSecret",
      handler: async (node: unknown) => {
        if (!(node instanceof SecretNode)) return;
        const value = await promptSecretValue({
          title: `Update secret — ${scopeLabel(node.repo, node.scope)} · ${node.secret.name}`,
          prompt: "Enter the new value. The existing value is not shown — GitHub never returns secret values.",
        });
        if (value === null) return;
        try {
          await deps.engine.writeSecret(node.repo, node.scope, node.secret.name, value);
          vscode.window.showInformationMessage(`Updated "${node.secret.name}".`);
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to update secret: ${errMsg(err)}`);
        }
      },
    },
    {
      id: "workflowMonitor.deleteSecret",
      handler: async (node: unknown) => {
        if (!(node instanceof SecretNode)) return;
        const confirm = await vscode.window.showWarningMessage(
          `Delete secret "${node.secret.name}" from ${scopeLabel(node.repo, node.scope)}? This cannot be undone.`,
          { modal: true },
          "Delete",
        );
        if (confirm !== "Delete") return;
        try {
          await deps.engine.deleteSecret(node.repo, node.scope, node.secret.name);
          vscode.window.showInformationMessage(`Deleted "${node.secret.name}".`);
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to delete secret: ${errMsg(err)}`);
        }
      },
    },
  ];
}

// --- variables -------------------------------------------------------------

function variablesCommands(deps: CommandDeps): CommandDef[] {
  return [
    {
      id: "workflowMonitor.copyVariableValue",
      handler: async (node: unknown) => {
        if (!(node instanceof VariableNode)) return;
        await vscode.env.clipboard.writeText(node.variable.value);
        vscode.window.setStatusBarMessage(`Copied value of "${node.variable.name}"`, 2000);
      },
    },
    {
      id: "workflowMonitor.addVariable",
      handler: async (node: unknown) => {
        const target = scopeFromAddContext(node, "variables");
        if (!target) return;
        const taken = collectTakenNames(deps, target.repo, target.scope, "variables");
        const name = await promptVariableName({ scopeLabel: scopeLabel(target.repo, target.scope), taken });
        if (name === null) return;
        const value = await promptVariableValue({
          title: `New variable — ${scopeLabel(target.repo, target.scope)} · ${name}`,
        });
        if (value === null) return;
        try {
          await deps.engine.writeVariable(target.repo, target.scope, name, value, false);
          vscode.window.showInformationMessage(`Saved variable "${name}" to ${scopeLabel(target.repo, target.scope)}.`);
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to save variable: ${errMsg(err)}`);
        }
      },
    },
    {
      id: "workflowMonitor.updateVariable",
      handler: async (node: unknown) => {
        if (!(node instanceof VariableNode)) return;
        const value = await promptVariableValue({
          title: `Update variable — ${scopeLabel(node.repo, node.scope)} · ${node.variable.name}`,
          current: node.variable.value,
        });
        if (value === null) return;
        if (value === node.variable.value) return;
        try {
          await deps.engine.writeVariable(node.repo, node.scope, node.variable.name, value, true);
          vscode.window.showInformationMessage(`Updated "${node.variable.name}".`);
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to update variable: ${errMsg(err)}`);
        }
      },
    },
    {
      id: "workflowMonitor.deleteVariable",
      handler: async (node: unknown) => {
        if (!(node instanceof VariableNode)) return;
        const confirm = await vscode.window.showWarningMessage(
          `Delete variable "${node.variable.name}" from ${scopeLabel(node.repo, node.scope)}? This cannot be undone.`,
          { modal: true },
          "Delete",
        );
        if (confirm !== "Delete") return;
        try {
          await deps.engine.deleteVariable(node.repo, node.scope, node.variable.name);
          vscode.window.showInformationMessage(`Deleted "${node.variable.name}".`);
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to delete variable: ${errMsg(err)}`);
        }
      },
    },
  ];
}

interface AddTarget { readonly repo: RepoCoordinates; readonly scope: SecretScope }

/**
 * Resolve a `(repo, scope)` pair from the tree node the user invoked from.
 * Every relevant node now carries its repo explicitly.
 */
function scopeFromAddContext(node: unknown, kind: "secrets" | "variables"): AddTarget | null {
  if (node instanceof SettingsSectionNode && node.section === kind) {
    return { repo: node.repo, scope: { kind: "repo" } };
  }
  if (node instanceof EnvironmentNode) {
    return { repo: node.repo, scope: { kind: "environment", name: node.environment.name } };
  }
  if (node instanceof EnvironmentSubsectionNode && node.section === kind) {
    return { repo: node.repo, scope: { kind: "environment", name: node.environment.name } };
  }
  return null;
}

function scopeLabel(repo: RepoCoordinates, scope: SecretScope): string {
  const base = `${repo.owner}/${repo.repo}`;
  return scope.kind === "repo" ? `${base} · repository` : `${base} · environment "${scope.name}"`;
}

function collectTakenNames(deps: CommandDeps, repo: RepoCoordinates, scope: SecretScope, kind: "secrets" | "variables"): readonly string[] {
  const snap = deps.store.getSecretsSnapshot(repoKey(repo));
  const key = scope.kind === "repo" ? "repo" : `env:${scope.name}`;
  const map = kind === "secrets" ? snap.secretsByScope : snap.variablesByScope;
  const items = map.get(key) ?? [];
  return items.map((x) => x.name);
}

// --- view preferences ------------------------------------------------------

function viewCommands({ viewState }: CommandDeps): CommandDef[] {
  return [
    {
      id: "workflowMonitor.toggleBranchFilter",
      handler: () => viewState.toggleBranchFilter(),
    },
    {
      id: "workflowMonitor.showAllBranches",
      handler: () => viewState.setBranchFilter("all"),
    },
    {
      id: "workflowMonitor.showCurrentBranchOnly",
      handler: () => viewState.setBranchFilter("current"),
    },
  ];
}

// --- logs ------------------------------------------------------------------

function logCommands(deps: CommandDeps): CommandDef[] {
  const { logs } = deps;
  return [
    {
      id: "workflowMonitor.viewJobLog",
      handler: (node: unknown) => guardJob(deps, node, async (_api, repo, ctx) => {
        const step = node instanceof StepNode ? node.step : null;
        deps.logPanels.show(repo, ctx, { focusStep: step, foldOthers: true });
      }),
    },
    {
      id: "workflowMonitor.copyJobLog",
      handler: (node: unknown) => guardJob(deps, node, async (_api, repo, ctx) => {
        const text = await logs.getJobLog(repo, ctx.job);
        await vscode.env.clipboard.writeText(text);
        vscode.window.showInformationMessage(`Copied log for ${ctx.job.name} (${approxKB(text)}).`);
      }),
    },
    {
      id: "workflowMonitor.copyFailureContext",
      handler: async (node: unknown) => {
        const jobs = collectFailingJobs(deps.store, node);
        if (jobs.length === 0) { vscode.window.showInformationMessage("Nothing failed here."); return; }
        const repo = repoFromNode(node);
        const api = deps.coordinator.api;
        if (!api || !repo) { vscode.window.showWarningMessage("Sign in to GitHub first."); return; }
        try {
          const parts = await Promise.all(jobs.map((ctx) => logs.getFailureContext(repo, ctx)));
          const markdown = parts.length === 1
            ? parts[0]!.markdown
            : parts.map((p) => p.markdown).join("\n\n---\n\n");
          await vscode.env.clipboard.writeText(markdown);
          const label = jobs.length === 1
            ? `${jobs[0]!.job.name}`
            : `${jobs.length} failing jobs`;
          vscode.window.showInformationMessage(`Copied failure context for ${label} (${approxKB(markdown)}).`);
        } catch (err) {
          vscode.window.showErrorMessage(errMsg(err));
        }
      },
    },
    {
      // Programmatic entry point so non-tree callers (e.g. notifications) can
      // trigger "copy failure context" by repo key + job id + run id.
      id: "workflowMonitor.copyFailureContextForJob",
      handler: async (key: unknown, jobId: unknown, runId: unknown) => {
        if (typeof key !== "string" || typeof jobId !== "number" || typeof runId !== "number") return;
        const ctx = deps.store.resolveJob(key, runId, jobId);
        const per = deps.store.snapshot().repos.get(key);
        const api = deps.coordinator.api;
        if (!ctx || !per || !api) return;
        try {
          const failure = await logs.getFailureContext(per.repo, ctx);
          await vscode.env.clipboard.writeText(failure.markdown);
          vscode.window.showInformationMessage(`Copied failure context for ${ctx.job.name}.`);
        } catch (err) {
          vscode.window.showErrorMessage(errMsg(err));
        }
      },
    },
  ];
}

// --- helpers ---------------------------------------------------------------

function collectFailingJobs(store: WorkflowStore, node: unknown): JobContext[] {
  const repo = repoFromNode(node);
  if (!repo) return [];
  const key = repoKey(repo);
  const per = store.snapshot().repos.get(key);
  if (!per) return [];
  const resolveFailingJobsForRun = (runId: number): JobContext[] => {
    const jobs = per.jobsByRunId.get(runId) ?? [];
    const out: JobContext[] = [];
    for (const j of jobs) {
      if (!hasFailed(j)) continue;
      const ctx = store.resolveJob(key, runId, j.id);
      if (ctx) out.push(ctx);
    }
    return out;
  };

  if (node instanceof StepNode) {
    if (!hasFailed(node.step)) return [];
    const ctx = store.resolveJob(key, node.job.runId, node.job.id);
    return ctx ? [ctx] : [];
  }
  if (node instanceof JobNode) {
    if (!hasFailed(node.job)) return [];
    const ctx = store.resolveJob(key, node.job.runId, node.job.id);
    return ctx ? [ctx] : [];
  }
  if (node instanceof RunNode) {
    return hasFailed(node.run) ? resolveFailingJobsForRun(node.run.id) : [];
  }
  if (node instanceof WorkflowNode) {
    const latest = node.latestRun;
    if (!latest || !hasFailed(latest)) return [];
    return resolveFailingJobsForRun(latest.id);
  }
  return [];
}

function repoFromNode(node: unknown): RepoCoordinates | null {
  if (node instanceof WorkflowsRepoNode) return node.repo;
  if (node instanceof WorkflowNode) return node.repo;
  if (node instanceof RunNode) return node.repo;
  if (node instanceof JobNode) return node.repo;
  if (node instanceof StepNode) return node.repo;
  if (node instanceof ArtifactsGroupNode) return node.repo;
  if (node instanceof ArtifactNode) return node.repo;
  return null;
}

function pickNodeUrl(node: unknown, store: WorkflowStore): string | null {
  if (node instanceof WorkflowNode) return node.workflow.htmlUrl;
  if (node instanceof RunNode) return node.run.htmlUrl;
  if (node instanceof JobNode) return node.job.htmlUrl;
  if (node instanceof StepNode) return node.job.htmlUrl;
  if (node instanceof WorkflowsRepoNode) return `https://github.com/${node.repo.owner}/${node.repo.repo}/actions`;
  // Fallback: pick the first tracked repo's actions page (single-repo case).
  const snap = store.snapshot();
  for (const per of snap.repos.values()) {
    return `https://github.com/${per.repo.owner}/${per.repo.repo}/actions`;
  }
  return null;
}

async function guardRun(
  deps: CommandDeps,
  node: unknown,
  body: (api: NonNullable<AppCoordinator["api"]>, repo: RepoCoordinates, run: RunNode["run"]) => Promise<void>,
): Promise<void> {
  if (!(node instanceof RunNode)) return;
  const api = deps.coordinator.api;
  if (!api) { vscode.window.showWarningMessage("Sign in to GitHub first."); return; }
  try {
    await body(api, node.repo, node.run);
  } catch (err) {
    vscode.window.showErrorMessage(errMsg(err));
  }
}

async function guardJob(
  deps: CommandDeps,
  node: unknown,
  body: (
    api: NonNullable<AppCoordinator["api"]>,
    repo: RepoCoordinates,
    ctx: NonNullable<ReturnType<WorkflowStore["resolveJob"]>>,
  ) => Promise<void>,
): Promise<void> {
  const repo = repoFromNode(node);
  if (!repo) return;
  const key = repoKey(repo);
  const { jobId, runId } = jobIdsFromNode(node);
  if (jobId == null || runId == null) return;

  const ctx = deps.store.resolveJob(key, runId, jobId);
  if (!ctx) { vscode.window.showWarningMessage("Job data not loaded yet — try again in a moment."); return; }

  const api = deps.coordinator.api;
  if (!api) { vscode.window.showWarningMessage("Sign in to GitHub first."); return; }
  try {
    await body(api, repo, ctx);
  } catch (err) {
    vscode.window.showErrorMessage(errMsg(err));
  }
}

function jobIdsFromNode(node: unknown): { jobId: number | null; runId: number | null } {
  if (node instanceof JobNode) return { jobId: node.job.id, runId: node.job.runId };
  if (node instanceof StepNode) return { jobId: node.job.id, runId: node.job.runId };
  return { jobId: null, runId: null };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function approxKB(s: string): string {
  const kb = Buffer.byteLength(s, "utf8") / 1024;
  return kb < 1 ? `${Math.round(kb * 1024)} B` : `${kb.toFixed(1)} KB`;
}
