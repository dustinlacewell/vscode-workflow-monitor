import type { Environment, Secret, SecretScope } from "../domain/secrets.js";
import { scopeKey } from "../domain/secrets.js";
import type { StoreSnapshot } from "../store/snapshot.js";

/**
 * A single scope's state. Tri-state: missing from the map (not yet fetched),
 * empty array (fetched, none exist), or populated.
 */
export type ScopeSecretsView =
  | { kind: "loading" }
  | { kind: "secrets"; items: readonly Secret[] };

export interface SecretGroup {
  readonly scope: SecretScope;
  readonly label: string;
  readonly view: ScopeSecretsView;
}

export type SecretsView =
  | { kind: "idle" } // never fetched yet
  | { kind: "loading" } // first fetch in flight
  | { kind: "error"; errorMessage: string }
  | { kind: "groups"; repo: SecretGroup; environments: readonly SecretGroup[] };

/**
 * Top-level view-model for the Secrets tree.
 *
 * Groups are ordered: repo-scoped first, then environments alphabetically.
 * Each group carries its own sub-view so the tree can render "loading…"
 * per-scope while the user expands environments for the first time — one
 * noisy scope shouldn't leave the whole tree in a loading state.
 */
export function selectSecretsView(snap: StoreSnapshot): SecretsView {
  const s = snap.secrets;
  if (s.status === "idle") return { kind: "idle" };
  if (s.status === "error") return { kind: "error", errorMessage: s.errorMessage ?? "unknown" };
  if (s.status === "loading" && s.environments.length === 0) return { kind: "loading" };

  const repo: SecretGroup = {
    scope: { kind: "repo" },
    label: "Repository",
    view: viewForScope(s.secretsByScope, { kind: "repo" }),
  };

  const envs = [...s.environments]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((env): SecretGroup => ({
      scope: { kind: "environment", name: env.name },
      label: environmentLabel(env),
      view: viewForScope(s.secretsByScope, { kind: "environment", name: env.name }),
    }));

  return { kind: "groups", repo, environments: envs };
}

function viewForScope(
  byScope: ReadonlyMap<string, readonly Secret[]>,
  scope: SecretScope,
): ScopeSecretsView {
  const items = byScope.get(scopeKey(scope));
  if (items === undefined) return { kind: "loading" };
  return { kind: "secrets", items: sortSecrets(items) };
}

function environmentLabel(env: Environment): string {
  return env.protectionRuleCount > 0
    ? `${env.name} (${env.protectionRuleCount} protection rule${env.protectionRuleCount === 1 ? "" : "s"})`
    : env.name;
}

function sortSecrets(items: readonly Secret[]): readonly Secret[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}
