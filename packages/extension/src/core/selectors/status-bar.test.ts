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

  it("prefers action_required over everything", () => {
    const running = makeRun({ id: 1, workflowId: 1, status: "in_progress" });
    const needs = makeRun({ id: 2, workflowId: 1, status: "completed", conclusion: "action_required" });
    const snap = makeSnapshot({ runsByWorkflowId: new Map([[1, [running, needs]]]) });
    const v = selectBadge(snap);
    if (v.kind !== "priority") throw new Error("expected priority");
    expect(v.run).toBe(needs);
    expect(v.reason).toBe("action-required");
  });

  it("falls back to in-progress when no action required", () => {
    const running = makeRun({ id: 1, workflowId: 1, status: "in_progress" });
    const done = makeRun({ id: 2, workflowId: 1, status: "completed", conclusion: "success" });
    const snap = makeSnapshot({ runsByWorkflowId: new Map([[1, [done, running]]]) });
    const v = selectBadge(snap);
    if (v.kind !== "priority") throw new Error("expected priority");
    expect(v.run).toBe(running);
    expect(v.reason).toBe("in-progress");
  });

  it("prefers a run on the current branch when nothing active", () => {
    const onMain = makeRun({ id: 10, workflowId: 1, status: "completed", conclusion: "success", headBranch: "main" });
    const onFeat = makeRun({ id: 11, workflowId: 1, status: "completed", conclusion: "success", headBranch: "feat" });
    const snap = makeSnapshot({
      runsByWorkflowId: new Map([[1, [onFeat, onMain]]]),
      branch: "main",
    });
    const v = selectBadge(snap);
    if (v.kind !== "priority") throw new Error("expected priority");
    expect(v.run).toBe(onMain);
    expect(v.reason).toBe("on-branch");
  });

  it("takes the latest id on-branch, not first-seen", () => {
    const older = makeRun({ id: 5, workflowId: 1, status: "completed", conclusion: "success", headBranch: "main" });
    const newer = makeRun({ id: 12, workflowId: 1, status: "completed", conclusion: "success", headBranch: "main" });
    const snap = makeSnapshot({
      runsByWorkflowId: new Map([[1, [older, newer]]]),
      branch: "main",
    });
    const v = selectBadge(snap);
    if (v.kind !== "priority") throw new Error("expected priority");
    expect(v.run).toBe(newer);
  });

  it("falls through to latest-anywhere when no branch or no match", () => {
    const other = makeRun({ id: 5, workflowId: 1, status: "completed", conclusion: "success", headBranch: "feat" });
    const snap = makeSnapshot({
      runsByWorkflowId: new Map([[1, [other]]]),
      branch: "main",
    });
    const v = selectBadge(snap);
    if (v.kind !== "priority") throw new Error("expected priority");
    expect(v.run).toBe(other);
    expect(v.reason).toBe("latest");
  });

  it("includes the in-progress count even when priority is action-required", () => {
    const running = makeRun({ id: 1, workflowId: 1, status: "in_progress" });
    const running2 = makeRun({ id: 2, workflowId: 1, status: "queued" });
    const needs = makeRun({ id: 3, workflowId: 1, status: "completed", conclusion: "action_required" });
    const snap = makeSnapshot({ runsByWorkflowId: new Map([[1, [running, running2, needs]]]) });
    const v = selectBadge(snap);
    if (v.kind !== "priority") throw new Error("expected priority");
    expect(v.inProgressCount).toBe(2);
    expect(v.reason).toBe("action-required");
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
