import { cmd } from "@ldlework/workmark/define";
import { buildable } from "../traits/buildable.js";

/** Build one, many, or all buildable projects. */
export default cmd({
  needs: [buildable],
  handler: (_, { traits, sh }) =>
    sh(traits.buildable.command, { timeout: traits.buildable.timeout }),
});
