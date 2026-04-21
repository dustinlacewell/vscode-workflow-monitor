import { describe, expect, it } from "vitest";
import { selectSettingsView } from "./settings.js";
import { makeEnvironment, makeSecret, makeSecretsSnapshot, makeSnapshot } from "./test-fixtures.js";

describe("selectSettingsView", () => {
  it("idle when the store hasn't started", () => {
    const snap = { ...makeSnapshot({ status: "idle" }), repo: null };
    expect(selectSettingsView(snap)).toEqual({ kind: "idle" });
  });

  it("no-repo when there is no active repository", () => {
    const snap = { ...makeSnapshot({ status: "no-repo" }), repo: null };
    expect(selectSettingsView(snap)).toEqual({ kind: "no-repo" });
  });

  it("repo view exposes repo-scoped secrets directly, not inside a scope group", () => {
    const snap = makeSnapshot({
      secrets: makeSecretsSnapshot({
        byScope: [
          [{ kind: "repo" }, [makeSecret({ name: "DB" }), makeSecret({ name: "API" })]],
        ],
      }),
    });
    const v = selectSettingsView(snap);
    if (v.kind !== "repos") throw new Error("expected repos");
    const { repoSecrets } = v.repos[0]!;
    expect(repoSecrets.kind).toBe("items");
    if (repoSecrets.kind !== "items") throw new Error("unreachable");
    expect(repoSecrets.items.map((s) => s.name)).toEqual(["API", "DB"]);
  });

  it("environments section lists each environment with its own nested secrets view", () => {
    const envProd = makeEnvironment({ name: "production", protectionRuleCount: 2 });
    const envStaging = makeEnvironment({ name: "staging" });
    const snap = makeSnapshot({
      secrets: makeSecretsSnapshot({
        environments: [envStaging, envProd],
        byScope: [
          [{ kind: "environment", name: "production" }, [makeSecret({ name: "DEPLOY_KEY" })]],
          // staging not fetched yet on purpose
        ],
      }),
    });
    const v = selectSettingsView(snap);
    if (v.kind !== "repos") throw new Error("expected repos");
    const { environments } = v.repos[0]!;
    if (environments.kind !== "items") throw new Error("expected items");

    expect(environments.items.map((e) => e.environment.name)).toEqual(["production", "staging"]);

    // production: fetched
    expect(environments.items[0]!.secrets.kind).toBe("items");
    if (environments.items[0]!.secrets.kind !== "items") throw new Error("unreachable");
    expect(environments.items[0]!.secrets.items.map((s) => s.name)).toEqual(["DEPLOY_KEY"]);

    // staging: lazy, not-yet-fetched
    expect(environments.items[1]!.secrets).toEqual({ kind: "loading" });
  });

  it("forwards secrets-error through every section when the store reports an error", () => {
    const snap = makeSnapshot({
      secrets: makeSecretsSnapshot({ status: "error", errorMessage: "403 Forbidden" }),
    });
    const v = selectSettingsView(snap);
    if (v.kind !== "repos") throw new Error("expected repos");
    expect(v.repos[0]!.repoSecrets).toEqual({ kind: "error", errorMessage: "403 Forbidden" });
    expect(v.repos[0]!.environments).toEqual({ kind: "error", errorMessage: "403 Forbidden" });
  });

  it("variables sections are placeholders at every scope until the feature lands", () => {
    const env = makeEnvironment({ name: "production" });
    const snap = makeSnapshot({
      secrets: makeSecretsSnapshot({ environments: [env] }),
    });
    const v = selectSettingsView(snap);
    if (v.kind !== "repos") throw new Error("expected repos");
    expect(v.repos[0]!.repoVariables).toEqual({ kind: "not-implemented" });
    if (v.repos[0]!.environments.kind !== "items") throw new Error("unreachable");
    expect(v.repos[0]!.environments.items[0]!.variables).toEqual({ kind: "not-implemented" });
  });

  it("sorts secrets alphabetically within a scope", () => {
    const snap = makeSnapshot({
      secrets: makeSecretsSnapshot({
        byScope: [
          [{ kind: "repo" }, [makeSecret({ name: "Z_VAR" }), makeSecret({ name: "A_VAR" })]],
        ],
      }),
    });
    const v = selectSettingsView(snap);
    if (v.kind !== "repos") throw new Error("expected repos");
    if (v.repos[0]!.repoSecrets.kind !== "items") throw new Error("unreachable");
    expect(v.repos[0]!.repoSecrets.items.map((s) => s.name)).toEqual(["A_VAR", "Z_VAR"]);
  });
});
