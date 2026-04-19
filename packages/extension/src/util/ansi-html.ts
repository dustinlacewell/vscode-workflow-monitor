/**
 * Tiny ANSI SGR → HTML renderer.
 *
 * Consumes a string that may contain ANSI escape sequences and emits an
 * HTML-escaped string where colours and styles are expressed as <span>
 * elements carrying CSS classes we style in the webview. Non-SGR control
 * sequences (OSC, cursor movement, erase-in-line, etc.) are quietly stripped.
 *
 * Pure function with no DOM dependency so it can be unit-tested and shared
 * between the extension and the webview bundle.
 */

export interface AnsiStyle {
  readonly fg: string | null;
  readonly bg: string | null;
  readonly bold: boolean;
  readonly dim: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strike: boolean;
  readonly reverse: boolean;
}

export const EMPTY_STYLE: AnsiStyle = {
  fg: null, bg: null,
  bold: false, dim: false, italic: false, underline: false, strike: false, reverse: false,
};

// eslint-disable-next-line no-control-regex
const ESC = /\x1b(?:\[([0-?]*)[ -/]*([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

export function ansiToHtml(input: string, initial: AnsiStyle = EMPTY_STYLE): { html: string; finalStyle: AnsiStyle } {
  const out: string[] = [];
  let style = initial;
  let spanOpen = false;
  let cursor = 0;

  const flushPlain = (end: number) => {
    if (end <= cursor) return;
    const text = input.slice(cursor, end);
    const { open, close, body } = renderChunk(text, style);
    if (open && !spanOpen) { out.push(open); spanOpen = true; }
    else if (!open && spanOpen) { out.push(close); spanOpen = false; }
    else if (open && spanOpen) { out.push("</span>"); out.push(open); }
    out.push(body);
    cursor = end;
  };

  ESC.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ESC.exec(input)) !== null) {
    flushPlain(m.index);
    if (m[2] === "m") style = applySgr(style, m[1] ?? "");
    // Non-SGR sequences are stripped (no visible output).
    cursor = m.index + m[0].length;
  }
  flushPlain(input.length);
  if (spanOpen) out.push("</span>");
  return { html: out.join(""), finalStyle: style };
}

interface RenderedChunk { open: string; close: string; body: string }

function renderChunk(text: string, style: AnsiStyle): RenderedChunk {
  const classes = classesFor(style);
  const open = classes.length > 0 ? `<span class="${classes.join(" ")}">` : "";
  const close = classes.length > 0 ? "</span>" : "";
  return { open, close, body: escapeHtml(text) };
}

function classesFor(s: AnsiStyle): string[] {
  const cls: string[] = [];
  const fg = s.reverse ? s.bg : s.fg;
  const bg = s.reverse ? s.fg : s.bg;
  if (fg) cls.push(`ansi-fg-${fg}`);
  if (bg) cls.push(`ansi-bg-${bg}`);
  if (s.bold) cls.push("ansi-bold");
  if (s.dim) cls.push("ansi-dim");
  if (s.italic) cls.push("ansi-italic");
  if (s.underline) cls.push("ansi-underline");
  if (s.strike) cls.push("ansi-strike");
  return cls;
}

function applySgr(prev: AnsiStyle, params: string): AnsiStyle {
  if (params === "") return { ...EMPTY_STYLE };
  const codes = params.split(";").map((p) => Number.parseInt(p, 10) || 0);
  let s: AnsiStyle = { ...prev };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!;
    if (c === 0) { s = { ...EMPTY_STYLE }; continue; }
    if (c === 1) { s = { ...s, bold: true }; continue; }
    if (c === 2) { s = { ...s, dim: true }; continue; }
    if (c === 3) { s = { ...s, italic: true }; continue; }
    if (c === 4) { s = { ...s, underline: true }; continue; }
    if (c === 7) { s = { ...s, reverse: true }; continue; }
    if (c === 9) { s = { ...s, strike: true }; continue; }
    if (c === 22) { s = { ...s, bold: false, dim: false }; continue; }
    if (c === 23) { s = { ...s, italic: false }; continue; }
    if (c === 24) { s = { ...s, underline: false }; continue; }
    if (c === 27) { s = { ...s, reverse: false }; continue; }
    if (c === 29) { s = { ...s, strike: false }; continue; }
    if (c === 39) { s = { ...s, fg: null }; continue; }
    if (c === 49) { s = { ...s, bg: null }; continue; }
    if (c >= 30 && c <= 37) { s = { ...s, fg: BASIC_COLORS[c - 30]! }; continue; }
    if (c >= 40 && c <= 47) { s = { ...s, bg: BASIC_COLORS[c - 40]! }; continue; }
    if (c >= 90 && c <= 97) { s = { ...s, fg: BRIGHT_COLORS[c - 90]! }; continue; }
    if (c >= 100 && c <= 107) { s = { ...s, bg: BRIGHT_COLORS[c - 100]! }; continue; }
    if (c === 38 || c === 48) {
      const mode = codes[i + 1];
      if (mode === 5 && codes[i + 2] !== undefined) {
        const token = `256-${codes[i + 2]}`;
        s = c === 38 ? { ...s, fg: token } : { ...s, bg: token };
        i += 2;
      } else if (mode === 2 && codes.length >= i + 4) {
        const token = `rgb-${codes[i + 2]}-${codes[i + 3]}-${codes[i + 4]}`;
        s = c === 38 ? { ...s, fg: token } : { ...s, bg: token };
        i += 4;
      }
      continue;
    }
    // Unknown code: ignore.
  }
  return s;
}

const BASIC_COLORS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;
const BRIGHT_COLORS = [
  "bright-black", "bright-red", "bright-green", "bright-yellow",
  "bright-blue", "bright-magenta", "bright-cyan", "bright-white",
] as const;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return ch;
    }
  });
}
