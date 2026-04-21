import type { AuthFailure } from "../auth/failure.js";
import type { Environment, Secret, SecretScope } from "../domain/secrets.js";
import { scopeKey } from "../domain/secrets.js";
import type { Artifact, Job, Workflow, WorkflowRun } from "../domain/types.js";
import { EMPTY_SECRETS_SNAPSHOT, type SecretsSnapshot, type SecretsStatus } from "../store/secrets-snapshot.js";
import type { StoreSnapshot, StoreStatus } from "../store/snapshot.js";

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

export interface SnapshotOptions {
  status?: StoreStatus;
  branch?: string | null;
  workflows?: readonly Workflow[];
  runsByWorkflowId?: ReadonlyMap<number, readonly WorkflowRun[]>;
  jobsByRunId?: ReadonlyMap<number, readonly Job[]>;
  artifactsByRunId?: ReadonlyMap<number, readonly Artifact[]>;
  errorMessage?: string | null;
  authFailure?: AuthFailure | null;
  secrets?: SecretsSnapshot;
}

export function makeSnapshot(opts: SnapshotOptions = {}): StoreSnapshot {
  return {
    status: opts.status ?? "ready",
    repo: { owner: "o", repo: "r" },
    branch: opts.branch === undefined ? "main" : opts.branch,
    workflows: opts.workflows ?? [],
    runsByWorkflowId: opts.runsByWorkflowId ?? new Map(),
    jobsByRunId: opts.jobsByRunId ?? new Map(),
    artifactsByRunId: opts.artifactsByRunId ?? new Map(),
    errorMessage: opts.errorMessage ?? null,
    authFailure: opts.authFailure ?? null,
    secrets: opts.secrets ?? EMPTY_SECRETS_SNAPSHOT,
    lastUpdated: null,
  };
}

export function makeSecret(partial: Partial<Secret> & Pick<Secret, "name">): Secret {
  return {
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
  errorMessage?: string | null;
}

export function makeSecretsSnapshot(opts: SecretsSnapshotOptions = {}): SecretsSnapshot {
  const map = new Map<string, readonly Secret[]>();
  for (const [scope, list] of opts.byScope ?? []) map.set(scopeKey(scope), list);
  return {
    status: opts.status ?? "ready",
    environments: opts.environments ?? [],
    secretsByScope: map,
    errorMessage: opts.errorMessage ?? null,
    lastUpdated: null,
  };
}
