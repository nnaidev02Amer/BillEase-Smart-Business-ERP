"use client";

import { useEffect } from "react";

import { WARM_BROWSER_API } from "@/lib/variables";

/** How long a successful warm-up is trusted before the next mount pings again. */
const WARM_TTL_MS = 4 * 60 * 1000;

let lastWarmAt = 0;

/**
 * Warms the server's shared Chromium so the first Generate does not pay its
 * ~2.3s launch.
 *
 * Call it only from screens that actually produce a PDF straight away (the
 * invoice builder, the quotation builder). It used to fire from
 * InvoiceContextProvider, which wraps every route — so opening the dashboard or
 * settings launched a browser nobody was going to use (43s in `next dev`, where
 * the route also had to compile first).
 *
 * Fire-and-forget: a failure leaves generation to launch the browser itself.
 * A module-level timestamp keeps repeated mounts (navigating between builders,
 * locale switches) from pinging more than once per TTL, which also keeps well
 * clear of the endpoint's rate limit.
 */
export function useWarmPdfRenderer(): void {
    useEffect(() => {
        const now = Date.now();
        if (now - lastWarmAt < WARM_TTL_MS) return;
        lastWarmAt = now;

        const controller = new AbortController();
        fetch(WARM_BROWSER_API, { signal: controller.signal }).catch(() => {
            // Not warmed after all: let the next mount try again.
            lastWarmAt = 0;
        });
        return () => controller.abort();
    }, []);
}
