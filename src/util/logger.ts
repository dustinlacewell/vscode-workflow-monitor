import * as vscode from "vscode";

export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, err?: unknown, ...args: unknown[]): void;
  dispose(): void;
}

export function createLogger(name: string): Logger {
  const channel = vscode.window.createOutputChannel(name, { log: true });
  const fmt = (args: unknown[]): string =>
    args.length === 0
      ? ""
      : " " +
        args
          .map((a) => {
            if (a instanceof Error) return a.stack ?? a.message;
            if (typeof a === "object") {
              try { return JSON.stringify(a); } catch { return String(a); }
            }
            return String(a);
          })
          .join(" ");

  return {
    info: (m, ...a) => channel.info(m + fmt(a)),
    warn: (m, ...a) => channel.warn(m + fmt(a)),
    error: (m, err, ...a) => {
      const suffix = err === undefined ? fmt(a) : fmt([err, ...a]);
      channel.error(m + suffix);
    },
    dispose: () => channel.dispose(),
  };
}
