import { ansiToHtml, escapeHtml } from "../util/ansi-html.js";
import type { EnrichedSection, SectionStatus } from "../util/log-sections.js";
import type {
  ExtensionToWebview,
  FocusRequest,
  HeaderModel,
  LogSnapshot,
  WebviewToExtension,
} from "./protocol.js";

/**
 * Webview entry point. Owns DOM orchestration only:
 *   - `Header` renders the metadata strip + action buttons;
 *   - `SectionList` reconciles the sections container against incoming
 *     snapshots, preserving each section's folded/expanded state across
 *     re-renders (user fold choices are never clobbered by a tail tick);
 *   - `ScrollFollower` keeps the view pinned to the bottom while the user
 *     hasn't scrolled up — the same "follow tail" behavior terminals have.
 *
 * Pure presentation. All parsing, matching, and status derivation happens
 * extension-side — the webview just renders the view model it's handed.
 */

declare const acquireVsCodeApi: () => {
  postMessage: (msg: WebviewToExtension) => void;
  setState: (state: unknown) => void;
  getState: () => unknown;
};

export type WebviewRoot = Document | ShadowRoot;

class Header {
  private readonly el: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly subtitleEl: HTMLElement;
  private readonly statusEl: HTMLElement;

  constructor(root: HTMLElement) {
    this.el = root;
    this.el.innerHTML = `
      <div class="title"></div>
      <div class="subtitle"></div>
      <div class="status"><span class="dot"></span><span class="status-text"></span></div>
      <div class="actions">
        <button data-action="fold-passing" title="Fold successful sections">Fold passing</button>
        <button data-action="fold-all">Fold all</button>
        <button data-action="unfold-all">Unfold all</button>
        <button data-action="copy-log">Copy log</button>
        <button data-action="copy-failure">Copy failure context</button>
        <button data-action="open-github" title="Open run page on GitHub">Open on GitHub</button>
      </div>
    `;
    this.titleEl = this.el.querySelector(".title")!;
    this.subtitleEl = this.el.querySelector(".subtitle")!;
    this.statusEl = this.el.querySelector(".status")!;
  }

  /** Returns a button element by its data-action tag so the controller can wire it. */
  button(action: string): HTMLButtonElement {
    const b = this.el.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
    if (!b) throw new Error(`missing button: ${action}`);
    return b;
  }

  update(h: HeaderModel, isTailing: boolean): void {
    this.titleEl.textContent = `${h.ownerRepo} · ${h.workflowName} · run #${h.runNumber}`;
    const parts = [h.jobName];
    if (h.branch) parts.push(`${h.branch} @ ${h.sha}`);
    if (h.actor) parts.push(`by ${h.actor}`);
    this.subtitleEl.textContent = parts.join(" · ");
    const statusLabel = h.jobStatus === "completed" && h.jobConclusion
      ? `${h.jobConclusion}`
      : h.jobStatus + (isTailing ? " · tailing" : "");
    this.statusEl.className = `status ${statusPhase(h.jobStatus, h.jobConclusion)}`;
    this.statusEl.querySelector(".status-text")!.textContent = statusLabel;
  }
}

class SectionNode {
  readonly details: HTMLDetailsElement;
  private readonly summary: HTMLElement;
  private readonly body: HTMLElement;
  private renderedRaw = "";
  private currentRaw = "";

  constructor(id: string) {
    this.details = document.createElement("details");
    this.details.className = "section";
    this.details.id = id;
    this.summary = document.createElement("summary");
    this.body = document.createElement("pre");
    this.body.className = "body";
    this.details.append(this.summary, this.body);
    // Lazy-render body on first open / when raw changes while open.
    this.details.addEventListener("toggle", () => {
      if (this.details.open && this.renderedRaw !== this.currentRaw) {
        this.body.innerHTML = renderBody(this.currentRaw);
        this.renderedRaw = this.currentRaw;
      }
    });
  }

  update(s: EnrichedSection): void {
    this.summary.innerHTML = renderSummary(s);
    this.details.dataset.status = s.status;
    this.currentRaw = s.raw;
    if (this.details.open && this.renderedRaw !== s.raw) {
      this.body.innerHTML = renderBody(s.raw);
      this.renderedRaw = s.raw;
    }
  }

  setOpen(open: boolean): void {
    if (this.details.open === open) return;
    this.details.open = open;
    if (open && this.renderedRaw !== this.currentRaw) {
      this.body.innerHTML = renderBody(this.currentRaw);
      this.renderedRaw = this.currentRaw;
    }
  }
}

class SectionList {
  private readonly nodes = new Map<string, SectionNode>();

  constructor(private readonly container: HTMLElement) {}

  reconcile(sections: readonly EnrichedSection[]): void {
    const seen = new Set<string>();
    for (const [i, s] of sections.entries()) {
      seen.add(s.id);
      let node = this.nodes.get(s.id);
      if (!node) {
        node = new SectionNode(s.id);
        this.nodes.set(s.id, node);
        const anchor = this.container.children[i] ?? null;
        this.container.insertBefore(node.details, anchor);
      } else if (this.container.children[i] !== node.details) {
        this.container.insertBefore(node.details, this.container.children[i] ?? null);
      }
      node.update(s);
    }
    // Remove any sections the server no longer has (unusual but possible).
    for (const [id, node] of [...this.nodes]) {
      if (seen.has(id)) continue;
      node.details.remove();
      this.nodes.delete(id);
    }
  }

  foldAll(): void { for (const n of this.nodes.values()) n.setOpen(false); }
  unfoldAll(): void { for (const n of this.nodes.values()) n.setOpen(true); }

  foldPassing(sections: readonly EnrichedSection[]): void {
    for (const s of sections) {
      const node = this.nodes.get(s.id);
      if (!node) continue;
      const keepOpen = s.status === "failure" || s.status === "running" || s.severities.includes("error");
      node.setOpen(keepOpen);
    }
  }

  applyFocus(focus: FocusRequest): void {
    if (focus.foldOthers) this.foldAll();
    if (!focus.sectionId) return;
    const node = this.nodes.get(focus.sectionId);
    if (!node) return;
    node.setOpen(true);
    // `scrollIntoView` on the details element puts its summary at the top of
    // the viewport, which is what the user expects after clicking a step.
    requestAnimationFrame(() => node.details.scrollIntoView({ block: "start", behavior: "auto" }));
  }

  get orderedNodes(): SectionNode[] {
    return Array.from(this.container.querySelectorAll<HTMLDetailsElement>("details.section"))
      .map((el) => this.nodes.get(el.id))
      .filter((n): n is SectionNode => !!n);
  }
}

class ScrollFollower {
  private atBottom = true;
  private readonly threshold = 64;

  constructor(private readonly container: HTMLElement) {
    container.addEventListener("scroll", () => {
      this.atBottom =
        container.scrollTop + container.clientHeight >= container.scrollHeight - this.threshold;
    });
  }

  beforeUpdate(): void {
    this.atBottom =
      this.container.scrollTop + this.container.clientHeight >= this.container.scrollHeight - this.threshold;
  }

  afterUpdate(tailing: boolean): void {
    if (tailing && this.atBottom) {
      this.container.scrollTop = this.container.scrollHeight;
    }
  }
}

export class LogViewController {
  private readonly header: Header;
  private readonly sections: SectionList;
  private readonly scroller: ScrollFollower;
  private readonly footer: HTMLElement;
  private readonly vscode: ReturnType<typeof acquireVsCodeApi>;
  private lastSnapshot: LogSnapshot | null = null;
  private githubUrl = "";

  /**
   * `root` is whatever ParentNode contains the webview markup — `document`
   * for the real extension webview, a `ShadowRoot` for the docs-site preview.
   * Keeping DOM queries root-relative is the only accommodation the controller
   * needs to run in both environments.
   */
  constructor(root: WebviewRoot) {
    const app = root.querySelector("#app");
    if (!app) throw new Error("webview: #app element not found in root");
    this.header = new Header(app.querySelector("header.header")!);
    const sectionsEl = app.querySelector("main#sections") as HTMLElement;
    this.sections = new SectionList(sectionsEl);
    this.scroller = new ScrollFollower(sectionsEl);
    this.footer = app.querySelector("footer") as HTMLElement;
    this.vscode = acquireVsCodeApi();

    this.header.button("open-github").addEventListener("click", () => {
      if (this.githubUrl) this.post({ type: "openExternal", url: this.githubUrl });
    });
    this.header.button("fold-all").addEventListener("click", () => this.sections.foldAll());
    this.header.button("unfold-all").addEventListener("click", () => this.sections.unfoldAll());
    this.header.button("copy-log").addEventListener("click", () => this.post({ type: "copyLog" }));
    this.header.button("copy-failure").addEventListener("click", () => this.post({ type: "copyFailureContext" }));
    this.header.button("fold-passing").addEventListener("click", () => {
      if (this.lastSnapshot) this.sections.foldPassing(this.lastSnapshot.sections);
    });

    window.addEventListener("message", (e) => this.onMessage(e.data as ExtensionToWebview));
    // Scope keyboard nav to the root — the extension's webview-iframe window
    // is isolated anyway, but on the docs site we don't want N/P hijacks.
    (root as unknown as EventTarget).addEventListener("keydown", (e) => this.onKey(e as KeyboardEvent));
  }

  start(): void { this.post({ type: "ready" }); }

  private post(msg: WebviewToExtension): void { this.vscode.postMessage(msg); }

  private onMessage(msg: ExtensionToWebview): void {
    switch (msg.type) {
      case "snapshot":
        this.applySnapshot(msg.snapshot);
        if (msg.focus) this.sections.applyFocus(msg.focus);
        return;
      case "focus":
        this.sections.applyFocus(msg.focus);
        return;
      case "error":
        this.footer.textContent = `⚠ ${msg.message}`;
        return;
    }
  }

  private applySnapshot(snap: LogSnapshot): void {
    this.scroller.beforeUpdate();
    this.header.update(snap.header, snap.isTailing);
    this.githubUrl = snap.header.htmlUrl;
    this.sections.reconcile(snap.sections);
    this.lastSnapshot = snap;
    const errorCount = snap.sections.reduce((acc, s) => acc + (s.severities.includes("error") ? 1 : 0), 0);
    const warnCount = snap.sections.reduce((acc, s) => acc + (s.severities.includes("warning") ? 1 : 0), 0);
    const footerParts = [`${snap.sections.length} sections`];
    if (errorCount > 0) footerParts.push(`${errorCount} error section${errorCount === 1 ? "" : "s"}`);
    if (warnCount > 0) footerParts.push(`${warnCount} warning section${warnCount === 1 ? "" : "s"}`);
    if (snap.isTailing) footerParts.push("tailing live");
    this.footer.textContent = footerParts.join(" · ");
    this.scroller.afterUpdate(snap.isTailing);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === "n" || e.key === "N") { this.jumpSection(1); e.preventDefault(); return; }
    if (e.key === "p" || e.key === "P") { this.jumpSection(-1); e.preventDefault(); return; }
    if (e.key === "f" && (e.ctrlKey || e.metaKey)) return; // let find passthrough
  }

  private jumpSection(delta: number): void {
    if (!this.lastSnapshot) return;
    const sections = this.lastSnapshot.sections;
    if (sections.length === 0) return;
    const current = findFirstVisible(this.sections.orderedNodes.map((n) => n.details));
    const idx = current === -1 ? 0 : Math.min(Math.max(current + delta, 0), sections.length - 1);
    const target = sections[idx]!;
    this.sections.applyFocus({ sectionId: target.id, foldOthers: false });
  }
}

function findFirstVisible(elements: readonly HTMLElement[]): number {
  for (let i = 0; i < elements.length; i++) {
    const rect = elements[i]!.getBoundingClientRect();
    if (rect.bottom > 0) return i;
  }
  return -1;
}

function renderSummary(s: EnrichedSection): string {
  const stepTag = s.stepNumber !== null ? `<span class="meta-step">${s.stepNumber}.</span>` : "";
  const errCount = s.severities.filter((k) => k === "error").length;
  const warnCount = s.severities.filter((k) => k === "warning").length;
  const badges: string[] = [];
  if (errCount > 0) badges.push(`<span class="badge-error">${errCount} error${errCount === 1 ? "" : "s"}</span>`);
  if (warnCount > 0) badges.push(`<span class="badge-warning">${warnCount} warning${warnCount === 1 ? "" : "s"}</span>`);
  const badgesHtml = badges.length > 0 ? `<span class="badges">${badges.join("")}</span>` : "";
  const durationHtml = s.durationMs !== null
    ? `<span class="duration">${humanDuration(s.durationMs)}</span>`
    : "";
  return `
    <span class="icon" aria-label="${s.status}"></span>
    <span class="title">${stepTag}${escapeHtml(s.name)}</span>
    ${badgesHtml}
    ${durationHtml}
  `;
}

function renderBody(raw: string): string {
  if (raw.length === 0) return `<span class="ansi-dim">(no output)</span>`;
  const lines = raw.split(/\r?\n/);
  const rendered: string[] = [];
  for (const line of lines) {
    const sub = SUBGROUP_MARKER.exec(line);
    if (sub) {
      const name = (sub[1] ?? "").trim();
      rendered.push(`<div class="log-subheader"><span class="sub-dot"></span><span class="sub-name">${escapeHtml(name)}</span></div>`);
      continue;
    }
    const callout = CALLOUT_MARKER.exec(line);
    if (callout) {
      const sev = callout[1]!;
      const body = (callout[2] ?? "").trim();
      const { html } = ansiToHtml(body);
      rendered.push(`<div class="log-callout" data-sev="${sev}"><span class="callout-icon" aria-hidden="true"></span><span class="callout-body">${html || escapeHtml(body)}</span></div>`);
      continue;
    }
    const { html } = ansiToHtml(line);
    rendered.push(`<div class="log-line">${html || "&nbsp;"}</div>`);
  }
  return rendered.join("");
}

// Step-aware merging in the extension re-inserts `##[group]NAME` for sub-groups
// that don't match a step; here we recognize that sentinel and render it as an
// inline road marker instead of a collapsible.
const SUBGROUP_MARKER = /^##\[group\](.*)$/;
// Severity markers get promoted to callouts (bordered/tinted boxes) instead of
// being plain colored lines buried in the log stream.
const CALLOUT_MARKER = /^##\[(error|warning|notice)\](.*)$/;

function humanDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m${rem.toString().padStart(2, "0")}s`;
}

function statusPhase(jobStatus: string, conclusion: string | null): SectionStatus {
  if (jobStatus === "completed") {
    switch (conclusion) {
      case "success": return "success";
      case "failure":
      case "timed_out":
      case "startup_failure": return "failure";
      case "cancelled": return "cancelled";
      case "skipped": return "skipped";
      default: return "neutral";
    }
  }
  if (jobStatus === "in_progress") return "running";
  return "neutral";
}

/**
 * Construct and start the controller for the given root. Exported so the
 * docs-site preview can mount into a shadow root; the extension's bundle
 * entry (main.ts) calls this with `document`.
 */
export function mount(root: WebviewRoot = document): LogViewController {
  const controller = new LogViewController(root);
  controller.start();
  return controller;
}
