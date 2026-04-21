import { describe, expect, it } from "vitest";
import { selectInProgressRunCount, selectRunJobs, selectVisibleRuns, selectWorkflowRows, selectWorkflowRuns } from "./runs.js";
import { makeJob, makeRun, makeSnapshot, makeWorkflow, perRepoFrom } from "./test-fixtures.js";

describe("selectVisibleRuns", () => {
  const r1 = makeRun({ id: 1, workflowId: 10, headBranch: "main" });
  const r2 = makeRun({ id: 2, workflowId: 10, headBranch: "feat" });
  const r3 = makeRun({ id: 3, workflowId: 10, headBranch: null });

  it("returns [] when runs is undefined", () => {
    expect(selectVisibleRuns(undefined, "main", "all")).toEqual([]);
    expect(selectVisibleRuns(undefined, "main", "current")).toEqual([]);
  });

  it("returns everything under branchFilter=all", () => {
    expect(selectVisibleRuns([r1, r2, r3], "main", "all")).toEqual([r1, r2, r3]);
  });

  it("returns everything when branch is unknown (safer than hiding)", () => {
    expect(selectVisibleRuns([r1, r2, r3], null, "current")).toEqual([r1, r2, r3]);
  });

  it("filters to runs whose headBranch matches when branchFilter=current", () => {
    expect(selectVisibleRuns([r1, r2, r3], "main", "current")).toEqual([r1]);
    expect(selectVisibleRuns([r1, r2, r3], "feat", "current")).toEqual([r2]);
  });
});

describe("selectWorkflowRows", () => {
  const wfA = makeWorkflow({ id: 1, name: "CI" });
  const wfB = makeWorkflow({ id: 2, name: "Deploy" });

  it("produces one row per workflow with zero runs when none cached", () => {
    const per = perRepoFrom(makeSnapshot({ workflows: [wfA, wfB] }));
    const rows = selectWorkflowRows(per, "all");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ workflow: wfA, latestVisibleRun: null, visibleRunCount: 0 });
  });

  it("picks the first visible run as `latest`", () => {
    const r1 = makeRun({ id: 1, workflowId: 1, headBranch: "main" });
    const r2 = makeRun({ id: 2, workflowId: 1, headBranch: "main" });
    const per = perRepoFrom(makeSnapshot({
      workflows: [wfA],
      runsByWorkflowId: new Map([[1, [r2, r1]]]),
      branch: "main",
    }));
    const [row] = selectWorkflowRows(per, "current");
    expect(row.latestVisibleRun).toBe(r2);
    expect(row.visibleRunCount).toBe(2);
  });

  it("drops runs from the non-current branch when filter=current", () => {
    const r1 = makeRun({ id: 1, workflowId: 1, headBranch: "main" });
    const r2 = makeRun({ id: 2, workflowId: 1, headBranch: "feat" });
    const per = perRepoFrom(makeSnapshot({
      workflows: [wfA],
      runsByWorkflowId: new Map([[1, [r2, r1]]]),
      branch: "main",
    }));
    const [row] = selectWorkflowRows(per, "current");
    expect(row.latestVisibleRun).toBe(r1);
    expect(row.visibleRunCount).toBe(1);
  });
});

describe("selectWorkflowRuns", () => {
  it("returns loading when runs have not been fetched yet", () => {
    const per = perRepoFrom(makeSnapshot({ workflows: [makeWorkflow({ id: 1, name: "CI" })] }));
    expect(selectWorkflowRuns(per, 1, "all")).toEqual({ kind: "loading" });
  });

  it("returns empty/none when the workflow has no runs at all", () => {
    const per = perRepoFrom(makeSnapshot({
      workflows: [makeWorkflow({ id: 1, name: "CI" })],
      runsByWorkflowId: new Map([[1, []]]),
    }));
    expect(selectWorkflowRuns(per, 1, "current")).toEqual({
      kind: "empty",
      reason: "none",
      branch: "main",
    });
  });

  it("returns empty/filtered when all runs are on other branches", () => {
    const r1 = makeRun({ id: 1, workflowId: 1, headBranch: "feat" });
    const per = perRepoFrom(makeSnapshot({
      workflows: [makeWorkflow({ id: 1, name: "CI" })],
      runsByWorkflowId: new Map([[1, [r1]]]),
      branch: "main",
    }));
    expect(selectWorkflowRuns(per, 1, "current")).toEqual({
      kind: "empty",
      reason: "filtered",
      branch: "main",
    });
  });

  it("returns runs otherwise", () => {
    const r1 = makeRun({ id: 1, workflowId: 1, headBranch: "main" });
    const per = perRepoFrom(makeSnapshot({
      workflows: [makeWorkflow({ id: 1, name: "CI" })],
      runsByWorkflowId: new Map([[1, [r1]]]),
      branch: "main",
    }));
    expect(selectWorkflowRuns(per, 1, "current")).toEqual({ kind: "runs", runs: [r1] });
  });
});

describe("selectInProgressRunCount", () => {
  it("is 0 when no runs are cached", () => {
    expect(selectInProgressRunCount(makeSnapshot())).toBe(0);
  });

  it("counts only active statuses across all workflows", () => {
    const r1 = makeRun({ id: 1, workflowId: 10, status: "in_progress" });
    const r2 = makeRun({ id: 2, workflowId: 10, status: "completed" });
    const r3 = makeRun({ id: 3, workflowId: 20, status: "queued" });
    const r4 = makeRun({ id: 4, workflowId: 20, status: "waiting" });
    const snap = makeSnapshot({
      runsByWorkflowId: new Map([[10, [r1, r2]], [20, [r3, r4]]]),
    });
    expect(selectInProgressRunCount(snap)).toBe(3);
  });

  it("ignores branch filter — badge reflects repo-wide activity", () => {
    const r1 = makeRun({ id: 1, workflowId: 10, status: "in_progress", headBranch: "feat" });
    const snap = makeSnapshot({
      runsByWorkflowId: new Map([[10, [r1]]]),
      branch: "main",
    });
    expect(selectInProgressRunCount(snap)).toBe(1);
  });
});

describe("selectRunJobs", () => {
  it("loading when jobs not yet fetched", () => {
    expect(selectRunJobs(perRepoFrom(makeSnapshot()), 99)).toEqual({ kind: "loading" });
  });

  it("empty when fetched but none reported", () => {
    const per = perRepoFrom(makeSnapshot({ jobsByRunId: new Map([[99, []]]) }));
    expect(selectRunJobs(per, 99)).toEqual({ kind: "empty" });
  });

  it("returns jobs", () => {
    const j = makeJob({ id: 1, runId: 99 });
    const per = perRepoFrom(makeSnapshot({ jobsByRunId: new Map([[99, [j]]]) }));
    expect(selectRunJobs(per, 99)).toEqual({ kind: "jobs", jobs: [j] });
  });
});
