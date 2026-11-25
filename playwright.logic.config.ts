import { defineConfig } from "@playwright/test";

/**
 * Pure-logic specs only: no browser, no build, no server.
 * Run with `npm run test:logic`. The full suite (UI + PDF) uses playwright.config.ts.
 */
export default defineConfig({
    testDir: "./e2e",
    testMatch: ["**/*.logic.spec.ts"],
    workers: 1,
    reporter: "list",
});
