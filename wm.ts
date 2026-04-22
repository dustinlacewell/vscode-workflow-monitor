import { defineProject } from "@ldlework/workmark/define";

export default [
  defineProject({
    name: "extension",
    dir: "packages/extension",
    tags: ["extension"],
    description: "VS Code Workflow Monitor extension",
    has: {
      buildable: { command: "pnpm build" },
      vscodeExtension: { publisher: "ldlework" },
      publishable: { kind: "vsce", publisher: "ldlework" },
    },
  }),
  defineProject({
    name: "site",
    dir: "packages/site",
    tags: ["site"],
    description: "Marketing site",
    has: {
      buildable: { command: "pnpm build" },
      publishable: { kind: "pages" },
    },
  }),
];
