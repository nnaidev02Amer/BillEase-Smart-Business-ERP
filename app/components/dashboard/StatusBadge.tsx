"use client";

import { useTranslationContext } from "@/contexts/TranslationContext";
import { cn } from "@/lib/utils";
import type { DisplayStatus } from "@/lib/invoiceRecords";

/**
 * One place that decides what each status looks like. Colour is never the only
 * signal: every badge carries a text label and a dot.
 */
export const STATUS_STYLES: Record<DisplayStatus, { badge: string; dot: string; swatch: string }> = {
    paid: {
        badge: "bg-success/15 text-success",
        dot: "bg-success",
        swatch: "hsl(var(--success))",
    },
    sent: {
        badge: "bg-primary/10 text-primary",
        dot: "bg-primary",
        swatch: "hsl(var(--primary))",
    },
    partial: {
        badge: "bg-warning/20 text-warning-foreground dark:text-warning",
        dot: "bg-warning",
        swatch: "hsl(var(--warning))",
    },
    overdue: {
        badge: "bg-destructive/15 text-destructive",
        dot: "bg-destructive",
        swatch: "hsl(var(--destructive))",
    },
    draft: {
        badge: "bg-muted text-muted-foreground",
        dot: "bg-muted-foreground/60",
        swatch: "hsl(var(--muted-foreground) / 0.5)",
    },
    cancelled: {
        badge: "bg-muted text-muted-foreground line-through",
        dot: "bg-muted-foreground/30",
        swatch: "hsl(var(--muted-foreground) / 0.25)",
    },
};

const StatusBadge = ({ status, className }: { status: DisplayStatus; className?: string }) => {
    const { _t } = useTranslationContext();
    const style = STATUS_STYLES[status];
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
                style.badge,
                className
            )}
        >
            <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", style.dot)} />
            {_t(`dashboard.status.${status}`)}
        </span>
    );
};

export default StatusBadge;
