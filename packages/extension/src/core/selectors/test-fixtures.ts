import type { AuthFailure } from "../auth/failure.js";
import type { Environment, Secret, SecretScope, Variable } from "../domain/secrets.js";
import { scopeKey } from "../domain/secrets.js";
import type { Artifact, Job, RepoCoordinates, Workflow, WorkflowRun } from "../domain/types.js";
import { repoKey } from "../domain/types.js";
import { EMPTY_SECRETS_SNAPSHOT, type SecretsSnapshot, type SecretsStatus } from "../store/secrets-snapshot.js";
import type { PerRepoState, StoreSnapshot, StoreStatus } from "../store/snapshot.js";

export function makeWorkflow(partial: Partial<Workflow> & Pick<Workflow, "id" | "name">): Workflow {
  return {
    path: `.github/workflows/${partial.name}.yml`,
    state: "active",
    htmlUrl: `https://github.com/o/r/actions/workflows/${partial.id}`,
    ...partial,
  };
}

export function makeRun(partial: Partial<WorkflowRun> & Pick<WorkflowRun, "id" | "workflowId">): WorkflowRun {
  return {
    runNumber: partial.id,
    name: null,
    displayTitle: `run ${partial.id}`,
    status: "completed",
    conclusion: "success",
    event: "push",
    headBranch: "main",
    headSha: "deadbee",
    actorLogin: "octocat",
    createdAt: new Date(partial.id * 1000).toISOString(),
    updatedAt: new Date(partial.id * 1000).toISOString(),
    runStartedAt: new Date(partial.id * 1000).toISOString(),
    htmlUrl: `https://github.com/o/r/actions/runs/${partial.id}`,
    ...partial,
  };
}

export function makeArtifact(partial: Partial<Artifact> & Pick<Artifact, "id" | "name">): Artifact {
  return {
    sizeBytes: 1024,
    expired: false,
    createdAt: new Date(partial.id * 1000).toISOString(),
    expiresAt: null,
    archiveDownloadUrl: `https://api.github.com/repos/o/r/actions/artifacts/${partial.id}/zip`,
    ...partial,
  };
}

export function makeJob(partial: Partial<Job> & Pick<Job, "id" | "runId">): Job {
  return {
    name: `job-${partial.id}`,
    status: "completed",
    conclusion: "success",
    startedAt: null,
    completedAt: null,
    htmlUrl: `https://github.com/o/r/actions/runs/${partial.runId}/job/${partial.id}`,
    steps: [],
    ...partial,
  };
}

// --- PerRepoState + snapshot builders -------------------------------------

const DEFAULT_REPO: RepoCoordinates = { owner: "o", repo: "r" };

export interface PerRepoOptions {
  repo?: RepoCoordinates;
  branch?: string | null;
  workflows?: readonly Workflow[];
  runsByWorkflowId?: ReadonlyMap<number, readonly WorkflowRun[]>;
  jobsByRunId?: ReadonlyMap<number, readonly Job[]>;
  artifactsByRunId?: ReadonlyMap<number, readonly Artifact[]>;
  errorMessage?: string | null;
}

/**
 * Pull the first (usually only) PerRepoState out of a single-repo snapshot.
 * Convenience for selector tests that used to operate on the snapshot
 * directly and now take PerRepoState.
 */
export function perRepoFrom(snap: StoreSnapshot): PerRepoState {
  const first = snap.repos.values().next().value;
  if (!first) throw new Error("makeSnapshot produced an empty repos map; use makePerRepo directly");
  return first;
}

export function makePerRepo(opts: PerRepoOptions = {}): PerRepoState {
  return {
    repo: opts.repo ?? DEFAULT_REPO,
    branch: opts.branch === undefined ? "main" : opts.branch,
    workflows: opts.workflows ?? [],
    runsByWorkflowId: opts.runsByWorkflowId ?? new Map(),
    jobsByRunId: opts.jobsByRunId ?? new Map(),
    artifactsByRunId: opts.artifactsByRunId ?? new Map(),
    errorMessage: opts.errorMessage ?? null,
    lastUpdated: null,
  };
}

export interface SnapshotOptions {
  status?: StoreStatus;
  /** Convenience: for single-repo tests, all the per-repo options flattened in. */
  branch?: string | null;
  workflows?: readonly Workflow[];
  runsByWorkflowId?: ReadonlyMap<number, readonly WorkflowRun[]>;
  jobsByRunId?: ReadonlyMap<number, readonly Job[]>;
  artifactsByRunId?: ReadonlyMap<number, readonly Artifact[]>;
  /** Override when you need multi-repo or an empty snapshot. */
  repos?: readonly PerRepoState[];
  errorMessage?: string | null;
  authFailure?: AuthFailure | null;
  /** Single-repo secrets convenience; consumed only when `repos` is unset. */
  secrets?: SecretsSnapshot;
  /** Multi-repo secrets override. */
  secretsByRepo?: ReadonlyMap<string, SecretsSnapshot>;
}

export function makeSnapshot(opts: SnapshotOptions = {}): StoreSnapshot {
  const status = opts.status ?? "ready";
  // A few statuses imply "no repo known yet"; default those to an empty
  // `repos` map unless the caller explicitly supplied one.
  const implicitlyEmpty = status === "idle" || status === "no-repo" || status === "unauthenticated";
  const repos = opts.repos
    ? new Map(opts.repos.map((p) => [repoKey(p.repo), p]))
    : implicitlyEmpty
      ? new Map<string, PerRepoState>()
      : new Map([[
          repoKey(DEFAULT_REPO),
          makePerRepo({
            ...(opts.branch !== undefined ? { branch: opts.branch } : {}),
            ...(opts.workflows !== undefined ? { workflows: opts.workflows } : {}),
            ...(opts.runsByWorkflowId !== undefined ? { runsByWorkflowId: opts.runsByWorkflowId } : {}),
            ...(opts.jobsByRunId !== undefined ? { jobsByRunId: opts.jobsByRunId } : {}),
            ...(opts.artifactsByRunId !== undefined ? { artifactsByRunId: opts.artifactsByRunId } : {}),
          }),
        ]]);
  const secretsByRepo = opts.secretsByRepo ?? (
    opts.secrets
      ? new Map([[repoKey(DEFAULT_REPO), opts.secrets]])
      : repos.size === 0
        ? new Map<string, SecretsSnapshot>()
        : new Map([[repoKey(DEFAULT_REPO), EMPTY_SECRETS_SNAPSHOT]])
  );
  return {
    status,
    repos,
    secretsByRepo,
    errorMessage: opts.errorMessage ?? null,
    authFailure: opts.authFailure ?? null,
    lastUpdated: null,
  };
}

// --- secrets + variables fixtures -----------------------------------------

export function makeSecret(partial: Partial<Secret> & Pick<Secret, "name">): Secret {
  return {
    scope: { kind: "repo" },
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    ...partial,
  };
}

export function makeVariable(partial: Partial<Variable> & Pick<Variable, "name">): Variable {
  return {
    value: `value-${partial.name}`,
    scope: { kind: "repo" },
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    ...partial,
  };
}

export function makeEnvironment(partial: Partial<Environment> & Pick<Environment, "name">): Environment {
  return {
    htmlUrl: `https://github.com/o/r/deployments/${partial.name}`,
    protectionRuleCount: 0,
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    ...partial,
  };
}

export interface SecretsSnapshotOptions {
  status?: SecretsStatus;
  environments?: readonly Environment[];
  byScope?: ReadonlyArray<readonly [SecretScope, readonly Secret[]]>;
  variablesByScope?: ReadonlyArray<readonly [SecretScope, readonly Variable[]]>;
  errorMessage?: string | null;
}

export function makeSecretsSnapshot(opts: SecretsSnapshotOptions = {}): SecretsSnapshot {
  const secrets = new Map<string, readonly Secret[]>();
  for (const [scope, list] of opts.byScope ?? []) secrets.set(scopeKey(scope), list);
  const variables = new Map<string, readonly Variable[]>();
  for (const [scope, list] of opts.variablesByScope ?? []) variables.set(scopeKey(scope), list);
  return {
    status: opts.status ?? "ready",
    environments: opts.environments ?? [],
    secretsByScope: secrets,
    variablesByScope: variables,
    errorMessage: opts.errorMessage ?? null,
    lastUpdated: null,
  };
}
