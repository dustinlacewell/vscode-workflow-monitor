import type { AuthFailure } from "../auth/failure.js";
import type { StoreSnapshot } from "../store/snapshot.js";
import { selectWorkflowRows, type BranchFilter, type WorkflowRow } from "./runs.js";

/**
 * Banner above the workflow list describing / toggling the branch filter.
 * `none` means there's no known branch yet, so showing a toggle would be
 * misleading — suppress it.
 */
export type BranchBanner =
  | { kind: "current"; branch: string }
  | { kind: "all"; branch: string };

/**
 * View-model for the root of the tree. Tagged union keeps the UI layer's
 * translation pure: one branch per kind, no conditional stacking.
 *
 * `unauthenticated` and `error` both carry the structured `authFailure` when
 * one is available — the tree provider uses it to render scope hints, route,
 * and a "Details" action rather than a generic "something went wrong" label.
 */
export type RootView =
  | { kind: "initializing" }
  | { kind: "no-repo" }
  | { kind: "unauthenticated"; errorMessage: string | null; authFailure: AuthFailure | null }
  | { kind: "error"; errorMessage: string; authFailure: AuthFailure | null }
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "workflows"; banner: BranchBanner | null; rows: readonly WorkflowRow[] };

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
      if (snap.workflows.length === 0) return { kind: "loading" };
      break;
    case "ready":
      break;
  }
  if (snap.workflows.length === 0) return { kind: "empty" };
  const rows = selectWorkflowRows(snap, branchFilter);
  const banner = selectBranchBanner(snap.branch, branchFilter);
  return { kind: "workflows", banner, rows };
}

function selectBranchBanner(branch: string | null, branchFilter: BranchFilter): BranchBanner | null {
  if (!branch) return null;
  return branchFilter === "current" ? { kind: "current", branch } : { kind: "all", branch };
}
