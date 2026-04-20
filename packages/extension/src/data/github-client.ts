import { Octokit } from "@octokit/rest";
import { RequestError } from "@octokit/request-error";
import type {
  Artifact,
  Job,
  RepoCoordinates,
  RunConclusion,
  RunStatus,
  Step,
  Workflow,
  WorkflowRun,
} from "../core/domain/types.js";
import type { Logger } from "../util/logger.js";
import type { GitHubApi, RateLimitSnapshot } from "./github-api.js";
import { GitHubApiError } from "./github-api.js";

export { GitHubApiError } from "./github-api.js";
export type { RateLimitSnapshot } from "./github-api.js";

interface CacheEntry<T> {
  readonly etag: string;
  readonly value: T;
}

/**
 * Octokit-backed GitHubApi implementation.
 *
 * The client keeps a per-endpoint ETag cache so that unchanged responses come
 * back as 304 Not Modified — these don't count against the primary REST
 * rate limit, which is what lets us poll aggressively while runs are active.
 */
export class GitHubClient implements GitHubApi {
  private readonly octokit: Octokit;
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private lastRateLimit: RateLimitSnapshot | null = null;

  constructor(token: string, private readonly log: Logger) {
    this.octokit = new Octokit({
      auth: token,
      userAgent: "vscode-workflow-monitor",
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

  async fetchJobLog(repo: RepoCoordinates, jobId: number, signal?: AbortSignal): Promise<string> {
    // The logs endpoint returns a 302 redirect to a signed S3 URL, which
    // Octokit follows automatically. GitHub rejects non-default Accept
    // headers here, so we leave Octokit's default ("application/vnd.github+json")
    // alone — the follow-through to S3 returns plain text regardless.
    try {
      const response = await this.octokit.request(
        "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs",
        {
          owner: repo.owner,
          repo: repo.repo,
          job_id: jobId,
          ...(signal ? { request: { signal } } : {}),
        },
      );
      this.captureRateLimit(response.headers);
      return toUtf8(response.data);
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw this.wrap(err, `GET jobs/${jobId}/logs`);
    }
  }

  async listArtifacts(repo: RepoCoordinates, runId: number, signal?: AbortSignal): Promise<Artifact[]> {
    const key = `artifacts:${repo.owner}/${repo.repo}:${runId}`;
    const data = await this.conditionalGet<{ artifacts: RawArtifact[] }>(
      key,
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts",
      { owner: repo.owner, repo: repo.repo, run_id: runId, per_page: 100 },
      signal,
    );
    return data.artifacts.map(mapArtifact);
  }

  async downloadArtifact(repo: RepoCoordinates, artifactId: number): Promise<Buffer> {
    try {
      const response = await this.octokit.request(
        "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}",
        { owner: repo.owner, repo: repo.repo, artifact_id: artifactId, archive_format: "zip" },
      );
      this.captureRateLimit(response.headers);
      return toBuffer(response.data);
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw this.wrap(err, `GET artifacts/${artifactId}/zip`);
    }
  }

  async getFileContent(repo: RepoCoordinates, path: string, ref: string | null, signal?: AbortSignal): Promise<string> {
    try {
      const response = await this.octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner: repo.owner,
        repo: repo.repo,
        path,
        ...(ref ? { ref } : {}),
        headers: { accept: "application/vnd.github.v3.raw" },
        ...(signal ? { request: { signal } } : {}),
      });
      this.captureRateLimit(response.headers);
      return toUtf8(response.data);
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw this.wrap(err, `GET contents/${path}`);
    }
  }

  async dispatchWorkflow(repo: RepoCoordinates, workflowId: number, ref: string, inputs: Record<string, string>): Promise<void> {
    await this.mutate(
      "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
      { owner: repo.owner, repo: repo.repo, workflow_id: workflowId, ref, inputs },
    );
  }

  async rerunWorkflow(repo: RepoCoordinates, runId: number): Promise<void> {
    await this.mutate(`POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun`, {
      owner: repo.owner,
      repo: repo.repo,
      run_id: runId,
    });
  }

  async rerunFailedJobs(repo: RepoCoordinates, runId: number): Promise<void> {
    await this.mutate(`POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs`, {
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

function toUtf8(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return String(data ?? "");
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === "string") return Buffer.from(data, "binary");
  throw new Error("Unexpected response body type for binary download");
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
interface RawStep {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
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
  steps?: RawStep[];
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
    steps: (raw.steps ?? []).map(mapStep),
  };
}

interface RawArtifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
  created_at: string;
  expires_at: string | null;
  archive_download_url: string;
}

function mapArtifact(raw: RawArtifact): Artifact {
  return {
    id: raw.id,
    name: raw.name,
    sizeBytes: raw.size_in_bytes,
    expired: raw.expired,
    createdAt: raw.created_at,
    expiresAt: raw.expires_at,
    archiveDownloadUrl: raw.archive_download_url,
  };
}

function mapStep(raw: RawStep): Step {
  return {
    number: raw.number,
    name: raw.name,
    status: (raw.status ?? "unknown") as RunStatus,
    conclusion: (raw.conclusion ?? null) as RunConclusion,
    startedAt: raw.started_at,
    completedAt: raw.completed_at,
  };
}
