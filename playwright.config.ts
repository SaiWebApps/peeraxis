import path from "node:path";
import { defineConfig } from "@playwright/test";

// Used only by scripts/acceptance.sh, which starts a seeded engine and sets these.
const spec = process.env.PEERAXIS_DEMO_SPEC;
const output = process.env.PEERAXIS_DEMO_OUTPUT;
const port = process.env.PEERAXIS_PORT;
if (!spec || !output || !port) throw new Error("Run through scripts/acceptance.sh");
const specPath = path.resolve(import.meta.dirname, spec);

export default defineConfig({
  testDir: path.dirname(specPath),
  testMatch: path.basename(specPath),
  outputDir: path.join(output, "test-results"),
  retries: 0,
  workers: 1,
  timeout: 60_000,
  reporter: [["list"], ["json", { outputFile: path.join(output, "report.json") }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1280, height: 860 },
    headless: true,
    video: "on",
    screenshot: "on",
  },
});
