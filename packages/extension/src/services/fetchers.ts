import type { GitHubApi } from "../data/github-api.js";
import type { RepoContext } from "../data/git-repo.js";
import { selectRepoRunsMissingArtifacts } from "../core/selectors/artifacts.js";
import type { RepoCoordinates, WorkflowRun } from "../core/domain/types.js";
import { isActiveStatus, repoKey } from "../core/domain/types.js";
import type { Logger } from "../util/logger.js";
import type { ApiProvider, Fetcher } from "./sync-engine.js";
import { onCompletionFetcherId } from "./sync-engine.js";
import type { WorkflowStore } from "./workflow-store.js";

/**
 * Produces the full set of fetchers for one tracked repo. Called by the
 * SyncEngine's registrar whenever a new repo appears; the engine owns the
 * cadence scheduling, these functions just bundle the network work.
 */
export function buildFetchersFor(ctx: RepoContext, deps: FetcherDeps): Fetcher[] {
  return [
    workflowsFetcher(ctx, deps),
    artifactSweepFetcher(ctx, deps),
    repoSecretsFetcher(ctx, deps),
    repoVariablesFetcher(ctx, deps),
    environmentsFetcher(ctx, deps),
  ];
}

/** Builder for on-completion artifact fetchers — registered dynamically by the engine. */
export function artifactOnCompletionFetcher(
  repo: RepoCoordinates,
  run: WorkflowRun,
  deps: FetcherDeps,
): Fetcher {
  const key = repoKey(repo);
  return {
    id: onCompletionFetcherId(key, run.id),
    repoKey: key,
    cadence: { kind: "on-completion" },
    fetch: async (signal) => {
      const api = deps.apiProvider();
      if (!api) return;
      const artifacts = await api.listArtifacts(repo, run.id, signal);
      if (signal.aborted) return;
      deps.store.setArtifacts(key, run.id, artifacts);
    },
  };
}

export interface FetcherDeps {
  readonly apiProvider: ApiProvider;
  readonly store: WorkflowStore;
  readonly log: Logger;
  readonly runsPerWorkflow: () => number;
}

/**
 * Polls workflows + recent runs + jobs for one repo. This is the
 * high-frequency fetcher — everything downstream (run status transitions,
 * artifact dispatch) hangs off its output.
 */
function workflowsFetcher(ctx: RepoContext, deps: FetcherDeps): Fetcher {
  const key = repoKey(ctx.coords);
  return {
    id: `poll:workflows:${key}`,
    repoKey: key,
    cadence: { kind: "poll" },
    fetch: async (signal) => {
      const api = deps.apiProvider();
      if (!api) return;

      const workflows = await api.listWorkflows(ctx.coords, signal);
      if (signal.aborted) return;
      const active = workflows.filter((w) => w.state === "active");
      deps.store.setWorkflows(key, active);

      const allRunIds = new Set<number>();
      const activeRunIds = new Set<number>();

      for (const wf of active) {
        if (signal.aborted) return;
        const runs = await api.listRecentRuns(ctx.coords, wf.id, deps.runsPerWorkflow(), signal);
        if (signal.aborted) return;
        deps.store.setRuns(key, wf.id, runs);
        for (const r of runs) {
          allRunIds.add(r.id);
          if (isActiveStatus(r.status)) activeRunIds.add(r.id);
        }
      }

      // Jobs: refetch when any job is active, when this is the first time
      // we see a run, or when the run itself is active. Same heuristic the
      // old LiveSync used.
      const per = deps.store.snapshot().repos.get(key);
      const knownJobs = per?.jobsByRunId ?? new Map();
      for (const runId of allRunIds) {
        if (signal.aborted) return;
        const cached = knownJobs.get(runId);
        const anyCachedJobActive = cached?.some((j: { status: string }) => isActiveStatus(j.status as import("../core/domain/types.js").RunStatus)) ?? false;
        const needsFetch = activeRunIds.has(runId) || !cached || anyCachedJobActive;
        if (!needsFetch) continue;
        try {
          const jobs = await api.listJobs(ctx.coords, runId, signal);
          if (signal.aborted) return;
          deps.store.setJobs(key, runId, jobs);
        } catch (err) {
          if (signal.aborted) return;
          deps.log.warn(`listJobs(${key}/${runId}) failed; skipping`, err);
        }
      }
      deps.store.pruneJobs(key, allRunIds);
      deps.store.pruneArtifacts(key, allRunIds);
      deps.store.setRepoError(key, null);
    },
  };
}

/**
 * Bulk-fetches artifact metadata for every completed run in the repo that
 * doesn't have it cached yet. Fires once on Workflows-view visibility —
 * that's all it takes, since post-completion artifact lists don't change
 * and on-completion fetchers handle anything that finishes mid-session.
 */
function artifactSweepFetcher(ctx: RepoContext, deps: FetcherDeps): Fetcher {
  const key = repoKey(ctx.coords);
  return {
    id: `visibility:artifact-sweep:${key}`,
    repoKey: key,
    cadence: { kind: "visibility", view: "workflows" },
    fetch: async (signal) => {
      const api = deps.apiProvider();
      if (!api) return;
      const runIds = selectRepoRunsMissingArtifacts(deps.store.snapshot(), key);
      if (runIds.length === 0) return;
      await Promise.all(runIds.map(async (runId) => {
        if (signal.aborted) return;
        try {
          const artifacts = await api.listArtifacts(ctx.coords, runId, signal);
          if (signal.aborted) return;
          deps.store.setArtifacts(key, runId, artifacts);
        } catch (err) {
          if (signal.aborted) return;
          deps.log.warn(`listArtifacts(${key}/${runId}) failed; skipping`, err);
        }
      }));
    },
  };
}

function repoSecretsFetcher(ctx: RepoContext, deps: FetcherDeps): Fetcher {
  const key = repoKey(ctx.coords);
  return {
    id: `visibility:repo-secrets:${key}`,
    repoKey: key,
    cadence: { kind: "visibility", view: "settings" },
    fetch: async (signal) => {
      const api = deps.apiProvider();
      if (!api) return;
      deps.store.setSecretsStatus(key, "loading");
      const secrets = await api.listRepoSecrets(ctx.coords, signal);
      if (signal.aborted) return;
      deps.store.setSecrets(key, { kind: "repo" }, secrets);
    },
  };
}

function repoVariablesFetcher(ctx: RepoContext, deps: FetcherDeps): Fetcher {
  const key = repoKey(ctx.coords);
  return {
    id: `visibility:repo-variables:${key}`,
    repoKey: key,
    cadence: { kind: "visibility", view: "settings" },
    fetch: async (signal) => {
      const api = deps.apiProvider();
      if (!api) return;
      const variables = await api.listRepoVariables(ctx.coords, signal);
      if (signal.aborted) return;
      deps.store.setVariables(key, { kind: "repo" }, variables);
    },
  };
}

/**
 * Fetches the environment list *and* every env's secrets + variables in
 * parallel. Modelled as one fetcher so a single visibility event triggers
 * the whole fanout — the user thinks of "environments" as one thing.
 */
function environmentsFetcher(ctx: RepoContext, deps: FetcherDeps): Fetcher {
  const key = repoKey(ctx.coords);
  return {
    id: `visibility:environments:${key}`,
    repoKey: key,
    cadence: { kind: "visibility", view: "settings" },
    fetch: async (signal) => {
      const api = deps.apiProvider();
      if (!api) return;
      const environments = await api.listEnvironments(ctx.coords, signal);
      if (signal.aborted) return;
      deps.store.setEnvironments(key, environments);
      await Promise.all(environments.flatMap((env) => [
        fetchEnvSecrets(api, ctx.coords, key, env.name, deps, signal),
        fetchEnvVariables(api, ctx.coords, key, env.name, deps, signal),
      ]));
    },
  };
}

async function fetchEnvSecrets(
  api: GitHubApi,
  coords: RepoCoordinates,
  key: string,
  envName: string,
  deps: FetcherDeps,
  signal: AbortSignal,
): Promise<void> {
  try {
    const secrets = await api.listEnvironmentSecrets(coords, envName, signal);
    if (signal.aborted) return;
    deps.store.setSecrets(key, { kind: "environment", name: envName }, secrets);
  } catch (err) {
    if (signal.aborted) return;
    deps.log.warn(`listEnvironmentSecrets(${key}/${envName}) failed`, err);
  }
}

async function fetchEnvVariables(
  api: GitHubApi,
  coords: RepoCoordinates,
  key: string,
  envName: string,
  deps: FetcherDeps,
  signal: AbortSignal,
): Promise<void> {
  try {
    const variables = await api.listEnvironmentVariables(coords, envName, signal);
    if (signal.aborted) return;
    deps.store.setVariables(key, { kind: "environment", name: envName }, variables);
  } catch (err) {
    if (signal.aborted) return;
    deps.log.warn(`listEnvironmentVariables(${key}/${envName}) failed`, err);
  }
}
