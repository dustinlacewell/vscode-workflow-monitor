# Vision

## Pivot thesis

**"GitHub Actions, observed well."** Cede authoring, LSP, YAML, GHE Server, web/virtual workspaces — entirely. Compete on the surfaces the upstream [github/vscode-github-actions](https://github.com/github/vscode-github-actions) tracker actively abandons.

Upstream ships releases but treats issues as write-only: **98 of 100 open issues have zero maintainer comments**, oldest untouched ~2.3 years. The highest-reacted scope-relevant pain is all observation: opaque auth ([#441](https://github.com/github/vscode-github-actions/issues/441), [#355](https://github.com/github/vscode-github-actions/issues/355), [#502](https://github.com/github/vscode-github-actions/issues/502)), a rigid single-repo tree ([#528](https://github.com/github/vscode-github-actions/issues/528), [#558](https://github.com/github/vscode-github-actions/issues/558), [#572](https://github.com/github/vscode-github-actions/issues/572), [#407](https://github.com/github/vscode-github-actions/issues/407), [#434](https://github.com/github/vscode-github-actions/issues/434)), and **zero coverage for artifacts**.

We are not competing on feature count. We are betting that the ~30% of users who just want a **reliable actions dashboard** are underserved.

## Where we already lead — keep and deepen

- **Log viewer** — ANSI + step folding + failure callouts. Upstream is plain text.
- **Artifacts** — we download; upstream has no UI. Make this a first-class tree, not a command. Browse → preview-if-text → diff-two-runs → pin-to-workspace.
- **Diagnostics panel** integration — failures land in the Problems panel. Unique.
- **Adaptive polling + ETags** — upstream polls naively.

## Where we need design

### Secrets & Variables as "tangible assets"

A dedicated tree. Upstream's is buggy — org vars leak plaintext ([#529](https://github.com/github/vscode-github-actions/issues/529)), multi-line secrets get newline-corrupted ([#566](https://github.com/github/vscode-github-actions/issues/566)), silent save failures ([#513](https://github.com/github/vscode-github-actions/issues/513)).

Scope v1 to **read/create/update/delete at repo + environment scope**. Skip org-level entirely in v1 — that is where the foot-guns are.

### One Runs view — cross-repo *and* single-repo

Not two trees. One **Runs** tree with a header filter strip:

- Repo: `[All ▾]` multi-select, persisted
- Branch: `[Current / All / Named…]`
- Status: `[failed, in_progress, …]`
- Sort: `time | repo | workflow`
- Group: `flat | by repo | by workflow`

Default grouping is flat chronological. One tree, same data, different projections.

## Architecture — layer the core, thin the edges

Current layout already separates store / live-sync / diagnostics in [`packages/extension/src/services/`](../packages/extension/src/services/), but everything imports `vscode`. Pay down that debt so the extension becomes actually testable and extensible.

```
core/          zero vscode imports. pure TS. unit-testable.
  domain/       types (Run, Job, Artifact, Secret, …)
  api/          interface GitHubSource { listRuns, getLog, listArtifacts, … }
  store/        event-sourced snapshot, one per resource kind
  policy/       polling rules, ETag cache, filter logic
  selectors/    pure projections (Run[] → grouped/sorted/filtered)

adapters/      vscode-facing. thin.
  vscode-auth/  AuthenticationSession → token
  octokit/      implements core/api via Octokit
  git/          workspaceFolders → GitHubRepoContext[]
  persistence/  workspaceState for filters/pins

ui/            pure projection of store via selectors.
  trees/        Runs, Artifacts, Secrets, Settings
  webviews/     log viewer, artifact preview
  commands/     one file per action verb
  statusbar/
```

### Key moves

1. **Treat resources as plural.** `RunStore`, `ArtifactStore`, `SecretStore`, each with its own polling policy.
   - Runs — 2.5 s active / 30 s idle (existing adaptive behavior)
   - Artifacts — refresh on run completion
   - Secrets — on-demand only

2. **Selectors, not bespoke trees.** Cross-repo view is not a new tree — it is `selectRuns({ repos, branch, status, groupBy })` feeding one generic `TreeProvider`.

3. **Auth observability.** Surface the raw `HttpError`, the requested scopes, and a "Reconnect" action in a banner node at the top of the tree. This alone solves the [#441](https://github.com/github/vscode-github-actions/issues/441) class of bugs by default.

4. **Write tests.** `core/` has no `vscode` dependency — `vitest` plus a fake `GitHubSource` gets us coverage on polling, filtering, and ETag logic without spinning up the Extension Host.

5. **No webpack monolith for the webview.** Preserve current separation; make framework choices (lit-html vs vanilla) based on log-viewer needs, not dogma.

## What we cut — or simply never add

- No language server. No YAML schema. No grammar.
- No GitHub Enterprise Server. No `vscode.dev` web build. No virtual workspaces.
- No pinned-workflow status bar (upstream bug magnet in multi-root workspaces).
- No org-level secrets in v1.
- No workflow authoring assistance of any kind.

## Competitive positioning — pain themes we hit

Mapping the upstream tracker's top complaints to what we'd ship:

| Upstream pain | Our answer |
| --- | --- |
| Opaque auth failures ([#441](https://github.com/github/vscode-github-actions/issues/441), [#355](https://github.com/github/vscode-github-actions/issues/355), [#502](https://github.com/github/vscode-github-actions/issues/502), [#510](https://github.com/github/vscode-github-actions/issues/510)) | Auth banner with raw error + scopes + one-click reconnect |
| Single-repo tree view ([#528](https://github.com/github/vscode-github-actions/issues/528), [#558](https://github.com/github/vscode-github-actions/issues/558)) | Cross-repo Runs view with group/filter/sort |
| No duration or timeline ([#434](https://github.com/github/vscode-github-actions/issues/434), [#572](https://github.com/github/vscode-github-actions/issues/572), [#407](https://github.com/github/vscode-github-actions/issues/407)) | Duration column on runs + jobs; stretch: waterfall webview |
| No artifact UI | First-class Artifacts tree with browse/preview/download |
| Secrets are unsafe ([#529](https://github.com/github/vscode-github-actions/issues/529), [#566](https://github.com/github/vscode-github-actions/issues/566), [#513](https://github.com/github/vscode-github-actions/issues/513)) | Repo+env-scoped Secrets tree; loud failure modes |
| A11y labels missing ([#379](https://github.com/github/vscode-github-actions/issues/379)) | Accessible labels on all status-bearing tree items |

## Bottom line

The architecture change is real but scoped. We don't delete anything — we extract [`core/`](../packages/extension/src/) from `services/`, make trees pure projections, and add three new stores (Artifacts, Secrets, filters-as-state). Tests follow from the `vscode`-free core.

Cede breadth. Win on reliability, observability, and the surfaces upstream forgot.
