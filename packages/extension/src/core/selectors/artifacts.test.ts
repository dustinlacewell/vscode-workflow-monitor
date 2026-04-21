import { describe, expect, it } from "vitest";
import { selectRepoRunsMissingArtifacts, selectRunArtifacts } from "./artifacts.js";
import { makeArtifact, makeRun, makeSnapshot, perRepoFrom } from "./test-fixtures.js";
import { repoKey } from "../domain/types.js";

const DEFAULT_KEY = repoKey({ owner: "o", repo: "r" });

describe("selectRunArtifacts", () => {
  it("hidden when the run is still in flight", () => {
    const run = makeRun({ id: 1, workflowId: 10, status: "in_progress" });
    const per = perRepoFrom(makeSnapshot({ runsByWorkflowId: new Map([[10, [run]]]) }));
    expect(selectRunArtifacts(per, 1)).toEqual({ kind: "hidden" });
  });

  it("hidden when the run is unknown", () => {
    expect(selectRunArtifacts(perRepoFrom(makeSnapshot()), 42)).toEqual({ kind: "hidden" });
  });

  it("loading when completed but no entry cached", () => {
    const run = makeRun({ id: 2, workflowId: 10, status: "completed", conclusion: "success" });
    const per = perRepoFrom(makeSnapshot({ runsByWorkflowId: new Map([[10, [run]]]) }));
    expect(selectRunArtifacts(per, 2)).toEqual({ kind: "loading" });
  });

  it("empty when fetched but none produced", () => {
    const run = makeRun({ id: 3, workflowId: 10, status: "completed", conclusion: "success" });
    const per = perRepoFrom(makeSnapshot({
      runsByWorkflowId: new Map([[10, [run]]]),
      artifactsByRunId: new Map([[3, []]]),
    }));
    expect(selectRunArtifacts(per, 3)).toEqual({ kind: "empty" });
  });

  it("returns artifacts sorted newest-first, name as tie-breaker", () => {
    const a = makeArtifact({ id: 1, name: "build-log", createdAt: "2026-04-20T10:00:00Z" });
    const b = makeArtifact({ id: 2, name: "coverage", createdAt: "2026-04-20T12:00:00Z" });
    const c = makeArtifact({ id: 3, name: "alpha", createdAt: "2026-04-20T12:00:00Z" });
    const run = makeRun({ id: 4, workflowId: 10, status: "completed", conclusion: "success" });
    const per = perRepoFrom(makeSnapshot({
      runsByWorkflowId: new Map([[10, [run]]]),
      artifactsByRunId: new Map([[4, [a, b, c]]]),
    }));
    const v = selectRunArtifacts(per, 4);
    if (v.kind !== "artifacts") throw new Error("expected artifacts");
    expect(v.items.map((x) => x.name)).toEqual(["alpha", "coverage", "build-log"]);
  });
});

describe("selectRepoRunsMissingArtifacts", () => {
  it("is empty when nothing is completed", () => {
    const run = makeRun({ id: 1, workflowId: 10, status: "in_progress" });
    const snap = makeSnapshot({ runsByWorkflowId: new Map([[10, [run]]]) });
    expect(selectRepoRunsMissingArtifacts(snap, DEFAULT_KEY)).toEqual([]);
  });

  it("returns every completed run whose artifacts haven't been cached", () => {
    const r1 = makeRun({ id: 1, workflowId: 10, status: "completed", conclusion: "success" });
    const r2 = makeRun({ id: 2, workflowId: 10, status: "completed", conclusion: "success" });
    const r3 = makeRun({ id: 3, workflowId: 20, status: "in_progress" });
    const snap = makeSnapshot({
      runsByWorkflowId: new Map([[10, [r1, r2]], [20, [r3]]]),
      artifactsByRunId: new Map([[1, []]]), // r1 already fetched (empty)
    });
    expect(selectRepoRunsMissingArtifacts(snap, DEFAULT_KEY)).toEqual([2]);
  });

  it("treats a cached empty array as fetched, not missing", () => {
    const r = makeRun({ id: 1, workflowId: 10, status: "completed", conclusion: "success" });
    const snap = makeSnapshot({
      runsByWorkflowId: new Map([[10, [r]]]),
      artifactsByRunId: new Map([[1, []]]),
    });
    expect(selectRepoRunsMissingArtifacts(snap, DEFAULT_KEY)).toEqual([]);
  });

  it("returns [] for an unknown repo key", () => {
    expect(selectRepoRunsMissingArtifacts(makeSnapshot(), "unknown/repo")).toEqual([]);
  });
});
