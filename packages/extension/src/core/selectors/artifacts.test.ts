import { describe, expect, it } from "vitest";
import { selectRunArtifacts, selectRunsMissingArtifacts } from "./artifacts.js";
import { makeArtifact, makeRun, makeSnapshot } from "./test-fixtures.js";

describe("selectRunArtifacts", () => {
  it("hidden when the run is still in flight", () => {
    const run = makeRun({ id: 1, workflowId: 10, status: "in_progress" });
    const snap = makeSnapshot({ runsByWorkflowId: new Map([[10, [run]]]) });
    expect(selectRunArtifacts(snap, 1)).toEqual({ kind: "hidden" });
  });

  it("hidden when the run is unknown", () => {
    expect(selectRunArtifacts(makeSnapshot(), 42)).toEqual({ kind: "hidden" });
  });

  it("loading when completed but no entry cached", () => {
    const run = makeRun({ id: 2, workflowId: 10, status: "completed", conclusion: "success" });
    const snap = makeSnapshot({ runsByWorkflowId: new Map([[10, [run]]]) });
    expect(selectRunArtifacts(snap, 2)).toEqual({ kind: "loading" });
  });

  it("empty when fetched but none produced", () => {
    const run = makeRun({ id: 3, workflowId: 10, status: "completed", conclusion: "success" });
    const snap = makeSnapshot({
      runsByWorkflowId: new Map([[10, [run]]]),
      artifactsByRunId: new Map([[3, []]]),
    });
    expect(selectRunArtifacts(snap, 3)).toEqual({ kind: "empty" });
  });

  it("returns artifacts sorted newest-first, name as tie-breaker", () => {
    const a = makeArtifact({ id: 1, name: "build-log", createdAt: "2026-04-20T10:00:00Z" });
    const b = makeArtifact({ id: 2, name: "coverage", createdAt: "2026-04-20T12:00:00Z" });
    const c = makeArtifact({ id: 3, name: "alpha", createdAt: "2026-04-20T12:00:00Z" });
    const run = makeRun({ id: 4, workflowId: 10, status: "completed", conclusion: "success" });
    const snap = makeSnapshot({
      runsByWorkflowId: new Map([[10, [run]]]),
      artifactsByRunId: new Map([[4, [a, b, c]]]),
    });
    const v = selectRunArtifacts(snap, 4);
    if (v.kind !== "artifacts") throw new Error("expected artifacts");
    expect(v.items.map((x) => x.name)).toEqual(["alpha", "coverage", "build-log"]);
  });
});

describe("selectRunsMissingArtifacts", () => {
  it("is empty when nothing is completed", () => {
    const run = makeRun({ id: 1, workflowId: 10, status: "in_progress" });
    const snap = makeSnapshot({ runsByWorkflowId: new Map([[10, [run]]]) });
    expect(selectRunsMissingArtifacts(snap)).toEqual([]);
  });

  it("returns every completed run whose artifacts haven't been cached", () => {
    const r1 = makeRun({ id: 1, workflowId: 10, status: "completed", conclusion: "success" });
    const r2 = makeRun({ id: 2, workflowId: 10, status: "completed", conclusion: "success" });
    const r3 = makeRun({ id: 3, workflowId: 20, status: "in_progress" });
    const snap = makeSnapshot({
      runsByWorkflowId: new Map([[10, [r1, r2]], [20, [r3]]]),
      artifactsByRunId: new Map([[1, []]]), // r1 already fetched (empty)
    });
    expect(selectRunsMissingArtifacts(snap)).toEqual([2]);
  });

  it("treats a cached empty array as fetched, not missing", () => {
    const r = makeRun({ id: 1, workflowId: 10, status: "completed", conclusion: "success" });
    const snap = makeSnapshot({
      runsByWorkflowId: new Map([[10, [r]]]),
      artifactsByRunId: new Map([[1, []]]),
    });
    expect(selectRunsMissingArtifacts(snap)).toEqual([]);
  });
});
