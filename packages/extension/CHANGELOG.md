# Changelog

## 0.2.0 — 2026-04-21

### Added

- **Settings tree.** New top-level view: repository → Secrets / Variables /
  Environments, with environment-scoped nesting. Full create / update /
  delete for both secrets and variables.
  - Secret writes use libsodium seal-box encryption; multi-line values
    (SSH keys, certs) round-trip cleanly; CRLF normalized to LF.
  - Variable values are visible inline, with copy-value action.
  - Loud failure modes — non-2xx responses surface as error toasts rather
    than silent save failures.
- **Multi-repo support.** Multi-root workspaces with more than one GitHub
  repository now render each repo as a collapsible root in both the
  Workflows and Settings trees. Single-repo workspaces render flat,
  unchanged from 0.1.x.
- **Auth failure banner.** 401/403 errors now produce a structured
  diagnostic with scope hints, endpoint, and a "Show details" action
  that opens a markdown report. Replaces the opaque "refresh button
  does nothing" failure mode.
- **Artifacts under runs.** Completed runs grow an "Artifacts (N)" row
  alongside their jobs. Click or inline icon triggers download with
  progress + reveal-in-explorer.

### Changed

- **Status-bar ranking.** The badge now surfaces the latest run on a
  tracked repo's current branch, with its status driving the visual.
  Previously a global scan for `action_required` could hijack the badge
  with stale approval-gated runs from branches you were never on.
- **Sync architecture.** `LiveSync` and `SecretSync` replaced with a
  single `SyncEngine` driving three cadence policies (poll /
  visibility / on-completion). Unifies how every resource type is
  scheduled.

### Fixed

- 403 from variables/secrets endpoints no longer blanks the Workflows
  view — auth-wide failures (401) are distinguished from per-endpoint
  scope limitations (403).
- "View is busy" chevron underline no longer flickers during sync
  cycles (store emits coalesced to one per microtask).
- Settings data prefetches on repo resolution so the view is ready
  before the user opens it.

## 0.1.1 — 2026-04-19

Marketplace icon, tighter README, screenshots.

## 0.1.0 — 2026-04-19

First marketplace release. Live Workflows sidebar: workflows → runs →
jobs → steps, with log viewer, dispatch, rerun/cancel, artifacts
download, and failure-context copy-for-LLM.
