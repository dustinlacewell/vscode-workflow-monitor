import * as vscode from "vscode";

export type BranchFilter = "current" | "all";

export interface ViewState {
  readonly branchFilter: BranchFilter;
}

/**
 * Client-side view preferences that don't affect what gets *fetched* — only
 * what gets *displayed*. Splitting these out from WorkflowStore keeps the
 * domain snapshot canonical while letting the tree/status-bar filter the
 * same data through different lenses.
 *
 * Persisted to workspaceState so a user's branch preference survives reloads
 * without bleeding between unrelated workspaces.
 */
export class ViewStateService implements vscode.Disposable {
  private static readonly KEY = "viewState.v1";

  private readonly emitter = new vscode.EventEmitter<ViewState>();
  private current: ViewState;

  readonly onDidChange = this.emitter.event;

  constructor(private readonly memento: vscode.Memento) {
    this.current = memento.get<ViewState>(ViewStateService.KEY) ?? { branchFilter: "current" };
  }

  get state(): ViewState { return this.current; }

  toggleBranchFilter(): void {
    this.set({ branchFilter: this.current.branchFilter === "current" ? "all" : "current" });
  }

  setBranchFilter(filter: BranchFilter): void {
    if (this.current.branchFilter === filter) return;
    this.set({ branchFilter: filter });
  }

  private set(next: ViewState): void {
    this.current = next;
    void this.memento.update(ViewStateService.KEY, next);
    this.emitter.fire(next);
  }

  dispose(): void { this.emitter.dispose(); }
}
