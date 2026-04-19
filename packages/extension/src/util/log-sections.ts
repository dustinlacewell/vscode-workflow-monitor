import type { RunStatus, Step } from "../domain/types.js";
import { isActiveStatus } from "../domain/types.js";
import type { ParsedSection, SeverityKind } from "./log-parser.js";

/**
 * Builds the webview's view-model by projecting parsed log sections onto the
 * job's step list. The goal is one foldable per *step*, not one per
 * `##[group]` marker.
 *
 *   - A parsed section whose name matches a step (`Run <step.name>`, exact
 *     match, `Post Run <name>`, etc.) becomes a top-level `EnrichedSection`.
 *   - Parsed sections that don't match — the nested sub-groups GitHub emits
 *     inside a step's output, like `Operating System` inside "Set up job" —
 *     get merged into the preceding step, keeping their group header as a
 *     sentinel `##[group]NAME` line so the webview can render it as an
 *     inline sub-header "road marker" instead of a collapsible.
 *
 * Pure function: no VS Code dependency, trivially testable.
 */

export type SectionStatus =
  | "pending"
  | "running"
  | "success"
  | "failure"
  | "skipped"
  | "cancelled"
  | "neutral"
  | "unknown";

export interface EnrichedSection {
  readonly id: string;
  readonly name: string;
  readonly raw: string;
  readonly status: SectionStatus;
  readonly durationMs: number | null;
  readonly stepNumber: number | null;
  readonly severities: ReadonlyArray<SeverityKind>;
}

export function enrichSections(
  sections: readonly ParsedSection[],
  steps: readonly Step[],
  jobStatus: RunStatus,
): EnrichedSection[] {
  if (steps.length === 0) {
    // No step info — fall back to rendering parsed sections flat so users
    // still see *something* instead of an empty view.
    return sections.map((sec, i) => flatSection(sec, i, isActiveStatus(jobStatus)));
  }
  const jobActive = isActiveStatus(jobStatus);
  const used = new Set<number>();
  const accumulators: Accumulator[] = [];
  let current: Accumulator | null = null;

  for (const sec of sections) {
    const match = findMatchingStep(sec.name, steps, used);
    if (match) {
      used.add(match.number);
      if (current) accumulators.push(current);
      current = accumulatorFor(sec, match);
      continue;
    }
    if (!current) {
      // Content before any step boundary belongs to the first not-yet-used
      // step — typically "Set up job", which often has no `##[group]Set up job`
      // header and just starts emitting `##[group]Operating System` directly.
      const first = steps.find((s) => !used.has(s.number));
      if (first) used.add(first.number);
      current = accumulatorFor(null, first ?? null);
    }
    mergeSubgroup(current, sec);
  }
  if (current) accumulators.push(current);

  return accumulators.map((a, i) => finalize(a, i, jobActive));
}

interface Accumulator {
  readonly name: string;
  readonly step: Step | null;
  readonly lines: string[];
  readonly severities: Set<SeverityKind>;
  tail: boolean;
}

function accumulatorFor(sec: ParsedSection | null, step: Step | null): Accumulator {
  const name = sec?.name ?? step?.name ?? "(setup)";
  const acc: Accumulator = {
    name,
    step,
    lines: [],
    severities: new Set(sec?.severities ?? []),
    tail: sec?.isTail ?? false,
  };
  if (sec && sec.raw.length > 0) acc.lines.push(sec.raw);
  return acc;
}

function mergeSubgroup(acc: Accumulator, sec: ParsedSection): void {
  // Synthetic parser names (`(setup)`, `(output)`) are noise in a road-marker
  // view — don't emit a header line for them, just fold the body in.
  if (!isSynthetic(sec.name)) {
    acc.lines.push(`##[group]${sec.name}`);
  }
  if (sec.raw.length > 0) acc.lines.push(sec.raw);
  for (const sev of sec.severities) acc.severities.add(sev);
  if (sec.isTail) acc.tail = true;
}

function finalize(acc: Accumulator, index: number, jobActive: boolean): EnrichedSection {
  const raw = acc.lines.join("\n");
  if (acc.step) {
    return {
      id: sectionId(index),
      name: acc.name,
      raw,
      status: stepStatus(acc.step.status, acc.step.conclusion),
      durationMs: duration(acc.step.startedAt, acc.step.completedAt),
      stepNumber: acc.step.number,
      severities: [...acc.severities],
    };
  }
  const hasError = acc.severities.has("error");
  return {
    id: sectionId(index),
    name: acc.name,
    raw,
    status: acc.tail && jobActive ? "running" : hasError ? "failure" : "neutral",
    durationMs: null,
    stepNumber: null,
    severities: [...acc.severities],
  };
}

function flatSection(sec: ParsedSection, index: number, jobActive: boolean): EnrichedSection {
  const hasError = sec.severities.includes("error");
  return {
    id: sectionId(index),
    name: sec.name,
    raw: sec.raw,
    status: sec.isTail && jobActive ? "running" : hasError ? "failure" : "neutral",
    durationMs: null,
    stepNumber: null,
    severities: sec.severities,
  };
}

function findMatchingStep(
  name: string,
  steps: readonly Step[],
  used: ReadonlySet<number>,
): Step | null {
  const trimmed = name.trim();
  const candidates = [
    trimmed,
    trimmed.replace(/^Run\s+/, ""),
    trimmed.replace(/^Post\s+Run\s+/, ""),
    trimmed.replace(/^Post\s+/, ""),
  ];
  for (const step of steps) {
    if (used.has(step.number)) continue;
    if (candidates.includes(step.name)) return step;
  }
  return null;
}

function isSynthetic(name: string): boolean {
  return name === "(setup)" || name === "(output)" || name === "(unnamed)";
}

function stepStatus(status: Step["status"], conclusion: Step["conclusion"]): SectionStatus {
  if (status === "in_progress") return "running";
  if (status !== "completed") return "pending";
  switch (conclusion) {
    case "success": return "success";
    case "failure":
    case "timed_out":
    case "startup_failure": return "failure";
    case "skipped": return "skipped";
    case "cancelled": return "cancelled";
    case "neutral":
    case "stale":
    case "action_required":
    case null:
    default: return "neutral";
  }
}

function duration(startedAt: string | null, completedAt: string | null): number | null {
  if (!startedAt || !completedAt) return null;
  const s = Date.parse(startedAt);
  const e = Date.parse(completedAt);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return null;
  return e - s;
}

function sectionId(index: number): string {
  return `s-${index}`;
}
