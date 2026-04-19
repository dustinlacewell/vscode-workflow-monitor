import { Octokit } from "@octokit/rest";
import { RequestError } from "@octokit/request-error";
import type {
  Job,
  RepoCoordinates,
  RunConclusion,
  RunStatus,
  Workflow,
  WorkflowRun,
} from "../domain/types.js";
import type { Logger } from "../util/logger.js";

export class GitHubApiError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status: number | undefined, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

export interface RateLimitSnapshot {
  readonly remaining: number;
  readonly limit: number;
  readonly resetAt: Date;
}

interface CacheEntry<T> {
  readonly etag: string;
  readonly value: T;
}

/**
 * Thin GitHub Actions client over Octokit.
 *
 * The client keeps a per-endpoint ETag cache so that unchanged responses come
 * back as 304 Not Modified — these don't count against the primary REST
 * rate limit, which is what lets us poll aggressively while runs are active.
 */
export class GitHubClient {
  private readonly octokit: Octokit;
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private lastRateLimit: RateLimitSnapshot | null = null;

  constructor(token: string, private readonly log: Logger) {
    this.octokit = new Octokit({
      auth: token,
      userAgent: "github-actions-monitor-vscode",
      request: { retries: 0 },
    });
  }

  get rateLimit(): RateLimitSnapshot | null { return this.lastRateLimit; }

  async listWorkflows(repo: RepoCoordinates, signal?: AbortSignal): Promise<Workflow[]> {
    const key = `workflows:${repo.owner}/${repo.repo}`;
    const data = await this.conditionalGet<{ workflows: RawWorkflow[] }>(
      key,
      `GET /repos/{owner}/{repo}/actions/workflows`,
      { owner: repo.owner, repo: repo.repo, per_page: 100 },
      signal,
    );
    return data.workflows.map(mapWorkflow);
  }

  async listRecentRuns(
    repo: RepoCoordinates,
    workflowId: number,
    perPage: number,
    signal?: AbortSignal,
  ): Promise<WorkflowRun[]> {
    const key = `runs:${repo.owner}/${repo.repo}:${workflowId}:${perPage}`;
    const data = await this.conditionalGet<{ workflow_runs: RawRun[] }>(
      key,
      `GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs`,
      { owner: repo.owner, repo: repo.repo, workflow_id: workflowId, per_page: perPage },
      signal,
    );
    return data.workflow_runs.map(mapRun);
  }

  async listJobs(repo: RepoCoordinates, runId: number, signal?: AbortSignal): Promise<Job[]> {
    const key = `jobs:${repo.owner}/${repo.repo}:${runId}`;
    const data = await this.conditionalGet<{ jobs: RawJob[] }>(
      key,
      `GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs`,
      { owner: repo.owner, repo: repo.repo, run_id: runId, per_page: 100 },
      signal,
    );
    return data.jobs.map(mapJob);
  }

  async rerunWorkflow(repo: RepoCoordinates, runId: number): Promise<void> {
    await this.mutate(`POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun`, {
      owner: repo.owner,
      repo: repo.repo,
      run_id: runId,
    });
  }

  async cancelRun(repo: RepoCoordinates, runId: number): Promise<void> {
    await this.mutate(`POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel`, {
      owner: repo.owner,
      repo: repo.repo,
      run_id: runId,
    });
  }

  private async conditionalGet<T>(
    cacheKey: string,
    route: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const cached = this.cache.get(cacheKey) as CacheEntry<T> | undefined;
    const headers: Record<string, string> = {};
    if (cached) headers["if-none-match"] = cached.etag;

    const requestOpts: Record<string, unknown> = { ...params, headers };
    if (signal) requestOpts["request"] = { signal };
    try {
      const response = await this.octokit.request(route, requestOpts);
      this.captureRateLimit(response.headers);
      const etag = normalizeEtag(response.headers.etag);
      const body = response.data as T;
      if (etag) this.cache.set(cacheKey, { etag, value: body });
      return body;
    } catch (err) {
      if (err instanceof RequestError) {
        this.captureRateLimit(err.response?.headers ?? {});
        if (err.status === 304 && cached) return cached.value;
      }
      if (isAbortError(err)) throw err;
      throw this.wrap(err, route);
    }
  }

  private async mutate(route: string, params: Record<string, unknown>): Promise<void> {
    try {
      const response = await this.octokit.request(route, params);
      this.captureRateLimit(response.headers);
    } catch (err) {
      throw this.wrap(err, route);
    }
  }

  private captureRateLimit(headers: Record<string, unknown>): void {
    const remaining = numHeader(headers["x-ratelimit-remaining"]);
    const limit = numHeader(headers["x-ratelimit-limit"]);
    const reset = numHeader(headers["x-ratelimit-reset"]);
    if (remaining != null && limit != null && reset != null) {
      this.lastRateLimit = { remaining, limit, resetAt: new Date(reset * 1000) };
    }
  }

  private wrap(err: unknown, route: string): GitHubApiError {
    if (err instanceof RequestError) {
      this.log.warn(`GitHub API ${route} failed: ${err.status} ${err.message}`);
      return new GitHubApiError(err.message, err.status, err);
    }
    this.log.error(`GitHub API ${route} failed`, err);
    return new GitHubApiError(
      err instanceof Error ? err.message : String(err),
      undefined,
      err,
    );
  }
}

function numHeader(v: unknown): number | null {
  if (typeof v === "string") { const n = Number(v); return Number.isFinite(n) ? n : null; }
  if (typeof v === "number") return v;
  return null;
}

function normalizeEtag(etag: unknown): string | null {
  if (typeof etag !== "string" || etag.length === 0) return null;
  // GitHub returns weak ETags; keep them as-is — the server interprets them.
  return etag;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message === "The operation was aborted.");
}

// --- mappers: isolate REST shape from domain shape -------------------------

interface RawWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
  html_url: string;
}
interface RawRun {
  id: number;
  workflow_id: number;
  run_number: number;
  name: string | null;
  display_title: string;
  status: string | null;
  conclusion: string | null;
  event: string;
  head_branch: string | null;
  head_sha: string;
  actor: { login: string } | null;
  created_at: string;
  updated_at: string;
  run_started_at: string | null;
  html_url: string;
}
interface RawJob {
  id: number;
  run_id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string;
}

function mapWorkflow(raw: RawWorkflow): Workflow {
  return {
    id: raw.id,
    name: raw.name,
    path: raw.path,
    state: (raw.state as Workflow["state"]) ?? "active",
    htmlUrl: raw.html_url,
  };
}

function mapRun(raw: RawRun): WorkflowRun {
  return {
    id: raw.id,
    workflowId: raw.workflow_id,
    runNumber: raw.run_number,
    name: raw.name,
    displayTitle: raw.display_title,
    status: (raw.status ?? "unknown") as RunStatus,
    conclusion: (raw.conclusion ?? null) as RunConclusion,
    event: raw.event,
    headBranch: raw.head_branch,
    headSha: raw.head_sha,
    actorLogin: raw.actor?.login ?? null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    runStartedAt: raw.run_started_at,
    htmlUrl: raw.html_url,
  };
}

function mapJob(raw: RawJob): Job {
  return {
    id: raw.id,
    runId: raw.run_id,
    name: raw.name,
    status: (raw.status ?? "unknown") as RunStatus,
    conclusion: (raw.conclusion ?? null) as RunConclusion,
    startedAt: raw.started_at,
    completedAt: raw.completed_at,
    htmlUrl: raw.html_url,
  };
}
