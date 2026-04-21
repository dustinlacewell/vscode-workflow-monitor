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

/**
 * Ask for a new secret name with GitHub's validation rules applied live.
 *
 *   - must start with a letter or underscore
 *   - alphanumeric + underscore only
 *   - <= 245 chars
 *   - may not begin with `GITHUB_` (reserved)
 *
 * Returns null if the user cancels.
 */
export async function promptSecretName(opts: { scopeLabel: string; taken: readonly string[] }): Promise<string | null> {
  const takenSet = new Set(opts.taken);
  const value = await vscode.window.showInputBox({
    title: `New secret — ${opts.scopeLabel}`,
    prompt: "Uppercase letters, digits, and underscores. Must start with a letter or underscore.",
    placeHolder: "MY_SECRET_NAME",
    ignoreFocusOut: true,
    validateInput: (v) => validateSecretName(v, takenSet),
  });
  if (value === undefined) return null;
  return value.trim();
}

function validateSecretName(raw: string, taken: ReadonlySet<string>): string | undefined {
  return validateIdentifierName(raw, taken, "secret");
}

/**
 * Prompt for a secret value. Password-masked input; paste-safe for multi-line
 * content (newlines preserved verbatim; CRLF normalized downstream in
 * encryptSecretValue). Returns null on cancel.
 */
export async function promptSecretValue(opts: {
  title: string;
  prompt?: string;
}): Promise<string | null> {
  const value = await vscode.window.showInputBox({
    title: opts.title,
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
    placeHolder: "Paste or type the secret value. Multi-line values are supported.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => v.length === 0 ? "Value must not be empty" : undefined,
  });
  return value ?? null;
}

/**
 * Variable names follow the same rules as secrets on GitHub's side (they
 * share the same identifier namespace at runtime).
 */
export async function promptVariableName(opts: { scopeLabel: string; taken: readonly string[] }): Promise<string | null> {
  const takenSet = new Set(opts.taken);
  const value = await vscode.window.showInputBox({
    title: `New variable — ${opts.scopeLabel}`,
    prompt: "Uppercase letters, digits, and underscores. Must start with a letter or underscore.",
    placeHolder: "MY_VARIABLE",
    ignoreFocusOut: true,
    validateInput: (v) => validateIdentifierName(v, takenSet, "variable"),
  });
  if (value === undefined) return null;
  return value.trim();
}

/**
 * Prompt for a variable value. Plaintext (no password mask) — variables are
 * non-secret by design, and seeing the value as you type/paste is useful.
 */
export async function promptVariableValue(opts: {
  title: string;
  current?: string;
  prompt?: string;
}): Promise<string | null> {
  const value = await vscode.window.showInputBox({
    title: opts.title,
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
    ...(opts.current !== undefined ? { value: opts.current } : {}),
    placeHolder: "Paste or type the variable value. Multi-line values are supported.",
    ignoreFocusOut: true,
    validateInput: (v) => v.length === 0 ? "Value must not be empty" : undefined,
  });
  return value ?? null;
}

function validateIdentifierName(raw: string, taken: ReadonlySet<string>, kind: string): string | undefined {
  const v = raw.trim();
  if (v.length === 0) return "Name is required";
  if (v.length > 245) return "Name must be 245 characters or fewer";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) {
    return "Use only letters, digits, and underscores; must start with a letter or underscore";
  }
  if (/^GITHUB_/i.test(v)) return "Names starting with GITHUB_ are reserved by GitHub";
  if (taken.has(v)) return `A ${kind} named "${v}" already exists in this scope`;
  return undefined;
}
