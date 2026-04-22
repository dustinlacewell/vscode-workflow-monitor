# Release Process

## Overview

This repo has two publish targets:
- **VS Code Marketplace**: `ldlework.vscode-workflow-monitor` (the extension at `packages/extension`)
- **GitHub Releases**: tag + `.vsix` asset for manual install

The marketing `site` deploys automatically from `main` via CI — no manual step.

## Steps

### 1. Commit all pending changes

Stage and commit any outstanding work before bumping.

### 2. Bump the version

Run `/bump major|minor|patch` (see [bump.md](./bump.md)). Bumps `packages/extension/package.json` and creates a version-only commit.

### 3. Build

```bash
pnpm build
```

Builds both packages (the extension via esbuild/tsc, the site via Astro).

### 4. Package the extension

```bash
wm package extension
```

Produces `packages/extension/vscode-workflow-monitor-X.Y.Z.vsix`. Equivalent to `pnpm --filter vscode-workflow-monitor package`.

### 5. Smoke-test the extension

```bash
wm install extension
```

Installs the just-packaged vsix into VS Code / Windsurf. Reload the editor window and exercise the extension — catches broken builds before they reach users.

### 6. Push and create GitHub release

```bash
git push origin main
gh release create vX.Y.Z packages/extension/vscode-workflow-monitor-X.Y.Z.vsix \
  --title "vX.Y.Z" --notes "release notes here"
```

Attach the `.vsix` so users can install manually. The site deploy happens on this push — if site changes need to be visible, push before publishing the marketplace so everything goes live in the same window.

### 7. Publish to VS Code Marketplace

```bash
wm publish extension
```

- Requires a Personal Access Token from Azure DevOps with `Marketplace (Manage)` scope.
- Run `npx @vscode/vsce login ldlework` to authenticate if the token has expired (expect `TF400813` on auth failure).
- Publisher is `ldlework`.

## Gotchas

- `vsce publish` must run from the extension directory; `wm publish extension` handles the `cwd` correctly.
- Marketplace PATs expire silently; rotate via `vsce login ldlework`.
- Site CI runs on `git push origin main` — if the site shouldn't update with this release, avoid touching `packages/site/` in the release commits.
