import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import dts from "vite-plugin-dts";

// https://vitejs.dev/config/
export default defineConfig({
  // Prepare the lazily loaded worker dependency at startup. Discovering it on
  // the first export otherwise makes Vite reload the page mid-download.
  optimizeDeps: { include: ['rhino3dm'] },
  plugins: [
    dts({
      insertTypesEntry: true,
    }),
    react({
      jsxImportSource: "@emotion/react",
      babel: {
        plugins: ["@emotion/babel-plugin"],
      },
    }),
  ],
  resolve: {
    alias: [{ find: "@", replacement: "/src" }],
  },
});
