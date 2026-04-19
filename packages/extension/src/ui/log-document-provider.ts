import * as vscode from "vscode";
import type { JobContext, RepoCoordinates } from "../domain/types.js";
import type { LogService } from "../services/log-service.js";

export const LOG_SCHEME = "gh-actions-log";

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
 * `gh-actions-log:` scheme, letting users open them in a normal editor tab
 * (find, copy, diff, etc.).
 */
export class LogDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly subscription: vscode.Disposable;

  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly logs: LogService,
    private readonly resolveJob: JobResolver,
  ) {
    // When the LogService refetches a job (e.g. an in-progress log), any
    // editor tab showing it should update automatically.
    this.subscription = logs.onDidUpdate((jobId) => {
      for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme !== LOG_SCHEME) continue;
        const parsed = parseLogUri(doc.uri);
        if (parsed && parsed.jobId === jobId) this.emitter.fire(doc.uri);
      }
    });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const parsed = parseLogUri(uri);
    if (!parsed) return `# Unparseable log URI: ${uri.toString()}`;
    const ctx = this.resolveJob(parsed.runId, parsed.jobId);
    if (!ctx) return `# Log no longer available — the run has rotated out of the cache. Refresh the view and try again.`;
    try {
      return await this.logs.getJobLog(parsed.repo, ctx.job);
    } catch (err) {
      return `# Failed to fetch log\n\n${err instanceof Error ? err.message : String(err)}`;
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
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

