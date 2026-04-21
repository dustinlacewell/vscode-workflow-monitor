import type { RepoCoordinates, RunConclusion, RunStatus, WorkflowRun } from "../domain/types.js";
import { isActiveStatus, repoKey } from "../domain/types.js";
import type { StoreSnapshot } from "../store/snapshot.js";
import { selectInProgressRunCount } from "./runs.js";

export type PriorityReason =
  | "action-required" // conclusion === "action_required" — needs a human
  | "in-progress" // any active status
  | "on-branch" // latest on the branch the active repo is on
  | "latest"; // latest anywhere, fallback

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
 * Pick what the status bar should show. Priority order across the whole
 * workspace (not per repo):
 *
 *   1. action_required anywhere — pulses until dismissed
 *   2. any in-progress run — spinning icon
 *   3. latest run on the current branch (if exactly one branch resolves
 *      across repos, or if a repo's branch matches the featured run)
 *   4. latest run anywhere
 *
 * We search repos in their tracked order (see GitRepoWatcher — active editor
 * wins the tiebreak), so if two repos both have in-progress runs the
 * "currently focused" one is the one that gets surfaced.
 */
export function selectBadge(snap: StoreSnapshot): BadgeView {
  if (snap.status === "no-repo" || snap.status === "unauthenticated") return { kind: "hidden" };
  if (snap.repos.size === 0) return { kind: "hidden" };

  // Flatten runs across repos, preserving order-of-tracking so the first
  // match in a category comes from the "primary" repo.
  const flat: { run: WorkflowRun; repo: RepoCoordinates }[] = [];
  for (const per of snap.repos.values()) {
    for (const runs of per.runsByWorkflowId.values()) {
      for (const run of runs) flat.push({ run, repo: per.repo });
    }
  }
  if (flat.length === 0) return { kind: "idle" };

  const inProgressCount = selectInProgressRunCount(snap);

  const actionReq = flat.find((e) => e.run.conclusion === "action_required");
  if (actionReq) return { kind: "priority", ...actionReq, reason: "action-required", inProgressCount };

  const inProgress = flat.find((e) => isActiveStatus(e.run.status));
  if (inProgress) return { kind: "priority", ...inProgress, reason: "in-progress", inProgressCount };

  const onBranch = latestOnAnyCurrentBranch(flat, snap);
  if (onBranch) return { kind: "priority", ...onBranch, reason: "on-branch", inProgressCount };

  const latest = latestOverall(flat);
  if (latest) return { kind: "priority", ...latest, reason: "latest", inProgressCount };
  return { kind: "idle" };
}

function latestOnAnyCurrentBranch(
  flat: readonly { run: WorkflowRun; repo: RepoCoordinates }[],
  snap: StoreSnapshot,
): { run: WorkflowRun; repo: RepoCoordinates } | null {
  // "On-branch" is per-repo: a run counts if it's on the branch of its own
  // repo's checkout. Walk the flat list in order and pick the first match
  // that's also the newest for its repo.
  const bestByRepo = new Map<string, { run: WorkflowRun; repo: RepoCoordinates }>();
  for (const entry of flat) {
    const per = snap.repos.get(repoKey(entry.repo));
    if (!per?.branch) continue;
    if (entry.run.headBranch !== per.branch) continue;
    const key = repoKey(entry.repo);
    const prev = bestByRepo.get(key);
    if (!prev || entry.run.id > prev.run.id) bestByRepo.set(key, entry);
  }
  // Return the first repo (in tracking order) that had a match.
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
