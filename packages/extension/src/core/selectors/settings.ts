import type { Environment, Secret, SecretScope, Variable } from "../domain/secrets.js";
import { scopeKey } from "../domain/secrets.js";
import type { RepoCoordinates } from "../domain/types.js";
import { EMPTY_SECRETS_SNAPSHOT, type SecretsSnapshot } from "../store/secrets-snapshot.js";
import type { StoreSnapshot } from "../store/snapshot.js";

export type ScopeListView<T> =
  | { kind: "loading" }
  | { kind: "items"; items: readonly T[] };

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
  if (snap.repos.size === 0) {
    if (snap.status === "idle") return { kind: "idle" };
    return { kind: "no-repo" };
  }
  const repos: SettingsRepoView[] = [];
  for (const per of snap.repos.values()) {
    const sec = snap.secretsByRepo.get(`${per.repo.owner}/${per.repo.repo}`) ?? EMPTY_SECRETS_SNAPSHOT;
    repos.push(buildRepoView(per.repo, sec));
  }
  return { kind: "repos", repos };
}

function buildRepoView(repo: RepoCoordinates, s: SecretsSnapshot): SettingsRepoView {
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
    repoSecrets: selectSecretScope(s, { kind: "repo" }),
    repoVariables: selectVariableScope(s, { kind: "repo" }),
    environments: selectEnvironmentsSection(s),
  };
}

function selectEnvironmentsSection(s: SecretsSnapshot): SectionListView<EnvironmentView> {
  if (s.status === "idle") return { kind: "loading" };
  if (s.status === "loading" && s.environments.length === 0) return { kind: "loading" };
  const items = [...s.environments]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((env): EnvironmentView => ({
      environment: env,
      secrets: selectSecretScope(s, { kind: "environment", name: env.name }),
      variables: selectVariableScope(s, { kind: "environment", name: env.name }),
    }));
  return { kind: "items", items };
}

function selectSecretScope(s: SecretsSnapshot, scope: SecretScope): ScopeListView<Secret> {
  const items = s.secretsByScope.get(scopeKey(scope));
  if (items === undefined) return { kind: "loading" };
  return { kind: "items", items: sortNamed(items) };
}

function selectVariableScope(s: SecretsSnapshot, scope: SecretScope): ScopeListView<Variable> {
  const items = s.variablesByScope.get(scopeKey(scope));
  if (items === undefined) return { kind: "loading" };
  return { kind: "items", items: sortNamed(items) };
}

function sortNamed<T extends { name: string }>(items: readonly T[]): readonly T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}
