import { z } from "zod";
import { defineTrait } from "@ldlework/workmark/define";

/** Projects that publish somewhere. */
export const publishable = defineTrait({
  name: "publishable",
  schema: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("npm"),
      npmName: z.string(),
      access: z.enum(["public", "restricted"]).default("public"),
    }),
    z.object({
      kind: z.literal("vsce"),
      publisher: z.string(),
    }),
    z.object({
      kind: z.literal("pages"),
      url: z.string().optional(),
    }),
  ]),
});
