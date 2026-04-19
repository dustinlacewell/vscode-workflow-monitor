# Workflow Monitor

A VS Code sidebar that streams your GitHub Actions workflows, runs, jobs, and
logs in real time — re-run, cancel, dispatch, tail logs, and copy failure
context without leaving the editor.

## Features

- **Live workflow tree.** Workflows → runs → jobs → steps in one always-on
  sidebar. Poll intervals tighten automatically while anything is in-flight.
- **Rich log view.** Click a job or step to open a timeline-spined log panel
  with collapsible steps, ANSI colours, auto-scroll-follow, and inline
  callouts for `##[error]` / `##[warning]` lines.
- **One-click copy.** Copy a full job log or a focused failure context
  (metadata header + failing step excerpt) straight to your clipboard.
- **Re-run, cancel, dispatch.** Trigger `workflow_dispatch` with typed
  inputs, re-run just the failed jobs of a run, or cancel a run mid-flight —
  all from the tree context menu.
- **Artifacts & branch focus.** Browse artifacts per run, download them
  in-place, and filter the tree to the branch you're actually working on.
- **Quiet when idle, loud when it matters.** Status-bar pill at a glance.
  Opt-in notifications on failure, success, or action-required approvals.

## Requirements

- VS Code 1.95 or newer.
- Git repository with a GitHub `origin` remote.
- A GitHub account the extension can authenticate with (first activation
  prompts for sign-in).

## Extension Settings

- `workflowMonitor.activePollIntervalMs` (default `2500`): poll cadence while
  any run is in-progress.
- `workflowMonitor.idlePollIntervalMs` (default `30000`): poll cadence when
  nothing is running.
- `workflowMonitor.runsPerWorkflow` (default `5`): how many recent runs to
  show per workflow.
- `workflowMonitor.showStatusBar` (default `true`): show the latest run
  status pill in the status bar.
- `workflowMonitor.notifyOnFailure` / `notifyOnSuccess` /
  `notifyOnActionRequired`: opt-in notifications on terminal states.

## License

[MIT](./LICENSE).
