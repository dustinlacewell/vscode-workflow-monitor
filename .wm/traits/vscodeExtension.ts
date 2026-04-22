import { z } from "zod";
import { defineTrait } from "@ldlework/workmark/define";

/** Projects that are VS Code extensions (vsce packaging + install). */
export const vscodeExtension = defineTrait({
  name: "vscodeExtension",
  schema: z.object({
    publisher: z.string(),
    packageCommand: z.string().default("pnpm package"),
    installCommand: z.string().default("pnpm install:ext"),
    timeout: z.number().default(240_000),
  }),
});
