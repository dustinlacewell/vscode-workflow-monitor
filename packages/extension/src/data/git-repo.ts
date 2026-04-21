import * as vscode from "vscode";
import type { GitAPI, GitExtension, Remote, Repository } from "./git-extension.js";
import type { RepoCoordinates } from "../core/domain/types.js";
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

/**
 * Watches the vscode.git extension for a GitHub repository in the workspace.
 * Emits a new RepoContext whenever the active coordinates change (remote
 * reconfigured, workspace folder changed, branch switched, etc.).
 */
interface BranchSnapshot {
  readonly name: string;
  readonly ahead: number;
  readonly commit: string | null;
}

export class GitRepoWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<RepoContext | null>();
  private readonly pushEmitter = new vscode.EventEmitter<void>();
  private readonly lastBranch = new WeakMap<Repository, BranchSnapshot>();
  private api: GitAPI | null = null;
  private current: RepoContext | null = null;

  readonly onDidChange = this.emitter.event;
  readonly onDidPush = this.pushEmitter.event;

  constructor(private readonly log: Logger) {}

  get context(): RepoContext | null { return this.current; }

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
   * Only tracks the repo currently selected as the extension's target, so
   * background repos don't generate noise.
   */
  private detectPush(repo: Repository): void {
    if (this.current?.rootUri.toString() !== repo.rootUri.toString()) return;
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

    // Only interpret transitions within the same branch; branch switches are
    // identity changes, not push events.
    if (!prev || prev.name !== name) return;

    const pushed =
      (prev.ahead > 0 && next.ahead === 0) ||
      (prev.ahead === 0 && next.ahead === 0 && prev.commit !== next.commit);
    if (pushed) this.pushEmitter.fire();
  }

  private recompute(): void {
    const next = this.pickRepo();
    const prev = this.current;
    const changed =
      (!prev && next) ||
      (prev && !next) ||
      (prev && next && (
        prev.coords.owner !== next.coords.owner ||
        prev.coords.repo !== next.coords.repo ||
        prev.branch !== next.branch ||
        prev.rootUri.toString() !== next.rootUri.toString()
      ));
    if (changed) {
      this.current = next;
      this.emitter.fire(next);
    }
  }

  private pickRepo(): RepoContext | null {
    if (!this.api) return null;
    // Prefer the workspace folder that contains the active editor; fall back to first.
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const repos = [...this.api.repositories];
    if (activeUri) {
      repos.sort((a, b) => {
        const aMatch = activeUri.fsPath.startsWith(a.rootUri.fsPath) ? 1 : 0;
        const bMatch = activeUri.fsPath.startsWith(b.rootUri.fsPath) ? 1 : 0;
        return bMatch - aMatch;
      });
    }

    // Within a repo, prefer: (1) the remote the current branch tracks,
    // (2) origin, (3) any remaining GitHub remote. Workflows only run on
    // the repo the branch pushes to, so the upstream remote is the one the
    // user almost always means.
    for (const repo of repos) {
      const upstreamRemoteName = repo.state.HEAD?.upstream?.remote;
      const ordered = orderRemotes(repo.state.remotes, upstreamRemoteName);
      for (const remote of ordered) {
        const url = remote.fetchUrl ?? remote.pushUrl;
        if (!url) continue;
        const coords = parseGitHubRemote(url);
        if (!coords) continue;
        return {
          coords,
          branch: repo.state.HEAD?.name ?? null,
          rootUri: repo.rootUri,
        };
      }
    }
    return null;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.emitter.dispose();
    this.pushEmitter.dispose();
  }
}
