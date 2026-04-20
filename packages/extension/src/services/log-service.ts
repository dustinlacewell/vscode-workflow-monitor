import * as vscode from "vscode";
import type { GitHubApi } from "../data/github-api.js";
import type { Job, JobContext, RepoCoordinates, Step } from "../core/domain/types.js";
import { isFailureConclusion } from "../core/domain/types.js";
import { stripAnsi, stripTimestamp, stripTimestamps } from "../util/ansi.js";

export interface FailureContext {
  readonly jobCtx: JobContext;
  readonly failingStep: Step | null;
  readonly excerpt: string;
  readonly markdown: string;
}

interface CachedLog {
  readonly jobId: number;
  readonly status: string;
  /** Timestamps stripped, ANSI preserved — the richest representation we need. */
  readonly raw: string;
}

const MAX_CONTEXT_BYTES = 120_000;
const MAX_EXCERPT_LINES = 400;

/**
 * Owns fetching, caching, and post-processing of GitHub Actions job logs.
 *
 * A single LogService instance is shared across the UI, the clipboard
 * commands, and the virtual-document provider so that opening a log, then
 * copying a failure excerpt from the same job, hits the network exactly once.
 *
 * Logs for completed jobs are immutable, so cache entries for `completed`
 * status live forever (or until the service is disposed). In-progress jobs
 * refetch on every request because GitHub grows the log incrementally.
 */
export class LogService implements vscode.Disposable {
  private readonly cache = new Map<number, CachedLog>();
  private readonly emitter = new vscode.EventEmitter<number>();

  /** Fires with a jobId whenever that job's cached log content changed. */
  readonly onDidUpdate = this.emitter.event;

  constructor(private readonly apiProvider: () => GitHubApi | null) {}

  /** Return the paste-ready log text (ANSI stripped) for a job. */
  async getJobLog(repo: RepoCoordinates, job: Job, opts: { force?: boolean } = {}): Promise<string> {
    const raw = await this.getJobLogRaw(repo, job, opts);
    return stripAnsi(raw);
  }

  /**
   * Return the log with timestamps stripped but ANSI preserved — the webview
   * renders the escape codes, so stripping them here would lose fidelity.
   */
  async getJobLogRaw(repo: RepoCoordinates, job: Job, opts: { force?: boolean } = {}): Promise<string> {
    const cached = this.cache.get(job.id);
    const isComplete = job.status === "completed";
    if (cached && !opts.force && cached.status === job.status && isComplete) {
      return cached.raw;
    }
    const api = this.apiProvider();
    if (!api) throw new Error("Not authenticated — sign in to GitHub first.");

    const fetched = await api.fetchJobLog(repo, job.id);
    const raw = stripTimestamps(fetched);
    const changed = !cached || cached.raw !== raw || cached.status !== job.status;
    this.cache.set(job.id, { jobId: job.id, status: job.status, raw });
    // Fire only when content (or terminal status) actually changed — subscribers
    // re-render on this, and re-rendering triggers another fetch, so firing on
    // every call would loop forever while tailing an active job.
    if (changed) this.emitter.fire(job.id);
    return raw;
  }

  /**
   * Build a paste-ready failure context for a job: metadata header + log
   * excerpt focused on the failing step.
   *
   * Falls back to the last MAX_EXCERPT_LINES of the job log if no failing
   * step is recognizable (e.g. the job itself was cancelled mid-stream).
   */
  async getFailureContext(repo: RepoCoordinates, ctx: JobContext): Promise<FailureContext> {
    const fullLog = await this.getJobLog(repo, ctx.job);
    const failingStep = ctx.job.steps.find((s) => isFailureConclusion(s.conclusion)) ?? null;
    const excerpt = failingStep
      ? extractStepLog(fullLog, failingStep.name) ?? tailLines(fullLog, MAX_EXCERPT_LINES)
      : tailLines(fullLog, MAX_EXCERPT_LINES);
    const clipped = clipBytes(excerpt, MAX_CONTEXT_BYTES);
    return {
      jobCtx: ctx,
      failingStep,
      excerpt: clipped,
      markdown: renderFailureMarkdown({ repo, ctx, failingStep, excerpt: clipped }),
    };
  }

  invalidate(jobId: number): void {
    this.cache.delete(jobId);
    this.emitter.fire(jobId);
  }

  dispose(): void {
    this.emitter.dispose();
    this.cache.clear();
  }
}

// --- helpers ---------------------------------------------------------------

/**
 * Given a cleaned job log, return just the section belonging to the named
 * step. Heuristic: look for `##[group]Run <stepName>` and take everything
 * until the next `##[group]` or end-of-log. Returns null when we can't find
 * a clear boundary (caller should fall back to a tail).
 */
function extractStepLog(log: string, stepName: string): string | null {
  const lines = log.split(/\r?\n/);
  const needles = [
    `##[group]Run ${stepName}`,
    `##[group]${stepName}`,
  ];
  const startIdx = lines.findIndex((line) => {
    const s = stripTimestamp(line);
    return needles.some((n) => s.startsWith(n));
  });
  if (startIdx < 0) return null;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (stripTimestamp(lines[i]!).startsWith("##[group]")) { endIdx = i; break; }
  }
  return lines.slice(startIdx, endIdx).join("\n");
}

function tailLines(log: string, maxLines: number): string {
  const lines = log.split(/\r?\n/);
  return lines.slice(-maxLines).join("\n");
}

function clipBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  // Drop characters from the FRONT — the tail is usually where failures live.
  const buf = Buffer.from(s, "utf8");
  const clipped = buf.subarray(buf.length - maxBytes);
  return `… [${buf.length - maxBytes} bytes trimmed]\n` + clipped.toString("utf8");
}

function renderFailureMarkdown(args: {
  repo: RepoCoordinates;
  ctx: JobContext;
  failingStep: Step | null;
  excerpt: string;
}): string {
  const { repo, ctx, failingStep, excerpt } = args;
  const { run, job, workflowName } = ctx;
  const lines: string[] = [];
  lines.push(`# GitHub Actions failure: ${repo.owner}/${repo.repo} · ${workflowName} · run #${run.runNumber}`);
  lines.push("");
  lines.push(`- workflow: ${workflowName}`);
  lines.push(`- run: [#${run.runNumber}](${run.htmlUrl})`);
  lines.push(`- event: \`${run.event}\``);
  if (run.headBranch) lines.push(`- branch: \`${run.headBranch}\``);
  lines.push(`- commit: \`${run.headSha.slice(0, 7)}\``);
  if (run.actorLogin) lines.push(`- actor: \`${run.actorLogin}\``);
  lines.push(`- job: **${job.name}** — \`${job.conclusion ?? job.status}\``);
  if (failingStep) {
    lines.push(`- failing step: **${failingStep.number}. ${failingStep.name}** — \`${failingStep.conclusion ?? failingStep.status}\``);
  } else {
    lines.push(`- failing step: (none clearly identified — showing tail)`);
  }
  lines.push("");
  lines.push("## Log excerpt");
  lines.push("");
  lines.push("```");
  lines.push(excerpt);
  lines.push("```");
  return lines.join("\n");
}
