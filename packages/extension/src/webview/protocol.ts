/**
 * Message protocol between the extension host and the log webview.
 *
 * Both sides depend on this module — extension imports from services/ and
 * ui/ code, the webview bundle imports from webview/main.ts. Keeping the
 * shapes serialisation-safe (plain JSON) means postMessage round-trips
 * don't surprise us with Date objects, Maps, etc.
 */

import type { EnrichedSection } from "../util/log-sections.js";

export interface HeaderModel {
  readonly ownerRepo: string;
  readonly workflowName: string;
  readonly runNumber: number;
  readonly jobName: string;
  readonly jobStatus: string;
  readonly jobConclusion: string | null;
  readonly branch: string | null;
  readonly sha: string;
  readonly htmlUrl: string;
  readonly actor: string | null;
}

export interface LogSnapshot {
  readonly header: HeaderModel;
  readonly sections: ReadonlyArray<EnrichedSection>;
  readonly isTailing: boolean;
  readonly generation: number;
}

export interface FocusRequest {
  readonly sectionId: string | null;
  /** When true, fold all other sections. Job click = true; step click = true; passive refresh = false. */
  readonly foldOthers: boolean;
}

export type ExtensionToWebview =
  | { readonly type: "snapshot"; readonly snapshot: LogSnapshot; readonly focus?: FocusRequest }
  | { readonly type: "focus"; readonly focus: FocusRequest }
  | { readonly type: "error"; readonly message: string };

export type WebviewToExtension =
  | { readonly type: "ready" }
  | { readonly type: "openExternal"; readonly url: string }
  | { readonly type: "copyLog" }
  | { readonly type: "copyFailureContext" };
