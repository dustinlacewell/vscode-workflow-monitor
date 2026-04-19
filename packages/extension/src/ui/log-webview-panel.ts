import * as vscode from "vscode";
import type { JobContext, RepoCoordinates, Step } from "../domain/types.js";
import { isActiveStatus } from "../domain/types.js";
import type { LogService } from "../services/log-service.js";
import type { WorkflowStore } from "../services/workflow-store.js";
import type { Logger } from "../util/logger.js";
import { parseLog } from "../util/log-parser.js";
import { enrichSections, type EnrichedSection } from "../util/log-sections.js";
import { STYLES } from "../webview/styles.js";
import type {
  ExtensionToWebview,
  FocusRequest,
  HeaderModel,
  LogSnapshot,
  WebviewToExtension,
} from "../webview/protocol.js";

export interface ShowOptions {
  /** When set, the webview focuses the matching section on open. */
  readonly focusStep?: Step | null;
  /** When true, other sections are folded on open (step clicks). */
  readonly foldOthers?: boolean;
}

/**
 * Multiplexes webview panels so each GitHub Actions job gets at most one
 * rich log view. Re-clicking a tree row reveals the existing panel instead
 * of spawning a new one, which matches VS Code's usual "one resource, one
 * tab" mental model.
 */
export class LogWebviewService implements vscode.Disposable {
  private readonly panels = new Map<number, LogPanel>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly logs: LogService,
    private readonly store: WorkflowStore,
    private readonly log: Logger,
  ) {}

  show(repo: RepoCoordinates, ctx: JobContext, opts: ShowOptions = {}): void {
    const existing = this.panels.get(ctx.job.id);
    if (existing) {
      existing.reveal(opts);
      return;
    }
    const panel = new LogPanel(this.extensionUri, this.logs, this.store, this.log, repo, ctx);
    panel.onDidDispose(() => this.panels.delete(ctx.job.id));
    this.panels.set(ctx.job.id, panel);
    panel.reveal(opts);
  }

  dispose(): void {
    for (const panel of [...this.panels.values()]) panel.dispose();
    this.panels.clear();
  }
}

/**
 * Single VS Code webview panel for one job. Owns:
 *   - the panel lifecycle (creation, disposal, HTML payload);
 *   - the fetch → parse → enrich → post loop, triggered on open, on
 *     LogService cache updates, and on WorkflowStore transitions;
 *   - a lightweight pre-ready message queue so focus requests emitted before
 *     the client signals "ready" still apply to the first render.
 */
class LogPanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly subs: vscode.Disposable[] = [];
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  private ctx: JobContext;
  private ready = false;
  private pendingPost: ExtensionToWebview | null = null;
  private pendingFocus: PendingFocus | null = null;
  private refreshing: Promise<void> | null = null;
  private refreshQueued = false;
  private generation = 0;

  readonly onDidDispose = this.disposeEmitter.event;

  constructor(
    extensionUri: vscode.Uri,
    private readonly logs: LogService,
    private readonly store: WorkflowStore,
    private readonly log: Logger,
    private readonly repo: RepoCoordinates,
    ctx: JobContext,
  ) {
    this.ctx = ctx;
    this.panel = vscode.window.createWebviewPanel(
      "workflowMonitor.jobLog",
      panelTitle(ctx),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
      },
    );
    this.panel.webview.html = renderHtml(this.panel.webview, extensionUri);
    this.panel.iconPath = new vscode.ThemeIcon("output");
    this.panel.onDidDispose(() => this.dispose());
    this.panel.webview.onDidReceiveMessage((msg) => void this.handleMessage(msg));

    this.subs.push(
      logs.onDidUpdate((jobId) => { if (jobId === this.ctx.job.id) this.scheduleRefresh(); }),
      store.onDidChange(() => { if (this.syncCtx()) this.scheduleRefresh(); }),
    );
  }

  reveal(opts: ShowOptions): void {
    this.panel.reveal(undefined, false);
    this.pendingFocus = {
      stepNumber: opts.focusStep?.number ?? null,
      foldOthers: opts.foldOthers ?? false,
    };
    this.scheduleRefresh();
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.subs.length = 0;
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
    try { this.panel.dispose(); } catch { /* already disposed */ }
  }

  // --- refresh orchestration ---------------------------------------------

  private scheduleRefresh(): void {
    if (this.refreshing) { this.refreshQueued = true; return; }
    this.refreshing = this.runRefresh().finally(() => {
      this.refreshing = null;
      if (this.refreshQueued) { this.refreshQueued = false; this.scheduleRefresh(); }
    });
  }

  private async runRefresh(): Promise<void> {
    try {
      const active = isActiveStatus(this.ctx.job.status);
      const raw = await this.logs.getJobLogRaw(this.repo, this.ctx.job, { force: active });
      const sections = enrichSections(parseLog(raw), this.ctx.job.steps, this.ctx.job.status);
      const snapshot: LogSnapshot = {
        header: buildHeader(this.repo, this.ctx),
        sections,
        isTailing: active,
        generation: ++this.generation,
      };
      this.post({ type: "snapshot", snapshot, ...this.consumeFocus(sections) });
    } catch (err) {
      this.log.warn(`LogPanel refresh failed for job ${this.ctx.job.id}`, err);
      this.post({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  private consumeFocus(sections: readonly EnrichedSection[]): { focus?: FocusRequest } {
    const pending = this.pendingFocus;
    if (!pending) return {};
    this.pendingFocus = null;
    const sectionId = pending.stepNumber !== null
      ? sections.find((s) => s.stepNumber === pending.stepNumber)?.id ?? null
      : null;
    return { focus: { sectionId, foldOthers: pending.foldOthers } };
  }

  private syncCtx(): boolean {
    const latest = this.store.resolveJob(this.ctx.run.id, this.ctx.job.id);
    if (!latest) return false;
    const changed = latest.job.status !== this.ctx.job.status
      || latest.job.conclusion !== this.ctx.job.conclusion;
    this.ctx = latest;
    if (changed) this.panel.title = panelTitle(latest);
    return changed;
  }

  // --- message pump ------------------------------------------------------

  private post(msg: ExtensionToWebview): void {
    if (!this.ready) {
      // Only keep the most recent message — stale snapshots/errors have no value.
      this.pendingPost = msg;
      return;
    }
    void this.panel.webview.postMessage(msg);
  }

  private async handleMessage(msg: WebviewToExtension): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.ready = true;
        if (this.pendingPost) {
          const pending = this.pendingPost;
          this.pendingPost = null;
          void this.panel.webview.postMessage(pending);
        }
        return;
      case "openExternal":
        if (typeof msg.url === "string" && msg.url.length > 0) {
          void vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
        return;
      case "copyLog":
        try {
          const text = await this.logs.getJobLog(this.repo, this.ctx.job);
          await vscode.env.clipboard.writeText(text);
          vscode.window.showInformationMessage(`Copied log for ${this.ctx.job.name}.`);
        } catch (err) {
          vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
        }
        return;
      case "copyFailureContext":
        await vscode.commands.executeCommand(
          "workflowMonitor.copyFailureContextForJob",
          this.ctx.job.id,
          this.ctx.run.id,
        );
        return;
    }
  }
}

interface PendingFocus {
  readonly stepNumber: number | null;
  readonly foldOthers: boolean;
}

function panelTitle(ctx: JobContext): string {
  return `${ctx.job.name} · #${ctx.run.runNumber}`;
}

function buildHeader(repo: RepoCoordinates, ctx: JobContext): HeaderModel {
  return {
    ownerRepo: `${repo.owner}/${repo.repo}`,
    workflowName: ctx.workflowName,
    runNumber: ctx.run.runNumber,
    jobName: ctx.job.name,
    jobStatus: ctx.job.status,
    jobConclusion: ctx.job.conclusion,
    branch: ctx.run.headBranch,
    sha: ctx.run.headSha.slice(0, 7),
    htmlUrl: ctx.run.htmlUrl,
    actor: ctx.run.actorLogin ?? null,
  };
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = makeNonce();
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.js"));
  const csp = [
    `default-src 'none'`,
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
  ].join("; ");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <title>GitHub Actions Log</title>
    <style nonce="${nonce}">${STYLES}</style>
  </head>
  <body>
    <div id="app">
      <header class="header"></header>
      <main id="sections"></main>
      <footer></footer>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}

function makeNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}
