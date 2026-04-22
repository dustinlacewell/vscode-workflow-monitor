import { z } from "zod";
import { defineTrait } from "@ldlework/workmark/define";

/** Projects with a build step. */
export const buildable = defineTrait({
  name: "buildable",
  schema: z.object({
    command: z.string().default("pnpm build"),
    timeout: z.number().default(180_000),
  }).default({}),
});
