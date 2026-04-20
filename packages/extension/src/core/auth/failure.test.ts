import { describe, expect, it } from "vitest";
import { classifyAuthFailure, formatAuthFailureMarkdown, missingScopes, summariseAuthFailure } from "./failure.js";

const NOW = new Date("2026-04-20T12:00:00.000Z");

function classify(overrides: Partial<Parameters<typeof classifyAuthFailure>[0]> = {}) {
  return classifyAuthFailure({
    status: 401,
    message: "Bad credentials",
    route: "GET /repos/{owner}/{repo}/actions/workflows",
    requestedScopes: ["repo", "workflow"],
    now: NOW,
    ...overrides,
  });
}

describe("classifyAuthFailure", () => {
  it("401 \u2192 bad-credentials", () => {
    expect(classify({ status: 401 }).kind).toBe("bad-credentials");
  });

  it("403 with missing accepted scope \u2192 insufficient-scope", () => {
    const f = classify({
      status: 403,
      headers: {
        "x-oauth-scopes": "repo",
        "x-accepted-oauth-scopes": "repo, workflow",
      },
    });
    expect(f.kind).toBe("insufficient-scope");
    expect(missingScopes(f)).toEqual(["workflow"]);
  });

  it("403 with all accepted scopes already granted \u2192 forbidden", () => {
    const f = classify({
      status: 403,
      headers: {
        "x-oauth-scopes": "repo, workflow",
        "x-accepted-oauth-scopes": "repo, workflow",
      },
    });
    expect(f.kind).toBe("forbidden");
  });

  it("403 with no accepted-scopes header \u2192 forbidden (SSO / rate limit)", () => {
    expect(classify({ status: 403 }).kind).toBe("forbidden");
  });

  it("404 \u2192 not-found", () => {
    expect(classify({ status: 404 }).kind).toBe("not-found");
  });

  it("5xx \u2192 server-error", () => {
    expect(classify({ status: 502 }).kind).toBe("server-error");
  });

  it("null status \u2192 network", () => {
    expect(classify({ status: null }).kind).toBe("network");
  });

  it("parses empty x-oauth-scopes header as []", () => {
    const f = classify({
      status: 403,
      headers: { "x-oauth-scopes": "", "x-accepted-oauth-scopes": "workflow" },
    });
    expect(f.currentScopes).toEqual([]);
    expect(f.kind).toBe("insufficient-scope");
    expect(missingScopes(f)).toEqual(["workflow"]);
  });

  it("trims whitespace in scope lists", () => {
    const f = classify({
      status: 403,
      headers: {
        "x-oauth-scopes": "  repo ,   workflow ",
        "x-accepted-oauth-scopes": "workflow",
      },
    });
    expect(f.currentScopes).toEqual(["repo", "workflow"]);
  });

  it("captures documentationUrl + occurredAt", () => {
    const f = classify({ documentationUrl: "https://docs.github.com/x" });
    expect(f.documentationUrl).toBe("https://docs.github.com/x");
    expect(f.occurredAt).toBe(NOW.toISOString());
  });
});

describe("summariseAuthFailure", () => {
  it("bad-credentials", () => {
    expect(summariseAuthFailure(classify({ status: 401 })))
      .toContain("401");
  });

  it("insufficient-scope lists missing scope", () => {
    const f = classify({
      status: 403,
      headers: { "x-oauth-scopes": "repo", "x-accepted-oauth-scopes": "repo, workflow" },
    });
    expect(summariseAuthFailure(f)).toMatch(/workflow/);
  });

  it("not-found", () => {
    expect(summariseAuthFailure(classify({ status: 404 }))).toMatch(/not found/i);
  });

  it("network", () => {
    expect(summariseAuthFailure(classify({ status: null })))
      .toMatch(/network/i);
  });
});

describe("formatAuthFailureMarkdown", () => {
  it("includes status, route, and scope sections", () => {
    const f = classify({
      status: 403,
      headers: { "x-oauth-scopes": "repo", "x-accepted-oauth-scopes": "repo, workflow" },
    });
    const md = formatAuthFailureMarkdown(f);
    expect(md).toMatch(/# GitHub Actions Monitor/);
    expect(md).toMatch(/403/);
    expect(md).toMatch(/GET \/repos/);
    expect(md).toMatch(/OAuth scopes/);
    expect(md).toMatch(/workflow/); // missing scope called out
    expect(md).toMatch(/\*\*Missing\*\*/);
  });

  it("renders gracefully when scopes are missing from the response", () => {
    const f = classify({ status: 401 });
    const md = formatAuthFailureMarkdown(f);
    expect(md).toMatch(/not reported by GitHub/);
    expect(md).not.toMatch(/\*\*Missing\*\*/);
  });
});
