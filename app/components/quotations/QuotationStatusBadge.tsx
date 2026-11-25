"use client";

import { useTranslationContext } from "@/contexts/TranslationContext";
import { expiryInfo, type Quotation, type QuotationStatus } from "@/lib/quotations";
import { cn } from "@/lib/utils";

import { AlertTriangle, Clock } from "lucide-react";

/** One place that decides what each quotation status looks like. */
export const QUOTATION_STYLES: Record<QuotationStatus, { badge: string; dot: string }> = {
    draft: { badge: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/60" },
    sent: { badge: "bg-primary/10 text-primary", dot: "bg-primary" },
    accepted: { badge: "bg-success/15 text-success", dot: "bg-success" },
    rejected: { badge: "bg-destructive/15 text-destructive", dot: "bg-destructive" },
    expired: { badge: "bg-warning/20 text-warning-foreground dark:text-warning", dot: "bg-warning" },
};

/** Colour is never the only signal: a dot and a text label always accompany it. */
export const QuotationStatusBadge = ({ status, className }: { status: QuotationStatus; className?: string }) => {
    const { _t } = useTranslationContext();
    const style = QUOTATION_STYLES[status];
    return (
        <span
            className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium", style.badge, className)}
            data-testid="quotation-status"
            data-status={status}
        >
            <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", style.dot)} />
            {_t(`quotations.status.${status}`)}
        </span>
    );
};

/** "Expires in 3 days" / "Expired 2 days ago" for something still open. */
export const ExpiryNote = ({ quotation, now }: { quotation: Quotation; now?: Date }) => {
    const { _t } = useTranslationContext();
    const info = expiryInfo(quotation, now);
    if (!info || info.state === "ok") return null;
    const text =
        info.state === "expired"
            ? _t("quotations.expiry.expired", { days: info.days })
            : info.days === 0
              ? _t("quotations.expiry.today")
              : _t("quotations.expiry.soon", { days: info.days });
    const Icon = info.state === "expired" ? AlertTriangle : Clock;
    return (
        <span
            className={cn("inline-flex items-center gap-1 text-xs", info.state === "expired" ? "text-destructive" : "text-amber-600 dark:text-amber-400")}
            data-testid="expiry-note"
            data-state={info.state}
        >
            <Icon className="h-3 w-3" aria-hidden />
            {text}
        </span>
    );
};
