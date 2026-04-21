import type { Environment, Secret } from "../core/domain/secrets.js";
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

  // --- secrets ------------------------------------------------------------

  listRepoSecrets(repo: RepoCoordinates, signal?: AbortSignal): Promise<Secret[]>;
  listEnvironments(repo: RepoCoordinates, signal?: AbortSignal): Promise<Environment[]>;
  listEnvironmentSecrets(repo: RepoCoordinates, env: string, signal?: AbortSignal): Promise<Secret[]>;

  getRepoPublicKey(repo: RepoCoordinates, signal?: AbortSignal): Promise<PublicKey>;
  getEnvironmentPublicKey(repo: RepoCoordinates, env: string, signal?: AbortSignal): Promise<PublicKey>;

  putRepoSecret(repo: RepoCoordinates, name: string, encryptedValue: string, keyId: string): Promise<void>;
  putEnvironmentSecret(repo: RepoCoordinates, env: string, name: string, encryptedValue: string, keyId: string): Promise<void>;

  deleteRepoSecret(repo: RepoCoordinates, name: string): Promise<void>;
  deleteEnvironmentSecret(repo: RepoCoordinates, env: string, name: string): Promise<void>;
}

/**
 * Public key + its stable identifier. The `keyId` must accompany every PUT so
 * GitHub can pair our ciphertext with the right key for decryption on their
 * side; rotating it would otherwise silently invalidate stored secrets.
 */
export interface PublicKey {
  readonly keyId: string;
  readonly key: string; // base64-encoded Curve25519 public key
}

export interface GitHubApiErrorDetail {
  readonly route?: string | null;
  readonly headers?: Readonly<Record<string, unknown>> | null;
  readonly documentationUrl?: string | null;
}

export class GitHubApiError extends Error {
  readonly status: number | undefined;
  readonly route: string | null;
  readonly headers: Readonly<Record<string, unknown>> | null;
  readonly documentationUrl: string | null;
  constructor(message: string, status: number | undefined, detail: GitHubApiErrorDetail = {}, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "GitHubApiError";
    this.status = status;
    this.route = detail.route ?? null;
    this.headers = detail.headers ?? null;
    this.documentationUrl = detail.documentationUrl ?? null;
  }
}
