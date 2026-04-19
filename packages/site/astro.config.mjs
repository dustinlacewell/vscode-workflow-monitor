import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://workflows.ldlework.com",
  vite: {
    plugins: [tailwindcss()],
  },
});
