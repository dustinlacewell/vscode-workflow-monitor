import type { Environment, Secret, Variable } from "../domain/secrets.js";

export type SecretsStatus = "idle" | "loading" | "ready" | "error";

/**
 * Settings-style state (secrets + variables + environments). Fetched on
 * demand rather than polled — listing round-trips multiple endpoints and
 * nothing changes often enough to justify a loop. The snapshot carries its
 * own status separate from the workflows snapshot.
 *
 * Named `SecretsSnapshot` for historical reasons — conceptually it covers
 * everything the Settings tree shows.
 */
export interface SecretsSnapshot {
  readonly status: SecretsStatus;
  readonly environments: readonly Environment[];
  /** Keyed by `scopeKey(scope)`. Missing key = not-yet-fetched for that scope. */
  readonly secretsByScope: ReadonlyMap<string, readonly Secret[]>;
  readonly variablesByScope: ReadonlyMap<string, readonly Variable[]>;
  readonly errorMessage: string | null;
  readonly lastUpdated: Date | null;
}

export const EMPTY_SECRETS_SNAPSHOT: SecretsSnapshot = {
  status: "idle",
  environments: [],
  secretsByScope: new Map(),
  variablesByScope: new Map(),
  errorMessage: null,
  lastUpdated: null,
};
