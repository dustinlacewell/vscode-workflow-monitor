import type { Environment, Secret, SecretScope, Variable } from "../domain/secrets.js";
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
 * View-model for a single environment under the Settings tree. Each env owns
 * its own Secrets and Variables sub-sections — that's the whole point of
 * having the Environments section, rather than making it a parallel "flat
 * list of env names" that duplicates what Secrets already tells us.
 */
export interface EnvironmentView {
  readonly environment: Environment;
  readonly secrets: ScopeListView<Secret>;
  readonly variables: ScopeListView<Variable>;
}

export type SectionListView<T> =
  | { kind: "loading" }
  | { kind: "error"; errorMessage: string }
  | { kind: "items"; items: readonly T[] };

export interface SettingsRepoView {
  readonly repo: RepoCoordinates;
  readonly repoSecrets: ScopeListView<Secret> | { kind: "error"; errorMessage: string };
  readonly repoVariables: ScopeListView<Variable> | { kind: "error"; errorMessage: string };
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
      repoVariables: error,
      environments: error,
    };
  }
  return {
    repo,
    repoSecrets: selectSecretScope(snap, { kind: "repo" }),
    repoVariables: selectVariableScope(snap, { kind: "repo" }),
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
      secrets: selectSecretScope(snap, { kind: "environment", name: env.name }),
      variables: selectVariableScope(snap, { kind: "environment", name: env.name }),
    }));
  return { kind: "items", items };
}

function selectSecretScope(snap: StoreSnapshot, scope: SecretScope): ScopeListView<Secret> {
  const items = snap.secrets.secretsByScope.get(scopeKey(scope));
  if (items === undefined) return { kind: "loading" };
  return { kind: "items", items: sortNamed(items) };
}

function selectVariableScope(snap: StoreSnapshot, scope: SecretScope): ScopeListView<Variable> {
  const items = snap.secrets.variablesByScope.get(scopeKey(scope));
  if (items === undefined) return { kind: "loading" };
  return { kind: "items", items: sortNamed(items) };
}

function sortNamed<T extends { name: string }>(items: readonly T[]): readonly T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}
