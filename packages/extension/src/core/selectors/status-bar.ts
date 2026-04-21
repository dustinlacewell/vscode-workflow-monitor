import type { RepoCoordinates, RunConclusion, RunStatus, WorkflowRun } from "../domain/types.js";
import { isActiveStatus } from "../domain/types.js";
import type { StoreSnapshot } from "../store/snapshot.js";
import { selectInProgressRunCount } from "./runs.js";

/**
 * Why we're highlighting this particular run — drives icon/colour choice in
 * the UI layer. Kept as a tagged value (not implicit from status/conclusion)
 * so the selector's priority decision is legible to tests and to readers.
 */
export type PriorityReason =
  | "action-required" // run.conclusion === "action_required" (approvals, env gates)
  | "in-progress" // anything actively running
  | "on-branch" // latest run matching snap.branch
  | "latest"; // latest run anywhere, fallback

export interface PriorityBadge {
  readonly kind: "priority";
  readonly repo: RepoCoordinates;
  readonly run: WorkflowRun;
  readonly reason: PriorityReason;
  readonly inProgressCount: number;
}

export type BadgeView =
  | { kind: "hidden" }
  | { kind: "idle"; repo: RepoCoordinates } // repo present, no runs tracked yet
  | PriorityBadge;

/**
 * Decide what the status-bar should show.
 *
 * Priority order, preserved from the previous inline logic:
 *   1. action_required   — needs a human now
 *   2. any in-progress   — work happening
 *   3. latest on branch  — keeps focus on the checkout
 *   4. latest anywhere   — something is better than nothing
 *
 * The `inProgressCount` is always included so the UI can annotate the badge
 * with "+N" context regardless of which reason fired.
 */
export function selectBadge(snap: StoreSnapshot): BadgeView {
  if (!snap.repo || snap.status === "no-repo") return { kind: "hidden" };

  const allRuns: WorkflowRun[] = [];
  for (const runs of snap.runsByWorkflowId.values()) allRuns.push(...runs);
  if (allRuns.length === 0) return { kind: "idle", repo: snap.repo };

  const inProgressCount = selectInProgressRunCount(snap);

  const actionReq = firstMatch(allRuns, (r) => r.conclusion === "action_required");
  if (actionReq) {
    return { kind: "priority", repo: snap.repo, run: actionReq, reason: "action-required", inProgressCount };
  }

  const inProgress = firstMatch(allRuns, (r) => isActiveStatus(r.status));
  if (inProgress) {
    return { kind: "priority", repo: snap.repo, run: inProgress, reason: "in-progress", inProgressCount };
  }

  const onBranch = snap.branch ? latestOnBranch(allRuns, snap.branch) : null;
  if (onBranch) {
    return { kind: "priority", repo: snap.repo, run: onBranch, reason: "on-branch", inProgressCount };
  }

  const latest = latest_(allRuns);
  if (latest) {
    return { kind: "priority", repo: snap.repo, run: latest, reason: "latest", inProgressCount };
  }
  // Unreachable: allRuns.length > 0 above guarantees at least one run here.
  return { kind: "idle", repo: snap.repo };
}

function firstMatch<T>(xs: readonly T[], pred: (x: T) => boolean): T | null {
  for (const x of xs) if (pred(x)) return x;
  return null;
}

function latestOnBranch(runs: readonly WorkflowRun[], branch: string): WorkflowRun | null {
  let best: WorkflowRun | null = null;
  for (const r of runs) {
    if (r.headBranch !== branch) continue;
    if (!best || r.id > best.id) best = r;
  }
  return best;
}

function latest_(runs: readonly WorkflowRun[]): WorkflowRun | null {
  let best: WorkflowRun | null = null;
  for (const r of runs) if (!best || r.id > best.id) best = r;
  return best;
}

/**
 * Visual "kind" the UI should use when colouring / icon-ing the badge. Pure —
 * the UI layer maps this to ThemeIcon / ThemeColor. Keeping the mapping out of
 * core keeps the selector trivially testable.
 */
export type BadgeVisualKind =
  | "action-required"
  | "in-progress"
  | "pending"
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "unknown";

export function classifyBadgeVisual(status: RunStatus, conclusion: RunConclusion): BadgeVisualKind {
  if (conclusion === "action_required") return "action-required";
  if (isActiveStatus(status)) {
    return status === "in_progress" ? "in-progress" : "pending";
  }
  if (status !== "completed") return "unknown";
  switch (conclusion) {
    case "success":
      return "success";
    case "failure":
    case "startup_failure":
    case "timed_out":
      return "failure";
    case "cancelled":
      return "cancelled";
    case "skipped":
      return "skipped";
    default:
      return "unknown";
  }
}
