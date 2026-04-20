import type { Artifact, Job, RepoCoordinates, Workflow, WorkflowRun } from "../core/domain/types.js";

export interface RateLimitSnapshot {
  readonly remaining: number;
  readonly limit: number;
  readonly resetAt: Date;
}

/**
 * Contract for every GitHub Actions operation the extension performs.
 *
 * Keeping this as an interface (rather than depending on the concrete
 * GitHubClient) means:
 *   - services depend on behavior, not Octokit's type surface;
 *   - tests can stand up fakes without hitting the network;
 *   - we can swap implementations (e.g. a GraphQL one) without ripples.
 */
export interface GitHubApi {
  readonly rateLimit: RateLimitSnapshot | null;

  listWorkflows(repo: RepoCoordinates, signal?: AbortSignal): Promise<Workflow[]>;
  listRecentRuns(repo: RepoCoordinates, workflowId: number, perPage: number, signal?: AbortSignal): Promise<WorkflowRun[]>;
  listJobs(repo: RepoCoordinates, runId: number, signal?: AbortSignal): Promise<Job[]>;

  fetchJobLog(repo: RepoCoordinates, jobId: number, signal?: AbortSignal): Promise<string>;

  listArtifacts(repo: RepoCoordinates, runId: number, signal?: AbortSignal): Promise<Artifact[]>;
  downloadArtifact(repo: RepoCoordinates, artifactId: number): Promise<Buffer>;

  /** Fetch a file's content at a given ref as UTF-8 text. */
  getFileContent(repo: RepoCoordinates, path: string, ref: string | null, signal?: AbortSignal): Promise<string>;

  dispatchWorkflow(repo: RepoCoordinates, workflowId: number, ref: string, inputs: Record<string, string>): Promise<void>;
  rerunWorkflow(repo: RepoCoordinates, runId: number): Promise<void>;
  rerunFailedJobs(repo: RepoCoordinates, runId: number): Promise<void>;
  cancelRun(repo: RepoCoordinates, runId: number): Promise<void>;
}

export class GitHubApiError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status: number | undefined, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "GitHubApiError";
    this.status = status;
  }
}
