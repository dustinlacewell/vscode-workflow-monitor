import { cmd } from "@ldlework/workmark/define";
import { vscodeExtension } from "../traits/vscodeExtension.js";

/** Build, package, and install the VS Code extension into the local editor. */
export default cmd({
  needs: [vscodeExtension],
  select: "one",
  handler: (_, { traits, sh }) =>
    sh(traits.vscodeExtension.installCommand, {
      timeout: traits.vscodeExtension.timeout,
    }),
});
