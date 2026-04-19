/**
 * Split a cleaned GitHub Actions log into structured sections.
 *
 * The runner emits two kinds of markers:
 *   ##[group]<name>          — starts a new step/sub-group; its visible
 *                              output runs until the next `##[group]` or EOF.
 *   ##[endgroup]             — closes the "metadata" block inside a step but
 *                              NOT the step itself; output after it still
 *                              belongs to the same step.
 *   ##[error|warning|notice] — severity annotations (tagged on the section).
 *
 * Consequences of the endgroup-is-not-a-boundary rule:
 *   - what we used to call "preamble" (content between `endgroup` and the
 *     next `group`) is really just the current step's output, and is now
 *     correctly attributed to the current section;
 *   - `##[endgroup]` marker lines are dropped from the body so they don't
 *     appear as visual noise.
 *
 * Nested `##[group]` blocks become flat sibling sections — the user sees one
 * foldable row per group regardless of original nesting. Fine for v1; if we
 * later want to collapse sub-groups under their parent step we can do that
 * in a post-pass against `job.steps`.
 */

const GROUP_START = /^##\[(?:group|section)\](.*)$/;
const GROUP_END = /^##\[(?:endgroup|endsection)\]/;
const SEVERITY = /^##\[(error|warning|notice)\]/;

export type SeverityKind = "error" | "warning" | "notice";

export interface ParsedSection {
  readonly name: string;
  /** Section body, ANSI preserved, marker lines stripped. */
  readonly raw: string;
  /** True for the final section of the log — i.e. the currently-growing tail. */
  readonly isTail: boolean;
  readonly severities: ReadonlyArray<SeverityKind>;
}

export function parseLog(text: string): ParsedSection[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  const out: ParsedSection[] = [];
  const preamble: string[] = [];
  let current: { name: string; body: string[]; severities: Set<SeverityKind> } | null = null;

  const flush = () => {
    if (!current) return;
    out.push({
      name: current.name,
      raw: current.body.join("\n"),
      isTail: false,
      severities: [...current.severities],
    });
    current = null;
  };

  for (const line of lines) {
    const start = GROUP_START.exec(line);
    if (start) {
      flush();
      if (out.length === 0 && hasVisibleContent(preamble)) {
        out.push({
          name: "(setup)",
          raw: preamble.join("\n"),
          isTail: false,
          severities: [],
        });
      }
      preamble.length = 0;
      current = {
        name: (start[1] ?? "").trim() || "(unnamed)",
        body: [],
        severities: new Set(),
      };
      continue;
    }
    if (GROUP_END.test(line)) continue; // absorbed — not a section boundary
    const sev = SEVERITY.exec(line);
    if (current) {
      current.body.push(line);
      if (sev) current.severities.add(sev[1] as SeverityKind);
    } else {
      preamble.push(line);
    }
  }

  if (current) {
    out.push({
      name: current.name,
      raw: current.body.join("\n"),
      isTail: true,
      severities: [...current.severities],
    });
  } else if (out.length > 0) {
    const last = out[out.length - 1]!;
    out[out.length - 1] = { ...last, isTail: true };
  }

  // No groups at all — surface the log as one synthetic section so the UI has
  // something to render.
  if (out.length === 0 && hasVisibleContent(preamble)) {
    out.push({
      name: "(output)",
      raw: preamble.join("\n"),
      isTail: true,
      severities: [],
    });
  }

  return out;
}

function hasVisibleContent(lines: readonly string[]): boolean {
  return lines.some((l) => l.trim().length > 0);
}
