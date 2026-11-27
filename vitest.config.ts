// Unit tests (npm test): the mesh engine and the shared building rules, in Node. The app's vite.config.ts
// (declaration files, React) is not needed for them.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
