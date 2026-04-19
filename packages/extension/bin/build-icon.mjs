#!/usr/bin/env node
/**
 * Render packages/extension/icon.svg to icon.png at 256×256 (Marketplace
 * shows it at ~128px; rendering 2x gives crisp Retina display).
 *
 * One-shot script — run when the icon SVG changes:  pnpm icon
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const svg = readFileSync(resolve(root, "icon.svg"), "utf8");

const resvg = new Resvg(svg, {
  fitTo: { mode: "width", value: 256 },
  background: "rgba(0,0,0,0)",
});
const png = resvg.render().asPng();
writeFileSync(resolve(root, "icon.png"), png);
console.log(`wrote ${png.byteLength} bytes → ${resolve(root, "icon.png")}`);
