import * as vscode from "vscode";
import type { DispatchInput } from "../core/domain/types.js";

/**
 * Sequential input collection for a workflow_dispatch. Returns null if the
 * user cancels at any point (matching the VS Code "escape = abort" pattern).
 */
export async function promptDispatchInputs(
  inputs: readonly DispatchInput[],
  defaultRef: string,
): Promise<{ ref: string; inputs: Record<string, string> } | null> {
  const ref = await vscode.window.showInputBox({
    title: "Run workflow — branch / tag / SHA",
    prompt: "Which ref should this dispatch target?",
    value: defaultRef,
    ignoreFocusOut: true,
  });
  if (ref === undefined) return null;

  const collected: Record<string, string> = {};
  for (const input of inputs) {
    const value = await promptInput(input);
    if (value === null) return null;
    if (value !== undefined) collected[input.name] = value;
  }
  return { ref: ref.trim() || defaultRef, inputs: collected };
}

interface ValuedPick extends vscode.QuickPickItem { value: string }

async function promptInput(input: DispatchInput): Promise<string | null | undefined> {
  const baseTitle = `Input: ${input.name}${input.required ? " (required)" : ""}`;
  const description = input.description ?? undefined;

  switch (input.type) {
    case "boolean": {
      const items: ValuedPick[] = [
        { label: "true", value: "true" },
        { label: "false", value: "false" },
      ];
      const pick = await vscode.window.showQuickPick(items, {
        title: baseTitle,
        ...(description ? { placeHolder: description } : {}),
        ignoreFocusOut: true,
        canPickMany: false,
      });
      return pick ? pick.value : null;
    }
    case "choice": {
      const options = input.options ?? [];
      if (options.length === 0) return promptString(input, baseTitle, description);
      const items: ValuedPick[] = options.map((o) => ({ label: o, value: o }));
      const pick = await vscode.window.showQuickPick(items, {
        title: baseTitle,
        ...(description ? { placeHolder: description } : {}),
        ignoreFocusOut: true,
        canPickMany: false,
      });
      return pick ? pick.value : null;
    }
    case "environment":
    case "number":
    case "string":
    default:
      return promptString(input, baseTitle, description);
  }
}

async function promptString(input: DispatchInput, title: string, prompt: string | undefined): Promise<string | null | undefined> {
  const value = await vscode.window.showInputBox({
    title,
    ...(prompt ? { prompt } : {}),
    value: input.default ?? "",
    ignoreFocusOut: true,
    validateInput: (v) => input.required && v.trim().length === 0 ? `${input.name} is required` : undefined,
  });
  if (value === undefined) return null;
  // Skip empty optional inputs so GitHub uses the workflow's declared default.
  if (!input.required && value.trim().length === 0) return undefined;
  return value;
}
