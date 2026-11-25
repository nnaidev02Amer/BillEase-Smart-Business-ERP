const withNextIntl = require("next-intl/plugin")("./i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
    // Defaults to ".next". The isolated test config builds into its own folder so a
    // test build can never overwrite what a running `next dev` is using.
    distDir: process.env.NEXT_DIST_DIR || ".next",
    serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
    webpack: (config) => {
        config.module.rules.push({
            test: /\.map$/,
            use: "ignore-loader",
        });
        return config;
    },
};

// Bundle analyzer
const withBundleAnalyzer = require("@next/bundle-analyzer")({
    enabled: process.env.ANALYZE === "true",
});

module.exports = withBundleAnalyzer(withNextIntl(nextConfig));
