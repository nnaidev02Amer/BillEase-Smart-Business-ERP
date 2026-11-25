"use client";

import type { ComponentProps } from "react";

import { Link } from "@/i18n/navigation";
import { useInvoiceContext } from "@/contexts/InvoiceContext";

/**
 * A Link that asks before leaving the builder with unsaved edits. Plain clicks
 * are intercepted; modified clicks (new tab, etc.) pass straight through, since
 * they do not discard the page.
 */
/**
 * Prefetch policy for the primary navigation (navbar, sidebar).
 *
 * Production: Next's default (viewport prefetch). Those routes are statically
 * prerendered, so prefetching them is cheap and makes navigation feel instant.
 * Development: off. `next dev` compiles a route on demand, and a viewport
 * prefetch is enough to trigger that compile — the trace showed `?_rsc=`
 * prefetches of /invoices and /quotations holding the dev server for 76-97s.
 */
export const NAV_PREFETCH: boolean | undefined =
    process.env.NODE_ENV === "production" ? undefined : false;

/**
 * Every other GuardedLink (rows in lists, "view all" links, cross-links between
 * pages) does not prefetch by default: a clients table alone renders dozens of
 * links, each to the same route with a different query string, and none of them
 * is likely to be followed. Pass `prefetch` to opt a specific link back in.
 */
const GuardedLink = ({ href, onClick, prefetch = false, ...props }: ComponentProps<typeof Link>) => {
    const { dirty, guardedNavigate } = useInvoiceContext();

    return (
        <Link
            href={href}
            prefetch={prefetch}
            onClick={(e) => {
                onClick?.(e);
                const modified = e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
                if (dirty && !modified && typeof href === "string") {
                    e.preventDefault();
                    guardedNavigate(href);
                }
            }}
            {...props}
        />
    );
};

export default GuardedLink;
