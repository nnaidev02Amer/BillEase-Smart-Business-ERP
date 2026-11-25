"use client";

import { useLocale } from "next-intl";

import { useTranslationContext } from "@/contexts/TranslationContext";
import type { Insight, InsightTone } from "@/lib/crm";
import { formatMoney, type CurrencyTotals } from "@/lib/invoiceRecords";
import { cn } from "@/lib/utils";

import { AlertOctagon, AlertTriangle, CheckCircle2, Info } from "lucide-react";

const TONE: Record<InsightTone, { Icon: typeof Info; cls: string }> = {
    critical: { Icon: AlertOctagon, cls: "border-destructive/40 bg-destructive/10 text-destructive" },
    warning: { Icon: AlertTriangle, cls: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" },
    info: { Icon: Info, cls: "border-primary/30 bg-primary/5 text-foreground" },
    positive: { Icon: CheckCircle2, cls: "border-success/30 bg-success/10 text-success" },
};

/**
 * Rule-based observations as sentences. Each carries the real figures from the
 * records (a count, an amount, a number of days); nothing here is a guess, and
 * the icon is never the only signal: the tone is also in the text colour and
 * the sentence itself.
 */
export const InsightsList = ({ insights, empty, prefix = "crm.insights" }: { insights: Insight[]; empty?: string; prefix?: string }) => {
    const { _t } = useTranslationContext();
    const locale = useLocale();

    if (insights.length === 0) return empty ? <p className="text-sm text-muted-foreground">{empty}</p> : null;

    return (
        <ul className="space-y-2" data-testid="insights">
            {insights.map((i, k) => {
                const { Icon, cls } = TONE[i.tone];
                const params = { ...i.params };
                if (typeof params.amount === "number" && typeof params.currency === "string") {
                    params.amount = formatMoney(params.amount, params.currency, locale);
                }
                return (
                    <li key={`${i.id}-${k}`} className={cn("flex items-start gap-2 rounded-lg border p-3 text-sm", cls)} data-testid="insight" data-insight={i.id} data-tone={i.tone}>
                        <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                        <span className="text-foreground">{_t(`${prefix}.${i.id}`, params as Record<string, string | number>)}</span>
                    </li>
                );
            })}
        </ul>
    );
};

/** One line per currency: amounts in different currencies are never added together. */
export const MoneyLines = ({ totals, empty = "—" }: { totals: CurrencyTotals; empty?: string }) => {
    const locale = useLocale();
    const entries = Object.entries(totals).filter(([, v]) => v > 0);
    if (!entries.length) return <span className="text-muted-foreground">{empty}</span>;
    return (
        <span className="flex flex-col">
            {entries.map(([c, v]) => (
                <span key={c}>{formatMoney(v, c, locale)}</span>
            ))}
        </span>
    );
};

export const StatCard = ({ label, value, sub, tone, testId }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: string; testId?: string }) => (
    <div className="min-w-0 rounded-xl border bg-card p-4 shadow-sm">
        <p className="text-sm text-muted-foreground">{label}</p>
        <div className={cn("mt-2 break-words text-xl font-semibold tabular-nums sm:text-2xl", tone)} data-testid={testId}>
            {value}
        </div>
        {sub && <div className="mt-1 min-h-4 text-xs text-muted-foreground">{sub}</div>}
    </div>
);

export const Panel = ({ title, children, action, className = "", testId }: { title: string; children: React.ReactNode; action?: React.ReactNode; className?: string; testId?: string }) => (
    <section className={cn("min-w-0 rounded-xl border bg-card p-4 shadow-sm sm:p-6", className)} data-testid={testId}>
        <div className="mb-4 flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold">{title}</h2>
            {action}
        </div>
        {children}
    </section>
);
