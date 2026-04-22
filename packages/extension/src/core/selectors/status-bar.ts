import type { RepoCoordinates, RunConclusion, RunStatus, WorkflowRun } from "../domain/types.js";
import { isActiveStatus, repoKey } from "../domain/types.js";
import type { StoreSnapshot } from "../store/snapshot.js";
import { selectInProgressRunCount } from "./runs.js";

export type PriorityReason =
  | "in-progress" // latest run on-branch is actively running
  | "on-branch" // latest completed run on a tracked repo's current branch
  | "latest"; // fallback: latest run anywhere (no branch known)

export interface PriorityBadge {
  readonly kind: "priority";
  /** Repo the featured run belongs to — carries through to the tooltip + click. */
  readonly repo: RepoCoordinates;
  readonly run: WorkflowRun;
  readonly reason: PriorityReason;
  /** Aggregate across every tracked repo — not just the one featured. */
  readonly inProgressCount: number;
}

export type BadgeView =
  | { kind: "hidden" }
  | { kind: "idle" } // authed + tracking repos, but no runs cached yet
  | PriorityBadge;

/**
 * Pick what the status bar should show.
 *
 * The rule is simpler than it used to be: surface the *latest* run on a
 * tracked repo's current branch. Its status drives the visual (spinning
 * for in-progress, warning pulse for action_required, error bg for
 * failure, etc.), but it is always the latest-on-branch run — not the
 * first action_required we can find across every run in every repo.
 *
 * That avoids the previous "forgotten Copilot PR on a fork branch hijacks
 * the status bar forever" bug: action_required ranks as a visual on the
 * right run, not as a reason to pick a different run.
 *
 * Order:
 *   1. latest-on-branch, in-progress → spinning icon
 *   2. latest-on-branch, completed   → success / failure / action_required
 *   3. latest-anywhere                → only when no tracked repo has a
 *                                        branch matching any of its runs
 */
export function selectBadge(snap: StoreSnapshot): BadgeView {
  if (snap.status === "no-repo" || snap.status === "unauthenticated") return { kind: "hidden" };
  if (snap.repos.size === 0) return { kind: "hidden" };

  const flat: { run: WorkflowRun; repo: RepoCoordinates }[] = [];
  for (const per of snap.repos.values()) {
    for (const runs of per.runsByWorkflowId.values()) {
      for (const run of runs) flat.push({ run, repo: per.repo });
    }
  }
  if (flat.length === 0) return { kind: "idle" };

  const inProgressCount = selectInProgressRunCount(snap);

  const onBranch = latestOnAnyCurrentBranch(flat, snap);
  if (onBranch) {
    const reason: PriorityReason = isActiveStatus(onBranch.run.status) ? "in-progress" : "on-branch";
    return { kind: "priority", ...onBranch, reason, inProgressCount };
  }

  const latest = latestOverall(flat);
  if (latest) return { kind: "priority", ...latest, reason: "latest", inProgressCount };
  return { kind: "idle" };
}

function latestOnAnyCurrentBranch(
  flat: readonly { run: WorkflowRun; repo: RepoCoordinates }[],
  snap: StoreSnapshot,
): { run: WorkflowRun; repo: RepoCoordinates } | null {
  // Per repo: pick the newest run whose headBranch matches that repo's
  // current checkout. Return the first such hit in tracking order so the
  // "active editor" repo wins when multiple repos are on a branch with
  // cached runs.
  const bestByRepo = new Map<string, { run: WorkflowRun; repo: RepoCoordinates }>();
  for (const entry of flat) {
    const per = snap.repos.get(repoKey(entry.repo));
    if (!per?.branch) continue;
    if (entry.run.headBranch !== per.branch) continue;
    const key = repoKey(entry.repo);
    const prev = bestByRepo.get(key);
    if (!prev || entry.run.id > prev.run.id) bestByRepo.set(key, entry);
  }
  for (const entry of flat) {
    const hit = bestByRepo.get(repoKey(entry.repo));
    if (hit) return hit;
  }
  return null;
}

function latestOverall(
  flat: readonly { run: WorkflowRun; repo: RepoCoordinates }[],
): { run: WorkflowRun; repo: RepoCoordinates } | null {
  let best: { run: WorkflowRun; repo: RepoCoordinates } | null = null;
  for (const entry of flat) {
    if (!best || entry.run.id > best.run.id) best = entry;
  }
  return best;
}

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
