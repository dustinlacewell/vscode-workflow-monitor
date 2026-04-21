import type { Environment, Secret, SecretScope } from "../domain/secrets.js";
import { scopeKey } from "../domain/secrets.js";
import type { RepoCoordinates } from "../domain/types.js";
import type { StoreSnapshot } from "../store/snapshot.js";

/**
 * Tri-state per-scope list. Absence = not yet fetched (render "loading…"),
 * empty array = fetched-empty, populated = render the items.
 */
export type ScopeListView<T> =
  | { kind: "loading" }
  | { kind: "items"; items: readonly T[] };

/**
 * Placeholder for the variables surface until we implement it. Keeps the shape
 * in place so the tree can render a consistent "coming soon" leaf without
 * conditionally hiding the node.
 */
export type VariablesScopeView =
  | { kind: "not-implemented" };

/**
 * View-model for a single environment under the Settings tree. Each env owns
 * its own Secrets and Variables sub-sections — that's the whole point of
 * having the Environments section, rather than making it a parallel "flat
 * list of env names" that duplicates what Secrets already tells us.
 */
export interface EnvironmentView {
  readonly environment: Environment;
  readonly secrets: ScopeListView<Secret>;
  readonly variables: VariablesScopeView;
}

export type SectionListView<T> =
  | { kind: "loading" }
  | { kind: "error"; errorMessage: string }
  | { kind: "items"; items: readonly T[] };

export interface SettingsRepoView {
  readonly repo: RepoCoordinates;
  readonly repoSecrets: ScopeListView<Secret> | { kind: "error"; errorMessage: string };
  readonly repoVariables: VariablesScopeView;
  readonly environments: SectionListView<EnvironmentView>;
}

export type SettingsView =
  | { kind: "idle" }
  | { kind: "no-repo" }
  | { kind: "repos"; repos: readonly SettingsRepoView[] };

export function selectSettingsView(snap: StoreSnapshot): SettingsView {
  if (!snap.repo) {
    if (snap.status === "idle") return { kind: "idle" };
    return { kind: "no-repo" };
  }
  return { kind: "repos", repos: [buildRepoView(snap.repo, snap)] };
}

function buildRepoView(repo: RepoCoordinates, snap: StoreSnapshot): SettingsRepoView {
  const s = snap.secrets;
  if (s.status === "error") {
    const error = { kind: "error" as const, errorMessage: s.errorMessage ?? "unknown" };
    return {
      repo,
      repoSecrets: error,
      repoVariables: { kind: "not-implemented" },
      environments: error,
    };
  }
  return {
    repo,
    repoSecrets: selectScopeList(snap, { kind: "repo" }),
    repoVariables: { kind: "not-implemented" },
    environments: selectEnvironmentsSection(snap),
  };
}

function selectEnvironmentsSection(snap: StoreSnapshot): SectionListView<EnvironmentView> {
  const s = snap.secrets;
  if (s.status === "idle") return { kind: "loading" };
  if (s.status === "loading" && s.environments.length === 0) return { kind: "loading" };
  const items = [...s.environments]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((env): EnvironmentView => ({
      environment: env,
      secrets: selectScopeList(snap, { kind: "environment", name: env.name }),
      variables: { kind: "not-implemented" },
    }));
  return { kind: "items", items };
}

function selectScopeList(snap: StoreSnapshot, scope: SecretScope): ScopeListView<Secret> {
  const items = snap.secrets.secretsByScope.get(scopeKey(scope));
  if (items === undefined) return { kind: "loading" };
  return { kind: "items", items: sortSecrets(items) };
}

function sortSecrets(items: readonly Secret[]): readonly Secret[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}
