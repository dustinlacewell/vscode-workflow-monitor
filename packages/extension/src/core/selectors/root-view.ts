import type { AuthFailure } from "../auth/failure.js";
import type { PerRepoState, StoreSnapshot } from "../store/snapshot.js";
import { selectWorkflowRows, type BranchFilter, type WorkflowRow } from "./runs.js";

/**
 * Branch-filter banner for a single repo's view. `null` means no branch is
 * known — we suppress the toggle rather than show it misleading.
 */
export type BranchBanner =
  | { kind: "current"; branch: string }
  | { kind: "all"; branch: string };

/**
 * Per-repo body: loading/empty/workflows. The multi-repo root wraps these in
 * a repo header; in single-repo mode the tree provider renders them at root
 * directly, skipping the repo-level nesting entirely.
 */
export type RepoBodyView =
  | { kind: "error"; errorMessage: string }
  | { kind: "empty" }
  | { kind: "workflows"; banner: BranchBanner | null; rows: readonly WorkflowRow[] };

export interface RepoView {
  readonly repo: PerRepoState;
  readonly body: RepoBodyView;
}

/**
 * View-model for the root of the Workflows tree. Tagged union; the UI layer
 * does a thin translation to TreeNodes.
 *
 *   - `initializing` | `no-repo` | `unauthenticated` | `error` | `loading`
 *     mirror the global store status.
 *   - `repos` carries one or more RepoView entries. The tree provider renders
 *     them flat when there's exactly one (skipping the repo-level nesting)
 *     and wraps each in a collapsible repo header when there's more than one.
 */
export type RootView =
  | { kind: "initializing" }
  | { kind: "no-repo" }
  | { kind: "unauthenticated"; errorMessage: string | null; authFailure: AuthFailure | null }
  | { kind: "error"; errorMessage: string; authFailure: AuthFailure | null }
  | { kind: "loading" }
  | { kind: "repos"; repos: readonly RepoView[] };

export function selectRootView(snap: StoreSnapshot, branchFilter: BranchFilter): RootView {
  switch (snap.status) {
    case "idle":
      return { kind: "initializing" };
    case "no-repo":
      return { kind: "no-repo" };
    case "unauthenticated":
      return { kind: "unauthenticated", errorMessage: snap.errorMessage, authFailure: snap.authFailure };
    case "error":
      return { kind: "error", errorMessage: snap.errorMessage ?? "unknown", authFailure: snap.authFailure };
    case "loading":
      if (snap.repos.size === 0) return { kind: "loading" };
      break;
    case "ready":
      break;
  }
  if (snap.repos.size === 0) return { kind: "loading" };
  const repos: RepoView[] = [];
  for (const per of snap.repos.values()) repos.push({ repo: per, body: buildBody(per, branchFilter) });
  return { kind: "repos", repos };
}

function buildBody(per: PerRepoState, branchFilter: BranchFilter): RepoBodyView {
  if (per.errorMessage) return { kind: "error", errorMessage: per.errorMessage };
  if (per.workflows.length === 0) return { kind: "empty" };
  return {
    kind: "workflows",
    banner: selectBranchBanner(per.branch, branchFilter),
    rows: selectWorkflowRows(per, branchFilter),
  };
}

function selectBranchBanner(branch: string | null, branchFilter: BranchFilter): BranchBanner | null {
  if (!branch) return null;
  return branchFilter === "current" ? { kind: "current", branch } : { kind: "all", branch };
}
