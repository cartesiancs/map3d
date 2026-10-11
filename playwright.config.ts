import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 60000,
  // Allow paced background requests and software-rendered 3D to settle on CI.
  expect: { timeout: 15000 },
  use: {
    baseURL: "http://127.0.0.1:5179",
    viewport: { width: 1280, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
  webServer: {
    command: process.env.PLAYWRIGHT_PREVIEW === '1' ? "npm run preview -- --host 127.0.0.1 --port 5179" : "VITE_MAP_DATA_TRANSPORT=direct npm run dev -- --host 127.0.0.1 --port 5179",
    url: "http://127.0.0.1:5179",
    reuseExistingServer: false,
  },
});
