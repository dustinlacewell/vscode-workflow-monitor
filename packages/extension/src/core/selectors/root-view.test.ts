import { describe, expect, it } from "vitest";
import { classifyAuthFailure } from "../auth/failure.js";
import { selectRootView, type RepoView } from "./root-view.js";
import { makePerRepo, makeRun, makeSnapshot, makeWorkflow } from "./test-fixtures.js";

function firstRepoView(view: ReturnType<typeof selectRootView>): RepoView {
  if (view.kind !== "repos") throw new Error(`expected repos, got ${view.kind}`);
  const first = view.repos[0];
  if (!first) throw new Error("expected at least one repo view");
  return first;
}

describe("selectRootView", () => {
  it("idle → initializing", () => {
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
    // status=loading without any repo yet = global loading
    expect(selectRootView(makeSnapshot({ status: "loading", repos: [] }), "current"))
      .toEqual({ kind: "loading" });
  });

  it("loading with cached repos renders them (keeps UI stable on re-poll)", () => {
    const wf = makeWorkflow({ id: 1, name: "CI" });
    const snap = makeSnapshot({ status: "loading", workflows: [wf] });
    const v = selectRootView(snap, "all");
    expect(v.kind).toBe("repos");
  });

  it("ready but no workflows → one repo with empty body", () => {
    const v = selectRootView(makeSnapshot({ status: "ready" }), "current");
    const repoView = firstRepoView(v);
    expect(repoView.body.kind).toBe("empty");
  });

  it("ready with workflows returns rows and a banner when branch is known", () => {
    const wf = makeWorkflow({ id: 1, name: "CI" });
    const r = makeRun({ id: 1, workflowId: 1, headBranch: "main" });
    const snap = makeSnapshot({
      workflows: [wf],
      runsByWorkflowId: new Map([[1, [r]]]),
      branch: "main",
    });
    const repoView = firstRepoView(selectRootView(snap, "current"));
    if (repoView.body.kind !== "workflows") throw new Error("expected workflows body");
    expect(repoView.body.banner).toEqual({ kind: "current", branch: "main" });
    expect(repoView.body.rows).toHaveLength(1);
    expect(repoView.body.rows[0]!.latestVisibleRun).toBe(r);
  });

  it("omits banner when branch is unknown", () => {
    const wf = makeWorkflow({ id: 1, name: "CI" });
    const snap = makeSnapshot({ workflows: [wf], branch: null });
    const repoView = firstRepoView(selectRootView(snap, "current"));
    if (repoView.body.kind !== "workflows") throw new Error("expected workflows body");
    expect(repoView.body.banner).toBeNull();
  });

  it("returns kind=all banner when filter is 'all' and branch is known", () => {
    const wf = makeWorkflow({ id: 1, name: "CI" });
    const snap = makeSnapshot({ workflows: [wf], branch: "main" });
    const repoView = firstRepoView(selectRootView(snap, "all"));
    if (repoView.body.kind !== "workflows") throw new Error("expected workflows body");
    expect(repoView.body.banner).toEqual({ kind: "all", branch: "main" });
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

  it("multi-repo: returns one RepoView per tracked repo", () => {
    const wfA = makeWorkflow({ id: 1, name: "CI" });
    const wfB = makeWorkflow({ id: 2, name: "Deploy" });
    const perA = makePerRepo({ repo: { owner: "acme", repo: "backend" }, workflows: [wfA], branch: "main" });
    const perB = makePerRepo({ repo: { owner: "acme", repo: "frontend" }, workflows: [wfB], branch: "main" });
    const snap = makeSnapshot({ repos: [perA, perB] });
    const v = selectRootView(snap, "current");
    if (v.kind !== "repos") throw new Error("expected repos");
    expect(v.repos).toHaveLength(2);
    expect(v.repos.map((r) => r.repo.repo.repo)).toEqual(["backend", "frontend"]);
  });
});
