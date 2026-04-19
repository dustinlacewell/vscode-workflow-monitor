/**
 * Strip ANSI SGR escape sequences and other terminal control bytes from a
 * string. GitHub Actions logs are heavily colorized; for clipboard paste and
 * text-document display we want clean text.
 *
 * Covers:
 *   - CSI sequences: ESC [ ... final byte
 *   - OSC sequences: ESC ] ... BEL  OR  ESC ] ... ESC \
 *   - Other 2-byte ESC sequences (ESC c, ESC 7, etc.)
 */
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, "");
}

/**
 * GitHub prefixes every log line with an ISO8601 timestamp followed by a
 * space. Stripping it makes log excerpts dramatically more readable and
 * cheaper to paste into an LLM.
 */
const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s/;

export function stripTimestamp(line: string): string {
  return line.replace(TIMESTAMP_PREFIX, "");
}

export function cleanLogForPaste(input: string): string {
  return stripAnsi(input)
    .split(/\r?\n/)
    .map(stripTimestamp)
    .join("\n");
}
