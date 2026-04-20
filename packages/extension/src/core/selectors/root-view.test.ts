import { describe, expect, it } from "vitest";
import { classifyAuthFailure } from "../auth/failure.js";
import { selectRootView } from "./root-view.js";
import { makeRun, makeSnapshot, makeWorkflow } from "./test-fixtures.js";

describe("selectRootView", () => {
  it("idle \u2192 initializing", () => {
    expect(selectRootView(makeSnapshot({ status: "idle" }), "current"))
      .toEqual({ kind: "initializing" });
  });

  it("no-repo passes through", () => {
    expect(selectRootView(makeSnapshot({ status: "no-repo" }), "current"))
      .toEqual({ kind: "no-repo" });
  });

  it("unauthenticated forwards errorMessage and authFailure", () => {
    expect(selectRootView(makeSnapshot({ status: "unauthenticated", errorMessage: "expired" }), "current"))
      .toEqual({ kind: "unauthenticated", errorMessage: "expired", authFailure: null });
  });

  it("error falls back to 'unknown' if no message", () => {
    expect(selectRootView(makeSnapshot({ status: "error" }), "current"))
      .toEqual({ kind: "error", errorMessage: "unknown", authFailure: null });
  });

  it("loading with nothing cached shows spinner", () => {
    expect(selectRootView(makeSnapshot({ status: "loading" }), "current"))
      .toEqual({ kind: "loading" });
  });

  it("loading with cached workflows renders them (keeps UI stable on re-poll)", () => {
    const wf = makeWorkflow({ id: 1, name: "CI" });
    const snap = makeSnapshot({ status: "loading", workflows: [wf] });
    const v = selectRootView(snap, "all");
    expect(v.kind).toBe("workflows");
  });

  it("ready but no workflows \u2192 empty", () => {
    expect(selectRootView(makeSnapshot({ status: "ready" }), "current"))
      .toEqual({ kind: "empty" });
  });

  it("ready with workflows returns rows and a banner when branch is known", () => {
    const wf = makeWorkflow({ id: 1, name: "CI" });
    const r = makeRun({ id: 1, workflowId: 1, headBranch: "main" });
    const snap = makeSnapshot({
      workflows: [wf],
      runsByWorkflowId: new Map([[1, [r]]]),
      branch: "main",
    });
    const v = selectRootView(snap, "current");
    expect(v.kind).toBe("workflows");
    if (v.kind !== "workflows") return;
    expect(v.banner).toEqual({ kind: "current", branch: "main" });
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0].latestVisibleRun).toBe(r);
  });

  it("omits banner when branch is unknown", () => {
    const wf = makeWorkflow({ id: 1, name: "CI" });
    const snap = makeSnapshot({ workflows: [wf], branch: null });
    const v = selectRootView(snap, "current");
    if (v.kind !== "workflows") throw new Error("expected workflows view");
    expect(v.banner).toBeNull();
  });

  it("returns kind=all banner when filter is 'all' and branch is known", () => {
    const wf = makeWorkflow({ id: 1, name: "CI" });
    const snap = makeSnapshot({ workflows: [wf], branch: "main" });
    const v = selectRootView(snap, "all");
    if (v.kind !== "workflows") throw new Error("expected workflows view");
    expect(v.banner).toEqual({ kind: "all", branch: "main" });
  });

  it("carries authFailure on unauthenticated and error", () => {
    const failure = classifyAuthFailure({
      status: 403,
      message: "Resource not accessible",
      route: "GET /repos/{owner}/{repo}/actions/workflows",
      headers: { "x-oauth-scopes": "repo", "x-accepted-oauth-scopes": "workflow" },
      requestedScopes: ["repo", "workflow"],
    });
    const snap = makeSnapshot({ status: "unauthenticated", errorMessage: failure.message, authFailure: failure });
    const v = selectRootView(snap, "current");
    if (v.kind !== "unauthenticated") throw new Error("expected unauthenticated view");
    expect(v.authFailure).toBe(failure);
  });
});
