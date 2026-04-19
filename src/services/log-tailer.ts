import * as vscode from "vscode";
import type { JobContext, RepoCoordinates } from "../domain/types.js";
import { isActiveStatus } from "../domain/types.js";
import type { LogService } from "./log-service.js";
import type { WorkflowStore } from "./workflow-store.js";
import type { Logger } from "../util/logger.js";

const POLL_MS = 2500;

interface Tail {
  readonly jobId: number;
  readonly channel: vscode.OutputChannel;
  timer: NodeJS.Timeout | null;
  lastContent: string;
  disposed: boolean;
}

/**
 * For an in-flight job, open a dedicated OutputChannel and stream new log
 * bytes to it every POLL_MS until the job completes.
 *
 * Uses the shared LogService cache so tailing doesn't duplicate fetches
 * driven by the tree's eager load — LogService handles cache invalidation
 * for non-completed jobs on every getJobLog call.
 *
 * Tails auto-stop when:
 *   - the job transitions to completed (one final fetch, then close);
 *   - the user invokes stopTail;
 *   - the service is disposed.
 */
export class LogTailer implements vscode.Disposable {
  private readonly tails = new Map<number, Tail>();
  private readonly storeSubscription: vscode.Disposable;

  constructor(
    private readonly logs: LogService,
    private readonly store: WorkflowStore,
    private readonly log: Logger,
  ) {
    // When the store updates, any tail whose job just completed should
    // fetch a final chunk and stop. Cheap: we only act on the tails we own.
    this.storeSubscription = store.onDidChange(() => this.reconcile());
  }

  /**
   * Start tailing a job. If the job is already completed, we render the
   * final log once and don't poll — still useful as a "jump to output
   * channel" action for completed runs.
   */
  async start(repo: RepoCoordinates, ctx: JobContext): Promise<void> {
    const existing = this.tails.get(ctx.job.id);
    if (existing) {
      existing.channel.show(true);
      return;
    }

    const channel = vscode.window.createOutputChannel(`GA · ${shortLabel(ctx)}`);
    const tail: Tail = { jobId: ctx.job.id, channel, timer: null, lastContent: "", disposed: false };
    this.tails.set(ctx.job.id, tail);

    channel.appendLine(`# ${ctx.workflowName} · run #${ctx.run.runNumber} · ${ctx.job.name}`);
    channel.appendLine(`# ${ctx.run.htmlUrl}`);
    channel.appendLine("");
    channel.show(true);

    await this.pollOnce(repo, ctx, tail);
    if (!isActiveStatus(ctx.job.status)) {
      this.finish(tail, "job already completed");
      return;
    }
    tail.timer = setInterval(() => {
      void this.pollOnce(repo, ctx, tail);
    }, POLL_MS);
  }

  stop(jobId: number): void {
    const tail = this.tails.get(jobId);
    if (tail) this.finish(tail, "stopped");
  }

  /** Is a tail currently running for this job? */
  isRunning(jobId: number): boolean {
    return this.tails.has(jobId);
  }

  dispose(): void {
    this.storeSubscription.dispose();
    for (const t of [...this.tails.values()]) this.finish(t, "disposed");
  }

  // --- internals ---------------------------------------------------------

  private async pollOnce(repo: RepoCoordinates, ctx: JobContext, tail: Tail): Promise<void> {
    if (tail.disposed) return;
    // Pull the live job (may have updated steps/status since `ctx` was made).
    const latest = this.store.resolveJob(ctx.run.id, ctx.job.id);
    const current = latest ? latest.job : ctx.job;
    try {
      const full = await this.logs.getJobLog(repo, current, { force: true });
      if (full.length > tail.lastContent.length && full.startsWith(tail.lastContent)) {
        tail.channel.append(full.slice(tail.lastContent.length));
      } else if (full !== tail.lastContent) {
        // Non-monotonic update (log rotated / reformatted). Replace wholesale.
        tail.channel.replace(full);
      }
      tail.lastContent = full;
    } catch (err) {
      this.log.warn(`LogTailer poll failed for job ${ctx.job.id}`, err);
    }
    if (!isActiveStatus(current.status)) this.finish(tail, "job completed");
  }

  private reconcile(): void {
    for (const tail of this.tails.values()) {
      const jobCtx = findAnyJob(this.store, tail.jobId);
      if (!jobCtx) continue;
      if (!isActiveStatus(jobCtx.job.status)) this.finish(tail, "store reports completed");
    }
  }

  private finish(tail: Tail, reason: string): void {
    if (tail.disposed) return;
    tail.disposed = true;
    if (tail.timer) { clearInterval(tail.timer); tail.timer = null; }
    tail.channel.appendLine("");
    tail.channel.appendLine(`# tail stopped (${reason})`);
    this.tails.delete(tail.jobId);
    // Leave the channel visible for the user; they dispose by closing it.
  }
}

function shortLabel(ctx: JobContext): string {
  return `${ctx.workflowName} #${ctx.run.runNumber} · ${ctx.job.name}`;
}

function findAnyJob(store: WorkflowStore, jobId: number): JobContext | null {
  const snap = store.snapshot();
  for (const [, jobs] of snap.jobsByRunId) {
    const job = jobs.find((j) => j.id === jobId);
    if (job) return store.resolveJob(job.runId, jobId);
  }
  return null;
}
