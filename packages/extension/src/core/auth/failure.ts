/**
 * Structured detail about a GitHub API failure that we suspect is auth-related
 * (401, 403) or otherwise blocks the extension from making progress.
 *
 * The point is to *never* render a generic "Unable to connect" message with a
 * dead refresh button. Whenever we can, we capture enough structure to tell
 * the user:
 *
 *   - what the API actually said,
 *   - which endpoint it said it about,
 *   - and — when the scopes on their token don't match what the API needs —
 *     which scope is missing.
 *
 * Kept in core/ with zero vscode/octokit imports so selectors and tests can
 * work against plain objects.
 */

export type AuthFailureKind =
  | "bad-credentials" // 401 — token missing, expired, or revoked
  | "insufficient-scope" // 403 with documented scope mismatch
  | "forbidden" // 403 without scope info (SSO gate, rate limit, etc.)
  | "not-found" // 404 — often an auth-signal (private repo, no access)
  | "server-error" // 5xx — GitHub side, not our fault
  | "network" // no HTTP response (DNS, offline, timeout)
  | "other"; // any other status we surface

export interface AuthFailure {
  readonly kind: AuthFailureKind;
  readonly status: number | null; // null when no HTTP response was received
  readonly message: string;
  readonly route: string | null;
  readonly documentationUrl: string | null;
  /**
   * The OAuth scopes currently attached to the token, as reported by GitHub in
   * `x-oauth-scopes`. Parsed from the comma-separated header value. An empty
   * array means the header was present but listed no scopes (e.g. a fresh
   * unauthenticated session or a fine-grained PAT, which reports scopes
   * differently).
   */
  readonly currentScopes: readonly string[] | null;
  /**
   * Scopes GitHub said the endpoint accepts, from `x-accepted-oauth-scopes`.
   * Empty array = endpoint is public / no scope needed.
   */
  readonly acceptedScopes: readonly string[] | null;
  /**
   * Scopes we asked `vscode.authentication` for. Used to show the user the
   * gap between "what this extension requested" and "what GitHub requires".
   */
  readonly requestedScopes: readonly string[];
  readonly occurredAt: string; // ISO timestamp
}

export interface ClassifyInput {
  readonly status: number | null;
  readonly message: string;
  readonly route: string | null;
  readonly headers?: Readonly<Record<string, unknown>> | undefined;
  readonly documentationUrl?: string | null | undefined;
  readonly requestedScopes: readonly string[];
  readonly now?: Date;
}

/**
 * Turn a raw API failure into a structured AuthFailure. Pure — no I/O. The
 * caller is responsible for pulling headers off the Octokit error and passing
 * them in; this function decides what the failure *means*.
 */
export function classifyAuthFailure(input: ClassifyInput): AuthFailure {
  const currentScopes = parseScopes(input.headers?.["x-oauth-scopes"]);
  const acceptedScopes = parseScopes(input.headers?.["x-accepted-oauth-scopes"]);
  const kind = classifyKind(input.status, currentScopes, acceptedScopes);
  return {
    kind,
    status: input.status,
    message: input.message,
    route: input.route,
    documentationUrl: input.documentationUrl ?? null,
    currentScopes,
    acceptedScopes,
    requestedScopes: input.requestedScopes,
    occurredAt: (input.now ?? new Date()).toISOString(),
  };
}

function classifyKind(
  status: number | null,
  currentScopes: readonly string[] | null,
  acceptedScopes: readonly string[] | null,
): AuthFailureKind {
  if (status === null) return "network";
  if (status === 401) return "bad-credentials";
  if (status === 403) {
    if (acceptedScopes && acceptedScopes.length > 0) {
      const have = new Set(currentScopes ?? []);
      const missing = acceptedScopes.some((s) => !have.has(s));
      if (missing) return "insufficient-scope";
    }
    return "forbidden";
  }
  if (status === 404) return "not-found";
  if (status >= 500) return "server-error";
  return "other";
}

function parseScopes(raw: unknown): readonly string[] | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  return trimmed.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * A short human-readable one-liner suitable for a tree-view label. Deliberately
 * shorter than the full failure — secondary detail goes in the description.
 */
export function summariseAuthFailure(f: AuthFailure): string {
  switch (f.kind) {
    case "bad-credentials":
      return "GitHub rejected the token (401 Bad credentials)";
    case "insufficient-scope": {
      const missing = missingScopes(f);
      if (missing.length > 0) return `GitHub requires scope: ${missing.join(", ")}`;
      return "GitHub requires additional OAuth scopes";
    }
    case "forbidden":
      return `GitHub refused the request (403${f.message ? `: ${trim(f.message)}` : ""})`;
    case "not-found":
      return "Repository not found or no access (404)";
    case "server-error":
      return `GitHub server error (${f.status}). Try again shortly.`;
    case "network":
      return "Unable to reach GitHub. Check your network.";
    case "other":
      return `GitHub API error${f.status ? ` (${f.status})` : ""}: ${trim(f.message)}`;
  }
}

/**
 * Scopes that would plausibly fix an insufficient-scope failure. Only meaningful
 * for `kind === "insufficient-scope"`, but safe to call on any failure —
 * returns [] for the others.
 */
export function missingScopes(f: AuthFailure): readonly string[] {
  if (f.kind !== "insufficient-scope") return [];
  if (!f.acceptedScopes) return [];
  const have = new Set(f.currentScopes ?? []);
  return f.acceptedScopes.filter((s) => !have.has(s));
}

function trim(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 80 ? one.slice(0, 77) + "\u2026" : one;
}

/**
 * A markdown-formatted diagnostic report for a single failure. Suited to
 * opening as an untitled document so the user can read, copy, or share it
 * verbatim — much friendlier than a modal toast.
 */
export function formatAuthFailureMarkdown(failure: AuthFailure): string {
  const lines: string[] = [];
  lines.push(`# GitHub Actions Monitor \u2014 connection failed`);
  lines.push("");
  lines.push(summariseAuthFailure(failure));
  lines.push("");
  lines.push(`- **Status**: ${failure.status ?? "(no response)"}`);
  lines.push(`- **Kind**: \`${failure.kind}\``);
  if (failure.route) lines.push(`- **Endpoint**: \`${failure.route}\``);
  if (failure.message) lines.push(`- **Message**: ${failure.message}`);
  if (failure.documentationUrl) lines.push(`- **GitHub docs**: ${failure.documentationUrl}`);
  lines.push(`- **Occurred**: ${failure.occurredAt}`);
  lines.push("");
  lines.push("## OAuth scopes");
  lines.push("");
  lines.push(`- **Requested by this extension**: ${fmtScopes(failure.requestedScopes)}`);
  lines.push(`- **On your current token**: ${fmtScopes(failure.currentScopes)}`);
  lines.push(`- **Required by the endpoint**: ${fmtScopes(failure.acceptedScopes)}`);
  const missing = missingScopes(failure);
  if (missing.length > 0) {
    lines.push("");
    lines.push(`> **Missing**: \`${missing.join("`, `")}\`. Re-authenticate and accept the additional scope.`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("If this persists, open an issue with the above block (scopes redacted if sensitive).");
  return lines.join("\n");
}

function fmtScopes(scopes: readonly string[] | null): string {
  if (scopes === null) return "_(not reported by GitHub)_";
  if (scopes.length === 0) return "_(none)_";
  return scopes.map((s) => `\`${s}\``).join(", ");
}
