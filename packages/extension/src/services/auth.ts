import * as vscode from "vscode";
import type { Logger } from "../util/logger.js";

export interface AuthState {
  readonly session: vscode.AuthenticationSession | null;
}

/**
 * Thin wrapper around vscode.authentication for the built-in GitHub provider.
 * Emits whenever the active session changes (sign in, sign out, scope change).
 */
export class AuthService implements vscode.Disposable {
  private static readonly PROVIDER = "github";
  private static readonly SCOPES = ["repo", "workflow"];

  /** Scopes this extension requests from the GitHub provider, for diagnostics. */
  static readonly REQUESTED_SCOPES: readonly string[] = AuthService.SCOPES;

  private readonly emitter = new vscode.EventEmitter<AuthState>();
  private readonly disposables: vscode.Disposable[] = [];
  private current: AuthState = { session: null };

  readonly onDidChange = this.emitter.event;

  constructor(private readonly log: Logger) {
    this.disposables.push(
      vscode.authentication.onDidChangeSessions((e) => {
        if (e.provider.id === AuthService.PROVIDER) void this.refresh({ createIfNone: false });
      }),
    );
  }

  get state(): AuthState { return this.current; }

  async initialize(): Promise<AuthState> {
    return this.refresh({ createIfNone: false, silent: true });
  }

  async signIn(): Promise<AuthState> {
    return this.refresh({ createIfNone: true });
  }

  private async refresh(opts: { createIfNone: boolean; silent?: boolean }): Promise<AuthState> {
    try {
      const session = await vscode.authentication.getSession(
        AuthService.PROVIDER,
        AuthService.SCOPES,
        opts.createIfNone
          ? { createIfNone: true }
          : opts.silent
            ? { silent: true }
            : {},
      );
      const next: AuthState = { session: session ?? null };
      if (next.session?.accessToken !== this.current.session?.accessToken) {
        this.current = next;
        this.emitter.fire(next);
      }
      return next;
    } catch (err) {
      this.log.error("GitHub authentication failed", err);
      const next: AuthState = { session: null };
      if (this.current.session) {
        this.current = next;
        this.emitter.fire(next);
      }
      return next;
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.emitter.dispose();
  }
}
