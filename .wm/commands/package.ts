import { cmd } from "@ldlework/workmark/define";
import { vscodeExtension } from "../traits/vscodeExtension.js";

/** Build + package the VS Code extension into a .vsix. */
export default cmd({
  needs: [vscodeExtension],
  select: "one",
  handler: (_, { traits, sh }) =>
    sh(traits.vscodeExtension.packageCommand, {
      timeout: traits.vscodeExtension.timeout,
    }),
});
