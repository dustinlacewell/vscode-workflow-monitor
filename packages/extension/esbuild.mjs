import { build, context } from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const extensionOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

/** @type {import("esbuild").BuildOptions} */
const webviewOptions = {
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  outfile: "dist/webview.js",
  platform: "browser",
  target: "es2020",
  format: "iife",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

if (watch) {
  const ctxExt = await context(extensionOptions);
  const ctxWeb = await context(webviewOptions);
  await Promise.all([ctxExt.watch(), ctxWeb.watch()]);
} else {
  await Promise.all([build(extensionOptions), build(webviewOptions)]);
}
