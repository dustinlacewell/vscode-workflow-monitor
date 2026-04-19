# Workflow Monitor

**Close the tab. Open the sidebar.**

A VS Code sidebar that streams your GitHub Actions workflows in real time.
Re-run, cancel, tail logs, and copy failure context to your clipboard —
without leaving the editor.

![Workflow Monitor sidebar](https://raw.githubusercontent.com/dustinlacewell/vscode-workflow-monitor/main/media/sidebar.png)

## Why

The Actions tab is a context switch. Workflow Monitor puts your CI in the
same view as your code — so the failed job, the line that broke it, and the
fix all live in the same window.

## Features

**Live workflow tree.** Workflows → runs → jobs → steps in one always-on
sidebar. Polling tightens automatically while anything is in-flight.

**Rich log view.** Click a job and the log opens in a tab — one continuous
timeline, collapsible per-step, ANSI colours, auto-scroll-follow, inline
callouts for `##[error]` / `##[warning]` lines.

![Log timeline](https://raw.githubusercontent.com/dustinlacewell/vscode-workflow-monitor/main/media/log.png)

**One-click copy.** Copy a full job log or a focused failure context
(metadata + the failing step's output) to your clipboard.

**Re-run, cancel, dispatch.** Trigger `workflow_dispatch` with typed inputs,
re-run only the failed jobs, or cancel a run mid-flight — from the tree.

**Artifacts & branch focus.** Browse and download artifacts per run; filter
the tree to the branch you're working on.

**Quiet when idle, loud when it matters.** Status-bar pill at a glance.
Opt-in notifications on failure, success, or action-required approvals.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `workflowMonitor.activePollIntervalMs` | `2500` | Poll cadence while any run is in-progress. |
| `workflowMonitor.idlePollIntervalMs` | `30000` | Poll cadence when nothing is running. |
| `workflowMonitor.runsPerWorkflow` | `5` | Recent runs shown per workflow. |
| `workflowMonitor.showStatusBar` | `true` | Show the latest run status in the status bar. |
| `workflowMonitor.notifyOnFailure` | `false` | Notify when a run completes with a failure. |
| `workflowMonitor.notifyOnSuccess` | `false` | Notify when a run completes successfully. |
| `workflowMonitor.notifyOnActionRequired` | `true` | Notify when a run needs manual approval. |

## License

[MIT](./LICENSE).
