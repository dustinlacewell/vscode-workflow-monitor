import * as vscode from "vscode";
import * as YAML from "yaml";
import type { GitHubApi } from "../data/github-api.js";
import type {
  DispatchInput,
  DispatchInputType,
  RepoCoordinates,
  Workflow,
  WorkflowDispatchSpec,
} from "../core/domain/types.js";

/**
 * Reads workflow YAML definitions from the repository so we can inspect
 * features that aren't exposed via the REST API — most importantly, the
 * `workflow_dispatch` input schema needed to prompt the user before
 * triggering a manual run.
 *
 * Definitions are cached by (path, ref); they change rarely and only when
 * the underlying file is edited, so a process-lifetime cache is fine.
 */
export class WorkflowDefinitionService implements vscode.Disposable {
  private readonly cache = new Map<string, WorkflowDispatchSpec>();

  constructor(private readonly apiProvider: () => GitHubApi | null) {}

  async getDispatchSpec(repo: RepoCoordinates, workflow: Workflow, ref: string | null): Promise<WorkflowDispatchSpec> {
    const key = `${repo.owner}/${repo.repo}:${workflow.path}:${ref ?? "HEAD"}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const api = this.apiProvider();
    if (!api) throw new Error("Not authenticated — sign in to GitHub first.");

    const yamlText = await api.getFileContent(repo, workflow.path, ref);
    const spec = parseDispatchSpec(yamlText);
    this.cache.set(key, spec);
    return spec;
  }

  invalidate(): void { this.cache.clear(); }

  dispose(): void { this.cache.clear(); }
}

/**
 * Parse a workflow YAML into its workflow_dispatch schema.
 *
 * Pure + exported so it can be unit-tested without any network or vscode
 * dependencies.
 */
export function parseDispatchSpec(yamlText: string): WorkflowDispatchSpec {
  let doc: unknown;
  try { doc = YAML.parse(yamlText); }
  catch { return { supported: false, inputs: [] }; }

  if (!isObj(doc)) return { supported: false, inputs: [] };

  // `on:` can be a string, a list, or a map. Only a map (or a list containing
  // "workflow_dispatch") carries inputs.
  const on = doc["on"];
  const dispatchNode = extractDispatchNode(on);
  if (dispatchNode === null) return { supported: false, inputs: [] };

  const inputsNode = isObj(dispatchNode) ? dispatchNode["inputs"] : null;
  if (!isObj(inputsNode)) return { supported: true, inputs: [] };

  const inputs: DispatchInput[] = [];
  for (const [name, raw] of Object.entries(inputsNode)) {
    if (!isObj(raw)) continue;
    inputs.push({
      name,
      description: asStr(raw["description"]) ?? null,
      required: raw["required"] === true,
      default: raw["default"] != null ? String(raw["default"]) : null,
      type: asInputType(raw["type"]),
      options: Array.isArray(raw["options"]) ? raw["options"].map((o) => String(o)) : null,
    });
  }
  return { supported: true, inputs };
}

// --- helpers ---------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asInputType(v: unknown): DispatchInputType {
  if (v === "boolean") return "boolean";
  if (v === "choice") return "choice";
  if (v === "environment") return "environment";
  if (v === "number") return "number";
  return "string";
}

/**
 * Extract the `workflow_dispatch` sub-node from the workflow's `on:` field.
 *
 * Returns:
 *   - the node (object or `true`) if workflow_dispatch is configured;
 *   - `null` if not.
 *
 * Handles all three legal shapes of `on:`.
 */
function extractDispatchNode(on: unknown): Record<string, unknown> | true | null {
  if (typeof on === "string") return on === "workflow_dispatch" ? true : null;
  if (Array.isArray(on)) return on.includes("workflow_dispatch") ? true : null;
  if (isObj(on)) {
    if (!("workflow_dispatch" in on)) return null;
    const v = on["workflow_dispatch"];
    if (v === null) return true; // `workflow_dispatch:` with no body
    if (v === true) return true;
    if (isObj(v)) return v;
    return true;
  }
  return null;
}
