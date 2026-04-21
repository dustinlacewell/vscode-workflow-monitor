/**
 * Pure domain types for GitHub Actions secrets and environments.
 *
 * Note: the GitHub REST API never returns secret *values* — only metadata
 * (name, created, updated). That is the single most important safety property
 * of this tree: we literally cannot leak what we don't have.
 */

export type SecretScopeKind = "repo" | "environment";

/**
 * Tagged identifier for a secrets namespace. Used as a map key in the store
 * (via scopeKey) so we can hold every scope's list in one data structure.
 */
export type SecretScope =
  | { kind: "repo" }
  | { kind: "environment"; name: string };

export function scopeKey(scope: SecretScope): string {
  return scope.kind === "repo" ? "repo" : `env:${scope.name}`;
}

export interface Secret {
  readonly name: string;
  readonly scope: SecretScope;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Variables share the secret scope model but carry plaintext values — GitHub
 * returns the value on GET. That's the whole UX difference: we can show and
 * copy values; for secrets we can't.
 */
export interface Variable {
  readonly name: string;
  readonly value: string;
  readonly scope: SecretScope;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Environment {
  readonly name: string;
  readonly htmlUrl: string | null;
  readonly protectionRuleCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
