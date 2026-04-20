import * as vscode from "vscode";
import type { AppCoordinator } from "../app/coordinator.js";
import type { JobContext } from "../core/domain/types.js";
import { hasFailed } from "../core/domain/types.js";
import { ArtifactService, humanBytes } from "../services/artifact-service.js";
import type { AuthService } from "../services/auth.js";
import type { DiagnosticsService } from "../services/diagnostics-service.js";
import type { LogService } from "../services/log-service.js";
import type { NotificationService } from "../services/notification-service.js";
import type { ViewStateService } from "../services/view-state.js";
import type { WorkflowDefinitionService } from "../services/workflow-definitions.js";
import type { WorkflowStore } from "../services/workflow-store.js";
import type { LiveSync } from "../services/live-sync.js";
import type { Logger } from "../util/logger.js";
import type { LogWebviewService } from "./log-webview-panel.js";
import { promptDispatchInputs } from "./prompts.js";
import { JobNode, RunNode, StepNode, WorkflowNode } from "./tree-items.js";

type Handler = (...args: unknown[]) => unknown | Promise<unknown>;

/**
 * Registry + small DSL for declaring commands. Keeping every handler
 * alongside its id (instead of a 200-line `registerCommand` chain in
 * extension.ts) makes it trivial to see what the extension can do, to add
 * new commands without touching composition, and to swap handlers for tests.
 */
export interface CommandDeps {
  readonly coordinator: AppCoordinator;
  readonly auth: AuthService;
  readonly store: WorkflowStore;
  readonly sync: LiveSync;
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

function authCommands({ auth }: CommandDeps): CommandDef[] {
  return [
    {
      id: "workflowMonitor.signIn",
      handler: async () => {
        const state = await auth.signIn();
        if (!state.session) vscode.window.showWarningMessage("GitHub sign-in was cancelled.");
      },
    },
  ];
}

// --- run management --------------------------------------------------------

function runCommands(deps: CommandDeps): CommandDef[] {
  const { sync } = deps;
  return [
    {
      id: "workflowMonitor.refresh",
      handler: () => sync.refresh(),
    },
    {
      id: "workflowMonitor.rerunWorkflow",
      handler: (node: unknown) => guardRun(deps, node, async (api, repo, run) => {
        await api.rerunWorkflow(repo, run.id);
        vscode.window.showInformationMessage(`Re-running #${run.runNumber}…`);
        sync.refresh();
      }),
    },
    {
      id: "workflowMonitor.rerunFailedJobs",
      handler: (node: unknown) => guardRun(deps, node, async (api, repo, run) => {
        await api.rerunFailedJobs(repo, run.id);
        vscode.window.showInformationMessage(`Re-running failed jobs in #${run.runNumber}…`);
        sync.refresh();
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
          sync.refresh();
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
        const repo = deps.store.snapshot().repo;
        const branch = deps.store.snapshot().branch;
        const api = deps.coordinator.api;
        if (!repo || !api) { vscode.window.showWarningMessage("Sign in to GitHub first."); return; }

        try {
          const spec = await deps.definitions.getDispatchSpec(repo, node.workflow, branch);
          if (!spec.supported) {
            vscode.window.showWarningMessage(`Workflow "${node.workflow.name}" does not have a workflow_dispatch trigger.`);
            return;
          }
          const collected = await promptDispatchInputs(spec.inputs, branch ?? "main");
          if (!collected) return;
          await api.dispatchWorkflow(repo, node.workflow.id, collected.ref, collected.inputs);
          vscode.window.showInformationMessage(`Dispatched ${node.workflow.name} on ${collected.ref}.`);
          deps.sync.refresh();
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
        const artifacts = await api.listArtifacts(repo, run.id);
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
        const api = deps.coordinator.api;
        const repo = deps.store.snapshot().repo;
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
      // Programmatic entry point so non-tree callers (e.g. notifications)
      // can trigger "copy failure context" with bare IDs.
      id: "workflowMonitor.copyFailureContextForJob",
      handler: async (jobId: unknown, runId: unknown) => {
        if (typeof jobId !== "number" || typeof runId !== "number") return;
        const ctx = deps.store.resolveJob(runId, jobId);
        const repo = deps.store.snapshot().repo;
        const api = deps.coordinator.api;
        if (!ctx || !repo || !api) return;
        try {
          const failure = await logs.getFailureContext(repo, ctx);
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

/**
 * Given a tree node, return every failing job that falls within its scope.
 * Lets a single "Copy Failure Context" command service leaves and parents
 * without branching in the handler.
 *
 *   StepNode (failed)     → [owning job]       (the step's job; step context flows via its steps[])
 *   JobNode (failed)      → [this job]
 *   RunNode (failed)      → failed jobs of the run
 *   WorkflowNode (failed) → failed jobs of the latest run
 */
function collectFailingJobs(store: WorkflowStore, node: unknown): JobContext[] {
  const snap = store.snapshot();
  const resolveFailingJobsForRun = (runId: number): JobContext[] => {
    const jobs = snap.jobsByRunId.get(runId) ?? [];
    const out: JobContext[] = [];
    for (const j of jobs) {
      if (!hasFailed(j)) continue;
      const ctx = store.resolveJob(runId, j.id);
      if (ctx) out.push(ctx);
    }
    return out;
  };

  if (node instanceof StepNode) {
    if (!hasFailed(node.step)) return [];
    const ctx = store.resolveJob(node.job.runId, node.job.id);
    return ctx ? [ctx] : [];
  }
  if (node instanceof JobNode) {
    if (!hasFailed(node.job)) return [];
    const ctx = store.resolveJob(node.job.runId, node.job.id);
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

function pickNodeUrl(node: unknown, store: WorkflowStore): string | null {
  if (node instanceof WorkflowNode) return node.workflow.htmlUrl;
  if (node instanceof RunNode) return node.run.htmlUrl;
  if (node instanceof JobNode) return node.job.htmlUrl;
  if (node instanceof StepNode) return node.job.htmlUrl;
  const snap = store.snapshot();
  for (const runs of snap.runsByWorkflowId.values()) {
    if (runs[0]) return runs[0].htmlUrl;
  }
  if (snap.repo) return `https://github.com/${snap.repo.owner}/${snap.repo.repo}/actions`;
  return null;
}

async function guardRun(
  deps: CommandDeps,
  node: unknown,
  body: (api: NonNullable<AppCoordinator["api"]>, repo: { owner: string; repo: string }, run: RunNode["run"]) => Promise<void>,
): Promise<void> {
  if (!(node instanceof RunNode)) return;
  const api = deps.coordinator.api;
  const repo = deps.store.snapshot().repo;
  if (!api || !repo) { vscode.window.showWarningMessage("Sign in to GitHub first."); return; }
  try {
    await body(api, repo, node.run);
  } catch (err) {
    vscode.window.showErrorMessage(errMsg(err));
  }
}

async function guardJob(
  deps: CommandDeps,
  node: unknown,
  body: (
    api: NonNullable<AppCoordinator["api"]>,
    repo: { owner: string; repo: string },
    ctx: NonNullable<ReturnType<WorkflowStore["resolveJob"]>>,
  ) => Promise<void>,
): Promise<void> {
  const jobId = jobIdFromNode(node);
  const runId = runIdFromNode(node);
  if (jobId == null || runId == null) return;

  const ctx = deps.store.resolveJob(runId, jobId);
  if (!ctx) { vscode.window.showWarningMessage("Job data not loaded yet — try again in a moment."); return; }

  const api = deps.coordinator.api;
  const repo = deps.store.snapshot().repo;
  if (!api || !repo) { vscode.window.showWarningMessage("Sign in to GitHub first."); return; }
  try {
    await body(api, repo, ctx);
  } catch (err) {
    vscode.window.showErrorMessage(errMsg(err));
  }
}

function jobIdFromNode(node: unknown): number | null {
  if (node instanceof JobNode) return node.job.id;
  if (node instanceof StepNode) return node.job.id;
  return null;
}

function runIdFromNode(node: unknown): number | null {
  if (node instanceof JobNode) return node.job.runId;
  if (node instanceof StepNode) return node.job.runId;
  return null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function approxKB(s: string): string {
  const kb = Buffer.byteLength(s, "utf8") / 1024;
  return kb < 1 ? `${Math.round(kb * 1024)} B` : `${kb.toFixed(1)} KB`;
}
