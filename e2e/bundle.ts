import path from "path";

import { buildSync } from "esbuild";

/**
 * Loads a React component module into a logic spec and returns what the entry
 * source exports.
 *
 * Playwright rewrites JSX in any .tsx file its runner loads into its own
 * component-testing placeholders, so a spec that imports a real component and
 * renders it on the server fails with "Objects are not valid as a React child".
 * Bundling the entry with esbuild first (React included, so there is one copy)
 * keeps the component exactly as the app and the PDF route run it, and keeps
 * these specs browserless and serverless.
 *
 * esbuild is not a direct dependency: it is already installed through Next's
 * toolchain. If it is ever removed, this is the one file to change.
 */
const ROOT = path.resolve(__dirname, "..");

export function loadBundled<T>(entry: string): T {
    const { outputFiles } = buildSync({
        stdin: { contents: entry, resolveDir: ROOT, sourcefile: "entry.ts", loader: "ts" },
        bundle: true,
        platform: "node",
        format: "cjs",
        write: false,
        jsx: "automatic",
        tsconfig: path.join(ROOT, "tsconfig.json"),
        logLevel: "silent",
    });
    const module = { exports: {} as T };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("module", "exports", "require", "__dirname", outputFiles[0].text)(module, module.exports, require, ROOT);
    return module.exports;
}
