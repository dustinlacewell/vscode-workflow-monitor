import type { Environment, SecretScope } from "../domain/secrets.js";
import type { RepoCoordinates } from "../domain/types.js";
import type { StoreSnapshot } from "../store/snapshot.js";
import { selectSecretsView, type SecretGroup } from "./secrets.js";

/**
 * One-node-per-scope tri-state — same shape the secrets sub-view uses, so
 * the Variables section can mirror Secrets when it lands.
 */
export type SectionListView<T> =
  | { kind: "loading" }
  | { kind: "error"; errorMessage: string }
  | { kind: "items"; items: readonly T[] };

export interface SettingsRepoView {
  readonly repo: RepoCoordinates;
  readonly environments: SectionListView<Environment>;
  readonly secrets: SecretsSectionView;
  readonly variables: VariablesSectionView;
}

/**
 * Secrets under Settings: a repo scope group + one group per environment,
 * each with its own loading/fetched state so an env that hasn't been
 * expanded doesn't block the repo-scoped list from rendering.
 */
export type SecretsSectionView =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; errorMessage: string }
  | { kind: "groups"; repo: SecretGroup; environments: readonly SecretGroup[] };

/**
 * Variables parallel Secrets but aren't implemented yet. Keep the tagged
 * union shape so the UI can render "coming soon" consistently.
 */
export type VariablesSectionView =
  | { kind: "not-implemented" };

export type SettingsView =
  | { kind: "idle" }
  | { kind: "no-repo" }
  | { kind: "repos"; repos: readonly SettingsRepoView[] };

/**
 * Top-level view-model for the Settings tree. Single-repo today (the store
 * only tracks one) but the shape is ready for a multi-root workspace that
 * surfaces several — the tree provider just enumerates `repos`.
 */
export function selectSettingsView(snap: StoreSnapshot): SettingsView {
  if (!snap.repo) {
    if (snap.status === "idle") return { kind: "idle" };
    return { kind: "no-repo" };
  }
  return {
    kind: "repos",
    repos: [buildRepoView(snap.repo, snap)],
  };
}

function buildRepoView(repo: RepoCoordinates, snap: StoreSnapshot): SettingsRepoView {
  return {
    repo,
    environments: selectEnvironmentsSection(snap),
    secrets: selectSecretsSection(snap),
    variables: { kind: "not-implemented" },
  };
}

function selectEnvironmentsSection(snap: StoreSnapshot): SectionListView<Environment> {
  const s = snap.secrets;
  if (s.status === "idle") return { kind: "loading" };
  if (s.status === "error") return { kind: "error", errorMessage: s.errorMessage ?? "unknown" };
  if (s.status === "loading" && s.environments.length === 0) return { kind: "loading" };
  const items = [...s.environments].sort((a, b) => a.name.localeCompare(b.name));
  return { kind: "items", items };
}

function selectSecretsSection(snap: StoreSnapshot): SecretsSectionView {
  const view = selectSecretsView(snap);
  // selectSecretsView already returns the exact tagged union we want —
  // re-export it under the settings namespace so the UI only imports from one
  // place.
  return view;
}

/** Re-export for the tree provider to avoid a second import. */
export type { SecretGroup, SecretScope };
