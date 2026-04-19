import * as vscode from "vscode";
import type { JobContext, RepoCoordinates } from "../domain/types.js";
import { isActiveStatus } from "../domain/types.js";
import type { LogService } from "../services/log-service.js";
import type { WorkflowStore } from "../services/workflow-store.js";

export const LOG_SCHEME = "gh-actions-log";

const TAIL_INTERVAL_MS = 2500;

/**
 * Builds the virtual URI that identifies a job log document. Encoding all
 * the information we need into the URI keeps the content provider stateless
 * (apart from its LogService dependency), which is exactly what VS Code
 * expects for cross-workspace, re-openable documents.
 *
 * Example:
 *   gh-actions-log:/dustinlacewell/demo/runs/123/jobs/456.log
 *     ?workflow=CI&runNumber=1&branch=main&sha=abc1234
 */
export function buildLogUri(repo: RepoCoordinates, ctx: JobContext): vscode.Uri {
  const path = `/${repo.owner}/${repo.repo}/runs/${ctx.run.id}/jobs/${ctx.job.id}.log`;
  const params = new URLSearchParams({
    workflow: ctx.workflowName,
    runNumber: String(ctx.run.runNumber),
    jobName: ctx.job.name,
  });
  if (ctx.run.headBranch) params.set("branch", ctx.run.headBranch);
  if (ctx.run.headSha) params.set("sha", ctx.run.headSha.slice(0, 7));
  return vscode.Uri.parse(`${LOG_SCHEME}:${path}?${params.toString()}`);
}

interface ParsedUri {
  repo: RepoCoordinates;
  runId: number;
  jobId: number;
}

function parseLogUri(uri: vscode.Uri): ParsedUri | null {
  const m = uri.path.match(/^\/([^/]+)\/([^/]+)\/runs\/(\d+)\/jobs\/(\d+)\.log$/);
  if (!m) return null;
  return {
    repo: { owner: m[1]!, repo: m[2]! },
    runId: Number(m[3]),
    jobId: Number(m[4]),
  };
}

export type JobResolver = (runId: number, jobId: number) => JobContext | null;

/**
 * TextDocumentContentProvider that serves cleaned job logs under the
 * `gh-actions-log:` scheme and live-tails active jobs.
 *
 * Tailing strategy:
 *   - When content is requested for an active job, spin up a timer that
 *     re-fires onDidChange every TAIL_INTERVAL_MS. VS Code re-queries the
 *     content; LogService re-fetches (bypassing cache for active jobs) and
 *     emits onDidUpdate only when bytes changed.
 *   - Store changes (a poll revealing the job completed) stop the tail and
 *     one last refetch happens to capture the final output.
 *   - Closing the document stops its tail immediately.
 */
export class LogDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly tails = new Map<number, { uri: vscode.Uri; timer: NodeJS.Timeout }>();

  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly logs: LogService,
    store: WorkflowStore,
    private readonly resolveJob: JobResolver,
  ) {
    this.subscriptions.push(
      logs.onDidUpdate((jobId) => this.fireForJob(jobId)),
      store.onDidChange(() => this.reconcileTails()),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (doc.uri.scheme !== LOG_SCHEME) return;
        const parsed = parseLogUri(doc.uri);
        if (parsed) this.stopTail(parsed.jobId);
      }),
    );
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const parsed = parseLogUri(uri);
    if (!parsed) return `# Unparseable log URI: ${uri.toString()}`;
    const ctx = this.resolveJob(parsed.runId, parsed.jobId);
    if (!ctx) return `# Log no longer available — the run has rotated out of the cache. Refresh the view and try again.`;
    const active = isActiveStatus(ctx.job.status);
    try {
      const content = await this.logs.getJobLog(parsed.repo, ctx.job, { force: active });
      if (active) this.ensureTail(parsed.jobId, uri);
      else this.stopTail(parsed.jobId);
      return content.length > 0
        ? content
        : `# ${ctx.job.name}\n# status: ${ctx.job.status}\n# (waiting for output…)\n`;
    } catch (err) {
      return `# Failed to fetch log\n\n${err instanceof Error ? err.message : String(err)}`;
    }
  }

  dispose(): void {
    for (const { timer } of this.tails.values()) clearInterval(timer);
    this.tails.clear();
    this.subscriptions.forEach((s) => s.dispose());
    this.emitter.dispose();
  }

  private ensureTail(jobId: number, uri: vscode.Uri): void {
    if (this.tails.has(jobId)) return;
    const timer = setInterval(() => this.emitter.fire(uri), TAIL_INTERVAL_MS);
    this.tails.set(jobId, { uri, timer });
  }

  private stopTail(jobId: number): void {
    const t = this.tails.get(jobId);
    if (!t) return;
    clearInterval(t.timer);
    this.tails.delete(jobId);
  }

  private reconcileTails(): void {
    for (const [jobId, { uri }] of [...this.tails]) {
      const parsed = parseLogUri(uri);
      if (!parsed) { this.stopTail(jobId); continue; }
      const ctx = this.resolveJob(parsed.runId, jobId);
      if (!ctx || !isActiveStatus(ctx.job.status)) {
        this.stopTail(jobId);
        // Final poke so the doc shows the post-completion snapshot.
        this.emitter.fire(uri);
      }
    }
  }

  private fireForJob(jobId: number): void {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== LOG_SCHEME) continue;
      const parsed = parseLogUri(doc.uri);
      if (parsed && parsed.jobId === jobId) this.emitter.fire(doc.uri);
    }
  }
}

/**
 * Convenience helper: build the URI, open it as a read-only editor tab.
 */
export async function openLogDocument(repo: RepoCoordinates, ctx: JobContext): Promise<void> {
  const uri = buildLogUri(repo, ctx);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(doc, "log");
  await vscode.window.showTextDocument(doc, { preview: false });
}
