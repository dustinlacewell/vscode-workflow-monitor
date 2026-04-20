import * as vscode from "vscode";
import type { JobContext, RepoCoordinates } from "../core/domain/types.js";
import type { LogService } from "./log-service.js";
import type { WorkflowStore } from "./workflow-store.js";
import type { Logger } from "../util/logger.js";

type Severity = "error" | "warning" | "notice";

export interface ParsedAnnotation {
  readonly severity: Severity;
  readonly file: string | null;
  readonly line: number | null;
  readonly column: number | null;
  readonly endLine: number | null;
  readonly endColumn: number | null;
  readonly title: string | null;
  readonly message: string;
}

/**
 * Bridges CI failures into VS Code's Problems panel.
 *
 * For each completed (non-success) job we have logs cached for, we parse the
 * GitHub-Actions-workflow-command annotation lines (`::error file=...::msg`
 * and the older `##[error]` form) and materialise them as vscode.Diagnostic
 * entries on a dedicated DiagnosticCollection.
 *
 * Annotations without a file path are dropped silently — without a URI we
 * can't anchor them in a document. The richer check-run-annotations API
 * surfaces those too, but parsing logs keeps us off one extra endpoint and
 * works even for forked repos where the annotations API is rate-limited.
 */
export class DiagnosticsService implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly storeSubscription: vscode.Disposable;
  // Per-job set of URIs we contributed to; lets us revoke cleanly when a run rotates out.
  private readonly contributedByJob = new Map<number, Set<string>>();
  // Inflight de-dupe keyed by jobId so repeat store events don't double-fetch.
  private readonly inflight = new Set<number>();

  constructor(
    private readonly logs: LogService,
    private readonly store: WorkflowStore,
    private readonly log: Logger,
  ) {
    this.collection = vscode.languages.createDiagnosticCollection("github-actions");
    this.storeSubscription = store.onDidChange(() => void this.reconcile());
  }

  dispose(): void {
    this.storeSubscription.dispose();
    this.collection.dispose();
  }

  /** Drop all diagnostics this service has produced. */
  clear(): void {
    this.collection.clear();
    this.contributedByJob.clear();
  }

  // --- internals ---------------------------------------------------------

  private async reconcile(): Promise<void> {
    const snap = this.store.snapshot();
    if (!snap.repo) { this.clear(); return; }

    // Revoke jobs whose runs are no longer cached.
    const liveJobIds = new Set<number>();
    for (const jobs of snap.jobsByRunId.values()) for (const j of jobs) liveJobIds.add(j.id);
    for (const jobId of [...this.contributedByJob.keys()]) {
      if (!liveJobIds.has(jobId)) this.revokeJob(jobId);
    }

    // For each completed non-success job, ensure we've ingested its log.
    for (const jobs of snap.jobsByRunId.values()) {
      for (const job of jobs) {
        if (job.status !== "completed") continue;
        if (job.conclusion === "success" || job.conclusion === "skipped" || job.conclusion === null) continue;
        if (this.contributedByJob.has(job.id)) continue;
        if (this.inflight.has(job.id)) continue;
        const ctx = this.store.resolveJob(job.runId, job.id);
        if (!ctx) continue;
        this.inflight.add(job.id);
        void this.ingestJob(snap.repo, ctx).finally(() => this.inflight.delete(job.id));
      }
    }
  }

  private async ingestJob(repo: RepoCoordinates, ctx: JobContext): Promise<void> {
    let logText: string;
    try { logText = await this.logs.getJobLog(repo, ctx.job); }
    catch (err) { this.log.warn(`Diagnostics: log fetch failed for job ${ctx.job.id}`, err); return; }

    const annotations = parseAnnotations(logText);
    if (annotations.length === 0) { this.contributedByJob.set(ctx.job.id, new Set()); return; }

    const byUri = new Map<string, vscode.Diagnostic[]>();
    for (const ann of annotations) {
      const uri = resolveToWorkspaceUri(ann.file);
      if (!uri) continue;
      const diag = toDiagnostic(ann, ctx);
      const list = byUri.get(uri.toString()) ?? [];
      list.push(diag);
      byUri.set(uri.toString(), list);
    }

    // Merge with whatever's already on each URI (e.g. annotations from
    // another job of the same run — both contribute to the same file).
    const touched = new Set<string>();
    for (const [uriStr, diags] of byUri) {
      const uri = vscode.Uri.parse(uriStr);
      const existing = this.collection.get(uri) ?? [];
      this.collection.set(uri, [...existing, ...diags]);
      touched.add(uriStr);
    }
    this.contributedByJob.set(ctx.job.id, touched);
  }

  private revokeJob(jobId: number): void {
    const uris = this.contributedByJob.get(jobId);
    if (!uris) return;
    for (const uriStr of uris) {
      const uri = vscode.Uri.parse(uriStr);
      const existing = this.collection.get(uri) ?? [];
      const remaining = existing.filter((d) => (d.source === `github-actions[#${jobId}]`) === false);
      this.collection.set(uri, remaining);
    }
    this.contributedByJob.delete(jobId);
  }
}

// --- parsing ---------------------------------------------------------------

// Matches both the new `::error file=...,line=...::msg` and legacy
// `##[error]file=...,line=...::msg` forms. Captures severity + param blob + message.
const LINE_RE = /(?:::(error|warning|notice)(?:\s+([^:]*))?::(.*))|(?:##\[(error|warning|notice)\](.*))/;

/** Pure parser — takes a cleaned log string and yields annotations. */
export function parseAnnotations(log: string): ParsedAnnotation[] {
  const out: ParsedAnnotation[] = [];
  for (const line of log.split(/\r?\n/)) {
    const m = line.match(LINE_RE);
    if (!m) continue;

    if (m[1]) {
      // `::<severity> [params]::<message>`
      const severity = m[1] as Severity;
      const params = parseParams(m[2] ?? "");
      const message = m[3] ?? "";
      out.push(buildAnnotation(severity, params, message));
    } else if (m[4]) {
      // `##[<severity>] <rest>` — `rest` may be `file=...,line=...::msg` or just a message.
      const severity = m[4] as Severity;
      const rest = m[5] ?? "";
      const split = rest.indexOf("::");
      if (split >= 0) {
        const params = parseParams(rest.slice(0, split));
        const message = rest.slice(split + 2);
        out.push(buildAnnotation(severity, params, message));
      } else {
        out.push(buildAnnotation(severity, {}, rest));
      }
    }
  }
  return out;
}

function parseParams(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const piece of raw.split(",")) {
    const eq = piece.indexOf("=");
    if (eq < 0) continue;
    const k = piece.slice(0, eq).trim();
    const v = piece.slice(eq + 1).trim();
    if (k) params[k] = v;
  }
  return params;
}

function buildAnnotation(severity: Severity, params: Record<string, string>, message: string): ParsedAnnotation {
  const num = (v: string | undefined) => {
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  return {
    severity,
    file: params["file"] ?? null,
    line: num(params["line"]),
    column: num(params["col"]) ?? num(params["column"]),
    endLine: num(params["endLine"]),
    endColumn: num(params["endColumn"]) ?? num(params["endCol"]),
    title: params["title"] ?? null,
    message: unescapeMessage(message.trim()),
  };
}

/** GitHub escapes some characters in the message payload. */
function unescapeMessage(msg: string): string {
  return msg
    .replace(/%25/g, "%")
    .replace(/%0D/g, "\r")
    .replace(/%0A/g, "\n")
    .replace(/%3A/g, ":")
    .replace(/%2C/g, ",");
}

// --- resolution + diagnostic construction ----------------------------------

function resolveToWorkspaceUri(file: string | null): vscode.Uri | null {
  if (!file) return null;
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;

  // GitHub-runner absolute paths look like
  //   /home/runner/work/<repo>/<repo>/src/foo.ts
  //   D:\a\<repo>\<repo>\src\foo.ts
  // Strip everything up to and including the second occurrence of repo slug.
  const relative = stripRunnerPrefix(file);
  for (const folder of folders) {
    const candidate = vscode.Uri.joinPath(folder.uri, relative);
    // We can't check existence synchronously without I/O; trust the first
    // folder as a best guess. If the file doesn't exist VS Code shows the
    // diagnostic orphaned but still in Problems panel, which is acceptable.
    return candidate;
  }
  return null;
}

function stripRunnerPrefix(file: string): string {
  const normalized = file.replace(/\\/g, "/");
  const work = normalized.match(/\/work\/[^/]+\/[^/]+\/(.+)$/);
  if (work) return work[1]!;
  if (normalized.startsWith("/")) return normalized.replace(/^\/+/, "");
  return normalized;
}

function toDiagnostic(ann: ParsedAnnotation, ctx: JobContext): vscode.Diagnostic {
  const line0 = Math.max(0, (ann.line ?? 1) - 1);
  const col0 = Math.max(0, (ann.column ?? 1) - 1);
  const endLine0 = ann.endLine !== null ? Math.max(0, ann.endLine - 1) : line0;
  const endCol0 = ann.endColumn !== null ? Math.max(0, ann.endColumn - 1) : col0 + 1;

  const range = new vscode.Range(line0, col0, endLine0, Math.max(endCol0, col0 + 1));
  const header = ann.title ? `${ann.title}: ` : "";
  const diag = new vscode.Diagnostic(range, `${header}${ann.message}`, severityToVsCode(ann.severity));
  diag.source = `github-actions[#${ctx.job.id}]`;
  diag.code = `${ctx.workflowName} · ${ctx.job.name}`;
  return diag;
}

function severityToVsCode(s: Severity): vscode.DiagnosticSeverity {
  switch (s) {
    case "error": return vscode.DiagnosticSeverity.Error;
    case "warning": return vscode.DiagnosticSeverity.Warning;
    case "notice": return vscode.DiagnosticSeverity.Information;
  }
}
