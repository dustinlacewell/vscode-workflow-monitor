import * as vscode from "vscode";
import type { GitAPI, GitExtension, Remote, Repository } from "./git-extension.js";
import type { RepoCoordinates } from "../core/domain/types.js";
import { repoKey } from "../core/domain/types.js";
import type { Logger } from "../util/logger.js";

function orderRemotes(remotes: readonly Remote[], upstream: string | undefined): Remote[] {
  const seen = new Set<string>();
  const out: Remote[] = [];
  const push = (r: Remote | undefined) => {
    if (r && !seen.has(r.name)) { seen.add(r.name); out.push(r); }
  };
  if (upstream) push(remotes.find((r) => r.name === upstream));
  push(remotes.find((r) => r.name === "origin"));
  for (const r of remotes) push(r);
  return out;
}

/**
 * Parses owner/repo from a GitHub remote URL.
 * Accepts:
 *   git@github.com:owner/repo.git
 *   https://github.com/owner/repo(.git)
 *   ssh://git@github.com/owner/repo.git
 */
export function parseGitHubRemote(url: string): RepoCoordinates | null {
  const cleaned = url.trim().replace(/\.git$/, "");
  const patterns = [
    /^git@github\.com:([^/]+)\/([^/]+)$/,
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/,
  ];
  for (const p of patterns) {
    const m = cleaned.match(p);
    if (m) return { owner: m[1]!, repo: m[2]! };
  }
  return null;
}

export interface RepoContext {
  readonly coords: RepoCoordinates;
  readonly branch: string | null;
  readonly rootUri: vscode.Uri;
}

interface BranchSnapshot {
  readonly name: string;
  readonly ahead: number;
  readonly commit: string | null;
}

/**
 * Watches the vscode.git extension for every GitHub repository in the
 * workspace. Emits a new list whenever the set, branches, or remotes
 * meaningfully change.
 *
 * Multi-repo workspaces (multi-root with microservice-style layouts) surface
 * as multiple entries; single-repo workspaces emit a one-element list.
 */
export class GitRepoWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<readonly RepoContext[]>();
  private readonly pushEmitter = new vscode.EventEmitter<RepoContext>();
  private readonly lastBranch = new WeakMap<Repository, BranchSnapshot>();
  private api: GitAPI | null = null;
  private current: readonly RepoContext[] = [];

  readonly onDidChange = this.emitter.event;
  readonly onDidPush = this.pushEmitter.event;

  constructor(private readonly log: Logger) {}

  get contexts(): readonly RepoContext[] { return this.current; }

  async start(): Promise<void> {
    const ext = vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (!ext) {
      this.log.warn("vscode.git extension not found");
      return;
    }
    const activated = ext.isActive ? ext.exports : await ext.activate();
    if (!activated.enabled) {
      this.log.warn("vscode.git extension is disabled");
      return;
    }
    this.api = activated.getAPI(1);

    for (const repo of this.api.repositories) this.hookRepository(repo);
    this.disposables.push(this.api.onDidOpenRepository((r) => { this.hookRepository(r); this.recompute(); }));
    this.disposables.push(this.api.onDidCloseRepository(() => this.recompute()));

    this.recompute();
  }

  private hookRepository(repo: Repository): void {
    this.disposables.push(repo.state.onDidChange(() => {
      this.detectPush(repo);
      this.recompute();
    }));
  }

  /**
   * Fire onDidPush when the active branch's `ahead` counter drops to 0 from a
   * non-zero value, or the HEAD commit SHA changes at ahead=0 (force-push).
   * We emit the pushed repo's RepoContext so the coordinator can scope a
   * burst-poll to that repo rather than blasting all of them.
   */
  private detectPush(repo: Repository): void {
    const ctx = this.current.find((c) => c.rootUri.toString() === repo.rootUri.toString());
    if (!ctx) return;
    const head = repo.state.HEAD;
    const name = head?.name;
    if (!name) return;
    const next: BranchSnapshot = {
      name,
      ahead: head.ahead ?? 0,
      commit: head.commit ?? null,
    };
    const prev = this.lastBranch.get(repo);
    this.lastBranch.set(repo, next);
    if (!prev || prev.name !== name) return;
    const pushed =
      (prev.ahead > 0 && next.ahead === 0) ||
      (prev.ahead === 0 && next.ahead === 0 && prev.commit !== next.commit);
    if (pushed) this.pushEmitter.fire(ctx);
  }

  private recompute(): void {
    const next = this.enumerate();
    if (sameList(this.current, next)) return;
    this.current = next;
    this.emitter.fire(next);
  }

  private enumerate(): readonly RepoContext[] {
    if (!this.api) return [];
    const out: RepoContext[] = [];
    const seen = new Set<string>();

    // Prefer the workspace folder containing the active editor as the
    // first-listed repo; the order leaks into tree display order, and users
    // expect "the one they were just editing" to feel primary.
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const repos = [...this.api.repositories];
    if (activeUri) {
      repos.sort((a, b) => {
        const aMatch = activeUri.fsPath.startsWith(a.rootUri.fsPath) ? 1 : 0;
        const bMatch = activeUri.fsPath.startsWith(b.rootUri.fsPath) ? 1 : 0;
        return bMatch - aMatch;
      });
    }

    for (const repo of repos) {
      // Upstream remote > origin > any other GitHub remote.
      const upstreamRemoteName = repo.state.HEAD?.upstream?.remote;
      const ordered = orderRemotes(repo.state.remotes, upstreamRemoteName);
      for (const remote of ordered) {
        const url = remote.fetchUrl ?? remote.pushUrl;
        if (!url) continue;
        const coords = parseGitHubRemote(url);
        if (!coords) continue;
        const key = repoKey(coords);
        if (seen.has(key)) break; // avoid duplicates when same repo appears in multiple folders
        seen.add(key);
        out.push({
          coords,
          branch: repo.state.HEAD?.name ?? null,
          rootUri: repo.rootUri,
        });
        break; // one remote per repo
      }
    }
    return out;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.emitter.dispose();
    this.pushEmitter.dispose();
  }
}

function sameList(a: readonly RepoContext[], b: readonly RepoContext[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    if (x.coords.owner !== y.coords.owner) return false;
    if (x.coords.repo !== y.coords.repo) return false;
    if (x.branch !== y.branch) return false;
    if (x.rootUri.toString() !== y.rootUri.toString()) return false;
  }
  return true;
}
