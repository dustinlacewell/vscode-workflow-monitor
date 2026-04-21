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

  it("bundles environments + secrets under one repo node", () => {
    const envProd = makeEnvironment({ name: "production", protectionRuleCount: 2 });
    const envStaging = makeEnvironment({ name: "staging" });
    const snap = makeSnapshot({
      secrets: makeSecretsSnapshot({
        environments: [envStaging, envProd],
        byScope: [
          [{ kind: "repo" }, [makeSecret({ name: "DB" })]],
        ],
      }),
    });
    const v = selectSettingsView(snap);
    if (v.kind !== "repos") throw new Error("expected repos");
    expect(v.repos).toHaveLength(1);

    const [repoView] = v.repos;
    expect(repoView!.repo).toEqual({ owner: "o", repo: "r" });

    expect(repoView!.environments.kind).toBe("items");
    if (repoView!.environments.kind !== "items") throw new Error("expected items");
    expect(repoView!.environments.items.map((e) => e.name)).toEqual(["production", "staging"]);

    expect(repoView!.secrets.kind).toBe("groups");
    if (repoView!.secrets.kind !== "groups") throw new Error("expected groups");
    expect(repoView!.secrets.repo.view.kind).toBe("secrets");

    expect(repoView!.variables).toEqual({ kind: "not-implemented" });
  });

  it("loading environments before first fetch, independent of other sections", () => {
    const snap = makeSnapshot();
    const v = selectSettingsView(snap);
    if (v.kind !== "repos") throw new Error("expected repos");
    expect(v.repos[0]!.environments).toEqual({ kind: "loading" });
    expect(v.repos[0]!.secrets).toEqual({ kind: "idle" });
  });

  it("forwards the secrets error through the section view", () => {
    const snap = makeSnapshot({
      secrets: makeSecretsSnapshot({ status: "error", errorMessage: "403" }),
    });
    const v = selectSettingsView(snap);
    if (v.kind !== "repos") throw new Error("expected repos");
    expect(v.repos[0]!.environments).toEqual({ kind: "error", errorMessage: "403" });
    expect(v.repos[0]!.secrets).toEqual({ kind: "error", errorMessage: "403" });
  });
});
