import { describe, expect, it } from "vitest";
import { classifyBadgeVisual, selectBadge } from "./status-bar.js";
import { makeRun, makeSnapshot, makeWorkflow } from "./test-fixtures.js";

describe("selectBadge", () => {
  it("hidden when no repo", () => {
    expect(selectBadge(makeSnapshot({ status: "no-repo" }))).toEqual({ kind: "hidden" });
  });

  it("idle when repo but no runs tracked", () => {
    const snap = makeSnapshot({ workflows: [makeWorkflow({ id: 1, name: "CI" })] });
    const v = selectBadge(snap);
    expect(v.kind).toBe("idle");
  });

  it("picks the latest on-branch run and tags in-progress when it's active", () => {
    const active = makeRun({ id: 5, workflowId: 1, status: "in_progress", headBranch: "main" });
    const older = makeRun({ id: 3, workflowId: 1, status: "completed", conclusion: "success", headBranch: "main" });
    const snap = makeSnapshot({ runsByWorkflowId: new Map([[1, [active, older]]]), branch: "main" });
    const v = selectBadge(snap);
    if (v.kind !== "priority") throw new Error("expected priority");
    expect(v.run).toBe(active);
    expect(v.reason).toBe("in-progress");
  });

  it("ignores action_required runs that aren't on the current branch", () => {
    // The bug that prompted this rewrite: a stale action_required run on
    // a fork branch was hijacking the status bar. It must not win over a
    // fresh on-branch run.
    const forkReview = makeRun({ id: 804, workflowId: 1, status: "completed", conclusion: "action_required", headBranch: "copilot/weird" });
    const onMain = makeRun({ id: 100, workflowId: 1, status: "completed", conclusion: "success", headBranch: "main" });
    const snap = makeSnapshot({
      runsByWorkflowId: new Map([[1, [forkReview, onMain]]]),
      branch: "main",
    });
    const v = selectBadge(snap);
    if (v.kind !== "priority") throw new Error("expected priority");
    expect(v.run).toBe(onMain);
    expect(v.reason).toBe("on-branch");
  });

  it("surfaces action_required only when it's the latest on-branch run", () => {
    const needsApproval = makeRun({ id: 20, workflowId: 1, status: "completed", conclusion: "action_required", headBranch: "main" });
    const earlier = makeRun({ id: 10, workflowId: 1, status: "completed", conclusion: "success", headBranch: "main" });
    const snap = makeSnapshot({ runsByWorkflowId: new Map([[1, [needsApproval, earlier]]]), branch: "main" });
    const v = selectBadge(snap);
    if (v.kind !== "priority") throw new Error("expected priority");
    expect(v.run).toBe(needsApproval);
    expect(v.reason).toBe("on-branch");
  });

  it("picks the newest id on-branch, not the first-seen", () => {
    const older = makeRun({ id: 5, workflowId: 1, status: "completed", conclusion: "success", headBranch: "main" });
    const newer = makeRun({ id: 12, workflowId: 1, status: "completed", conclusion: "success", headBranch: "main" });
    const snap = makeSnapshot({ runsByWorkflowId: new Map([[1, [older, newer]]]), branch: "main" });
    const v = selectBadge(snap);
    if (v.kind !== "priority") throw new Error("expected priority");
    expect(v.run).toBe(newer);
  });

  it("falls through to latest-anywhere when no run matches the branch", () => {
    const other = makeRun({ id: 5, workflowId: 1, status: "completed", conclusion: "success", headBranch: "feat" });
    const snap = makeSnapshot({ runsByWorkflowId: new Map([[1, [other]]]), branch: "main" });
    const v = selectBadge(snap);
    if (v.kind !== "priority") throw new Error("expected priority");
    expect(v.run).toBe(other);
    expect(v.reason).toBe("latest");
  });

  it("still aggregates inProgressCount across all runs — badge can show +N", () => {
    const onMain = makeRun({ id: 10, workflowId: 1, status: "in_progress", headBranch: "main" });
    const onFeat = makeRun({ id: 11, workflowId: 1, status: "queued", headBranch: "feat" });
    const snap = makeSnapshot({ runsByWorkflowId: new Map([[1, [onMain, onFeat]]]), branch: "main" });
    const v = selectBadge(snap);
    if (v.kind !== "priority") throw new Error("expected priority");
    expect(v.inProgressCount).toBe(2);
  });
});

describe("classifyBadgeVisual", () => {
  it("action_required beats active status", () => {
    expect(classifyBadgeVisual("in_progress", "action_required")).toBe("action-required");
  });
  it("in_progress → in-progress", () => {
    expect(classifyBadgeVisual("in_progress", null)).toBe("in-progress");
  });
  it("queued → pending", () => {
    expect(classifyBadgeVisual("queued", null)).toBe("pending");
  });
  it("completed + success → success", () => {
    expect(classifyBadgeVisual("completed", "success")).toBe("success");
  });
  it("completed + failure-like → failure", () => {
    expect(classifyBadgeVisual("completed", "failure")).toBe("failure");
    expect(classifyBadgeVisual("completed", "timed_out")).toBe("failure");
    expect(classifyBadgeVisual("completed", "startup_failure")).toBe("failure");
  });
  it("completed + cancelled/skipped map through", () => {
    expect(classifyBadgeVisual("completed", "cancelled")).toBe("cancelled");
    expect(classifyBadgeVisual("completed", "skipped")).toBe("skipped");
  });
  it("unknown status → unknown", () => {
    expect(classifyBadgeVisual("unknown", null)).toBe("unknown");
  });
});
