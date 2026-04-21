/**
 * Minimal subset of the vscode.git extension API we rely on.
 * Upstream type definition lives at
 *   https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
 * We vendor only the fields we use so we don't need to depend on the
 * entire upstream file at build time.
 */
import type { Event, Uri } from "vscode";

export interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitAPI;
}

export interface GitAPI {
  readonly repositories: Repository[];
  readonly onDidOpenRepository: Event<Repository>;
  readonly onDidCloseRepository: Event<Repository>;
}

export interface Repository {
  readonly rootUri: Uri;
  readonly state: RepositoryState;
}

export interface RepositoryState {
  readonly remotes: Remote[];
  readonly HEAD: Branch | undefined;
  readonly onDidChange: Event<void>;
}

export interface Branch {
  readonly name?: string;
  readonly commit?: string;
  readonly ahead?: number;
  readonly upstream?: { name: string; remote: string };
}

export interface Remote {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
  readonly isReadOnly: boolean;
}
