import { describe, expect, it } from "vitest";
import { selectSecretsView } from "./secrets.js";
import { makeEnvironment, makeSecret, makeSecretsSnapshot, makeSnapshot } from "./test-fixtures.js";

describe("selectSecretsView", () => {
  it("idle before the first fetch", () => {
    expect(selectSecretsView(makeSnapshot())).toEqual({ kind: "idle" });
  });

  it("loading on initial fetch (no environments seen yet)", () => {
    const snap = makeSnapshot({ secrets: makeSecretsSnapshot({ status: "loading" }) });
    expect(selectSecretsView(snap)).toEqual({ kind: "loading" });
  });

  it("error carries errorMessage", () => {
    const snap = makeSnapshot({
      secrets: makeSecretsSnapshot({ status: "error", errorMessage: "403 Forbidden" }),
    });
    expect(selectSecretsView(snap)).toEqual({ kind: "error", errorMessage: "403 Forbidden" });
  });

  it("groups repo scope first, environments alphabetically", () => {
    const envProd = makeEnvironment({ name: "production" });
    const envStaging = makeEnvironment({ name: "staging" });
    const snap = makeSnapshot({
      secrets: makeSecretsSnapshot({
        environments: [envProd, envStaging],
        byScope: [
          [{ kind: "repo" }, [makeSecret({ name: "API_TOKEN" }), makeSecret({ name: "DATABASE_URL" })]],
          [{ kind: "environment", name: "production" }, [makeSecret({ name: "DEPLOY_KEY" })]],
        ],
      }),
    });
    const v = selectSecretsView(snap);
    if (v.kind !== "groups") throw new Error("expected groups");

    expect(v.repo.scope).toEqual({ kind: "repo" });
    expect(v.repo.label).toBe("Repository");
    if (v.repo.view.kind !== "secrets") throw new Error("expected secrets");
    expect(v.repo.view.items.map((s) => s.name)).toEqual(["API_TOKEN", "DATABASE_URL"]);

    expect(v.environments.map((g) => g.scope)).toEqual([
      { kind: "environment", name: "production" },
      { kind: "environment", name: "staging" },
    ]);
    expect(v.environments[0]!.view.kind).toBe("secrets");
    expect(v.environments[1]!.view.kind).toBe("loading");
  });

  it("labels environments with protection-rule count when non-zero", () => {
    const env = makeEnvironment({ name: "production", protectionRuleCount: 2 });
    const snap = makeSnapshot({
      secrets: makeSecretsSnapshot({
        environments: [env],
        byScope: [[{ kind: "repo" }, []]],
      }),
    });
    const v = selectSecretsView(snap);
    if (v.kind !== "groups") throw new Error("expected groups");
    expect(v.environments[0]!.label).toBe("production (2 protection rules)");
  });

  it("sorts secrets alphabetically within a scope", () => {
    const snap = makeSnapshot({
      secrets: makeSecretsSnapshot({
        byScope: [
          [{ kind: "repo" }, [makeSecret({ name: "Z_VAR" }), makeSecret({ name: "A_VAR" })]],
        ],
      }),
    });
    const v = selectSecretsView(snap);
    if (v.kind !== "groups") throw new Error("expected groups");
    if (v.repo.view.kind !== "secrets") throw new Error("expected secrets");
    expect(v.repo.view.items.map((s) => s.name)).toEqual(["A_VAR", "Z_VAR"]);
  });
});
