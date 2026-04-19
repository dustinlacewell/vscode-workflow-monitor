export const STYLES = /* css */ `
/* :root matches <html> in the extension's webview page; :host matches the
   shadow host when these styles are loaded inside a shadow DOM (the docs-site
   preview). The union makes the rule apply in either context. */
:host, :root {
  --sev-error: var(--vscode-errorForeground, #f48771);
  --sev-warning: var(--vscode-editorWarning-foreground, #cca700);
  --sev-notice: var(--vscode-editorInfo-foreground, #75beff);
  --sev-success: var(--vscode-testing-iconPassed, #73c991);
  --sev-running: var(--vscode-progressBar-background, #0e70c0);
  --sev-neutral: var(--vscode-descriptionForeground, #969696);
}

/* :host matches inside a shadow root; html/body match in the extension's
   webview page. Both paths need the editor background or the shadow content
   falls back to whatever's underneath the host element. */
html, body, :host {
  margin: 0;
  padding: 0;
  height: 100%;
  overflow: hidden;
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 13px);
}

/* 100% (not 100vh) so the app fills its container in both contexts: the
   extension's webview window, and the site preview's shadow host. */
#app {
  display: flex;
  flex-direction: column;
  height: 100%;
}

header.header {
  flex: 0 0 auto;
  padding: 10px 16px;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
  background: var(--vscode-sideBar-background, transparent);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
}

header .title { font-weight: 600; font-size: 1.05em; }
header .subtitle { opacity: 0.75; font-size: 0.9em; margin-top: 2px; }
header .status { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
header .status.running .dot { background: var(--sev-running); animation: pulse 1.2s infinite; }
header .status.success .dot { background: var(--sev-success); }
header .status.failure .dot { background: var(--sev-error); }
header .status.neutral .dot { background: var(--sev-neutral); }
header .dot { width: 10px; height: 10px; border-radius: 50%; flex: 0 0 auto; }
header .actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
/* Ghost buttons — no neutral box, only a hover tint. Matches how the
   real extension renders these in typical VS Code themes. */
header .actions button {
  background: transparent;
  color: inherit;
  border: 0;
  padding: 4px 10px;
  border-radius: 4px;
  font: inherit;
  cursor: pointer;
}
header .actions button:hover {
  background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.15));
}

main#sections {
  flex: 1 1 auto;
  overflow-y: auto;
  overflow-x: hidden;
  scroll-behavior: smooth;
  padding: 0 0 16px 0;
}

/* One continuous vertical rail runs down every section. Step dots and
   sub-group dots both sit on this same line; folding a body doesn't break
   the rail because it's the section itself that carries it. */
.section {
  position: relative;
}

.section::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 20px;
  width: 2px;
  background: var(--vscode-panel-border, rgba(128,128,128,0.45));
  z-index: 0;
}

.section > summary {
  list-style: none;
  cursor: pointer;
  /* padding-left picked so the 12px step dot's left edge lands at x=15,
     putting its center at x=21 — dead-centre of the 2px rail at left:20. */
  padding: 3px 16px 3px 15px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--vscode-font-family);
  font-size: 0.95em;
  position: sticky;
  top: 0;
  background: var(--vscode-editor-background);
  z-index: 2;
}
/* --vscode-list-hoverBackground is translucent in most themes, which makes
   the sticky summary read-through while hovered. Layer the tint over the
   solid editor background so the sticky header stays opaque. */
.section > summary:hover {
  background-color: var(--vscode-editor-background);
  background-image: linear-gradient(
    var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.08)),
    var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.08))
  );
}
.section > summary::-webkit-details-marker { display: none; }

.section .icon {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  display: inline-block;
  flex: 0 0 auto;
  position: relative;
  z-index: 1;
}
.section[data-status="success"] .icon { background: var(--sev-success); }
.section[data-status="failure"] .icon { background: var(--sev-error); }
.section[data-status="running"] .icon { background: var(--sev-running); animation: pulse 1.2s infinite; }
.section[data-status="skipped"] .icon { background: var(--sev-neutral); opacity: 0.5; }
.section[data-status="cancelled"] .icon { background: var(--sev-neutral); }
.section[data-status="pending"] .icon {
  border: 1.5px solid var(--sev-neutral);
  background: var(--vscode-editor-background);
  /* Inset slightly so the border doesn't push the box larger than the rail-dot alignment assumes. */
  box-sizing: border-box;
}
.section[data-status="neutral"] .icon { background: var(--sev-neutral); opacity: 0.65; }
.section[data-status="unknown"] .icon {
  background: var(--vscode-editor-background);
  border: 1.5px dashed var(--sev-neutral);
  box-sizing: border-box;
}

.section .title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.section .title .meta-step {
  opacity: 0.55;
  margin-right: 4px;
  font-variant-numeric: tabular-nums;
}
.section .badges {
  flex: 0 0 auto;
  display: flex;
  gap: 10px;
  font-size: 0.82em;
  opacity: 0.9;
}
.section .duration {
  flex: 0 0 auto;
  font-family: var(--vscode-editor-font-family, ui-monospace, Consolas, monospace);
  font-size: 0.82em;
  opacity: 0.6;
  font-variant-numeric: tabular-nums;
}
.section .badge-error { color: var(--sev-error); }
.section .badge-warning { color: var(--sev-warning); }

.section .body {
  margin: 0;
  /* padding-left chosen so text clears the rail; sub-dots are pulled left by
     a negative margin to land back on the rail. */
  padding: 4px 16px 10px 36px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--vscode-editor-font-family, ui-monospace, Menlo, Consolas, monospace);
  font-size: 0.95em;
  line-height: 1.4;
  color: var(--vscode-editor-foreground);
}

.log-subheader {
  display: flex;
  align-items: center;
  gap: 8px;
  /* body padding-left = 36; subheader margin-left = -20 puts first child
     (the dot) at x=16. Dot width 10 → center x=21 — same rail line as
     the step dots above. */
  margin: 8px 0 4px -20px;
  padding-left: 0;
  font-family: var(--vscode-font-family);
  font-size: 0.82em;
  font-weight: 600;
  color: var(--vscode-descriptionForeground, #9d9d9d);
  letter-spacing: 0.02em;
}
.log-subheader:first-child { margin-top: 2px; }

.log-subheader .sub-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: currentColor;
  flex: 0 0 auto;
  margin-left: 0;
  position: relative;
  z-index: 1;
}

.log-subheader .sub-name { white-space: nowrap; }

/* Callouts for ##[error|warning|notice] lines. Left border + icon + tint
   makes them stand out without stealing the whole row like a full banner. */
.log-callout {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin: 4px 0;
  padding: 6px 10px 6px 8px;
  border-left: 3px solid;
  border-radius: 2px;
  font-family: var(--vscode-font-family);
  font-size: 0.88em;
  line-height: 1.45;
}
.log-callout[data-sev="error"] {
  border-left-color: var(--sev-error);
  background: color-mix(in srgb, var(--sev-error) 10%, transparent);
  color: var(--sev-error);
}
.log-callout[data-sev="warning"] {
  border-left-color: var(--sev-warning);
  background: color-mix(in srgb, var(--sev-warning) 10%, transparent);
  color: var(--sev-warning);
}
.log-callout[data-sev="notice"] {
  border-left-color: var(--sev-notice);
  background: color-mix(in srgb, var(--sev-notice) 10%, transparent);
  color: var(--sev-notice);
}
.log-callout .callout-icon {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 0.9em;
  line-height: 1;
  margin-top: 1px;
}
.log-callout[data-sev="error"] .callout-icon::before { content: "\\2715"; }
.log-callout[data-sev="warning"] .callout-icon::before { content: "\\26A0"; }
.log-callout[data-sev="notice"] .callout-icon::before { content: "\\2139"; }
.log-callout .callout-body {
  flex: 1 1 auto;
  color: var(--vscode-editor-foreground);
  font-family: var(--vscode-editor-font-family, ui-monospace, Consolas, monospace);
  word-break: break-word;
  white-space: pre-wrap;
}

.ansi-bold { font-weight: bold; }
.ansi-dim { opacity: 0.6; }
.ansi-italic { font-style: italic; }
.ansi-underline { text-decoration: underline; }
.ansi-strike { text-decoration: line-through; }

.ansi-fg-black { color: var(--vscode-terminal-ansiBlack, #000); }
.ansi-fg-red { color: var(--vscode-terminal-ansiRed, #cd3131); }
.ansi-fg-green { color: var(--vscode-terminal-ansiGreen, #0dbc79); }
.ansi-fg-yellow { color: var(--vscode-terminal-ansiYellow, #e5e510); }
.ansi-fg-blue { color: var(--vscode-terminal-ansiBlue, #2472c8); }
.ansi-fg-magenta { color: var(--vscode-terminal-ansiMagenta, #bc3fbc); }
.ansi-fg-cyan { color: var(--vscode-terminal-ansiCyan, #11a8cd); }
.ansi-fg-white { color: var(--vscode-terminal-ansiWhite, #e5e5e5); }
.ansi-fg-bright-black { color: var(--vscode-terminal-ansiBrightBlack, #666); }
.ansi-fg-bright-red { color: var(--vscode-terminal-ansiBrightRed, #f14c4c); }
.ansi-fg-bright-green { color: var(--vscode-terminal-ansiBrightGreen, #23d18b); }
.ansi-fg-bright-yellow { color: var(--vscode-terminal-ansiBrightYellow, #f5f543); }
.ansi-fg-bright-blue { color: var(--vscode-terminal-ansiBrightBlue, #3b8eea); }
.ansi-fg-bright-magenta { color: var(--vscode-terminal-ansiBrightMagenta, #d670d6); }
.ansi-fg-bright-cyan { color: var(--vscode-terminal-ansiBrightCyan, #29b8db); }
.ansi-fg-bright-white { color: var(--vscode-terminal-ansiBrightWhite, #fff); }

.ansi-bg-black { background: var(--vscode-terminal-ansiBlack, #000); }
.ansi-bg-red { background: var(--vscode-terminal-ansiRed, #cd3131); }
.ansi-bg-green { background: var(--vscode-terminal-ansiGreen, #0dbc79); }
.ansi-bg-yellow { background: var(--vscode-terminal-ansiYellow, #e5e510); }
.ansi-bg-blue { background: var(--vscode-terminal-ansiBlue, #2472c8); }
.ansi-bg-magenta { background: var(--vscode-terminal-ansiMagenta, #bc3fbc); }
.ansi-bg-cyan { background: var(--vscode-terminal-ansiCyan, #11a8cd); }
.ansi-bg-white { background: var(--vscode-terminal-ansiWhite, #e5e5e5); }

footer {
  flex: 0 0 auto;
  padding: 6px 16px;
  border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
  font-size: 0.85em;
  opacity: 0.75;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-family: var(--vscode-font-family);
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
`;
