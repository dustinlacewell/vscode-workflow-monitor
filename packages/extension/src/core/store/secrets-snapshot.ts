import type { Environment, Secret } from "../domain/secrets.js";

export type SecretsStatus = "idle" | "loading" | "ready" | "error";

/**
 * Secrets are fetched on demand (tree visibility, explicit refresh) rather
 * than polled — listing them round-trips multiple endpoints and nothing
 * changes often enough to justify a loop. So the snapshot carries its own
 * status separate from the workflows snapshot.
 */
export interface SecretsSnapshot {
  readonly status: SecretsStatus;
  readonly environments: readonly Environment[];
  /** Keyed by `scopeKey(scope)`. Missing key = not-yet-fetched for that scope. */
  readonly secretsByScope: ReadonlyMap<string, readonly Secret[]>;
  readonly errorMessage: string | null;
  readonly lastUpdated: Date | null;
}

export const EMPTY_SECRETS_SNAPSHOT: SecretsSnapshot = {
  status: "idle",
  environments: [],
  secretsByScope: new Map(),
  errorMessage: null,
  lastUpdated: null,
};
