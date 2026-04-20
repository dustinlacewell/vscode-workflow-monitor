import { writeFile } from "node:fs/promises";
import * as vscode from "vscode";
import type { GitHubApi } from "../data/github-api.js";
import type { Artifact, RepoCoordinates } from "../core/domain/types.js";

/**
 * Thin wrapper around the artifacts API that adds VS Code specifics:
 *   - file picker for where to save the zip;
 *   - progress notification during download;
 *   - "Reveal in Explorer" follow-up once done.
 *
 * Kept as a service (not a free function) so we can inject fakes in tests
 * and later add caching/resume without touching the command handlers.
 */
export class ArtifactService {
  constructor(private readonly apiProvider: () => GitHubApi | null) {}

  async saveToDisk(repo: RepoCoordinates, artifact: Artifact): Promise<vscode.Uri | null> {
    if (artifact.expired) {
      vscode.window.showWarningMessage(`Artifact "${artifact.name}" has expired on GitHub.`);
      return null;
    }
    const api = this.apiProvider();
    if (!api) throw new Error("Not authenticated — sign in to GitHub first.");

    const defaultName = `${sanitizeFilename(artifact.name)}.zip`;
    const defaultUri = pickDefaultSaveUri(defaultName);
    const target = await vscode.window.showSaveDialog({
      ...(defaultUri ? { defaultUri } : {}),
      filters: { "Zip archive": ["zip"] },
      title: `Save artifact "${artifact.name}"`,
      saveLabel: "Download",
    });
    if (!target) return null;

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Downloading ${artifact.name} (${humanBytes(artifact.sizeBytes)})`,
        cancellable: false,
      },
      async () => {
        const buffer = await api.downloadArtifact(repo, artifact.id);
        await writeFile(target.fsPath, buffer);
        const revealAction = "Reveal in Explorer";
        const choice = await vscode.window.showInformationMessage(
          `Saved ${artifact.name} → ${target.fsPath}`,
          revealAction,
        );
        if (choice === revealAction) {
          await vscode.commands.executeCommand("revealFileInOS", target);
        }
        return target;
      },
    );
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "artifact";
}

function pickDefaultSaveUri(filename: string): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? vscode.Uri.joinPath(folder.uri, filename) : undefined;
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
