import { defineConfig } from "@playwright/test";

import base from "./playwright.config";

/**
 * The same suite as playwright.config.ts, but fully isolated: its own port and
 * its own build folder, and it never reuses a server that is already running.
 *
 * The default config reuses whatever answers on :3000, which is convenient and
 * wrong whenever a `next dev` is already there (tests then run against the dev
 * server, with its on-demand compilation), and its build step shares `.next`
 * with that dev server. Use this one for a trustworthy production-build run:
 *
 *   npx playwright test -c playwright.isolated.config.ts
 */
const PORT = 3100;

export default defineConfig({
    ...base,
    use: { ...base.use, baseURL: `http://127.0.0.1:${PORT}` },
    webServer: {
        command: `npm run build && npx next start -p ${PORT}`,
        url: `http://127.0.0.1:${PORT}/en`,
        reuseExistingServer: process.env.REUSE_SERVER === "1",
        timeout: 8 * 60 * 1000,
        env: { NEXT_DIST_DIR: ".next-test" },
        stdout: "pipe",
        stderr: "pipe",
    },
});
