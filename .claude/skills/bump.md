---
name: bump
description: Bump the extension package.json version and create a version-only commit. Takes `major`, `minor`, or `patch` as argument.
---

# Version Bump

The extension at `packages/extension/package.json` is the only published thing in this repo — the `site` is private and deploys from `main` via CI. This skill bumps the extension version in a single version-only commit.

## Usage

```
/bump major    # X.Y.Z → (X+1).0.0
/bump minor    # X.Y.Z → X.(Y+1).0
/bump patch    # X.Y.Z → X.Y.(Z+1)
```

If the user runs `/bump` with no argument, ask which of `major` / `minor` / `patch` they want — don't guess.

## Procedure

1. **Read the current version** from `packages/extension/package.json`.

2. **Compute the next version** by semver.

3. **Update `packages/extension/package.json`** with the `Edit` tool:
   - `"version": "<CURRENT>"` → `"version": "<NEW>"`

4. **Verify**. `grep -n '"version": "<NEW>"' packages/extension/package.json` should find exactly one match.

5. **Commit** with the exact message `Bump to v<NEW>`. Must be a version-only commit — no unrelated changes staged.

6. **Report back**: old version → new, and the commit sha.

## Non-goals

- No build, package, publish, or git tag. This is purely a version-string edit + commit.
- No release-notes generation.
- Follow up with `wm publish extension` for marketplace publish; see [release.md](./release.md) for the full workflow (package + smoke-test + push + GH release + publish).

## Edge cases

- If the working tree is not clean (`git status --short` non-empty), stop and warn. The commit must be version-only.
- If the user passes something other than `major` / `minor` / `patch`, reject with a clear message.
